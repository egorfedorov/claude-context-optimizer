#!/usr/bin/env node

/**
 * Context Optimizer Tracker v2.0
 *
 * Tracks file reads, edits, searches, and tool usage per session.
 * Features: ignore patterns, real-time waste warnings, partial read tracking,
 * co-occurrence matrix, project-segmented patterns, weighted usefulness scoring,
 * compact heatmap with actionable recommendations.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'fs';
import { join, basename, extname, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const DATA_DIR = join(homedir(), '.claude-context-optimizer');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const PATTERNS_FILE = join(DATA_DIR, 'patterns.json');
const GLOBAL_STATS_FILE = join(DATA_DIR, 'global-stats.json');

mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Ignore patterns: skip tracking for these files ──────────────────────────
const IGNORE_PATTERNS = [
  /^toolu_/,                          // Claude internal tool result IDs
  /^\/dev\//,                         // system paths
  /^\/proc\//,                        // linux proc
  /^\/tmp\/claude/,                   // Claude temp files
  /^data:/,                           // data URIs
  /\.(png|jpg|jpeg|gif|svg|ico|webp|bmp|tiff)$/i,  // images
  /\.(mp3|mp4|wav|ogg|webm|avi|mov)$/i,            // media
  /\.(zip|tar|gz|bz2|7z|rar)$/i,                   // archives
  /\.(woff|woff2|ttf|eot|otf)$/i,                  // fonts
  /\.(pdf)$/i,                        // PDFs (high token cost, often one-off)
  /node_modules\//,                   // dependencies
  /\.git\//,                          // git internals
  /package-lock\.json$/,              // lock files
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
];

function shouldIgnore(filePath) {
  if (!filePath) return true;
  const normalized = filePath.replace(/^\/Users\/[^/]+\//, '~/');
  return IGNORE_PATTERNS.some(p => p.test(filePath) || p.test(basename(filePath)) || p.test(normalized));
}

// ── Token estimation ────────────────────────────────────────────────────────

// Extension-specific chars-per-token ratios (lower = more tokens per char)
const TOKEN_RATIOS = {
  '.json': 3.2, '.yaml': 3.5, '.yml': 3.5, '.toml': 3.5,
  '.ts': 3.8, '.tsx': 3.8, '.js': 3.8, '.jsx': 3.8,
  '.py': 4.0, '.rb': 4.0, '.go': 3.7, '.rs': 3.7,
  '.cpp': 3.6, '.c': 3.6, '.h': 3.6, '.hpp': 3.6,
  '.md': 4.2, '.txt': 4.5, '.html': 3.5, '.css': 3.8,
  '.svg': 3.0, '.xml': 3.2,
};

function estimateTokens(lineCount, ext) {
  // Better heuristic: avg line is ~35 chars, then apply ratio
  const avgCharsPerLine = 35;
  const ratio = TOKEN_RATIOS[ext] || 3.7;
  return Math.round((lineCount * avgCharsPerLine) / ratio);
}

function estimateTokensFromContent(content, ext) {
  const ratio = TOKEN_RATIOS[ext] || 3.7;
  return Math.round(content.length / ratio);
}

// ── File utilities ──────────────────────────────────────────────────────────

function getFileLines(filePath) {
  try {
    const stat = statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) return 0;
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

function getProjectRoot(filePath) {
  try {
    let dir = dirname(filePath);
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, '.git'))) return dir;
      if (existsSync(join(dir, 'package.json'))) return dir;
      if (existsSync(join(dir, 'Cargo.toml'))) return dir;
      if (existsSync(join(dir, 'go.mod'))) return dir;
      if (existsSync(join(dir, 'pyproject.toml'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Session management ──────────────────────────────────────────────────────

function loadSession(sessionId) {
  const sessionFile = join(SESSIONS_DIR, `${sessionId}.json`);
  if (existsSync(sessionFile)) {
    return JSON.parse(readFileSync(sessionFile, 'utf-8'));
  }
  return {
    id: sessionId,
    startedAt: new Date().toISOString(),
    projectRoot: null,
    files: {},
    searches: [],
    tools: {},
    compactions: 0,
    totalReads: 0,
    totalEdits: 0,
    totalSearches: 0,
    totalToolCalls: 0
  };
}

function saveSession(session) {
  const sessionFile = join(SESSIONS_DIR, `${session.id}.json`);
  session.updatedAt = new Date().toISOString();
  writeFileSync(sessionFile, JSON.stringify(session, null, 2));
}

// ── Patterns (project-segmented) ────────────────────────────────────────────

function loadPatterns() {
  if (existsSync(PATTERNS_FILE)) {
    const data = JSON.parse(readFileSync(PATTERNS_FILE, 'utf-8'));
    // Migrate old flat format to project-segmented
    if (data.fileFrequency && !data.projects) {
      return {
        projects: {
          _global: {
            fileFrequency: data.fileFrequency || {},
            wastedReads: data.wastedReads || {},
            coOccurrence: {},
          }
        },
        taskPatterns: data.taskPatterns || {},
        lastUpdated: data.lastUpdated
      };
    }
    return data;
  }
  return {
    projects: {},
    taskPatterns: {},
    lastUpdated: null
  };
}

function getProjectPatterns(patterns, projectRoot) {
  const key = projectRoot || '_global';
  if (!patterns.projects[key]) {
    patterns.projects[key] = {
      fileFrequency: {},
      wastedReads: {},
      coOccurrence: {},
    };
  }
  return patterns.projects[key];
}

function savePatterns(patterns) {
  patterns.lastUpdated = new Date().toISOString();
  writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
}

// ── Global stats ────────────────────────────────────────────────────────────

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
    sessionHistory: []
  };
}

function saveGlobalStats(stats) {
  writeFileSync(GLOBAL_STATS_FILE, JSON.stringify(stats, null, 2));
}

// ── Tracking functions ──────────────────────────────────────────────────────

function trackRead(session, filePath, lineCount, readOptions = {}) {
  if (shouldIgnore(filePath)) return { ignored: true };

  const ext = extname(filePath);
  const tokens = estimateTokens(lineCount, ext);
  const isPartial = !!(readOptions.offset || readOptions.limit);

  if (!session.files[filePath]) {
    session.files[filePath] = {
      reads: 0,
      edits: 0,
      lines: lineCount,
      estTokens: tokens,
      firstRead: new Date().toISOString(),
      lastUse: null,
      wasEdited: false,
      wasReferencedInOutput: false,
      partialReads: 0,
      fullReads: 0,
    };
  }

  const file = session.files[filePath];
  file.reads++;
  file.lastUse = new Date().toISOString();
  file.lines = lineCount;
  file.estTokens = tokens;

  if (isPartial) {
    file.partialReads++;
  } else {
    file.fullReads++;
  }

  session.totalReads++;

  // Detect project root from first file read
  if (!session.projectRoot) {
    session.projectRoot = getProjectRoot(filePath);
  }

  // ── Real-time warnings ──
  const warnings = [];

  // Warn: repeated reads of same file (3+ times, no edits)
  if (file.reads >= 3 && !file.wasEdited) {
    const totalTokensSpent = file.estTokens * file.reads;
    if (file.reads === 3) {
      warnings.push(
        `[cco] ${basename(filePath)} read ${file.reads}x (~${formatTokens(totalTokensSpent)} tokens). ` +
        `Consider offset/limit for specific sections.`
      );
    } else if (file.reads === 5) {
      warnings.push(
        `[cco] ${basename(filePath)} read ${file.reads}x (~${formatTokens(totalTokensSpent)} tokens). ` +
        `Add key parts to CLAUDE.md or memory to avoid re-reads.`
      );
    } else if (file.reads % 5 === 0) {
      warnings.push(
        `[cco] ${basename(filePath)} read ${file.reads}x (~${formatTokens(totalTokensSpent)} tokens) with 0 edits!`
      );
    }
  }

  // Warn: file known as waste from past sessions
  if (file.reads === 1) {
    try {
      const patterns = loadPatterns();
      const proj = getProjectPatterns(patterns, session.projectRoot);
      const wasteData = proj.wastedReads[filePath];
      if (wasteData && wasteData.sessions >= 2) {
        warnings.push(
          `[cco] ${basename(filePath)} was wasted in ${wasteData.sessions} past sessions. Consider skipping.`
        );
      }
    } catch { /* don't block on pattern load failure */ }
  }

  // Warn: large file read fully when partial would suffice
  if (!isPartial && lineCount > 300) {
    warnings.push(
      `[cco] ${basename(filePath)} is ${lineCount} lines. Use offset/limit to read only what you need.`
    );
  }

  // Output warnings to stderr (shown as hook feedback)
  for (const w of warnings) {
    console.error(w);
  }

  return { ignored: false, warnings };
}

