# CLAUDE.md

Guidance for working in this repo.

## What this is

A **local-first, privacy-gated AI work mentor**. It passively captures how a
workday is spent (code, AI-tool usage, tickets, PRs, reading, meetings) into one
local event store, then runs a disciplined insight layer over it. See
[`work-mentor-design.md`](work-mentor-design.md) — that document is the source of
truth for architecture and decisions. Read it before making design changes.

It is **not** a dashboard or a data lake. Capture is the easy part; the value is
the insight layer (detectors → themes → characterizer → weekly digest).

## Current phase

The pipeline is working end-to-end: **capture → sessionize → detect →
characterize → recap → dashboard**, plus interactive **`ask`**. Collectors:
Copilot chat, local git commits, and **macOS Calendar** (`collectors/calendar.ts`
— reads the local `Calendar.sqlitedb`, so a work Outlook/Exchange account synced
into Calendar.app is captured without any remote API; feeds the meeting-load
lesson). The model layers (`characterizer.ts`,
`query.ts`, `llm.ts`) run on a local Ollama model (default `llama3.2:latest`)
via the `insights` and `ask` commands; both fall back gracefully if Ollama is
down. The weekly *remote* synthesis (`digest`, via GitHub Copilot CLI) and the
remote open-ended detector (`explore.ts`, `digest --explore`) are built and
metered (`usage.ts`). **Phase 4 (themes/lessons) is built** for the
deterministic-lesson backbone: `themes.ts` persists `lesson`-category
candidates week-over-week (the `themes`/`theme_observations` tables) and tracks
a lifecycle (`new → active → improving → regressed → resolved → dormant`) with a
trend; lessons surface in the `digest` and dashboard **only on material change**
(§7 anti-Clippy), and `postcaptain lessons` shows the tracked trends. Still
pending: knowledge-base notes (`kb_notes`/`kb_links`, blocked on a `reading`
collector / screenpipe) and the self-growing exploration tier (phase 5).

## Stack & conventions

- **Language:** TypeScript on **Bun**. Run TS directly (no build step). The
  capture layer has **zero runtime dependencies** — `bun:sqlite` and `node:fs`
  cover it. camelCase in code; SQL columns stay snake_case.
- **Store:** local SQLite via `bun:sqlite`. One `events` table, typed JSON
  `payload` per kind. Each event carries `project`, `ticket`, `sensitivity`
  (set at collection time — sensitivity drives all later routing, see §8).
- **Layout:** `src/` (`events.ts`, `store.ts`, `collectors/`, `sessionizer.ts`,
  `detectors.ts`, `explore.ts` (remote open-ended detector), `characterizer.ts`,
  `recap.ts`, `themes.ts` (longitudinal lessons), `redact.ts`, `synthesis.ts`,
  `usage.ts`, `dashboard.ts`, `cli.ts`); `tests/` holds
  `*.test.ts` run by `bun test`. Analysis stages (sessionizer, detectors, recap)
  are pure functions over events — easy to test and re-run. `themes.ts` is the
  one exception by design: it's the **only stateful stage**, persisting derived
  lesson state across runs in its own tables (the lifecycle logic stays pure;
  `ThemeStore` is the thin SQLite wrapper, idempotent per `(theme, week)`).
- **Idempotency:** collectors are re-runnable. Events have a deterministic
  `event_id` derived from the source's natural key; inserts are `OR IGNORE`.
- **Privacy (tiered, owner-configurable):** the remote redaction level
  (`redact.ts`) is a setting — `strict` (full §8 pseudonymization), `identifiers`
  (default; repo/ticket/host/path names readable), or `raw` (verbatim
  prompts/code). Set it in `redaction.toml` (`level = "..."`) or per-run via
  `--redact`. **Invariant that holds at every tier:** credential/secret masking
  is always on, and the fail-closed secret-shape self-check (`assertClean`) runs
  regardless of tier — a leaked key must never go remote. The denylist-literal
  check only applies at `strict`. When adding code that sends data remote, route
  text through `redactText`/`assertClean` at the active level; never bypass the
  secret masking.

### Domain keys (design §5/§12)

- **Work session:** new session after ~25–30 min inactivity (AFK) or a project
  switch.
- **Ticket / project key:** Jira key regex `[A-Z][A-Z0-9]+-\d+`, extracted from
  branch names (`ABC-123-...`), commits/PR titles as fallback. This is the
  backbone join key across tools.
- **Token estimate:** heuristic `chars ÷ 4`. It's a ranking signal, not a bill.

## Commands

```bash
bun install              # one-time: dev deps (@types/bun, typescript, biome)
bun test                 # run the test suite
bun run typecheck        # tsc --noEmit
bun run lint             # biome check (lint + format + import order)
bun run format           # biome check --write (apply fixes)

# run the capture spike (parses local VS Code Copilot history into a SQLite store)
bun run src/cli.ts capture --db ./postcaptain.db
bun run src/cli.ts stats   --db ./postcaptain.db
```

Before committing, run `bun run format`, `bun run lint`, `bun run typecheck`, and
`bun test`. Biome is configured in `biome.json` (double quotes, 2-space, 100-col);
non-null assertions are allowed in `tests/**` since they pair with strict index
access.

## Gotchas

- VS Code's `state.vscdb` may be locked by a running editor. The parser copies it
  to a temp file and opens it read-only/immutable — never write to it.
- VS Code chat moved from inline `interactive.sessions` blobs to external
  `chatSessions/<id>.json` files indexed by `chat.ChatSessionStore.index`. The
  parser uses the index as the manifest and joins content from the JSON files.
- macOS Calendar (`Calendar.sqlitedb`) is WAL-active and locked by Calendar.app;
  the collector copies it **with its `-wal`/`-shm`** to temp (else recent events
  are missed) and reads the copy. Dates are Core Data REAL (seconds since
  2001-01-01 → add `978307200`, ×1000 for ms). An event is `entity_type = 2`
  on-disk — **not** EventKit's documented `0` (verified against live data).
