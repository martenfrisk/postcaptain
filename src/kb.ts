/**
 * Knowledge base — reading captured, deduplicated, and (later) joined to work
 * (design §7). This is the consumption side: `reading` events (from the AW web
 * watcher, browser history, or screenpipe) are promoted into durable **notes**
 * keyed by canonical URL. Notes live in the indefinite-retention tier (§11) —
 * they're the product, not the raw capture, so they outlive the 21-day raw
 * events they were built from.
 *
 * Like `themes.ts`, this is split: pure functions (URL canonicalization, note
 * projection) + a thin idempotent SQLite wrapper (`KbStore`). A note is a *pure
 * projection* of the reading events for a URL — `visit_count` is recomputed (a
 * count of visits), never blindly incremented — so re-running capture can't
 * inflate it. Re-promotion preserves any LLM `summary`/`tags`/`embedding`
 * already attached (those are the expensive, phase-D-next bits).
 *
 * Not yet built (next sub-step): local summarization/embeddings and the
 * `kb_links` consumption↔work join (temporal + topical proximity, §7).
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Event } from "./events.ts";
import { SENSITIVITY_RANK, type Sensitivity } from "./events.ts";

/** Tracking/query params that don't change the page identity (dropped on canon). */
const TRACKING_PARAMS = /^(utm_|ref$|ref_|fbclid$|gclid$|mc_|_hs|igshid$|si$|spm$)/i;

/**
 * Canonicalize a URL for dedup: lowercase scheme+host, drop the fragment and
 * tracking params, drop a trailing slash. Meaningful query params are kept (a
 * search/result page is a different "read"). Falls back to the trimmed input if
 * it isn't a parseable URL.
 */
export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    // Drop a trailing slash from the path (before any query), keeping root "/".
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    // ...and tidy a lone host-root trailing slash ("https://host/" → "https://host").
    return u.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

/** Stable, opaque note id from the canonical URL. */
export function noteId(canonical: string): string {
  return `note:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/** A durable knowledge-base note (the §7 `kb_notes` row, camelCase). */
export interface KbNote {
  noteId: string;
  canonicalUrl: string;
  title: string | null;
  summary: string | null;
  tags: string[];
  firstSeen: number;
  lastSeen: number;
  visitCount: number;
  sensitivity: Sensitivity;
}

function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}

/**
 * Project `reading` events into notes, deduped by canonical URL. Pure: visit
 * count = number of reading events for the URL, first/last seen from their
 * timestamps, title = the most recent non-empty one, sensitivity = max over the
 * group. Reading events without a URL are ignored.
 */
export function buildNotes(events: Event[]): KbNote[] {
  interface Acc {
    canonical: string;
    title: string | null;
    titleTs: number;
    firstSeen: number;
    lastSeen: number;
    visits: number;
    sensitivity: Sensitivity;
  }
  const groups = new Map<string, Acc>();
  for (const e of events) {
    if (e.kind !== "reading") continue;
    const url = typeof e.payload.url === "string" ? e.payload.url : "";
    if (!url) continue;
    const canonical = canonicalUrl(url);
    const title = typeof e.payload.title === "string" ? e.payload.title : "";
    const g = groups.get(canonical) ?? {
      canonical,
      title: null,
      titleTs: -1,
      firstSeen: e.ts,
      lastSeen: e.ts,
      visits: 0,
      sensitivity: "low" as Sensitivity,
    };
    g.visits += 1;
    g.firstSeen = Math.min(g.firstSeen, e.ts);
    g.lastSeen = Math.max(g.lastSeen, e.ts);
    g.sensitivity = maxSensitivity(g.sensitivity, e.sensitivity);
    if (title && e.ts >= g.titleTs) {
      g.title = title;
      g.titleTs = e.ts;
    }
    groups.set(canonical, g);
  }
  return [...groups.values()].map((g) => ({
    noteId: noteId(g.canonical),
    canonicalUrl: g.canonical,
    title: g.title,
    summary: null,
    tags: [],
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    visitCount: g.visits,
    sensitivity: g.sensitivity,
  }));
}

// --- persistence -------------------------------------------------------------

const KB_SCHEMA = `
CREATE TABLE IF NOT EXISTS kb_notes (
    note_id       TEXT PRIMARY KEY,
    canonical_url TEXT,
    title         TEXT,
    summary       TEXT,                  -- LLM summary (next sub-step)
    tags          TEXT,                  -- JSON array
    embedding     BLOB,                  -- summary embedding (next sub-step)
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    visit_count   INTEGER NOT NULL,
    sensitivity   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_links (
    note_id     TEXT NOT NULL,
    target_id   TEXT NOT NULL,           -- event_id, session id, or ticket key
    target_kind TEXT NOT NULL,           -- event | session | ticket
    relation    TEXT NOT NULL,           -- read_before | read_during | read_after | referenced
    score       REAL NOT NULL,
    evidence    TEXT NOT NULL,           -- JSON
    PRIMARY KEY (note_id, target_id, target_kind, relation)
);
`;

interface NoteRow {
  note_id: string;
  canonical_url: string;
  title: string | null;
  summary: string | null;
  tags: string | null;
  first_seen: number;
  last_seen: number;
  visit_count: number;
  sensitivity: string;
}

/**
 * Idempotent SQLite wrapper for the knowledge base (same db file as events).
 * Upserting a note recomputes `visit_count`/`last_seen`/`title` but **preserves**
 * any existing `summary`/`tags`/`embedding` so re-promotion never clobbers
 * enrichment.
 */
export class KbStore {
  readonly path: string;
  private db: Database;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(KB_SCHEMA);
  }

  /** Promote/refresh one note. Returns nothing; idempotent per note_id. */
  upsert(note: KbNote): void {
    this.db
      .query(
        `INSERT INTO kb_notes
           (note_id, canonical_url, title, summary, tags, embedding, first_seen, last_seen, visit_count, sensitivity)
         VALUES ($id, $url, $title, NULL, $tags, NULL, $first, $last, $visits, $sens)
         ON CONFLICT(note_id) DO UPDATE SET
           title       = $title,
           first_seen  = MIN(first_seen, $first),
           last_seen   = MAX(last_seen, $last),
           visit_count = $visits,
           sensitivity = $sens`,
      )
      .run({
        $id: note.noteId,
        $url: note.canonicalUrl,
        $title: note.title,
        $tags: JSON.stringify(note.tags),
        $first: note.firstSeen,
        $last: note.lastSeen,
        $visits: note.visitCount,
        $sens: note.sensitivity,
      });
  }

  /** Promote a batch of reading events into notes. Returns the note count touched. */
  promote(events: Event[]): number {
    const notes = buildNotes(events);
    const tx = this.db.transaction((ns: KbNote[]) => {
      for (const n of ns) this.upsert(n);
    });
    tx(notes);
    return notes.length;
  }

  /** All notes, most-revisited first. */
  all(): KbNote[] {
    const rows = this.db
      .query("SELECT * FROM kb_notes ORDER BY visit_count DESC, last_seen DESC")
      .all() as NoteRow[];
    return rows.map((r) => ({
      noteId: r.note_id,
      canonicalUrl: r.canonical_url,
      title: r.title,
      summary: r.summary,
      tags: parseTags(r.tags),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      visitCount: r.visit_count,
      sensitivity: r.sensitivity as Sensitivity,
    }));
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM kb_notes").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const t = JSON.parse(value);
    return Array.isArray(t) ? (t as string[]) : [];
  } catch {
    return [];
  }
}
