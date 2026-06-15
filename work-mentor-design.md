# Personal AI Work Mentor — Design Document

> **Status:** Firm spec · v0.3 · 2026-06-15
> **Codename:** Postcaptain
> **Owner:** Mårten
> **Purpose of this doc:** Capture the architecture and design decisions, now firm enough to build against. Phase 1 (capture spike) is underway; this doc is the source of truth for what to build.
> **v0.3 changelog:** Closed the last open items from §12 — redaction rules + denylist (§8), characterizer remote-escalation policy (§5/§8), knowledge-base schema and the consumption↔work join (§7), and the confidence-calibration procedure (§6). Folded in the verified Copilot on-disk format (§4) and the concrete event-store DDL (§5) from the Phase 1 spike. Set the codename (Postcaptain). Status promoted from living draft to firm spec.
> **v0.2 changelog:** Resolved the open-questions list (§12) and threaded the decisions into §5–§11 — work-session/ticket keying, token estimation, Copilot CLI as the synthesis engine, retention tiers, gate thresholds, and lesson progress display.

---

## 1. What this is

A local-first system that passively captures how a workday is actually spent — code written, AI tools used, tickets, PRs, docs and articles read, meetings and context-switching — and turns that raw activity into a small set of **actionable insights**, delivered like a senior developer/mentor who sits nearby: knows your week, suggests concrete improvements, and can be asked questions on demand.

It is explicitly **not** a dashboard or a data lake. Capturing data is the easy part and not the point. The value is in a disciplined insight layer that earns its keep.

### Success looks like

- A short daily recap and a weekly digest that surface a handful of insights worth acting on.
- A strong focus on **how AI is used and how to use it better** — including, as we move toward AI-first/AI-only development, suggesting codebase- and workflow-tailored agents, prompts, and MCP workflows.
- An ad-hoc query interface: *"When did I work on feature X?"*, *"How much time went to PR reviews last week?"*
- A personal knowledge base built from what's read (docs, HN, specs), linked back to the work it relates to.
- Insights that stay fresh over months instead of devolving into Clippy-style repetition.

---

## 2. Design principles

1. **Local-first, privacy-gated.** Raw code, prompts, responses, and meeting content never leave the machine. Only abstracted, redacted insight objects are eligible for occasional remote (more powerful) model calls.
2. **Deterministic trigger, LLM narrate.** Cheap, deterministic detectors find candidate patterns; the LLM only characterizes a candidate and drafts the fix. The model is the narrator, not the search engine.
3. **Every insight ships an artifact + evidence.** "Consider a skill" is ignored; a drafted skill/snippet/alias you accept or reject gets used. Every insight links back to the source events that produced it.
4. **Open-ended discovery, with a memory and an evidence bar.** The system can find improvement areas nobody pre-specified — but novelty must be validated against data and de-duplicated against everything previously surfaced. (See §6.)
5. **Track, don't re-suggest.** Once a pattern is known, the mentor monitors it quietly and speaks up only when it changes. This is what separates a mentor from a linter.
6. **Pull-based + scheduled digest.** Always queryable; daily/weekly reports. No real-time nagging (deferred — see §9).
7. **Code/AI-usage is first-class** for actionability; **non-code time is first-class** for time-shape insight. Both matter, in different roles. (See §4.)

---

## 3. Non-goals (for now)

- **Proactive/real-time interruptions ("nagging").** Deferred; revisit after the digest format proves useful.
- **Capturing meeting *content*** (Teams audio, on-screen meeting material). Metadata is enough for time-shape coaching and far safer. Revisit only with a clear use case.
- **Personal-life tracking.** Out of scope by nature of the day (~10 min/day puzzle games + non-tech HN). Handled by a tiny exclusion list, not a classifier.
- **Team/manager surveillance.** This is a personal tool for self-improvement, single-user.

---

## 4. Data sources (collectors)

All collectors normalize into one local event store. Each event carries a **sensitivity tag set at collection time**, which drives all later routing.

