/**
 * Shared utilities for Context Optimizer
 *
 * Single source of truth for constants, formatting, token estimation,
 * usefulness scoring, JSON I/O, file classification, and config management.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, existsSync, statSync, realpathSync, readdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// ── Main-module guard ────────────────────────────────────────────────────────
// True only when the given module is the process entry point (i.e. run as
// `node src/foo.js`), false when it is imported by another module (e.g. tests).
// Hook modules use this to guard their stdin-reading main() — importing them
// for unit testing must NOT start the hook, or the test process hangs forever
// waiting on stdin (this caused the v3.6.0 CI runs to time out at 6h).
export function isMainModule(metaUrl) {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// ── Data directories ─────────────────────────────────────────────────────────

export const DATA_DIR = join(homedir(), '.claude-context-optimizer');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const PATTERNS_FILE = join(DATA_DIR, 'patterns.json');
export const GLOBAL_STATS_FILE = join(DATA_DIR, 'global-stats.json');
export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const BUDGET_STATE_DIR = join(DATA_DIR, 'budget');
export const BUDGET_CONFIG_FILE = join(DATA_DIR, 'budget-config.json');
export const READ_CACHE_DIR = join(DATA_DIR, 'read-cache');
export const TEMPLATES_DIR = join(DATA_DIR, 'templates');
export const EXPORTS_DIR = join(DATA_DIR, 'exports');
export const SUMMARIES_DIR = join(DATA_DIR, 'summaries');
export const PROMPTS_DIR = join(DATA_DIR, 'prompts');
export const NOTICES_DIR = join(DATA_DIR, 'notices');
export const TASKS_FILE = join(DATA_DIR, 'tasks.json');

// ── Model costs ($/M tokens — input/output) — platform.claude.com/docs pricing ─
// Current lineup (Opus 4.8 era). Output costs included for accurate ROI.
//   • Opus 4.7 / 4.8 — $5/$25, full 1M context window at standard price
//     (there is NO long-context premium; the old "1M tier surcharge" is gone).
//   • Sonnet 4.6 — $3/$15, 1M context window.
//   • Haiku 4.5 — $1/$5, 200K context window.
export const MODEL_COSTS = {
  'haiku':         { input: 1,  output: 5,  contextWindow:   200_000 },
  'haiku-4.5':     { input: 1,  output: 5,  contextWindow:   200_000 },
  'sonnet':        { input: 3,  output: 15, contextWindow: 1_000_000 },
  'sonnet-4.6':    { input: 3,  output: 15, contextWindow: 1_000_000 },
  'opus':          { input: 5,  output: 25, contextWindow: 1_000_000 },
  'opus-4.7':      { input: 5,  output: 25, contextWindow: 1_000_000 },
  'opus-4.8':      { input: 5,  output: 25, contextWindow: 1_000_000 },
  // Back-compat aliases — these used to carry a fictional 1M surcharge; the 1M
  // window is now standard, so they map to the standard Opus price.
  'opus-4.7-1m':   { input: 5,  output: 25, contextWindow: 1_000_000 },
  'opus-4.8-1m':   { input: 5,  output: 25, contextWindow: 1_000_000 },
  'opus-extended': { input: 5,  output: 25, contextWindow: 1_000_000 },
  // Claude 5 family (Fable/Mythos tier above Opus). Pricing not yet published —
  // priced at the Opus tier until Anthropic announces; window matches Opus 1M.
  'fable':         { input: 5,  output: 25, contextWindow: 1_000_000 },
  'fable-5':       { input: 5,  output: 25, contextWindow: 1_000_000 },
  'sonnet-5':      { input: 3,  output: 15, contextWindow: 1_000_000 },
};

/**
 * Map a raw session model id from the transcript (e.g. "claude-fable-5",
 * "claude-opus-4-8", "claude-haiku-4-5-20251001", possibly with a "[1m]"
 * suffix) to a MODEL_COSTS key. Null when unrecognized — callers fall back
 * to config.model.
 */
