#!/usr/bin/env node

/**
 * Smart Read Cache — Retroactive Savings Simulator
 *
 * Analyzes existing session data and calculates how many tokens
 * the read-cache WOULD HAVE saved if it had been active.
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { SESSIONS_DIR, formatTokens, loadJSON } from './utils.js';

function loadSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => loadJSON(join(SESSIONS_DIR, f)))
    .filter(s => s && s.files && Object.keys(s.files).length > 0);
}

function analyzeSession(session) {
  let totalTokens = 0;
  let savedTokens = 0;
  let redundantReads = 0;
  const fileSavings = [];

  for (const [filePath, f] of Object.entries(session.files)) {
    const tokens = f.estTokens || 0;
    const fullReads = f.fullReads || 0;
    const edits = f.edits || 0;
    const reads = f.reads || 0;

    totalTokens += tokens * reads;

    // First read always allowed. Each edit invalidates cache, so next read is allowed.
    const allowedReads = f.wasEdited ? 1 + edits : 1;
    const redundant = Math.max(0, fullReads - allowedReads);

    if (redundant > 0) {
      const saved = redundant * tokens;
      savedTokens += saved;
      redundantReads += redundant;
      fileSavings.push({ path: filePath, reads, redundant, saved, tokens });
    }
  }

  return { totalTokens, savedTokens, redundantReads, fileSavings };
}

function run() {
  const sessions = loadSessions();

  if (sessions.length === 0) {
    console.log('No session data found. Use Claude Code to generate tracking data first.');
    return;
  }

  let grandTotalTokens = 0;
  let grandSavedTokens = 0;
  let grandRedundantReads = 0;
  const sessionResults = [];
  const globalFiles = new Map();

  for (const session of sessions) {
    const result = analyzeSession(session);
    grandTotalTokens += result.totalTokens;
    grandSavedTokens += result.savedTokens;
    grandRedundantReads += result.redundantReads;

    const date = (session.startedAt || '').slice(0, 10);
    const project = session.projectRoot ? basename(session.projectRoot) : 'unknown';
    sessionResults.push({ date, project, ...result });

    for (const f of result.fileSavings) {
      const key = basename(f.path);
      const entry = globalFiles.get(key) || { reads: 0, redundant: 0, saved: 0 };
      entry.reads += f.reads;
      entry.redundant += f.redundant;
      entry.saved += f.saved;
      globalFiles.set(key, entry);
    }
  }

  const savePct = grandTotalTokens > 0
    ? ((grandSavedTokens / grandTotalTokens) * 100).toFixed(1)
    : '0.0';

  let out = '\n';
  out += 'SMART READ CACHE \u2014 RETROACTIVE ANALYSIS\n';
  out += '\u2550'.repeat(55) + '\n\n';
  out += `Sessions analyzed:              ${sessions.length}\n`;
  out += `Total tokens tracked:           ${formatTokens(grandTotalTokens)}\n`;
  out += `Redundant reads found:          ${grandRedundantReads} (across all sessions)\n`;
  out += `Tokens that would have been saved: ${formatTokens(grandSavedTokens)} (${savePct}%)\n`;

  // Top sessions by savings
  const topSessions = sessionResults
    .filter(s => s.savedTokens > 0)
    .sort((a, b) => b.savedTokens - a.savedTokens)
    .slice(0, 10);

  if (topSessions.length > 0) {
    out += '\nTOP SESSIONS BY SAVINGS\n';
    out += '\u2500'.repeat(55) + '\n';
    for (const s of topSessions) {
      const pct = s.totalTokens > 0
        ? ((s.savedTokens / s.totalTokens) * 100).toFixed(1)
        : '0.0';
      out += `  ${s.date} ${s.project.padEnd(18)} ${formatTokens(s.savedTokens).padStart(6)} / ${formatTokens(s.totalTokens)} saved (${pct}%)\n`;
    }
  }

  // Top files that would have been blocked
  const topFiles = [...globalFiles.entries()]
    .sort((a, b) => b[1].saved - a[1].saved)
    .slice(0, 10);

  if (topFiles.length > 0) {
    out += '\nTOP FILES THAT WOULD HAVE BEEN BLOCKED\n';
    out += '\u2500'.repeat(55) + '\n';
    for (const [name, f] of topFiles) {
      out += `  ${name.padEnd(22)} read ${String(f.reads).padStart(2)}x \u2192 blocked ${String(f.redundant).padStart(2)}x \u2192 saved ${formatTokens(f.saved)}\n`;
    }
  }

  out += '\nUse this data to demonstrate real savings to users.\n';
  console.log(out);
}

run();