| Source | Captures | Sensitivity | Role |
|---|---|---|---|
| **VS Code + Copilot** | Chat prompts/responses, follow-up counts, accepted vs rejected suggestions, token estimates | sensitive | AI-usage analysis (primary) |
| **GitHub** | Commits, branches, PRs, review activity, diff stats; MCP-driven actions | sensitive | Code work + ticket linkage |
| **Jira (Atlassian)** | Ticket IDs, status transitions, time-on-ticket (via branch/PR linkage) | sensitive | Per-ticket time + context |
| **Calendar / MS Teams** | Meeting titles, durations, frequency, attendee count (metadata only) | low–medium | Time-shape, meeting load |
| **ActivityWatch** | Active window/app, focus duration, app-switch counts, AFK | low–medium | Context-switching, time-shape (primary) |
| **screenpipe** | Reading: docs, specs, HN, browser tabs (OCR/extracted text + URL) | mixed | Knowledge base + reading-vs-doing |
| **Git/editor time** (WakaTime or ActivityWatch editor watcher) | Time per file/project/language | sensitive | Coding-time breakdown |

### Notes

- **Code + AI usage stays heavily analyzed.** It's the most actionable, easiest-to-find-insights vein, and the most strategically important as development goes AI-first. Copilot data is the priority signal here.
- **Most of the day is not coding** (specs, colleagues, Teams, reading). So the *time-shape* insights (context-switching, meeting load, maker-vs-meeting balance) lean primarily on calendar metadata + ActivityWatch + screenpipe. The mentor reasons over the whole day, not just the code stream.
- **Copilot on Mac (format verified in Phase 1 spike):** chat history lives per workspace under `~/Library/Application Support/Code/User/workspaceStorage/<hash>/`. Three files matter:
  - `state.vscdb` — a SQLite key/value table (`ItemTable(key, value)`). The key `chat.ChatSessionStore.index` holds the **session manifest** (`sessionId`, `title`, `lastMessageDate`, `isEmpty`). Older VS Code builds stored chat inline under `interactive.sessions`; modern builds externalize it.
  - `chatSessions/<sessionId>.json` — the full content: a `requests[]` array where each entry carries the user `message.text`, the `response[]` markdown parts, `modelId` (e.g. `copilot/gpt-4.1`), `agent.id` (ask vs edits/agent mode), `result.timings.totalElapsed`, `followups`, `isCanceled`, and a `timestamp`.
  - `workspace.json` — the `folder` URI, mapped to the `project` key.
  - **Parser approach:** use the `state.vscdb` index as the manifest (skip `isEmpty` sessions, recover titles), join content from the session JSON, emit one `ai_interaction` event per request. Open `state.vscdb` from a read-only temp copy so a running VS Code is never disturbed. There is no official export API and the format shifts between VS Code versions, so parsing stays defensive (CodeHist/WayLog remain useful cross-references).
- **Token estimation (resolved):** tokens are a *ranking signal* ("this was an expensive session"), not a bill, so relative accuracy is fine. **Start with a heuristic** (≈ chars ÷ 4). Upgrade later if needed via the `ai-engineering-fluency` extension (reads session logs automatically) or the debug log (`github.copilot.chat.agentDebugLog.enabled` + `/troubleshoot`, accurate but manual and forward-only).
- **MCP surfaces:** GitHub + Atlassian MCPs (already in use) are both a *data source* and an *automation target* — the system can observe MCP-driven workflows and later suggest/refine agents around them (see §7).
- **Personal filtering:** a small denylist of puzzle-game app/window names dropped at collection. Non-tech HN still flows in as reading events; it just won't trigger work detectors.

---

## 5. Architecture

A staged pipeline over a shared local SQLite store. Each stage is independently re-runnable.

```
Collectors → Event store → Sessionizer
   → Deterministic detectors  ─┐
   → Theme aggregation (cross-session) ─┤
   → Exploration tier (hypothesis → validate → promote) ─┘
        → Candidates
        → Privacy gate (sensitivity tag + redaction + local/remote routing)
        → Characterizer (bounded harness agent, local LLM)
        → Ranker / dedup / feedback
        → Daily recap  +  Weekly digest (Copilot CLI, redacted)

Interactive query  ──►  same harness, interactive mode
```

### Stage roles

- **Event store.** One `events` table with a typed JSON payload per kind (`edit`, `ai_interaction`, `reading`, `commit`, `pr_review`, `meeting`, `afk`), plus `project`, `ticket`, `sensitivity`.
- **Sessionizer (resolved).** Groups events into work sessions so detectors reason about "a stretch of work," not isolated events. Two parameters:
  - *Gap threshold:* a new session starts after ~25–30 min of inactivity (AFK) **or** a project switch.
  - *Project keying:* the **Jira ticket key is the backbone join key** across all code tools. Branches follow the `ABC-123-new-feature` convention, so a regex `[A-Z][A-Z0-9]+-\d+` extracts the key from branch names; commits and PR titles carry it as a fallback. Sessions key on ticket when present, repo/workspace when not.
