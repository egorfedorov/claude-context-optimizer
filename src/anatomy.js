#!/usr/bin/env node

/**
 * Project Anatomy Generator
 *
 * Generates a compact PROJECT_ANATOMY.md to stdout so Claude can
 * understand the codebase without opening every file.
 *
 * Usage: node src/anatomy.js /path/to/project
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join, extname, basename, relative } from 'path';
import {
  estimateTokens, formatTokens,
  categorizeFile, shouldSkipFile, SKIP_DIRS
} from './utils.js';

// Backwards-compatible local aliases.
const categorize = categorizeFile;
const shouldSkip = shouldSkipFile;

// ── File listing ────────────────────────────────────────────────────────────

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10000 }).trimEnd();
  } catch {
    return '';
  }
}

function getFileList(projectDir) {
  // Prefer git ls-files for .gitignore awareness
  const isGit = run('git rev-parse --is-inside-work-tree', projectDir) === 'true';
  if (isGit) {
    const tracked = run('git ls-files', projectDir);
    const untracked = run('git ls-files --others --exclude-standard', projectDir);
    const all = [tracked, untracked].filter(Boolean).join('\n');
    return all.split('\n').filter(Boolean);
  }
  // Manual walk fallback
  return walkDir(projectDir, projectDir);
}

function walkDir(dir, root) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        results.push(...walkDir(fullPath, root));
      }
    } else {
      results.push(relative(root, fullPath));
    }
  }
  return results;
}

// ── Line counting ───────────────────────────────────────────────────────────

function countLines(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function generateAnatomy(projectDir) {
  const projectName = basename(projectDir);
  const files = getFileList(projectDir);

  // Gather file info
  const entries = [];
  for (const relPath of files) {
    if (shouldSkip(relPath)) continue;
    const fullPath = join(projectDir, relPath);
    const lines = countLines(fullPath);
    if (lines === 0) continue;

    const ext = extname(relPath);
    const tokens = estimateTokens(lines, ext);
    const type = categorize(relPath);
    entries.push({ path: relPath, lines, tokens, type });
  }

  // Sort by tokens descending within each category
  entries.sort((a, b) => b.tokens - a.tokens);

  // Category totals
  const cats = {};
  for (const e of entries) {
    if (!cats[e.type]) cats[e.type] = { files: 0, tokens: 0 };
    cats[e.type].files++;
    cats[e.type].tokens += e.tokens;
  }

  const totalTokens = entries.reduce((s, e) => s + e.tokens, 0);
  const date = new Date().toISOString().slice(0, 10);

  // Build output
  let out = '';
  out += `# Project Anatomy: ${projectName}\n`;
  out += `Generated: ${date} | ${entries.length} files | ~${formatTokens(totalTokens)} tokens if all read\n\n`;

  // Structure table — sorted by category then tokens descending
  const categoryOrder = ['source', 'config', 'test', 'docs', 'style', 'other'];
  const sorted = [...entries].sort((a, b) => {
    const ai = categoryOrder.indexOf(a.type);
    const bi = categoryOrder.indexOf(b.type);
    if (ai !== bi) return ai - bi;
    return b.tokens - a.tokens;
  });

  out += `## Structure\n`;
  out += `| Path | Lines | ~Tokens | Type |\n`;
  out += `|------|-------|---------|------|\n`;
  for (const e of sorted) {
    out += `| ${e.path} | ${e.lines} | ${formatTokens(e.tokens)} | ${e.type} |\n`;
  }

  // Summary
  out += `\n## Summary\n`;
  for (const cat of categoryOrder) {
    if (cats[cat]) {
      out += `- ${cat.charAt(0).toUpperCase() + cat.slice(1)}: ${cats[cat].files} files, ~${formatTokens(cats[cat].tokens)} tokens\n`;
    }
  }

  // Heaviest files (>500 lines)
  const heavy = entries.filter(e => e.lines > 500).sort((a, b) => b.lines - a.lines);
  if (heavy.length > 0) {
    out += `\n## Heaviest files (read these with offset/limit)\n`;
    heavy.forEach((e, i) => {
      out += `${i + 1}. ${e.path} — ${e.lines} lines (~${formatTokens(e.tokens)} tokens)\n`;
    });
  }

  return out;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

const projectDir = process.argv[2];
if (!projectDir) {
  console.error('Usage: node src/anatomy.js /path/to/project');
  process.exit(1);
}

try {
  const output = generateAnatomy(projectDir);
  process.stdout.write(output);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
