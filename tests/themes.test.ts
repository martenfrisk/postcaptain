import { expect, test } from "bun:test";
import type { Candidate } from "../src/detectors.ts";
import {
  candidateMetric,
  isMaterialChange,
  type LessonStatus,
  lifecycle,
  type Theme,
  type ThemeObservation,
  ThemeStore,
  trackWeek,
  trendLine,
  weekKey,
} from "../src/themes.ts";

function obs(metrics: number[]): ThemeObservation[] {
  // synthetic chronological weeks: 2026-01-05, -12, -19, ...
  return metrics.map((metric, i) => ({
    week: weekKey(Date.UTC(2026, 0, 5) + i * 7 * 86_400_000),
    metric,
    evidenceCount: metric,
  }));
}

function lesson(over: Partial<Candidate> = {}): Candidate {
  return {
    detector: "followup-habit",
    signature: "followup-habit",
    headline: "h",
    whatHappened: "w",
    suggestion: "s",
    category: "lesson",
    artifactType: "none",
    evidence: ["e1", "e2"],
    confidence: 0.7,
    ...over,
  };
}

// --- pure lifecycle ----------------------------------------------------------

test("weekKey normalizes any day to its Monday-UTC week start", () => {
  // 2026-06-17 is a Wednesday → week starts Monday 2026-06-15
  expect(weekKey(Date.UTC(2026, 5, 17))).toBe("2026-06-15");
  expect(weekKey(Date.UTC(2026, 5, 15))).toBe("2026-06-15");
  expect(weekKey(Date.UTC(2026, 5, 21))).toBe("2026-06-15"); // Sunday, same week
});

test("a single observation is `new`", () => {
  expect(lifecycle(obs([5]))).toBe("new");
});

test("a falling metric is `improving`", () => {
  expect(lifecycle(obs([5, 3]))).toBe("improving");
  expect(lifecycle(obs([5, 3, 2]))).toBe("improving");
});

test("a steady/worsening metric with no prior gain is `active`, not regressed", () => {
  expect(lifecycle(obs([3, 3]))).toBe("active");
  expect(lifecycle(obs([2, 3, 4]))).toBe("active"); // monotonic worsening, never improved
});

test("worsening after a prior improvement is `regressed`", () => {
  expect(lifecycle(obs([5, 2, 4]))).toBe("regressed");
});

test("two consecutive weeks at/below the floor `resolve`, then go `dormant`", () => {
  expect(lifecycle(obs([5, 3, 1, 1]))).toBe("resolved"); // belowRun hits resolvedWeeks
  expect(lifecycle(obs([5, 3, 1, 1, 0]))).toBe("dormant"); // stays clear → dormant
});

test("the resolve floor and window are tunable", () => {
  expect(lifecycle(obs([5, 2, 2]), { floor: 2 })).toBe("resolved");
  expect(lifecycle(obs([5, 1, 1]), { resolvedWeeks: 3 })).toBe("active"); // at floor but not long enough to resolve
});

test("isMaterialChange surfaces new/improving/regressed/resolved, hides active/dormant", () => {
  const surfaced: LessonStatus[] = ["new", "improving", "regressed", "resolved"];
  const hidden: LessonStatus[] = ["active", "dormant"];
  for (const s of surfaced) expect(isMaterialChange(s)).toBe(true);
  for (const s of hidden) expect(isMaterialChange(s)).toBe(false);
});

test("candidateMetric uses the detector metric, falling back to evidence volume", () => {
  expect(candidateMetric(lesson({ metric: 7 }))).toBe(7);
  expect(candidateMetric(lesson({ metric: undefined, evidence: ["a", "b", "c"] }))).toBe(3);
});

test("trendLine renders the recent series with a status arrow", () => {
  const theme: Theme = {
    themeId: "x",
    signature: "followup-habit",
    category: "lesson",
    headline: "h",
    suggestion: "s",
    status: "improving",
    firstWeek: "2026-01-05",
    lastWeek: "2026-01-19",
    observations: obs([5, 3, 1]),
  };
  expect(trendLine(theme)).toBe("5 → 3 → 1 ↓ improving");
});

// --- persistence -------------------------------------------------------------

test("ThemeStore round-trips and recomputes lifecycle on each record", () => {
  const store = new ThemeStore(":memory:");
  const sig = "followup-habit";
  store.record({
    signature: sig,
    category: "lesson",
    headline: "h",
    suggestion: "s",
    week: "2026-01-05",
    metric: 5,
    evidenceCount: 5,
  });
  const t = store.record({
    signature: sig,
    category: "lesson",
    headline: "h2",
    suggestion: "s2",
    week: "2026-01-12",
    metric: 3,
    evidenceCount: 3,
  });
  expect(t.status).toBe("improving");
  expect(t.headline).toBe("h2"); // latest characterization wins
  expect(t.observations.map((o) => o.metric)).toEqual([5, 3]);
  expect(store.all().length).toBe(1);
  store.close();
});

test("re-recording the same (theme, week) is idempotent — no double counting", () => {
  const store = new ThemeStore(":memory:");
  const base = {
    signature: "x",
    category: "lesson" as const,
    headline: "h",
    suggestion: "s",
    week: "2026-01-05",
    evidenceCount: 2,
  };
  store.record({ ...base, metric: 5 });
  const t = store.record({ ...base, metric: 4 }); // same week again, updated reading
  expect(t.observations.length).toBe(1);
  expect(t.observations[0]!.metric).toBe(4);
  store.close();
});

test("trackWeek zero-fills a lesson that stops firing, driving resolve→dormant", () => {
  const store = new ThemeStore(":memory:");
  const w1 = "2026-01-05";
  const w2 = "2026-01-12";
  const w3 = "2026-01-19";

  // Week 1: the lesson fires.
  trackWeek(store, [lesson({ metric: 4 })], w1);
  expect(store.all()[0]!.status).toBe("new");

  // Week 2: it does NOT fire → zero-filled. 4 → 0 reads as improving.
  let touched = trackWeek(store, [], w2);
  expect(touched.length).toBe(1);
  expect(touched[0]!.status).toBe("improving");

  // Week 3: still gone → second clear week → resolved (one-time close-out).
  touched = trackWeek(store, [], w3);
  expect(touched[0]!.status).toBe("resolved");

  // Week 4: resolved lessons get one more zero, flipping to dormant (silent).
  const w4 = "2026-01-26";
  touched = trackWeek(store, [], w4);
  expect(touched[0]!.status).toBe("dormant");

  // Week 5: dormant lessons are left alone — no further zero-fill.
  const w5 = "2026-02-02";
  expect(trackWeek(store, [], w5).length).toBe(0);
  store.close();
});

test("trackWeek ignores shortcut candidates — only lessons are tracked", () => {
  const store = new ThemeStore(":memory:");
  const shortcut = lesson({ category: "shortcut", signature: "repetition:x" });
  expect(trackWeek(store, [shortcut], "2026-01-05")).toEqual([]);
  expect(store.all().length).toBe(0);
  store.close();
});
