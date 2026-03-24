<p align="center">
  <img src="assets/logo.svg" alt="claude-context-optimizer" width="600"/>
</p>

<p align="center">
  <strong>Stop burning tokens on files Claude never uses.</strong>
</p>

<p align="center">
  <a href="#installation"><img src="https://img.shields.io/badge/claude--code-plugin-blue?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PHBhdGggZD0iTTEyIDJMMiA3bDEwIDUgMTAtNS0xMC01ek0yIDE3bDEwIDUgMTAtNS0xMC01LTEwIDV6TTIgMTJsMTAgNSAxMC01Ii8+PC9zdmc+" alt="Claude Code Plugin"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"/></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" alt="Node 18+"/>
  <img src="https://img.shields.io/badge/zero%20config-yes-blueviolet?style=flat-square" alt="Zero Config"/>
  <img src="https://img.shields.io/badge/telemetry-none-critical?style=flat-square" alt="No Telemetry"/>
</p>

---

## The Problem

The average Claude Code session **wastes 30-50% of tokens** on files that are read but never actually used. Every `Read` call consumes context — whether the file was relevant or not.

- A 200-line config file? **800 tokens gone.**
- A README you glanced at once? **2,400 tokens burned.**
- That `package.json` Claude reads "just in case"? **120 tokens, every time.**

At $15/M tokens (Opus), a developer spending $100/month is lighting **$30-50 on fire** on irrelevant context.

## The Solution

**context-optimizer** silently tracks every file read, edit, and search. It learns which files are actually useful and which are waste. Over time, it builds a profile of your coding patterns and tells you exactly where your tokens go — and how to stop wasting them.

<p align="center">
  <img src="assets/how-it-works.svg" alt="How it works" width="700"/>
</p>

---

## Features

### NEW: ContextShield — proactive waste prevention

ContextShield runs as a **PreToolUse hook** and warns you *before* loading known-waste files. It checks historical patterns and suggests alternatives in real-time.

```
[context-shield] README.md was WASTED in 5 sessions (~12.4K tokens burned).
                 Use Grep to find specific content instead of full Read.
[context-shield] utils.js is usually edited with: tracker.js, budget.js.
                 Consider loading them together.
```

Run `/cco-shield` to see protection status and stats.

### NEW: CLAUDE.md Analyzer — trim the bloat

Run `/cco-claudemd` to analyze your CLAUDE.md for token waste: duplicates, verbose patterns, oversized code blocks, excessive whitespace. Get concrete suggestions with estimated savings.

```
  CLAUDE.MD ANALYSIS
  ══════════════════════════════════════════════════════════════
  File: /project/CLAUDE.md
  Size: 342 lines | ~2.9K tokens

  ISSUES (4)
  ──────────────────────────────────────────────────────────────
  ⚠ 3 duplicate line(s) found (~25 saveable)
  ● "please make sure to" found 4x — Simplify to: "Always X" (~12 saveable)
  ● Code block at line 45 is 38 lines — consider shortening (~233 saveable)
  ○ 28% empty/separator lines — reduce for token savings (~98 saveable)

  POTENTIAL SAVINGS: ~368 tokens
```

### NEW: Confidence Learning — smart pattern scoring

File patterns now have confidence scores (0.0-1.0) based on session count, usefulness consistency, and recency. High-confidence patterns produce stronger recommendations; old unused patterns decay naturally.

### NEW: Interactive Dashboard — Chart.js analytics

Run `/cco-export html` to generate an interactive dashboard with:
- Waste trend line chart
- Token usage bar chart
- Project breakdown doughnut
- Edits-per-session timeline
- Click-to-copy donation wallets

### Context Heatmap — see where your tokens go

Run `/cco` to get a visual breakdown of every file in your session. Green = useful. Red = waste.

<p align="center">
  <img src="assets/heatmap-demo.svg" alt="Context Heatmap" width="700"/>
</p>

### Token ROI Report — full analytics across sessions

Run `/cco-report` for a comprehensive dashboard: total tokens, waste ratio, cost estimates, trends, and actionable recommendations.

<p align="center">
  <img src="assets/dashboard-demo.svg" alt="Token ROI Report" width="700"/>
</p>

### Efficiency Score — gamified optimization

Run `/cco-digest` for a weekly efficiency grade (S/A/B/C/D/F) with breakdown by precision, edit ratio, search accuracy, and focus.

<p align="center">
  <img src="assets/efficiency-score.svg" alt="Efficiency Score" width="700"/>
</p>

### Token Budget — never overspend

Set a token budget and get real-time warnings as you approach the limit. Automatic alerts at 50%, 70%, 85%, 95% with cost estimates.

```
[context-budget] 70% budget used (~70K/100K) | Est. cost: $1.050 (opus)
[context-budget] 85% budget used (~85K/100K) | Est. cost: $1.275 (opus)
[context-budget] Run /compact to free ~8.2K tokens:
  drop README.md (~2.4K, 1 reads, 0 edits)
  drop tsconfig.json (~1.1K, 2 reads, 0 edits)
  drop package.json (~320, 1 reads, 0 edits)
```