- **Deterministic detectors.** Pure functions (events → candidate rows). Reliable backbone for known pattern forms. No LLM. (See §6 for the seed catalog.)
- **Theme aggregation.** Rolls candidates up by topic across sessions/weeks, producing the longitudinal signal that powers *lessons* (e.g. "recurring feedback on React effects").
- **Exploration tier.** Low-frequency open-ended pass that proposes *new* detector hypotheses, not one-off tips (§6).
- **Privacy gate.** Tags candidate sensitivity (max over evidence), redacts, and routes local vs remote (§8).
- **Characterizer.** A small tool-using agent ("harness") with a tight step budget and read-only tools — query the event store, pull a session transcript, search the knowledge base, optionally one web lookup ("is there a name for this pattern?"). It enriches/verifies one candidate, then emits a structured insight. Runs on the **local** model.
- **Ranker / dedup / feedback.** Scores, removes near-duplicates and dismissed signatures, keeps top N.
- **Digest.** Daily recap (lightweight, no LLM needed) + weekly synthesis (the one occasional remote call via Copilot CLI, on abstracted insights).
- **Interactive query = the same harness, interactive mode.** Scheduled mode is triggered by a candidate (autonomous, bounded); interactive mode is triggered by you (conversational). One agent, two entry points.

### Event store schema (implemented in Phase 1)

One table, typed JSON payload per kind. Writes are idempotent via a deterministic `event_id` derived from each source's natural key (for Copilot: `copilot:<sessionId>:<requestId>`), so every collector is safe to re-run.

```sql
CREATE TABLE events (
    event_id     TEXT PRIMARY KEY,        -- deterministic; INSERT OR IGNORE
    kind         TEXT NOT NULL,           -- edit | ai_interaction | reading | commit | pr_review | meeting | afk
    source       TEXT NOT NULL,           -- copilot | github | jira | calendar | activitywatch | screenpipe | wakatime
    ts           INTEGER NOT NULL,        -- event time, epoch ms
    project      TEXT,                    -- repo/workspace key (nullable)
    ticket       TEXT,                    -- Jira key [A-Z][A-Z0-9]+-\d+ (nullable)
    sensitivity  TEXT NOT NULL,           -- low | medium | sensitive
    payload      TEXT NOT NULL,           -- kind-specific JSON
    ingested_at  INTEGER NOT NULL         -- ingest time, epoch ms
);
-- indexes on ts, (kind, ts), (project, ts), (ticket, ts)
```

`sensitivity` is set at collection time and is the max over an event's evidence; it drives all later routing (§8). The `ai_interaction` payload from the Copilot collector carries `prompt`, `promptChars`/`responseChars`, `*TokensEst` (chars ÷ 4), `model`, `agentMode`, `elapsedMs`, `isCanceled`, `followupCount`, and `requestIndex`/`requestCount` (a prompt-churn proxy). (Code is TypeScript on Bun — camelCase payload keys; SQL columns stay snake_case.)

### Candidate → insight contract (illustrative)

One candidate at a time, bounded input, JSON-only output, low temperature:

```json
{
  "headline": "string",
  "what_happened": "string",
  "suggestion": "string",
  "category": "shortcut | lesson",
  "artifact_type": "skill | snippet | git_alias | keybind | workflow | agent | note | none",
  "artifact_draft": "string",
  "evidence": ["event_id", "..."],
  "confidence": 0.0
}
```

---

## 6. Open-ended discovery without becoming Clippy

The core tension: deterministic detectors are reliable but closed-world (they only find what we coded). The real value is open-world discovery — patterns we never thought of. Naive open-endedness, though, *is* Clippy: a model emitting weekly "tips" with no memory and no evidence bar.

**Resolution: the open-ended layer proposes new detectors, not new tips.**

1. The exploration pass ranges over *aggregated, abstracted* activity and forms a hypothesis ("context-switching correlates with slower completion").
2. The hypothesis is expressed as a **measurable pattern** and validated deterministically against real data.
3. If it holds, it's **promoted to a tracked signal** the system watches from then on. If not, it's discarded. The system grows its own detectors.

