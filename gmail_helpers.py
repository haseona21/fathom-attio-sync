"""
gmail_helpers.py
----------------
Gmail draft creation for rejection emails.
"""

import base64
import json
import os
from email.mime.text import MIMEText
from pathlib import Path

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from errors import GmailError, logger, with_error_handling

TEMPLATE_DIR = Path(__file__).parent / "templates"


def _get_gmail_service():
    """Build a Gmail API service from credentials in env."""
    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if not creds_json:
        raise GmailError("GOOGLE_CREDENTIALS_JSON environment variable not set")

    creds_data = json.loads(creds_json)
    creds = Credentials.from_authorized_user_info(creds_data)
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _load_template(template_name: str) -> str:
    """Load an email template from the templates directory."""
    path = TEMPLATE_DIR / template_name
    if not path.exists():
        raise GmailError(f"Email template not found: {path}")
    return path.read_text()


def _find_existing_thread(service, emails: list[str]) -> dict | None:
    """Search for an existing thread with any of the recipient's emails.

    Tries two strategies in order:
      1. An existing draft addressed to them
      2. Any email conversation with them (e.g. the scheduling thread)

    Returns dict with 'thread_id', 'message_id' (RFC Message-ID header),
    and 'subject', or None if no prior thread exists.
    """
    email_clause = " OR ".join(f"{{{e}}}" for e in emails)

    queries = [
        f"({email_clause}) -subject:Invitation",
        f"({email_clause})",
    ]

    for query in queries:
        try:
            results = service.users().messages().list(
                userId="me", q=query, maxResults=1,
            ).execute()
        except Exception as exc:
            logger.warning("Thread search failed for query '%s': %s", query, exc)
            continue

        messages = results.get("messages", [])
        if not messages:
            continue

        msg_id = messages[0]["id"]
        try:
            msg = service.users().messages().get(
                userId="me", id=msg_id, format="metadata",
                metadataHeaders=["Message-ID", "Subject"],
            ).execute()
        except Exception as exc:
            logger.warning("Failed to fetch message %s: %s", msg_id, exc)
            continue

        headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
        logger.info("Found existing thread via query: %s", query)
        return {
            "thread_id": msg["threadId"],
            "message_id": headers.get("Message-ID", ""),
            "subject": headers.get("Subject", ""),
        }

    return None


@with_error_handling
def create_rejection_draft(
    to_email: str,
    to_name: str,
    company_name: str,
    all_emails: list[str] | None = None,
) -> str | None:
    """Create a Gmail draft with the rejection email.

    If an existing rejection thread with the recipient is found, the draft
    is created as a reply in that thread. Otherwise a new draft is created.

    Args:
        to_email: Recipient email address (used as the draft's To: address)
        to_name: Recipient name (for template personalisation)
        company_name: Company name (for template personalisation)
        all_emails: All known emails for this person (searched for existing threads)

    Returns:
        The draft ID if created successfully, None otherwise.
    """
    service = _get_gmail_service()

    template = _load_template("rejection_email.txt")

    # Parse subject from template (first line after "Subject: ")
    lines = template.strip().split("\n")
    subject = ""
    body_start = 0
    for i, line in enumerate(lines):
        if line.startswith("Subject:"):
            subject = line[len("Subject:"):].strip()
            body_start = i + 1
            break

    body = "\n".join(lines[body_start:]).strip()

    # Fill in placeholders
    first_name = to_name.split()[0] if to_name else "there"
    subject = subject.replace("{company_name}", company_name or "your company")
    body = body.replace("{founder_name}", first_name)
    body = body.replace("{company_name}", company_name or "your company")

    # Check for an existing thread to reply to
    existing = _find_existing_thread(service, all_emails or [to_email])

    # Build MIME message
    message = MIMEText(body)
    message["to"] = to_email

    draft_body = {}

    if existing:
        # Thread the reply: set threadId, and threading headers if available
        if existing.get("subject"):
            message["subject"] = f"Re: {existing['subject']}"
        else:
            message["subject"] = subject
        if existing.get("message_id"):
            message["In-Reply-To"] = existing["message_id"]
            message["References"] = existing["message_id"]
        draft_body["message"] = {"threadId": existing["thread_id"]}
        logger.info("Replying in existing thread %s for %s", existing["thread_id"], to_email)
    else:
        message["subject"] = subject

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    draft_body.setdefault("message", {})["raw"] = raw

    try:
        draft = service.users().drafts().create(
            userId="me",
            body=draft_body,
        ).execute()
        draft_id = draft["id"]
        logger.info("Gmail draft created (id: %s) to %s", draft_id, to_email)
        return draft_id
    except Exception as exc:
        raise GmailError(f"Failed to create Gmail draft: {exc}") from exc
