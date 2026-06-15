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
import * as copilot from "./collectors/copilot.ts";
import * as github from "./collectors/github.ts";
import { EventStore } from "./store.ts";

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

async function serve(dbPath: string, port: number): Promise<number> {
  const { startServer } = await import("./dashboard.ts");
  startServer(dbPath, port);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      db: { type: "string", default: "./postcaptain.db" },
      port: { type: "string", default: "4317" },
    },
    allowPositionals: false,
  });
  const dbPath = values.db as string;

  switch (cmd) {
    case "capture":
      return await capture(dbPath);
    case "stats":
      return stats(dbPath);
    case "serve":
      return await serve(dbPath, Number(values.port));
    default:
      console.error("usage: postcaptain <capture|stats|serve> [--db PATH] [--port N]");
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
