#!/usr/bin/env node

/**
 * Context Optimizer Report Generator
 *
 * Generates human-readable reports from tracked context data.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.claude-context-optimizer');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const GLOBAL_STATS_FILE = join(DATA_DIR, 'global-stats.json');
const PATTERNS_FILE = join(DATA_DIR, 'patterns.json');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return { budgetTokens: 100000, warnAt: [50, 70, 85, 95], autoCompactAt: 90, model: 'opus' };
}

const MODEL_COSTS = { haiku: 0.25, sonnet: 3, opus: 15 };

function loadJSON(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function generateFullReport() {
  const stats = loadJSON(GLOBAL_STATS_FILE);
  const patterns = loadJSON(PATTERNS_FILE);

  if (!stats || stats.totalSessions === 0) {
    console.log('No tracking data yet. Use Claude Code normally and data will be collected automatically.');
    return;
  }

  let report = '';

  // Header
  report += '\n';
  report += '  ╔══════════════════════════════════════════════════════════════╗\n';
  report += '  ║           CONTEXT OPTIMIZER — TOKEN ROI REPORT             ║\n';
  report += '  ╚══════════════════════════════════════════════════════════════╝\n\n';

  // Overview
  report += '  OVERVIEW\n';
  report += '  ' + '─'.repeat(50) + '\n';
  report += `  Total sessions tracked:     ${stats.totalSessions}\n`;
  report += `  Total tokens tracked:       ${formatTokens(stats.totalTokensTracked)}\n`;
  report += `  Estimated tokens wasted:    ${formatTokens(stats.estimatedTokensSaved)}\n`;
  report += `  Avg tokens per session:     ${formatTokens(stats.avgTokensPerSession)}\n`;
  report += `  Total files read:           ${stats.totalFilesRead}\n`;
  report += `  Total files edited:         ${stats.totalFilesEdited}\n`;

  const overallWaste = stats.totalTokensTracked > 0 ?
    Math.round((stats.estimatedTokensSaved / stats.totalTokensTracked) * 100) : 0;
  report += `  Overall waste ratio:        ${overallWaste}%\n`;

  // Cost estimate using configured model (with all models shown)
  const config = loadConfig();
  const primaryModel = config.model || 'opus';
  const primaryCost = (stats.estimatedTokensSaved / 1000000) * (MODEL_COSTS[primaryModel] || 15);
  if (stats.estimatedTokensSaved > 5000) {
    report += `  Est. $ saveable (${primaryModel}):   $${primaryCost.toFixed(2)}\n`;
    // Show other models for reference
    for (const [model, rate] of Object.entries(MODEL_COSTS)) {
      if (model !== primaryModel) {
        const cost = (stats.estimatedTokensSaved / 1000000) * rate;
        report += `  Est. $ saveable (${model}):   $${cost.toFixed(2)}\n`;
      }
    }
  }
  report += '\n';

  // Recent sessions trend
  if (stats.sessionHistory.length > 1) {
    report += '  RECENT SESSIONS\n';
    report += '  ' + '─'.repeat(50) + '\n';
    report += '  Date                Files  Reads  Edits  Waste%\n';

    for (const s of stats.sessionHistory.slice(-10)) {
      const date = new Date(s.date).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      report += `  ${date.padEnd(20)} ${String(s.filesRead).padStart(5)}  ${String(s.totalReads).padStart(5)}  ${String(s.totalEdits).padStart(5)}  ${String(s.wastePercent).padStart(5)}%\n`;
    }
    report += '\n';

    // Trend analysis
    const recent5 = stats.sessionHistory.slice(-5);
    const older5 = stats.sessionHistory.slice(-10, -5);
    if (older5.length > 0) {
      const recentAvgWaste = recent5.reduce((s, x) => s + x.wastePercent, 0) / recent5.length;
      const olderAvgWaste = older5.reduce((s, x) => s + x.wastePercent, 0) / older5.length;
      const trend = recentAvgWaste < olderAvgWaste ? 'IMPROVING' :
                    recentAvgWaste > olderAvgWaste ? 'WORSENING' : 'STABLE';
      const icon = trend === 'IMPROVING' ? '\u2193' : trend === 'WORSENING' ? '\u2191' : '\u2192';
      report += `  Waste trend: ${icon} ${trend} (${Math.round(olderAvgWaste)}% -> ${Math.round(recentAvgWaste)}%)\n\n`;
    }
  }

  // Top wasted files
  if (stats.topWastedFiles && stats.topWastedFiles.length > 0) {
    report += '  TOP WASTED FILES (read but never used)\n';
    report += '  ' + '─'.repeat(50) + '\n';

    for (const f of stats.topWastedFiles.slice(0, 10)) {
      report += `  \u26A0 ${basename(f.fullPath).padEnd(30)} ${formatTokens(f.totalTokensWasted).padStart(6)} tokens wasted across ${f.sessions} sessions\n`;
    }
    report += '\n';
  }

  // Top useful files
  if (stats.topUsefulFiles && stats.topUsefulFiles.length > 0) {
    report += '  TOP USEFUL FILES (frequently edited)\n';
    report += '  ' + '─'.repeat(50) + '\n';

    for (const f of stats.topUsefulFiles.slice(0, 10)) {
      report += `  \u2714 ${basename(f.fullPath).padEnd(30)} ${String(f.totalEdits).padStart(3)} edits, ${String(f.totalReads).padStart(3)} reads across ${f.sessions} sessions\n`;
    }
    report += '\n';
  }

  // Recommendations
  report += '  RECOMMENDATIONS\n';
  report += '  ' + '─'.repeat(50) + '\n';

  if (overallWaste > 40) {
    report += '  [!] High waste ratio. Consider:\n';
    report += '      - Use Grep/Glob to find specific files before reading\n';
    report += '      - Read only relevant sections with offset/limit\n';
    report += '      - Use Agent tool for exploratory searches\n';
  } else if (overallWaste > 20) {
    report += '  [~] Moderate waste. You can improve by:\n';
    report += '      - Avoiding reading large config files fully\n';
    report += '      - Using /compact when switching tasks\n';
  } else {
    report += '  [OK] Context usage is efficient. Keep it up!\n';
  }

  if (stats.avgTokensPerSession > 80000) {
    report += '  [!] High avg token usage. Consider splitting large tasks into sub-sessions.\n';
  }

  report += '\n';
  console.log(report);
}

function generateSessionList() {
  if (!existsSync(SESSIONS_DIR)) {
    console.log('No sessions tracked yet.');
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
      const fileCount = Object.keys(session.files).length;
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
