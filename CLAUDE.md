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

**Phase 1 — capture spike** (§11 of the design doc): collectors → normalized
event store. First slice: the events schema + the Copilot `state.vscdb` parser.
Later collectors (GitHub, ActivityWatch, calendar) normalize into the same store.

## Stack & conventions

- **Language:** Python 3.10+, standard library first. No heavy deps in the
  capture layer — `sqlite3`, `json`, `pathlib` are enough.
- **Store:** local SQLite. One `events` table, typed JSON `payload` per kind.
  Each event carries `project`, `ticket`, `sensitivity` (set at collection time —
  sensitivity drives all later routing, see §8).
- **Layout:** `src/postcaptain/` package; `tests/` mirrors it.
- **Idempotency:** collectors are re-runnable. Events have a deterministic
  `event_id` derived from the source's natural key; inserts are `OR IGNORE`.
- **Privacy:** raw prompts/code never leave the machine. Copilot/GitHub/Jira
  events are `sensitive`. Only redacted, abstracted insights are remote-eligible.
  Do not add code that ships raw payloads anywhere.

### Domain keys (design §5/§12)

- **Work session:** new session after ~25–30 min inactivity (AFK) or a project
  switch.
- **Ticket / project key:** Jira key regex `[A-Z][A-Z0-9]+-\d+`, extracted from
  branch names (`ABC-123-...`), commits/PR titles as fallback. This is the
  backbone join key across tools.
- **Token estimate:** heuristic `chars ÷ 4`. It's a ranking signal, not a bill.

## Commands

```bash
# run tests
python3 -m pytest -q

# run the capture spike (parses local VS Code Copilot history into a SQLite store)
python3 -m postcaptain.cli capture --db ./postcaptain.db
python3 -m postcaptain.cli stats  --db ./postcaptain.db
```

(Install dev deps with `pip install -e '.[dev]'` or `uv pip install -e '.[dev]'`.)

## Gotchas

- VS Code's `state.vscdb` may be locked by a running editor. The parser copies it
  to a temp file and opens it read-only/immutable — never write to it.
- VS Code chat moved from inline `interactive.sessions` blobs to external
  `chatSessions/<id>.json` files indexed by `chat.ChatSessionStore.index`. The
  parser uses the index as the manifest and joins content from the JSON files.
