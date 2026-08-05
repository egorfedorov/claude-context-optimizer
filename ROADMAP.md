# claude-context-optimizer — Roadmap

The north star: **the honest ledger of your Claude Code spend.** Every release
must make a number more true, a waste more visible, or a fix more automatic.

## v4.4 — Act, don't just report

- [x] **`/cco-overhead` auto-fix** — shipped in v4.6.0: `overhead.js mcp`
      audits 30 days of tracked mcp__* calls per configured server and prints
      the exact `claude mcp remove` for servers never called; the skill offers
      to run them
- [x] **Real-time cache-break warning** — shipped in v4.5.0: the budget hook
      timestamps events and names the cost of a >=5-min-pause break the moment
      work resumes (plus model auto-detection, Bash accounting, context-rot
      warning, auto-.contextignore, CLAUDE.md nudge, savings headline)
- [ ] **Prompt-coach outcome learning**: correlate prompt grades with what the
      session actually did (files read to find intent, re-prompts) and tune
      the weights from evidence, not vibes
- [ ] **`/cco-pack` v2**: pack from git branch context + open PR diff, not
      just prompt keywords

## v4.5 — Precision

- [x] **Per-language token estimation** — shipped in v4.8.0: chars/line
      measured over 6.3K real files, per extension, config-overridable (#35)
- [ ] **Exact token counting** for estimates via a local BPE approximation
      (self-calibration + per-language chars/line narrow the gap; kill it entirely)
- [ ] **Per-model cache TTL awareness** (1h beta cache pricing) in economics
- [ ] **Subagent economics**: split main-loop vs agent token spend in `/cco`
      and credit delegation savings to the advisor that suggested it
- [x] **Windows-correct paths** — shipped in v4.7.0: transcript-folder
      encoding, CRLF `.contextignore`, backslash-aware globs, project-root
      walk and path display (#46, #33)
- [ ] **Windows-native hooks** (drop the POSIX-shell requirement — the *only*
      remaining Windows gap; Git Bash/WSL still required)

## v5.0 — The ecosystem

- [ ] **Team patterns**: opt-in export/import of waste patterns and
      `.contextignore` presets per repo (a lockfile is a lockfile everywhere)
- [ ] **Unified local dashboard** with [cco-arcade](https://github.com/egorfedorov/cco-arcade):
      one server, two tabs — the truth (CCO analytics) and the fun (Token City);
      cache breaks render as lightning storms over the city
- [ ] **VS Code heatmap overlay** (file explorer badges from patterns.json)
- [ ] **`/cost` integration**: reconcile CCO numbers against Claude Code's own
      cost reporting and show the delta

---

## The bar for EVERY release ✅

1. **Honesty first**: never report a number we can't defend; prefer transcript
   ground truth over estimates; NET savings over gross.
2. **Silence is a feature**: hooks stay <10ms and inject nothing that isn't
   actionable (the notice ledger caps advisory output).
3. Tests for all new pure logic; CI green on Node 18/20/22 + CodeQL.
4. Version sync: `npm run sync-version` (4 files) **+ the external
   `egorfedorov/claude-plugins` marketplace** (the script warns about it).
5. CHANGELOG + README "What's new"; branch → PR → merge → tag → GH release.
