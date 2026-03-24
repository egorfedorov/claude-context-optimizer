---
title: "Update: my Claude Code token optimizer now blocks redundant reads. Here's the data from 107 sessions."
published: false
description: "Two weeks ago I shared a plugin that tracks token waste. Now it actively prevents it — and I have real numbers from 107 sessions to prove it."
tags: claudecode, ai, productivity, opensource
cover_image:
series: "Claude Code Token Optimization"
---

Two weeks ago I posted [I tracked where my Claude Code tokens actually go. 37% were wasted.](https://dev.to/egorfedorov/i-tracked-where-my-claude-code-tokens-actually-go-37-were-wasted-2gll) — a plugin that tracks where your tokens go and shows you the waste.

34 reactions. Great feedback. But one comment stuck with me:

> "The real unlock for me was getting a live counter visible all session instead of only doing post-mortems, because it changes behavior in the moment before waste happens." — @henrygodnick

He was right. Tracking is nice. **Preventing** is better.

So I built v3.1 — and the plugin now actively blocks wasted reads instead of just reporting them.

## The big one: Smart Read Cache

The #1 waste pattern I found in 107 sessions: **Claude re-reads the same file multiple times.**

`page.tsx` — read **189 times** across my sessions. 60 of those were pure duplicates. That's 130K tokens burned on a file Claude already had.

So I added a `PreToolUse` hook that intercepts every `Read` call:

```javascript
// First read? Always allow.
if (!entry) return allow();

// File changed on disk? Allow.
if (currentMtime !== entry.mtime) return allow();

// Different section? Allow.
if (!isRangeCovered(entry.ranges, offset, end)) return allow();

// Same file, same range, unchanged. Block it.
return { decision: 'block', reason: 'Already loaded — file unchanged.' };
```

When it blocks, Claude sees:

```
Already loaded tracker.js this session (983 lines, ~9.3K tokens).
File unchanged. Use offset/limit to read a specific section, or Edit to modify it.
```

And Claude **adapts** — it stops trying to re-read and works with what it has.

### It's not dumb about it

Three edge cases that matter:

- **Compaction** — Claude actually lost the context. Cache clears. Re-reads allowed.
- **Edit/Write** — file content changed. That file's cache invalidates.
- **Partial reads** — tracks offset/limit ranges. Only blocks if the exact range was already covered.

## Real numbers: 107 sessions analyzed

I ran a retroactive analysis on all my existing sessions — what would Read Cache have saved?

```
Sessions analyzed:              107
Total tokens tracked:           23.5M
Redundant reads found:          1,225
Tokens that would have been saved: 1.9M (8.0%)
```

Top sessions by savings:

| Session | Saved | Total | % |
|---------|-------|-------|---|
| Football Slot | 247K | 362K | **68%** |
| claude-context-optimizer | 62K | 210K | **29%** |
| Engine3.0 | 63K | 329K | **19%** |
| DJ Beat Drop | 39K | 276K | **14%** |

Top re-read offenders:

| File | Total reads | Blocked | Tokens saved |
|------|-------------|---------|--------------|
| `page.tsx` | 189 | 60 | 130.9K |
| `GameInfoModal.svelte` | 23 | 6 | 56.8K |
| `variables.css` | 34 | 26 | 49.2K |
| `client.ts` | 46 | 22 | 48.8K |
| `types.ts` | 60 | 30 | 41.6K |

That's **1.9M tokens** I would have saved. At $15/M on Opus — roughly **$28.50** over two weeks, or ~$60/month.

## What else is new in v3.1

**Project Anatomy** (`/cco-anatomy`) — generates a one-file codebase map:

```
# Project Anatomy: my-app
Generated: 2026-03-24 | 31 files | ~46K tokens if all read

| Path | Lines | ~Tokens | Type |
|------|-------|---------|------|
| src/tracker.js | 984 | 9.1K | source |
| src/export.js | 398 | 3.7K | source |
...
```

Claude reads this instead of opening 20 files to understand your project.

**45 unit tests** — the plugin is now properly tested. `npm test` runs in under 60ms.

**Honest README** — I renamed "Interactive Dashboard" to "HTML Dashboard Export" because that's what it actually is. No more marketing fluff.

## Install / update

First time:
```bash
npx skills add https://github.com/egorfedorov/claude-context-optimizer
```

Already have it:
```bash
claude plugin update claude-context-optimizer@egorfedorov-plugins
```

Zero config. Zero telemetry. All data stays local.

---

[GitHub repo](https://github.com/egorfedorov/claude-context-optimizer) — MIT licensed.

The v2 post got 34 reactions. Let's see if blocking redundant reads is worth a star.
