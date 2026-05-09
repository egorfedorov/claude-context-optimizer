#!/usr/bin/env node

/**
 * Smart Context Pack v1.0
 *
 * Given a task description (or no description — uses git state instead),
 * proposes the OPTIMAL set of files to load, ranked by relevance, with
 * suggested offset/limit ranges and a token budget.
 *
 * Inputs:
 *   - Task description (free text, optional)
 *   - Current working directory (auto)
 *   - Git diff / git log (auto)
 *   - Historical patterns (~/.claude-context-optimizer/patterns.json)
 *   - File structure landmarks (parsed on the fly for top picks)
 *
 * Output:
 *   - JSON or pretty-printed list of files with:
 *       path, reason, relevance, suggestedOffset, suggestedLimit, tokens
 *
 * Usage:
 *   node src/smart-pack.js "fix login bug in src/auth"
 *   node src/smart-pack.js --json "..."
 */

import { execSync } from 'child_process';
import { existsSync, statSync, readFileSync } from 'fs';
import { join, basename, extname, dirname } from 'path';
import {
  PATTERNS_FILE, loadJSON, formatTokens, estimateTokens,
  computeUsefulness, computeConfidence, getEffectiveBudget, loadConfig,
  shouldSkipFile
} from './utils.js';
import { parseFileStructure } from './file-digest.js';

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
  } catch {
    return '';
  }
}

function isGitRepo(cwd) {
  return run('git rev-parse --is-inside-work-tree', cwd) === 'true';
}

function getGitChangedFiles(cwd) {
  if (!isGitRepo(cwd)) return [];
  const out = run('git status --porcelain', cwd);
  return out.split('\n').filter(Boolean).map(l => l.slice(3).trim());
}

/** Extract candidate file paths from a task description. */
function extractMentionedPaths(task, cwd) {
  if (!task) return [];
  const FILE_RE = /(?:[a-zA-Z0-9_./-]*\/)?[a-zA-Z0-9_-]+\.[a-zA-Z]{1,8}\b/g;
  const candidates = [...new Set(task.match(FILE_RE) || [])];
  const real = [];
  for (const c of candidates) {
    if (c.startsWith('http') || c.endsWith('.com') || c.endsWith('.io')) continue;
    if (existsSync(c)) { real.push(c); continue; }
    const abs = join(cwd, c);
    if (existsSync(abs)) { real.push(abs); continue; }
    // try basename match against git ls-files
    const matches = run(`git ls-files | grep -F "${c.replace(/"/g, '\\"')}"`, cwd)
      .split('\n').filter(Boolean).slice(0, 3);
    for (const m of matches) {
      const mAbs = join(cwd, m);
      if (existsSync(mAbs)) real.push(mAbs);
    }
  }
  return [...new Set(real)];
}

/** Extract keywords for grep-like matching against file paths. */
function extractKeywords(task) {
  if (!task) return [];
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w))
    .slice(0, 12);
}

const STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'should',
  'would', 'could', 'have', 'when', 'while', 'about', 'just', 'need',
  'want', 'make', 'work', 'works', 'thing', 'something', 'better',
  'change', 'changes', 'task', 'please', 'fix', 'bug', 'feature',
]);

