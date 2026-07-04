# Changelog

## 4.2.0 — 2026-07-04

### Real token counts (ground truth)
- **New `src/transcript-usage.js`**: the budget hook now reads exact API token
  usage from the Claude Code session transcript (`transcript_path` on every
  hook event) instead of relying only on the chars-per-token heuristic. Budget
  % and the `/cco` board show real context usage when available; estimation
  remains the fallback. Real numbers print without the `~` prefix.

### Fixed
- `/cco-digest` printed `$NaN` for every row of the cost table (multiplied
  tokens by the `MODEL_COSTS` object instead of a rate) — same class as the
  earlier roi/report fixes. Also deduped alias rows and fixed column alignment.
- `/cco-export` (HTML) and `/cco-claudemd` overstated costs **3×** — they still
  hardcoded the legacy `$15/M` Opus price instead of `MODEL_COSTS` ($5/M).
- `benchmark/run.js` passed file *contents* where `parseFileStructure()` expects
  a *path*, so every digest-based scenario measured an empty structure —
  published savings were fabricated. Fixed and `results.json` regenerated
  (honest total: 63%).
- `/cco-roi` printed `Infinityx` at 100% waste (division by zero) — clamped.
- Race between tracker and budget hooks: both ran in parallel on the same
  PostToolUse matcher and did read-modify-write on the shared notice ledger,
  breaking the noise cap and undercounting overhead in NET savings. The hooks
  are now serialized in a single command (same for SessionEnd tracker →
  dashboard).
- Concurrent session finalization clobbered `global-stats.json` /
  `patterns.json` (last-writer-wins) — now serialized with an atomic
  mkdir-based file lock (stale locks stolen after 5s).
- prompt-coach rewrote its whole prompt log on every prompt (O(n²), crash
  could truncate history) — now a true `appendFileSync`.
- Legacy read-cache entries without `ranges`/`lines` threw and silently
  disabled caching for that file — fields are now defaulted.
- Session summaries showed UTC as if it were wall-clock time — now local.

### Performance
- `getFileLines()` no longer slurps multi-MB files on the hook hot path just to
  count lines (>1MB files are estimated from size).
- Read token estimates are capped by the file's real size and use the
  extension-aware ratio (a 475-line file now counts ~4.9K tokens, not 18.9K).
- Unbounded per-session state capped: budget `filesLoaded` (500, coldest
  evicted), tracker search log (last 300; totals unaffected).

### Honesty
- The "Session pulse" line now goes through the notice ledger: it respects the
  per-session noise cap and its tokens count as overhead in NET savings.

### Docs & packaging
- README: added missing `/cco-roi`, `cco-replay`, and four `src/` files to the
  docs; fixed stale `v4.0.0` strings here and in `docs/index.html`.
- `sync-version.js` now also syncs `marketplace.json` and the `docs/index.html`
  footer, so version drift can't recur.
- Removed the junk `CHANGELOG-notes.md` and the empty `hooks/scripts/` dir.
- Note: hook commands use POSIX shell syntax (`payload=$(cat)`); on Windows
  they require Git Bash / WSL.

### Tests
- 139 → 150: regressions for the `$NaN` class, size-aware Read estimates,
  large-file line estimation, transcript usage parsing, file-lock exclusivity
  and stale-steal, tracker search-cap and tool counting.

## 4.1.0

- Silent-by-default hooks: advisory output gated by a per-session notice
  ledger (cap 4), only actionable messages reach context.
- Honest NET savings: `/cco` reports cache savings minus the optimizer's own
  injected tokens; re-reads credited by real file size.
- Big-file map-then-load: first full read of a >1500-line file returns its
  structural map once; read again to load fully (`bigFileDigest` config).

## 4.0.0

- Opus 4.8 aware: default model `opus-4.8`, corrected pricing ($5/$25, full 1M
  context at standard price — the fictional "1M surcharge" removed).
- Context Control Center (`/cco`): budget, $ spent, savings, waste, prompt
  grade, active task, and ready-to-run actions on one screen.
- Per-task tracking (`/cco-task`), session-end auto-report, `/cco-doctor`.

Earlier history: see git log.
