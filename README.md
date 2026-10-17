# Context Optimizer (CCO)

**See what Claude costs you, and spend less of it.** Every message re-sends
the whole conversation, so long chats and long coding sessions use up limits
fast and recall early details worse. context-optimizer keeps the context small,
moves cheap work to a cheap model, and shows you the numbers while you work.

| Where | What you get |
|---|---|
| **claude.ai chat and desktop** | Skills Claude uses on its own: `fresh-start` hands a long chat over to a new one, `doc-digest` turns a long document into a working digest, `project-context` turns background you keep retyping into Project instructions, `token-check` sizes text and files, `sharpen-prompt` tightens a vague request |
| **Cowork** | The same skills, plus two subagents on Haiku 5.5, about 40× cheaper than Opus: `scout` for reading and searching, `runner` for tests and builds |
| **Claude Code** | Everything: a **live meter** under the prompt, the Haiku subagents, `/cco` (a session board, an audit of your own transcripts, task state that survives `/compact`, and more), read dedup, and budget and cache warnings |

Runs locally, open source (MIT), no telemetry.

![context-optimizer](assets/logo.svg)

[![Claude Code plugin](https://img.shields.io/badge/claude--code-plugin-blue?style=flat-square)](#installation)
[![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
![No Telemetry](https://img.shields.io/badge/telemetry-none-critical?style=flat-square)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

---

## The live meter

In Claude Code, one line under the prompt, updated after every reply and every
minute. It appears as the session starts, with your plan's limits; the context
and cost fill in after the first reply:

```text
context-optimizer: ctx 142K/1M 14% · $3.10 · 5h 63% · 7d 41% · cache 47m
```

- **ctx**: how much context the last reply was answered over, of the model's
  window. Every message re-sends all of it.
- **$**: what the session has cost so far, as `/cost` counts it.
- **5h / 7d**: how much of your plan's 5-hour and weekly limits is used.
- **cache**: minutes until the prompt cache expires. After that, the next
  message pays full price or more for the whole context instead of a
  twentieth of it. The meter learns from your own requests whether your cache lasts 5
  minutes or an hour.

It speaks up once, as a toast, when it matters: context past 70%, a limit past
80%, or a cold cache on a large context. `/cco-meter` hides it or shows it
again. The figures come from Claude Code itself; the meter reads no files and
sends nothing anywhere.

## Skills that work everywhere

These need no setup and run in chat, Cowork and Claude Code alike. Claude
picks them up on its own, or you can ask:

| Skill | Ask for it like this | What you get |
|---|---|---|
| `fresh-start` | "Let's continue in a new chat" | A handoff under 300 words to paste into a new conversation, with how much it saves |
| `doc-digest` | "Summarize this so we can keep working with it" | A digest of a long document, with a section map and references, at a tenth of the size |
| `project-context` | "I keep explaining the same thing" | Instructions and a file list for a Project, Cowork folder or `CLAUDE.md`, so new chats start with it |
| `token-check` | "How many tokens is this?" | A size estimate, what it costs over a conversation, and how to cut it |
| `sharpen-prompt` | "Improve this prompt" | The same request with goal, scope, constraints and what done looks like |

## In Claude Code

### Haiku subagents

| Agent | Model | Use |
|---|---|---|
| `context-optimizer:scout` | Haiku 5.5 | Read-only exploration of the project: several files, wide searches. Read, Grep and Glob only. Returns a short answer with `path:line`. |
| `context-optimizer:runner` | Haiku 5.5 | Test suites, builds, linters. Returns pass/fail and the failing items only. |

A one-paragraph policy at session start (about 90 tokens, once per
conversation) tells Claude when to hand work to them. Only their short answer
enters the expensive model's context. `/cco orchestrate <task>` runs a whole
task that way.

### `/cco`: one command for the rest

`/cco` alone shows the session board: budget, money spent and saved, waste,
the active task and what to do next. `/cco help` lists everything:

| See where the tokens go | Spend less | Settings and data |
|---|---|---|
| `/cco audit`: your own transcripts, where the money went, what CCO saved | `/cco orchestrate <task>`: Haiku does the reading and test runs | `/cco config`: thresholds |
| `/cco report`, `/cco roi`, `/cco digest`: trends across sessions | `/cco task`: cost per task, state that survives `/compact` | `/cco budget`: budget and auto-compact |
| `/cco replay`: recent sessions | `/cco pack <task>`: the files a task needs, with line ranges | `/cco export`: Markdown or an offline HTML page |
| `/cco tools`: what each tool costs | `/cco anatomy`, `/cco git`: a project map, git-aware context | `/cco patterns`: share learned patterns |
| `/cco overhead`: the fixed context every session starts with | `/cco claudemd`, `/cco shield`, `/cco coach`, `/cco templates` | `/cco clean`, `/cco doctor` |

### What runs on its own

- **Read dedup.** A re-read of a file that hasn't changed, in the same context,
  is skipped, with a map of the file's landmarks instead. A changed file, a
  new range, or a read after `/compact` goes through.
- **Budget and cache warnings** at 50/70/85/95% of the budget, and a note when
  a pause let the prompt cache go cold, with what that cost.
- **Task state across `/compact`.** A small execution state you keep with
  `/cco task` is put back into context after compaction.
- **A recap of the last session** in a project when you start the next one.
- **`.contextignore`** keeps files you never need out of reads.

## Does it really save?

We checked on real transcripts rather than guessing. In long Opus sessions
about 60% of the cost is cache reads: the whole context re-read on every
request. Repeated reads of unchanged files, which dedup removes, turned out to
be rare. So the levers that matter are a smaller context and a cheaper model
for the reading: the Haiku subagents, compacting at the right time, and not
letting the cache go cold on a big context. `/cco audit` shows what that
comes to in your own sessions, including what CCO's own messages cost.

---

## Installation

**claude.ai, the desktop app and Cowork:** open the Directory, search for
*Context Optimizer*, and add it.

**Claude Code**, from the plugin marketplace:

```bash
claude plugin marketplace add egorfedorov/claude-context-optimizer
claude plugin install context-optimizer@cco
```

Then restart Claude Code.

**From a clone**, to change the plugin and see it live:

```bash
git clone https://github.com/egorfedorov/claude-context-optimizer.git ~/claude-context-optimizer
claude --plugin-dir ~/claude-context-optimizer
```

### Updating

```bash
claude plugin marketplace update cco
claude plugin update context-optimizer@cco
```

### Upgrading from 4.x

- **Commands moved under `/cco`** in 5.0: `/cco-audit` is now `/cco audit`,
  `/cco-task` is `/cco task`, and so on. `/cco help` lists them.
- **The plugin was renamed** in 4.21 from `claude-context-optimizer` to
  `context-optimizer`, because Claude Code reserves the `claude-` prefix. Both
  marketplaces map the old name to the new one. If your install didn't move,
  reinstall once:

```bash
claude plugin uninstall claude-context-optimizer@cco
claude plugin marketplace update cco
claude plugin install context-optimizer@cco
```

Your history stays in `~/.claude-context-optimizer/`.

### Requirements

- Claude Code with plugin support; the live meter needs a version with plugin
  mods. Skills alone work on claude.ai and in Cowork.
- Node.js 18 or later for the hooks and `/cco`.
- A POSIX shell for hooks: macOS and Linux as they are, Git Bash or WSL on
  Windows.

## Settings

Everything lives in `~/.claude-context-optimizer/config.json`; `/cco config`
shows and changes it.

- `"orchestrate": false` turns off the session-start policy that sends work
  to the Haiku subagents.
- `"quiet": true` hides the donation line and the prompt coach.
- `thresholds` tunes the read-dedup and warning thresholds, each
  range-checked: `/cco config set staleTimeMs 300000`.

## Privacy

This plugin:

- **Tracks file paths and line counts**, never file contents
- **Keeps a 200-character preview of each prompt** (with its grade) so `/cco coach` can show trends
- **Reads token-usage numbers** from Claude Code's own session transcript to price the session; `/cco audit` reads your transcripts under `~/.claude/projects/` and prints only totals
- **Runs `git` locally** for `/cco git`, `/cco pack` and `/cco anatomy`; nothing else is executed
- **Stores everything locally** in `~/.claude-context-optimizer/`, pruned automatically (90 days for session history, 14 for live-session state)
- **Sends zero telemetry**: the plugin's own code makes no network calls, no analytics, no tracking
- **Reads no environment variables**: every setting lives in `~/.claude-context-optimizer/config.json`
- **The live meter** shows figures Claude Code already has, from inside Claude Code; it reads no files and sends nothing
- **Ships two subagents** (`scout`, `runner`) that Claude can call. They use Claude Code's own tools under your permission settings: `scout` only reads and searches the project (Read, Grep, Glob), and `runner` runs the commands it is given through Bash
- **`/cco export html` writes one offline file**: charts are inline SVG, with no scripts and nothing loaded from the web
- **Can be fully wiped** with `/cco clean --reset-all`

Your data never leaves your machine.

## FAQ

**Does it slow Claude Code down?**
Barely. Each hook event starts one Node process, about 50–65 ms, mostly Node's
own startup. Only Read triggers a hook before the tool runs. `/cco doctor`
shows the time on your machine. The meter runs inside Claude Code and costs
nothing per request.

**Which models does it know?**
Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, plus the earlier Claude 5 and
4.x models, each with its own window, prices and cache rates. The session's
real model is read from the transcript; `/cco budget model <name>` sets only
the fallback.

**Does the prompt coach call a model?**
No. It is local heuristics, under 5 ms per prompt, no API calls.

**Does it work with subagents?**
Yes. Hooks tell subagents apart by the hook's `agent_id`: each gets its own
read cache, and its reads never count as the main context's waste.

**Can read dedup break anything?**
It only skips a read of the same file, range and context with no change since.
If Claude repeats the read right after a skip, it goes through, in case its
copy was cleared.

**Where did the old "What's new" sections go?**
To [CHANGELOG.md](CHANGELOG.md), which has every release.

---

## Support Development

context-optimizer is **100% free and open source**. No paywalls, no premium tiers, no telemetry. If it saves you money on tokens, consider supporting development:

| Chain | Address |
|-------|---------|
| **BTC** | `bc1q428exz5t2h9rzk7z5ya70madh0j3rs6h4gfgyd` |
| **ETH (ERC-20)** | `0xB3f0C8e42B7cA9d65920cEfe82e3fef1B5C9d0C9` |
| **SOL** | `8ctK8nt3CBkPZGfWQXX8TsnqUYUy4JAbT1EMhr8rsQxm` |

---

## Contributing

PRs welcome. See [ROADMAP.md](ROADMAP.md) for what's planned and [CONTRIBUTING.md](CONTRIBUTING.md) for how to start. `npm test` runs the suite; `npm run test:engine` runs the meter's tests in Claude Code's own engine.

## Credits

GitHub's [contributors graph](https://github.com/egorfedorov/claude-context-optimizer/graphs/contributors) only counts commits, so the people who found the bugs don't appear in it. They should. Every entry below changed the tool:

| | Found | Shipped |
|---|---|---|
| **[@GesPacClinica](https://github.com/GesPacClinica)** | [#1](https://github.com/egorfedorov/claude-context-optimizer/issues/1) — the very first issue: a clean install on fresh Linux Mint crashed Node on every hook, because `npx skills add` puts `CLAUDE_PLUGIN_ROOT` somewhere with no `src/` | `fd5dc7e` — every hook now tests for the file before running it |
| **[@zwrose](https://github.com/zwrose)** | [#29](https://github.com/egorfedorov/claude-context-optimizer/pull/29) — `/cco report` crashed outright, and its cost table printed `$NaN` | sent the fix themselves, as a PR |
| **[@Reapper-Stack](https://github.com/Reapper-Stack)** | [#46](https://github.com/egorfedorov/claude-context-optimizer/issues/46) — on Windows every transcript lookup pointed at a malformed path, so `/cco overhead` always claimed "no transcripts found" — reported with the root cause | v4.7.0 Windows-correct paths |
| **[@harvest316](https://github.com/harvest316)** | [#53](https://github.com/egorfedorov/claude-context-optimizer/issues/53) — `/cco overhead mcp` told fresh installs to delete MCP servers it had never actually watched; the cold-start guard counted sessions, not evidence — reported with the root cause, the on-disk verification, and the fix | v4.9.1 |

A report that names the root cause is worth more than one that just names the symptom — #46 and #53 both arrived that way, and #29 arrived as the patch itself.

Found something? [Open an issue](https://github.com/egorfedorov/claude-context-optimizer/issues/new) — you'll end up on this list.

## License

MIT — do whatever you want with it.

---

<p align="center">
  <sub>Built with frustration at wasted tokens and love for efficiency.</sub><br/>
  <sub>If we saved you money, <a href="#support-development">return the favor</a>.</sub>
</p>