export function normalizeModelId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const id = raw.toLowerCase().replace(/\[1m\]$/, '');
  if (id.includes('fable') || id.includes('mythos')) return 'fable';
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return id.includes('sonnet-5') ? 'sonnet-5' : 'sonnet';
  if (id.includes('opus')) {
    if (id.includes('4-8') || id.includes('4.8')) return 'opus-4.8';
    if (id.includes('4-7') || id.includes('4.7')) return 'opus-4.7';
    return 'opus';
  }
  return null;
}

// Backwards-compatible numeric accessor (input price only — used by old callsites).
export const MODEL_INPUT_COST = Object.fromEntries(
  Object.entries(MODEL_COSTS).map(([k, v]) => [k, v.input])
);

export function getModelCost(model) {
  return MODEL_COSTS[model] || MODEL_COSTS.opus;
}

// ── Prompt-cache pricing ─────────────────────────────────────────────────────
// Cache reads bill at 10% of the input price; 5-minute cache writes at 125%.
// Real Claude Code sessions are dominated by cache reads, so pricing every
// input token at the full rate overstates cost by up to ~10×.
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;

/**
 * Dollar cost of a session given exact usage totals from the transcript.
 * `totals` = { input, cacheRead, cacheCreation, output } (tokens).
 * Returns { real, naive, cacheSavings } — `naive` prices all input-side tokens
 * at the full input rate (what the cost would be without prompt caching).
 */
export function computeCacheAwareCost(totals, model) {
  const c = getModelCost(model);
  const inRate = c.input / 1e6;
  const real =
    (totals.input || 0) * inRate +
    (totals.cacheRead || 0) * inRate * CACHE_READ_MULT +
    (totals.cacheCreation || 0) * inRate * CACHE_WRITE_MULT +
    (totals.output || 0) * (c.output / 1e6);
  const naive =
    ((totals.input || 0) + (totals.cacheRead || 0) + (totals.cacheCreation || 0)) * inRate +
    (totals.output || 0) * (c.output / 1e6);
  return { real, naive, cacheSavings: Math.max(0, naive - real) };
}

export function getModelContextWindow(model) {
  return getModelCost(model).contextWindow;
}

// ── Token estimation ─────────────────────────────────────────────────────────
// chars-per-token ratios — roughly calibrated against tiktoken cl100k_base.

export const TOKEN_RATIOS = {
  // Data / config
  '.json': 3.2, '.yaml': 3.5, '.yml': 3.5, '.toml': 3.5, '.ini': 3.6, '.env': 3.6,
  // JS / TS family
  '.ts': 3.8, '.tsx': 3.8, '.js': 3.8, '.jsx': 3.8, '.mjs': 3.8, '.cjs': 3.8,
  '.svelte': 3.6, '.vue': 3.6, '.astro': 3.7,
  // Python / Ruby / Go / Rust
  '.py': 4.0, '.pyi': 4.0, '.rb': 4.0, '.go': 3.7, '.rs': 3.7,
  // C / C++
  '.cpp': 3.6, '.c': 3.6, '.h': 3.6, '.hpp': 3.6, '.cc': 3.6, '.cxx': 3.6,
  // Other compiled
  '.java': 3.6, '.kt': 3.7, '.scala': 3.6, '.swift': 3.7, '.dart': 3.7, '.cs': 3.7,
  // JVM / functional
  '.clj': 3.8, '.cljs': 3.8, '.ex': 3.9, '.exs': 3.9, '.erl': 3.9, '.fs': 3.7, '.hs': 3.7,
  // Shell / scripting
  '.sh': 3.5, '.bash': 3.5, '.zsh': 3.5, '.fish': 3.5, '.ps1': 3.5,
  '.lua': 3.8, '.pl': 3.8, '.r': 3.8, '.php': 3.7,
  // Docs / markup
  '.md': 4.2, '.mdx': 4.2, '.txt': 4.5, '.rst': 4.3, '.tex': 3.8,
  '.html': 3.5, '.htm': 3.5, '.xml': 3.2,
  // Styles
  '.css': 3.8, '.scss': 3.8, '.sass': 3.8, '.less': 3.8, '.styl': 3.8,
  // Other
  '.svg': 3.0, '.proto': 3.6, '.graphql': 3.7, '.gql': 3.7, '.sql': 3.6,
};

