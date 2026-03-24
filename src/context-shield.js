#!/usr/bin/env node

/**
 * ContextShield v1.0
 *
 * PreToolUse hook that protects against wasteful file reads.
 * Checks historical patterns and warns before loading known-waste files.
 * Suggests alternatives: Grep instead of Read, offset/limit for large files.
 */

import { basename, extname } from 'path';
import {
  PATTERNS_FILE, SESSIONS_DIR,
  estimateTokens, formatTokens, loadJSON, ensureDataDirs
} from './utils.js';

ensureDataDirs();

function loadPatterns() {
  return loadJSON(PATTERNS_FILE) || { projects: {}, taskPatterns: {}, lastUpdated: null };
}

function getProjectPatterns(patterns, projectRoot) {
  const key = projectRoot || '_global';
  return patterns.projects[key] || { fileFrequency: {}, wastedReads: {}, coOccurrence: {} };
}

function findProjectForPath(patterns, filePath) {
  for (const key of Object.keys(patterns.projects)) {
    if (key !== '_global' && filePath.startsWith(key)) {
      return key;
    }
  }
  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) process.exit(0);

  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }

  if (event.hook_event_name !== 'PreToolUse') process.exit(0);

  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};

  // Only shield Read operations
  if (toolName !== 'Read') process.exit(0);

  const filePath = toolInput.file_path || '';
  if (!filePath || filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) process.exit(0);

  const patterns = loadPatterns();
  const projectRoot = findProjectForPath(patterns, filePath);
  const proj = getProjectPatterns(patterns, projectRoot);

  const warnings = [];
  let shouldBlock = false;

  // ── Check 1: Known waste file (3+ sessions wasted) ──
  const wasteData = proj.wastedReads[filePath];
  if (wasteData && wasteData.sessions >= 5) {
    warnings.push(
      `[context-shield] ${basename(filePath)} was WASTED in ${wasteData.sessions} sessions ` +
      `(~${formatTokens(wasteData.totalTokensWasted)} tokens burned). ` +
      `Use Grep to find specific content instead of full Read.`
    );
  } else if (wasteData && wasteData.sessions >= 3) {
    warnings.push(
      `[context-shield] ${basename(filePath)} was unused in ${wasteData.sessions} past sessions. ` +
      `Consider: do you really need the full file? Try Grep or offset/limit.`
    );
  }

  // ── Check 2: Large file without offset/limit ──
  const isPartial = !!(toolInput.offset || toolInput.limit);
  if (!isPartial) {
    const freqData = proj.fileFrequency[filePath];
    if (freqData && freqData.sessions >= 2) {
      const editRate = freqData.totalEdits / freqData.totalReads;
      if (editRate < 0.1 && freqData.totalReads >= 5) {
        warnings.push(
          `[context-shield] ${basename(filePath)}: read ${freqData.totalReads}x across ${freqData.sessions} sessions ` +
          `but edited only ${freqData.totalEdits}x. Use offset/limit to read only the section you need.`
        );
      }
    }
  }

  // ── Check 3: File frequently read with co-occurring files ──
  if (proj.coOccurrence[filePath]) {
    const related = Object.entries(proj.coOccurrence[filePath])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, count]) => count >= 3);

    if (related.length > 0) {
      const names = related.map(([p]) => basename(p)).join(', ');
      warnings.push(
        `[context-shield] ${basename(filePath)} is usually edited with: ${names}. ` +
        `Consider loading them together.`
      );
    }
  }

  // Output warnings
  for (const w of warnings) {
    console.error(w);
  }

  // ContextShield never blocks — only warns
  // Output empty JSON to allow the operation
  process.exit(0);
}

main().catch(() => process.exit(0));
