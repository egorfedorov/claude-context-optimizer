#!/usr/bin/env node

/**
 * Context Optimizer Report Generator v2.1
 *
 * Generates human-readable reports from tracked context data.
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import {
  SESSIONS_DIR, GLOBAL_STATS_FILE,
  formatTokens, loadJSON, loadConfig, MODEL_INPUT_COST
} from './utils.js';

function generateFullReport() {
  const stats = loadJSON(GLOBAL_STATS_FILE);

  if (!stats || stats.totalSessions === 0) {
    console.log('No data yet — just use Claude Code normally and tracking starts automatically!');
    return;
  }

  const config = loadConfig();
  let report = '';

  report += '\n';
  report += `  \u2554${'═'.repeat(62)}\u2557\n`;
  report += '  \u2551           CONTEXT OPTIMIZER \u2014 TOKEN ROI REPORT             \u2551\n';
  report += `  \u255A${'═'.repeat(62)}\u255D\n\n`;

  report += '  OVERVIEW\n';
  report += '  ' + '\u2500'.repeat(50) + '\n';
  report += `  Total sessions tracked:     ${stats.totalSessions}\n`;
  report += `  Total tokens tracked:       ${formatTokens(stats.totalTokensTracked)}\n`;
  report += `  Estimated tokens wasted:    ${formatTokens(stats.estimatedTokensSaved)}\n`;
  report += `  Avg tokens per session:     ${formatTokens(stats.avgTokensPerSession)}\n`;
  report += `  Total files read:           ${stats.totalFilesRead}\n`;
  report += `  Total files edited:         ${stats.totalFilesEdited}\n`;

  const overallWaste = stats.totalTokensTracked > 0 ?
    Math.round((stats.estimatedTokensSaved / stats.totalTokensTracked) * 100) : 0;
  report += `  Overall waste ratio:        ${overallWaste}%\n`;

  const primaryModel = config.model || 'opus';
  const primaryCost = (stats.estimatedTokensSaved / 1000000) * (MODEL_INPUT_COST[primaryModel] || MODEL_INPUT_COST.opus);
  if (stats.estimatedTokensSaved > 5000) {
    report += `  Est. $ saveable (${primaryModel}):   $${primaryCost.toFixed(2)}\n`;
    for (const [model, rate] of Object.entries(MODEL_INPUT_COST)) {
      if (model !== primaryModel) {
        const cost = (stats.estimatedTokensSaved / 1000000) * rate;
        report += `  Est. $ saveable (${model}):   $${cost.toFixed(2)}\n`;
      }
    }
  }
  report += '\n';

  if (stats.sessionHistory && stats.sessionHistory.length > 1) {
    // Filter out empty sessions from display
    const nonEmpty = stats.sessionHistory.filter(s => s.tokensTotal > 0);

    if (nonEmpty.length > 0) {
      report += '  RECENT SESSIONS\n';
      report += '  ' + '\u2500'.repeat(50) + '\n';
      report += '  Date                Files  Reads  Edits  Waste%\n';

      for (const s of nonEmpty.slice(-10)) {
        const date = new Date(s.date).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        report += `  ${date.padEnd(20)} ${String(s.filesRead).padStart(5)}  ${String(s.totalReads).padStart(5)}  ${String(s.totalEdits).padStart(5)}  ${String(s.wastePercent).padStart(5)}%\n`;
      }
      report += '\n';

      // Trend analysis
      const recent5 = nonEmpty.slice(-5);
      const older5 = nonEmpty.slice(-10, -5);
      if (older5.length > 0) {
        const recentAvgWaste = recent5.reduce((s, x) => s + x.wastePercent, 0) / recent5.length;
        const olderAvgWaste = older5.reduce((s, x) => s + x.wastePercent, 0) / older5.length;
        const trend = recentAvgWaste < olderAvgWaste ? 'IMPROVING' :
                      recentAvgWaste > olderAvgWaste ? 'WORSENING' : 'STABLE';
        const icon = trend === 'IMPROVING' ? '\u2193' : trend === 'WORSENING' ? '\u2191' : '\u2192';
        report += `  Waste trend: ${icon} ${trend} (${Math.round(olderAvgWaste)}% -> ${Math.round(recentAvgWaste)}%)\n\n`;
      }
    }
  }

  if (stats.topWastedFiles && stats.topWastedFiles.length > 0) {
    report += '  FILES TO SKIP NEXT TIME (read but never used)\n';
    report += '  ' + '\u2500'.repeat(50) + '\n';

    for (const f of stats.topWastedFiles.slice(0, 10)) {
      report += `  \u26A0 ${basename(f.fullPath).padEnd(30)} ${formatTokens(f.totalTokensWasted).padStart(6)} tokens wasted across ${f.sessions} sessions\n`;
    }
    report += '\n';
  }

  if (stats.topUsefulFiles && stats.topUsefulFiles.length > 0) {
    report += '  TOP USEFUL FILES (frequently edited)\n';
    report += '  ' + '\u2500'.repeat(50) + '\n';

    for (const f of stats.topUsefulFiles.slice(0, 10)) {
      report += `  \u2714 ${basename(f.fullPath).padEnd(30)} ${String(f.totalEdits).padStart(3)} edits, ${String(f.totalReads).padStart(3)} reads across ${f.sessions} sessions\n`;
    }
    report += '\n';
  }

  report += '  RECOMMENDATIONS\n';
  report += '  ' + '\u2500'.repeat(50) + '\n';

  if (overallWaste > 40) {
    report += '  Room to improve! Try:\n';
    report += '      - Use Grep/Glob to find specific files before reading\n';
    report += '      - Read only relevant sections with offset/limit\n';
    report += '      - Use Agent tool for exploratory searches\n';
  } else if (overallWaste > 20) {
    report += '  Not bad! Save more by:\n';
    report += '      - Avoiding reading large config files fully\n';
    report += '      - Using /compact when switching tasks\n';
  } else {
    report += '  You\'re a context pro — tokens well spent!\n';
  }

  if (stats.avgTokensPerSession > 80000) {
    report += '  Large sessions detected — try splitting big tasks into focused sub-sessions.\n';
  }

  report += '\n';
  console.log(report);
}

function generateSessionList() {
  if (!existsSync(SESSIONS_DIR)) {
    console.log('No sessions yet — start using Claude Code and tracking begins automatically!');
    return;
  }

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-20);

  console.log('\nRecent sessions:');
  for (const f of files) {
    const session = loadJSON(join(SESSIONS_DIR, f));
    if (session) {
      const fileCount = Object.keys(session.files || {}).length;
      if (fileCount === 0) continue; // Skip empty sessions
      console.log(`  ${session.id.substring(0, 12)}  ${session.startedAt || 'unknown'}  ${fileCount} files  ${session.totalEdits} edits`);
    }
  }
}

const action = process.argv[2] || 'full';

switch (action) {
  case 'full':
    generateFullReport();
    break;
  case 'sessions':
    generateSessionList();
    break;
  default:
    console.log('Usage: cco-report [full|sessions]');
}
