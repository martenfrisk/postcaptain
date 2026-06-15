#!/usr/bin/env bun
/**
 * Command-line entry point for the capture spike.
 *
 *     bun run src/cli.ts capture --db ./postcaptain.db
 *     bun run src/cli.ts stats   --db ./postcaptain.db
 *
 * `capture` runs the local collectors into the SQLite store (idempotent — safe
 * to re-run). `stats` prints a quick read-back so you can eyeball what landed.
 */

import { parseArgs } from "node:util";
import { characterizeAll } from "./characterizer.ts";
import * as copilot from "./collectors/copilot.ts";
import * as github from "./collectors/github.ts";
import { type Candidate, detectAll } from "./detectors.ts";
import type { Event } from "./events.ts";
import { exploreCandidates } from "./explore.ts";
import { ollamaClient } from "./llm.ts";
import { answer } from "./query.ts";
import {
  asLevel,
  loadDenylist,
  loadOrCreateSalt,
  loadRedactionLevel,
  RedactionError,
} from "./redact.ts";
import { sessionize } from "./sessionizer.ts";
import { EventStore } from "./store.ts";
import {
  buildDigestInput,
  copilotRunner,
  type DigestLesson,
  localDigest,
  previewText,
  synthesize,
  weekRange,
} from "./synthesis.ts";
import { isMaterialChange, ThemeStore, trackWeek, trendLine, weekKey } from "./themes.ts";
import { readUsage, summarizeUsage } from "./usage.ts";

async function capture(dbPath: string): Promise<number> {
  const store = new EventStore(dbPath);
  try {
    const copilotAdded = store.addMany(copilot.collect());
    console.log(
      `copilot: +${copilotAdded} new ai_interaction events (${store.count("ai_interaction")} total)`,
    );
    const gitAdded = store.addMany(await github.collect());
    console.log(`git:     +${gitAdded} new commit events (${store.count("commit")} total)`);
    console.log(`→ ${dbPath}`);
  } finally {
    store.close();
  }
  return 0;
}

function stats(dbPath: string): number {
  const store = new EventStore(dbPath);
  try {
    const total = store.count();
    const events = store.query({ kind: "ai_interaction" });
    const byProject = tally(events.map((e) => e.project ?? "(unknown)"));
    const byModel = tally(events.map((e) => (e.payload.model as string | null) ?? "(unknown)"));
    const tokens = events.reduce((sum, e) => sum + Number(e.payload.tokensEst ?? 0), 0);
    console.log(`events: ${total} total`);
    console.log(`ai_interaction: ${events.length} events, ~${tokens} est. tokens`);
    console.log("  top projects:", topN(byProject, 5));
    console.log("  by model:    ", topN(byModel, 5));
  } finally {
    store.close();
  }

  const usage = summarizeUsage(readUsage());
  if (usage.calls > 0) {
    const credits =
      usage.creditsKnown > 0
        ? `~${usage.credits.toFixed(1)} credits (${usage.creditsKnown}/${usage.calls} reported)`
        : "credits not reported";
    console.log(
      `remote calls: ${usage.calls} (${JSON.stringify(usage.byPurpose)}), ` +
        `~${usage.promptTokensEst + usage.responseTokensEst} est. tokens, ${credits}`,
    );
  }
  return 0;
}

function tally(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

function topN(counts: Map<string, number>, n: number): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n));
}

/**
 * Run detectors, then the local-LLM characterizer over the candidates that
 * clear the surfacing bar (§6), printing each insight + its drafted artifact.
 */
async function insights(dbPath: string, model: string, minConfidence: number): Promise<number> {
  const store = new EventStore(dbPath);
  let events: ReturnType<EventStore["query"]>;
  try {
    events = store.query();
  } finally {
    store.close();
  }
  const candidates = detectAll({ events, sessions: sessionize(events) });
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const client = ollamaClient({ model });
  const results = await characterizeAll(candidates, byId, client, { minConfidence });

  if (results.length === 0) {
    console.log(`No findings above confidence ${minConfidence}. Capture more activity.`);
    return 0;
  }
  for (const i of results) {
    const flag = i.characterized ? "" : "  (fallback — model unavailable)";
    console.log(`\n● ${i.headline}  [${i.category} · ${(i.confidence * 100).toFixed(0)}%]${flag}`);
    console.log(`  ${i.whatHappened}`);
    console.log(`  → ${i.suggestion}`);
    if (i.artifactDraft) {
      console.log(`  ┌─ ${i.artifactType} ─────────────`);
      for (const line of i.artifactDraft.split("\n")) console.log(`  │ ${line}`);
      console.log("  └────────────────────");
    }
  }
  return 0;
}

