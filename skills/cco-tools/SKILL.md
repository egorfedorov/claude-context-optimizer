---
name: cco-tools
description: Show what tools actually cost in tokens — learned per-tool averages from observed results, replacing the hardcoded MCP/Agent guesses
license: MIT
argument-hint: "[show | reset]"
allowed-tools: [Bash]
---

# CCO Tools — what your tools really cost

MCP and Agent token costs used to be constants picked once (`mcp__*` ≈ 200 in,
`Agent` ≈ 500). Real results vary by orders of magnitude — a "list all issues"
query and a one-row lookup are the same tool name and nowhere near the same
cost. On MCP-heavy sessions the budget meter was guessing at its biggest line
item.

CCO now measures every tool result and learns the average per tool name.

Run from the plugin root:

## `show` (or no arguments)

```bash
node src/tool-costs.js
```

Prints the learned table: calls, average, worst case, and cumulative total per
tool, sorted by total spend.

When reading it back to the user, the useful observations are:
- **The top row by `total` is where their context budget actually goes.** It is
  frequently an MCP server rather than file reads.
- A row marked `·` has fewer than 3 samples and is still using the built-in
  constant — its estimate isn't trustworthy yet.
- A large gap between `avg` and `max` means that tool is unpredictable; suggest
  narrowing its queries (filters, limits, pagination) rather than dropping it.

Pair with `/cco-overhead mcp` — that shows which servers are *configured but
never called*; this shows what the called ones actually cost.

## `reset`

```bash
node src/tool-costs.js reset
```

Clears the learned table and returns every tool to its built-in constant.
Useful after changing MCP servers or their configuration, when past
measurements no longer describe the current setup. Confirm before running —
the history isn't recoverable.
