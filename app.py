"""
app.py
------
Slack Socket Mode handler for interactive message callbacks (button clicks).

Routes button actions to the appropriate handler in actions/.
Run with: python app.py
No server or ngrok needed — connects outbound to Slack via WebSocket.
"""

import json
import os

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from actions import ACTION_HANDLERS
from slack_helpers import update_message_with_result
from errors import logger

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = App(token=os.environ["SLACK_BOT_TOKEN"])


# ── Action handler factory ────────────────────────────────────────────────────

def _make_listener(action_id: str, handler_fn):
    """Create a Slack Bolt action listener that routes to the correct handler."""

    def listener(ack, body, action):
        # Acknowledge immediately
        ack()

        user_id = body.get("user", {}).get("id", "unknown")
        user_name = body.get("user", {}).get("username", "unknown")
        channel = body.get("channel", {}).get("id", "")
        message_ts = body.get("message", {}).get("ts", "")

        logger.info(
            "Slack interaction: action=%s user=%s channel=%s",
            action_id, user_name, channel,
        )

        # Parse button value (contains deal/meeting metadata)
        try:
            button_payload = json.loads(action.get("value", "{}"))
        except json.JSONDecodeError:
            logger.error("Failed to parse button value for action %s", action_id)
            return

        # Run the handler
        try:
            result = handler_fn(button_payload)
        except Exception as exc:
            logger.error("Action handler %s failed: %s", action_id, exc, exc_info=True)
            result = {"success": False, "message": f"Error: {exc}"}

        # Update the Slack message to show the result
        action_label = action.get("text", {}).get("text", action_id)
        status = "Done" if result["success"] else "Failed"
        details = result.get("message", "")

        try:
            update_message_with_result(
                channel=channel,
                ts=message_ts,
                action_name=f"{action_label} — {status}",
                actor=user_id,
                details=details,
            )
        except Exception as exc:
            logger.error("Failed to update Slack message: %s", exc)

    return listener


# Register a listener for each action
for action_id, handler_fn in ACTION_HANDLERS.items():
    app.action(action_id)(_make_listener(action_id, handler_fn))


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app_token = os.environ.get("SLACK_APP_TOKEN")
    if not app_token:
        logger.error("SLACK_APP_TOKEN not set — required for Socket Mode")
        raise SystemExit(1)

    logger.info("Starting Slack Socket Mode handler...")
    handler = SocketModeHandler(app, app_token)
    handler.start()
