#!/usr/bin/env node

/**
 * Context Budget Monitor v2.0
 *
 * Tracks token accumulation during a session and warns
 * when approaching a configurable budget limit.
 * Now handles ALL tool types (Read, Edit, Write, Glob, Grep, Agent),
 * and provides smart compact recommendations with specific files to drop.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.claude-context-optimizer');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const BUDGET_STATE_DIR = join(DATA_DIR, 'budget');

mkdirSync(BUDGET_STATE_DIR, { recursive: true });

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return {
    budgetTokens: 100000,
    warnAt: [50, 70, 85, 95],
    autoCompactAt: 90,
    model: 'opus'
  };
}

function loadBudgetState(sessionId) {
  const file = join(BUDGET_STATE_DIR, `${sessionId}.json`);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf-8'));
  }
  return {
    sessionId,
    totalTokensEstimated: 0,
    warningsSent: [],
    filesLoaded: {},
    startedAt: new Date().toISOString()
  };
}

function saveBudgetState(state) {
  const file = join(BUDGET_STATE_DIR, `${state.sessionId}.json`);
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const MODEL_COSTS = {
  haiku: 0.25,
  sonnet: 3,
  opus: 15
};

function estimateToolTokens(toolName, toolInput) {
  switch (toolName) {
    case 'Read': {
      const lines = toolInput?.limit || 2000;
      // ~35 chars per line / ~3.7 chars per token
      return Math.round((lines * 35) / 3.7);
    }
    case 'Edit': {
      // old_string + new_string context
      const oldLen = (toolInput?.old_string || '').length;
      const newLen = (toolInput?.new_string || '').length;
      return Math.round((oldLen + newLen) / 3.7) + 50; // +50 for metadata
    }
    case 'Write': {
      const contentLen = (toolInput?.content || '').length;
      return Math.round(contentLen / 3.7) + 30;
    }
    case 'Grep': {
      // Estimate based on typical result size: ~3 tokens per result line
      return 200; // conservative base estimate
    }
    case 'Glob': {
      // File paths: ~3 tokens each, typical 10-30 results
      return 100;
    }
    case 'Agent': {
      // Agent calls consume significant context
      return 500;
    }
    default:
      return 50; // minimal overhead for unknown tools
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) process.exit(0);

  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }

  if (event.hook_event_name !== 'PostToolUse') process.exit(0);

  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};
  const sessionId = event.session_id || 'unknown';
  const config = loadConfig();
  const state = loadBudgetState(sessionId);

  // Estimate tokens for this tool call
  const tokensAdded = estimateToolTokens(toolName, toolInput);
  state.totalTokensEstimated += tokensAdded;

  // Track per-file for Read/Edit/Write
  const filePath = toolInput?.file_path;
  if (filePath) {
    if (!state.filesLoaded[filePath]) {
      state.filesLoaded[filePath] = { tokens: 0, reads: 0, edits: 0 };
    }
    state.filesLoaded[filePath].tokens += tokensAdded;
    if (toolName === 'Read') state.filesLoaded[filePath].reads++;
    if (toolName === 'Edit' || toolName === 'Write') state.filesLoaded[filePath].edits++;
  }

  const usagePercent = Math.round((state.totalTokensEstimated / config.budgetTokens) * 100);

  for (const threshold of config.warnAt) {
    if (usagePercent >= threshold && !state.warningsSent.includes(threshold)) {
      state.warningsSent.push(threshold);

      const cost = (state.totalTokensEstimated / 1000000) * (MODEL_COSTS[config.model] || 15);

      let msg = `[context-budget] ${usagePercent}% budget used (~${formatTokens(state.totalTokensEstimated)}/${formatTokens(config.budgetTokens)})`;
      msg += ` | Est. cost: $${cost.toFixed(3)} (${config.model})`;

      // Smart compact: at 90%+, list specific files that can be dropped
      if (usagePercent >= config.autoCompactAt) {
        const droppable = Object.entries(state.filesLoaded)
          .filter(([, d]) => d.reads > 0 && d.edits === 0) // read but never edited
          .sort((a, b) => b[1].tokens - a[1].tokens)
          .slice(0, 3);

        if (droppable.length > 0) {
          const reclaimable = droppable.reduce((sum, [, d]) => sum + d.tokens, 0);
          msg += `\n[context-budget] Reclaimable files (read-only, 0 edits):`;
          for (const [path, d] of droppable) {
            msg += `\n  - ${basename(path)} (~${formatTokens(d.tokens)}, ${d.reads} reads)`;
          }
          msg += `\n  Total reclaimable: ~${formatTokens(reclaimable)} | Run /compact`;
        } else {
          msg += ` | Consider /compact to free context`;
        }
      }

      console.error(msg);
    }
  }

  saveBudgetState(state);
  process.exit(0);
}

main().catch(() => process.exit(0));
