/**
 * Sessionizer — groups events into work sessions so detectors reason about "a
 * stretch of work," not isolated events (design §5).
 *
 * Two rules (design §12):
 *   - Gap threshold: a new session starts after ~25–30 min of inactivity.
 *   - Key change: a new session starts on a project/ticket switch.
 *
 * The session key is the **Jira ticket** when present (the backbone join key),
 * falling back to the repo/workspace `project`. Events that carry neither share
 * a sentinel key and still split on the gap rule.
 */

import { type Event, type EventKind, SENSITIVITY_RANK, type Sensitivity } from "./events.ts";

/** Default inactivity gap that ends a session: 28 minutes. */
export const DEFAULT_GAP_MS = 28 * 60 * 1000;

const NO_KEY = "(none)";

export interface Session {
  id: string;
  /** ticket ?? project ?? "(none)" — what events were grouped on. */
  key: string;
  ticket: string | null;
  project: string | null;
  startTs: number;
  endTs: number;
  durationMs: number;
  eventIds: string[];
  eventCount: number;
  /** Per-kind event counts within the session. */
  kinds: Partial<Record<EventKind, number>>;
  /** Max sensitivity over the session's events (§8). */
  sensitivity: Sensitivity;
}

function sessionKey(e: Event): string {
  return e.ticket ?? e.project ?? NO_KEY;
}

function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}

interface Builder {
  key: string;
  ticket: string | null;
  project: string | null;
  startTs: number;
  endTs: number;
  eventIds: string[];
  kinds: Partial<Record<EventKind, number>>;
  sensitivity: Sensitivity;
}

function finalize(b: Builder): Session {
  return {
    id: `${b.key}:${b.startTs}`,
    key: b.key,
    ticket: b.ticket,
    project: b.project,
    startTs: b.startTs,
    endTs: b.endTs,
    durationMs: b.endTs - b.startTs,
    eventIds: b.eventIds,
    eventCount: b.eventIds.length,
    kinds: b.kinds,
    sensitivity: b.sensitivity,
  };
}

/**
 * Group events into work sessions, ordered by start time.
 *
 * Events are sorted by `ts` (ties broken by `eventId` for determinism) before
 * grouping, so callers may pass them in any order.
 */
export function sessionize(events: Event[], opts: { gapMs?: number } = {}): Session[] {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.eventId.localeCompare(b.eventId));

  const sessions: Session[] = [];
  let cur: Builder | null = null;

  for (const e of sorted) {
    const key = sessionKey(e);
    const gapped = cur !== null && e.ts - cur.endTs > gapMs;
    if (cur === null || key !== cur.key || gapped) {
      if (cur !== null) sessions.push(finalize(cur));
      cur = {
        key,
        ticket: e.ticket,
        project: e.project,
        startTs: e.ts,
        endTs: e.ts,
        eventIds: [],
        kinds: {},
        sensitivity: e.sensitivity,
      };
    }
    cur.eventIds.push(e.eventId);
    cur.endTs = e.ts;
    cur.kinds[e.kind] = (cur.kinds[e.kind] ?? 0) + 1;
    cur.sensitivity = maxSensitivity(cur.sensitivity, e.sensitivity);
  }
  if (cur !== null) sessions.push(finalize(cur));
  return sessions;
}
