---
name: cco-templates
description: Manage context templates for common task types
license: MIT
disable-model-invocation: true
argument-hint: "[list | create <name> | apply <name> | delete <name>]"
allowed-tools:
  - "Bash(node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js:*)"
  - Read
  - Glob
---

# Context Templates

> **Needs Claude Code** (or Cowork on your computer): this runs the plugin's local scripts. If `node` or `${CLAUDE_PLUGIN_ROOT}` isn't available, as in claude.ai chat, don't try to run anything. Say so in one line and offer the `fresh-start` or `token-check` skill instead.

Context templates are pre-defined sets of files to read for common task types, saving time and tokens by loading only what's needed.

Templates are stored in `~/.claude-context-optimizer/templates/`.

Parse $ARGUMENTS:

## `list` (or no arguments)
Show all available templates: Glob `~/.claude-context-optimizer/templates/*.json`.
For each template, show its name, description, and file list.

## `create <name>`
Help the user create a new template. Ask them:
1. What type of task is this for? (e.g., "bug-fix", "new-feature", "refactor", "review")
2. Which files/patterns should be pre-loaded?

Also suggest files based on historical tracking data:
```bash
node ${CLAUDE_PLUGIN_ROOT}/src/tracker.js suggest
```

Save (the user approves the write) the template as `~/.claude-context-optimizer/templates/<name>.json` with format:
```json
{
  "name": "template-name",
  "description": "What this template is for",
  "files": ["relative/path/to/file1", "relative/path/to/file2"],
  "patterns": ["**/*.config.*", "src/core/**"],
  "preCommands": ["git status", "git log --oneline -5"]
}
```

## `apply <name>`
Read the template and execute:
1. Run any `preCommands`
2. Read the listed files
3. Search for the listed patterns using Glob

This gives Claude exactly the right context for the task type.

## `delete <name>`
Delete the template file and confirm.