function findFilesByKeywords(cwd, keywords, limit = 12) {
  if (!isGitRepo(cwd) || keywords.length === 0) return [];
  const all = run('git ls-files', cwd).split('\n').filter(Boolean);
  const scored = [];
  for (const f of all) {
    if (shouldSkipFile(f)) continue;
    let score = 0;
    const lower = f.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) score += basename(lower) === kw ? 5 : 2;
    }
    if (score > 0) scored.push({ file: join(cwd, f), score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function findHistoricallyUseful(cwd, limit = 8) {
  const patterns = loadJSON(PATTERNS_FILE) || { projects: {} };
  const candidates = [];
  for (const [projKey, proj] of Object.entries(patterns.projects || {})) {
    if (projKey !== '_global' && !cwd.startsWith(projKey)) continue;
    for (const [path, data] of Object.entries(proj.fileFrequency || {})) {
      if (data.usefulness < 2 || (data.totalEdits || 0) === 0) continue;
      const daysSince = data.lastSeen
        ? Math.round((Date.now() - new Date(data.lastSeen)) / 86400000)
        : 30;
      const confidence = computeConfidence(data, daysSince);
      candidates.push({ file: path, confidence, sessions: data.sessions, edits: data.totalEdits });
    }
  }
  return candidates
    .filter(c => existsSync(c.file))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * For each candidate, suggest an offset/limit window — we point to the most
 * structurally relevant section based on landmark density near keywords.
 */
function suggestRange(filePath, keywords) {
  try {
    const stat = statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) return null;
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const total = lines.length;
    if (total <= 200) return { offset: 0, limit: total, full: true };

    const landmarks = parseFileStructure(filePath);
    if (landmarks.length === 0) return { offset: 0, limit: 200, full: false };

    // Score each landmark by keyword proximity in surrounding ±10 lines.
    const scored = landmarks.map(lm => {
      const start = Math.max(0, lm.line - 10);
      const end = Math.min(total, lm.line + 30);
      const slice = lines.slice(start, end).join('\n').toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (slice.includes(kw)) score += 1;
      }
      // Prefer functions/classes over imports
      if (/import|module\.exports/.test(lm.label)) score -= 0.5;
      return { lm, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const top = scored[0];
    if (!top || top.score === 0) {
      // No keyword match — return file map only (offset 0, small limit)
      return { offset: 0, limit: 80, full: false, hint: 'no keyword match — peek only' };
    }
    const offset = Math.max(0, top.lm.line - 10);
    const limit = 100;
    return { offset, limit, full: false, around: top.lm.label };
  } catch {
    return null;
  }
}

// ── Main composition ─────────────────────────────────────────────────────────

export function buildPack(task, cwd) {
  const keywords = extractKeywords(task);
  const mentioned = extractMentionedPaths(task, cwd);
  const changed = getGitChangedFiles(cwd).map(f => join(cwd, f)).filter(existsSync);
  const historic = findHistoricallyUseful(cwd, 6);
  const keywordHits = findFilesByKeywords(cwd, keywords, 10);

  // Merge with priorities: mentioned > changed > historic > keyword
  const seen = new Set();
  const items = [];

  for (const f of mentioned) {
    if (seen.has(f) || shouldSkipFile(f)) continue;
    seen.add(f);
    items.push({ file: f, reason: 'mentioned in prompt', relevance: 100 });
  }
  for (const f of changed) {
    if (seen.has(f) || shouldSkipFile(f)) continue;
    seen.add(f);
    items.push({ file: f, reason: 'modified in git working tree', relevance: 85 });
  }
  for (const h of historic) {
    if (seen.has(h.file)) continue;
    seen.add(h.file);
    items.push({
      file: h.file,
      reason: `historically useful (edited in ${h.edits}/${h.sessions} sessions)`,
      relevance: Math.round(70 * h.confidence),
    });
  }
  for (const k of keywordHits) {
    if (seen.has(k.file)) continue;
    seen.add(k.file);
    items.push({
      file: k.file,
      reason: `matches task keywords (score ${k.score})`,
      relevance: 30 + Math.min(40, k.score * 3),
    });
  }

  // For each item, suggest a range and estimate tokens.
  const enriched = items.map(it => {
    const range = suggestRange(it.file, keywords) || { offset: 0, limit: 200, full: false };
    const ext = extname(it.file);
    const tokens = estimateTokens(range.limit, ext);
    return { ...it, ...range, tokens, ext };
  });

  enriched.sort((a, b) => b.relevance - a.relevance);

  // Honour budget — stop adding files once we'd consume >25% of effective budget.
  const config = loadConfig();
  const budget = getEffectiveBudget(config);
  const cap = Math.round(budget * 0.25);
  let running = 0;
  const final = [];
  for (const it of enriched) {
    if (running + it.tokens > cap && final.length >= 3) break;
    final.push(it);
    running += it.tokens;
  }

  return {
    task,
    cwd,
    keywords,
    files: final,
    totalEstTokens: running,
    budget,
    capUsedPercent: Math.round((running / cap) * 100),
  };
}

function formatPack(pack, asJson) {
  if (asJson) return JSON.stringify(pack, null, 2);

  const out = [];
  out.push('');
  out.push('  SMART CONTEXT PACK');
  out.push('  ' + '─'.repeat(70));
  out.push(`  Task: ${pack.task ? pack.task.slice(0, 80) : '(none — using git state)'}`);
  out.push(`  Files proposed: ${pack.files.length}`);
  out.push(`  Est. tokens: ${formatTokens(pack.totalEstTokens)} (${pack.capUsedPercent}% of context budget cap)`);
  if (pack.keywords.length > 0) out.push(`  Keywords: ${pack.keywords.join(', ')}`);
  out.push('');
  out.push('  Read these in order:');
  for (let i = 0; i < pack.files.length; i++) {
    const f = pack.files[i];
    const rel = f.file.replace(pack.cwd + '/', '');
    out.push('');
    out.push(`  ${i + 1}. ${rel}  (relevance ${f.relevance}, ~${formatTokens(f.tokens)} tokens)`);
    out.push(`     reason: ${f.reason}`);
    if (f.full) {
      out.push(`     read: full file (${f.limit} lines)`);
    } else {
      const around = f.around ? ` — around ${f.around}` : '';
      const hint = f.hint ? ` (${f.hint})` : '';
      out.push(`     read: offset=${f.offset}, limit=${f.limit}${around}${hint}`);
    }
  }
  out.push('');
  out.push('  Tip: pass these to Claude as context, or apply via /cco-templates.');
  out.push('');
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const task = args.filter(a => !a.startsWith('--')).join(' ');
  const cwd = process.cwd();

  const pack = buildPack(task, cwd);
  console.log(formatPack(pack, asJson));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
