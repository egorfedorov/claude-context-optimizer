---
name: cco-overhead
description: Audit the fixed context overhead every session starts with — system prompt, MCP tools, agents, CLAUDE.md, memory — measured from real transcript usage
license: MIT
allowed-tools: [Bash, Read]
---

# Session Baseline Overhead Audit

Measure how many tokens every session of this project pays BEFORE any work
happens — and where to cut.

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/src/overhead.js
```

The report shows:

1. **Baseline** — exact context size at the first assistant response (from the
   session transcript's API usage counts), latest and averaged over recent
   sessions, as a % of the working budget.
2. **Cost per session** — what that baseline costs to write into the prompt
   cache each session.
3. **Itemization** — the locally measurable parts (project + global CLAUDE.md,
   memory index, agent definitions) and the unattributed remainder (system
   prompt, tool schemas, MCP servers).
4. **Recommendations** — what to trim and how (e.g. `/cco-claudemd`, disabling
   unused MCP servers, pruning agent descriptions).

Present the output to the user as-is (it is already formatted). If the report
says no transcripts were found, explain that the audit needs at least one
completed exchange in a session for this project.

Key framing for the user: baseline overhead is paid in EVERY session, so a
one-time trim repays itself continuously — it is usually the highest-leverage
optimization available.