function trackEdit(session, filePath) {
  if (shouldIgnore(filePath)) return;

  if (!session.files[filePath]) {
    session.files[filePath] = {
      reads: 0,
      edits: 0,
      lines: 0,
      estTokens: 0,
      firstRead: new Date().toISOString(),
      lastUse: null,
      wasEdited: true,
      wasReferencedInOutput: true,
      partialReads: 0,
      fullReads: 0,
    };
  }

  session.files[filePath].edits++;
  session.files[filePath].wasEdited = true;
  session.files[filePath].wasReferencedInOutput = true;
  session.files[filePath].lastUse = new Date().toISOString();
  session.totalEdits++;

  if (!session.projectRoot) {
    session.projectRoot = getProjectRoot(filePath);
  }
}

function trackSearch(session, pattern, type, resultsCount) {
  session.searches.push({
    pattern,
    type,
    resultsCount: resultsCount || 0,
    ts: new Date().toISOString()
  });
  session.totalSearches++;
}

function trackToolUse(session, toolName) {
  if (!session.tools[toolName]) {
    session.tools[toolName] = { calls: 0 };
  }
  session.tools[toolName].calls++;
  session.totalToolCalls++;
}

// ── Usefulness scoring (weighted, not binary) ───────────────────────────────

function computeUsefulness(fileData) {
  let score = 0;

  // Edited = high value
  score += (fileData.edits || 0) * 3;

  // Multi-read = some value (but diminishing)
  if (fileData.reads > 1) {
    score += Math.min(3, (fileData.reads - 1) * 0.5);
  }

  // Partial reads = smart usage bonus
  if ((fileData.partialReads || 0) > 0) {
    score += 1;
  }

  // Penalty: many reads but no edits on a large file
  if (fileData.reads >= 3 && !fileData.wasEdited && (fileData.lines || 0) > 100) {
    score -= 1;
  }

  return score;
}

