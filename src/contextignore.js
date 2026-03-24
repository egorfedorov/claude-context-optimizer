/**
 * Contextignore v1.0
 *
 * Checks file paths against .contextignore patterns (like .gitignore).
 * Supports project-level (.contextignore in cwd) and global-level
 * (~/.claude/.contextignore) pattern files.
 *
 * Pattern syntax:
 *   - Exact filename: package-lock.json
 *   - Extension glob: *.lock, *.min.js
 *   - Directory glob: dist/**, node_modules/**
 *   - Wildcard glob: *.generated.*
 *   - Comments (#) and blank lines are ignored
 *
 * No external dependencies — uses only Node.js built-ins.
 */

import { readFileSync } from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';

// ── Pattern cache ────────────────────────────────────────────────────────────

let cachedPatterns = null;
let cachedCwd = null;

/**
 * Parse a .contextignore file into an array of pattern objects.
 * Returns [] if the file doesn't exist or can't be read.
 */
function parseIgnoreFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const patterns = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    // Skip blank lines and comments
    if (!line || line.startsWith('#')) continue;
    patterns.push({ raw: line, source: filePath });
  }
  return patterns;
}

/**
 * Load patterns from both project-level and global .contextignore files.
 * Results are cached per cwd — cache is invalidated if cwd changes.
 */
function loadPatterns() {
  const cwd = process.cwd();
  if (cachedPatterns && cachedCwd === cwd) {
    return cachedPatterns;
  }

  const patterns = [];

  // Project-level: .contextignore in current working directory
  const projectFile = join(cwd, '.contextignore');
  patterns.push(...parseIgnoreFile(projectFile));

  // Global-level: ~/.claude/.contextignore
  const globalFile = join(homedir(), '.claude', '.contextignore');
  patterns.push(...parseIgnoreFile(globalFile));

  cachedPatterns = patterns;
  cachedCwd = cwd;
  return patterns;
}

// ── Pattern matching ─────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern to a RegExp.
 *
 * Supported syntax:
 *   *       → matches any characters except /
 *   **      → matches any characters including /
 *   .       → literal dot (escaped)
 *   ?       → matches any single character except /
 *
 * Patterns without / are matched against the basename only.
 * Patterns with / are matched against the full path.
 */
function globToRegex(pattern) {
  // Escape regex-special characters except * and ?
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** — match anything including path separators
        regex += '.*';
        i += 2;
        // Skip trailing / after ** (e.g., dist/**)
        if (pattern[i] === '/') i++;
        continue;
      }
      // Single * — match anything except /
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
    i++;
  }
  return new RegExp('^' + regex + '$');
}

/**
 * Test whether a file path matches a glob pattern.
 *
 * - Patterns without / or ** are matched against the basename.
 * - Patterns with / or ** are matched against the full normalized path.
 */
function matchesPattern(filePath, pattern) {
  const normalized = resolve(filePath);
  const name = basename(normalized);
  const raw = pattern.raw;

  // Determine match target: basename-only for simple patterns,
  // full path for patterns containing / or **
  const hasPathSeparator = raw.includes('/');
  const hasDoubleStar = raw.includes('**');

  const regex = globToRegex(raw);

  if (hasPathSeparator || hasDoubleStar) {
    // Match against the full path — try both the full path and
    // relative-from-cwd path for directory patterns like dist/**
    if (regex.test(normalized)) return true;

    // Also try matching against a relative-ish path from cwd
    const cwd = process.cwd();
    if (normalized.startsWith(cwd + '/')) {
      const relative = normalized.slice(cwd.length + 1);
      if (regex.test(relative)) return true;
    }
    return false;
  }

  // Simple pattern — match against basename
  return regex.test(name);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a file path is blocked by .contextignore patterns.
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {{ ignored: boolean, pattern: string }} Result with matched pattern
 */
export function isContextIgnored(filePath) {
  const patterns = loadPatterns();

  for (const pattern of patterns) {
    if (matchesPattern(filePath, pattern)) {
      return { ignored: true, pattern: pattern.raw };
    }
  }

  return { ignored: false, pattern: '' };
}

/**
 * Exposed for testing — convert glob to regex.
 * @param {string} pattern
 * @returns {RegExp}
 */
export { globToRegex as _globToRegex };

/**
 * Exposed for testing — parse an ignore file.
 * @param {string} filePath
 * @returns {Array<{raw: string, source: string}>}
 */
export { parseIgnoreFile as _parseIgnoreFile };

/**
 * Clear the cached patterns. Useful for testing or after file changes.
 */
export function clearContextIgnoreCache() {
  cachedPatterns = null;
  cachedCwd = null;
}
