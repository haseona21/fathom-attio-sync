"""
actions/ali_to_reject.py
------------------------
Button 2: "Ali to Reject" — update deal stage + create Gmail rejection draft.
"""

from attio_helpers import update_deal_stage
from gmail_helpers import create_rejection_draft
from errors import logger, AttioError, GmailError

STAGE_NAME = "Ali to Reject"


def handle(payload: dict) -> dict:
    """Handle the "Ali to Reject" button click.

    Args:
        payload: dict with deal_record_id, event_id, attendee_email,
                 attendee_name, company_name, deal_name

    Returns:
        dict with 'success' (bool) and 'message' (str) for Slack update.
    """
    deal_id = payload.get("deal_record_id")
    deal_name = payload.get("deal_name", "Unknown")
    email = payload.get("attendee_email", "")
    name = payload.get("attendee_name", "")
    company = payload.get("company_name", "")

    results = []
    overall_success = True

    # 1. Update deal stage in Attio
    try:
        update_deal_stage(deal_id, STAGE_NAME)
        results.append(f"Deal stage → *{STAGE_NAME}*")
        logger.info("Deal %s (%s) stage updated to '%s'", deal_id, deal_name, STAGE_NAME)
    except AttioError as exc:
        results.append(f"Failed to update deal stage: {exc}")
        logger.error("Failed to update deal %s stage: %s", deal_id, exc)
        overall_success = False

    # 2. Create Gmail rejection draft
    if email:
        try:
            draft_id = create_rejection_draft(email, name, company)
            results.append(f"Gmail draft created (id: {draft_id})")
            logger.info("Rejection draft created for %s (%s)", email, company)
        except GmailError as exc:
            results.append(f"Failed to create Gmail draft: {exc}")
            logger.error("Failed to create rejection draft for %s: %s", email, exc)
            overall_success = False
    else:
        results.append("No attendee email — skipped Gmail draft")
        logger.warning("No attendee email for deal %s, skipping Gmail draft", deal_id)

    return {
        "success": overall_success,
        "message": "\n".join(results),
    }
