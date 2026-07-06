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

import { join, extname } from 'path';
import { statSync } from 'fs';
import {
  BUDGET_STATE_DIR,
  formatTokens, loadConfig, getModelCost, getEffectiveBudget,
  displayPath, loadJSON, saveJSON, ensureDataDirs, loadBudgetConfig,
  estimateTokens, isMainModule, getCalibrationFactor, normalizeModelId,
  CACHE_WRITE_MULT, CACHE_READ_MULT
} from './utils.js';
import { emitNotice } from './notices.js';
import { readRealUsage } from './transcript-usage.js';

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
      // Input = file contents echoed back into context. Cap the assumed line
      // count by the file's real size (a full read of a 40-line file is 40
      // lines, not the 2000-line default) and use the extension-aware ratio.
      let lines = toolInput?.limit || 2000;
      const fp = toolInput?.file_path || '';
      try {
        const sizeLines = Math.ceil(statSync(fp).size / 36); // ~35 chars + newline
        lines = Math.min(lines, Math.max(1, sizeLines));
      } catch { /* deleted/unreadable — keep default */ }
      return { input: estimateTokens(lines, extname(fp)), output: 0 };
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
    case 'Bash':
      // Command echo + typical output; real size comes from tool_response below.
      return { input: 300, output: 20 };
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

  const est = estimateToolTokens(toolName, toolInput);
  // GROUND TRUTH per tool call: PostToolUse carries the actual tool_response
  // that just entered the context — its real size beats any stat-based guess
  // (and covers Bash/MCP output, which estimation can't see at all).
  let respTokens = 0;
  if (event.tool_response !== undefined) {
    try {
      const respText = typeof event.tool_response === 'string'
        ? event.tool_response : JSON.stringify(event.tool_response);
      respTokens = Math.round((respText || '').length / 4);
    } catch { /* keep estimate */ }
  }
  // Self-calibration: sessions with transcript ground truth teach the local
  // real/estimated drift (see utils.updateCalibrationFromSession). Input-side
  // only — output estimates already come from exact string lengths.
  const inAdded = respTokens > 0 ? respTokens : Math.round(est.input * getCalibrationFactor());
  const outAdded = est.output;

  // A single huge tool result is the #1 avoidable context burn. Nudge once per
  // occurrence with the concrete fix for that tool.
  if (respTokens >= 10_000) {
    const fix = toolName === 'Read'
      ? 'read with offset/limit or Grep the file instead'
      : toolName === 'Bash'
        ? 'pipe through tail/head/grep next time'
        : 'narrow the query';
    emitNotice(sessionId, {
      kind: 'budget:bigresult',
      text: `[context-budget] ${toolName} result was ~${formatTokens(respTokens)} tokens — ${fix}.`,
      priority: 'normal',
    });
  }
  state.inputTokensEstimated += inAdded;
  state.outputTokensEstimated += outAdded;
  state.totalTokensEstimated = state.inputTokensEstimated + state.outputTokensEstimated;

  const filePath = toolInput?.file_path;
  if (filePath) {
    if (!state.filesLoaded[filePath]) {
      // Cap the map: the whole state file is rewritten on every tool call, so
      // unbounded growth makes long sessions O(n²). Evict the coldest file.
      const keys = Object.keys(state.filesLoaded);
      if (keys.length >= 500) {
        const coldest = keys.reduce((min, k) =>
          state.filesLoaded[k].tokens < state.filesLoaded[min].tokens ? k : min, keys[0]);
        delete state.filesLoaded[coldest];
      }
      state.filesLoaded[filePath] = { tokens: 0, reads: 0, edits: 0 };
    }
    state.filesLoaded[filePath].tokens += inAdded;
    if (toolName === 'Read') state.filesLoaded[filePath].reads++;
    if (toolName === 'Edit' || toolName === 'Write') state.filesLoaded[filePath].edits++;
  }

  // Prefer GROUND TRUTH from the session transcript (exact API usage counts)
  // over the chars-per-token estimate. Estimation stays as the fallback.
  const real = readRealUsage(event.transcript_path);
  if (real && real.contextTokens > 0) {
    state.realContextTokens = real.contextTokens;
  }
  // The session's REAL model (from the transcript) — window and pricing follow
  // it automatically, whatever /model the user picked (fable, opus, haiku…).
  if (real && real.model) state.model = real.model;
  // Remember where the transcript lives so the dashboard (a plain CLI with no
  // hook event) can compute full-session cache economics on demand.
  if (event.transcript_path) state.transcriptPath = event.transcript_path;

  const sessionModel = normalizeModelId(state.model) || config.model;
  const effectiveBudget = getEffectiveBudget(config, state.model);

  // ── Cache-break guard ──────────────────────────────────────────────────────
  // The prompt cache lives 5 minutes. A longer pause with a warm context means
  // the whole cached prefix was just re-billed at the 1.25× write rate instead
  // of 0.1× reads — the single biggest avoidable dollar leak. We can't stop a
  // break that already happened, but naming its real cost teaches the habit:
  // batch pauses, /compact (or finish) before stepping away.
  const nowMs = Date.now();
  if (state.lastEventAt && (state.realContextTokens || 0) >= 20_000) {
    const gapMin = (nowMs - state.lastEventAt) / 60_000;
    if (gapMin >= 5) {
      const rate = getModelCost(sessionModel).input / 1e6;
      const lost = state.realContextTokens * rate * (CACHE_WRITE_MULT - CACHE_READ_MULT);
      state.cacheBreaks = (state.cacheBreaks || 0) + 1;
      emitNotice(sessionId, {
        kind: `budget:cachebreak:${state.cacheBreaks}`,
        text:
          `[context-budget] ~${Math.round(gapMin)} min pause — the prompt cache (5-min TTL) went cold; ` +
          `re-warming ${formatTokens(state.realContextTokens)} of context costs ~$${lost.toFixed(2)} extra. ` +
          `Batch pauses: finish the task first, or /compact before a long break.`,
      });
    }
  }
  state.lastEventAt = nowMs;
  const contextNow = state.realContextTokens || state.totalTokensEstimated;
  const usagePercent = Math.round((contextNow / effectiveBudget) * 100);

  // ── Context-rot zone (quality, not capacity) ──────────────────────────────
  // On 1M-window models intelligence degrades well before the window fills —
  // community consensus puts the "dumb zone" at ~300–400K tokens. Budget-%
  // warnings (50/70/85) never fire that early on 1M, so this is a separate,
  // one-shot quality signal.
  const window = getModelCost(sessionModel).contextWindow;
  if (window >= 1_000_000 && contextNow >= 350_000 && !state.rotWarned) {
    state.rotWarned = true;
    const rec = buildCompactRecommendation(state);
    emitNotice(sessionId, {
      kind: 'budget:rot',
      priority: 'critical',
      text:
        `[context-budget] ${formatTokens(contextNow)} in context — entering the degradation zone (~300-400K on 1M models: ` +
        `quality drops long before the window fills). Prefer /compact focused on the current task, or finish and start fresh.` +
        (rec ? ` Free ~${formatTokens(rec.reclaimableTokens)} now: /compact.` : ''),
    });
  }

  // ── Threshold warnings (gated by the session noise budget) ────────────────
  // Only actionable signals reach Claude's context, and only a few per session.
  // 85%+ is critical (always shown, carries a /compact recommendation); the
  // early 50/70 nudges are 'normal' and may be suppressed once the cap is hit.
  for (const threshold of config.warnAt) {
    if (usagePercent >= threshold && !state.warningsSent.includes(threshold)) {
      state.warningsSent.push(threshold);

      const cost = computeCost(state, sessionModel);
      const src = state.realContextTokens ? '' : '~';
      let msg = `[context-budget] ${usagePercent}% budget used (${src}${formatTokens(contextNow)}/${formatTokens(effectiveBudget)})`;
      msg += ` | Cost: $${cost.toFixed(3)} (${sessionModel}: in ${formatTokens(state.inputTokensEstimated)} / out ${formatTokens(state.outputTokensEstimated)})`;

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
            `[context-budget] CRITICAL: ${usagePercent}% budget used (${formatTokens(contextNow)}/${formatTokens(effectiveBudget)}). ` +
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
