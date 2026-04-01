"""
errors.py
---------
Centralised error handling and logging for the founder-call notification system.
"""

import functools
import logging
import os
import sys
import traceback


# ── Logging setup ────────────────────────────────────────────────────────────

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s  %(levelname)-8s  [%(name)s]  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)

logger = logging.getLogger("fathom_attio")


# ── Custom exceptions ────────────────────────────────────────────────────────

class AttioError(Exception):
    """Raised when an Attio API call fails."""

class SlackError(Exception):
    """Raised when a Slack API call fails."""

class GmailError(Exception):
    """Raised when a Gmail API call fails."""

class CalendarError(Exception):
    """Raised when a Google Calendar API call fails."""


# ── Error-handling decorator ─────────────────────────────────────────────────

def with_error_handling(func):
    """Wrap a function so exceptions are logged with full context and re-raised."""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except (AttioError, SlackError, GmailError, CalendarError) as exc:
            logger.error("%s failed: %s", func.__name__, exc)
            raise
        except Exception as exc:
            logger.error(
                "%s unexpected error: %s\n%s",
                func.__name__,
                exc,
                traceback.format_exc(),
            )
            raise

    return wrapper


# ── Error summary helper ─────────────────────────────────────────────────────

class ErrorCollector:
    """Collects errors during a run and reports a summary."""

    def __init__(self):
        self.errors: list[dict] = []

    def add(self, context: str, error: Exception):
        self.errors.append({"context": context, "error": str(error)})
        logger.error("Error in %s: %s", context, error)

    @property
    def has_errors(self) -> bool:
        return len(self.errors) > 0

    def summary(self) -> str:
        if not self.errors:
            return "No errors."
        lines = [f"  - [{e['context']}] {e['error']}" for e in self.errors]
        return f"{len(self.errors)} error(s):\n" + "\n".join(lines)