/** Interactive query: answer a question grounded in the captured activity. */
async function ask(dbPath: string, model: string, question: string): Promise<number> {
  if (!question.trim()) {
    console.error('usage: postcaptain ask "your question" [--db PATH] [--model M]');
    return 2;
  }
  const store = new EventStore(dbPath);
  let events: ReturnType<EventStore["query"]>;
  try {
    events = store.query();
  } finally {
    store.close();
  }
  const reply = await answer(question, events, sessionize(events), ollamaClient({ model }));
  console.log(reply);
  return 0;
}

/**
 * Detect the week's deterministic lessons, fold them into the persistent theme
 * store, and return the ones that materially changed (§7) as digest lessons.
 * Opens its own `ThemeStore` (same db file) and always closes it.
 */
function trackLessonsForWeek(dbPath: string, inWeek: Event[], week: string): DigestLesson[] {
  const candidates = detectAll({ events: inWeek, sessions: sessionize(inWeek) });
  const store = new ThemeStore(dbPath);
  try {
    return trackWeek(store, candidates, week)
      .filter((t) => isMaterialChange(t.status))
      .map((t) => ({
        headline: t.headline,
        trend: trendLine(t),
        status: t.status,
        suggestion: t.suggestion,
      }));
  } finally {
    store.close();
  }
}

/** Show every tracked lesson with its trend (§7). Read-only; no detection run. */
function lessons(dbPath: string): number {
  const store = new ThemeStore(dbPath);
  try {
    const tracked = store.all().filter((t) => t.category === "lesson");
    if (tracked.length === 0) {
      console.log("No lessons tracked yet. Run `digest` over a few weeks to build trends.");
      return 0;
    }
    for (const t of tracked) {
      const flag = isMaterialChange(t.status) ? "  ●" : "";
      console.log(`\n${t.headline}${flag}`);
      console.log(`  ${trendLine(t)}   (${t.firstWeek} → ${t.lastWeek})`);
      console.log(`  → ${t.suggestion}`);
    }
  } finally {
    store.close();
  }
  return 0;
}

/**
 * Weekly digest (§8/§9) — the one remote call. Characterizes the week's
 * findings on the LOCAL model, runs them through the redaction gate, and shows
 * a "what would be sent" preview. The remote Copilot CLI call only happens with
 * `--send` (opt-in); redaction is fail-closed.
 */
