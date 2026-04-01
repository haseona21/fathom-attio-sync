"""
slack_helpers.py
----------------
Slack message sending with Block Kit buttons for founder call notifications.
"""

import json
import os

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from errors import SlackError, logger, with_error_handling


def _get_slack_client() -> WebClient:
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise SlackError("SLACK_BOT_TOKEN environment variable not set")
    return WebClient(token=token)


def _get_channel() -> str:
    channel = os.environ.get("SLACK_CHANNEL")
    if not channel:
        raise SlackError("SLACK_CHANNEL environment variable not set")
    return channel


@with_error_handling
def send_founder_call_message(deal_info: dict, meeting_info: dict) -> str | None:
    """Send a Slack message with action buttons after a founder call.

    Args:
        deal_info: dict with keys: record_id, deal_name, company_name,
                   contact_name, contact_email
        meeting_info: dict with keys: event_id, title, end_time, attendee_emails

    Returns:
        The message timestamp (ts) if sent successfully, None otherwise.
    """
    client = _get_slack_client()
    channel = _get_channel()

    # Payload embedded in each button so the handler knows what to act on
    button_payload = json.dumps({
        "deal_record_id": deal_info["record_id"],
        "event_id": meeting_info["event_id"],
        "attendee_email": deal_info.get("contact_email", ""),
        "attendee_name": deal_info.get("contact_name", ""),
        "company_name": deal_info.get("company_name", ""),
        "deal_name": deal_info.get("deal_name", ""),
    })

    attendee_list = ", ".join(meeting_info.get("attendee_emails", []))

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"Founder Call: {deal_info.get('company_name', 'Unknown')}",
            },
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*Deal:* {deal_info.get('deal_name', 'N/A')}\n"
                    f"*Meeting:* {meeting_info.get('title', 'N/A')}\n"
                    f"*Ended:* {meeting_info.get('end_time', 'N/A')}\n"
                    f"*Attendees:* {attendee_list or 'N/A'}"
                ),
            },
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "To Deals"},
                    "action_id": "to_deals",
                    "value": button_payload,
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Ali to Reject"},
                    "action_id": "ali_to_reject",
                    "value": button_payload,
                    "style": "danger",
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Deal Review"},
                    "action_id": "deal_review",
                    "value": button_payload,
                    "style": "primary",
                },
            ],
        },
    ]

    try:
        response = client.chat_postMessage(
            channel=channel,
            text=f"Founder Call: {deal_info.get('company_name', 'Unknown')}",
            blocks=blocks,
        )
        logger.info(
            "Slack message sent for deal %s (ts: %s)",
            deal_info["record_id"],
            response["ts"],
        )
        return response["ts"]
    except SlackApiError as exc:
        raise SlackError(f"Failed to send Slack message: {exc.response['error']}") from exc


@with_error_handling
def update_message_with_result(
    channel: str, ts: str, action_name: str, actor: str, details: str = ""
):
    """Replace the buttons in a message with a confirmation of the action taken.

    Args:
        channel: Slack channel ID
        ts: Message timestamp to update
        action_name: Human-readable name of the action (e.g. "Ali to Reject")
        actor: Name/ID of the user who clicked the button
        details: Optional extra details to show
    """
    client = _get_slack_client()

    result_text = f"*{action_name}* — by <@{actor}>"
    if details:
        result_text += f"\n{details}"

    blocks = [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": result_text},
        },
    ]

    try:
        client.chat_update(channel=channel, ts=ts, blocks=blocks, text=result_text)
        logger.info("Slack message %s updated with action: %s", ts, action_name)
    except SlackApiError as exc:
        raise SlackError(f"Failed to update Slack message: {exc.response['error']}") from exc
