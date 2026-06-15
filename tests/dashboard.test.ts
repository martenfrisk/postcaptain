import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel, renderPage, startServer } from "../src/dashboard.ts";
import { type Event, makeEvent } from "../src/events.ts";
import { EventStore } from "../src/store.ts";

let dir: string;
let dbPath: string;

function seed(store: EventStore): void {
  const events: Event[] = [];
  let seq = 0;
  const base = Date.parse("2026-01-02T10:00:00Z");
  for (let i = 0; i < 7; i++) {
    events.push(
      makeEvent({
        eventId: `ai${seq++}`,
        kind: "ai_interaction",
        source: "copilot",
        ts: base + i * 60_000,
        sensitivity: "sensitive",
        project: "demo",
        ticket: "ABC-1",
        payload: {
          prompt: `step ${i}`,
          model: "copilot/gpt-4.1",
          agentMode: "agent",
          tokensEst: 100,
        },
      }),
    );
  }
  events.push(
    makeEvent({
      eventId: "c1",
      kind: "commit",
      source: "github",
      ts: base + 8 * 60_000,
      sensitivity: "sensitive",
      project: "demo",
      ticket: "ABC-1",
      payload: { subject: "<script>alert(1)</script>", insertions: 5, deletions: 1 },
    }),
  );
  store.addMany(events);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "postcaptain-dash-"));
  dbPath = join(dir, "t.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("renderPage produces an HTML document with the key sections", () => {
  const store = new EventStore(dbPath);
  seed(store);
  const html = renderPage(buildModel(store));
  store.close();

  expect(html).toContain("<!doctype html>");
  expect(html).toContain("postcaptain");
  expect(html).toContain("AI interactions");
  expect(html).toContain("Findings");
  expect(html).toContain("Recent sessions");
  // the 7-prompt session should trip the struggle detector
  expect(html).toContain("High AI churn");
});

test("renderPage escapes untrusted content (commit subjects, prompts)", () => {
  const store = new EventStore(dbPath);
  seed(store);
  const html = renderPage(buildModel(store));
  store.close();
  expect(html).not.toContain("<script>alert(1)</script>");
});

test("startServer responds 200 with HTML", async () => {
  const store = new EventStore(dbPath);
  seed(store);
  store.close();

  const server = startServer(dbPath, 0); // ephemeral port
  try {
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("postcaptain");
  } finally {
    server.stop(true);
  }
});
