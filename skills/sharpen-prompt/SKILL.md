---
name: sharpen-prompt
description: Rewrite a vague request into a precise prompt — goal, context, scope, constraints, what done looks like, output format. Use when the user asks to improve, rewrite, sharpen or check a prompt.
license: MIT
---

# Sharpen a prompt

A precise prompt saves the back-and-forth, and the tokens, that a vague one
costs. Rewrite the user's prompt so another assistant could do the task right
on the first try.

## Check what the prompt is missing

1. **Goal**: what should exist or be true at the end.
2. **Context**: who it's for, what it builds on, what was tried.
3. **Scope**: exactly which files, sections, data or part of the problem. Name
   them.
4. **Constraints**: must keep, must avoid, length, tone, tools, deadline.
5. **Done looks like**: how to tell it worked: tests pass, a sample output, a
   checklist.
6. **Output format**: a list, a table, a diff, a file, a one-paragraph answer.

## Then

- If you can fill the gaps from the conversation, write the improved prompt in
  a code block in the user's language. Keep it as short as the task allows,
  and list in one line what you added and why.
- If one gap is essential and unknowable, ask that one question instead of
  guessing. Never ask more than one.
- Don't do the task itself unless the user asks you to.
