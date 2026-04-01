"""
attio_helpers.py
----------------
Shared Attio CRM utilities used by both sync.py and the notification system.
Single source of truth for all Attio API interactions.
"""

import os
import re
import requests

from errors import AttioError, logger, with_error_handling

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── Config ────────────────────────────────────────────────────────────────────

ATTIO_API_KEY = os.environ["ATTIO_API_KEY"]
ATTIO_BASE = "https://api.attio.com/v2"

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
ATTIO_ATTRIBUTE = "fathom_links"

# The Attio object slug for deals.
DEALS_OBJECT = "magic"


# ── Helpers ───────────────────────────────────────────────────────────────────

def extract_domain(email: str) -> str | None:
    """Extract the domain part from an email address."""
    match = re.search(r"@([\w.\-]+)$", email or "")
    return match.group(1).lower() if match else None


# ── Generic Attio API ─────────────────────────────────────────────────────────

@with_error_handling
def attio_get(path: str) -> dict | None:
    """GET a path from the Attio API. Returns parsed JSON or None on error."""
    resp = requests.get(f"{ATTIO_BASE}{path}", headers=ATTIO_HEADERS)
    if resp.status_code == 200:
        return resp.json()
    logger.warning("Attio GET %s returned %d: %s", path, resp.status_code, resp.text)
    return None


@with_error_handling
def attio_post(path: str, json_body: dict) -> dict | None:
    """POST to the Attio API. Returns parsed JSON or None on error."""
    resp = requests.post(f"{ATTIO_BASE}{path}", headers=ATTIO_HEADERS, json=json_body)
    if resp.status_code in (200, 201):
        return resp.json()
    logger.warning("Attio POST %s returned %d: %s", path, resp.status_code, resp.text)
    return None


@with_error_handling
def attio_patch(path: str, json_body: dict) -> dict | None:
    """PATCH the Attio API. Returns parsed JSON or None on error."""
    resp = requests.patch(f"{ATTIO_BASE}{path}", headers=ATTIO_HEADERS, json=json_body)
    if resp.status_code in (200, 201):
        return resp.json()
    logger.warning("Attio PATCH %s returned %d: %s", path, resp.status_code, resp.text)
    return None


# ── People lookup ─────────────────────────────────────────────────────────────

@with_error_handling
def find_person_by_email(email: str) -> list[str]:
    """Find Attio Person record IDs by email. Returns list of record_ids."""
    for filter_body in [
        {"email_addresses": email.lower()},
        {"email_addresses": {"original_email_address": {"$eq": email.lower()}}},
    ]:
        result = attio_post("/objects/people/records/query", {"filter": filter_body})
        if result:
            ids = [r["id"]["record_id"] for r in result.get("data", [])]
            if ids:
                return ids
    return []


# ── Company lookup ────────────────────────────────────────────────────────────

@with_error_handling
def find_company_by_domain(domain: str) -> list[str]:
    """Find Attio Company record IDs by domain. Returns list of record_ids."""
    for filter_body in [
        {"domains": domain.lower()},
        {"domains": {"domain": {"$eq": domain.lower()}}},
    ]:
        result = attio_post("/objects/companies/records/query", {"filter": filter_body})
        if result:
            ids = [r["id"]["record_id"] for r in result.get("data", [])]
            if ids:
                return ids
    return []


# ── Fathom links (used by sync.py) ───────────────────────────────────────────

@with_error_handling
def get_current_value(object_type: str, record_id: str) -> str:
    """Read the current fathom_links value from an Attio record."""
    data = attio_get(f"/objects/{object_type}/records/{record_id}")
    if not data:
        return ""
    values = data.get("data", {}).get("values", {})
    entries = values.get(ATTIO_ATTRIBUTE, [])
    if entries:
        return entries[0].get("value", "")
    return ""


@with_error_handling
def append_link(object_type: str, record_id: str, new_entry: str) -> bool:
    """Read current fathom_links, append new_entry if not present, write back."""
    current = get_current_value(object_type, record_id)

    if new_entry in current:
        logger.debug("Link already exists for %s/%s, skipping.", object_type, record_id)
        return False

    updated = f"{current}, {new_entry}" if current else new_entry

    result = attio_patch(
        f"/objects/{object_type}/records/{record_id}",
        {"data": {"values": {ATTIO_ATTRIBUTE: updated}}},
    )
    return result is not None