async function digest(
  dbPath: string,
  localModel: string,
  remoteModel: string,
  minConfidence: number,
  opts: { send: boolean; explore: boolean; week?: string; redact?: string },
): Promise<number> {
  const store = new EventStore(dbPath);
  let events: ReturnType<EventStore["query"]>;
  try {
    events = store.query();
  } finally {
    store.close();
  }

  const denylist = loadDenylist();
  const salt = loadOrCreateSalt();
  const level = opts.redact ? asLevel(opts.redact) : loadRedactionLevel();
  const day = opts.week ? new Date(opts.week) : undefined;
  if (day && Number.isNaN(day.getTime())) {
    console.error(`invalid --week date: ${opts.week} (use YYYY-MM-DD)`);
    return 2;
  }

  const week = weekRange(day);
  const inWeek = events.filter((e) => e.ts >= week.startTs && e.ts < week.endTs);

  // Open-ended detector (remote): widen the net beyond the deterministic catalog.
  // It's a remote call, so it only runs on explicit opt-in (--explore).
  let extraCandidates: Candidate[] = [];
  if (opts.explore) {
    console.log(`→ open-ended detection on Copilot CLI (model: ${remoteModel})…`);
    extraCandidates = await exploreCandidates(inWeek, copilotRunner("explore"), {
      denylist,
      salt,
      level,
      model: remoteModel,
    });
    console.log(`  ${extraCandidates.length} additional candidate(s) found\n`);
  }

  // Longitudinal layer (§7): fold this week's deterministic lessons into the
  // persistent theme store and recompute each lesson's lifecycle. Local-only —
  // no remote call. We surface only the ones that MATERIALLY changed this week.
  const lessons = trackLessonsForWeek(dbPath, inWeek, weekKey(week.startTs));

  let input: Awaited<ReturnType<typeof buildDigestInput>>;
  try {
    input = await buildDigestInput(events, ollamaClient({ model: localModel }), denylist, salt, {
      day,
      minConfidence,
      level,
      extraCandidates,
      lessons,
    });
  } catch (err) {
    if (err instanceof RedactionError) {
      console.error(`✗ redaction self-check failed — send aborted: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // The always-available local digest, then the exact would-be-sent payload.
  console.log(localDigest(input));
  console.log(`\n${previewText(input)}`);

  if (input.redacted.length === 0) {
    console.log("\nNo findings for this week above the confidence bar — nothing to send.");
    return 0;
  }
  if (!opts.send) {
    console.log("\n(local digest above — re-run with --send for the remote synthesis)");
    return 0;
  }

  console.log(`\n→ synthesizing on Copilot CLI (model: ${remoteModel})…\n`);
  const result = await synthesize(input, copilotRunner("digest"), remoteModel);
  console.log(result.digest ?? "(no digest returned)");
  return 0;
}

/**
 * The whole workflow in one shot: capture → weekly digest (open-ended detector
 * + remote synthesis). `--local` stops before any remote call (capture + the
 * fully-local digest). All the usual digest flags (`--redact`, `--week`, …)
 * apply.
 */
async function run(
  dbPath: string,
  localModel: string,
  remoteModel: string,
  minConfidence: number,
  opts: { local: boolean; week?: string; redact?: string },
): Promise<number> {
  console.log("━━ 1/2  capture ━━");
  const captured = await capture(dbPath);
  if (captured !== 0) return captured;

  console.log("\n━━ 2/2  digest ━━");
  // The "full" workflow is the remote path; --local keeps it on-machine.
  return await digest(dbPath, localModel, remoteModel, minConfidence, {
    send: !opts.local,
    explore: !opts.local,
    week: opts.week,
    redact: opts.redact,
  });
}

async function serve(dbPath: string, port: number): Promise<number> {
  const { startServer } = await import("./dashboard.ts");
  startServer(dbPath, port);
  await new Promise<never>(() => {}); // run until interrupted (Ctrl-C)
  return 0; // unreachable
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      db: { type: "string", default: "./postcaptain.db" },
      port: { type: "string", default: "4317" },
      model: { type: "string", default: "llama3.2:latest" },
      "remote-model": { type: "string", default: "auto" },
      "min-confidence": { type: "string", default: "0.6" },
      send: { type: "boolean", default: false },
      explore: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      redact: { type: "string" },
      week: { type: "string" },
    },
    allowPositionals: true,
  });
  const dbPath = values.db as string;

  switch (cmd) {
    case "capture":
      return await capture(dbPath);
    case "stats":
      return stats(dbPath);
    case "insights":
      return await insights(dbPath, values.model as string, Number(values["min-confidence"]));
    case "ask":
      return await ask(dbPath, values.model as string, positionals.join(" "));
    case "lessons":
      return lessons(dbPath);
    case "digest":
      return await digest(
        dbPath,
        values.model as string,
        values["remote-model"] as string,
        Number(values["min-confidence"]),
        {
          send: values.send as boolean,
          explore: values.explore as boolean,
          week: values.week as string | undefined,
          redact: values.redact as string | undefined,
        },
      );
    case "run":
      return await run(
        dbPath,
        values.model as string,
        values["remote-model"] as string,
        Number(values["min-confidence"]),
        {
          local: values.local as boolean,
          week: values.week as string | undefined,
          redact: values.redact as string | undefined,
        },
      );
    case "serve":
      return await serve(dbPath, Number(values.port));
    default:
      console.error(
        'usage: postcaptain <run|capture|stats|insights|ask "q"|lessons|digest|serve> [--db PATH] [--port N] [--model M] [--remote-model M] [--min-confidence C] [--redact strict|identifiers|raw] [--explore] [--local] [--week YYYY-MM-DD] [--send]',
      );
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
