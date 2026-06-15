/**
 * GitHub Copilot chat collector — the priority AI-usage signal (design §4/§10).
 *
 * On macOS, VS Code stores chat history per workspace under
 * `~/Library/Application Support/Code/User/workspaceStorage/<hash>/`:
 *
 *   - `state.vscdb` — a SQLite key/value table (`ItemTable(key, value)`). The
 *     key `chat.ChatSessionStore.index` holds the *session manifest* (sessionId,
 *     title, lastMessageDate, isEmpty). Older VS Code builds stored chat inline
 *     under `interactive.sessions`; modern builds externalize it.
 *   - `chatSessions/<sessionId>.json` — the full content: a `requests` array
 *     where each entry has the user `message.text`, the `response` parts,
 *     `modelId`, `agent`, `result.timings`, `followups` and a `timestamp`.
 *   - `workspace.json` — `folder` URI, mapped to a `project` key.
 *
 * This collector uses `state.vscdb` as the manifest (to skip empty sessions and
 * recover titles) and joins content from the JSON session files, emitting one
 * `ai_interaction` event per request. Tokens are estimated heuristically
 * (chars / 4) — a ranking signal, not a bill (design §4/§12).
 *
 * There is no official Copilot export API; the format here is reverse-engineered
 * from live data and may shift between VS Code versions. Keep parsing defensive.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, extractTicket, makeEvent, stableEventId } from "../events.ts";

/** Copilot prompts/responses contain proprietary code → always sensitive (§8). */
const SENSITIVITY = "sensitive" as const;

/** VS Code editor flavors that share the same storage layout. */
const USER_DIR_CANDIDATES = ["Code/User", "Code - Insiders/User", "VSCodium/User"];

const SESSION_INDEX_KEY = "chat.ChatSessionStore.index";

/** chars-per-token heuristic for the token *ranking* signal (design §4/§12). */
const CHARS_PER_TOKEN = 4;

/** Existing VS Code `User` directories for the current macOS user. */
export function defaultUserDirs(): string[] {
  const base = join(homedir(), "Library", "Application Support");
  return USER_DIR_CANDIDATES.map((c) => join(base, c)).filter(isDir);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** One `workspaceStorage/<hash>` directory. */
class Workspace {
  constructor(readonly storageDir: string) {}

  get stateDb(): string {
    return join(this.storageDir, "state.vscdb");
  }

  get sessionsDir(): string {
    return join(this.storageDir, "chatSessions");
  }

  /** Project key from `workspace.json`'s `folder` URI (basename). */
  project(): string | null {
    const data = readJson(join(this.storageDir, "workspace.json")) as
      | { folder?: string; workspace?: string }
      | undefined;
    const folder = data?.folder ?? data?.workspace;
    if (!folder) return null;
    const path = folder.includes("://") ? fileURLToPath(folder) : folder;
    return basename(path) || null;
  }
}

interface SessionMeta {
  title?: string;
  isEmpty?: boolean;
}

/**
 * Return the session manifest from `state.vscdb`, keyed by sessionId.
 *
 * Opens a temp copy read-only so a running VS Code (which may hold a lock on
 * the live DB) is never disturbed. Returns `{}` if the DB or key is absent.
 */
function readSessionIndex(stateDb: string): Record<string, SessionMeta> {
  if (!existsSync(stateDb)) return {};
  const dir = mkdtempSync(join(tmpdir(), "postcaptain-vscdb-"));
  const copy = join(dir, "state.vscdb");
  copyFileSync(stateDb, copy);
  const db = new Database(copy, { readonly: true });
  try {
    const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(SESSION_INDEX_KEY) as
      | { value: string | Uint8Array }
      | null;
    if (!row?.value) return {};
    const text = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value);
    const parsed = JSON.parse(text) as { entries?: Record<string, SessionMeta> };
    return parsed.entries ?? {};
  } catch {
    return {};
  } finally {
    db.close();
  }
}

/** Coarse interaction mode from the agent id (ask vs edit/agent). */
function agentMode(agentId: string | undefined): "ask" | "agent" {
  const a = (agentId ?? "").toLowerCase();
  return a.includes("edit") || a.includes("agent") ? "agent" : "ask";
}