### Git-Aware Suggestions — smart context loading

Run `/cco-git` and the plugin analyzes your `git diff`, finds related test files, configs, and historically useful files — then suggests exactly what to load.

### Context Templates — presets for common tasks

Create reusable context sets for different task types:

```bash
/cco-templates create bug-fix    # Save files you always need for bug fixes
/cco-templates apply bug-fix     # Load them instantly next time
```

### Smart Loader Skill — automatic suggestions

The plugin learns from your behavior. When you start a new task, it silently suggests files you'll probably need based on historical patterns. No configuration required.

---

## All Commands

When installed as a plugin, commands are namespaced: `/claude-context-optimizer:cco`. With `--plugin-dir`, they're also available as `/cco`.

| Command | Description |
|---------|-------------|
| `/cco` | Session heatmap — visual file-by-file token breakdown |
| `/cco-report` | Full ROI report — stats, trends, waste analysis, recommendations |
| `/cco-digest [days]` | Efficiency digest — score, grade, cost analysis (default: 7 days) |
| `/cco-budget [status\|set\|model]` | Token budget — configure limits and cost model |
| `/cco-git` | Git-aware suggestions — smart file loading based on diff |
| `/cco-templates [list\|create\|apply\|delete]` | Context templates — reusable file sets for task types |
| `/cco-export [md\|html]` | Export reports — Markdown or interactive HTML dashboard |
| `/cco-clean` | Cleanup — remove old tracking data |
| `/cco-shield` | ContextShield status — waste protection stats |
| `/cco-claudemd` | CLAUDE.md analyzer — find and fix token bloat |

---

## Installation

### Option 1 — Skills CLI (recommended)

Install all skills with one command:

```bash
npx skills add https://github.com/egorfedorov/claude-context-optimizer
```

This installs the skills globally to `~/.agents/skills/` and symlinks them to Claude Code. Works with Amp, Cline, Codex, Cursor, Gemini CLI, and other compatible agents.

### Option 2 — Plugin directory

Clone the repo and load it as a plugin:

```bash
git clone https://github.com/egorfedorov/claude-context-optimizer.git ~/claude-context-optimizer
claude --plugin-dir ~/claude-context-optimizer
```

To make it persistent, add to `~/.claude/settings.json`:

```json
{
  "plugins": [
    "~/claude-context-optimizer"
  ]
}
```

### Requirements

- Node.js >= 18
- Claude Code (with plugin/skills support)

---

## Install & Forget

Once installed, the plugin works **automatically** — no commands needed. Here's what happens in the background:

**On session start:**
- Weekly savings streak: "Waste trending down 8% this week!"
- Warns about files that were consistently wasted in this project
- Mentions auto-generated templates if available

**Before every file read (ContextShield):**
- Checks if the file was wasted in 3+ past sessions — warns with token count
- Suggests Grep for known-waste files instead of full Read
- Shows co-occurrence groups ("this file is usually edited with X and Y")

**On every file read:**
- Warns if a file has been read 3+ times without edits (suggests offset/limit)
- Warns if a file was wasted in 2+ past sessions ("Try Grep for specific content instead")
- Tiered warnings for large files: 200+ lines (soft), 500+ lines (strong with token count)

**On budget thresholds (50%, 70%, 85%, 95%):**
- Shows usage percentage and estimated cost per model
- At 85%+, lists specific read-only files to drop with exact token savings
- Repeats compact reminders every 10K tokens after 90%

**On session end:**
- Compares your session waste vs recent average: "12% waste. Better than avg (19%)!"
- Updates pattern database for smarter future suggestions

**After 5+ sessions in a project:**
- Auto-creates file templates from your most frequently edited files
- Notifies you on next session start: "Template available — apply it?"

You literally just code. The plugin watches and helps.

---

## How It Works

```
You use Claude Code normally
         │
         ▼
┌─────────────────────┐
│  PreToolUse Hook     │  ContextShield: warns before loading known-waste files.
│  context-shield.js   │  Checks history, suggests Grep/offset/limit alternatives.
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  PostToolUse Hook    │  Silent. Runs on every Read/Edit/Write/Glob/Grep/Agent.
│  tracker.js          │  Records: file path, line count, token estimate, timestamp.
│  budget.js           │  Tracks token accumulation, warns at thresholds.
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Session Store       │  ~/.claude-context-optimizer/sessions/<id>.json
│  Per-file tracking   │  Reads, edits, usefulness score, confidence score.
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  SessionEnd Hook     │  Finalizes session. Computes waste. Updates patterns DB.
│  Confidence Learning │  Patterns scored 0.0-1.0, decay over time.
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Reports & Insights  │  /cco, /cco-report, /cco-digest, /cco-claudemd
│  Interactive Charts  │  HTML dashboard with Chart.js analytics
│  ContextShield       │  Proactive waste prevention before file reads
│  Smart Suggestions   │  Confidence-scored recommendations
└─────────────────────┘
```

### What counts as "useful"?

