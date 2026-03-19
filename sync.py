"""
sync.py
-------
Fetches new Fathom meetings since the last run and appends
(date): link entries to matching Person and Company records in Attio.

Tracks last run time in last_run.txt (committed back to the repo by the
GitHub Actions workflow so state persists across runs).
"""

import os
import re
import time
import requests
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
FATHOM_API_KEY = os.environ["FATHOM_API_KEY"]
ATTIO_API_KEY  = os.environ["ATTIO_API_KEY"]
LAST_RUN_FILE  = "last_run.txt"

FATHOM_BASE = "https://api.fathom.ai/external/v1/meetings"
ATTIO_BASE  = "https://api.attio.com/v2"

ATTIO_HEADERS = {
    "Authorization": f"Bearer {ATTIO_API_KEY}",
    "Content-Type": "application/json",
}

IGNORED_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com",
    "yahoo.com", "icloud.com", "me.com", "mac.com", "live.com",
    "msn.com", "protonmail.com", "pm.me",
}

# The Attio attribute slug where Fathom links are stored.
# Create a Text attribute on People and Companies called "Fathom Recordings"
# and use its slug here (visible in Attio under attribute settings).
ATTIO_ATTRIBUTE = "fathom_links"
# ─────────────────────────────────────────────────────────────────────────────


# ── State ─────────────────────────────────────────────────────────────────────

def read_last_run():
    """Returns the last run timestamp as an ISO string, or None if first run."""
    if os.path.exists(LAST_RUN_FILE):
        with open(LAST_RUN_FILE) as f:
            val = f.read().strip()
            if val:
                return val
    return None


def write_last_run(ts: str):
    with open(LAST_RUN_FILE, "w") as f:
        f.write(ts)


# ── Fathom ────────────────────────────────────────────────────────────────────

def fetch_new_meetings(since: str | None):
    """Fetch meetings created after `since` (ISO string). If None, fetches all."""
    meetings, cursor = [], None
    print(f"Fetching Fathom meetings{f' since {since}' if since else ' (full history)'}...")

    while True:
        params = {"limit": 50}
        if cursor:
            params["cursor"] = cursor
        if since:
            params["created_after"] = since

        while True:
            resp = requests.get(FATHOM_BASE, headers={"X-Api-Key": FATHOM_API_KEY}, params=params)
            if resp.status_code == 429:
                print("  Rate limited — waiting 60s...")
                time.sleep(60)
                continue
            if resp.status_code != 200:
                print(f"  Fathom error {resp.status_code}: {resp.text}")
                return meetings
            break

        data = resp.json()
        batch = data.get("items", [])
        meetings.extend(batch)
        print(f"  Got {len(batch)} meetings (total: {len(meetings)})")

        cursor = data.get("next_cursor")
        time.sleep(1)
        if not cursor:
            break

    print(f"  Done. {len(meetings)} new meetings.\n")
    return meetings


# ── Helpers ───────────────────────────────────────────────────────────────────

def extract_domain(email):
    match = re.search(r"@([\w.\-]+)$", email or "")
    return match.group(1).lower() if match else None


def format_date(iso_string):
    if not iso_string:
        return ""
    try:
        dt = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return iso_string


def make_link_entry(meeting):
    date = format_date(meeting.get("scheduled_start_time") or meeting.get("created_at"))
    url  = meeting.get("share_url", "")
    return f"({date}): {url}"


# ── Attio ─────────────────────────────────────────────────────────────────────

def attio_get(path):
    resp = requests.get(f"{ATTIO_BASE}{path}", headers=ATTIO_HEADERS)
    if resp.status_code == 200:
        return resp.json()
    return None


def find_person_by_email(email):
    # Try both shorthand and verbose filter to maximise match rate
    for filter_body in [
        {"email_addresses": email.lower()},
        {"email_addresses": {"original_email_address": {"$eq": email.lower()}}},
    ]:
        resp = requests.post(
            f"{ATTIO_BASE}/objects/people/records/query",
            headers=ATTIO_HEADERS,
            json={"filter": filter_body},
        )
        if resp.status_code == 200:
            results = [r["id"]["record_id"] for r in resp.json().get("data", [])]
            if results:
                return results
    return []


