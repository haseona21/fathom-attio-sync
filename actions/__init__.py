"""
actions
-------
Button action handlers for Slack interactive messages.
Each module exports a handle(payload) function.
"""

from actions import to_deals, ali_to_reject, deal_review

ACTION_HANDLERS = {
    "to_deals": to_deals.handle,
    "ali_to_reject": ali_to_reject.handle,
    "deal_review": deal_review.handle,
}
