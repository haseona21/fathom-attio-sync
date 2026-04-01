"""
actions/deal_review.py
----------------------
Button 3: "Deal Review" — update deal stage in Attio.
"""

from attio_helpers import update_deal_stage
from errors import logger, AttioError

STAGE_NAME = "Deal Review"


def handle(payload: dict) -> dict:
    """Handle the "Deal Review" button click.

    Args:
        payload: dict with deal_record_id, event_id, attendee_email,
                 attendee_name, company_name, deal_name

    Returns:
        dict with 'success' (bool) and 'message' (str) for Slack update.
    """
    deal_id = payload.get("deal_record_id")
    deal_name = payload.get("deal_name", "Unknown")

    try:
        update_deal_stage(deal_id, STAGE_NAME)
        logger.info("Deal %s (%s) stage updated to '%s'", deal_id, deal_name, STAGE_NAME)
        return {
            "success": True,
            "message": f"Deal stage → *{STAGE_NAME}*",
        }
    except AttioError as exc:
        logger.error("Failed to update deal %s stage: %s", deal_id, exc)
        return {
            "success": False,
            "message": f"Failed to update deal stage: {exc}",
        }
