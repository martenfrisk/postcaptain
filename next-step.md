⏺ KB foundation shipped — committed 120cdf5 (not pushed). Review at the gate:

What landed

- src/kb.ts — canonicalUrl (dedup-friendly URL normalization), buildNotes (a pure, idempotent projection of reading events — visit_count
  recomputed, never incremented), and KbStore over the §7 kb_notes/kb_links tables. Re-promotion preserves any future summary/embedding.
- reResearchDetector — page revisited ≥3× across ≥2 days → a "save a note" candidate.
- Capture auto-promotes reading → notes; dashboard gets a Knowledge-base panel (most-revisited). 117 tests pass, integration-checked
  end-to-end.

Critical self-review (honest caveats)

1. The differentiator isn't done yet. This is the foundation. The design's genuinely-unique bit — the consumption↔work join ("you read X
   about Postgres indexes, then hit a slow query Friday") via kb_links — is created as a table but not populated. Notes + re-research are
   useful, but the join is where the value concentrates; that's the explicit next sub-step.
2. No live reading data here (no aw-watcher-web installed) — verified against fixtures + a synthetic integration run, not real browsing.
   Same "validate on the real machine" caveat as ActivityWatch.
3. Sensitivity is conservative — the AW collector marks all web reading medium, so notes inherit medium and their URLs get pseudonymized
   at the strict tier. Safe, but a public-domain allowlist could relax well-known doc sites to low later.

Roadmap status

Phase 4 ✅ · Calendar ✅ · ActivityWatch ✅ · KB foundation ✅ — all committed this session. Remaining:

- D, final sub-step: local summaries/embeddings on notes + the kb_links consumption↔work join (the differentiator) + reading-vs-doing in
  the digest.
- E (phase 5): self-growing detectors + novelty gate.

The natural next step is the consumption↔work join — it's where the KB earns its keep, and it'll exercise the embedding helper already in
llm.ts for the topical-proximity part. Want me to continue into that, or pause here? (It's a meatier piece and leans on Ollama for
embeddings, so it's a reasonable spot to check in before I dive in.)
