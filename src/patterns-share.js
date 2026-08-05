#!/usr/bin/env node

/**
 * Cross-project / team pattern sharing — #37
 *
 * Patterns (which files are usually waste, usually useful, or edited together)
 * are learned per-machine, per-project. A teammate's fresh clone starts blind
 * and re-learns the same lessons by wasting the same tokens.
 *
 * This makes them portable:
 *   export → a path-relativized, anonymized digest (no absolute paths, no home
 *            directory, no file contents — only counts about relative paths)
 *   import → merged as a SEPARATE prior, never blended into your own counts
 *
 * The separation matters. `confidence` is computed from how many sessions YOU
 * observed a file in. Folding someone else's sessions into that number would
 * make your own confidence a lie. Imported data therefore lives in
 * `proj.imported` and is consulted only where you have no evidence of your own
 * — which is exactly the day-one-on-a-fresh-clone case it exists for.
 *
 * Usage:
 *   node src/patterns-share.js export [--out <file>] [--project <path>]
 *   node src/patterns-share.js import <file> [--project <path>]
 *   node src/patterns-share.js show
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, relative, dirname, isAbsolute } from 'path';
import { homedir } from 'os';
import {
  PATTERNS_FILE, loadJSON, saveJSON, formatTokens, toPosixPath,
  getProjectRoot, isMainModule, acquireFileLock, getDonationMessage,
} from './utils.js';

export const DIGEST_VERSION = 1;
export const DEFAULT_DIGEST_PATH = join('.cco', 'patterns.digest.json');

// ── Pure core (exported for tests) ──────────────────────────────────────────

/**
 * Make a tracked absolute path safe to share.
 *
 * Returns a project-relative POSIX path, or null when the file lives outside
 * the project root. Null is the safe answer: anything we cannot express
 * relative to the project would otherwise leak a home directory, a username,
 * or an unrelated client's directory name into a file people commit.
 */
export function relativizePath(absPath, projectRoot) {
  if (!absPath || !projectRoot) return null;
  const p = toPosixPath(absPath);
  const root = toPosixPath(projectRoot).replace(/\/+$/, '');
  if (!root || !p.startsWith(root + '/')) return null;
  const rel = p.slice(root.length + 1);
  // Defence in depth: no escaping the root, no absolute remainder, and never
  // anything that still looks like a home directory.
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  if (isAbsolute(rel) || rel.includes(toPosixPath(homedir()))) return null;
  return rel;
}

/**
 * Build a portable digest of ONE project's patterns.
 *
 * Carries counts only — never file contents, never absolute paths. Files that
 * cannot be relativized are dropped and reported, so the caller can say what
 * was withheld instead of silently shipping less than the user expects.
 */
export function buildDigest(proj, projectRoot, { minSessions = 2 } = {}) {
  const files = {};
  let dropped = 0;

  for (const [abs, data] of Object.entries((proj && proj.fileFrequency) || {})) {
    const rel = relativizePath(abs, projectRoot);
    if (!rel) { dropped++; continue; }
    // Thin evidence is noise, and noise is what makes people distrust a shared
    // file. Require the file to have been seen in a few sessions.
    if ((data.sessions || 0) < minSessions) continue;
    files[rel] = {
      sessions: data.sessions || 0,
      usefulness: data.usefulness || 0,
      reads: data.totalReads || 0,
      edits: data.totalEdits || 0,
    };
  }

  for (const [abs, w] of Object.entries((proj && proj.wastedReads) || {})) {
    const rel = relativizePath(abs, projectRoot);
    if (!rel) { dropped++; continue; }
    if ((w.sessions || 0) < minSessions) continue;
    files[rel] = {
      ...(files[rel] || { sessions: 0, usefulness: 0, reads: 0, edits: 0 }),
      wastedSessions: w.sessions || 0,
      wastedTokens: w.totalTokensWasted || 0,
    };
  }

  const coOccurrence = {};
  for (const [abs, partners] of Object.entries((proj && proj.coOccurrence) || {})) {
    const rel = relativizePath(abs, projectRoot);
    if (!rel) { dropped++; continue; }
    const out = {};
    for (const [pAbs, count] of Object.entries(partners || {})) {
      const pRel = relativizePath(pAbs, projectRoot);
      if (pRel) out[pRel] = count;
    }
    if (Object.keys(out).length) coOccurrence[rel] = out;
  }

  return {
    digest: {
      version: DIGEST_VERSION,
      generatedAt: new Date().toISOString(),
      files,
      coOccurrence,
    },
    stats: { files: Object.keys(files).length, dropped },
  };
}

