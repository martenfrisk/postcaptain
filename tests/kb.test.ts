import { expect, test } from "bun:test";
import { type Event, makeEvent, type Sensitivity } from "../src/events.ts";
import { buildNotes, canonicalUrl, KbStore, noteId } from "../src/kb.ts";

let seq = 0;
function reading(url: string, ts: number, title = "", sensitivity: Sensitivity = "low"): Event {
  return makeEvent({
    eventId: `r${seq++}`,
    kind: "reading",
    source: "activitywatch",
    ts,
    sensitivity,
    payload: { url, title, durationSec: 60 },
  });
}

const DAY = 86_400_000;

test("canonicalUrl drops fragments, tracking params, and trailing slash; lowercases host", () => {
  expect(canonicalUrl("HTTPS://Example.com/Docs/?utm_source=x&q=1#frag")).toBe(
    "https://example.com/Docs?q=1",
  );
  expect(canonicalUrl("https://example.com/page/")).toBe("https://example.com/page");
  // a non-URL string falls back to its trimmed self
  expect(canonicalUrl("  not a url  ")).toBe("not a url");
});

test("canonicalUrl collapses tracking-only variants to the same key", () => {
  const a = canonicalUrl("https://site.dev/post?utm_campaign=a&fbclid=z");
  const b = canonicalUrl("https://site.dev/post");
  expect(a).toBe(b);
});

test("buildNotes dedups by canonical URL with recomputed visit count and span", () => {
  const events = [
    reading("https://docs.dev/x?utm_source=hn", 0, "X Guide"),
    reading("https://docs.dev/x", DAY, "X Guide (updated)"),
    reading("https://docs.dev/x#section", 2 * DAY, ""),
    reading("https://other.dev/y", DAY, "Y"),
    reading("", DAY, "no url ignored"),
  ];
  const notes = buildNotes(events);
  expect(notes.length).toBe(2);
  const x = notes.find((n) => n.canonicalUrl === "https://docs.dev/x")!;
  expect(x.visitCount).toBe(3);
  expect(x.firstSeen).toBe(0);
  expect(x.lastSeen).toBe(2 * DAY);
  expect(x.title).toBe("X Guide (updated)"); // most-recent non-empty title
  expect(x.noteId).toBe(noteId("https://docs.dev/x"));
});

test("buildNotes takes the max sensitivity across a URL's reads", () => {
  const [note] = buildNotes([
    reading("https://internal.corp/wiki", 0, "wiki", "low"),
    reading("https://internal.corp/wiki", DAY, "wiki", "medium"),
  ]);
  expect(note!.sensitivity).toBe("medium");
});

test("KbStore promote is idempotent — re-running does not inflate visit_count", () => {
  const store = new KbStore(":memory:");
  const events = [reading("https://docs.dev/x", 0, "X"), reading("https://docs.dev/x", DAY, "X")];
  store.promote(events);
  store.promote(events); // capture re-run
  const notes = store.all();
  expect(notes.length).toBe(1);
  expect(notes[0]!.visitCount).toBe(2); // not 4
  store.close();
});

test("KbStore.all orders by visit count, and round-trips fields", () => {
  const store = new KbStore(":memory:");
  store.promote([
    reading("https://a.dev", 0, "A"),
    reading("https://b.dev", 0, "B"),
    reading("https://b.dev", DAY, "B"),
    reading("https://b.dev", 2 * DAY, "B"),
  ]);
  const notes = store.all();
  expect(notes[0]!.canonicalUrl).toBe("https://b.dev"); // most revisited first
  expect(notes[0]!.visitCount).toBe(3);
  expect(notes[0]!.tags).toEqual([]);
  expect(notes[0]!.summary).toBeNull();
  store.close();
});
