#!/usr/bin/env node

/**
 * Git-Aware Context Suggester
 *
 * Analyzes git status/diff to suggest which files Claude should read
 * for the current task. Runs on SessionStart hook.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.claude-context-optimizer');
const PATTERNS_FILE = join(DATA_DIR, 'patterns.json');

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

function isGitRepo(cwd) {
  return run('git rev-parse --is-inside-work-tree', cwd) === 'true';
}

function getGitContext(cwd) {
  if (!isGitRepo(cwd)) return null;

  const branch = run('git branch --show-current', cwd);
  const status = run('git status --porcelain', cwd);
  const recentCommits = run('git log --oneline -5 2>/dev/null', cwd);
  const diffFiles = run('git diff --name-only HEAD 2>/dev/null', cwd);
  const stagedFiles = run('git diff --cached --name-only 2>/dev/null', cwd);
  const untrackedFiles = run('git ls-files --others --exclude-standard 2>/dev/null', cwd);

  // Parse modified files
  const modifiedFiles = status.split('\n')
    .filter(l => l.trim())
    .map(l => ({
      status: l.substring(0, 2).trim(),
      file: l.substring(3).trim()
    }));

  // Find related files (tests, configs, imports)
  const relatedFiles = new Set();
  for (const { file } of modifiedFiles) {
    const ext = extname(file);
    const dir = dirname(file);
    const base = file.replace(ext, '');

    // Test file
    relatedFiles.add(`${base}.test${ext}`);
    relatedFiles.add(`${base}.spec${ext}`);
    relatedFiles.add(`${dir}/__tests__/${file.split('/').pop()}`);

    // Config files in same directory
    const configs = ['package.json', 'tsconfig.json', '.eslintrc', 'Makefile', 'CMakeLists.txt'];
    for (const cfg of configs) {
      const cfgPath = join(dir, cfg);
      if (existsSync(join(cwd, cfgPath))) {
        relatedFiles.add(cfgPath);
      }
    }
  }

  return {
    branch,
    modifiedFiles,
    recentCommits: recentCommits.split('\n').filter(Boolean),
    diffFiles: diffFiles.split('\n').filter(Boolean),
    stagedFiles: stagedFiles.split('\n').filter(Boolean),
    untrackedFiles: untrackedFiles.split('\n').filter(Boolean),
    relatedFiles: [...relatedFiles].filter(f => existsSync(join(cwd, f)))
  };
}

function getHistoricalSuggestions(cwd) {
  if (!existsSync(PATTERNS_FILE)) return [];

  const patterns = JSON.parse(readFileSync(PATTERNS_FILE, 'utf-8'));
  const suggestions = [];

  for (const [filePath, data] of Object.entries(patterns.fileFrequency || {})) {
    if (filePath.startsWith(cwd) && data.usefulness >= 2 && data.totalEdits > 0) {
      suggestions.push({
        file: filePath.replace(cwd + '/', ''),
        score: data.usefulness,
        reason: `edited ${data.totalEdits}x across ${data.sessions} sessions`
      });
    }
  }

  return suggestions.sort((a, b) => b.score - a.score).slice(0, 5);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let cwd = process.cwd();
  if (input.trim()) {
    try {
      const event = JSON.parse(input);
      cwd = event.cwd || cwd;
    } catch {
      // use default cwd
    }
  }

  const gitContext = getGitContext(cwd);
  const historical = getHistoricalSuggestions(cwd);

  const result = {
    cwd,
    isGitRepo: !!gitContext,
    git: gitContext,
    historicalSuggestions: historical,
    summary: ''
  };

  // Build human-readable summary
  if (gitContext) {
    const parts = [];

    if (gitContext.branch) {
      parts.push(`Branch: ${gitContext.branch}`);
    }

    if (gitContext.modifiedFiles.length > 0) {
      parts.push(`${gitContext.modifiedFiles.length} modified file(s): ${gitContext.modifiedFiles.map(f => f.file).join(', ')}`);
    }

    if (gitContext.stagedFiles.length > 0) {
      parts.push(`${gitContext.stagedFiles.length} staged for commit`);
    }

    if (gitContext.relatedFiles.length > 0) {
      parts.push(`Related files found: ${gitContext.relatedFiles.join(', ')}`);
    }

    if (historical.length > 0) {
      parts.push(`Frequently useful: ${historical.map(h => h.file).join(', ')}`);
    }

    result.summary = parts.join(' | ');
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch(() => process.exit(0));
