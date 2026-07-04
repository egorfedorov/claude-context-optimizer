#!/usr/bin/env node

/**
 * ROI Calculator v1.0
 *
 * Calculates monthly savings from CCO based on actual session data
 * or user-provided estimates. Outputs ROI tables like tamp.dev.
 */

import { readdirSync, existsSync } from 'fs';
import {
  SESSIONS_DIR, DATA_DIR,
  formatTokens, loadJSON, MODEL_INPUT_COST, ensureDataDirs
} from './utils.js';

ensureDataDirs();

function loadRecentSessions(days = 30) {
  if (!existsSync(SESSIONS_DIR)) return [];
  const cutoff = Date.now() - days * 86400000;
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions = [];
  for (const f of files) {
    const data = loadJSON(`${SESSIONS_DIR}/${f}`);
    if (!data) continue;
    const ts = new Date(data.startedAt || 0).getTime();
    if (ts >= cutoff) sessions.push(data);
  }
  return sessions;
}

function analyzeWaste(sessions) {
  let totalTokens = 0;
  let wastedTokens = 0;
  let totalFiles = 0;
  let wastedFiles = 0;

  for (const s of sessions) {
    for (const [, fd] of Object.entries(s.files || {})) {
      const tokens = fd.estTokens || 0;
      totalTokens += tokens;
      totalFiles++;
      const useful = (fd.edits || 0) > 0 || (fd.partialReads || 0) > 0;
      if (!useful && (fd.reads || 0) >= 1 && (fd.edits || 0) === 0) {
        wastedTokens += tokens;
        wastedFiles++;
      }
    }
  }
  return { totalTokens, wastedTokens, totalFiles, wastedFiles };
}

function buildROITable(avgWastePercent, avgTokensPerSession, sessionsPerDay) {
  const models = ['haiku', 'sonnet', 'opus'];
  const rows = [];

  for (const model of models) {
    const cost = MODEL_INPUT_COST[model];
    const savedPerSession = avgTokensPerSession * (avgWastePercent / 100);
    const costPerSession = (avgTokensPerSession / 1_000_000) * cost;
    const savingsPerSession = (savedPerSession / 1_000_000) * cost;
    const dailySavings = savingsPerSession * sessionsPerDay;
    const monthlySavings = dailySavings * 30;

    rows.push({
      model: model.charAt(0).toUpperCase() + model.slice(1),
      pricePerM: `$${cost}`,
      savingsPerSession: `$${savingsPerSession.toFixed(2)}`,
      dailySavings: `$${dailySavings.toFixed(2)}`,
      monthlySavings: `$${monthlySavings.toFixed(0)}`,
      yearSavings: `$${(monthlySavings * 12).toFixed(0)}`
    });
  }
  return rows;
}

function formatROIReport(sessions, sessionsPerDay) {
  const lines = [];
  lines.push('');
  lines.push('  ╔══════════════════════════════════════════════════════════════╗');
  lines.push('  ║              CCO — Return on Investment Report              ║');
  lines.push('  ╚══════════════════════════════════════════════════════════════╝');
  lines.push('');

  let wastePercent, avgTokens, dataSource;

  if (sessions.length > 0) {
    const { totalTokens, wastedTokens } = analyzeWaste(sessions);
    wastePercent = totalTokens > 0 ? (wastedTokens / totalTokens) * 100 : 35;
    avgTokens = totalTokens / sessions.length;
    dataSource = `${sessions.length} sessions (last 30 days)`;
  } else {
    wastePercent = 35;
    avgTokens = 80000;
    dataSource = 'Industry estimate (no local data yet)';
  }

  lines.push(`  Data source: ${dataSource}`);
  lines.push(`  Average waste: ${wastePercent.toFixed(1)}%`);
  lines.push(`  Avg tokens/session: ${formatTokens(Math.round(avgTokens))}`);
  lines.push(`  Sessions/day: ${sessionsPerDay}`);
  lines.push('');

  // Savings overview
  const savedTokensPerSession = Math.round(avgTokens * (wastePercent / 100));
  lines.push('  ── What CCO Saves You ──────────────────────────────────────');
  lines.push(`  Per session:   ~${formatTokens(savedTokensPerSession)} tokens blocked/deduplicated`);
  lines.push(`  Per day:       ~${formatTokens(savedTokensPerSession * sessionsPerDay)} tokens`);
  lines.push(`  Per month:     ~${formatTokens(savedTokensPerSession * sessionsPerDay * 30)} tokens`);
  lines.push('');

  // ROI table
  lines.push('  ── Monthly Savings by Model ─────────────────────────────────');
  lines.push('');
  lines.push('  Model     $/M tok   Per session   Per day    Per month   Per year');
  lines.push('  ───────   ───────   ───────────   ────────   ─────────   ────────');

  const table = buildROITable(wastePercent, avgTokens, sessionsPerDay);
  for (const row of table) {
    const m = row.model.padEnd(9);
    const p = row.pricePerM.padEnd(9);
    const s = row.savingsPerSession.padEnd(13);
    const d = row.dailySavings.padEnd(10);
    const mo = row.monthlySavings.padEnd(11);
    const y = row.yearSavings;
    lines.push(`  ${m} ${p} ${s} ${d} ${mo} ${y}`);
  }
  lines.push('');

  // Context budget multiplier
  const multiplier = (1 / (1 - Math.min(99, wastePercent) / 100)).toFixed(1);
  lines.push('  ── Effective Context Multiplier ─────────────────────────────');
  lines.push(`  CCO makes your context budget ${multiplier}x more effective`);
  lines.push(`  200K context → effectively ${formatTokens(Math.round(200000 * parseFloat(multiplier)))} of useful context`);
  lines.push(`  1M context   → effectively ${formatTokens(Math.round(1000000 * parseFloat(multiplier)))} of useful context`);
  lines.push('');

  // Team ROI
  lines.push('  ── Team ROI (10 developers, Opus) ───────────────────────────');
  const teamMonthly = parseFloat(table[2].monthlySavings.replace('$', '')) * 10;
  const teamYearly = teamMonthly * 12;
  lines.push(`  Monthly: $${teamMonthly.toFixed(0)}`);
  lines.push(`  Yearly:  $${teamYearly.toFixed(0)}`);
  lines.push('');

  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sessionsPerDay = parseInt(args[0]) || 5;
const sessions = loadRecentSessions(30);
console.log(formatROIReport(sessions, sessionsPerDay));
