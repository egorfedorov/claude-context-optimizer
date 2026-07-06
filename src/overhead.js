#!/usr/bin/env node

/**
 * Session Baseline Overhead audit — /cco-overhead
 *
 * The biggest invisible token spend isn't redundant reads — it's the FIXED
 * overhead every session starts with: system prompt, tool schemas, MCP
 * servers, agent lists, CLAUDE.md, memory. You pay it before typing a word,
 * and again in every session.
 *
 * This tool measures it from ground truth: the first assistant message of a
 * session transcript carries exact API usage — that's the context loaded
 * before any work happened. It then itemizes the parts that are measurable
 * locally (CLAUDE.md files, memory index, agent definitions) and labels the
 * rest "system prompt & tools (unattributed)".
 *
 * Usage:
 *   node src/overhead.js [transcript.jsonl]   # specific transcript
 *   node src/overhead.js                      # last 10 sessions of this project
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  SESSIONS_DIR,
  formatTokens, estimateTokensFromString, loadConfig, getModelCost,
  getEffectiveBudget, CACHE_WRITE_MULT, isMainModule, getDonationMessage,
} from './utils.js';

// ── Pure parsing (exported for tests) ───────────────────────────────────────

/**
 * Baseline = context present at the FIRST assistant response: system prompt,
 * tools, CLAUDE.md, memory, and the user's opening prompt. Exact API counts.
 */
export function parseBaselineFromLines(lines) {
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const u = obj && obj.message && obj.message.usage;
    if (u && typeof u.input_tokens === 'number') {
      return (u.input_tokens || 0) +
             (u.cache_read_input_tokens || 0) +
             (u.cache_creation_input_tokens || 0);
    }
  }
  return null;
}

// ── Transcript discovery ─────────────────────────────────────────────────────

/** Claude Code stores transcripts under ~/.claude/projects/<munged-cwd>/. */
export function projectTranscriptDir(cwd) {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

function recentTranscripts(cwd, limit = 10) {
  const dir = projectTranscriptDir(cwd);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(t => t.path);
  } catch {
    return [];
  }
}

