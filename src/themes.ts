/**
 * Themes & lessons — the longitudinal layer (design §7, phase 4).
 *
 * Everything upstream of here is stateless: pure functions over the events of a
 * single window. A *lesson* is different — it's a tracked habit whose value is
 * the trend across weeks ("React useEffect feedback: 5 → 3 → 1 ↓ improving").
 * That requires state that survives between runs, so this module is the first to
 * persist derived data (the `themes` / `theme_observations` tables, part of the
 * indefinite-retention tier, §11).
 *
 * Split, mirroring the rest of the pipeline: the aggregation + lifecycle logic
 * is pure and unit-testable; `ThemeStore` is a thin, idempotent SQLite wrapper
 * (re-running a week upserts that week's observation, never double-counts).
 *
 * Anti-Clippy (§7): a lesson surfaces in the digest ONLY when it materially
 * changes (new, improving, regressed, resolved). Steady or dormant lessons are
 * tracked silently. `resolved` fires once, then the lesson goes `dormant`.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Candidate, Category } from "./detectors.ts";
import { weekRange } from "./synthesis.ts";

/** Lesson lifecycle (§7). Lower metric = better, so a fall is "improving". */
export type LessonStatus = "new" | "active" | "improving" | "regressed" | "resolved" | "dormant";

/** One week's reading of a tracked theme. */
export interface ThemeObservation {
  /** ISO week-start (Monday, UTC) — `YYYY-MM-DD`. */
  week: string;
  /** The tracked quantity (e.g. # of multi-follow-up sessions). Lower = better. */
  metric: number;
  /** How many events backed the reading that week. */
  evidenceCount: number;
}

/** A tracked lesson with its full observation history and current lifecycle. */
export interface Theme {
  themeId: string;
  signature: string;
  category: Category;
  headline: string;
  suggestion: string;
  status: LessonStatus;
  firstWeek: string;
  lastWeek: string;
  /** Chronological (oldest first). */
  observations: ThemeObservation[];
}

/** Tunables for the lifecycle classifier (dials, not truths — §6). */
export interface LifecycleOpts {
  /** A week whose metric is ≤ this counts as effectively clear. */
  floor?: number;
  /** Consecutive weeks at/below `floor` before a lesson resolves. */
  resolvedWeeks?: number;
}

/** The Monday-UTC week key (`YYYY-MM-DD`) containing `ts`. */
export function weekKey(ts: number): string {
  return weekRange(new Date(ts)).label.slice(0, 10);
}

/** A stable, opaque id for a theme signature. */
export function themeId(signature: string): string {
  return createHash("sha256").update(signature).digest("hex").slice(0, 12);
}

/** The lesson-category candidates — only these become tracked themes (§7). */
export function lessonCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => c.category === "lesson");
}

/** The number a lesson tracks over time: the detector's metric, else evidence volume. */
export function candidateMetric(c: Candidate): number {
  return typeof c.metric === "number" ? c.metric : c.evidence.length;
}

/**
 * Classify a lesson from its metric history (§7). Pure: same observations →
 * same status. `floor`/`resolvedWeeks` are the only dials.
 */
export function lifecycle(
  observations: ThemeObservation[],
  opts: LifecycleOpts = {},
): LessonStatus {
  const floor = opts.floor ?? 1;
  const resolvedWeeks = opts.resolvedWeeks ?? 2;
  const m = observations.map((o) => o.metric);
  const n = m.length;
  if (n <= 1) return "new";

  // Sustained clearance takes precedence: a trailing run at/below the floor.
  let belowRun = 0;
  for (let i = n - 1; i >= 0; i--) {
    const v = m[i];
    if (v === undefined || v > floor) break;
    belowRun++;
  }
  if (belowRun >= resolvedWeeks) {
    // `resolved` is the one-time close-out the week it first qualifies; dormant after.
    return belowRun === resolvedWeeks ? "resolved" : "dormant";
  }

  const last = m[n - 1] ?? 0;
  const prev = m[n - 2] ?? 0;
  if (last < prev) return "improving";
  if (last > prev) {
    // "regressed" only if we'd previously been getting better — otherwise it's a
    // steady/worsening problem, which reads as "active", not a relapse.
    let priorImprovement = false;
    let previous = m[0] ?? 0;
    for (let i = 1; i < n - 1; i++) {
      const v = m[i] ?? 0;
      if (v < previous) priorImprovement = true;
      previous = v;
    }
    return priorImprovement ? "regressed" : "active";
  }
  return "active";
}

/** Whether a lesson in this status belongs in the digest (§7 anti-Clippy). */
export function isMaterialChange(status: LessonStatus): boolean {
  return (
    status === "new" || status === "improving" || status === "regressed" || status === "resolved"
  );
}

/** A compact trend line, e.g. `5 → 3 → 1 ↓ improving` (§7). */
export function trendLine(theme: Theme, maxPoints = 5): string {
  const pts = theme.observations.slice(-maxPoints).map((o) => fmtMetric(o.metric));
  const arrow = trendArrow(theme.status);
  return `${pts.join(" → ")} ${arrow} ${theme.status}`;
}

function trendArrow(status: LessonStatus): string {
  if (status === "improving") return "↓";
  if (status === "regressed") return "↑";
  if (status === "resolved") return "✓";
  return "→";
}

function fmtMetric(m: number): string {
  return Number.isInteger(m) ? String(m) : m.toFixed(2);
}

// --- persistence -------------------------------------------------------------

