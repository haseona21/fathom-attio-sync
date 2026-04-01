"""
actions/to_deals.py
-------------------
Button 1: "To Deals" — placeholder for the deals framework (coming later).
"""

from errors import logger


def handle(payload: dict) -> dict:
    """Handle the "To Deals" button click.

    Args:
        payload: dict with deal_record_id, event_id, attendee_email,
                 attendee_name, company_name, deal_name

    Returns:
        dict with 'success' (bool) and 'message' (str) for Slack update.
    """
    logger.info(
        "To Deals action for deal %s (%s)",
        payload.get("deal_record_id"),
        payload.get("deal_name"),
    )

    # Placeholder — the deals framework will be built separately.
    return {
        "success": True,
        "message": "Marked for Deals framework (coming soon)",
    }
