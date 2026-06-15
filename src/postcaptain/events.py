"""The normalized event model.

Every collector normalizes into a single ``Event`` shape that lands in one
``events`` table (see ``store.py``). The model is deliberately small: a typed
``kind``, a ``source``, an event time, a ``sensitivity`` tag set at collection
time (it drives all later routing — design §8), optional ``project``/``ticket``
join keys, and a kind-specific JSON ``payload``.

Design references: §4 (data sources), §5 (event store), §12 (resolved keys).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


def now_ms() -> int:
    """Current wall-clock time in epoch milliseconds (the unit for all ``ts``)."""
    return int(time.time() * 1000)


class EventKind(str, Enum):
    """The closed set of normalized event kinds (design §5)."""

    EDIT = "edit"
    AI_INTERACTION = "ai_interaction"
    READING = "reading"
    COMMIT = "commit"
    PR_REVIEW = "pr_review"
    MEETING = "meeting"
    AFK = "afk"


class Source(str, Enum):
    """Which collector produced an event."""

    COPILOT = "copilot"
    GITHUB = "github"
    JIRA = "jira"
    CALENDAR = "calendar"
    ACTIVITYWATCH = "activitywatch"
    SCREENPIPE = "screenpipe"
    WAKATIME = "wakatime"


class Sensitivity(str, Enum):
    """Privacy tier, set at collection time (design §8).

    Ordered low < medium < sensitive so a session/candidate can take the max
    over its evidence.
    """

    LOW = "low"
    MEDIUM = "medium"
    SENSITIVE = "sensitive"

    @property
    def rank(self) -> int:
        return {"low": 0, "medium": 1, "sensitive": 2}[self.value]


# Jira ticket key: convention `ABC-123`, used as the backbone join key across
# tools (design §5/§12). Anchored to word boundaries so it doesn't match inside
# longer tokens.
TICKET_RE = re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b")


def extract_ticket(*texts: Optional[str]) -> Optional[str]:
    """Return the first Jira ticket key found across ``texts``, or None.

    Used on branch names (primary), then commit/PR titles, then workspace
    folder names as a fallback.
    """
    for text in texts:
        if not text:
            continue
        m = TICKET_RE.search(text)
        if m:
            return m.group(1)
    return None


def stable_event_id(source: Source | str, *parts: Any) -> str:
    """Build a deterministic event id from a source's natural key.

    Re-running a collector over the same underlying data yields the same id, so
    ``INSERT OR IGNORE`` makes ingestion idempotent. Kept human-readable (joined
    with ``:``) rather than hashed, to ease debugging.
    """
    src = source.value if isinstance(source, Source) else str(source)
    tail = ":".join(str(p) for p in parts)
    return f"{src}:{tail}"


@dataclass(frozen=True, slots=True)
class Event:
    """One normalized activity event.

    ``ts`` and ``ingested_at`` are epoch milliseconds. ``payload`` is a
    kind-specific dict that is JSON-serialized in the store.
    """

    event_id: str
    kind: EventKind
    source: Source
    ts: int
    sensitivity: Sensitivity
    payload: dict[str, Any]
    project: Optional[str] = None
    ticket: Optional[str] = None
    ingested_at: int = field(default_factory=now_ms)

    def __post_init__(self) -> None:
        # Coerce string inputs into enums so callers can pass either, and fail
        # loudly on unknown values rather than silently storing junk.
        object.__setattr__(self, "kind", EventKind(self.kind))
        object.__setattr__(self, "source", Source(self.source))
        object.__setattr__(self, "sensitivity", Sensitivity(self.sensitivity))