const THEME_SCHEMA = `
CREATE TABLE IF NOT EXISTS themes (
    theme_id    TEXT PRIMARY KEY,
    signature   TEXT NOT NULL,
    category    TEXT NOT NULL,
    headline    TEXT NOT NULL,        -- latest characterization
    suggestion  TEXT NOT NULL,
    status      TEXT NOT NULL,        -- derived lifecycle (cached for display)
    first_week  TEXT NOT NULL,
    last_week   TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS theme_observations (
    theme_id       TEXT NOT NULL,
    week           TEXT NOT NULL,     -- Monday-UTC YYYY-MM-DD
    metric         REAL NOT NULL,
    evidence_count INTEGER NOT NULL,
    observed_at    INTEGER NOT NULL,
    PRIMARY KEY (theme_id, week)
);
`;

interface ThemeRow {
  theme_id: string;
  signature: string;
  category: string;
  headline: string;
  suggestion: string;
  status: string;
  first_week: string;
  last_week: string;
  updated_at: number;
}

interface ObservationRow {
  week: string;
  metric: number;
  evidence_count: number;
}

/** What a single week's run contributes for one lesson. */
export interface ThemeInput {
  signature: string;
  category: Category;
  headline: string;
  suggestion: string;
  week: string;
  metric: number;
  evidenceCount: number;
}

/**
 * Idempotent SQLite wrapper for the longitudinal theme state. Lives in the same
 * db file as events; re-recording a `(theme, week)` replaces that week's
 * observation, so a week can be re-run without inflating the trend.
 */
export class ThemeStore {
  readonly path: string;
  private db: Database;
  private opts: LifecycleOpts;

  constructor(path: string, opts: LifecycleOpts = {}) {
    this.path = path;
    this.opts = opts;
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(THEME_SCHEMA);
  }

  /**
   * Record one week's reading of a lesson, then recompute and persist its
   * lifecycle from the full history. Returns the updated theme.
   */
  record(input: ThemeInput): Theme {
    const id = themeId(input.signature);
    const now = Date.now();
    this.db
      .query(
        `INSERT OR REPLACE INTO theme_observations
           (theme_id, week, metric, evidence_count, observed_at)
         VALUES ($id, $week, $metric, $count, $now)`,
      )
      .run({
        $id: id,
        $week: input.week,
        $metric: input.metric,
        $count: input.evidenceCount,
        $now: now,
      });

    const observations = this.observations(id);
    const status = lifecycle(observations, this.opts);
    const firstWeek = observations[0]?.week ?? input.week;
    const lastWeek = observations[observations.length - 1]?.week ?? input.week;

    this.db
      .query(
        `INSERT INTO themes
           (theme_id, signature, category, headline, suggestion, status, first_week, last_week, updated_at)
         VALUES ($id, $sig, $cat, $head, $sug, $status, $first, $last, $now)
         ON CONFLICT(theme_id) DO UPDATE SET
           headline = $head, suggestion = $sug, status = $status,
           first_week = $first, last_week = $last, updated_at = $now`,
      )
      .run({
        $id: id,
        $sig: input.signature,
        $cat: input.category,
        $head: input.headline,
        $sug: input.suggestion,
        $status: status,
        $first: firstWeek,
        $last: lastWeek,
        $now: now,
      });

    return {
      themeId: id,
      signature: input.signature,
      category: input.category as Category,
      headline: input.headline,
      suggestion: input.suggestion,
      status,
      firstWeek,
      lastWeek,
      observations,
    };
  }

  /** A theme's observations, oldest week first. */
  observations(id: string): ThemeObservation[] {
    const rows = this.db
      .query(
        `SELECT week, metric, evidence_count FROM theme_observations
         WHERE theme_id = ? ORDER BY week ASC`,
      )
      .all(id) as ObservationRow[];
    return rows.map((r) => ({ week: r.week, metric: r.metric, evidenceCount: r.evidence_count }));
  }

  /** Every tracked theme, most recently updated first. */
  all(): Theme[] {
    const rows = this.db.query("SELECT * FROM themes ORDER BY updated_at DESC").all() as ThemeRow[];
    return rows.map((r) => ({
      themeId: r.theme_id,
      signature: r.signature,
      category: r.category as Category,
      headline: r.headline,
      suggestion: r.suggestion,
      status: r.status as LessonStatus,
      firstWeek: r.first_week,
      lastWeek: r.last_week,
      observations: this.observations(r.theme_id),
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Record this week's fired lessons. `week` is the Monday-UTC key the candidates
 * belong to. Pure plumbing over `ThemeStore.record`.
 */
export function trackLessons(store: ThemeStore, candidates: Candidate[], week: string): Theme[] {
  const themes: Theme[] = [];
  for (const c of lessonCandidates(candidates)) {
    themes.push(
      store.record({
        signature: c.signature,
        category: c.category,
        headline: c.headline,
        suggestion: c.suggestion,
        week,
        metric: candidateMetric(c),
        evidenceCount: c.evidence.length,
      }),
    );
  }
  return themes;
}

/**
 * Fold a whole week into the store: record this week's fired lessons, AND record
 * a zero reading for previously-tracked lessons that did NOT fire this week. The
 * zero-fill is what gives the resolve→dormant lifecycle teeth — a habit that
 * goes away should trend to zero and close out, not freeze at its last value
 * (§7). Dormant lessons are left alone (already closed). Returns every theme
 * touched this week, in fired-then-faded order.
 */
export function trackWeek(store: ThemeStore, candidates: Candidate[], week: string): Theme[] {
  const firedSigs = new Set(lessonCandidates(candidates).map((c) => c.signature));
  const touched = trackLessons(store, candidates, week);
  for (const t of store.all()) {
    if (t.category !== "lesson" || t.status === "dormant") continue;
    if (firedSigs.has(t.signature) || t.lastWeek >= week) continue;
    touched.push(
      store.record({
        signature: t.signature,
        category: "lesson",
        headline: t.headline,
        suggestion: t.suggestion,
        week,
        metric: 0,
        evidenceCount: 0,
      }),
    );
  }
  return touched;
}
