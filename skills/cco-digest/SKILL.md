---
name: cco-digest
description: Show weekly/daily efficiency digest with score and trends
license: MIT
disable-model-invocation: true
argument-hint: "[7|14|30] (days, default 7)"
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/digest.js:*)"
---

# Context Efficiency Digest

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Generate and display an efficiency digest for the specified time period.

Parse $ARGUMENTS for the number of days (default: 7).

Run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/digest.js $ARGUMENTS
```

Present the digest to the user. Highlight:
1. Their efficiency grade (S/A/B/C/D/F) and what it means
2. Which score components are weakest and how to improve them
3. Cost savings opportunities
4. Trend over time — is efficiency improving or declining?

If grade is C or below, provide 3 specific actionable tips.
If grade is A or above, congratulate them and suggest advanced techniques.
