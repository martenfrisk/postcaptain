"""The local SQLite event store.

One ``events`` table holds every normalized event. The store is the shared
substrate for the whole pipeline (collectors write; detectors, sessionizer and
the characterizer read). Each stage is independently re-runnable, so writes are
idempotent via the deterministic ``event_id`` primary key (design §5).
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Optional

from .events import Event, EventKind, Sensitivity, Source

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    event_id     TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    source       TEXT NOT NULL,
    ts           INTEGER NOT NULL,        -- event time, epoch ms
    project      TEXT,
    ticket       TEXT,
    sensitivity  TEXT NOT NULL,
    payload      TEXT NOT NULL,           -- kind-specific JSON
    ingested_at  INTEGER NOT NULL         -- ingest time, epoch ms
);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind    ON events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project, ts);
CREATE INDEX IF NOT EXISTS idx_events_ticket  ON events(ticket, ts);
"""


class EventStore:
    """A thin, idempotent wrapper over the SQLite ``events`` table."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        self._conn = sqlite3.connect(self.path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    # ---- writes -----------------------------------------------------------

    def add(self, event: Event) -> bool:
        """Insert one event. Returns True if newly inserted, False if a dup."""
        return self.add_many([event]) == 1

    def add_many(self, events: Iterable[Event]) -> int:
        """Insert events idempotently. Returns the count of *new* rows."""
        rows = [
            (
                e.event_id,
                e.kind.value,
                e.source.value,
                e.ts,
                e.project,
                e.ticket,
                e.sensitivity.value,
                json.dumps(e.payload, ensure_ascii=False, sort_keys=True),
                e.ingested_at,
            )
            for e in events
        ]
        if not rows:
            return 0
        before = self._conn.total_changes
        self._conn.executemany(
            "INSERT OR IGNORE INTO events "
            "(event_id, kind, source, ts, project, ticket, sensitivity, payload, ingested_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        self._conn.commit()
        return self._conn.total_changes - before

    # ---- reads ------------------------------------------------------------

    def count(self, kind: Optional[EventKind | str] = None) -> int:
        if kind is None:
            cur = self._conn.execute("SELECT COUNT(*) FROM events")
        else:
            k = kind.value if isinstance(kind, EventKind) else kind
            cur = self._conn.execute("SELECT COUNT(*) FROM events WHERE kind = ?", (k,))
        return int(cur.fetchone()[0])

    def query(
        self,
        *,
        kind: Optional[EventKind | str] = None,
        project: Optional[str] = None,
        ticket: Optional[str] = None,
        since: Optional[int] = None,
        until: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> list[Event]:
        """Fetch events ordered by event time (ascending)."""
        clauses: list[str] = []
        params: list[object] = []
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind.value if isinstance(kind, EventKind) else kind)
        if project is not None:
            clauses.append("project = ?")
            params.append(project)
        if ticket is not None:
            clauses.append("ticket = ?")
            params.append(ticket)
        if since is not None:
            clauses.append("ts >= ?")
            params.append(since)
        if until is not None:
            clauses.append("ts <= ?")
            params.append(until)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"SELECT * FROM events{where} ORDER BY ts ASC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return [_row_to_event(r) for r in self._conn.execute(sql, params)]

    # ---- lifecycle --------------------------------------------------------

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "EventStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _row_to_event(row: sqlite3.Row) -> Event:
    return Event(
        event_id=row["event_id"],
        kind=EventKind(row["kind"]),
        source=Source(row["source"]),
        ts=row["ts"],
        sensitivity=Sensitivity(row["sensitivity"]),
        payload=json.loads(row["payload"]),
        project=row["project"],
        ticket=row["ticket"],
        ingested_at=row["ingested_at"],
    )
