"""
gcal_helpers.py
---------------
Google Calendar polling to detect recently ended meetings.
"""

import json
import os
from datetime import datetime, timedelta, timezone

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from errors import CalendarError, logger, with_error_handling


def _get_calendar_service():
    """Build a Google Calendar API service from credentials in env."""
    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if not creds_json:
        raise CalendarError("GOOGLE_CREDENTIALS_JSON environment variable not set")

    creds_data = json.loads(creds_json)
    creds = Credentials.from_authorized_user_info(creds_data)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


@with_error_handling
def get_recently_ended_meetings(minutes_ago: int = 10) -> list[dict]:
    """Fetch calendar events that ended in the last `minutes_ago` minutes.

    Returns a list of dicts with:
      - event_id: str
      - title: str
      - end_time: str (ISO format)
      - attendee_emails: list[str] (external attendees only)
    """
    service = _get_calendar_service()

    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(minutes=minutes_ago)).isoformat()
    time_max = now.isoformat()

    logger.info("Checking calendar for events ending between %s and %s", time_min, time_max)

    try:
        events_result = service.events().list(
            calendarId="primary",
            timeMin=time_min,
            timeMax=time_max,
            singleEvents=True,
            orderBy="startTime",
        ).execute()
    except Exception as exc:
        raise CalendarError(f"Failed to list calendar events: {exc}") from exc

    events = events_result.get("items", [])
    logger.info("Found %d calendar events in window", len(events))

    results = []
    for event in events:
        # Skip all-day events (no dateTime in end)
        end = event.get("end", {})
        if "dateTime" not in end:
            continue

        # Skip cancelled events
        if event.get("status") == "cancelled":
            continue

        # Only include events that have actually ended
        end_dt = datetime.fromisoformat(end["dateTime"])
        if end_dt > now:
            continue

        # Extract attendee emails (exclude organiser / self)
        attendees = event.get("attendees", [])
        attendee_emails = [
            a["email"]
            for a in attendees
            if not a.get("self", False)
            and not a.get("organizer", False)
            and a.get("email")
        ]

        results.append({
            "event_id": event["id"],
            "title": event.get("summary", "Untitled"),
            "end_time": end["dateTime"],
            "attendee_emails": attendee_emails,
        })

    logger.info("Returning %d ended meetings with attendees", len(results))
    return results