const AVG_CHARS_PER_LINE = 35;

export function estimateTokens(lineCount, ext) {
  const ratio = TOKEN_RATIOS[ext] || 3.7;
  return Math.round((lineCount * AVG_CHARS_PER_LINE) / ratio);
}

/** Estimate tokens directly from a string. Used by prompt-coach and budget. */
export function estimateTokensFromString(str, ext = '') {
  if (!str) return 0;
  const ratio = TOKEN_RATIOS[ext] || 3.7;
  return Math.round(str.length / ratio);
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Display a file path in a compact, disambiguated form.
 * Shows last 2-3 path segments instead of just basename.
 */
export function displayPath(filePath, maxLen = 35) {
  const home = homedir();
  let display = filePath;
  if (display.startsWith(home)) {
    display = '~' + display.slice(home.length);
  }
  const parts = display.split('/');
  if (parts.length > 3) {
    display = parts.slice(-3).join('/');
  }
  if (display.length > maxLen) {
    display = '...' + display.slice(-(maxLen - 3));
  }
  return display;
}

// ── JSON I/O (atomic writes) ─────────────────────────────────────────────────

export function loadJSON(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Atomic JSON write: write to temp + rename.
 * Prevents corruption when parallel hook processes write the same file
 * (e.g. main session + subagent finalizing concurrently).
 */
export function saveJSON(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    // Best-effort: fall back to direct write so we don't lose data.
    try { writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* drop */ }
    try { if (existsSync(tmp)) { /* leave tmp for inspection */ } } catch { /* ignore */ }
    throw err;
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  budgetTokens: 200000,        // 200K — sane working default even on 1M-window models
  warnAt: [50, 70, 85, 95],
  autoCompactAt: 90,
  model: 'opus-4.8',
  bigFileDigest: true,         // on first full read of a very large file, show its
  bigFileThreshold: 1500,      // map once (≈14K+ tokens) so Claude reads targeted
};

export function loadConfig() {
  const config = loadJSON(CONFIG_FILE);
  if (config) return { ...DEFAULT_CONFIG, ...config };
  mkdirSync(DATA_DIR, { recursive: true });
  saveJSON(CONFIG_FILE, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config) {
  saveJSON(CONFIG_FILE, { ...DEFAULT_CONFIG, ...config });
}

// ── Estimate self-calibration ────────────────────────────────────────────────
// The chars-per-token heuristic drifts per codebase (dense JSON vs airy MD).
// Sessions where the transcript gave ground truth teach us the local drift:
// at session end we EMA the real/estimated ratio into config, and the budget
// hook multiplies its estimates by it. Estimates get more honest by themselves.

/** One EMA step of the calibration factor. Pure — exported for tests. */
export function emaCalibration(prevFactor, ratio, alpha = 0.3) {
  const clamped = Math.min(2, Math.max(0.5, ratio));
  const next = (prevFactor || 1) * (1 - alpha) + clamped * alpha;
  return Math.round(Math.min(2, Math.max(0.5, next)) * 100) / 100;
}

let _calibrationFactor = null;
export function getCalibrationFactor() {
  if (_calibrationFactor !== null) return _calibrationFactor;
  const cfg = loadJSON(CONFIG_FILE);
  const f = cfg && cfg.calibration && cfg.calibration.factor;
  _calibrationFactor = (typeof f === 'number' && f >= 0.5 && f <= 2) ? f : 1;
  return _calibrationFactor;
}

/**
 * Learn from one finished session. Only trusts sessions big enough for the
 * ratio to be signal, not noise. Returns the new factor or null if skipped.
 */
export function updateCalibrationFromSession(realTokens, estimatedTokens) {
  if (!(realTokens > 20_000) || !(estimatedTokens > 5_000)) return null;
  const config = loadConfig();
  const prev = (config.calibration && config.calibration.factor) || 1;
  const samples = (config.calibration && config.calibration.samples) || 0;
  const factor = emaCalibration(prev, realTokens / estimatedTokens);
  config.calibration = { factor, samples: samples + 1, updatedAt: new Date().toISOString() };
  saveConfig(config);
  _calibrationFactor = factor;
  return factor;
}

/**
 * Effective budget — model-aware. Honours explicit budgetTokens but caps to
 * the model's context window if user hasn't customised it.
 */
export function getEffectiveBudget(config, sessionModel) {
  const cfg = config || loadConfig();
  const window = getModelContextWindow(normalizeModelId(sessionModel) || cfg.model);
  return Math.min(cfg.budgetTokens || DEFAULT_CONFIG.budgetTokens, window);
}

/** Raw model id detected for a session (written by the budget hook), or null. */
export function getSessionModel(sessionId) {
  if (!sessionId) return null;
  const state = loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`));
  return (state && state.model) || null;
}

// ── Session resolution (shared by skills that have no event stdin) ───────────
// Slash-command skills run as plain processes without the hook's session_id,
// so they resolve "the current session" as the most-recently-updated session
// file — the same convention tracker/report/digest already use.

export function getLatestSessionId() {
  try {
    const files = readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ name: f, mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].name.replace(/\.json$/, '') : null;
  } catch {
    return null;
  }
}

/** Total estimated tokens spent in a session (from budget state), or 0. */
export function getSessionTokenTotal(sessionId) {
  if (!sessionId) return 0;
  const state = loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`));
  return (state && state.totalTokensEstimated) || 0;
}

// ── Budget config (auto-compact settings) ────────────────────────────────────

const DEFAULT_BUDGET_CONFIG = {
  autoCompactEnabled: true,
  autoCompactThreshold: 80,
  criticalThreshold: 90
};

let _budgetConfigCache = null;

export function loadBudgetConfig() {
  if (_budgetConfigCache) return _budgetConfigCache;
  const config = loadJSON(BUDGET_CONFIG_FILE);
  if (config) {
    _budgetConfigCache = { ...DEFAULT_BUDGET_CONFIG, ...config };
  } else {
    mkdirSync(DATA_DIR, { recursive: true });
    saveJSON(BUDGET_CONFIG_FILE, DEFAULT_BUDGET_CONFIG);
    _budgetConfigCache = { ...DEFAULT_BUDGET_CONFIG };
  }
  return _budgetConfigCache;
}

export function saveBudgetConfig(config) {
  const merged = { ...DEFAULT_BUDGET_CONFIG, ...config };
  saveJSON(BUDGET_CONFIG_FILE, merged);
  _budgetConfigCache = merged;
}

export function clearBudgetConfigCache() {
  _budgetConfigCache = null;
}

// ── Usefulness scoring ───────────────────────────────────────────────────────

export function computeUsefulness(fileData) {
  let score = 0;
  score += (fileData.edits || 0) * 3;
  if (fileData.reads > 1) {
    score += Math.min(3, (fileData.reads - 1) * 0.5);
  }
  if ((fileData.partialReads || 0) > 0) {
    score += 1;
  }
  if (fileData.reads >= 3 && !fileData.wasEdited && (fileData.lines || 0) > 100) {
    score -= 1;
  }
  return score;
}

// ── Confidence scoring ──────────────────────────────────────────────────────

export function computeConfidence(freqData, daysSinceLastSession = 0) {
  if (!freqData || !freqData.sessions) return 0;
  const sessionScore = Math.min(1, freqData.sessions / 10);
  const usefulRatio = freqData.sessions > 0
    ? (freqData.usefulness || 0) / freqData.sessions
    : 0;
  const decayFactor = Math.max(0, 1 - (daysSinceLastSession / 300));
  const confidence = (sessionScore * 0.4 + usefulRatio * 0.5 + decayFactor * 0.1);
  return Math.round(confidence * 100) / 100;
}

// ── Unified file classification (single source of truth) ─────────────────────

export const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.go', '.rs', '.cpp', '.c', '.h', '.hpp', '.cc', '.cxx',
  '.rb', '.java', '.kt', '.scala', '.swift', '.dart', '.cs',
  '.clj', '.cljs', '.ex', '.exs', '.erl', '.fs', '.hs',
  '.lua', '.pl', '.r', '.php',
  '.svelte', '.vue', '.astro',
]);
export const CONFIG_EXTS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.proto', '.graphql', '.gql']);
export const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less', '.styl']);
export const DOC_EXTS = new Set(['.md', '.mdx', '.txt', '.rst', '.tex']);
export const SHELL_EXTS = new Set(['.sh', '.bash', '.zsh', '.fish', '.ps1']);