function baselineOf(transcriptPath) {
  try {
    // Baseline lives at the head of the file — 512KB is plenty.
    const buf = readFileSync(transcriptPath, 'utf-8').slice(0, 512 * 1024);
    return parseBaselineFromLines(buf.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

// ── Locally measurable overhead sources ──────────────────────────────────────

function tokensOfFile(path, ext = '.md') {
  try {
    if (!existsSync(path)) return 0;
    return estimateTokensFromString(readFileSync(path, 'utf-8'), ext);
  } catch { return 0; }
}

function tokensOfAgentDir(dir) {
  // Agent frontmatter (name + description) is what lands in the system prompt.
  let tokens = 0, count = 0;
  try {
    if (!existsSync(dir)) return { tokens, count };
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const content = readFileSync(join(dir, f), 'utf-8');
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      tokens += estimateTokensFromString(fm ? fm[1] : content.slice(0, 2000));
      count++;
    }
  } catch { /* best-effort */ }
  return { tokens, count };
}

export function measureLocalSources(cwd) {
  const home = homedir();
  const items = [];

  const add = (label, tokens, hint) => {
    if (tokens > 0) items.push({ label, tokens, hint });
  };

  add('Project CLAUDE.md', tokensOfFile(join(cwd, 'CLAUDE.md')),
    'trim with /cco-claudemd');
  add('Global ~/.claude/CLAUDE.md', tokensOfFile(join(home, '.claude', 'CLAUDE.md')),
    'loaded in EVERY project — keep it minimal');
  add('Memory index (MEMORY.md)',
    tokensOfFile(join(projectTranscriptDir(cwd), 'memory', 'MEMORY.md')),
    'one line per memory is the rule');

  const projAgents = tokensOfAgentDir(join(cwd, '.claude', 'agents'));
  add(`Project agents (${projAgents.count})`, projAgents.tokens,
    'each agent description is in every system prompt');
  const userAgents = tokensOfAgentDir(join(home, '.claude', 'agents'));
  add(`User agents (${userAgents.count})`, userAgents.tokens,
    'disable agents you never invoke');

  return items;
}

// ── Report ───────────────────────────────────────────────────────────────────

export function buildReport(cwd, transcriptArg) {
  const config = loadConfig();
  const model = config.model || 'opus-4.8';
  const cost = getModelCost(model);
  const budget = getEffectiveBudget(config);

  const transcripts = transcriptArg ? [transcriptArg] : recentTranscripts(cwd);
  const baselines = transcripts
    .map(p => ({ path: p, baseline: baselineOf(p) }))
    .filter(b => b.baseline && b.baseline > 0);

  const L = [];
  L.push('');
  L.push('  SESSION BASELINE OVERHEAD');
  L.push('  ' + '─'.repeat(60));

  if (!baselines.length) {
    L.push('  No session transcripts found for this project yet.');
    L.push(`  Looked in: ${projectTranscriptDir(cwd)}`);
    L.push('  Start a session, do one exchange, then run /cco-overhead again.');
    return L.join('\n');
  }

  const latest = baselines[0].baseline;
  const avg = Math.round(baselines.reduce((s, b) => s + b.baseline, 0) / baselines.length);
  const pctOfBudget = Math.round((avg / budget) * 100);
  // Every session writes the baseline into cache once at the 1.25× rate.
  const perSession = (avg / 1e6) * cost.input * CACHE_WRITE_MULT;

  L.push(`  Latest session started at   ${formatTokens(latest)} tokens before any work`);
  L.push(`  Average over ${String(baselines.length).padStart(2)} session(s)   ${formatTokens(avg)} tokens  (${pctOfBudget}% of your ${formatTokens(budget)} budget)`);
  L.push(`  Cost per session            ~$${perSession.toFixed(3)} written to cache (${model})`);
  L.push('');

  const items = measureLocalSources(cwd).sort((a, b) => b.tokens - a.tokens);
  const itemized = items.reduce((s, i) => s + i.tokens, 0);
  const unattributed = Math.max(0, avg - itemized);

  L.push('  Where it goes (locally measurable):');
  for (const i of items) {
    L.push(`    ${i.label.padEnd(30)} ~${formatTokens(i.tokens).padStart(7)}   ${i.hint}`);
  }
  L.push(`    ${'System prompt, tools & MCP'.padEnd(30)} ~${formatTokens(unattributed).padStart(7)}   check /context; disable unused MCP servers`);
  L.push('');

  // ── Recommendations ──
  const recs = [];
  const claudeMd = items.find(i => i.label === 'Project CLAUDE.md');
  if (claudeMd && claudeMd.tokens > 3000) {
    recs.push(`Project CLAUDE.md is ~${formatTokens(claudeMd.tokens)} — run /cco-claudemd to trim it.`);
  }
  if (unattributed > 40_000) {
    recs.push(`~${formatTokens(unattributed)} is system prompt/tools/MCP — run /context in a fresh session ` +
      `to see the breakdown, and disable MCP servers you don't use here.`);
  }
  if (pctOfBudget > 30) {
    recs.push(`Baseline eats ${pctOfBudget}% of your working budget before you type — every trim here repays in EVERY session.`);
  }
  if (recs.length) {
    L.push('  Recommendations:');
    for (const r of recs) L.push(`    • ${r}`);
  } else {
    L.push('  ✅ Baseline is lean for this model and budget.');
  }
  L.push(getDonationMessage());
  return L.join('\n');
}

// ── MCP usage audit: observation → the exact removal command ────────────────
// Every configured MCP server ships its tool schemas into the session baseline
// whether you use it or not. The tracker already records every mcp__* call, so
// we can name the servers that took up space and were never called — and print
// the exact `claude mcp remove` for each.

/** All configured MCP servers with the scope they're defined in. Pure-ish. */
export function collectConfiguredMcpServers(cwd, home = homedir()) {
  const out = [];
  const seen = new Set();
  const add = (name, scope) => {
    const key = `${name}`;
    if (!seen.has(key)) { seen.add(key); out.push({ name, scope }); }
  };
  try {
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'));
    for (const name of Object.keys(cfg.mcpServers || {})) add(name, 'user');
    const proj = (cfg.projects || {})[cwd];
    for (const name of Object.keys((proj && proj.mcpServers) || {})) add(name, 'local');
  } catch { /* no global config */ }
  try {
    const mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8'));
    for (const name of Object.keys(mcp.mcpServers || {})) add(name, 'project');
  } catch { /* no project .mcp.json */ }
  return out;
}

/** Sum mcp__<server>__* calls across tracked sessions newer than sinceMs. */
export function aggregateMcpUsage(sessionsDir = SESSIONS_DIR, sinceMs = Date.now() - 30 * 86400_000) {
  const usage = {};
  let sessions = 0;
  try {
    for (const f of readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
      const p = join(sessionsDir, f);
      try {
        if (statSync(p).mtimeMs < sinceMs) continue;
        const s = JSON.parse(readFileSync(p, 'utf-8'));
        sessions++;
        for (const [tool, d] of Object.entries(s.tools || {})) {
          if (!tool.startsWith('mcp__')) continue;
          const server = tool.split('__')[1] || '';
          if (server) usage[server] = (usage[server] || 0) + (d.calls || 0);
        }
      } catch { /* skip unreadable session */ }
    }
  } catch { /* no sessions dir */ }
  return { usage, sessions };
}

/** Split configured servers into used/unused given observed calls. Pure. */
export function splitMcpByUsage(configured, usage) {
  const used = [], unused = [];
  for (const srv of configured) {
    const calls = usage[srv.name] || 0;
    (calls > 0 ? used : unused).push({ ...srv, calls });
  }
  used.sort((a, b) => b.calls - a.calls);
  return { used, unused };
}

export function buildMcpReport(cwd) {
  const configured = collectConfiguredMcpServers(cwd);
  const { usage, sessions } = aggregateMcpUsage();
  const { used, unused } = splitMcpByUsage(configured, usage);

  const L = [];
  L.push('');
  L.push('  MCP SERVER USAGE — last 30 days');
  L.push('  ' + '─'.repeat(60));
  if (!configured.length) {
    L.push('  No MCP servers configured (checked ~/.claude.json and ./.mcp.json).');
    return L.join('\n');
  }
  L.push(`  ${configured.length} server(s) configured · evidence from ${sessions} tracked session(s)`);
  L.push('');
  for (const s of used) {
    L.push(`    ✔ ${s.name.padEnd(28)} ${String(s.calls).padStart(6)} calls   (${s.scope})`);
  }
  for (const s of unused) {
    L.push(`    ✖ ${s.name.padEnd(28)}      0 calls   (${s.scope}) — schemas still load every session`);
  }
  if (unused.length && sessions >= 5) {
    L.push('');
    L.push('  Fix — remove what you never call (each removal repays in EVERY session):');
    for (const s of unused) {
      L.push(`    claude mcp remove "${s.name}" -s ${s.scope}`);
    }
    L.push('  (re-add any time with `claude mcp add`)');
  } else if (unused.length) {
    L.push('');
    L.push(`  Only ${sessions} tracked session(s) so far — verdicts firm up at 5+. Re-run later.`);
  } else {
    L.push('');
    L.push('  ✅ Every configured server was actually used. Nothing to trim.');
  }
  return L.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const arg = process.argv[2];
  if (arg === 'mcp') {
    console.log(buildMcpReport(process.cwd()));
    return;
  }
  console.log(buildReport(process.cwd(), arg));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[cco] overhead error: ${e.message}`); process.exit(0); }
}