So the context-switching example becomes a real detector the mentor tracks — not a tip re-rolled every Monday.

### Anti-repetition machinery (the three gates)

Every insight ever surfaced is remembered (signature + embedding). A new insight surfaces only if it is:

1. **Novel** — semantically distinct from everything shown before.
2. **Validated** — backed by data, above a confidence bar.
3. **Not dismissed** — its theme signature isn't on the dismissed list.

**Starting thresholds (resolved — these are dials, not truths):**
- Surface only if **confidence ≥ ~0.6** (LLM self-rated). Below that, hold/track silently.
- Surface only if **embedding cosine distance ≥ ~0.15–0.2** from every previously surfaced insight.
- **Start conservative** — better to under-surface than spam early on.
- **Log everything, including suppressed insights**, so the dismiss/useful feedback over the first few weeks tells us where to move the knobs.

Validated patterns become *tracked* (with state + progress), not re-suggested. Repetition is structurally prevented, not hoped against.

### Confidence calibration (resolved — a procedure, not a fixed number)

The 0.6 confidence bar is an LLM self-rating, which is uncalibrated until checked against reality. The dial is tuned by a feedback loop, not guessed:

1. **Capture feedback per surfaced insight.** Four signals: `accepted` (artifact used), `dismissed`, `useful_no_action` (acknowledged, nothing changed), and `lesson_improved` (a tracked theme trended down after surfacing). Every suppressed insight is logged too, with its self-rated confidence — so we can see what we *wrongly* held back.
2. **Build a reliability view.** Bucket surfaced insights by self-rated confidence (e.g. 0.5–0.6, 0.6–0.7, …) and compute the empirical "acted-on / useful" rate per bucket. That reliability diagram shows whether 0.6 is too loose (low buckets full of dismissals) or too tight (suppressed insights that would have been accepted).
3. **Recalibrate, don't hand-tune.** Once there are enough labels (rule of thumb: ≥ ~30 accept/dismiss decisions), fit a simple monotonic map (isotonic regression, or Platt scaling as a fallback) from raw self-rating → empirical usefulness probability, and apply the threshold against the *calibrated* score. Until then, keep the conservative raw 0.6.
4. **Cadence.** Revisit monthly during the first quarter, then quarterly. Calibration is per-category (shortcuts vs lessons calibrate separately — lessons are inherently lower-frequency and slower to confirm).

The actual numbers stay data-driven; what's resolved here is the *mechanism* that produces them.

### Seed detector catalog (starting points, open by design)

- **Struggle / skill-gap:** long single-problem session + high AI prompt-churn + high tokens → reusable prompt scaffold, snippet, or project custom-instruction.
- **Repetition:** same normalized prompt/command across days → saved prompt, snippet, alias.
- **Prompt quality:** one-shot vs multi-follow-up ratio by task type → a prompting habit to change.
- **Abandonment:** AI asked, then done manually anyway → workflow gap, not a prompt gap.
- **Re-research:** same doc/URL revisited N times → promote to a knowledge-base note.
- **Context-switching / fragmentation:** focus churn + meeting interleaving vs completion speed → time-blocking suggestions.
- **Meeting load / maker-time:** meeting density vs available focus blocks.
- **AI-first opportunities:** recurring multi-step Jira→branch→PR or MCP sequences → draft a tailored agent/command (see §7).

---

## 7. Output taxonomy

Two categories with different lifecycles.

### Shortcuts — tactical, fire-and-resolve

Concrete automations you accept or reject; once accepted, done and gone. The artifact enum is a **starting set, deliberately open** — the exploration tier can mint forms we didn't list:

- New AI skill / prompt scaffold / project custom-instruction
- Code snippet / template
- Git alias / worktree workflow
- Keyboard shortcut / VS Code keybinding
- **Codebase- and workflow-tailored agent or MCP workflow** (the AI-first payoff — e.g. an agent that runs your recurring Jira→branch→PR flow via the GitHub/Atlassian MCPs, tuned to your repo conventions and way-of-working)
- Time-management nudge (e.g. block 30 min for review instead of interleaving)

### Lessons — educational, stateful, longitudinal

Emitted from **themes**, not single candidates. They track whether you're improving over weeks.

