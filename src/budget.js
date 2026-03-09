#!/usr/bin/env node

/**
 * Context Budget Monitor
 *
 * Tracks token accumulation during a session and warns
 * when approaching a configurable budget limit.
 * Runs as a PostToolUse hook — checks cumulative tokens after each Read.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
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
    budgetTokens: 100000,       // default 100K token budget per session
    warnAt: [50, 70, 85, 95],   // warn at these percentages
    autoCompactAt: 90,          // suggest /compact at this %
    model: 'opus'               // for cost estimation
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

function estimateTokensFromLines(lines) {
  return Math.round(lines * 4);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) {
    process.exit(0);
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  if (event.hook_event_name !== 'PostToolUse') {
    process.exit(0);
  }

  const toolName = event.tool_name || '';
  if (toolName !== 'Read') {
    process.exit(0);
  }

  const sessionId = event.session_id || 'unknown';
  const config = loadConfig();
  const state = loadBudgetState(sessionId);

  const filePath = event.tool_input?.file_path || '';
  const lineLimit = event.tool_input?.limit || 2000;

  const tokensAdded = estimateTokensFromLines(lineLimit);
  state.totalTokensEstimated += tokensAdded;

  if (!state.filesLoaded[filePath]) {
    state.filesLoaded[filePath] = { tokens: 0, reads: 0 };
  }
  state.filesLoaded[filePath].tokens += tokensAdded;
  state.filesLoaded[filePath].reads++;

  const usagePercent = Math.round((state.totalTokensEstimated / config.budgetTokens) * 100);

  // Check if we need to warn
  for (const threshold of config.warnAt) {
    if (usagePercent >= threshold && !state.warningsSent.includes(threshold)) {
      state.warningsSent.push(threshold);

      const costs = {
        haiku: (state.totalTokensEstimated / 1000000) * 0.25,
        sonnet: (state.totalTokensEstimated / 1000000) * 3,
        opus: (state.totalTokensEstimated / 1000000) * 15
      };

      let msg = `[context-budget] ${usagePercent}% of token budget used (~${formatTokens(state.totalTokensEstimated)}/${formatTokens(config.budgetTokens)})`;

      if (usagePercent >= config.autoCompactAt) {
        msg += ` | Consider running /compact to free context`;
      }

      msg += ` | Est. cost: $${costs[config.model].toFixed(3)} (${config.model})`;

      // Output warning to stderr (shown as hook feedback)
      console.error(msg);
    }
  }

  saveBudgetState(state);
  process.exit(0);
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

main().catch(() => process.exit(0));
