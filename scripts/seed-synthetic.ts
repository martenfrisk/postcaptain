#!/usr/bin/env bun
/**
 * Seed a SQLite store with realistic *synthetic* activity for one week, dense
 * enough to exercise the whole pipeline end-to-end (capture-shaped events →
 * sessionize → detect → characterize → redact → digest). This is a dev/test
 * fixture, not a collector — it fabricates plausible Copilot interactions and
 * git commits so the weekly digest path has something to chew on.
 *
 *   bun run scripts/seed-synthetic.ts --db ./postcaptain-synthetic.db [--week YYYY-MM-DD]
 *
 * It intentionally includes denylist-worthy identifiers (a repo name, an
 * internal domain, a filesystem path, a leaked-looking token) so the redaction
 * gate (§8) has real work to do. Pair it with the matching redaction.toml.
 */

import { parseArgs } from "node:util";
import { type Event, makeEvent, type NewEvent } from "../src/events.ts";
import { EventStore } from "../src/store.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

/** Monday 00:00 UTC of the week containing `day`. */
function mondayOf(day: Date): number {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
}

let seq = 0;
function ai(
  ts: number,
  prompt: string,
  over: Partial<Record<string, unknown>> & { project: string; ticket: string | null },
): Event {
  const { project, ticket, ...payloadOver } = over;
  const promptChars = prompt.length;
  const responseChars = 400 + ((seq * 137) % 1800);
  const input: NewEvent = {
    eventId: `synthetic:ai:${seq++}`,
    kind: "ai_interaction",
    source: "copilot",
    ts,
    sensitivity: "sensitive",
    project,
    ticket,
    payload: {
      sessionId: `s-${Math.floor(ts / HOUR)}`,
      requestIndex: 0,
      requestCount: 1,
      prompt,
      promptChars,
      responseChars,
      promptTokensEst: Math.round(promptChars / 4),
      responseTokensEst: Math.round(responseChars / 4),
      model: "claude-sonnet-4.6",
      agentId: "github.copilot",
      agentMode: "agent",
      elapsedMs: 2_000 + ((seq * 911) % 9_000),
      isCanceled: false,
      followupCount: 0,
      ...payloadOver,
    },
  };
  return makeEvent(input);
}

function commit(
  ts: number,
  subject: string,
  project: string,
  ticket: string | null,
  ins: number,
  del: number,
): Event {
  return makeEvent({
    eventId: `synthetic:commit:${seq++}`,
    kind: "commit",
    source: "github",
    ts,
    sensitivity: "sensitive",
    project,
    ticket,
    payload: { subject, insertions: ins, deletions: del, files: 1 + (del % 4) },
  });
}

/** Build a session of `n` AI interactions ~`gap` apart starting at `start`. */
function burst(
  start: number,
  n: number,
  prompts: string[],
  ctx: { project: string; ticket: string | null },
  opts: { gap?: number; canceledEvery?: number } = {},
): Event[] {
  const gap = opts.gap ?? 6 * MIN;
  const out: Event[] = [];
  for (let i = 0; i < n; i++) {
    const prompt = prompts[i % prompts.length] ?? prompts[0] ?? "help me with this";
    const canceled = opts.canceledEvery ? (i + 1) % opts.canceledEvery === 0 : false;
    out.push(ai(start + i * gap, prompt, { ...ctx, isCanceled: canceled, followupCount: i }));
  }
  return out;
}