**Progress representation (resolved):** each lesson is a tracked theme with a lifecycle status — `new → active → improving → resolved → dormant` — plus a trend over time. It appears in the weekly digest **only when it materially changes** (new, regressed, improved, or resolved) and is tracked silently otherwise (the anti-Clippy bit). Display is one line plus a tiny trend, e.g.:

> React `useEffect` feedback: 5 → 3 → 1 over 3 weeks ↓ *improving*

When evidence stays below a floor for a few weeks, the lesson flips to `resolved` with a one-time "you've got this now" close-out, then goes dormant. This is what produces the "I've noticed you're getting better at X" mentor quality rather than a nag that never stops. Each lesson has a stable ID so progress accrues across weeks.

### Knowledge-base outputs

Reading (docs/specs/HN) is captured, summarized, tagged, de-duplicated — and crucially **joined to work**: "you read X about Postgres indexes Tuesday, then spent 40 min on a slow query Friday." That consumption↔work link is the part no off-the-shelf tool does.

#### Schema (resolved)

`reading` events (from screenpipe: URL + OCR/extracted text) are deduplicated into durable **notes**. Notes and their links are part of the *indefinite-retention* tier (§11) — they're the product, not the raw capture.

```sql
CREATE TABLE kb_notes (
    note_id       TEXT PRIMARY KEY,       -- stable id (hash of canonical_url or content)
    canonical_url TEXT,                   -- normalized (strip tracking params/fragments)
    title         TEXT,
    summary       TEXT,                   -- LLM summary (local model)
    tags          TEXT,                   -- JSON array of topic tags
    embedding     BLOB,                   -- summary embedding, for topical joins
    first_seen    INTEGER NOT NULL,       -- epoch ms
    last_seen     INTEGER NOT NULL,
    visit_count   INTEGER NOT NULL,       -- ++ on each revisit (drives re-research detector)
    sensitivity   TEXT NOT NULL           -- mostly low; mixed if internal docs
);

CREATE TABLE kb_links (
    note_id    TEXT NOT NULL REFERENCES kb_notes(note_id),
    target_id  TEXT NOT NULL,             -- event_id, session id, or ticket key
    target_kind TEXT NOT NULL,            -- event | session | ticket
    relation   TEXT NOT NULL,             -- read_before | read_during | read_after | referenced
    score      REAL NOT NULL,             -- join confidence 0..1
    evidence   TEXT NOT NULL              -- JSON: window, similarity, reference site
);
```

A reading event is promoted to a note on first sight; revisits bump `last_seen`/`visit_count`. When `visit_count` crosses the re-research threshold (§6 seed catalog), the note is surfaced as a "promote to knowledge-base note" candidate.

#### The consumption↔work join (resolved)

Two independent join paths produce `kb_links`; both are cheap, deterministic candidate-finders, with the LLM only narrating the strongest links:

1. **Explicit reference (high precision).** A note's `canonical_url` (or its title/repo path) appears verbatim in a Copilot prompt, commit message, PR body, or Jira comment → `relation = referenced`, high score. This is the unambiguous link.
2. **Temporal + topical proximity (recall).** A reading event falls within a window of a work session (default ±1 work-week) **and** the note embedding is within a cosine threshold of the session's abstracted topic (or shares ≥1 tag) → `read_before`/`read_during`/`read_after` by ordering, scored by `similarity × time_decay`. This is what catches "read about Postgres indexes Tuesday → slow query Friday" with no explicit citation.

Links above a surfacing score feed the weekly digest's knowledge section and the interactive query ("what did I read before working on X?"). The session/ticket keying from §5 is what makes the work side of the join addressable.

---

## 8. Privacy & data flow

