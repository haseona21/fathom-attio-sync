"""
notify.py
---------
Polls Google Calendar for recently ended meetings, matches attendees to
Attio deals, and sends Slack notifications with action buttons.

Usage:
    python notify.py              # Normal run
    python notify.py --dry-run    # Show what would be sent without sending
    python notify.py --window 15  # Check last 15 minutes instead of default 10
"""

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from attio_helpers import (
    extract_domain,
    find_person_by_email,
    find_company_by_domain,
    find_deals_by_person,
    find_deals_by_company,
    get_deal_details,
    get_person_details,
    get_company_name,
    IGNORED_DOMAINS,
)
from gcal_helpers import get_recently_ended_meetings
from slack_helpers import send_founder_call_message
from errors import logger, ErrorCollector

STATE_FILE = Path(__file__).parent / "notified_events.json"
PRUNE_DAYS = 30


# ── State management ─────────────────────────────────────────────────────────

def load_state() -> dict:
    """Load the notified events state file."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to load state file: %s", exc)
    return {}


def save_state(state: dict):
    """Save the notified events state file, pruning old entries."""
    cutoff = datetime.now(timezone.utc).timestamp() - (PRUNE_DAYS * 86400)
    pruned = {
        k: v for k, v in state.items()
        if datetime.fromisoformat(v).timestamp() > cutoff
    }
    STATE_FILE.write_text(json.dumps(pruned, indent=2))
    logger.info("State saved (%d entries, pruned %d old)", len(pruned), len(state) - len(pruned))


def state_key(event_id: str, deal_record_id: str) -> str:
    return f"{event_id}:{deal_record_id}"


# ── Deal matching ─────────────────────────────────────────────────────────────

def match_attendees_to_deals(attendee_emails: list[str]) -> list[dict]:
    """Match meeting attendees to Attio deals.

    Returns a list of dicts, each with:
      - deal: deal details dict
      - contact_email: the matched attendee email
      - contact_name: the matched person's name (if found)
      - company_name: the matched company name
      - match_type: "person" or "company"
    """
    matches = []
    seen_deal_ids = set()

    for email in attendee_emails:
        # Try matching via person → deal (primary_contact)
        person_ids = find_person_by_email(email)
        for person_id in person_ids:
            deals = find_deals_by_person(person_id)
            for deal in deals:
                if deal["record_id"] in seen_deal_ids:
                    continue
                seen_deal_ids.add(deal["record_id"])

                person_info = get_person_details(person_id)
                deal_details = get_deal_details(deal["record_id"])
                company_name = ""
                if deal_details and deal_details.get("company_record_id"):
                    company_name = get_company_name(deal_details["company_record_id"])

                matches.append({
                    "deal": deal_details or {"record_id": deal["record_id"]},
                    "contact_email": email,
                    "contact_name": person_info["name"] if person_info else "",
                    "company_name": company_name,
                    "match_type": "person",
                })

        # Try matching via domain → company → deal
        domain = extract_domain(email)
        if not domain or domain in IGNORED_DOMAINS:
            continue

        company_ids = find_company_by_domain(domain)
        for company_id in company_ids:
            deals = find_deals_by_company(company_id)
            for deal in deals:
                if deal["record_id"] in seen_deal_ids:
                    continue
                seen_deal_ids.add(deal["record_id"])

                deal_details = get_deal_details(deal["record_id"])
                company_name = get_company_name(company_id)

                matches.append({
                    "deal": deal_details or {"record_id": deal["record_id"]},
                    "contact_email": email,
                    "contact_name": "",
                    "company_name": company_name,
                    "match_type": "company",
                })

    return matches


# ── Main ──────────────────────────────────────────────────────────────────────

def run(dry_run: bool = False, window_minutes: int = 10):
    """Main entry point: poll calendar, match deals, send Slack messages."""
    errors = ErrorCollector()
    state = load_state()

    logger.info("Starting notification run (dry_run=%s, window=%dm)", dry_run, window_minutes)

    # 1. Get recently ended meetings
    try:
        meetings = get_recently_ended_meetings(minutes_ago=window_minutes)
    except Exception as exc:
        errors.add("calendar_poll", exc)
        logger.error("Failed to poll calendar: %s", exc)
        return

    if not meetings:
        logger.info("No recently ended meetings found.")
        return

    logger.info("Found %d recently ended meetings", len(meetings))
    notifications_sent = 0

    # 2. For each meeting, match attendees to deals
    for meeting in meetings:
        try:
            logger.info("Processing meeting: %s (%s)", meeting["title"], meeting["event_id"])
            matches = match_attendees_to_deals(meeting["attendee_emails"])

            if not matches:
                logger.info("  No deal matches for meeting '%s'", meeting["title"])
                continue

            logger.info("  Found %d deal match(es)", len(matches))

            # 3. Send Slack notification for each matched deal
            for match in matches:
                deal = match["deal"]
                key = state_key(meeting["event_id"], deal.get("record_id", ""))

                if key in state:
                    logger.info("  Already notified for %s, skipping", key)
                    continue

                deal_info = {
                    "record_id": deal.get("record_id", ""),
                    "deal_name": deal.get("deal_name", "Unknown"),
                    "company_name": match["company_name"],
                    "contact_name": match["contact_name"],
                    "contact_email": match["contact_email"],
                }

                if dry_run:
                    logger.info(
                        "  [DRY RUN] Would send Slack message: deal=%s company=%s contact=%s",
                        deal_info["deal_name"],
                        deal_info["company_name"],
                        deal_info["contact_email"],
                    )
                else:
                    try:
                        send_founder_call_message(deal_info, meeting)
                        notifications_sent += 1
                    except Exception as exc:
                        errors.add(f"slack_send:{deal.get('record_id', '')}", exc)
                        continue

                state[key] = datetime.now(timezone.utc).isoformat()

        except Exception as exc:
            errors.add(f"meeting:{meeting.get('event_id', 'unknown')}", exc)
            continue

    # 4. Save state and report
    if not dry_run:
        save_state(state)

    logger.info("Run complete. Notifications sent: %d", notifications_sent)
    if errors.has_errors:
        logger.warning("Run completed with errors:\n%s", errors.summary())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Post-call deal notification system.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Log what would be sent without sending")
    parser.add_argument("--window", type=int, default=10,
                        help="Minutes to look back for ended meetings (default: 10)")
    args = parser.parse_args()

    run(dry_run=args.dry_run, window_minutes=args.window)
