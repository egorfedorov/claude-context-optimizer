---
name: cco-audit
description: Honest savings audit from your own Claude Code transcripts — where the money went, what CCO verifiably saved, and which bigger levers (compacting earlier, Haiku delegation, fixed overhead) would save more
license: MIT
disable-model-invocation: true
argument-hint: "[--days N] [--project] [--compact-at TOKENS]"
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/audit.js:*)"
---

# Savings audit

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Answer "does this plugin actually save me anything?" from ground truth: the
session transcripts Claude Code keeps in `~/.claude/projects/`. Nothing leaves
the machine; the script only prints totals.

Run (pass `$ARGUMENTS` through; add `--project` to limit it to the current
project):

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/audit.js $ARGUMENTS
```

Present the report, then explain it in plain words:

1. **Spend** — total over the period, and how it splits into cache reads,
   cache writes and output. Cache reads dominate when sessions run long: the
   whole context is re-read on every request.
2. **What CCO did** — read-cache refusals found in the transcripts, priced at
   what each skipped read would have cost for the rest of its session. Say
   plainly if this is small.
3. **Bigger levers** — the estimates, largest first, with the concrete action
   for each (`/compact` earlier, delegate exploration to the
   `context-optimizer:scout` subagent or run `/cco-orchestrate`, trim fixed
   overhead with `/cco-overhead`).
4. **Verdict** — one sentence: the single change that would save the most for
   this user.

Don't round small numbers up or present estimates as measured savings; the
report labels which is which.