/**
 * Assert a digest carries nothing identifying before it is written or merged.
 * Returns a list of problems — empty means clean.
 *
 * Cheap to run and worth running on IMPORT too: the file may have been written
 * by an older version, hand-edited, or produced by someone else entirely.
 */
export function auditDigest(digest) {
  const problems = [];
  const home = toPosixPath(homedir());
  const check = (path, where) => {
    if (isAbsolute(path) || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
      problems.push(`${where}: absolute path "${path}"`);
    } else if (home && path.includes(home)) {
      problems.push(`${where}: home directory leaked in "${path}"`);
    } else if (path.split('/').includes('..')) {
      problems.push(`${where}: path escapes the project root "${path}"`);
    }
  };

  for (const [p, data] of Object.entries((digest && digest.files) || {})) {
    check(p, 'files');
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') problems.push(`files.${p}.${k}: unexpected string content`);
      }
    }
  }
  for (const [p, partners] of Object.entries((digest && digest.coOccurrence) || {})) {
    check(p, 'coOccurrence');
    for (const q of Object.keys(partners || {})) check(q, 'coOccurrence');
  }
  return problems;
}

/**
 * Merge a digest into a project's patterns as a separate prior.
 *
 * Never touches fileFrequency / wastedReads / coOccurrence — your own counts
 * stay exactly as observed. Repeated imports combine by taking the stronger
 * signal, so importing the same digest twice is a no-op rather than a doubling.
 */
export function mergeDigest(proj, digest) {
  const prior = (proj && proj.imported) || { files: {}, coOccurrence: {} };
  const files = { ...prior.files };
  const co = { ...prior.coOccurrence };
  let added = 0;
  let updated = 0;

  for (const [rel, d] of Object.entries((digest && digest.files) || {})) {
    const existing = files[rel];
    if (!existing) { files[rel] = { ...d }; added++; continue; }
    files[rel] = {
      sessions: Math.max(existing.sessions || 0, d.sessions || 0),
      usefulness: Math.max(existing.usefulness || 0, d.usefulness || 0),
      reads: Math.max(existing.reads || 0, d.reads || 0),
      edits: Math.max(existing.edits || 0, d.edits || 0),
      wastedSessions: Math.max(existing.wastedSessions || 0, d.wastedSessions || 0),
      wastedTokens: Math.max(existing.wastedTokens || 0, d.wastedTokens || 0),
    };
    updated++;
  }

  for (const [rel, partners] of Object.entries((digest && digest.coOccurrence) || {})) {
    co[rel] = { ...(co[rel] || {}) };
    for (const [q, n] of Object.entries(partners || {})) {
      co[rel][q] = Math.max(co[rel][q] || 0, n);
    }
  }

  return {
    imported: { files, coOccurrence: co, importedAt: new Date().toISOString() },
    stats: { added, updated },
  };
}

/**
 * What the imported prior says about a file — consulted ONLY when the local
 * patterns have no observation of it. Returns null when local evidence exists
 * or the prior has nothing useful, so imported data can never override what
 * this machine actually measured.
 */
