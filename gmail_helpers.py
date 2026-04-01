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


@with_error_handling
def create_rejection_draft(
    to_email: str,
    to_name: str,
    company_name: str,
) -> str | None:
    """Create a Gmail draft with the rejection email.

    Args:
        to_email: Recipient email address
        to_name: Recipient name (for template personalisation)
        company_name: Company name (for template personalisation)

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

    # Build MIME message
    message = MIMEText(body)
    message["to"] = to_email
    message["subject"] = subject

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()

    try:
        draft = service.users().drafts().create(
            userId="me",
            body={"message": {"raw": raw}},
        ).execute()
        draft_id = draft["id"]
        logger.info("Gmail draft created (id: %s) to %s", draft_id, to_email)
        return draft_id
    except Exception as exc:
        raise GmailError(f"Failed to create Gmail draft: {exc}") from exc