- **Local by default; remote tier configurable (revised 2026-06-15).** Collectors, detectors, theme aggregation, and the local characterizer still run on Ollama. What leaves the machine is now governed by a **redaction tier** the owner sets, not a hard "raw never leaves" rule — see *Redaction tiers* below. The original local-first choice was about *capability* ("throw the week at a model and find signal in the noise") as much as privacy; the tiers make that trade-off explicit and adjustable.
- **Sensitivity tiering.** Set at collection. Work-repo / Copilot / Jira events = `sensitive`; calendar + window metadata = `low–medium`; public reading = `low`.
- **Redaction pass (local, deterministic, tiered)** before anything is remote-eligible: strip code blocks, mask secret-ish patterns, and — *at `strict` only* — pseudonymize repo names / internal domains / paths / tickets. Secret masking and the secret-shape self-check run at **every** tier.
- **Routing rule.** Two things may go remote, both through the redaction gate at the active tier: (1) the **weekly synthesis input** — abstracted, locally-characterized insight objects + per-week aggregate stats; and (2) the **open-ended detector's activity log** — a redacted, numbered transcript of the week, handed to the remote model so it can surface patterns the deterministic catalog misses. At `strict` the powerful model sees only conclusions; at relaxed tiers it sees readable identifiers and (at `raw`) verbatim prompts/code — never secrets.
- **Remote endpoint = Copilot CLI (resolved).** Synthesis and open-ended detection run through GitHub Copilot CLI in non-interactive mode (already authorized on the work machine, latest Claude/GPT models). Staying inside the GitHub/Microsoft boundary the company already trusts is a better posture than a loose third-party API key. Every call is **metered** locally (`usage.ts`): sizes, purpose, and reported credits, surfaced in `stats` and the dashboard.
- **Visible + opt-in.** Remote calls log a "this is what would be sent" preview; the local digest renders with no remote call at all, so the remote synthesis is an upgrade, not a dependency.

Data flow (synthesis): `sensitive raw → local LLM → abstracted insight → redact(tier) → Copilot CLI synthesis`.
Data flow (open-ended detection): `sensitive raw → redact(tier) activity log → Copilot CLI → candidates → local characterize → digest`.

### Redaction tiers (resolved 2026-06-15)

The redaction level is an owner setting (`redaction.toml` `level = "..."`, or `--redact`), default **`identifiers`**:

| Tier | Code blocks | Secrets | Identifiers (repo/ticket/host/path) |
| --- | --- | --- | --- |
| `strict` | stripped | masked | pseudonymized (HMAC tokens) |
| `identifiers` *(default)* | stripped | masked | **kept readable** |
| `raw` | **kept verbatim** | masked | kept readable |

**Invariant across all tiers:** credential/secret masking is always on, and the fail-closed secret-shape self-check aborts the send if a key shape survives. Relaxing past `strict` is deliberate — the owner already shares this code with the same remote model day-to-day — but a leaked secret is never an insight at any tier. The denylist-literal self-check only applies at `strict`.

### Redaction rules (resolved)

The redactor is a deterministic, local, ordered pipeline that runs over the abstracted insight objects (never raw events) right before the one remote call. Order matters — coarse structural strips first, then secrets, then identifiers — so later passes see less:

