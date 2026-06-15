/**
 * Tests for the Copilot collector against a synthetic VS Code storage tree.
 *
 * The fixtures mirror the real on-disk format observed on macOS: a `state.vscdb`
 * SQLite key/value table with a `chat.ChatSessionStore.index` manifest, plus
 * `chatSessions/<id>.json` content files and a `workspace.json`.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/collectors/copilot.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "postcaptain-copilot-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SID_FULL = "11111111-1111-1111-1111-111111111111";
const SID_EMPTY = "22222222-2222-2222-2222-222222222222";

function writeStateDb(storageDir: string, entries: Record<string, unknown>): void {
  const db = new Database(join(storageDir, "state.vscdb"), { create: true });
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.query("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "chat.ChatSessionStore.index",
    JSON.stringify({ version: 1, entries }),
  );
  db.close();
}

function session(sessionId: string, requests: unknown[], last = 123): unknown {
  return {
    version: 3,
    sessionId,
    requesterUsername: "tester",
    responderUsername: "GitHub Copilot",
    creationDate: last,
    lastMessageDate: last,
    requests,
  };
}

/** Build one workspaceStorage/<hash> dir; return the VS Code User dir. */
function makeWorkspace(): string {
  const user = join(root, "Code", "User");
  const storage = join(user, "workspaceStorage", "deadbeef");
  const sessions = join(storage, "chatSessions");
  mkdirSync(sessions, { recursive: true });

  writeFileSync(
    join(storage, "workspace.json"),
    JSON.stringify({ folder: "file:///Users/tester/Web/ABC-123-demo" }),
  );

  const requests = [
    {
      requestId: "req-0",
      message: { text: "Fix these type errors please" },
      response: [{ value: "Here is the fix: ..." }],
      modelId: "copilot/gpt-4.1",
      agent: { id: "github.copilot.editsAgent" },
      result: { timings: { firstProgress: 100, totalElapsed: 500 } },
      followups: [],
      isCanceled: false,
      timestamp: 1758000000000,
    },
    {
      requestId: "req-1",
      message: { text: "still broken, try again" },
      response: [{ value: "Updated." }, { toolId: "x" }], // non-text part ignored
      modelId: "copilot/gpt-4.1",
      agent: { id: "github.copilot.default" },
      result: { timings: { totalElapsed: 200 } },
      isCanceled: true,
      timestamp: 1758000100000,
    },
  ];
  writeFileSync(join(sessions, `${SID_FULL}.json`), JSON.stringify(session(SID_FULL, requests)));
  writeFileSync(join(sessions, `${SID_EMPTY}.json`), JSON.stringify(session(SID_EMPTY, [])));

  writeStateDb(storage, {
    [SID_FULL]: { sessionId: SID_FULL, title: "Type errors", isEmpty: false },
    [SID_EMPTY]: { sessionId: SID_EMPTY, title: "Empty", isEmpty: true },
  });
  return user;
}

test("emits one event per request, skipping empty sessions via manifest", () => {
  const user = makeWorkspace();
  expect(collect([user])).toHaveLength(2);
});

test("event fields and payload", () => {
  const user = makeWorkspace();
  const events = collect([user]);
  const first = events.find((e) => e.payload.requestIndex === 0)!;

  expect(first.kind).toBe("ai_interaction");
  expect(first.source).toBe("copilot");
  expect(first.sensitivity).toBe("sensitive");
  expect(first.ts).toBe(1758000000000);
  expect(first.project).toBe("ABC-123-demo");
  expect(first.ticket).toBe("ABC-123"); // extracted from the workspace folder name

  const p = first.payload;
  expect(p.model).toBe("copilot/gpt-4.1");
  expect(p.agentMode).toBe("agent"); // editsAgent → agent
  expect(p.requestCount).toBe(2);
  expect(p.elapsedMs).toBe(500);
  expect(p.sessionTitle).toBe("Type errors");
  expect(p.promptTokensEst).toBe(Math.floor("Fix these type errors please".length / 4));
  expect(p.tokensEst).toBe(Number(p.promptTokensEst) + Number(p.responseTokensEst));
});

test("event ids are stable and idempotent across runs", () => {
  const user = makeWorkspace();
  const ids1 = collect([user])
    .map((e) => e.eventId)
    .sort();
  const ids2 = collect([user])
    .map((e) => e.eventId)
    .sort();
  expect(ids1).toEqual(ids2);
  expect(ids1[0]!.startsWith("copilot:")).toBe(true);
});

test("response text only joins textual parts; canceled flag preserved", () => {
  const user = makeWorkspace();
  const second = collect([user]).find((e) => e.payload.requestIndex === 1)!;
  expect(second.payload.responseChars).toBe("Updated.".length);
  expect(second.payload.isCanceled).toBe(true);
  expect(second.payload.agentMode).toBe("ask");
});

test("missing storage is a no-op", () => {
  expect(collect([join(root, "nope")])).toEqual([]);
});