// ── Session finalization ────────────────────────────────────────────────────

function finalizeSession(session) {
  const patterns = loadPatterns();
  const globalStats = loadGlobalStats();
  const proj = getProjectPatterns(patterns, session.projectRoot);

  let sessionTokensTotal = 0;
  let sessionTokensWasted = 0;

  const editedFiles = [];
  const allFiles = Object.keys(session.files);

  for (const [filePath, fileData] of Object.entries(session.files)) {
    const tokensUsed = fileData.estTokens * fileData.reads;
    sessionTokensTotal += tokensUsed;

    const usefulness = computeUsefulness(fileData);
    const isUseful = usefulness > 0;

    if (!isUseful && fileData.reads >= 1) {
      sessionTokensWasted += tokensUsed;

      if (!proj.wastedReads[filePath]) {
        proj.wastedReads[filePath] = { count: 0, sessions: 0, totalTokensWasted: 0 };
      }
      proj.wastedReads[filePath].count++;
      proj.wastedReads[filePath].sessions++;
      proj.wastedReads[filePath].totalTokensWasted += tokensUsed;
    }

    // Track frequency
    if (!proj.fileFrequency[filePath]) {
      proj.fileFrequency[filePath] = { sessions: 0, totalReads: 0, totalEdits: 0, usefulness: 0 };
    }
    proj.fileFrequency[filePath].sessions++;
    proj.fileFrequency[filePath].totalReads += fileData.reads;
    proj.fileFrequency[filePath].totalEdits += fileData.edits;
    if (isUseful) {
      proj.fileFrequency[filePath].usefulness++;
    }

    if (fileData.wasEdited) {
      editedFiles.push(filePath);
    }
  }

  // ── Build co-occurrence matrix ──
  // Files edited together in the same session are likely related
  if (editedFiles.length >= 2 && editedFiles.length <= 20) {
    for (let i = 0; i < editedFiles.length; i++) {
      const a = editedFiles[i];
      if (!proj.coOccurrence[a]) proj.coOccurrence[a] = {};

      for (let j = 0; j < editedFiles.length; j++) {
        if (i === j) continue;
        const b = editedFiles[j];
        proj.coOccurrence[a][b] = (proj.coOccurrence[a][b] || 0) + 1;
      }
    }
  }

  // ── Update global stats ──
  globalStats.totalSessions++;
  globalStats.totalTokensTracked += sessionTokensTotal;
  globalStats.estimatedTokensSaved += sessionTokensWasted;
  globalStats.totalFilesRead += session.totalReads;
  globalStats.totalFilesEdited += session.totalEdits;
  globalStats.avgTokensPerSession = Math.round(
    globalStats.totalTokensTracked / globalStats.totalSessions
  );

  globalStats.sessionHistory.push({
    id: session.id,
    date: new Date().toISOString(),
    project: session.projectRoot ? basename(session.projectRoot) : null,
    filesRead: allFiles.length,
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

  // Aggregate top files across all projects
  const allWasted = {};
  const allUseful = {};
  for (const [, projData] of Object.entries(patterns.projects)) {
    for (const [path, data] of Object.entries(projData.wastedReads || {})) {
      if (!allWasted[path] || allWasted[path].totalTokensWasted < data.totalTokensWasted) {
        allWasted[path] = data;
      }
    }
    for (const [path, data] of Object.entries(projData.fileFrequency || {})) {
      if (data.usefulness > 0) {
        if (!allUseful[path] || allUseful[path].usefulness < data.usefulness) {
          allUseful[path] = data;
        }
      }
    }
  }

  globalStats.topWastedFiles = Object.entries(allWasted)
    .sort((a, b) => b[1].totalTokensWasted - a[1].totalTokensWasted)
    .slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  globalStats.topUsefulFiles = Object.entries(allUseful)
    .filter(([, data]) => data.usefulness > 0)
    .sort((a, b) => b[1].usefulness - a[1].usefulness)
    .slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  savePatterns(patterns);
  saveGlobalStats(globalStats);
  saveSession(session);

  return { sessionTokensTotal, sessionTokensWasted };
}

// ── Rebuild global stats ────────────────────────────────────────────────────

function rebuildGlobalStats() {
  const sessionFiles = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  if (sessionFiles.length === 0) return;

  const patterns = { projects: {}, taskPatterns: {}, lastUpdated: null };
  const globalStats = {
    totalSessions: 0, totalTokensTracked: 0, estimatedTokensSaved: 0,
    totalFilesRead: 0, totalFilesEdited: 0, avgTokensPerSession: 0,
    topWastedFiles: [], topUsefulFiles: [], sessionHistory: []
  };

  for (const file of sessionFiles) {
    try {
      const session = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
      const projKey = session.projectRoot || '_global';
      if (!patterns.projects[projKey]) {
        patterns.projects[projKey] = { fileFrequency: {}, wastedReads: {}, coOccurrence: {} };
      }
      const proj = patterns.projects[projKey];

      let sessionTokensTotal = 0;
      let sessionTokensWasted = 0;

      for (const [filePath, fileData] of Object.entries(session.files || {})) {
        if (shouldIgnore(filePath)) continue;

        const tokensUsed = (fileData.estTokens || 0) * (fileData.reads || 1);
        sessionTokensTotal += tokensUsed;
        const usefulness = computeUsefulness(fileData);
        const isUseful = usefulness > 0;

        if (!isUseful && (fileData.reads || 0) >= 1) {
          sessionTokensWasted += tokensUsed;
          if (!proj.wastedReads[filePath]) {
            proj.wastedReads[filePath] = { count: 0, sessions: 0, totalTokensWasted: 0 };
          }
          proj.wastedReads[filePath].count++;
          proj.wastedReads[filePath].sessions++;
          proj.wastedReads[filePath].totalTokensWasted += tokensUsed;
        }

        if (!proj.fileFrequency[filePath]) {
          proj.fileFrequency[filePath] = { sessions: 0, totalReads: 0, totalEdits: 0, usefulness: 0 };
        }
        proj.fileFrequency[filePath].sessions++;
        proj.fileFrequency[filePath].totalReads += fileData.reads || 0;
        proj.fileFrequency[filePath].totalEdits += fileData.edits || 0;
        if (isUseful) proj.fileFrequency[filePath].usefulness++;
      }

      globalStats.totalSessions++;
      globalStats.totalTokensTracked += sessionTokensTotal;
      globalStats.estimatedTokensSaved += sessionTokensWasted;
      globalStats.totalFilesRead += session.totalReads || 0;
      globalStats.totalFilesEdited += session.totalEdits || 0;

      globalStats.sessionHistory.push({
        id: session.id, date: session.startedAt || new Date().toISOString(),
        project: session.projectRoot ? basename(session.projectRoot) : null,
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

  // Aggregate top files
  const allWasted = {};
  const allUseful = {};
  for (const [, projData] of Object.entries(patterns.projects)) {
    for (const [path, data] of Object.entries(projData.wastedReads || {})) {
      if (!allWasted[path] || allWasted[path].totalTokensWasted < data.totalTokensWasted) allWasted[path] = data;
    }
    for (const [path, data] of Object.entries(projData.fileFrequency || {})) {
      if (data.usefulness > 0 && (!allUseful[path] || allUseful[path].usefulness < data.usefulness)) allUseful[path] = data;
    }
  }

  globalStats.topWastedFiles = Object.entries(allWasted)
    .sort((a, b) => b[1].totalTokensWasted - a[1].totalTokensWasted).slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  globalStats.topUsefulFiles = Object.entries(allUseful)
    .sort((a, b) => b[1].usefulness - a[1].usefulness).slice(0, 20)
    .map(([path, data]) => ({ path: basename(path), fullPath: path, ...data }));

  savePatterns(patterns);
  saveGlobalStats(globalStats);
}

// ── Compact heatmap with actionable recommendations ─────────────────────────

function generateHeatmap(session) {
  const files = Object.entries(session.files)
    .filter(([path]) => !shouldIgnore(path))
    .sort((a, b) => b[1].estTokens * b[1].reads - a[1].estTokens * a[1].reads);

  if (files.length === 0) return 'No files tracked in this session.';

  const maxTokens = Math.max(...files.map(([, d]) => d.estTokens * d.reads));
  const barWidth = 30;

  let totalTokens = 0;
  let wastedTokens = 0;
  let totalPartialReads = 0;
  let totalFullReads = 0;
  const wasteFiles = [];
  const heavyRereadFiles = [];

  // ── Compact table ──
  let output = '\n  CONTEXT HEATMAP\n';
  output += '  ' + '='.repeat(70) + '\n';
  output += '  File'.padEnd(33) + 'Tokens'.padStart(7) + ' Rds Eds  Impact\n';
  output += '  ' + '-'.repeat(70) + '\n';

  for (const [filePath, data] of files) {
    const totalTok = data.estTokens * data.reads;
    totalTokens += totalTok;
    const usefulness = computeUsefulness(data);
    const isUseful = usefulness > 0;

    if (!isUseful) {
      wastedTokens += totalTok;
      wasteFiles.push({ name: basename(filePath), tokens: totalTok, reads: data.reads });
    }
    if (data.reads >= 3 && !data.wasEdited) {
      heavyRereadFiles.push({ name: basename(filePath), tokens: totalTok, reads: data.reads });
    }

    totalPartialReads += data.partialReads || 0;
    totalFullReads += data.fullReads || 0;

    const barLen = Math.max(1, Math.round((totalTok / maxTokens) * barWidth));
    const bar = isUseful ? '\u2588'.repeat(barLen) : '\u2591'.repeat(barLen);
    const icon = data.wasEdited ? '\u270F' : (data.reads > 1 ? '\u2714' : '\u26A0');
    const name = basename(filePath).substring(0, 28);
    const partial = (data.partialReads || 0) > 0 ? '\u2197' : ' ';

    output += `  ${icon}${partial}${name.padEnd(30)} ${formatTokens(totalTok).padStart(6)} ${String(data.reads).padStart(3)} ${String(data.edits).padStart(3)}  ${bar}\n`;
  }

  const wastePercent = totalTokens > 0 ? Math.round((wastedTokens / totalTokens) * 100) : 0;
  const partialPercent = (totalPartialReads + totalFullReads) > 0 ?
    Math.round((totalPartialReads / (totalPartialReads + totalFullReads)) * 100) : 0;

  // ── Summary line ──
  output += '  ' + '-'.repeat(70) + '\n';
  output += `  ${formatTokens(totalTokens)} total | ${formatTokens(wastedTokens)} waste (${wastePercent}%) | ${partialPercent}% partial reads\n`;

  // ── Actionable recommendations ──
  output += '\n  ACTIONS\n';
  output += '  ' + '-'.repeat(70) + '\n';

  if (wasteFiles.length > 0) {
    const topWaste = wasteFiles.sort((a, b) => b.tokens - a.tokens).slice(0, 3);
    for (const f of topWaste) {
      output += `  \u2717 Skip ${f.name} (${formatTokens(f.tokens)} wasted, ${f.reads} read${f.reads > 1 ? 's' : ''}, 0 edits)\n`;
    }
  }

  if (heavyRereadFiles.length > 0) {
    for (const f of heavyRereadFiles.slice(0, 2)) {
      output += `  \u21BB ${f.name}: ${f.reads} re-reads \u2192 add to memory/CLAUDE.md\n`;
    }
  }

  if (partialPercent < 20 && totalTokens > 10000) {
    output += `  \u2197 Only ${partialPercent}% partial reads. Use offset/limit on large files.\n`;
  }

  if (wastePercent <= 15) {
    output += `  \u2713 Efficient session (${wastePercent}% waste). Nice work.\n`;
  }

  output += '\n  \u270F=edited  \u2714=multi-read  \u26A0=waste  \u2197=partial read\n';
  return output;
}

// ── Smart suggestions ───────────────────────────────────────────────────────

function generateSuggestions(cwd) {
  const patterns = loadPatterns();
  const globalStats = loadGlobalStats();

  const suggestions = { preload: [], avoid: [], coRelated: [], tips: [] };

  // Find matching project
  let proj = null;
  for (const [key, data] of Object.entries(patterns.projects)) {
    if (cwd.startsWith(key) || key === '_global') {
      proj = data;
      break;
    }
  }
  if (!proj) proj = getProjectPatterns(patterns, cwd);

  // Files that are almost always useful
  for (const [filePath, data] of Object.entries(proj.fileFrequency)) {
    if (filePath.startsWith(cwd) && data.usefulness >= 2 && data.totalEdits > 0) {
      suggestions.preload.push({
        file: filePath,
        reason: `Edited in ${data.totalEdits}/${data.sessions} sessions`,
        confidence: Math.min(100, Math.round((data.usefulness / data.sessions) * 100))
      });
    }
  }

  // Files frequently wasted
  for (const [filePath, data] of Object.entries(proj.wastedReads)) {
    if (data.sessions >= 2 && data.totalTokensWasted > 500) {
      suggestions.avoid.push({
        file: filePath,
        reason: `Wasted in ${data.sessions} sessions (~${formatTokens(data.totalTokensWasted)} tokens)`,
        tokensSaveable: data.totalTokensWasted
      });
    }
  }

  // Co-occurrence suggestions: "if you opened X, you probably need Y"
  for (const [filePath, related] of Object.entries(proj.coOccurrence || {})) {
    if (!filePath.startsWith(cwd)) continue;
    const top = Object.entries(related)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, count]) => count >= 2);

    if (top.length > 0) {
      suggestions.coRelated.push({
        file: basename(filePath),
        relatedTo: top.map(([p, c]) => ({ file: basename(p), coSessions: c }))
      });
    }
  }

  // Tips
  if (globalStats.totalSessions > 3) {
    const avgWaste = globalStats.sessionHistory.slice(-10)
      .reduce((sum, s) => sum + s.wastePercent, 0) /
      Math.min(10, globalStats.sessionHistory.length);

    if (avgWaste > 30) {
      suggestions.tips.push(
        `Average waste is ${Math.round(avgWaste)}%. Use Grep/Glob to find files before reading.`
      );
    }

    if (globalStats.avgTokensPerSession > 50000) {
      suggestions.tips.push(
        `Avg session: ~${formatTokens(globalStats.avgTokensPerSession)} tokens. Consider task splitting.`
      );
    }
  }

  suggestions.preload.sort((a, b) => b.confidence - a.confidence);
  suggestions.avoid.sort((a, b) => b.tokensSaveable - a.tokensSaveable);

  return suggestions;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// ── Main entry ──────────────────────────────────────────────────────────────

async function main() {
  const action = process.argv[2];

  if (action === 'report') {
    if (!existsSync(GLOBAL_STATS_FILE)) rebuildGlobalStats();
    console.log(JSON.stringify(loadGlobalStats(), null, 2));
    return;
  }

  if (action === 'patterns') {
    console.log(JSON.stringify(loadPatterns(), null, 2));
    return;
  }

  if (action === 'session-report') {
    const sessionId = process.argv[3];
    if (!sessionId) { console.error('Usage: tracker session-report <session-id>'); process.exit(1); }
    console.log(JSON.stringify(loadSession(sessionId), null, 2));
    return;
  }

  if (action === 'heatmap') {
    let sessionId = process.argv[3];
    if (!sessionId) {
      const sessionFiles = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      if (sessionFiles.length === 0) { console.log('No sessions tracked yet.'); return; }
      const sorted = sessionFiles
        .map(f => ({ name: f, mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      sessionId = sorted[0].name.replace('.json', '');
    }
    console.log(generateHeatmap(loadSession(sessionId)));
    return;
  }

  if (action === 'suggest') {
    const cwd = process.argv[3] || process.cwd();
    console.log(JSON.stringify(generateSuggestions(cwd), null, 2));
    return;
  }

  // Default: read hook event from stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) process.exit(0);

  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }

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
        trackRead(session, filePath, lineCount, {
          offset: toolInput.offset,
          limit: toolInput.limit,
        });
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
      break;
    }

    case 'PreCompact': {
      session.compactions++;
      break;
    }

    case 'SessionEnd': {
      const result = finalizeSession(session);
      const wastePercent = result.sessionTokensTotal > 0 ?
        Math.round((result.sessionTokensWasted / result.sessionTokensTotal) * 100) : 0;
      console.error(
        `[cco] Session: ~${formatTokens(result.sessionTokensTotal)} tracked, ` +
        `~${formatTokens(result.sessionTokensWasted)} wasted (${wastePercent}%). ` +
        `${Object.keys(session.files).length} files, ${session.totalEdits} edits.`
      );
      break;
    }

    default:
      break;
  }

  saveSession(session);
  process.exit(0);
}

main().catch(err => {
  console.error(`[cco] Error: ${err.message}`);
  process.exit(0);
});
