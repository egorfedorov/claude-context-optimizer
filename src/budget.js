#!/usr/bin/env node

/**
 * Context Budget Monitor v3.0
 *
 * Tracks token accumulation during a session (input + estimated output) and
 * warns when approaching a configurable budget limit. Model-aware: uses the
 * effective context window for the configured model (e.g. 1M for opus-4.8).
 *
 * v3.0:
 *   - Tracks output tokens too (Edit/Write content size).
 *   - Cost calculation uses real input + output prices from MODEL_COSTS.
 *   - Effective budget honours model context window (avoids "50% used" at 50K
 *     when the actual window is 1M).
 */

import { join } from 'path';
import {
  BUDGET_STATE_DIR,
  formatTokens, loadConfig, getModelCost, getEffectiveBudget,
  displayPath, loadJSON, saveJSON, ensureDataDirs, loadBudgetConfig,
  estimateTokensFromString, isMainModule
} from './utils.js';
import { emitNotice } from './notices.js';

ensureDataDirs();

function loadBudgetState(sessionId) {
  const file = join(BUDGET_STATE_DIR, `${sessionId}.json`);
  return loadJSON(file) || {
    sessionId,
    totalTokensEstimated: 0,
    inputTokensEstimated: 0,
    outputTokensEstimated: 0,
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

/**
 * Estimate input + output tokens consumed by a tool call.
 * Returns { input, output }.
 */
function estimateToolTokens(toolName, toolInput) {
  switch (toolName) {
    case 'Read': {
      // Input = file contents echoed back into context.
      const lines = toolInput?.limit || 2000;
      return { input: Math.round((lines * 35) / 3.7), output: 0 };
    }
    case 'Edit': {
      const oldLen = (toolInput?.old_string || '').length;
      const newLen = (toolInput?.new_string || '').length;
      // Output: the new string Claude generated.
      return {
        input: Math.round(oldLen / 3.7) + 50,
        output: Math.round(newLen / 3.7) + 30
      };
    }
    case 'Write': {
      const contentLen = (toolInput?.content || '').length;
      // Pure output — Claude wrote the whole file.
      return { input: 30, output: Math.round(contentLen / 3.7) };
    }
    case 'Grep':
      return { input: 200, output: 50 };
    case 'Glob':
      return { input: 100, output: 30 };
    case 'Agent':
      // Subagents emit a summary back; estimate moderate output.
      return { input: 500, output: 1000 };
    default:
      // MCP and unknown tools — small default.
      if (toolName && toolName.startsWith('mcp__')) {
        return { input: 200, output: 300 };
      }
      return { input: 50, output: 50 };
  }
}

/**
 * Build a compact recommendation with specific files to drop.
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

function computeCost(state, model) {
  const cost = getModelCost(model);
  const inDollars = (state.inputTokensEstimated / 1_000_000) * cost.input;
  const outDollars = (state.outputTokensEstimated / 1_000_000) * cost.output;
  return inDollars + outDollars;
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

  const { input: inAdded, output: outAdded } = estimateToolTokens(toolName, toolInput);
  state.inputTokensEstimated += inAdded;
  state.outputTokensEstimated += outAdded;
  state.totalTokensEstimated = state.inputTokensEstimated + state.outputTokensEstimated;

  const filePath = toolInput?.file_path;
  if (filePath) {
    if (!state.filesLoaded[filePath]) {
      state.filesLoaded[filePath] = { tokens: 0, reads: 0, edits: 0 };
    }
    state.filesLoaded[filePath].tokens += inAdded;
    if (toolName === 'Read') state.filesLoaded[filePath].reads++;
    if (toolName === 'Edit' || toolName === 'Write') state.filesLoaded[filePath].edits++;
  }

  const effectiveBudget = getEffectiveBudget(config);
  const usagePercent = Math.round((state.totalTokensEstimated / effectiveBudget) * 100);

  // ── Threshold warnings (gated by the session noise budget) ────────────────
  // Only actionable signals reach Claude's context, and only a few per session.
  // 85%+ is critical (always shown, carries a /compact recommendation); the
  // early 50/70 nudges are 'normal' and may be suppressed once the cap is hit.
  for (const threshold of config.warnAt) {
    if (usagePercent >= threshold && !state.warningsSent.includes(threshold)) {
      state.warningsSent.push(threshold);

      const cost = computeCost(state, config.model);
      let msg = `[context-budget] ${usagePercent}% budget used (~${formatTokens(state.totalTokensEstimated)}/${formatTokens(effectiveBudget)})`;
      msg += ` | Cost: $${cost.toFixed(3)} (${config.model}: in ${formatTokens(state.inputTokensEstimated)} / out ${formatTokens(state.outputTokensEstimated)})`;

      if (threshold >= 85) {
        const rec = buildCompactRecommendation(state);
        if (rec) msg += '\n' + rec.message;
        else msg += ` | Consider /compact to free context`;
      }

      emitNotice(sessionId, {
        kind: `budget:${threshold}`,
        text: msg,
        priority: threshold >= 85 ? 'critical' : 'normal',
      });
    }
  }

  // ── Auto-compact directives ──────────────────────────────────────────────
  // These are the highest-value signals (they trigger an actual /compact that
  // frees real tokens), so they're 'critical' — always allowed past the cap.
  if (budgetConfig.autoCompactEnabled) {
    const { autoCompactThreshold, criticalThreshold } = budgetConfig;

    if (usagePercent >= criticalThreshold) {
      const tokensSinceCritical = state.totalTokensEstimated - (state.criticalSentAt || 0);
      if (tokensSinceCritical >= 5000 || !state.criticalSentAt) {
        state.criticalSentAt = state.totalTokensEstimated;
        const rec = buildCompactRecommendation(state);
        const reclaimMsg = rec ? ` Free ~${formatTokens(rec.reclaimableTokens)} tokens.` : '';
        emitNotice(sessionId, {
          kind: 'budget:critical',
          priority: 'critical',
          text:
            `[context-budget] CRITICAL: ${usagePercent}% budget used (~${formatTokens(state.totalTokensEstimated)}/${formatTokens(effectiveBudget)}). ` +
            `Run /compact immediately or the session will lose older context.${reclaimMsg}`,
        });
      }
    } else if (usagePercent >= autoCompactThreshold) {
      const tokensSinceAutoCompact = state.totalTokensEstimated - (state.autoCompactSentAt || 0);
      if (tokensSinceAutoCompact >= 10000 || !state.autoCompactSentAt) {
        state.autoCompactSentAt = state.totalTokensEstimated;
        const rec = buildCompactRecommendation(state);
        const reclaimMsg = rec ? ` Free ~${formatTokens(rec.reclaimableTokens)} tokens.` : '';
        emitNotice(sessionId, {
          kind: 'budget:autocompact',
          priority: 'critical',
          text:
            `[context-budget] Auto-compact recommended — ${usagePercent}% budget used. ` +
            `Run /compact now to free tokens and keep the session efficient.${reclaimMsg}`,
        });
      }
    }
  } else if (usagePercent >= config.autoCompactAt) {
    const tokensSinceLast = state.totalTokensEstimated - (state.lastCompactSuggestAt || 0);
    if (tokensSinceLast >= 10000) {
      state.lastCompactSuggestAt = state.totalTokensEstimated;
      const rec = buildCompactRecommendation(state);
      if (rec && rec.reclaimableTokens > 5000) {
        emitNotice(sessionId, {
          kind: 'budget:still',
          priority: 'critical',
          text: `[context-budget] Still at ${usagePercent}% — run /compact to reclaim ~${formatTokens(rec.reclaimableTokens)} tokens`,
        });
      }
    }
  }

  // Note: the "CCO makes your budget Nx more effective" brag was removed — it
  // was pure FYI that spent context to praise itself. The /cco dashboard now
  // reports NET savings (saved − the optimizer's own injected tokens) instead.

  saveBudgetState(state);
  process.exit(0);
}

// Run the hook only when executed directly — importing for tests must not read stdin.
if (isMainModule(import.meta.url)) main().catch(() => process.exit(0));

// Exposed for tests
export { estimateToolTokens, buildCompactRecommendation, computeCost };
