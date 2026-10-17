#!/usr/bin/env node

/**
 * CCO Doctor — health check.
 *
 * Verifies plugin install integrity:
 *   - package.json / plugin.json versions in sync
 *   - hooks.json valid
 *   - data dir writable
 *   - patterns.json size sane
 *   - tests pass (optional, --tests flag)
 *   - hook scripts present, and the hook really runs under sh -c
 *   - model + budget config sane for current Claude version
 */

import {
  readFileSync, existsSync, statSync, accessSync, constants, writeFileSync, unlinkSync, mkdtempSync, rmSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import {
  DATA_DIR, PATTERNS_FILE, GLOBAL_STATS_FILE, CONFIG_FILE,
  loadConfig, getEffectiveBudget, getModelContextWindow, formatTokens,
  getPluginVersion, CURRENT_MODELS, reservedPluginNameReason
} from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RESULTS = [];
function check(name, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      RESULTS.push({ name, status: 'pass', detail: '' });
    } else if (typeof result === 'string') {
      RESULTS.push({ name, status: 'pass', detail: result });
    } else if (result && result.warn) {
      RESULTS.push({ name, status: 'warn', detail: result.warn });
    } else {
      RESULTS.push({ name, status: 'fail', detail: String(result) });
    }
  } catch (err) {
    RESULTS.push({ name, status: 'fail', detail: err.message });
  }
}

function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

// ── Checks ──────────────────────────────────────────────────────────────────

check('plugin manifest exists', () => {
  const f = join(ROOT, '.claude-plugin', 'plugin.json');
  if (!existsSync(f)) return 'plugin.json not found at expected location';
  return true;
});

check('package.json exists', () => {
  const f = join(ROOT, 'package.json');
  if (!existsSync(f)) return 'package.json missing';
  return true;
});

check('plugin name accepted by Claude Code', () => {
  const { name } = readJSON(join(ROOT, '.claude-plugin', 'plugin.json'));
  const reason = reservedPluginNameReason(name);
  return reason ? `"${name}" ${reason} — \`claude plugin validate\` rejects it` : name;
});

check('versions in sync (plugin.json vs package.json)', () => {
  const pkg = readJSON(join(ROOT, 'package.json'));
  const plug = readJSON(join(ROOT, '.claude-plugin', 'plugin.json'));
  if (pkg.version !== plug.version) {
    return `package=${pkg.version}, plugin=${plug.version} — run \`npm run sync-version\``;
  }
  return `v${pkg.version}`;
});

check('hooks.json is valid JSON', () => {
  const f = join(ROOT, 'hooks', 'hooks.json');
  if (!existsSync(f)) return 'hooks.json missing';
  const j = readJSON(f);
  if (!j.hooks) return 'hooks.json has no "hooks" key';
  return `${Object.keys(j.hooks).length} event types wired`;
});

check('hook scripts present', () => {
  const j = readJSON(join(ROOT, 'hooks', 'hooks.json'));
  const scripts = new Set();
  for (const groups of Object.values(j.hooks || {})) {
    for (const g of groups) {
      for (const h of g.hooks || []) {
        for (const m of String(h.command || '').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.js)/g)) scripts.add(m[1]);
      }
    }
  }
  const missing = [...scripts].filter(p => !existsSync(join(ROOT, p)));
  if (missing.length > 0) return `missing: ${missing.join(', ')}`;
  return `${[...scripts].join(', ')}`;
});

