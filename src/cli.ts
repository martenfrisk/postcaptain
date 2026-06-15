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
import { detectAll } from "./detectors.ts";
import { ollamaClient } from "./llm.ts";
import { answer } from "./query.ts";
import { loadDenylist, loadOrCreateSalt, RedactionError } from "./redact.ts";
import { sessionize } from "./sessionizer.ts";
import { EventStore } from "./store.ts";
import { buildDigestInput, copilotRunner, previewText, synthesize } from "./synthesis.ts";

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
  opts: { send: boolean; week?: string },
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
  const day = opts.week ? new Date(opts.week) : undefined;
  if (day && Number.isNaN(day.getTime())) {
    console.error(`invalid --week date: ${opts.week} (use YYYY-MM-DD)`);
    return 2;
  }

  let input: Awaited<ReturnType<typeof buildDigestInput>>;
  try {
    input = await buildDigestInput(events, ollamaClient({ model: localModel }), denylist, salt, {
      day,
      minConfidence,
    });
  } catch (err) {
    if (err instanceof RedactionError) {
      console.error(`✗ redaction self-check failed — send aborted: ${err.message}`);
      return 1;
    }
    throw err;
  }

  console.log(previewText(input));

  if (input.redacted.length === 0) {
    console.log("\nNo findings for this week above the confidence bar — nothing to send.");
    return 0;
  }
  if (!opts.send) {
    console.log("\n(preview only — re-run with --send to make the remote Copilot CLI call)");
    return 0;
  }

  console.log(`\n→ sending to Copilot CLI (model: ${remoteModel})…\n`);
  const result = await synthesize(input, copilotRunner(), remoteModel);
  console.log(result.digest ?? "(no digest returned)");
  return 0;
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
    case "digest":
      return await digest(
        dbPath,
        values.model as string,
        values["remote-model"] as string,
        Number(values["min-confidence"]),
        { send: values.send as boolean, week: values.week as string | undefined },
      );
    case "serve":
      return await serve(dbPath, Number(values.port));
    default:
      console.error(
        'usage: postcaptain <capture|stats|insights|ask "q"|digest|serve> [--db PATH] [--port N] [--model M] [--remote-model M] [--min-confidence C] [--week YYYY-MM-DD] [--send]',
      );
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