# ── Deal operations (used by notification system) ─────────────────────────────

@with_error_handling
def find_deals_by_person(person_record_id: str) -> list[dict]:
    """Find deals where primary_contact matches the given person record ID.

    Returns list of dicts with 'record_id' and basic deal info.
    """
    result = attio_post(
        f"/objects/{DEALS_OBJECT}/records/query",
        {
            "filter": {
                "primary_contact": {"$eq": person_record_id},
            },
        },
    )
    if not result:
        return []

    deals = []
    for record in result.get("data", []):
        deals.append({
            "record_id": record["id"]["record_id"],
            "values": record.get("values", {}),
        })
    return deals


@with_error_handling
def find_deals_by_company(company_record_id: str) -> list[dict]:
    """Find deals where company matches the given company record ID.

    Returns list of dicts with 'record_id' and basic deal info.
    """
    result = attio_post(
        f"/objects/{DEALS_OBJECT}/records/query",
        {
            "filter": {
                "company": {"$eq": company_record_id},
            },
        },
    )
    if not result:
        return []

    deals = []
    for record in result.get("data", []):
        deals.append({
            "record_id": record["id"]["record_id"],
            "values": record.get("values", {}),
        })
    return deals


@with_error_handling
def get_deal_details(deal_record_id: str) -> dict | None:
    """Fetch full deal details including name, stage, company, primary contact.

    Returns a dict with extracted fields, or None on error.
    """
    data = attio_get(f"/objects/{DEALS_OBJECT}/records/{deal_record_id}")
    if not data:
        return None

    values = data.get("data", {}).get("values", {})

    def first_value(field: str, key: str = "value") -> str:
        entries = values.get(field, [])
        if entries:
            return entries[0].get(key, "")
        return ""

    def first_record_ref(field: str) -> str:
        entries = values.get(field, [])
        if entries:
            return entries[0].get("target_record_id", "")
        return ""

    return {
        "record_id": deal_record_id,
        "deal_name": first_value("deal_name"),
        "deal_stage": first_value("deal_stage", key="status"),
        "company_record_id": first_record_ref("company"),
        "primary_contact_record_id": first_record_ref("primary_contact"),
    }


@with_error_handling
def update_deal_stage(deal_record_id: str, stage_title: str) -> bool:
    """Update the deal_stage field on a deal record.

    The stage_title must match an existing status option in Attio exactly.
    """
    logger.info("Updating deal %s stage to '%s'", deal_record_id, stage_title)
    result = attio_patch(
        f"/objects/{DEALS_OBJECT}/records/{deal_record_id}",
        {"data": {"values": {"deal_stage": stage_title}}},
    )
    if result is None:
        raise AttioError(f"Failed to update deal {deal_record_id} stage to '{stage_title}'")
    return True


@with_error_handling
def get_all_person_emails(email: str) -> list[str]:
    """Look up a person by email and return all their email addresses from Attio.

    Falls back to [email] if the person isn't found or has no other addresses.
    """
    person_ids = find_person_by_email(email)
    if not person_ids:
        return [email]

    data = attio_get(f"/objects/people/records/{person_ids[0]}")
    if not data:
        return [email]

    entries = data.get("data", {}).get("values", {}).get("email_addresses", [])
    emails = []
    for entry in entries:
        addr = entry.get("email_address", "") or entry.get("value", "")
        if addr:
            emails.append(addr.lower())

    return emails or [email]


@with_error_handling
def get_person_details(person_record_id: str) -> dict | None:
    """Fetch person name and email from Attio."""
    data = attio_get(f"/objects/people/records/{person_record_id}")
    if not data:
        return None

    values = data.get("data", {}).get("values", {})

    name_entries = values.get("name", [])
    name = ""
    if name_entries:
        name = name_entries[0].get("full_name", "") or name_entries[0].get("value", "")

    email_entries = values.get("email_addresses", [])
    email = ""
    if email_entries:
        email = email_entries[0].get("email_address", "") or email_entries[0].get("value", "")

    return {"name": name, "email": email, "record_id": person_record_id}


@with_error_handling
def get_company_name(company_record_id: str) -> str:
    """Fetch company name from Attio."""
    data = attio_get(f"/objects/companies/records/{company_record_id}")
    if not data:
        return ""

    values = data.get("data", {}).get("values", {})
    name_entries = values.get("name", [])
    if name_entries:
        return name_entries[0].get("value", "")
    return ""