// Run the real hook the way Claude Code does (sh -c, JSON on stdin) against a
// throwaway data dir: two reads of the same file must end in a refusal, and a
// subagent's first read must not. This is the check that would have caught
// read dedup silently doing nothing under dash.
check('hooks work end-to-end (sh -c)', () => {
  if (process.platform === 'win32') return { warn: 'skipped on Windows (hooks run under Git Bash there)' };
  const home = mkdtempSync(join(tmpdir(), 'cco-doctor-'));
  try {
    const hook = join(ROOT, 'src', 'hook.js');
    const run = (extra = {}) => {
      const r = spawnSync('/bin/sh', ['-c', `node "${hook}"`], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', session_id: 'doctor', tool_name: 'Read',
          tool_input: { file_path: join(ROOT, 'src', 'utils.js') }, cwd: ROOT, ...extra,
        }),
        // A throwaway HOME and PATH (to find node) only — nothing else from
        // the user's environment reaches the child process.
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
        encoding: 'utf-8', timeout: 10_000,
      });
      if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${(r.stderr || '').trim().slice(0, 120)}`);
      return r.stdout.trim();
    };
    const t0 = Date.now();
    if (run() !== '') return 'first read was refused';
    const second = run();
    const ms = Math.round((Date.now() - t0) / 2);
    if (!/"permissionDecision":"deny"/.test(second)) return 'repeated read was not deduplicated';
    if (run({ agent_id: 'doctor-sub' }) !== '') return "a subagent's first read was refused";
    return `read dedup + subagent isolation OK, ~${ms} ms per call`;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

check('data directory writable', () => {
  if (!existsSync(DATA_DIR)) return { warn: `${DATA_DIR} does not exist yet (will be created on first run)` };
  try {
    accessSync(DATA_DIR, constants.W_OK);
    const probe = join(DATA_DIR, '.doctor-probe');
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return DATA_DIR;
  } catch (e) {
    return `not writable: ${e.message}`;
  }
});

check('patterns.json size', () => {
  if (!existsSync(PATTERNS_FILE)) return { warn: 'no patterns yet (no sessions tracked)' };
  const size = statSync(PATTERNS_FILE).size;
  if (size > 5 * 1024 * 1024) {
    return { warn: `patterns.json is ${(size / 1024 / 1024).toFixed(1)}MB — old per-session data is auto-pruned daily; /cco-clean --prune to run it now` };
  }
  return `${(size / 1024).toFixed(1)} KB`;
});

check('global-stats.json readable', () => {
  if (!existsSync(GLOBAL_STATS_FILE)) return { warn: 'no global stats yet' };
  const data = readJSON(GLOBAL_STATS_FILE);
  return `${data.totalSessions || 0} sessions, ${formatTokens(data.totalTokensTracked || 0)} tokens tracked`;
});

check('user config', () => {
  const cfg = loadConfig();
  const budget = getEffectiveBudget(cfg);
  const window = getModelContextWindow(cfg.model);
  if (budget > window) return `budget ${formatTokens(budget)} exceeds model window ${formatTokens(window)}`;
  if (!CURRENT_MODELS.includes(cfg.model)) {
    return { warn: `fallback model=${cfg.model} is not current — /cco-budget model opus-5.5 (live sessions still auto-detect their real model)` };
  }
  return `model=${cfg.model}, budget=${formatTokens(budget)}, window=${formatTokens(window)}`;
});

check('node version', () => {
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0], 10);
  if (major < 18) return `Node ${v} — plugin requires >=18`;
  return `Node ${v}`;
});

// Optional — slow.
if (process.argv.includes('--tests')) {
  check('tests pass', () => {
    try {
      execSync('npm test', { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      return 'all green';
    } catch {
      return 'tests failing — run `npm test` for details';
    }
  });
}

// ── Output ──────────────────────────────────────────────────────────────────

const symbols = { pass: '✔', warn: '⚠', fail: '✘' };
const colors = process.stdout.isTTY ? {
  pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', reset: '\x1b[0m', dim: '\x1b[2m'
} : { pass: '', warn: '', fail: '', reset: '', dim: '' };

const failed = RESULTS.filter(r => r.status === 'fail').length;
const warned = RESULTS.filter(r => r.status === 'warn').length;
const passed = RESULTS.filter(r => r.status === 'pass').length;

console.log('');
console.log(`  CCO Doctor — v${getPluginVersion()}`);
console.log('  ' + '─'.repeat(60));

for (const r of RESULTS) {
  const c = colors[r.status];
  const sym = symbols[r.status];
  const detail = r.detail ? `${colors.dim} — ${r.detail}${colors.reset}` : '';
  console.log(`  ${c}${sym}${colors.reset} ${r.name.padEnd(45)}${detail}`);
}

console.log('  ' + '─'.repeat(60));
console.log(`  ${colors.pass}${passed} pass${colors.reset}, ${colors.warn}${warned} warn${colors.reset}, ${colors.fail}${failed} fail${colors.reset}`);
console.log('');

if (failed > 0) process.exit(1);