export const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.lock', '.map',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.br', '.zst',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
]);

export const SKIP_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock',
]);

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.turbo',
  '__pycache__', '.venv', 'venv', 'vendor', 'target', '.cache',
]);

export function categorizeFile(filePath) {
  const ext = extname(filePath);
  const name = basename(filePath);
  const lower = filePath.toLowerCase();

  // Test files first (before source, since .test.ts is also .ts)
  if (/\.(test|spec)\./.test(name) || /\/__tests__\//.test(lower) || /\/tests?\//.test(lower)) {
    return 'test';
  }
  if (DOC_EXTS.has(ext) || /\/docs?\//.test(lower)) return 'docs';
  if (SOURCE_EXTS.has(ext)) return 'source';
  if (STYLE_EXTS.has(ext) || /\.styled\./.test(name)) return 'style';
  if (SHELL_EXTS.has(ext)) return 'script';
  if (CONFIG_EXTS.has(ext) || /\.config\./.test(name) || /\.env/.test(name) ||
      name.startsWith('tsconfig') || name === 'Makefile' || name === 'CMakeLists.txt' ||
      name === 'Dockerfile' || name === '.eslintrc' || name === '.prettierrc') {
    return 'config';
  }
  return 'other';
}

export function shouldSkipFile(filePath) {
  const ext = extname(filePath);
  const name = basename(filePath);
  if (SKIP_EXTS.has(ext)) return true;
  if (SKIP_NAMES.has(name)) return true;
  if (name.endsWith('.min.js') || name.endsWith('.min.css')) return true;
  return false;
}

/**
 * Tracker-level ignore: also covers transient/system paths and binary blobs.
 * Used by the PostToolUse tracker to drop noise events.
 */
const TRACKER_IGNORE_PATTERNS = [
  /^toolu_/,
  /^\/dev\//,
  /^\/proc\//,
  /^\/tmp\/claude/,
  /^data:/,
  /node_modules\//,
  /\.git\//,
];

export function shouldIgnoreForTracking(filePath) {
  if (!filePath) return true;
  if (TRACKER_IGNORE_PATTERNS.some(p => p.test(filePath))) return true;
  return shouldSkipFile(filePath);
}

// ── File metadata helpers ────────────────────────────────────────────────────

export function getFileLines(filePath, maxBytes = 10 * 1024 * 1024) {
  try {
    const stat = statSync(filePath);
    if (stat.size > maxBytes) return 0;
    // Hot path (called from Pre/PostToolUse hooks): don't slurp multi-MB files
    // just to count lines — estimate from size instead. Exact only when small.
    if (stat.size > 1024 * 1024) {
      return Math.round(stat.size / (AVG_CHARS_PER_LINE + 1));
    }
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

export function getProjectRoot(filePath) {
  try {
    let dir = filePath;
    // If filePath is a file, walk from its dir
    try { if (statSync(dir).isFile()) dir = dir.replace(/\/[^/]+$/, ''); } catch { /* ignore */ }
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, '.git'))) return dir;
      if (existsSync(join(dir, 'package.json'))) return dir;
      if (existsSync(join(dir, 'Cargo.toml'))) return dir;
      if (existsSync(join(dir, 'go.mod'))) return dir;
      if (existsSync(join(dir, 'pyproject.toml'))) return dir;
      const parent = dir.replace(/\/[^/]+$/, '');
      if (parent === dir || !parent) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Donation / quiet mode ────────────────────────────────────────────────────

export const DONATION_ADDRESSES = {
  btc: 'bc1q428exz5t2h9rzk7z5ya70madh0j3rs6h4gfgyd',
  eth: '0xB3f0C8e42B7cA9d65920cEfe82e3fef1B5C9d0C9',
  sol: '8ctK8nt3CBkPZGfWQXX8TsnqUYUy4JAbT1EMhr8rsQxm',
};

/** Suppress donation banner in machine-consumed outputs. */
export function isQuietMode() {
  return process.env.CCO_QUIET === '1' ||
         process.env.CCO_QUIET === 'true' ||
         process.env.CI === 'true';
}

export function getDonationMessage() {
  if (isQuietMode()) return '';
  return [
    '',
    '  ─────────────────────────────────────────────────────────────',
    '  Like saving tokens? Support the project:',
    `  BTC: ${DONATION_ADDRESSES.btc}`,
    `  ETH: ${DONATION_ADDRESSES.eth}`,
    `  SOL: ${DONATION_ADDRESSES.sol}`,
    '  ─────────────────────────────────────────────────────────────',
  ].join('\n');
}

// ── Cross-process file lock ──────────────────────────────────────────────────
// mkdir() is atomic: it either creates the directory or throws EEXIST. Used to
// serialize read-modify-write of shared files (global stats / patterns) between
// concurrently-finalizing sessions. Best-effort: if the lock can't be acquired
// within ~600ms the caller proceeds unlocked (a rare lost update beats a hung
// hook), and locks older than staleMs are stolen (crashed holder).

export function acquireFileLock(name, { retries = 40, delayMs = 15, staleMs = 5000 } = {}) {
  const lockDir = join(DATA_DIR, `.${name}.lock`);
  mkdirSync(DATA_DIR, { recursive: true });
  for (let i = 0; i < retries; i++) {
    try {
      mkdirSync(lockDir);
      return () => { try { rmdirSync(lockDir); } catch { /* already gone */ } };
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
          rmdirSync(lockDir);
          continue;
        }
      } catch { continue; } // lock vanished between mkdir and stat — retry now
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  return () => {}; // could not acquire — proceed unlocked (best-effort)
}

// ── Data directory initialization ────────────────────────────────────────────

export function ensureDataDirs() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(BUDGET_STATE_DIR, { recursive: true });
  mkdirSync(READ_CACHE_DIR, { recursive: true });
  mkdirSync(TEMPLATES_DIR, { recursive: true });
  mkdirSync(EXPORTS_DIR, { recursive: true });
  mkdirSync(SUMMARIES_DIR, { recursive: true });
  mkdirSync(PROMPTS_DIR, { recursive: true });
  mkdirSync(NOTICES_DIR, { recursive: true });
}

// ── Plugin version (single source of truth) ─────────────────────────────────

let _pluginVersion = null;
export function getPluginVersion() {
  if (_pluginVersion) return _pluginVersion;
  try {
    const here = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(here, 'utf-8'));
    _pluginVersion = pkg.version;
  } catch {
    _pluginVersion = '0.0.0';
  }
  return _pluginVersion;
}
