# Changelog

## 4.7.0 — 2026-08-05

### Windows: the path handling was wrong everywhere it mattered
CCO assumed POSIX. On Windows that silently degraded four separate features —
none of them loudly enough to look broken.

- **`/cco-overhead` finds transcripts again** (#46). `projectTranscriptDir()`
  munged only `/` and `.`, so a Windows cwd kept its `\`, `:` and spaces and
  produced a malformed lookup path
  (`~\.claude\projects\C:\Program Files\Git`). Claude Code names that folder
  `C--Program-Files-Git`; the encoding now matches. This also un-breaks the
  CLAUDE.md / MEMORY.md itemization, which had been lumping everything into
  the "system prompt & tools (unattributed)" line.
- **`.contextignore` matches CRLF files** (#33). Patterns were parsed with
  `split('\n')`, leaving a trailing `\r` on every line of a Windows-authored
  file — so *no pattern ever matched* and the whole ignore list was inert.
  Now `split(/\r?\n/)`.
- **Glob matching understands backslashes** (#33). Paths are normalized to `/`
  before matching, so `C:\proj\dist\a.js` matches `dist/**`.
- **`getProjectRoot()` walks up correctly** (#33). The parent-directory step
  was a `/`-only regex that never terminated properly on `C:\`; it now uses
  `path.dirname`.
- **`displayPath()` shortens Windows paths.** Splitting on `/` treated
  `C:\a\b\c\file.ts` as one segment, so nothing was truncated and raw absolute
  paths leaked into every report.
- New `toPosixPath()` helper in `src/utils.js` — one normalization point at the
  boundary instead of two separator dialects in every matcher.

### Docs
- `CONTRIBUTING.md` (#40) — setup, the release checklist, and the platform
  rules above, so the POSIX assumption doesn't creep back in.

### Tests
175 → 183. Covers the Windows transcript-folder encoding, CRLF/LF parse
equivalence, backslash path display, and `toPosixPath`.


## 4.6.0 — 2026-07-06

### /cco-overhead mcp — observation → the exact removal command
- New `overhead.js mcp` subcommand: audits 30 days of tracked `mcp__*` calls
  against every configured MCP server (user / local / project scope) and
  prints per-server verdicts. Servers never called get the exact
  `claude mcp remove "<name>" -s <scope>` fix; the skill offers to run it.
  Verdicts hold off until 5+ tracked sessions of evidence.

### Benchmark: dollar-leak economics
- `benchmark/run.js` now prices the cache-break guard's value: one avoided
  break on 150K context = $0.86; at 3 breaks/day that is ~$57/month (150K ctx)
  to ~$152/month (400K ctx). Written to `results.json` as
  `cacheBreakEconomics`.

### README/landing
- Session-summary screenshot asset (`assets/summary-demo.svg`) with the
  "★ CCO saved $654.36 — 86%" headline, embedded in the README v4.5 section.


## 4.5.0 — 2026-07-06

### Model auto-detection — works with fable / opus / sonnet / haiku, no config
- The budget hook now reads the session's REAL model id from the transcript
  (`message.model`) and stores it in budget state. Window size, pricing, the
  dashboard header, and Read-Cache staleness thresholds all follow the model
  the session actually runs on — switching `/model` mid-day no longer
  miscalibrates anything. `config.model` is only the fallback.
- New `normalizeModelId()` maps raw API ids (`claude-fable-5`,
  `claude-opus-4-8[1m]`, dated haiku ids…) to the pricing table; added Claude 5
  family entries (fable/mythos at the Opus tier until pricing is published).

### Ground-truth tool accounting (Bash/MCP no longer invisible)
- `Bash` added to the tracker/budget hook matcher — shell output was the
  biggest untracked context consumer.
- PostToolUse now measures the ACTUAL `tool_response` size instead of
  stat-based guessing, for every tool. Waste attribution and /compact
  recommendations get real numbers.
- Big-result nudge: any single tool result ≥10K tokens emits a one-line fix
  ("pipe through tail/grep", "read with offset/limit") — the #1 avoidable burn.

### Context-rot warning (quality, not capacity)
- On 1M-window models, a one-shot critical notice fires at ~350K context:
  intelligence degrades in the ~300-400K "dumb zone" long before budget-%
  warnings would trigger. Suggests a focused /compact or a fresh session.

### Cache-break guard (the biggest remaining dollar leak)
- The budget hook timestamps every event; when work resumes after a ≥5-min
  pause with ≥20K warm context, it names the real cost of the break that just
  happened (context × input rate × (1.25 write − 0.1 read)) and teaches the
  habit: batch pauses, /compact before stepping away.

### Observation → rule: .contextignore suggestions in the hook path
- The shield's historical waste knowledge (files read-but-unused in 3+
  sessions) now surfaces automatically once per session when the recurring
  waste is ≥30K tokens, with the exact `/cco-shield apply` fix. Previously
  this intelligence was only visible if you manually ran the CLI.

### CLAUDE.md size nudge at SessionStart
- Memory files load into every prompt — the most expensive place for bloat.
  If project + user CLAUDE.md together exceed 200 lines, a one-shot notice
  points at `/cco-claudemd`.

### Savings headline on the session-end summary
- `dashboard.js summary` now leads with the one number people remember:
  `★ CCO saved $X this session — Y% of what it would have cost.`
  (read-cache savings + prompt-cache economics vs the uncached price).

### Fixes
- Removed duplicated hook registrations guidance: plugin hooks.json is the
  single source; running CCO hooks from both settings.json and the plugin
  double-counted every stat and spawned 3 extra node processes per tool call.

## 4.3.0 — 2026-07-04

### Prompt Coach stops grading conversation (trust fix)
- New classifier (`classifyPrompt`): prompts are `chat` / `question` / `task`.
  Conversational replies ("спасибо, всё ок") are no longer graded F with
  "name the file you want changed" advice injected into context — the coach
  now coaches only actual work requests. Questions are graded for history but
  never coached.
- **Russian language support**: strong/vague verbs, unbounded phrases, success
  hints, and interrogatives. Also fixes a latent bug: JS `\b` is ASCII-only,
  so Cyrillic verb matching silently never worked.
- Follow-up leniency: short mid-session prompts lean on loaded context and are
  no longer coached unless truly unbounded.

### Cache economics — the real billing lever (`/cco`)
- Session cost is now priced at **real prompt-cache rates** (reads 10%, writes
  125% of input) from exact transcript usage, instead of pricing every token
  at the full input rate (which overstated cost up to ~10×).
- New **Cache line** on the `/cco` board: hit rate, $ saved vs uncached, and
  **cache breaks** — moments the warm cache went cold (>5 min pause, mid-session
  CLAUDE.md edit, model switch) and the whole context was re-written at 1.25×.
  The session summary calls out breaks with their extra cost.

### NEW `/cco-overhead` — session baseline audit
- Measures the fixed context every session starts with (system prompt, tools,
  MCP, agents, CLAUDE.md, memory) from ground-truth transcript usage: latest,
  average across recent sessions, % of budget, and $ per session.
- Itemizes locally measurable sources (project/global CLAUDE.md, memory index,
  agent definitions) and flags the unattributed remainder with concrete
  recommendations. Baseline trims repay in EVERY session.

### `/cco-shield suggest|apply` — close the waste loop
- `suggest` turns files wasted in 3+ sessions into ready `.contextignore`
  patterns (with per-session savings); `apply` appends them, deduped against
  existing rules. Observation → permanent rule.

### Self-calibrating estimates
- At session end, the real/estimated token ratio is EMA'd into config
  (clamped 0.5–2×) and the budget hook multiplies its input estimates by it.
  The chars-per-token heuristic now learns each codebase's actual drift.

### Delegation advisor
- 12+ consecutive Read/Grep/Glob calls with no edits and 20K+ tokens pinned in
  main context now triggers a one-per-session suggestion to delegate broad
  exploration to a subagent (whose context is discarded — only the conclusion
  returns). Resets on any edit or Agent call.

### Tests
- 150 → 170: prompt classification (ru/en), cache-break detection, cache-aware
  cost math, baseline parsing, ignore suggestions, calibration EMA, streak
  advisor.

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
