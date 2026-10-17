# Savings audit

Answer "does this plugin actually save me anything?" from ground truth: the
session transcripts Claude Code keeps in `~/.claude/projects/`. Nothing leaves
the machine; the script only prints totals.

Run (pass `<args>` through; add `--project` to limit it to the current
project):

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/audit.js <args>
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
   `context-optimizer:scout` subagent or run `/cco orchestrate`, trim fixed
   overhead with `/cco overhead`).
4. **Verdict** — one sentence: the single change that would save the most for
   this user.

Don't round small numbers up or present estimates as measured savings; the
report labels which is which.
