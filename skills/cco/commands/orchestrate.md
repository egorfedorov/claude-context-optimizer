# Orchestrate: <args>

> **Needs Claude Code or Cowork**: the `scout` and `runner` subagents don't load in claude.ai chat. There, do the task directly and suggest `fresh-start` when the conversation gets long.

Do this task as an orchestrator. The aim is the same result at a fraction of
the cost: in a long session, every token in this conversation is re-read on
each later request, while a subagent's reading is discarded when it returns.
The plugin's subagents run on Haiku 5.5, about 40× cheaper per token than
Opus 5.5.

## How to split the work

1. **Understand (delegate).** List the questions you need answered before you
   can change anything: where is X defined, how does Y flow, what calls Z,
   what do the docs say about W. Send each independent question to a
   `context-optimizer:scout` subagent, several in parallel when they don't
   depend on each other. Write each prompt as a precise question with the
   names, paths or URLs you already know, and ask for `path:line` evidence.
2. **Decide (yourself).** Plan from the scouts' answers. Read yourself only
   the exact line ranges you are about to edit.
3. **Change (yourself).** Make the edits here. Don't hand edits or design
   decisions to a subagent.
4. **Verify (delegate).** Send the exact test, build or lint commands to a
   `context-optimizer:runner` subagent and act on its failure report. Fix,
   then send the runner again until it passes.
5. **Report.** What changed, why, and what was verified.

## When not to delegate

- One known file or one grep: do it yourself; a subagent's startup costs more.
- Work that needs many back-and-forth steps on shared context.
- Anything that changes files, or needs judgment about the design.

If this conversation is already past ~150K tokens, suggest `/compact` before
starting a large task.