def find_company_by_domain(domain):
    for filter_body in [
        {"domains": domain.lower()},
        {"domains": {"domain": {"$eq": domain.lower()}}},
    ]:
        resp = requests.post(
            f"{ATTIO_BASE}/objects/companies/records/query",
            headers=ATTIO_HEADERS,
            json={"filter": filter_body},
        )
        if resp.status_code == 200:
            results = [r["id"]["record_id"] for r in resp.json().get("data", [])]
            if results:
                return results
    return []


def get_current_value(object_type, record_id):
    """Read the current fathom_recordings value from an Attio record."""
    data = attio_get(f"/objects/{object_type}/records/{record_id}")
    if not data:
        return ""
    values = data.get("data", {}).get("values", {})
    entries = values.get(ATTIO_ATTRIBUTE, [])
    if entries:
        return entries[0].get("value", "")
    return ""


def append_link(object_type, record_id, new_entry):
    """Read current value, append new_entry if not already present, write back."""
    current = get_current_value(object_type, record_id)

    # Skip if this exact entry already exists (idempotent)
    if new_entry in current:
        print(f"    Already exists, skipping.")
        return False

    updated = f"{current}, {new_entry}" if current else new_entry

    resp = requests.patch(
        f"{ATTIO_BASE}/objects/{object_type}/records/{record_id}",
        headers=ATTIO_HEADERS,
        json={"data": {"values": {ATTIO_ATTRIBUTE: updated}}},
    )
    return resp.status_code in (200, 201)


# ── Main ──────────────────────────────────────────────────────────────────────

def process(meetings):
    stats = {"people": 0, "companies": 0, "skipped": 0}

    for i, m in enumerate(meetings, 1):
        title = m.get("title") or m.get("meeting_title") or "Untitled"
        print(f"[{i}/{len(meetings)}] {title}")

        invitees = m.get("calendar_invitees") or []
        external = [inv for inv in invitees if inv.get("is_external", True) and inv.get("email")]

        if not external:
            print("  No external invitees — skipping.")
            stats["skipped"] += 1
            continue

        link_entry = make_link_entry(m)

        # ── People ────────────────────────────────────────────────────────
        for inv in external:
            email = inv["email"]
            record_ids = find_person_by_email(email)
            if not record_ids:
                print(f"  No Attio person found for {email}")
                continue
            for record_id in record_ids:
                ok = append_link("people", record_id, link_entry)
                if ok:
                    print(f"  ✓ Updated person {email}")
                    stats["people"] += 1

        # ── Companies (one per unique domain) ─────────────────────────────
        seen_domains = set()
        for inv in external:
            domain = extract_domain(inv["email"])
            if not domain or domain in IGNORED_DOMAINS or domain in seen_domains:
                continue
            seen_domains.add(domain)

            record_ids = find_company_by_domain(domain)
            if not record_ids:
                print(f"  No Attio company found for @{domain}")
                continue
            for record_id in record_ids:
                ok = append_link("companies", record_id, link_entry)
                if ok:
                    print(f"  ✓ Updated company @{domain}")
                    stats["companies"] += 1

        time.sleep(0.3)

    print("\n── Summary ──────────────────────────────────")
    print(f"  People updated:    {stats['people']}")
    print(f"  Companies updated: {stats['companies']}")
    print(f"  Meetings skipped:  {stats['skipped']}")


if __name__ == "__main__":
    run_started_at = datetime.now(timezone.utc).isoformat()

    last_run = read_last_run()
    meetings = fetch_new_meetings(since=last_run)

    if meetings:
        process(meetings)
    else:
        print("No new meetings since last run.")

    write_last_run(run_started_at)
    print(f"\nLast run updated to {run_started_at}")