/** Join the markdown `value` of textual response parts; ignore the rest. */
function responseText(response: unknown): string {
  if (!Array.isArray(response)) return "";
  const out: string[] = [];
  for (const part of response) {
    if (part && typeof part === "object" && typeof (part as { value?: unknown }).value === "string") {
      out.push((part as { value: string }).value);
    }
  }
  return out.join("");
}

function estTokens(chars: number): number {
  return Math.floor(chars / CHARS_PER_TOKEN);
}

interface RawRequest {
  requestId?: string;
  message?: { text?: string };
  response?: unknown;
  modelId?: string;
  agent?: { id?: string };
  result?: { timings?: { totalElapsed?: number } };
  followups?: unknown[];
  isCanceled?: boolean;
  timestamp?: number;
}

interface RawSession {
  sessionId?: string;
  customTitle?: string;
  creationDate?: number;
  lastMessageDate?: number;
  requests?: RawRequest[];
}

/** Yield one `ai_interaction` Event per request in a session JSON file. */
export function parseSession(
  sessionPath: string,
  opts: { project?: string | null; title?: string } = {},
): Event[] {
  const data = readJson(sessionPath) as RawSession | undefined;
  if (!data) return [];

  const sessionId = data.sessionId ?? basename(sessionPath, ".json");
  const requests = data.requests ?? [];
  const requestCount = requests.length;
  // Fallback event time for requests missing their own timestamp.
  const sessionTs = data.lastMessageDate ?? data.creationDate ?? 0;
  // The workspace folder name can itself carry a ticket key as a last resort.
  const ticket = extractTicket(opts.project);

  const events: Event[] = [];
  requests.forEach((req, idx) => {
    if (!req || typeof req !== "object") return;
    const requestId = req.requestId ?? String(idx);
    const prompt = req.message?.text ?? "";
    const response = responseText(req.response);
    const promptChars = prompt.length;
    const responseChars = response.length;
    const agentId = req.agent?.id;
    const followups = Array.isArray(req.followups) ? req.followups : [];

    events.push(
      makeEvent({
        eventId: stableEventId("copilot", sessionId, requestId),
        kind: "ai_interaction",
        source: "copilot",
        ts: req.timestamp ?? sessionTs,
        sensitivity: SENSITIVITY,
        project: opts.project ?? null,
        ticket,
        payload: {
          tool: "copilot",
          sessionId,
          sessionTitle: opts.title ?? data.customTitle ?? null,
          requestId,
          requestIndex: idx,
          requestCount,
          prompt,
          promptChars,
          responseChars,
          promptTokensEst: estTokens(promptChars),
          responseTokensEst: estTokens(responseChars),
          tokensEst: estTokens(promptChars + responseChars),
          model: req.modelId ?? null,
          agentId: agentId ?? null,
          agentMode: agentMode(agentId),
          elapsedMs: req.result?.timings?.totalElapsed ?? null,
          isCanceled: Boolean(req.isCanceled),
          followupCount: followups.length,
        },
      }),
    );
  });
  return events;
}

/** Yield events for one workspace, using the state.vscdb index as manifest. */
function parseWorkspace(ws: Workspace): Event[] {
  if (!isDir(ws.sessionsDir)) return [];
  const index = readSessionIndex(ws.stateDb);
  const project = ws.project();

  const events: Event[] = [];
  const files = readdirSync(ws.sessionsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const sessionId = basename(file, ".json");
    const meta = index[sessionId] ?? {};
    // Trust the manifest's emptiness flag to skip no-op sessions cheaply.
    if (meta.isEmpty === true) continue;
    events.push(...parseSession(join(ws.sessionsDir, file), { project, title: meta.title }));
  }
  return events;
}

/**
 * Collect `ai_interaction` events from all local VS Code Copilot history.
 *
 * Pass `userDirs` to point at specific VS Code `User` directories (used by
 * tests); defaults to the standard macOS locations.
 */
export function collect(userDirs?: string[]): Event[] {
  const dirs = userDirs ?? defaultUserDirs();
  const events: Event[] = [];
  for (const userDir of dirs) {
    const storage = join(userDir, "workspaceStorage");
    if (!isDir(storage)) continue;
    for (const entry of readdirSync(storage).sort()) {
      const storageDir = join(storage, entry);
      if (isDir(storageDir)) events.push(...parseWorkspace(new Workspace(storageDir)));
    }
  }
  return events;
}