function build(weekStart: number): Event[] {
  const events: Event[] = [];

  // The recurring prompt — issued near-identically across three days (fires the
  // repetition detector → a saved snippet/custom-instruction is the artifact).
  const recurring = "write a vitest unit test for this React component, mocking the api client";

  // Mon — budgetera / BUD-412: a clean two-prompt session incl. the recurring one.
  events.push(
    ...burst(weekStart + 9 * HOUR + 15 * MIN, 2, [recurring, "now add a test for the error path"], {
      project: "budgetera",
      ticket: "BUD-412",
    }),
  );
  events.push(
    commit(weekStart + 11 * HOUR, "BUD-412 add BudgetTable tests", "budgetera", "BUD-412", 84, 6),
  );

  // Tue — budgetera / BUD-412: recurring prompt again + follow-ups (multi-prompt session).
  events.push(
    ...burst(
      weekStart + DAY + 10 * HOUR + 30 * MIN,
      3,
      [recurring, "the mock isn't intercepting fetch", "use msw instead of manual mock"],
      { project: "budgetera", ticket: "BUD-412" },
    ),
  );

  // Wed — checkout-service / CHK-204: recurring prompt a third day (denylisted repo).
  events.push(
    ...burst(
      weekStart + 2 * DAY + 14 * HOUR,
      3,
      [recurring, "wire it into the CHK-204 checkout flow", "why does the snapshot keep changing"],
      { project: "checkout-service", ticket: "CHK-204" },
    ),
  );
  events.push(
    commit(
      weekStart + 2 * DAY + 16 * HOUR,
      "CHK-204 cover checkout edge cases",
      "checkout-service",
      "CHK-204",
      120,
      18,
    ),
  );

  // Thu — budgetera / BUD-415: a long high-churn session (fires the struggle detector).
  events.push(
    ...burst(
      weekStart + 3 * DAY + 9 * HOUR,
      9,
      [
        "refactor the currency formatter to support multiple locales",
        "it breaks for ja-JP, the yen has no decimals",
        "now the tests fail with NaN",
        "Intl.NumberFormat options aren't applying",
        "give me the full corrected formatCurrency function",
        "edge case: negative zero shows -¥0",
        "add a fallback for unknown currency codes",
        "this still throws on undefined amount",
        "ok summarize the final approach",
      ],
      { project: "budgetera", ticket: "BUD-415" },
      { gap: 7 * MIN, canceledEvery: 3 }, // some abandoned mid-flight → canceled detector
    ),
  );
  events.push(
    commit(
      weekStart + 3 * DAY + 13 * HOUR,
      "BUD-415 locale-aware currency formatting",
      "budgetera",
      "BUD-415",
      210,
      64,
    ),
  );

  // Fri — a couple more short multi-prompt sessions (pushes the follow-up-habit
  // ratio over the bar) plus a leak-bait prompt for the redaction gate.
  events.push(
    ...burst(
      weekStart + 4 * DAY + 9 * HOUR + 45 * MIN,
      4,
      [
        "set up a github actions workflow to run vitest on push",
        "cache the bun install step",
        "it can't find the lockfile at /Users/marten/work/checkout-service/bun.lockb",
        "add a step that posts coverage to jira.acme-corp.com",
      ],
      { project: "checkout-service", ticket: "CHK-209" },
      { gap: 8 * MIN, canceledEvery: 3 },
    ),
  );
  events.push(
    ai(
      weekStart + 4 * DAY + 15 * HOUR,
      "debug why CI fails — here's the env: AWS_SECRET=AKIAIOSFODNN7EXAMPLE and token ghp_aBcD1234567890aBcD1234567890aBcD1234",
      { project: "checkout-service", ticket: "CHK-209", isCanceled: true, followupCount: 1 },
    ),
  );
  events.push(
    commit(
      weekStart + 4 * DAY + 17 * HOUR,
      "CHK-209 add CI workflow",
      "checkout-service",
      "CHK-209",
      56,
      2,
    ),
  );

  return events;
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string", default: "./postcaptain-synthetic.db" },
      week: { type: "string" },
    },
  });
  const day = values.week ? new Date(values.week) : new Date();
  if (Number.isNaN(day.getTime())) {
    console.error(`invalid --week date: ${values.week}`);
    return 2;
  }
  const weekStart = mondayOf(day);
  const events = build(weekStart);

  const store = new EventStore(values.db as string);
  try {
    const added = store.addMany(events);
    const start = new Date(weekStart).toISOString().slice(0, 10);
    console.log(`seeded ${added} synthetic events for week of ${start} → ${values.db}`);
    console.log(
      `  ai_interaction: ${store.count("ai_interaction")}, commit: ${store.count("commit")}`,
    );
  } finally {
    store.close();
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
