/**
 * The local SQLite event store.
 *
 * One `events` table holds every normalized event. The store is the shared
 * substrate for the whole pipeline (collectors write; detectors, sessionizer
 * and the characterizer read). Each stage is independently re-runnable, so
 * writes are idempotent via the deterministic `event_id` primary key (§5).
 */

import { Database } from "bun:sqlite";
import type { Event, EventKind, Sensitivity, Source } from "./events.ts";

const SCHEMA = `
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
`;

/** A row as stored in SQLite (snake_case columns). */
interface EventRow {
  event_id: string;
  kind: string;
  source: string;
  ts: number;
  project: string | null;
  ticket: string | null;
  sensitivity: string;
  payload: string;
  ingested_at: number;
}

export interface QueryOpts {
  kind?: EventKind;
  project?: string;
  ticket?: string;
  since?: number;
  until?: number;
  limit?: number;
}

/** A thin, idempotent wrapper over the SQLite `events` table. */
export class EventStore {
  readonly path: string;
  private db: Database;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  // ---- writes ------------------------------------------------------------

  /** Insert one event. Returns true if newly inserted, false if a dup. */
  add(event: Event): boolean {
    return this.addMany([event]) === 1;
  }

  /** Insert events idempotently. Returns the count of *new* rows. */
  addMany(events: Event[]): number {
    if (events.length === 0) return 0;
    const stmt = this.db.query(
      `INSERT OR IGNORE INTO events
         (event_id, kind, source, ts, project, ticket, sensitivity, payload, ingested_at)
       VALUES ($eventId, $kind, $source, $ts, $project, $ticket, $sensitivity, $payload, $ingestedAt)`,
    );
    const insertAll = this.db.transaction((rows: Event[]) => {
      let inserted = 0;
      for (const e of rows) {
        const { changes } = stmt.run({
          $eventId: e.eventId,
          $kind: e.kind,
          $source: e.source,
          $ts: e.ts,
          $project: e.project,
          $ticket: e.ticket,
          $sensitivity: e.sensitivity,
          $payload: JSON.stringify(e.payload),
          $ingestedAt: e.ingestedAt,
        });
        inserted += Number(changes);
      }
      return inserted;
    });
    return insertAll(events);
  }

  // ---- reads -------------------------------------------------------------

  count(kind?: EventKind): number {
    const row =
      kind === undefined
        ? this.db.query("SELECT COUNT(*) AS n FROM events").get()
        : this.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind);
    return (row as { n: number }).n;
  }

  /** Fetch events ordered by event time (ascending). */
  query(opts: QueryOpts = {}): Event[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.project !== undefined) {
      clauses.push("project = ?");
      params.push(opts.project);
    }
    if (opts.ticket !== undefined) {
      clauses.push("ticket = ?");
      params.push(opts.ticket);
    }
    if (opts.since !== undefined) {
      clauses.push("ts >= ?");
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      clauses.push("ts <= ?");
      params.push(opts.until);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    let sql = `SELECT * FROM events${where} ORDER BY ts ASC`;
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.query(sql).all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  // ---- lifecycle ---------------------------------------------------------

  close(): void {
    this.db.close();
  }
}

function rowToEvent(row: EventRow): Event {
  return {
    eventId: row.event_id,
    kind: row.kind as EventKind,
    source: row.source as Source,
    ts: row.ts,
    sensitivity: row.sensitivity as Sensitivity,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    project: row.project,
    ticket: row.ticket,
    ingestedAt: row.ingested_at,
  };
}
