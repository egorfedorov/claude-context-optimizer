#!/usr/bin/env node

/**
 * Context Budget Monitor v2.2
 *
 * Tracks token accumulation during a session and warns
 * when approaching a configurable budget limit.
 * Auto-compact: at configurable thresholds (default 80%/90%) outputs
 * strong directive messages that prompt Claude to run /compact.
 * Incremental warnings: every 5K tokens after critical threshold shows updated recommendations.
 */

import { join, basename } from 'path';
import {
  BUDGET_STATE_DIR, SESSIONS_DIR,
  formatTokens, loadConfig, MODEL_COSTS, displayPath,
  loadJSON, saveJSON, ensureDataDirs, loadBudgetConfig
} from './utils.js';

ensureDataDirs();

function loadBudgetState(sessionId) {
  const file = join(BUDGET_STATE_DIR, `${sessionId}.json`);
  return loadJSON(file) || {
    sessionId,
    totalTokensEstimated: 0,
    warningsSent: [],
    filesLoaded: {},
    compactSuggested: false,
    lastCompactSuggestAt: 0,
    autoCompactSentAt: 0,
    criticalSentAt: 0,
    startedAt: new Date().toISOString()
  };
}

function saveBudgetState(state) {
  const file = join(BUDGET_STATE_DIR, `${state.sessionId}.json`);
  saveJSON(file, state);
}

function estimateToolTokens(toolName, toolInput) {
  switch (toolName) {
    case 'Read': {
      const lines = toolInput?.limit || 2000;
      return Math.round((lines * 35) / 3.7);
    }
    case 'Edit': {
      const oldLen = (toolInput?.old_string || '').length;
      const newLen = (toolInput?.new_string || '').length;
      return Math.round((oldLen + newLen) / 3.7) + 50;
    }
    case 'Write': {
      const contentLen = (toolInput?.content || '').length;
      return Math.round(contentLen / 3.7) + 30;
    }
    case 'Grep':
      return 200;
    case 'Glob':
      return 100;
    case 'Agent':
      return 500;
    default:
      return 50;
  }
}

/**
 * Build a compact recommendation with specific files to drop.
 * Returns { message, reclaimableTokens, files[] }
 */
function buildCompactRecommendation(state) {
  const droppable = Object.entries(state.filesLoaded)
    .filter(([, d]) => d.reads > 0 && d.edits === 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 5);

  if (droppable.length === 0) return null;

  const reclaimable = droppable.reduce((sum, [, d]) => sum + d.tokens, 0);
  let msg = `[context-budget] You can free ~${formatTokens(reclaimable)} tokens with /compact:`;
  for (const [path, d] of droppable) {
    msg += `\n  drop ${displayPath(path, 40)} (~${formatTokens(d.tokens)}, ${d.reads} reads, 0 edits)`;
  }

  return { message: msg, reclaimableTokens: reclaimable, files: droppable.map(([p]) => p) };
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
  const budgetConfig = loadBudgetConfig();
  const state = loadBudgetState(sessionId);

  const tokensAdded = estimateToolTokens(toolName, toolInput);
  state.totalTokensEstimated += tokensAdded;

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

  // Standard threshold warnings
  for (const threshold of config.warnAt) {
    if (usagePercent >= threshold && !state.warningsSent.includes(threshold)) {
      state.warningsSent.push(threshold);

      const cost = (state.totalTokensEstimated / 1000000) * (MODEL_COSTS[config.model] || 15);
      let msg = `[context-budget] ${usagePercent}% budget used (~${formatTokens(state.totalTokensEstimated)}/${formatTokens(config.budgetTokens)})`;
      msg += ` | Est. cost: $${cost.toFixed(3)} (${config.model})`;

      // At 85%+, show compact recommendation
      if (threshold >= 85) {
        const rec = buildCompactRecommendation(state);
        if (rec) {
          msg += '\n' + rec.message;
        } else {
          msg += ` | Consider /compact to free context`;
        }
      }

      console.error(msg);
    }
  }

  // ── Auto-compact directives ──────────────────────────────────────────────
  if (budgetConfig.autoCompactEnabled) {
    const { autoCompactThreshold, criticalThreshold } = budgetConfig;

    // Critical threshold (default 90%): urgent directive, repeats every 5K tokens
    if (usagePercent >= criticalThreshold) {
      const tokensSinceCritical = state.totalTokensEstimated - (state.criticalSentAt || 0);
      if (tokensSinceCritical >= 5000 || !state.criticalSentAt) {
        state.criticalSentAt = state.totalTokensEstimated;
        const rec = buildCompactRecommendation(state);
        const reclaimMsg = rec ? ` Free ~${formatTokens(rec.reclaimableTokens)} tokens.` : '';
        console.error(
          `[context-budget] CRITICAL: ${usagePercent}% budget used (~${formatTokens(state.totalTokensEstimated)}/${formatTokens(config.budgetTokens)}). ` +
          `Run /compact immediately or the session will lose older context.${reclaimMsg}`
        );
      }
    }
    // Auto-compact threshold (default 80%): strong recommendation, repeats every 10K tokens
    else if (usagePercent >= autoCompactThreshold) {
      const tokensSinceAutoCompact = state.totalTokensEstimated - (state.autoCompactSentAt || 0);
      if (tokensSinceAutoCompact >= 10000 || !state.autoCompactSentAt) {
        state.autoCompactSentAt = state.totalTokensEstimated;
        const rec = buildCompactRecommendation(state);
        const reclaimMsg = rec ? ` Free ~${formatTokens(rec.reclaimableTokens)} tokens.` : '';
        console.error(
          `[context-budget] Auto-compact recommended — ${usagePercent}% budget used. ` +
          `Run /compact now to free tokens and keep the session efficient.${reclaimMsg}`
        );
      }
    }
  }
  // Legacy fallback: original incremental compact reminders when auto-compact is disabled
  else if (usagePercent >= config.autoCompactAt) {
    const tokensSinceLast = state.totalTokensEstimated - (state.lastCompactSuggestAt || 0);
    if (tokensSinceLast >= 10000) {
      state.lastCompactSuggestAt = state.totalTokensEstimated;
      const rec = buildCompactRecommendation(state);
      if (rec && rec.reclaimableTokens > 5000) {
        console.error(`[context-budget] Still at ${usagePercent}% — run /compact to reclaim ~${formatTokens(rec.reclaimableTokens)} tokens`);
      }
    }
  }

  saveBudgetState(state);
  process.exit(0);
}

main().catch(() => process.exit(0));