A file is considered **useful** if (weighted scoring):
- It was **edited** after being read (+3 per edit)
- It was **read multiple times** (+0.5 per re-read, diminishing)
- It was **partially read** with offset/limit (+1 bonus for smart usage)

A file is considered **wasted** if:
- Its usefulness score is zero or negative (read but never edited, no re-reads)
- Large files (100+ lines) read 3+ times without edits get a penalty

### Token estimation

Tokens are estimated using extension-specific ratios (e.g., 3.8 chars/token for JS/TS, 4.2 for Markdown, 3.2 for JSON) applied to line counts. Not exact, but consistent enough for comparative analysis.

---

## Data Storage

```
~/.claude-context-optimizer/
├── sessions/           # Per-session tracking data (JSON)
├── budget/             # Per-session budget state
├── templates/          # User-defined context templates
├── exports/            # Exported reports (MD/HTML)
├── config.json         # Budget and preference settings
├── patterns.json       # Cross-session file usage patterns
└── global-stats.json   # Aggregate statistics
```

---

## Plugin Structure

```
claude-context-optimizer/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── src/
│   ├── utils.js             # Shared constants, formatting, scoring, donation info
│   ├── tracker.js           # Core: file & token tracking engine
│   ├── context-shield.js    # ContextShield: PreToolUse waste prevention
│   ├── claudemd-analyzer.js # CLAUDE.md token bloat analyzer
│   ├── budget.js            # Token budget monitor with alerts
│   ├── digest.js            # Efficiency score & weekly digest
│   ├── git-context.js       # Git-aware context suggestions
│   ├── report.js            # ROI report generator
│   └── export.js            # Interactive Chart.js HTML dashboard exporter
├── skills/
│   ├── cco/SKILL.md               # /cco — session heatmap
│   ├── cco-report/SKILL.md        # /cco-report — full ROI report
│   ├── cco-digest/SKILL.md        # /cco-digest — efficiency digest
│   ├── cco-budget/SKILL.md        # /cco-budget — budget manager
│   ├── cco-git/SKILL.md           # /cco-git — git suggestions
│   ├── cco-export/SKILL.md        # /cco-export — report export
│   ├── cco-templates/SKILL.md     # /cco-templates — template manager
│   ├── cco-clean/SKILL.md         # /cco-clean — data cleanup
│   ├── cco-shield/SKILL.md        # /cco-shield — ContextShield status
│   ├── cco-claudemd/SKILL.md      # /cco-claudemd — CLAUDE.md analyzer
│   └── smart-loader/SKILL.md      # Auto-suggestion skill (model-invoked)
├── agents/
│   └── context-analyzer.md  # Deep analysis agent
├── hooks/
│   └── hooks.json           # Hook configuration
├── assets/                  # SVG visuals for README
├── docs/
│   └── index.html           # Landing page (GitHub Pages)
├── skills.json              # Skills CLI manifest
└── package.json
```

---

## Privacy

This plugin:

- **Tracks only file paths and line counts** — never file contents
- **Stores everything locally** in `~/.claude-context-optimizer/`
- **Sends zero telemetry** — no network calls, no analytics, no tracking
- **Can be fully wiped** with `/cco-clean --reset-all`

Your data never leaves your machine. Period.

---

## FAQ

**Q: Does this slow down Claude Code?**
A: No. Hook scripts run asynchronously and typically complete in <10ms. The tracker only writes small JSON files.

**Q: How accurate are the token estimates?**
A: They use a ~4 tokens/line heuristic. It's not exact, but it's consistent across sessions, making trends and comparisons reliable.

**Q: Can I use this with Claude Sonnet / Haiku?**
A: Yes. Set your model with `/cco-budget model sonnet` for accurate cost estimates.

**Q: Will this work with subagents?**
A: Yes. The PostToolUse hook fires for all tool calls, including those made by subagents.

---

## Support Development

context-optimizer is **100% free and open source**. No paywalls, no premium tiers, no telemetry. If it saves you money on tokens, consider supporting development with a donation:

| Chain | Address |
|-------|---------|
| **BTC** | `bc1q428exz5t2h9rzk7z5ya70madh0j3rs6h4gfgyd` |
| **ETH (ERC-20)** | `0xB3f0C8e42B7cA9d65920cEfe82e3fef1B5C9d0C9` |
| **SOL** | `8ctK8nt3CBkPZGfWQXX8TsnqUYUy4JAbT1EMhr8rsQxm` |

Every donation helps keep this project maintained and evolving. The more users save on tokens, the more features we build to save even more.

---

## Contributing

PRs welcome. Areas that need help:

- [ ] More accurate token counting (AST-based instead of line-based)
- [ ] VSCode extension for visual heatmap overlay
- [ ] Team sharing — aggregate patterns across team members
- [ ] Integration with Claude Code's built-in `/cost` command
- [ ] Multi-language CLAUDE.md analysis

---

## License

MIT — do whatever you want with it.

---

<p align="center">
  <sub>Built with frustration at wasted tokens and love for efficiency.</sub><br/>
  <sub>If we saved you money, <a href="#support-development">return the favor</a>.</sub>
</p>