export function importedVerdict(proj, absPath, projectRoot) {
  if (!proj || !proj.imported) return null;
  const localSeen = (proj.fileFrequency && proj.fileFrequency[absPath]) ||
                    (proj.wastedReads && proj.wastedReads[absPath]);
  if (localSeen) return null;                       // local evidence always wins
  const rel = relativizePath(absPath, projectRoot);
  if (!rel) return null;
  const d = proj.imported.files[rel];
  if (!d) return null;
  if ((d.wastedSessions || 0) >= 2) {
    return { kind: 'waste', sessions: d.wastedSessions, tokens: d.wastedTokens || 0 };
  }
  if ((d.usefulness || 0) >= 2) {
    return { kind: 'useful', sessions: d.sessions || 0 };
  }
  return null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

function resolveProject() {
  return arg('--project') || getProjectRoot(process.cwd()) || process.cwd();
}

function doExport() {
  const projectRoot = resolveProject();
  const patterns = loadJSON(PATTERNS_FILE);
  const proj = patterns && patterns.projects && patterns.projects[projectRoot];
  if (!proj) {
    console.error(`No tracked patterns for ${projectRoot}.`);
    console.error('Use Claude Code in this project first, then export.');
    process.exitCode = 1;
    return;
  }

  const { digest, stats } = buildDigest(proj, projectRoot);
  const problems = auditDigest(digest);
  if (problems.length) {
    console.error('Refusing to write — the digest failed its privacy audit:');
    for (const p of problems.slice(0, 10)) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }

  const out = arg('--out') || join(projectRoot, DEFAULT_DIGEST_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(digest, null, 2) + '\n');

  console.log(`\n  ✓ Exported ${stats.files} files to ${out}`);
  if (stats.dropped) {
    console.log(`  ${stats.dropped} entries skipped — they live outside the project root`);
    console.log('  (dropping them is what keeps absolute paths out of a file you commit)');
  }
  console.log('\n  Contains: relative paths + counts. No file contents, no absolute paths.');
  console.log('  Safe to commit — teammates get it on clone and run /cco-patterns import.\n');
}

function doImport() {
  const file = process.argv[3];
  if (!file || file.startsWith('--')) {
    console.error('Usage: patterns-share.js import <file> [--project <path>]');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(file)) {
    console.error(`Not found: ${file}`);
    process.exitCode = 1;
    return;
  }

  let digest;
  try {
    digest = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`Could not parse ${file}: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (!digest || digest.version !== DIGEST_VERSION) {
    console.error(`Unsupported digest version ${digest && digest.version} (expected ${DIGEST_VERSION}).`);
    process.exitCode = 1;
    return;
  }

  // Audit on the way IN too — this file came from somewhere else.
  const problems = auditDigest(digest);
  if (problems.length) {
    console.error('Refusing to import — this digest contains identifying paths:');
    for (const p of problems.slice(0, 10)) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }

  const projectRoot = resolveProject();
  const release = acquireFileLock('globals');
  try {
    const patterns = loadJSON(PATTERNS_FILE) || { projects: {}, taskPatterns: {}, lastUpdated: null };
    if (!patterns.projects) patterns.projects = {};
    if (!patterns.projects[projectRoot]) {
      patterns.projects[projectRoot] = { fileFrequency: {}, wastedReads: {}, coOccurrence: {} };
    }
    const proj = patterns.projects[projectRoot];
    const { imported, stats } = mergeDigest(proj, digest);
    proj.imported = imported;
    patterns.lastUpdated = new Date().toISOString();
    saveJSON(PATTERNS_FILE, patterns);

    console.log(`\n  ✓ Imported into ${projectRoot}`);
    console.log(`  ${stats.added} new, ${stats.updated} reinforced`);
    console.log('\n  Stored as a separate prior — your own counts are untouched.');
    console.log('  It fills in only where you have no observations of your own.\n');
  } finally {
    release();
  }
}

function doShow() {
  const projectRoot = resolveProject();
  const patterns = loadJSON(PATTERNS_FILE);
  const proj = patterns && patterns.projects && patterns.projects[projectRoot];
  const imp = proj && proj.imported;
  if (!imp || !Object.keys(imp.files || {}).length) {
    console.log(`\n  No imported patterns for ${projectRoot}.\n`);
    return;
  }
  const rows = Object.entries(imp.files)
    .map(([p, d]) => ({ path: p, ...d }))
    .sort((a, b) => (b.wastedTokens || 0) - (a.wastedTokens || 0));

  console.log(`\n  IMPORTED PATTERNS — ${projectRoot}`);
  console.log(`  ${rows.length} files, imported ${imp.importedAt}`);
  console.log('  ' + '─'.repeat(70));
  for (const r of rows.slice(0, 20)) {
    const tag = (r.wastedSessions || 0) >= 2 ? 'waste '
      : (r.usefulness || 0) >= 2 ? 'useful' : '      ';
    const cost = r.wastedTokens ? ` ~${formatTokens(r.wastedTokens)} wasted` : '';
    console.log(`  ${tag}  ${r.path}${cost}`);
  }
  if (rows.length > 20) console.log(`  (${rows.length - 20} more)`);
  console.log();
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'export') return doExport();
  if (cmd === 'import') return doImport();
  if (cmd === 'show' || !cmd) return doShow();
  console.error(`Unknown command "${cmd}". Use: export | import <file> | show`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
  const d = getDonationMessage();
  if (d) console.log(d);
}
