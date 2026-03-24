---
title: I built a plugin that blocks Claude Code from re-reading the same file — saves 30-60% tokens
published: false
description: A Claude Code plugin that tracks every file read and blocks redundant ones. Smart Read Cache, ContextShield, token budgets, and more.
tags: claudecode, ai, productivity, opensource
cover_image:
---

My Claude Code sessions were burning 100K+ tokens. I started tracking where they went — 37% were wasted on re-reading files Claude already had in context.

That number bothered me enough to build something about it.

## The problem

Watch Claude Code work on any non-trivial task. You'll see patterns like this:

- `package.json` read 3 times in a single session
- `tsconfig.json` loaded, ignored, loaded again after compaction
- A 200-line utility file read 4 separate times across the conversation

The math is brutal. A 200-line file is roughly 1,900 tokens. Read it 4 times and you've spent 7,600 tokens on the same information. At $15/M tokens on Opus, that adds up fast.

The worst part? After compaction, Claude loses context and re-reads *everything*. Your carefully loaded files? Gone. So it reads them all again.

## What I built

[claude-context-optimizer](https://github.com/egorfedorov/claude-context-optimizer) — a Claude Code plugin that hooks into the tool lifecycle and stops the waste.

The killer feature is **Smart Read Cache**. It's a `PreToolUse` hook that intercepts every `Read` call and blocks it if the file was already loaded and hasn't changed.

Here's the core logic, simplified:

```javascript
// PreToolUse hook — runs before every Read tool call

const entry = cache.files[filePath];
const currentMtime = statSync(filePath).mtimeMs;

// First read? Always allow.
if (!entry) {
  cache.files[filePath] = { mtime: currentMtime, ranges: [[offset, end]] };
  return; // allow
}

// File changed since last read? Allow.
if (currentMtime !== entry.mtime) {
  return; // allow
}

// New section (different offset/limit)? Allow.
if (!isRangeCovered(entry.ranges, offset, end)) {
  entry.ranges.push([offset, end]);
  return; // allow
}

// Same file, same range, unchanged. Block it.
return { decision: 'block', reason: 'Already loaded — file unchanged.' };
```

It's smart about edge cases:

- **Compaction** — clears the cache, because Claude actually lost the context
- **Edit/Write** — invalidates that file's cache entry, because the content changed
- **Partial reads** — tracks offset/limit ranges and only blocks if the exact range was already covered

When it blocks a read, Claude sees a message like:

```
Already loaded tracker.js this session (983 lines, ~9.3K tokens).
File unchanged. Use offset/limit to read a specific section, or Edit to modify it.
```

Claude adapts. It stops trying to re-read and works with what it has.

## Other features

Read Cache is the biggest win, but the plugin does more:

**Project Anatomy** — generates a one-file codebase map with file sizes and token estimates. Claude reads one file instead of opening twenty to understand your project.

**ContextShield** — a second PreToolUse hook that warns before loading files that were historically wasted. If `README.md` was read-but-never-used in 5 past sessions, it tells Claude to use Grep instead.

**Token Budget** — tracks token accumulation in real-time and warns at configurable thresholds (50%, 70%, 85%, 95%). At 85%+ it lists specific files to drop with exact token savings.

**CLAUDE.md Analyzer** — scans your CLAUDE.md for token bloat: duplicate lines, verbose phrasing ("please make sure to" -> "Always"), oversized code blocks. Shows estimated savings.

**Weekly Digest** — efficiency score (S/A/B/C/D/F grade), cost breakdown by model, waste trends, actionable tips.

Everything runs as hooks. Zero config. Install it and forget it's there.

## Installation

Recommended:

```bash
npx skills add https://github.com/egorfedorov/claude-context-optimizer
```

Or clone and point Claude at it:

```bash
git clone https://github.com/egorfedorov/claude-context-optimizer.git ~/claude-context-optimizer
claude --plugin-dir ~/claude-context-optimizer
```

To update:

```bash
claude plugin update claude-context-optimizer@egorfedorov-plugins
```

No telemetry. No network calls. All data stays in `~/.claude-context-optimizer/` on your machine.

## Results

[TODO: fill with real data after 10+ sessions]

After 10 sessions with the plugin, here's what changed:

- Average tokens per session: [BEFORE] -> [AFTER]
- Redundant reads blocked: [NUMBER] per session
- Monthly cost impact: ~$[X] saved on Opus

## Privacy note

The plugin tracks file paths and line counts only. Never file contents. Everything is local. You can wipe all data with `/cco-clean --reset-all`.

---

The repo is at [github.com/egorfedorov/claude-context-optimizer](https://github.com/egorfedorov/claude-context-optimizer). MIT licensed.

Star it if it saved you tokens.
