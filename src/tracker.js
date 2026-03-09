#!/usr/bin/env node

/**
 * Context Optimizer Tracker
 *
 * Tracks file reads, edits, searches, and tool usage per session.
 * Stores data in ~/.claude-context-optimizer/ for cross-session analysis.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.claude-context-optimizer');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const PATTERNS_FILE = join(DATA_DIR, 'patterns.json');
const GLOBAL_STATS_FILE = join(DATA_DIR, 'global-stats.json');

// Ensure data directories exist
mkdirSync(SESSIONS_DIR, { recursive: true });

/**
 * Estimate token count from line count (rough: ~4 tokens per line average)
 */
function estimateTokens(lineCount) {
  return Math.round(lineCount * 4);
}

/**
 * Get file line count without reading entire file
 */
function getFileLines(filePath) {
  try {
    const stat = statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) return 0; // Skip files > 10MB
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Load or create session data
 */
function loadSession(sessionId) {
  const sessionFile = join(SESSIONS_DIR, `${sessionId}.json`);
  if (existsSync(sessionFile)) {
    return JSON.parse(readFileSync(sessionFile, 'utf-8'));
  }
  return {
    id: sessionId,
    startedAt: new Date().toISOString(),
    files: {},       // { path: { reads: N, edits: N, lines: N, estTokens: N, firstRead: ts, lastUse: ts } }
    searches: [],    // { pattern, type, ts, resultsCount }
    tools: {},       // { toolName: { calls: N, totalTime: N } }
    compactions: 0,
    totalReads: 0,
    totalEdits: 0,
    totalSearches: 0,
    totalToolCalls: 0
  };
}

/**
 * Save session data
 */
function saveSession(session) {
  const sessionFile = join(SESSIONS_DIR, `${session.id}.json`);
  session.updatedAt = new Date().toISOString();
  writeFileSync(sessionFile, JSON.stringify(session, null, 2));
}

/**
 * Load global patterns database
 */
function loadPatterns() {
  if (existsSync(PATTERNS_FILE)) {
    return JSON.parse(readFileSync(PATTERNS_FILE, 'utf-8'));
  }
  return {
    fileFrequency: {},    // { path: { sessions: N, totalReads: N, totalEdits: N, avgUsefulness: N } }
    taskPatterns: {},     // { taskType: [commonly_needed_files] }
    wastedReads: {},      // { path: { count: N, sessions: N } } - files read but never referenced in output
    lastUpdated: null
  };
}

/**
 * Save global patterns
 */
function savePatterns(patterns) {
  patterns.lastUpdated = new Date().toISOString();
  writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
}

/**
 * Load global stats
 */
function loadGlobalStats() {
  if (existsSync(GLOBAL_STATS_FILE)) {
    return JSON.parse(readFileSync(GLOBAL_STATS_FILE, 'utf-8'));
  }
  return {
    totalSessions: 0,
    totalTokensTracked: 0,
    estimatedTokensSaved: 0,
    totalFilesRead: 0,
    totalFilesEdited: 0,
    avgTokensPerSession: 0,
    topWastedFiles: [],
    topUsefulFiles: [],
    sessionHistory: []  // last 100 sessions summary
  };
}

function saveGlobalStats(stats) {
  writeFileSync(GLOBAL_STATS_FILE, JSON.stringify(stats, null, 2));
}

/**
 * Track a file read event
 */
function trackRead(session, filePath, lineCount) {
  if (!session.files[filePath]) {
    session.files[filePath] = {
      reads: 0,
      edits: 0,
      lines: lineCount,
      estTokens: estimateTokens(lineCount),
      firstRead: new Date().toISOString(),
      lastUse: null,
      wasEdited: false,
      wasReferencedInOutput: false
    };
  }

  session.files[filePath].reads++;
  session.files[filePath].lastUse = new Date().toISOString();
  session.files[filePath].lines = lineCount;
  session.files[filePath].estTokens = estimateTokens(lineCount);
  session.totalReads++;
}

/**
 * Track a file edit/write event
 */
function trackEdit(session, filePath) {
  if (!session.files[filePath]) {
    session.files[filePath] = {
      reads: 0,
      edits: 0,
      lines: 0,
      estTokens: 0,
      firstRead: new Date().toISOString(),
      lastUse: null,
      wasEdited: true,
      wasReferencedInOutput: true
    };
  }

  session.files[filePath].edits++;
  session.files[filePath].wasEdited = true;
  session.files[filePath].wasReferencedInOutput = true;
  session.files[filePath].lastUse = new Date().toISOString();
  session.totalEdits++;
}

/**
 * Track a search event
 */
function trackSearch(session, pattern, type, resultsCount) {
  session.searches.push({
    pattern,
    type,
    resultsCount: resultsCount || 0,
    ts: new Date().toISOString()
  });
  session.totalSearches++;
}

/**
 * Track generic tool use
 */
function trackToolUse(session, toolName) {
  if (!session.tools[toolName]) {
    session.tools[toolName] = { calls: 0 };
  }
  session.tools[toolName].calls++;
  session.totalToolCalls++;
}

/**
 * Finalize session — compute usefulness scores, update global patterns
 */
function finalizeSession(session) {
  const patterns = loadPatterns();
  const globalStats = loadGlobalStats();

  let sessionTokensTotal = 0;
  let sessionTokensWasted = 0;

  for (const [filePath, fileData] of Object.entries(session.files)) {
    const tokensUsed = fileData.estTokens * fileData.reads;
    sessionTokensTotal += tokensUsed;

    // A file is "useful" if it was edited or read multiple times
    const isUseful = fileData.wasEdited || fileData.reads > 1;

    if (!isUseful && fileData.reads === 1) {
      sessionTokensWasted += tokensUsed;

      // Track wasted reads globally
      if (!patterns.wastedReads[filePath]) {
        patterns.wastedReads[filePath] = { count: 0, sessions: 0, totalTokensWasted: 0 };
      }
      patterns.wastedReads[filePath].count++;
      patterns.wastedReads[filePath].sessions++;
      patterns.wastedReads[filePath].totalTokensWasted += tokensUsed;
    }

    // Track file frequency globally
    if (!patterns.fileFrequency[filePath]) {
      patterns.fileFrequency[filePath] = { sessions: 0, totalReads: 0, totalEdits: 0, usefulness: 0 };
    }
    patterns.fileFrequency[filePath].sessions++;
    patterns.fileFrequency[filePath].totalReads += fileData.reads;
    patterns.fileFrequency[filePath].totalEdits += fileData.edits;
    patterns.fileFrequency[filePath].usefulness = isUseful ?
      patterns.fileFrequency[filePath].usefulness + 1 :
      patterns.fileFrequency[filePath].usefulness;
  }

  // Update global stats
  globalStats.totalSessions++;
  globalStats.totalTokensTracked += sessionTokensTotal;
  globalStats.estimatedTokensSaved += sessionTokensWasted;
  globalStats.totalFilesRead += session.totalReads;
  globalStats.totalFilesEdited += session.totalEdits;
  globalStats.avgTokensPerSession = Math.round(
    globalStats.totalTokensTracked / globalStats.totalSessions
  );

  // Keep last 100 sessions
  globalStats.sessionHistory.push({
    id: session.id,
    date: new Date().toISOString(),
    filesRead: Object.keys(session.files).length,
    totalReads: session.totalReads,
    totalEdits: session.totalEdits,
    tokensTotal: sessionTokensTotal,
    tokensWasted: sessionTokensWasted,
    wastePercent: sessionTokensTotal > 0 ?
      Math.round((sessionTokensWasted / sessionTokensTotal) * 100) : 0
  });
  if (globalStats.sessionHistory.length > 100) {
    globalStats.sessionHistory = globalStats.sessionHistory.slice(-100);
  }

  // Compute top wasted/useful files
  globalStats.topWastedFiles = Object.entries(patterns.wastedReads)
    .sort((a, b) => b[1].totalTokensWasted - a[1].totalTokensWasted)
    .slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  globalStats.topUsefulFiles = Object.entries(patterns.fileFrequency)
    .filter(([, data]) => data.usefulness > 0)
    .sort((a, b) => b[1].usefulness - a[1].usefulness)
    .slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  savePatterns(patterns);
  saveGlobalStats(globalStats);
  saveSession(session);

  return { sessionTokensTotal, sessionTokensWasted };
}

/**
 * Rebuild global stats from all session files (fallback when global-stats.json is missing)
 */
function rebuildGlobalStats() {
  const sessionFiles = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  if (sessionFiles.length === 0) return;

  // Reset patterns and stats, then finalize each session
  const patterns = { fileFrequency: {}, taskPatterns: {}, wastedReads: {}, lastUpdated: null };
  const globalStats = {
    totalSessions: 0, totalTokensTracked: 0, estimatedTokensSaved: 0,
    totalFilesRead: 0, totalFilesEdited: 0, avgTokensPerSession: 0,
    topWastedFiles: [], topUsefulFiles: [], sessionHistory: []
  };

  for (const file of sessionFiles) {
    try {
      const session = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
      let sessionTokensTotal = 0;
      let sessionTokensWasted = 0;

      for (const [filePath, fileData] of Object.entries(session.files || {})) {
        const tokensUsed = (fileData.estTokens || 0) * (fileData.reads || 1);
        sessionTokensTotal += tokensUsed;
        const isUseful = fileData.wasEdited || fileData.reads > 1;

        if (!isUseful && fileData.reads === 1) {
          sessionTokensWasted += tokensUsed;
          if (!patterns.wastedReads[filePath]) {
            patterns.wastedReads[filePath] = { count: 0, sessions: 0, totalTokensWasted: 0 };
          }
          patterns.wastedReads[filePath].count++;
          patterns.wastedReads[filePath].sessions++;
          patterns.wastedReads[filePath].totalTokensWasted += tokensUsed;
        }

        if (!patterns.fileFrequency[filePath]) {
          patterns.fileFrequency[filePath] = { sessions: 0, totalReads: 0, totalEdits: 0, usefulness: 0 };
        }
        patterns.fileFrequency[filePath].sessions++;
        patterns.fileFrequency[filePath].totalReads += fileData.reads || 0;
        patterns.fileFrequency[filePath].totalEdits += fileData.edits || 0;
        if (isUseful) patterns.fileFrequency[filePath].usefulness++;
      }

      globalStats.totalSessions++;
      globalStats.totalTokensTracked += sessionTokensTotal;
      globalStats.estimatedTokensSaved += sessionTokensWasted;
      globalStats.totalFilesRead += session.totalReads || 0;
      globalStats.totalFilesEdited += session.totalEdits || 0;

      globalStats.sessionHistory.push({
        id: session.id, date: session.startedAt || new Date().toISOString(),
        filesRead: Object.keys(session.files || {}).length,
        totalReads: session.totalReads || 0, totalEdits: session.totalEdits || 0,
        tokensTotal: sessionTokensTotal, tokensWasted: sessionTokensWasted,
        wastePercent: sessionTokensTotal > 0 ? Math.round((sessionTokensWasted / sessionTokensTotal) * 100) : 0
      });
    } catch { /* skip corrupted session files */ }
  }

  if (globalStats.totalSessions > 0) {
    globalStats.avgTokensPerSession = Math.round(globalStats.totalTokensTracked / globalStats.totalSessions);
  }
  globalStats.sessionHistory = globalStats.sessionHistory.slice(-100);

  globalStats.topWastedFiles = Object.entries(patterns.wastedReads)
    .sort((a, b) => b[1].totalTokensWasted - a[1].totalTokensWasted)
    .slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  globalStats.topUsefulFiles = Object.entries(patterns.fileFrequency)
    .filter(([, data]) => data.usefulness > 0)
    .sort((a, b) => b[1].usefulness - a[1].usefulness)
    .slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  savePatterns(patterns);
  saveGlobalStats(globalStats);
}

/**
 * Main entry: parse hook event from stdin
 */
async function main() {
  const action = process.argv[2];

  if (action === 'report') {
    // Rebuild from sessions if global-stats.json is missing
    if (!existsSync(GLOBAL_STATS_FILE)) {
      rebuildGlobalStats();
    }
    const globalStats = loadGlobalStats();
    console.log(JSON.stringify(globalStats, null, 2));
    return;
  }

  if (action === 'patterns') {
    const patterns = loadPatterns();
    console.log(JSON.stringify(patterns, null, 2));
    return;
  }

  if (action === 'session-report') {
    const sessionId = process.argv[3];
    if (!sessionId) {
      console.error('Usage: cco-tracker session-report <session-id>');
      process.exit(1);
    }
    const session = loadSession(sessionId);
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  if (action === 'heatmap') {
    const sessionId = process.argv[3];
    if (!sessionId) {
      console.error('Usage: cco-tracker heatmap <session-id>');
      process.exit(1);
    }
    const session = loadSession(sessionId);
    const heatmap = generateHeatmap(session);
    console.log(heatmap);
    return;
  }

  if (action === 'suggest') {
    const cwd = process.argv[3] || process.cwd();
    const suggestions = generateSuggestions(cwd);
    console.log(JSON.stringify(suggestions, null, 2));
    return;
  }

  // Default: read hook event from stdin
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

  const sessionId = event.session_id || 'unknown';
  const session = loadSession(sessionId);
  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};
  const hookEvent = event.hook_event_name || action || '';

  switch (hookEvent) {
    case 'PostToolUse': {
      trackToolUse(session, toolName);

      if (toolName === 'Read') {
        const filePath = toolInput.file_path || '';
        const lineCount = toolInput.limit || getFileLines(filePath);
        trackRead(session, filePath, lineCount);
      }

      if (toolName === 'Edit' || toolName === 'Write') {
        const filePath = toolInput.file_path || '';
        trackEdit(session, filePath);
      }

      if (toolName === 'Glob' || toolName === 'Grep') {
        const pattern = toolInput.pattern || toolInput.query || '';
        trackSearch(session, pattern, toolName, 0);
      }

      if (toolName === 'Agent') {
        trackToolUse(session, `Agent:${toolInput.subagent_type || 'general'}`);
      }

      break;
    }

    case 'SessionStart': {
      // Fresh session init already handled by loadSession
      break;
    }

    case 'PreCompact': {
      session.compactions++;
      break;
    }

    case 'SessionEnd': {
      const result = finalizeSession(session);
      // Output summary to stderr so it shows as feedback
      const wastePercent = result.sessionTokensTotal > 0 ?
        Math.round((result.sessionTokensWasted / result.sessionTokensTotal) * 100) : 0;
      console.error(
        `[context-optimizer] Session summary: ~${result.sessionTokensTotal} tokens tracked, ` +
        `~${result.sessionTokensWasted} potentially wasted (${wastePercent}%). ` +
        `Files: ${Object.keys(session.files).length} read, ${session.totalEdits} edits.`
      );
      break;
    }

    default:
      break;
  }

  saveSession(session);
  process.exit(0);
}

/**
 * Generate ASCII heatmap for a session
 */
function generateHeatmap(session) {
  const files = Object.entries(session.files)
    .sort((a, b) => b[1].estTokens * b[1].reads - a[1].estTokens * a[1].reads);

  if (files.length === 0) return 'No files tracked in this session.';

  const maxTokens = Math.max(...files.map(([, d]) => d.estTokens * d.reads));
  const barWidth = 40;

  let output = '\n  CONTEXT HEATMAP\n';
  output += '  ' + '='.repeat(70) + '\n\n';
  output += '  File'.padEnd(35) + 'Tokens'.padStart(8) + '  Reads  Edits  Impact\n';
  output += '  ' + '-'.repeat(70) + '\n';

  for (const [filePath, data] of files) {
    const totalTokens = data.estTokens * data.reads;
    const barLen = Math.max(1, Math.round((totalTokens / maxTokens) * barWidth));
    const isUseful = data.wasEdited || data.reads > 1;
    const bar = isUseful ? '\u2588'.repeat(barLen) : '\u2591'.repeat(barLen);
    const icon = data.wasEdited ? '\u270F' : (data.reads > 1 ? '\u2714' : '\u26A0');
    const name = basename(filePath).substring(0, 30);

    output += `  ${icon} ${name.padEnd(32)} ${String(totalTokens).padStart(6)}  ${String(data.reads).padStart(5)}  ${String(data.edits).padStart(5)}  ${bar}\n`;
  }

  output += '\n  Legend: \u270F = edited (high value)  \u2714 = multi-read (useful)  \u26A0 = single read (potential waste)\n';
  output += '  \u2588 = useful tokens  \u2591 = potentially wasted tokens\n';

  return output;
}

/**
 * Generate smart suggestions based on historical patterns
 */
function generateSuggestions(cwd) {
  const patterns = loadPatterns();
  const globalStats = loadGlobalStats();

  const suggestions = {
    preload: [],
    avoid: [],
    tips: []
  };

  // Files that are almost always useful in this directory
  for (const [filePath, data] of Object.entries(patterns.fileFrequency)) {
    if (filePath.startsWith(cwd) && data.usefulness >= 3 && data.totalEdits > 0) {
      suggestions.preload.push({
        file: filePath,
        reason: `Edited in ${data.totalEdits}/${data.sessions} sessions`,
        confidence: Math.min(100, Math.round((data.usefulness / data.sessions) * 100))
      });
    }
  }

  // Files that are frequently wasted
  for (const [filePath, data] of Object.entries(patterns.wastedReads)) {
    if (data.sessions >= 3 && data.totalTokensWasted > 1000) {
      suggestions.avoid.push({
        file: filePath,
        reason: `Read but unused in ${data.sessions} sessions, wasted ~${data.totalTokensWasted} tokens`,
        tokensSaveable: data.totalTokensWasted
      });
    }
  }

  // General tips
  if (globalStats.totalSessions > 5) {
    const avgWaste = globalStats.sessionHistory.slice(-10)
      .reduce((sum, s) => sum + s.wastePercent, 0) /
      Math.min(10, globalStats.sessionHistory.length);

    if (avgWaste > 30) {
      suggestions.tips.push(
        `Your average context waste is ${Math.round(avgWaste)}%. Try being more specific about which files to read.`
      );
    }

    if (globalStats.avgTokensPerSession > 50000) {
      suggestions.tips.push(
        `Average session uses ~${globalStats.avgTokensPerSession} tokens. Consider using /compact more often or splitting tasks.`
      );
    }
  }

  suggestions.preload.sort((a, b) => b.confidence - a.confidence);
  suggestions.avoid.sort((a, b) => b.tokensSaveable - a.tokensSaveable);

  return suggestions;
}

main().catch(err => {
  console.error(`[context-optimizer] Error: ${err.message}`);
  process.exit(0); // Don't block Claude on errors
});
