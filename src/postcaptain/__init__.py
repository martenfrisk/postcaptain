"""postcaptain — a local-first AI work mentor (capture + insight layer).

See ``work-mentor-design.md`` for the architecture. Phase 1 is the capture
spike: the normalized event model (``events``), the SQLite store (``store``)
and collectors (``collectors``).
"""

from .events import Event, EventKind, Sensitivity, Source
from .store import EventStore

__all__ = ["Event", "EventKind", "Sensitivity", "Source", "EventStore"]
__version__ = "0.0.1"
