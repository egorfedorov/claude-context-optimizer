---
name: cco
description: Context Control Center — one screen for budget, $ spent, tokens saved, waste, last prompt grade, the active task, and ready-to-run optimization actions
license: MIT
allowed-tools: [Bash, Read]
---

# Context Control Center

The all-in-one view of the current session. Show the user the live board, then
the per-file heatmap if they want detail.

## 1. Show the board

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/dashboard.js board
```

This renders, in one screen:
- **Budget** — % of the effective context window used + $ spent this session
- **Saved** — tokens the Read Cache blocked → the effectiveness multiplier (e.g. "1.4x")
- **Waste** — cold context (read but never edited) you can drop to free budget
- **Prompt** — grade of the last prompt (from Prompt Coach)
- **Task** — the active task and its token/$ cost (per-task attribution)
- **Actions** — concrete next steps: what to drop → `/compact`, what to `/cco-pack`

Present the board as-is. Then, based on what it shows:
1. If an **action** line suggests dropping cold files, offer to run `/compact`.
2. If **no task is active**, suggest `/cco-task add "<what they're working on>"` so
   the board can attribute tokens per task.
3. If the **prompt grade** is low (C/D/F), suggest `/cco-coach`.

## 2. (Optional) per-file heatmap

If the user wants the file-by-file breakdown:

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js heatmap
```

Highlight files read but never used (waste), files that were edited (high-value),
and the total token usage / waste percentage.

If there is no data yet, tell the user:
"No data in this session yet — keep working. Reads, edits, prompts and cache
savings are tracked automatically; run /cco again to see the board fill in."
