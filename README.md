# postcaptain

> Codename TBD. A **local-first, privacy-gated AI work mentor**.

postcaptain passively captures how a workday is actually spent — code written, AI
tools used, tickets, PRs, docs read, meetings, context-switching — into one local
event store, then runs a disciplined insight layer over it: a daily recap, a
weekly digest, and an ad-hoc query interface, delivered like a senior developer
who sits nearby. The strategic focus is **how AI is used, and how to use it
better**, as development goes AI-first.

It is explicitly **not** a dashboard or a data lake. Raw code, prompts, responses
and meeting content never leave the machine; only redacted, abstracted insights
are ever eligible for a remote model call.

See [`work-mentor-design.md`](work-mentor-design.md) for the full design.

## Status

**Phase 1 — capture spike** (design §11). Building the foundation: a normalized
event store and the first collector (GitHub Copilot chat history). GitHub,
ActivityWatch and calendar collectors follow, then detectors and the digest.

### Done so far

- Normalized event model (`postcaptain.events`) — `Event`, the `kind` /
  `source` / `sensitivity` enums, Jira-ticket extraction, deterministic event ids.
- SQLite event store (`postcaptain.store`) — one `events` table, idempotent
  inserts, filtered queries.
- Copilot collector (`postcaptain.collectors.copilot`) — parses VS Code's
  `state.vscdb` session manifest + `chatSessions/*.json` into `ai_interaction`
  events.

## Quickstart

```bash
pip install -e '.[dev]'      # or: uv pip install -e '.[dev]'

# parse local VS Code Copilot history into a SQLite store (idempotent)
python3 -m postcaptain.cli capture --db ./postcaptain.db
python3 -m postcaptain.cli stats   --db ./postcaptain.db

python3 -m pytest -q
```

Captured data is local and git-ignored (`*.db`).

## Layout

```
src/postcaptain/
  events.py            # the normalized Event model + domain keys
  store.py             # SQLite event store
  collectors/
    copilot.py         # VS Code / GitHub Copilot chat collector
  cli.py               # capture / stats spike runner
tests/                 # synthetic-fixture tests (no machine data needed)
```