1. **Strip code & verbatim blocks.** Remove fenced ```` ``` ```` blocks and inline `` `code` ``, replace with `[code: N lines]`. Insights should already be prose, but this is the backstop against a leaked snippet.
2. **Mask secrets (high-entropy / known shapes).** Regex for: `KEY=value` / `.env` lines, AWS keys (`AKIA[0-9A-Z]{16}`), GitHub/GHP tokens (`gh[pousr]_[A-Za-z0-9]{36,}`), bearer/JWT (`eyJ[A-Za-z0-9_-]+\.…`), PEM private-key headers, generic `[A-Za-z0-9_\-]{32,}` high-entropy tokens. Replace with `[secret]`.
3. **Pseudonymize identifiers via stable HMAC.** Repo names, internal hostnames/domains (from the denylist), absolute filesystem paths, Jira ticket keys, and email addresses are replaced with stable tokens: `HMAC-SHA256(local_salt, value)` truncated, formatted by type — `repo:7f3a`, `host:1c9e`, `ticket:a04b`, `path:…`, `user:…`. **Stable** so longitudinal grouping survives across weeks; **one-way** so the remote can't reverse them. The salt lives only on the machine.
4. **Drop residual paths & URLs not on an allowlist.** Internal/file URLs → pseudonym; public doc URLs (knowledge base) may pass since reading is `low` sensitivity.

**Denylist (`redaction.toml`, local, git-ignored).** A small hand-maintained config, not a classifier:

```toml
company_domains = ["example-corp.com", "internal.example-corp.com"]
repo_orgs       = ["example-corp", "example-corp-labs"]
repo_names      = ["checkout-service", "pricing-engine"]   # extra repos to force-pseudonymize
internal_hosts  = ["jira.example-corp.com", "git.example-corp.com"]
people          = []                                        # optional extra names to mask
```

Anything matching the denylist is force-pseudonymized even if a generic rule misses it. Stakes are moderate (e-commerce, little critical secret material) but the bar is "nothing identifying or proprietary leaves," and the denylist is the safety net over the generic regex.

**Verification.** Two guards before send: (a) a **self-check** that asserts no denylist literal and no obvious secret shape survives the pipeline (fail closed — abort the send if it does); (b) the visible **"this is what would be sent" preview** (the opt-in preview noted above), logged. The redaction step's exact rule set is itself part of what gets reviewed in the preview.

### Characterizer escalation policy (resolved: no)

**The characterizer never auto-escalates per-candidate context to a remote model.** It runs entirely on the local model (Ollama) with read-only tools. If a candidate stays below the confidence bar after local characterization, it is **held/tracked silently** (per the §6 gates), not sent remote for a "second opinion." This is distinct from the two *deliberate, owner-configured* remote stages (weekly synthesis and the opt-in `--explore` open-ended detector): those are explicit, tier-gated, and metered — not silent per-candidate escalation. What goes remote in those stages is governed by the active redaction tier (above), with secret masking enforced at every tier.

---

## 9. Cadence & delivery

- **Daily recap:** lightweight, from time/ticket/meeting data; no LLM required.
- **Weekly digest:** the core report — top 3–5 ranked insights (each with why + next action + drafted artifact), a dedicated AI-usage read (where AI helped / cost time, one habit to change), and one experiment to try. Generated via Copilot CLI, e.g.:
  ```
  cat week_insights.redacted.json | copilot -p "<synthesis prompt>" -s --model claude-sonnet-4.6
  ```
- **Interactive query:** on demand, any time.
- **Nagging / proactive surfacing:** deferred. Keep it pull-based + digest for now.
- **Scheduling (Mac):** `launchd` agents — collectors continuous; detectors + characterizer nightly (local, free); digest weekly (one Copilot CLI call).
- **Cost note:** each Copilot CLI prompt consumes one Premium Request from the monthly quota. The weekly digest is ~4 calls/month (trivial); keep the nightly per-candidate characterizer on local Ollama so quota isn't a factor.

---

## 10. AI-usage analysis (priority focus)

Because this is the highest-actionability area and the strategic direction is AI-first:

**Capture:** Copilot prompts/responses, follow-up counts, accepted vs rejected suggestions, token estimates (heuristic to start — see §4), task types, and MCP-driven workflows (GitHub/Atlassian).

**Surface:**
- Where AI saves vs costs time (one-shot vs multi-shot by task type).
- Recurring prompts → saved scaffolds / project custom-instructions.
- **Codebase- and ways-of-working-tailored agents** — the marquee output as dev goes AI-first.
- Prompting habits worth changing (lessons).
- Where AI is being avoided or abandoned → workflow gaps.

---

## 11. Implementation notes (sketch)

- **Language/runtime:** TypeScript on **Bun** (owner's home stack; runs TS directly, no build step). The capture layer has zero runtime deps — `bun:sqlite` + `node:fs`.
- **Stack to reuse:** screenpipe (reading/knowledge capture) · ActivityWatch (window/focus) · CodeHist / WayLog (Copilot session parsing — cross-reference; we parse `state.vscdb`+`chatSessions` directly) · ai-engineering-fluency (token usage, if/when needed) · GitHub + Atlassian MCPs (already in use).
- **Store:** local SQLite (`bun:sqlite`).
- **Local LLM:** Ollama (collectors, detectors, characterizer, interactive query).
- **Remote synthesis:** Copilot CLI, non-interactive, `--model claude-sonnet-4.6` (default; revisit), redacted input only, weekly.
- **Platform:** macOS, `launchd`.
- **User stack to integrate:** Mac · VS Code (+ Copilot) · Jira · GitHub · Figma · MS Teams.
- **Figma:** lower priority initially; useful as a "design context" reading/work signal for frontend tasks — revisit.

### Retention (resolved)

| Data | Retention |
|---|---|
| Raw screenpipe capture (OCR/screen — the only disk hog) | 21-day rolling purge |
| Normalized events | 12 months |
| Derived insights / themes / feedback / knowledge-base notes | Indefinite (small; the actual product) |

Cap screenpipe's disk usage in its own settings as a backstop.

### Suggested phasing

1. **Capture + store:** collectors → normalized event store (start with Copilot + GitHub + ActivityWatch + calendar). — *built: Copilot chat + local git collectors → `bun:sqlite` store; sessionizer.*
2. **Deterministic detectors + daily/weekly digest:** prove the insight format is useful. — *built: no-LLM detectors, daily recap, a local dashboard, and the weekly remote digest (Copilot CLI, behind the redaction gate).*
3. **Characterizer harness + interactive query:** the one-agent-two-modes layer. — *built: characterizer (local Ollama; candidate → insight + drafted artifact, deterministic fallback) and interactive `ask` (retrieval-augmented Q&A). A full tool-using agent loop is the richer future version.*
4. **Themes + lessons:** longitudinal tracking. — *pending.*
5. **Exploration tier:** self-grown detectors + anti-Clippy gates. — *pending (embedding/cosine novelty helper in place via `llm.ts`).*

Built so far: `capture → sessionize → detect → characterize → recap → dashboard`, plus interactive `ask` and the weekly `digest`. Everything through characterization is local (Ollama). The one *remote* piece — the weekly synthesis — is implemented (`src/redact.ts` + `src/synthesis.ts`, the `digest` command) and verified end-to-end through GitHub Copilot CLI in non-interactive mode: the week's local insights are redacted (fail-closed self-check), previewed, and on `--send` synthesized remotely. The remote model runs on `auto` (no premium model required) and sees only pseudonymized conclusions.

---

## 12. Resolved decisions & remaining items

### Resolved (v0.3)

- **Codename:** Postcaptain (matches the repo/package name).
- **Redaction rules + denylist:** ordered local pipeline (strip code → mask secrets → HMAC-pseudonymize identifiers → drop residual paths), a hand-maintained `redaction.toml` denylist, and a fail-closed self-check plus visible preview (see §8).
- **Characterizer escalation:** no autonomous remote escalation; hard/low-confidence candidates are held and tracked locally. Only the weekly synthesis goes remote, over redacted abstractions (see §5/§8).
- **Knowledge-base schema + consumption↔work join:** `kb_notes` / `kb_links` tables; two join paths (explicit reference, and temporal+topical proximity), scored and surfaced above a threshold (see §7).
- **Confidence calibration:** a feedback-driven procedure (capture accept/dismiss/useful/improved signals → reliability buckets → isotonic/Platt recalibration once enough labels exist), per-category, revisited monthly then quarterly (see §6).
- **Copilot on-disk format:** verified against live data — `state.vscdb` index as manifest + `chatSessions/*.json` content; one `ai_interaction` event per request (see §4). Implemented in the Phase 1 spike.
- **Event-store DDL:** concrete `events` schema with deterministic idempotent ids (see §5).

### Resolved (v0.2)

- **Work session:** gap threshold ~25–30 min inactivity or project switch; keyed on Jira ticket, falling back to repo/workspace.
- **Ticket linkage:** `[A-Z][A-Z0-9]+-\d+` from branch names (convention: `ABC-123-...`), commits/PR titles as fallback. Doubles as the project key.
- **Token estimation:** heuristic (chars ÷ 4) to start; relative accuracy is enough. Upgrade path via ai-engineering-fluency or debug log.
- **Remote synthesis model:** Copilot CLI, non-interactive. Implemented default is `auto` (Copilot picks an available model — no premium quota required); override with `--remote-model`. Redaction gate applies regardless.
- **Storage/retention:** 21 days raw / 12 months events / indefinite insights (see §11).
- **Gate thresholds:** confidence ≥ 0.6, novelty cosine distance ≥ 0.15–0.2, start conservative, log suppressed insights, tune on feedback.
- **Lesson progress display:** status lifecycle + trend line, surfaced only on material change, with a one-time resolved close-out (see §7).

### Deferred (by design, or until data / later phases)

These are intentionally open — not gaps in the design, but things that either depend on real data or belong to later phases:

- **Calibrated threshold numbers.** The 0.6 confidence bar and 0.15–0.2 novelty distance are starting dials; the *procedure* to tune them is resolved (§6), the *values* await a few weeks of feedback.
- **Figma integration.** Lower priority; useful later as a "design context" reading signal for frontend tasks (§11).
- **Real-time/proactive surfacing ("nagging").** Deferred non-goal (§3/§9); revisit only after the digest format proves useful.
- **Redaction denylist contents** are environment-specific and maintained in `redaction.toml`, not in this doc.
