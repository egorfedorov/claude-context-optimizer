#!/usr/bin/env node

/**
 * Weekly/Daily Digest Generator
 *
 * Aggregates session data over a time period and generates
 * a comprehensive digest with trends, insights, and scores.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.claude-context-optimizer');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const GLOBAL_STATS_FILE = join(DATA_DIR, 'global-stats.json');

function loadJSON(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function getSessionsInRange(days) {
  if (!existsSync(SESSIONS_DIR)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions = [];

  for (const f of files) {
    try {
      const session = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8'));
      const sessionDate = new Date(session.updatedAt || session.startedAt);
      if (sessionDate >= cutoff) {
        sessions.push(session);
      }
    } catch {
      // skip corrupt files
    }
  }

  return sessions.sort((a, b) =>
    new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );
}

function calculateEfficiencyScore(sessions) {
  if (sessions.length === 0) return { score: 0, grade: '-', breakdown: {} };

  let totalTokens = 0;
  let wastedTokens = 0;
  let totalReads = 0;
  let totalEdits = 0;
  let totalSearches = 0;
  let reReads = 0; // files read multiple times (exploration waste)
  let editRatio = 0;

  for (const session of sessions) {
    for (const [, fileData] of Object.entries(session.files || {})) {
      const tokens = (fileData.estTokens || 0) * (fileData.reads || 1);
      totalTokens += tokens;

      if (!fileData.wasEdited && fileData.reads === 1) {
        wastedTokens += tokens;
      }

      if (fileData.reads > 2) {
        reReads += fileData.reads - 1;
      }

      totalReads += fileData.reads || 0;
      totalEdits += fileData.edits || 0;
    }
    totalSearches += session.totalSearches || 0;
  }

  // Score components (0-100 each)
  const wasteScore = totalTokens > 0 ?
    Math.max(0, 100 - Math.round((wastedTokens / totalTokens) * 100)) : 100;

  editRatio = totalReads > 0 ? totalEdits / totalReads : 0;
  const editScore = Math.min(100, Math.round(editRatio * 200)); // 50% edit ratio = 100

  const searchEfficiency = totalSearches > 0 && totalReads > 0 ?
    Math.min(100, Math.round((1 - totalSearches / (totalSearches + totalReads)) * 100)) : 80;

  const reReadPenalty = totalReads > 0 ?
    Math.max(0, 100 - Math.round((reReads / totalReads) * 100)) : 100;

  // Weighted final score
  const score = Math.round(
    wasteScore * 0.40 +
    editScore * 0.25 +
    searchEfficiency * 0.15 +
    reReadPenalty * 0.20
  );

  let grade;
  if (score >= 90) grade = 'S';
  else if (score >= 80) grade = 'A';
  else if (score >= 70) grade = 'B';
  else if (score >= 55) grade = 'C';
  else if (score >= 40) grade = 'D';
  else grade = 'F';

  return {
    score,
    grade,
    breakdown: {
      wasteScore,
      editScore,
      searchEfficiency,
      reReadPenalty
    },
    stats: {
      totalTokens,
      wastedTokens,
      totalReads,
      totalEdits,
      totalSearches,
      sessions: sessions.length
    }
  };
}

function generateDigest(days) {
  const sessions = getSessionsInRange(days);
  const efficiency = calculateEfficiencyScore(sessions);
  const period = days === 1 ? 'DAILY' : days === 7 ? 'WEEKLY' : `${days}-DAY`;

  let output = '\n';
  output += `  ╔══════════════════════════════════════════════════════════════╗\n`;
  output += `  ║              ${period} CONTEXT EFFICIENCY DIGEST              ║\n`;
  output += `  ╚══════════════════════════════════════════════════════════════╝\n\n`;

  if (sessions.length === 0) {
    output += '  No sessions found in this period. Start using Claude Code!\n';
    console.log(output);
    return;
  }

  // Efficiency Score with ASCII art
  const scoreBar = '█'.repeat(Math.round(efficiency.score / 2.5)) +
                   '░'.repeat(40 - Math.round(efficiency.score / 2.5));

  output += `  EFFICIENCY SCORE\n`;
  output += `  ────────────────────────────────────────────────────\n`;
  output += `  Grade: ${efficiency.grade}  Score: ${efficiency.score}/100\n`;
  output += `  [${scoreBar}]\n\n`;

  output += `  Breakdown:\n`;
  output += `    Context Precision .... ${efficiency.breakdown.wasteScore}/100  (${efficiency.breakdown.wasteScore >= 70 ? 'good' : 'needs work'})\n`;
  output += `    Edit Efficiency ...... ${efficiency.breakdown.editScore}/100  (${efficiency.breakdown.editScore >= 50 ? 'good' : 'low edits vs reads'})\n`;
  output += `    Search Accuracy ...... ${efficiency.breakdown.searchEfficiency}/100\n`;
  output += `    Focus Score .......... ${efficiency.breakdown.reReadPenalty}/100  (${efficiency.breakdown.reReadPenalty >= 70 ? 'focused' : 'too much re-reading'})\n\n`;

  // Stats
  output += `  STATS (last ${days} days)\n`;
  output += `  ────────────────────────────────────────────────────\n`;
  output += `  Sessions:         ${efficiency.stats.sessions}\n`;
  output += `  Total tokens:     ${formatTokens(efficiency.stats.totalTokens)}\n`;
  output += `  Wasted tokens:    ${formatTokens(efficiency.stats.wastedTokens)}\n`;
  output += `  Files read:       ${efficiency.stats.totalReads}\n`;
  output += `  Files edited:     ${efficiency.stats.totalEdits}\n`;
  output += `  Searches:         ${efficiency.stats.totalSearches}\n`;

  // Cost
  const costs = {
    haiku: (efficiency.stats.totalTokens / 1000000) * 0.25,
    sonnet: (efficiency.stats.totalTokens / 1000000) * 3,
    opus: (efficiency.stats.totalTokens / 1000000) * 15
  };
  const wasted = {
    haiku: (efficiency.stats.wastedTokens / 1000000) * 0.25,
    sonnet: (efficiency.stats.wastedTokens / 1000000) * 3,
    opus: (efficiency.stats.wastedTokens / 1000000) * 15
  };
  output += `\n  EST. COST\n`;
  output += `  ────────────────────────────────────────────────────\n`;
  output += `  Model      Total       Wasted      Saveable\n`;
  output += `  Haiku      $${costs.haiku.toFixed(3).padStart(7)}    $${wasted.haiku.toFixed(3).padStart(7)}    $${wasted.haiku.toFixed(3).padStart(7)}\n`;
  output += `  Sonnet     $${costs.sonnet.toFixed(3).padStart(7)}    $${wasted.sonnet.toFixed(3).padStart(7)}    $${wasted.sonnet.toFixed(3).padStart(7)}\n`;
  output += `  Opus       $${costs.opus.toFixed(3).padStart(7)}    $${wasted.opus.toFixed(3).padStart(7)}    $${wasted.opus.toFixed(3).padStart(7)}\n`;

  // Per-session breakdown
  if (sessions.length > 1) {
    output += `\n  SESSION BREAKDOWN\n`;
    output += `  ────────────────────────────────────────────────────\n`;
    output += `  #   Date          Files  Edits  Tokens    Waste\n`;

    sessions.forEach((s, i) => {
      const date = new Date(s.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const fileCount = Object.keys(s.files || {}).length;
      const totalTok = Object.values(s.files || {}).reduce((sum, f) =>
        sum + (f.estTokens || 0) * (f.reads || 1), 0);
      const wasteTok = Object.values(s.files || {}).reduce((sum, f) =>
        !f.wasEdited && f.reads === 1 ? sum + (f.estTokens || 0) : sum, 0);
      const wastePct = totalTok > 0 ? Math.round((wasteTok / totalTok) * 100) : 0;

      output += `  ${String(i + 1).padStart(2)}  ${date.padEnd(12)}  ${String(fileCount).padStart(5)}  ${String(s.totalEdits || 0).padStart(5)}  ${formatTokens(totalTok).padStart(8)}  ${String(wastePct).padStart(4)}%\n`;
    });
  }

  // Tips based on score
  output += `\n  TIPS\n`;
  output += `  ────────────────────────────────────────────────────\n`;

  if (efficiency.score >= 80) {
    output += `  You're a context efficiency pro! Keep it up.\n`;
  } else {
    if (efficiency.breakdown.wasteScore < 70) {
      output += `  - Too many files read without being used. Try Grep first to find\n`;
      output += `    the right file, then Read only what you need.\n`;
    }
    if (efficiency.breakdown.editScore < 40) {
      output += `  - Low edit-to-read ratio. Are you exploring too much before acting?\n`;
      output += `    Try describing the task precisely so Claude reads fewer files.\n`;
    }
    if (efficiency.breakdown.reReadPenalty < 60) {
      output += `  - Files being re-read too often. Use /compact less aggressively,\n`;
      output += `    or keep key files in context with templates.\n`;
    }
  }

  output += '\n';
  console.log(output);
}

// Parse args
const days = parseInt(process.argv[2]) || 7;
generateDigest(days);
