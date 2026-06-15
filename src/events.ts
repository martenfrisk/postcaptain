/**
 * The normalized event model.
 *
 * Every collector normalizes into a single `Event` shape that lands in one
 * `events` table (see `store.ts`). The model is deliberately small: a typed
 * `kind`, a `source`, an event time, a `sensitivity` tag set at collection time
 * (it drives all later routing — design §8), optional `project`/`ticket` join
 * keys, and a kind-specific JSON `payload`.
 *
 * Design references: §4 (data sources), §5 (event store), §12 (resolved keys).
 */

/** The closed set of normalized event kinds (design §5). */
export const EVENT_KINDS = [
  "edit",
  "ai_interaction",
  "reading",
  "commit",
  "pr_review",
  "meeting",
  "afk",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Which collector produced an event. */
export const SOURCES = [
  "copilot",
  "github",
  "jira",
  "calendar",
  "activitywatch",
  "screenpipe",
  "wakatime",
] as const;
export type Source = (typeof SOURCES)[number];

/** Privacy tier, set at collection time (design §8). */
export const SENSITIVITIES = ["low", "medium", "sensitive"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/** low < medium < sensitive, so a session can take the max over its evidence. */
export const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  low: 0,
  medium: 1,
  sensitive: 2,
};

/** Current wall-clock time in epoch milliseconds (the unit for all `ts`). */
export function nowMs(): number {
  return Date.now();
}

/**
 * Jira ticket key: convention `ABC-123`, used as the backbone join key across
 * tools (design §5/§12). Anchored to word boundaries so it doesn't match inside
 * longer tokens. Not global — used for first-match search.
 */
export const TICKET_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/**
 * Return the first Jira ticket key found across `texts`, or null.
 *
 * Used on branch names (primary), then commit/PR titles, then workspace folder
 * names as a fallback.
 */
export function extractTicket(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (!text) continue;
    const key = text.match(TICKET_RE)?.[1];
    if (key) return key;
  }
  return null;
}

/**
 * Build a deterministic event id from a source's natural key.
 *
 * Re-running a collector over the same underlying data yields the same id, so
 * `INSERT OR IGNORE` makes ingestion idempotent. Kept human-readable (joined
 * with `:`) rather than hashed, to ease debugging.
 */
export function stableEventId(source: Source | string, ...parts: (string | number)[]): string {
  return `${source}:${parts.join(":")}`;
}

/** One normalized activity event. `ts`/`ingestedAt` are epoch milliseconds. */
export interface Event {
  eventId: string;
  kind: EventKind;
  source: Source;
  ts: number;
  sensitivity: Sensitivity;
  payload: Record<string, unknown>;
  project: string | null;
  ticket: string | null;
  ingestedAt: number;
}

export interface NewEvent {
  eventId: string;
  kind: EventKind;
  source: Source;
  ts: number;
  sensitivity: Sensitivity;
  payload: Record<string, unknown>;
  project?: string | null;
  ticket?: string | null;
  ingestedAt?: number;
}

/**
 * Construct a validated `Event`, defaulting `ingestedAt` to now. Fails loudly on
 * an unknown `kind`/`source`/`sensitivity` rather than silently storing junk.
 */
export function makeEvent(input: NewEvent): Event {
  if (!EVENT_KINDS.includes(input.kind)) throw new Error(`unknown kind: ${input.kind}`);
  if (!SOURCES.includes(input.source)) throw new Error(`unknown source: ${input.source}`);
  if (!SENSITIVITIES.includes(input.sensitivity)) {
    throw new Error(`unknown sensitivity: ${input.sensitivity}`);
  }
  return {
    eventId: input.eventId,
    kind: input.kind,
    source: input.source,
    ts: input.ts,
    sensitivity: input.sensitivity,
    payload: input.payload,
    project: input.project ?? null,
    ticket: input.ticket ?? null,
    ingestedAt: input.ingestedAt ?? nowMs(),
  };
}
