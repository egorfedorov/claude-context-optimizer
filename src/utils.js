/**
 * Shared utilities for Context Optimizer
 *
 * Single source of truth for constants, formatting, token estimation,
 * usefulness scoring, JSON I/O, and config management.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

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

// ── Model costs ($/M tokens) ────────────────────────────────────────────────

export const MODEL_COSTS = {
  haiku: 0.80,
  sonnet: 3,
  opus: 15
};

// ── Token estimation ─────────────────────────────────────────────────────────

export const TOKEN_RATIOS = {
  '.json': 3.2, '.yaml': 3.5, '.yml': 3.5, '.toml': 3.5,
  '.ts': 3.8, '.tsx': 3.8, '.js': 3.8, '.jsx': 3.8,
  '.py': 4.0, '.rb': 4.0, '.go': 3.7, '.rs': 3.7,
  '.cpp': 3.6, '.c': 3.6, '.h': 3.6, '.hpp': 3.6,
  '.md': 4.2, '.txt': 4.5, '.html': 3.5, '.css': 3.8,
  '.svg': 3.0, '.xml': 3.2,
};

export function estimateTokens(lineCount, ext) {
  const avgCharsPerLine = 35;
  const ratio = TOKEN_RATIOS[ext] || 3.7;
  return Math.round((lineCount * avgCharsPerLine) / ratio);
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

// ── JSON I/O ─────────────────────────────────────────────────────────────────

export function loadJSON(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveJSON(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  budgetTokens: 100000,
  warnAt: [50, 70, 85, 95],
  autoCompactAt: 90,
  model: 'opus'
};

export function loadConfig() {
  const config = loadJSON(CONFIG_FILE);
  if (config) return { ...DEFAULT_CONFIG, ...config };
  mkdirSync(DATA_DIR, { recursive: true });
  saveJSON(CONFIG_FILE, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

// ── Budget config (auto-compact settings) ────────────────────────────────────

const DEFAULT_BUDGET_CONFIG = {
  autoCompactEnabled: true,
  autoCompactThreshold: 80,
  criticalThreshold: 90
};

let _budgetConfigCache = null;

/**
 * Load budget-specific config (auto-compact settings).
 * Lazily loaded and cached for performance since this runs on every PostToolUse.
 * Creates the config file with defaults if it doesn't exist.
 */
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

/**
 * Save budget config and update cache.
 */
export function saveBudgetConfig(config) {
  const merged = { ...DEFAULT_BUDGET_CONFIG, ...config };
  saveJSON(BUDGET_CONFIG_FILE, merged);
  _budgetConfigCache = merged;
}

/**
 * Clear the budget config cache (useful for testing or after external changes).
 */
export function clearBudgetConfigCache() {
  _budgetConfigCache = null;
}

// ── Usefulness scoring (consistent across all modules) ───────────────────────

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

/**
 * Compute confidence score (0.0 - 1.0) for a file pattern.
 * Based on: sessions seen, usefulness consistency, recency.
 */
export function computeConfidence(freqData, daysSinceLastSession = 0) {
  if (!freqData || !freqData.sessions) return 0;

  // Base: more sessions = more confidence (caps at 10 sessions = 1.0)
  const sessionScore = Math.min(1, freqData.sessions / 10);

  // Consistency: what % of sessions was this file useful?
  const usefulRatio = freqData.sessions > 0
    ? (freqData.usefulness || 0) / freqData.sessions
    : 0;

  // Recency decay: lose 10% confidence per 30 days of inactivity
  const decayFactor = Math.max(0, 1 - (daysSinceLastSession / 300));

  // Weighted score
  const confidence = (sessionScore * 0.4 + usefulRatio * 0.5 + decayFactor * 0.1);
  return Math.round(confidence * 100) / 100;
}

// ── Donation info ───────────────────────────────────────────────────────────

export const DONATION_ADDRESSES = {
  btc: 'bc1q428exz5t2h9rzk7z5ya70madh0j3rs6h4gfgyd',
  eth: '0xB3f0C8e42B7cA9d65920cEfe82e3fef1B5C9d0C9',
  sol: '8ctK8nt3CBkPZGfWQXX8TsnqUYUy4JAbT1EMhr8rsQxm',
};

export function getDonationMessage() {
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

// ── Data directory initialization ────────────────────────────────────────────

export function ensureDataDirs() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(BUDGET_STATE_DIR, { recursive: true });
  mkdirSync(READ_CACHE_DIR, { recursive: true });
  mkdirSync(TEMPLATES_DIR, { recursive: true });
  mkdirSync(EXPORTS_DIR, { recursive: true });
  mkdirSync(SUMMARIES_DIR, { recursive: true });
}
