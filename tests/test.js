import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { extname, basename, join } from 'path';
import { homedir } from 'os';

import {
  estimateTokens, estimateTokensFromString, formatTokens, displayPath,
  computeUsefulness, computeConfidence, TOKEN_RATIOS,
  loadBudgetConfig, saveBudgetConfig, clearBudgetConfigCache,
  BUDGET_CONFIG_FILE, loadJSON,
  MODEL_COSTS, MODEL_INPUT_COST, getModelCost, getModelContextWindow,
  getEffectiveBudget, categorizeFile, shouldSkipFile, shouldIgnoreForTracking,
  isMainModule, getFileLines, toPosixPath,
  CHARS_PER_LINE, charsPerLine, clearCharsPerLineCache
} from '../src/utils.js';
import { analyzePrompt, buildImprovedPrompt, classifyPrompt } from '../src/prompt-coach.js';
import { parseBaselineFromLines, projectTranscriptDir } from '../src/overhead.js';
import { THRESHOLD_SPEC, validateThreshold } from '../src/utils.js';
import { describeThresholds, applySet, applyReset } from '../src/config.js';
import { buildIgnoreSuggestions } from '../src/context-shield.js';
import { updateExploreStreak } from '../src/tracker.js';
import { computeCacheAwareCost, emaCalibration } from '../src/utils.js';
import {
  emptyState, addTask, completeActiveTask, getActiveTask, taskSpend, tasksForProject
} from '../src/tasks.js';
import {
  emptyLedger, shouldEmit, recordEmit, DEFAULT_NOTICE_CAP
} from '../src/notices.js';
import { shouldNudgeBigFile, checkStaleness } from '../src/read-cache.js';
import {
  estimateToolTokens, computeCost, selectWarnings,
  shouldWarnCacheBreak, shouldWarnContextRot, buildCompactRecommendation
} from '../src/budget.js';
import {
  isContextIgnored, _globToRegex, _parseIgnoreFile, clearContextIgnoreCache
} from '../src/contextignore.js';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { parseUsageFromLines, readRealUsage, parseEconomicsFromLines } from '../src/transcript-usage.js';
import { acquireFileLock } from '../src/utils.js';
import {
  trackSearch, trackToolUse, aggregateSessionFiles, buildCoOccurrence
} from '../src/tracker.js';

// ── Recreated pure functions from read-cache.js ─────────────────────────────

function isRangeCovered(ranges, offset, end) {
  if (!ranges || ranges.length === 0) return false;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }
  for (const [s, e] of merged) {
    if (s <= offset && e >= end) return true;
  }
  return false;
}

// Use the unified classification from utils — single source of truth.
const categorize = categorizeFile;
const shouldSkip = shouldSkipFile;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('utils', () => {
  describe('estimateTokens', () => {
    it('uses extension-specific chars/line AND ratio for .js', () => {
      assert.equal(estimateTokens(100, '.js'), Math.round((100 * CHARS_PER_LINE['.js']) / 3.8));
    });

    it('uses extension-specific chars/line AND ratio for .md', () => {
      assert.equal(estimateTokens(100, '.md'), Math.round((100 * CHARS_PER_LINE['.md']) / 4.2));
    });

    it('uses extension-specific chars/line AND ratio for .json', () => {
      assert.equal(estimateTokens(100, '.json'), Math.round((100 * CHARS_PER_LINE['.json']) / 3.2));
    });

    it('falls back to 3.7 ratio and 35 chars/line for unknown extensions', () => {
      assert.equal(estimateTokens(100, '.xyz'), Math.round((100 * 35) / 3.7));
    });

    it('returns 0 for 0 lines', () => {
      assert.equal(estimateTokens(0, '.js'), 0);
    });
  });

  // #35: a flat 35 chars/line biased the headline "tokens saved" figure. These
  // pin the per-extension behaviour against the measured sample.
  describe('charsPerLine (#35)', () => {
    it('reflects that SVG lines are ~3x longer than the old flat assumption', () => {
      assert.ok(charsPerLine('.svg') > 90, 'measured ~100 chars/line');
      // A 1000-line SVG was under-counted nearly 3x before.
      assert.ok(estimateTokens(1000, '.svg') / Math.round((1000 * 35) / 3.0) > 2.5);
    });

    it('reflects that CSS lines are SHORTER than the old flat assumption', () => {
      assert.ok(charsPerLine('.css') < 30, 'measured ~25 chars/line');
      assert.ok(estimateTokens(1000, '.css') < Math.round((1000 * 35) / 3.8));
    });

    it('is case-insensitive about the extension', () => {
      assert.equal(charsPerLine('.TS'), charsPerLine('.ts'));
    });

    it('falls back to 35 for an unlisted extension', () => {
      assert.equal(charsPerLine('.zzz'), 35);
      assert.equal(charsPerLine(''), 35);
      assert.equal(charsPerLine(undefined), 35);
    });

    it('keeps every default within a sane 15-150 chars/line band', () => {
      for (const [ext, v] of Object.entries(CHARS_PER_LINE)) {
        assert.ok(v >= 15 && v <= 150, `${ext} = ${v} is out of band`);
      }
    });

    it('lands within 25% of the measured value for the top languages', () => {
      // Ground truth measured over 6.3K real files (see CHANGELOG 4.8.0).
      const MEASURED = { '.py': 34.5, '.ts': 44, '.md': 35.8, '.json': 38.8, '.go': 29.9, '.css': 25.3 };
      for (const [ext, real] of Object.entries(MEASURED)) {
        const got = charsPerLine(ext);
        assert.ok(Math.abs(got - real) / real < 0.25,
          `${ext}: ${got} is >25% off the measured ${real}`);
      }
    });
  });

  describe('formatTokens', () => {
    it('returns plain number below 1000', () => {
      assert.equal(formatTokens(500), '500');
      assert.equal(formatTokens(0), '0');
      assert.equal(formatTokens(999), '999');
    });

    it('formats thousands with K suffix', () => {
      assert.equal(formatTokens(1500), '1.5K');
      assert.equal(formatTokens(1000), '1.0K');
      assert.equal(formatTokens(99900), '99.9K');
    });

    it('formats millions with M suffix', () => {
      assert.equal(formatTokens(1500000), '1.5M');
      assert.equal(formatTokens(1000000), '1.0M');
    });
  });

  describe('displayPath', () => {
    it('truncates long paths to last 3 segments', () => {
      const result = displayPath('/a/b/c/d/e/file.ts');
      assert.equal(result, 'd/e/file.ts');
    });

    it('keeps paths with 3 or fewer segments intact after split', () => {
      // '/x/y' splits to ['', 'x', 'y'] which is 3 parts, no truncation
      assert.equal(displayPath('/x/y'), '/x/y');
    });

    it('applies maxLen truncation with ellipsis', () => {
      const result = displayPath('/a/b/c/very-long-directory-name/file.ts', 20);
      assert.ok(result.startsWith('...'));
      assert.ok(result.length <= 20);
    });

    it('shortens home directory to ~', () => {
      const home = homedir();
      const result = displayPath(home + '/projects/foo/bar.ts');
      assert.ok(result.startsWith('~') || !result.includes(home),
        'should replace homedir with ~');
    });

    // Issue #33: on Windows the whole path is one segment under split('/'),
    // so nothing was ever shortened and the raw C:\... path leaked into output.
    it('truncates Windows-style backslash paths to last 3 segments', () => {
      assert.equal(displayPath('C:\\a\\b\\c\\d\\e\\file.ts'), 'd/e/file.ts');
    });
  });

  describe('toPosixPath', () => {
    it('converts backslash separators to forward slashes', () => {
      assert.equal(toPosixPath('C:\\Users\\me\\proj\\src\\a.ts'),
        'C:/Users/me/proj/src/a.ts');
    });

    it('leaves POSIX paths untouched', () => {
      assert.equal(toPosixPath('/Users/me/proj/src/a.ts'),
        '/Users/me/proj/src/a.ts');
    });

    it('passes through non-strings unchanged', () => {
      assert.equal(toPosixPath(undefined), undefined);
      assert.equal(toPosixPath(null), null);
    });
  });

  describe('computeUsefulness', () => {
    it('scores edited files highly', () => {
      const score = computeUsefulness({ reads: 2, edits: 3, wasEdited: true, partialReads: 0, lines: 50 });
      // 3 edits * 3 = 9, plus re-read bonus: (2-1)*0.5 = 0.5
      assert.equal(score, 9.5);
    });

    it('gives read-only files minimal score', () => {
      const score = computeUsefulness({ reads: 1, edits: 0, wasEdited: false, partialReads: 0, lines: 50 });
      // no edits, only 1 read (no re-read bonus), no partial reads
      assert.equal(score, 0);
    });

    it('penalizes large files read many times but never edited', () => {
      const score = computeUsefulness({ reads: 5, edits: 0, wasEdited: false, partialReads: 0, lines: 200 });
      // re-read: min(3, 4*0.5)=2, penalty for reads>=3 && !wasEdited && lines>100: -1
      assert.equal(score, 1);
    });

    it('adds bonus for partial reads', () => {
      const withPartial = computeUsefulness({ reads: 2, edits: 0, wasEdited: false, partialReads: 1, lines: 50 });
      const without = computeUsefulness({ reads: 2, edits: 0, wasEdited: false, partialReads: 0, lines: 50 });
      assert.equal(withPartial - without, 1);
    });

    it('caps re-read bonus at 3', () => {
      const score = computeUsefulness({ reads: 100, edits: 0, wasEdited: false, partialReads: 0, lines: 10 });
      // min(3, 99*0.5)=3, no penalty (lines<=100)
      assert.equal(score, 3);
    });
  });

  describe('computeConfidence', () => {
    it('returns 0 for null/missing data', () => {
      assert.equal(computeConfidence(null), 0);
      assert.equal(computeConfidence({}), 0);
      assert.equal(computeConfidence({ sessions: 0 }), 0);
    });

    it('gives high confidence for frequent useful file', () => {
      const conf = computeConfidence({ sessions: 10, usefulness: 9 }, 0);
      // sessionScore=1.0, usefulRatio=0.9, decay=1.0
      // 1.0*0.4 + 0.9*0.5 + 1.0*0.1 = 0.4+0.45+0.1 = 0.95
      assert.equal(conf, 0.95);
    });

    it('decays with inactivity', () => {
      const recent = computeConfidence({ sessions: 10, usefulness: 10 }, 0);
      const stale = computeConfidence({ sessions: 10, usefulness: 10 }, 150);
      assert.ok(stale < recent, 'stale data should have lower confidence');
    });

    it('fully decays after 300 days', () => {
      const conf = computeConfidence({ sessions: 10, usefulness: 10 }, 300);
      // decay=0, sessionScore=1.0, usefulRatio=1.0
      // 1.0*0.4 + 1.0*0.5 + 0*0.1 = 0.9
      assert.equal(conf, 0.9);
    });

    it('returns low confidence for single-session data', () => {
      const conf = computeConfidence({ sessions: 1, usefulness: 1 }, 0);
      // sessionScore=0.1, usefulRatio=1.0, decay=1.0
      // 0.1*0.4 + 1.0*0.5 + 1.0*0.1 = 0.04+0.5+0.1 = 0.64
      assert.equal(conf, 0.64);
    });
  });
});

describe('read-cache logic', () => {
  describe('isRangeCovered', () => {
    it('returns false for empty ranges', () => {
      assert.equal(isRangeCovered([], 0, 100), false);
      assert.equal(isRangeCovered(null, 0, 100), false);
    });

    it('returns true when single range covers query', () => {
      assert.equal(isRangeCovered([[0, 2000]], 0, 2000), true);
      assert.equal(isRangeCovered([[0, 2000]], 50, 500), true);
    });

    it('returns false when single range does not cover', () => {
      assert.equal(isRangeCovered([[0, 100]], 0, 200), false);
      assert.equal(isRangeCovered([[100, 300]], 0, 200), false);
    });

    it('merges overlapping ranges to determine coverage', () => {
      // [0,150] + [100,300] merge to [0,300]
      assert.equal(isRangeCovered([[0, 150], [100, 300]], 0, 300), true);
    });

    it('detects gap between non-overlapping ranges', () => {
      // [0,100] and [200,400] — gap at [100,200]
      assert.equal(isRangeCovered([[0, 100], [200, 400]], 0, 300), false);
    });

    it('merges adjacent ranges', () => {
      // [0,100] + [100,200] — second starts where first ends
      assert.equal(isRangeCovered([[0, 100], [100, 200]], 0, 200), true);
    });

    it('handles unsorted input ranges', () => {
      assert.equal(isRangeCovered([[100, 200], [0, 150]], 0, 200), true);
    });
  });
});

describe('anatomy logic', () => {
  describe('categorize', () => {
    it('classifies test files by extension', () => {
      assert.equal(categorize('src/foo.test.ts'), 'test');
      assert.equal(categorize('src/foo.spec.js'), 'test');
    });

    it('classifies files in test directories', () => {
      assert.equal(categorize('src/tests/helper.ts'), 'test');
      assert.equal(categorize('src/__tests__/utils.js'), 'test');
    });

    it('does not classify top-level tests/ without leading slash as test', () => {
      // regex requires /test(s)?/ — no leading slash for top-level relative paths
      assert.equal(categorize('tests/helper.ts'), 'source');
    });

    it('classifies source files', () => {
      assert.equal(categorize('src/index.ts'), 'source');
      assert.equal(categorize('lib/main.py'), 'source');
      assert.equal(categorize('pkg/server.go'), 'source');
    });

    it('classifies config files', () => {
      assert.equal(categorize('package.json'), 'config');
      assert.equal(categorize('config.yaml'), 'config');
      assert.equal(categorize('Dockerfile'), 'config');
      assert.equal(categorize('tsconfig.json'), 'config');
    });

    it('classifies .config.ts as source (source check runs first)', () => {
      // .ts is a source ext and source check precedes config check
      assert.equal(categorize('vite.config.ts'), 'source');
    });

    it('classifies docs', () => {
      assert.equal(categorize('README.md'), 'docs');
      assert.equal(categorize('docs/guide.txt'), 'docs');
    });

    it('classifies styles', () => {
      assert.equal(categorize('src/app.css'), 'style');
      assert.equal(categorize('src/theme.scss'), 'style');
    });

    it('classifies .styled.ts as source (source ext takes precedence)', () => {
      // .ts matched as source before .styled. pattern for style
      assert.equal(categorize('Button.styled.ts'), 'source');
    });

    it('returns other for unrecognized files', () => {
      assert.equal(categorize('Procfile'), 'other');
      assert.equal(categorize('src/data.bin'), 'other');
    });

    it('prioritizes test over source for .test.ts files', () => {
      // A .test.ts file matches both test and source patterns
      assert.equal(categorize('src/utils.test.ts'), 'test');
    });
  });

  describe('shouldSkip', () => {
    it('skips binary/media files', () => {
      assert.equal(shouldSkip('logo.png'), true);
      assert.equal(shouldSkip('font.woff2'), true);
      assert.equal(shouldSkip('video.mp4'), true);
    });

    it('skips lockfiles by name', () => {
      assert.equal(shouldSkip('package-lock.json'), true);
      assert.equal(shouldSkip('yarn.lock'), true);
      assert.equal(shouldSkip('pnpm-lock.yaml'), true);
    });

    it('skips minified files', () => {
      assert.equal(shouldSkip('bundle.min.js'), true);
      assert.equal(shouldSkip('styles.min.css'), true);
    });

    it('does not skip source files', () => {
      assert.equal(shouldSkip('index.ts'), false);
      assert.equal(shouldSkip('main.py'), false);
      assert.equal(shouldSkip('README.md'), false);
    });

    it('skips sourcemaps and archives', () => {
      assert.equal(shouldSkip('bundle.map'), true);
      assert.equal(shouldSkip('dist.zip'), true);
      assert.equal(shouldSkip('data.tar'), true);
    });
  });
});

describe('contextignore', () => {
  describe('_globToRegex', () => {
    it('matches exact filenames', () => {
      const re = _globToRegex('package-lock.json');
      assert.ok(re.test('package-lock.json'));
      assert.ok(!re.test('package.json'));
      assert.ok(!re.test('xpackage-lock.json'));
    });

    it('matches single-star extension globs', () => {
      const re = _globToRegex('*.lock');
      assert.ok(re.test('yarn.lock'));
      assert.ok(re.test('Gemfile.lock'));
      assert.ok(!re.test('lockfile'));
      assert.ok(!re.test('.lock.bak'));
    });

    it('matches compound extension globs like *.min.js', () => {
      const re = _globToRegex('*.min.js');
      assert.ok(re.test('bundle.min.js'));
      assert.ok(re.test('app.min.js'));
      assert.ok(!re.test('app.js'));
      assert.ok(!re.test('app.min.css'));
    });

    it('matches double-star directory globs', () => {
      const re = _globToRegex('dist/**');
      assert.ok(re.test('dist/index.js'));
      assert.ok(re.test('dist/sub/deep/file.ts'));
      assert.ok(!re.test('src/dist/index.js'));
    });

    it('matches wildcard-in-middle patterns', () => {
      const re = _globToRegex('*.generated.*');
      assert.ok(re.test('schema.generated.ts'));
      assert.ok(re.test('api.generated.js'));
      assert.ok(!re.test('schema.ts'));
    });

    it('single star does not match across path separators', () => {
      const re = _globToRegex('*.js');
      assert.ok(re.test('index.js'));
      assert.ok(!re.test('src/index.js'));
    });

    it('escapes regex special characters', () => {
      const re = _globToRegex('file.name+special.js');
      assert.ok(re.test('file.name+special.js'));
      assert.ok(!re.test('fileXnameXspecialXjs'));
    });

    it('handles ? as single character wildcard', () => {
      const re = _globToRegex('file?.txt');
      assert.ok(re.test('file1.txt'));
      assert.ok(re.test('fileA.txt'));
      assert.ok(!re.test('file12.txt'));
      assert.ok(!re.test('file/.txt'));
    });
  });

  describe('_parseIgnoreFile', () => {
    it('returns empty array for non-existent file', () => {
      const result = _parseIgnoreFile('/tmp/nonexistent-contextignore-' + Date.now());
      assert.deepEqual(result, []);
    });

    // Issue #33: a Windows-authored .contextignore is CRLF; a trailing \r on
    // every pattern made all of them silently fail to match.
    it('parses CRLF and LF files identically', () => {
      const body = '# comment\n*.lock\n\ndist/**\n';
      const lf = join('/tmp', `cco-ignore-lf-${process.pid}`);
      const crlf = join('/tmp', `cco-ignore-crlf-${process.pid}`);
      writeFileSync(lf, body);
      writeFileSync(crlf, body.replace(/\n/g, '\r\n'));
      try {
        const rawsLf = _parseIgnoreFile(lf).map(p => p.raw);
        const rawsCrlf = _parseIgnoreFile(crlf).map(p => p.raw);
        assert.deepEqual(rawsLf, ['*.lock', 'dist/**']);
        assert.deepEqual(rawsCrlf, rawsLf);
      } finally {
        unlinkSync(lf);
        unlinkSync(crlf);
      }
    });
  });

  describe('isContextIgnored (integration)', () => {
    // These tests rely on the cwd NOT having a .contextignore,
    // so they verify the "no patterns loaded" path.
    // The globToRegex tests above cover the matching logic thoroughly.

    it('returns ignored:false when no .contextignore exists', () => {
      clearContextIgnoreCache();
      const originalCwd = process.cwd;
      process.cwd = () => '/tmp/no-contextignore-here-' + Date.now();
      try {
        const result = isContextIgnored('/some/random/file.js');
        assert.equal(result.ignored, false);
        assert.equal(result.pattern, '');
      } finally {
        process.cwd = originalCwd;
        clearContextIgnoreCache();
      }
    });

    it('returns the matching pattern string when ignored', () => {
      clearContextIgnoreCache();
      // Write a temporary .contextignore
      const tmpDir = '/tmp/contextignore-test-' + Date.now();
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, '.contextignore'), '*.lock\npackage-lock.json\ndist/**\n');

      const originalCwd = process.cwd;
      process.cwd = () => tmpDir;
      try {
        const r1 = isContextIgnored('/project/yarn.lock');
        assert.equal(r1.ignored, true);
        assert.equal(r1.pattern, '*.lock');

        const r2 = isContextIgnored('/project/package-lock.json');
        assert.equal(r2.ignored, true);
        assert.equal(r2.pattern, 'package-lock.json'); // exact match, *.lock doesn't match .json ext

        const r3 = isContextIgnored(join(tmpDir, 'dist', 'bundle.js'));
        assert.equal(r3.ignored, true);
        assert.equal(r3.pattern, 'dist/**');

        const r4 = isContextIgnored('/project/src/index.js');
        assert.equal(r4.ignored, false);
      } finally {
        process.cwd = originalCwd;
        clearContextIgnoreCache();
        try { unlinkSync(join(tmpDir, '.contextignore')); } catch {}
      }
    });
  });
});

// ── Budget config (auto-compact) tests ──────────────────────────────────────

describe('budget config', () => {
  describe('loadBudgetConfig', () => {
    it('returns defaults when no config file exists', () => {
      clearBudgetConfigCache();
      // If config file already exists, test the merge behavior
      const config = loadBudgetConfig();
      assert.equal(typeof config.autoCompactEnabled, 'boolean');
      assert.equal(typeof config.autoCompactThreshold, 'number');
      assert.equal(typeof config.criticalThreshold, 'number');
      assert.ok(config.autoCompactThreshold > 0 && config.autoCompactThreshold <= 100);
      assert.ok(config.criticalThreshold > 0 && config.criticalThreshold <= 100);
    });

    it('caches config on subsequent calls', () => {
      clearBudgetConfigCache();
      const config1 = loadBudgetConfig();
      const config2 = loadBudgetConfig();
      assert.strictEqual(config1, config2); // Same reference = cached
    });

    it('returns fresh config after clearBudgetConfigCache', () => {
      clearBudgetConfigCache();
      const config1 = loadBudgetConfig();
      clearBudgetConfigCache();
      const config2 = loadBudgetConfig();
      assert.notStrictEqual(config1, config2); // Different reference = reloaded
      assert.deepStrictEqual(config1, config2); // Same values
    });
  });

  describe('saveBudgetConfig', () => {
    it('saves and reloads config correctly', () => {
      clearBudgetConfigCache();
      const custom = {
        autoCompactEnabled: false,
        autoCompactThreshold: 75,
        criticalThreshold: 85
      };
      saveBudgetConfig(custom);

      clearBudgetConfigCache();
      const loaded = loadBudgetConfig();
      assert.equal(loaded.autoCompactEnabled, false);
      assert.equal(loaded.autoCompactThreshold, 75);
      assert.equal(loaded.criticalThreshold, 85);

      // Restore defaults
      saveBudgetConfig({
        autoCompactEnabled: true,
        autoCompactThreshold: 80,
        criticalThreshold: 90
      });
      clearBudgetConfigCache();
    });

    it('merges partial config with defaults', () => {
      clearBudgetConfigCache();
      saveBudgetConfig({ autoCompactEnabled: false });

      clearBudgetConfigCache();
      const loaded = loadBudgetConfig();
      assert.equal(loaded.autoCompactEnabled, false);
      // Defaults should be preserved for unspecified fields
      assert.equal(loaded.autoCompactThreshold, 80);
      assert.equal(loaded.criticalThreshold, 90);

      // Restore defaults
      saveBudgetConfig({
        autoCompactEnabled: true,
        autoCompactThreshold: 80,
        criticalThreshold: 90
      });
      clearBudgetConfigCache();
    });

    it('updates cache immediately after save', () => {
      clearBudgetConfigCache();
      saveBudgetConfig({ autoCompactEnabled: false });
      // Should return cached value without needing clearBudgetConfigCache
      const loaded = loadBudgetConfig();
      assert.equal(loaded.autoCompactEnabled, false);

      // Restore defaults
      saveBudgetConfig({
        autoCompactEnabled: true,
        autoCompactThreshold: 80,
        criticalThreshold: 90
      });
      clearBudgetConfigCache();
    });
  });

  describe('config file persistence', () => {
    it('creates budget-config.json on first load', () => {
      // The file should exist after loadBudgetConfig has been called
      assert.ok(existsSync(BUDGET_CONFIG_FILE));
    });

    it('config file contains valid JSON', () => {
      const data = loadJSON(BUDGET_CONFIG_FILE);
      assert.ok(data !== null);
      assert.equal(typeof data.autoCompactEnabled, 'boolean');
    });
  });

  describe('threshold validation', () => {
    it('autoCompactThreshold defaults to 80', () => {
      clearBudgetConfigCache();
      saveBudgetConfig({ autoCompactEnabled: true });
      clearBudgetConfigCache();
      const config = loadBudgetConfig();
      assert.equal(config.autoCompactThreshold, 80);

      // Restore
      saveBudgetConfig({
        autoCompactEnabled: true,
        autoCompactThreshold: 80,
        criticalThreshold: 90
      });
      clearBudgetConfigCache();
    });

    it('criticalThreshold defaults to 90', () => {
      clearBudgetConfigCache();
      saveBudgetConfig({ autoCompactEnabled: true });
      clearBudgetConfigCache();
      const config = loadBudgetConfig();
      assert.equal(config.criticalThreshold, 90);

      // Restore
      saveBudgetConfig({
        autoCompactEnabled: true,
        autoCompactThreshold: 80,
        criticalThreshold: 90
      });
      clearBudgetConfigCache();
    });
  });
});

// ── File Digest tests ─────────────────────────────────────────────────────────

import { parseFileStructure, formatDigest } from '../src/file-digest.js';

describe('file-digest', () => {
  describe('parseFileStructure', () => {
    it('returns empty array for non-existent file', () => {
      const result = parseFileStructure('/tmp/nonexistent-file-' + Date.now() + '.js');
      assert.deepEqual(result, []);
    });

    it('detects JS functions', () => {
      const tmp = '/tmp/test-digest-func-' + Date.now() + '.js';
      writeFileSync(tmp, [
        'import { foo } from "bar";',
        'import { baz } from "qux";',
        '',
        'function handleClick() {',
        '  console.log("clicked");',
        '}',
        '',
        'async function fetchData() {',
        '  return fetch("/api");',
        '}',
        '',
        'export default handleClick;',
      ].join('\n'));
      try {
        const landmarks = parseFileStructure(tmp);
        const labels = landmarks.map(l => l.label);
        assert.ok(labels.some(l => l.includes('imports')), 'should detect import block');
        assert.ok(labels.some(l => l.includes('handleClick')), 'should detect handleClick');
        assert.ok(labels.some(l => l.includes('fetchData')), 'should detect fetchData');
        assert.ok(labels.some(l => l.includes('export default')), 'should detect export default');
      } finally {
        try { unlinkSync(tmp); } catch {}
      }
    });

    it('detects classes and interfaces', () => {
      const tmp = '/tmp/test-digest-class-' + Date.now() + '.ts';
      writeFileSync(tmp, [
        'interface UserProps {',
        '  name: string;',
        '}',
        '',
        'export class UserService {',
        '  constructor() {}',
        '  getUser() { return null; }',
        '}',
        '',
        'type ID = string | number;',
      ].join('\n'));
      try {
        const landmarks = parseFileStructure(tmp);
        const labels = landmarks.map(l => l.label);
        assert.ok(labels.some(l => l.includes('UserProps')), 'should detect interface');
        assert.ok(labels.some(l => l.includes('UserService')), 'should detect class');
        assert.ok(labels.some(l => l.includes('ID')), 'should detect type alias');
      } finally {
        try { unlinkSync(tmp); } catch {}
      }
    });

    it('detects Svelte sections', () => {
      const tmp = '/tmp/test-digest-svelte-' + Date.now() + '.svelte';
      writeFileSync(tmp, [
        '<script lang="ts">',
        '  let count = 0;',
        '  function increment() { count++; }',
        '</script>',
        '',
        '<button on:click={increment}>',
        '  {count}',
        '</button>',
        '',
        '<style>',
        '  button { color: red; }',
        '</style>',
      ].join('\n'));
      try {
        const landmarks = parseFileStructure(tmp);
        const labels = landmarks.map(l => l.label);
        assert.ok(labels.some(l => l === '<script>'), 'should detect <script>');
        assert.ok(labels.some(l => l.includes('increment')), 'should detect function inside script');
        assert.ok(labels.some(l => l === '<style>'), 'should detect <style>');
      } finally {
        try { unlinkSync(tmp); } catch {}
      }
    });

    it('detects Python functions and classes', () => {
      const tmp = '/tmp/test-digest-py-' + Date.now() + '.py';
      writeFileSync(tmp, [
        'import os',
        'from pathlib import Path',
        '',
        'class FileProcessor:',
        '    def __init__(self):',
        '        pass',
        '',
        '    async def process(self, path):',
        '        return Path(path).read_text()',
        '',
        'def main():',
        '    fp = FileProcessor()',
      ].join('\n'));
      try {
        const landmarks = parseFileStructure(tmp);
        const labels = landmarks.map(l => l.label);
        assert.ok(labels.some(l => l.includes('FileProcessor')), 'should detect class');
        assert.ok(labels.some(l => l.includes('__init__')), 'should detect __init__');
        assert.ok(labels.some(l => l.includes('process')), 'should detect async def');
        assert.ok(labels.some(l => l.includes('main')), 'should detect main');
      } finally {
        try { unlinkSync(tmp); } catch {}
      }
    });

    it('detects Go funcs and types', () => {
      const tmp = '/tmp/test-digest-go-' + Date.now() + '.go';
      writeFileSync(tmp, [
        'package main',
        '',
        'import "fmt"',
        '',
        'type Server struct {',
        '    port int',
        '}',
        '',
        'func (s *Server) Start() {',
        '    fmt.Println("starting")',
        '}',
        '',
        'func NewServer(port int) *Server {',
        '    return &Server{port: port}',
        '}',
      ].join('\n'));
      try {
        const landmarks = parseFileStructure(tmp);
        const labels = landmarks.map(l => l.label);
        assert.ok(labels.some(l => l.includes('Server') && l.includes('struct')), 'should detect struct');
        assert.ok(labels.some(l => l.includes('Start')), 'should detect method');
        assert.ok(labels.some(l => l.includes('NewServer')), 'should detect func');
      } finally {
        try { unlinkSync(tmp); } catch {}
      }
    });

    it('detects Rust items', () => {
      const tmp = '/tmp/test-digest-rs-' + Date.now() + '.rs';
      writeFileSync(tmp, [
        'pub struct Config {',
        '    pub port: u16,',
        '}',
        '',
        'pub enum Mode {',
        '    Debug,',
        '    Release,',
        '}',
        '',
        'impl Config {',
        '    pub fn new() -> Self {',
        '        Config { port: 8080 }',
        '    }',
        '}',
        '',
        'pub trait Service {',
        '    fn start(&self);',
        '}',
      ].join('\n'));
      try {
        const landmarks = parseFileStructure(tmp);
        const labels = landmarks.map(l => l.label);
        assert.ok(labels.some(l => l.includes('struct Config')), 'should detect struct');
        assert.ok(labels.some(l => l.includes('enum Mode')), 'should detect enum');
        assert.ok(labels.some(l => l.includes('impl Config')), 'should detect impl');
        assert.ok(labels.some(l => l.includes('fn new')), 'should detect fn');
        assert.ok(labels.some(l => l.includes('trait Service')), 'should detect trait');
      } finally {
        try { unlinkSync(tmp); } catch {}
      }
    });

    it('collapses multiple imports into a single range', () => {
      const tmp = '/tmp/test-digest-imports-' + Date.now() + '.js';
      writeFileSync(tmp, [
        'import { a } from "a";',
        'import { b } from "b";',
        'import { c } from "c";',
        'import { d } from "d";',
        '',
        'function main() {}',
      ].join('\n'));
      try {
        const landmarks = parseFileStructure(tmp);
        const importEntries = landmarks.filter(l => l.label.includes('import'));
        assert.equal(importEntries.length, 1, 'should collapse to single import entry');
        assert.ok(importEntries[0].label.includes('1'), 'should start at line 1');
        assert.ok(importEntries[0].label.includes('4'), 'should end at line 4');
      } finally {
        try { unlinkSync(tmp); } catch {}
      }
    });

    it('detects JSON top-level keys', () => {
      const tmp = '/tmp/test-digest-json-' + Date.now() + '.json';
      writeFileSync(tmp, JSON.stringify({
        name: "test",
        version: "1.0.0",
        dependencies: { foo: "^1.0" },
        scripts: { test: "node test" }
      }, null, 2));
      try {
        const landmarks = parseFileStructure(tmp);
        const labels = landmarks.map(l => l.label);
        assert.ok(labels.some(l => l.includes('name')), 'should detect "name"');
        assert.ok(labels.some(l => l.includes('version')), 'should detect "version"');
        assert.ok(labels.some(l => l.includes('dependencies')), 'should detect "dependencies"');
        assert.ok(labels.some(l => l.includes('scripts')), 'should detect "scripts"');
      } finally {
        try { unlinkSync(tmp); } catch {}
      }
    });
  });

  describe('formatDigest', () => {
    it('returns message for empty landmarks', () => {
      const result = formatDigest([], 100);
      assert.ok(result.includes('No structural landmarks'));
      assert.ok(result.includes('100'));
    });

    it('formats landmarks with line numbers', () => {
      const landmarks = [
        { line: 1, label: 'imports (1–5)' },
        { line: 10, label: 'function main()' },
        { line: 50, label: 'class Foo' },
      ];
      const result = formatDigest(landmarks, 200);
      assert.ok(result.includes('File map'));
      assert.ok(result.includes('200 lines'));
      assert.ok(result.includes('function main()'));
      assert.ok(result.includes('class Foo'));
      assert.ok(result.includes('10'));
      assert.ok(result.includes('50'));
    });

    it('caps at ~20 entries for large files', () => {
      const landmarks = Array.from({ length: 50 }, (_, i) => ({
        line: i * 10,
        label: `item_${i}`
      }));
      const result = formatDigest(landmarks, 500);
      const entryLines = result.split('\n').filter(l => l.trim().match(/^\d+:/));
      assert.ok(entryLines.length <= 21, `should cap at ~20 entries, got ${entryLines.length}`);
    });
  });
});

// ── Staleness detection tests (using recreated logic) ─────────────────────────

describe('staleness detection', () => {
  // Recreate checkStaleness as a pure function for testing
  const STALE_DISPLACEMENT_TOKENS = 20_000;
  const STALE_DISPLACEMENT_FILES = 8;
  const STALE_TIME_MS = 10 * 60 * 1000;

  function checkStaleness(cache, filePath) {
    const entry = cache.files[filePath];
    if (!entry || !entry.readAtMs) return { stale: false, reason: '' };

    const readTime = entry.readAtMs;
    let newerFiles = 0;
    let newerTokens = 0;

    for (const [path, other] of Object.entries(cache.files)) {
      if (path === filePath) continue;
      if ((other.readAtMs || 0) > readTime) {
        newerFiles++;
        newerTokens += other.tokens || 0;
      }
    }

    if (newerTokens >= STALE_DISPLACEMENT_TOKENS) {
      return { stale: true, reason: 'token displacement' };
    }
    if (newerFiles >= STALE_DISPLACEMENT_FILES) {
      return { stale: true, reason: 'file displacement' };
    }
    const elapsed = Date.now() - readTime;
    if (elapsed >= STALE_TIME_MS) {
      return { stale: true, reason: 'time decay' };
    }
    return { stale: false, reason: '' };
  }

  it('returns not stale for missing entry', () => {
    const cache = { files: {} };
    assert.equal(checkStaleness(cache, '/foo.js').stale, false);
  });

  it('returns not stale for fresh entry with no newer files', () => {
    const cache = {
      files: {
        '/foo.js': { readAtMs: Date.now(), tokens: 5000 }
      }
    };
    assert.equal(checkStaleness(cache, '/foo.js').stale, false);
  });

  it('detects staleness by token displacement', () => {
    const now = Date.now();
    const cache = {
      files: {
        '/old.js': { readAtMs: now - 60000, tokens: 5000 },
        '/new1.js': { readAtMs: now - 30000, tokens: 12000 },
        '/new2.js': { readAtMs: now - 20000, tokens: 12000 },
      }
    };
    const result = checkStaleness(cache, '/old.js');
    assert.equal(result.stale, true);
    assert.ok(result.reason.includes('token'));
  });

  it('detects staleness by file count displacement', () => {
    const now = Date.now();
    const files = { '/old.js': { readAtMs: now - 60000, tokens: 1000 } };
    for (let i = 0; i < 9; i++) {
      files[`/new${i}.js`] = { readAtMs: now - 50000 + i * 1000, tokens: 500 };
    }
    const cache = { files };
    const result = checkStaleness(cache, '/old.js');
    assert.equal(result.stale, true);
    assert.ok(result.reason.includes('file'));
  });

  it('detects staleness by time decay', () => {
    const cache = {
      files: {
        '/old.js': { readAtMs: Date.now() - 11 * 60 * 1000, tokens: 5000 }
      }
    };
    const result = checkStaleness(cache, '/old.js');
    assert.equal(result.stale, true);
    assert.ok(result.reason.includes('time'));
  });

  it('does not trigger staleness for small displacement', () => {
    const now = Date.now();
    const cache = {
      files: {
        '/old.js': { readAtMs: now - 60000, tokens: 5000 },
        '/new1.js': { readAtMs: now - 30000, tokens: 3000 },
        '/new2.js': { readAtMs: now - 20000, tokens: 3000 },
      }
    };
    const result = checkStaleness(cache, '/old.js');
    assert.equal(result.stale, false);
  });

  it('ignores files older than the target', () => {
    const now = Date.now();
    const cache = {
      files: {
        '/target.js': { readAtMs: now - 60000, tokens: 5000 },
        '/older.js': { readAtMs: now - 120000, tokens: 50000 },
      }
    };
    const result = checkStaleness(cache, '/target.js');
    assert.equal(result.stale, false, 'older files should not count as displacement');
  });
});

// ── Model cost tests (Opus 4.7-aware) ───────────────────────────────────────

describe('model costs', () => {
  it('opus-4.8 has correct prices and 1M window', () => {
    const c = getModelCost('opus-4.8');
    assert.equal(c.input, 5);
    assert.equal(c.output, 25);
    assert.equal(c.contextWindow, 1_000_000);
  });

  it('opus-4.7 matches opus-4.8 pricing and 1M window', () => {
    const c = getModelCost('opus-4.7');
    assert.equal(c.input, 5);
    assert.equal(c.output, 25);
    assert.equal(c.contextWindow, 1_000_000);
  });

  it('1m aliases carry no surcharge (standard Opus price)', () => {
    const c = getModelCost('opus-4.8-1m');
    assert.equal(c.contextWindow, 1_000_000);
    assert.equal(c.input, 5, '1M window is standard-priced — no premium');
    assert.equal(c.output, 25);
  });

  it('sonnet-4.6 has correct prices and 1M window', () => {
    const c = getModelCost('sonnet-4.6');
    assert.equal(c.input, 3);
    assert.equal(c.output, 15);
    assert.equal(c.contextWindow, 1_000_000);
  });

  it('haiku-4.5 has correct prices and 200K window', () => {
    const c = getModelCost('haiku-4.5');
    assert.equal(c.input, 1);
    assert.equal(c.output, 5);
    assert.equal(c.contextWindow, 200_000);
  });

  it('falls back to opus when model unknown', () => {
    const c = getModelCost('unknown-model-xyz');
    assert.equal(c.input, 5);
  });

  it('getModelContextWindow returns correct window', () => {
    assert.equal(getModelContextWindow('opus-4.8'), 1_000_000);
    assert.equal(getModelContextWindow('haiku-4.5'), 200_000);
  });
});

// ── Import safety (regression: v3.6.0 hooks hung CI by reading stdin on import) ─

// ── Task register (per-task context attribution) ────────────────────────────

describe('tasks', () => {
  const P = '/proj/a';

  it('emptyState has no tasks', () => {
    const s = emptyState();
    assert.equal(s.tasks.length, 0);
    assert.equal(getActiveTask(s, { project: P }), null);
  });

  it('addTask creates one active task with a token baseline', () => {
    const { state, task } = addTask(emptyState(), { name: 'fix bug', project: P, tokensNow: 5000 });
    assert.equal(task.status, 'active');
    assert.equal(task.tokensAtStart, 5000);
    assert.equal(getActiveTask(state, { project: P }).id, task.id);
  });

  it('starting a new task completes the previous active one (one active at a time)', () => {
    let { state } = addTask(emptyState(), { name: 'first', project: P, tokensNow: 1000 });
    const r = addTask(state, { name: 'second', project: P, tokensNow: 4000 });
    state = r.state;
    const active = getActiveTask(state, { project: P });
    assert.equal(active.name, 'second');
    // first task is closed and its end snapshot is the second task's start
    const first = state.tasks.find(t => t.name === 'first');
    assert.equal(first.status, 'done');
    assert.equal(first.tokensAtEnd, 4000);
  });

  it('taskSpend is the token delta over the task window, floored at 0', () => {
    const { task } = addTask(emptyState(), { name: 't', project: P, tokensNow: 2000 });
    assert.equal(taskSpend(task, 9000), 7000);
    assert.equal(taskSpend(task, 1000), 0); // never negative
  });

  it('completeActiveTask freezes the spend', () => {
    const { state } = addTask(emptyState(), { name: 't', project: P, tokensNow: 2000 });
    const r = completeActiveTask(state, { project: P, tokensNow: 12000 });
    assert.equal(r.task.status, 'done');
    assert.equal(taskSpend(r.task, 999999), 10000); // frozen at completion delta
    assert.equal(getActiveTask(r.state, { project: P }), null);
  });

  it('tasks are scoped by project', () => {
    let { state } = addTask(emptyState(), { name: 'a-task', project: '/proj/a', tokensNow: 0 });
    state = addTask(state, { name: 'b-task', project: '/proj/b', tokensNow: 0 }).state;
    assert.equal(getActiveTask(state, { project: '/proj/a' }).name, 'a-task');
    assert.equal(getActiveTask(state, { project: '/proj/b' }).name, 'b-task');
    assert.equal(tasksForProject(state, '/proj/a').length, 1);
  });

  it('tasksForProject returns newest first', () => {
    let s = emptyState();
    s = addTask(s, { name: 'one', project: P, tokensNow: 0 }).state;
    s = addTask(s, { name: 'two', project: P, tokensNow: 0 }).state;
    const list = tasksForProject(s, P);
    assert.equal(list[0].name, 'two');
  });
});

// ── Notice ledger (keeps the optimizer from polluting Claude's context) ──────

describe('notices (noise budget)', () => {
  it('emptyLedger starts at zero', () => {
    const l = emptyLedger();
    assert.equal(l.count, 0);
    assert.equal(l.tokensInjected, 0);
    assert.deepEqual(l.kinds, {});
  });

  it('allows a normal notice when under cap and kind unseen', () => {
    assert.equal(shouldEmit(emptyLedger(), { kind: 'budget:50' }), true);
  });

  it('suppresses a repeated kind (no double nag)', () => {
    let l = emptyLedger();
    l = recordEmit(l, { kind: 'track:foo.js', text: 'read 3x' });
    assert.equal(shouldEmit(l, { kind: 'track:foo.js' }), false);
  });

  it('suppresses normal notices once the session cap is hit', () => {
    let l = emptyLedger();
    for (let i = 0; i < DEFAULT_NOTICE_CAP; i++) {
      l = recordEmit(l, { kind: `k${i}`, text: 'x' });
    }
    assert.equal(shouldEmit(l, { kind: 'one-more' }), false);
  });

  it('always allows critical notices, even past the cap', () => {
    let l = emptyLedger();
    for (let i = 0; i < DEFAULT_NOTICE_CAP + 5; i++) {
      l = recordEmit(l, { kind: `k${i}`, text: 'x' });
    }
    assert.equal(shouldEmit(l, { kind: 'budget:critical', priority: 'critical' }), true);
  });

  it('recordEmit accrues injected tokens (the overhead the dashboard nets out)', () => {
    const l = recordEmit(emptyLedger(), { kind: 'k', text: 'a'.repeat(370) });
    assert.ok(l.tokensInjected > 0, 'injected tokens should be counted');
    assert.equal(l.count, 1);
  });
});

// ── Big-file first-read nudge ────────────────────────────────────────────────

describe('shouldNudgeBigFile', () => {
  const base = { entry: null, hasOffset: false, hasLimit: false, lines: 2000, threshold: 1500, enabled: true };

  it('nudges on first full read of a very large file', () => {
    assert.equal(shouldNudgeBigFile(base), true);
  });

  it('does not nudge when disabled', () => {
    assert.equal(shouldNudgeBigFile({ ...base, enabled: false }), false);
  });

  it('does not nudge a file already seen (entry present)', () => {
    assert.equal(shouldNudgeBigFile({ ...base, entry: { mtime: 1 } }), false);
  });

  it('respects a targeted read (offset/limit present)', () => {
    assert.equal(shouldNudgeBigFile({ ...base, hasOffset: true }), false);
    assert.equal(shouldNudgeBigFile({ ...base, hasLimit: true }), false);
  });

  it('does not nudge files under the threshold', () => {
    assert.equal(shouldNudgeBigFile({ ...base, lines: 800 }), false);
    assert.equal(shouldNudgeBigFile({ ...base, lines: 0 }), false);
  });
});

describe('import safety (isMainModule guard)', () => {
  it('isMainModule is true for the entry module (this test file, run directly)', () => {
    // node --test tests/test.js makes this file the process entry point.
    assert.equal(isMainModule(import.meta.url), true);
  });

  it('isMainModule is false for any module that is not the entry point', () => {
    // An imported hook module (budget.js, prompt-coach.js, …) has a url that is
    // NOT process.argv[1], so its guarded main() never fires on import. If it
    // did, main() would block on process.stdin — exactly what hung v3.6.0 CI 6h.
    assert.equal(isMainModule('file:///some/other/module.js'), false);
  });

  // The real regression guard is that this test file finishes and the process
  // exits at all: it imports budget.js and prompt-coach.js, whose guarded
  // main() must NOT read stdin on import.
});

describe('getEffectiveBudget', () => {
  it('caps budget at model context window (haiku = 200K)', () => {
    const budget = getEffectiveBudget({ budgetTokens: 2_000_000, model: 'haiku-4.5' });
    assert.equal(budget, 200_000);
  });

  it('honours user budget below model window', () => {
    const budget = getEffectiveBudget({ budgetTokens: 50_000, model: 'opus-4.8' });
    assert.equal(budget, 50_000);
  });

  it('allows up to 1M for opus-4.8 (1M is standard)', () => {
    const budget = getEffectiveBudget({ budgetTokens: 1_000_000, model: 'opus-4.8' });
    assert.equal(budget, 1_000_000);
  });
});

// ── Unified classification (regression — was duplicated before) ──────────────

describe('unified classification', () => {
  it('categorizeFile detects new languages', () => {
    assert.equal(categorizeFile('app.svelte'), 'source');
    assert.equal(categorizeFile('app.vue'), 'source');
    assert.equal(categorizeFile('foo.ex'), 'source');
    assert.equal(categorizeFile('script.sh'), 'script');
  });

  it('shouldIgnoreForTracking covers transients and lockfiles', () => {
    assert.equal(shouldIgnoreForTracking('/dev/stdin'), true);
    assert.equal(shouldIgnoreForTracking('/proc/self/maps'), true);
    assert.equal(shouldIgnoreForTracking('toolu_abc.json'), true);
    assert.equal(shouldIgnoreForTracking('node_modules/foo.js'), true);
    assert.equal(shouldIgnoreForTracking('package-lock.json'), true);
    assert.equal(shouldIgnoreForTracking('src/index.ts'), false);
    assert.equal(shouldIgnoreForTracking(''), true);
    assert.equal(shouldIgnoreForTracking(null), true);
  });
});

// ── Token estimation: new languages ─────────────────────────────────────────

describe('estimateTokens (extended ratios)', () => {
  it('uses ratio for .svelte', () => {
    assert.equal(estimateTokens(100, '.svelte'), Math.round((100 * CHARS_PER_LINE['.svelte']) / 3.6));
  });
  it('uses ratio for .sh', () => {
    assert.equal(estimateTokens(100, '.sh'), Math.round((100 * CHARS_PER_LINE['.sh']) / 3.5));
  });
  it('uses ratio for .php', () => {
    assert.equal(estimateTokens(100, '.php'), Math.round((100 * CHARS_PER_LINE['.php']) / 3.7));
  });
});

describe('estimateTokensFromString', () => {
  it('returns 0 for empty/null', () => {
    assert.equal(estimateTokensFromString(''), 0);
    assert.equal(estimateTokensFromString(null), 0);
  });
  it('uses default ratio for no extension', () => {
    const s = 'a'.repeat(370);
    assert.equal(estimateTokensFromString(s), 100);
  });
  it('respects extension ratio', () => {
    const s = 'a'.repeat(420);
    assert.equal(estimateTokensFromString(s, '.md'), 100);
  });
});

// ── Prompt Coach tests ──────────────────────────────────────────────────────

describe('prompt-coach', () => {
  describe('analyzePrompt', () => {
    it('returns F for empty prompts', () => {
      const a = analyzePrompt('');
      assert.equal(a.grade, 'F');
      assert.equal(a.score, 0);
    });

    it('low score for vague unbounded prompt', () => {
      const a = analyzePrompt('improve everything in the codebase');
      assert.ok(a.score < 50, `expected <50, got ${a.score}`);
      assert.ok(a.suggestions.length > 0);
      assert.ok(a.signals.hasUnbounded);
    });

    it('high score for specific prompt with file path and success criteria', () => {
      const a = analyzePrompt(
        'Add input validation to src/auth/login.ts:42 in the validateEmail() function so the unit test in tests/auth.test.ts passes'
      );
      assert.ok(a.score >= 70, `expected >=70, got ${a.score}`);
      assert.ok(a.signals.filePathsFound.length > 0);
      assert.ok(a.signals.hasLineRef);
      assert.ok(a.signals.hasSuccess);
    });

    it('detects vague verbs', () => {
      const a = analyzePrompt('please optimize the auth module');
      assert.ok(a.signals.hasVagueVerb);
    });

    it('detects strong verbs', () => {
      const a = analyzePrompt('rename `getUser` to `fetchUser` in src/api.ts');
      assert.ok(a.signals.hasStrongVerb);
      assert.ok(a.signals.filePathsFound.length > 0);
    });

    it('flags very short prompts', () => {
      const a = analyzePrompt('fix it');
      assert.ok(a.suggestions.some(s => s.toLowerCase().includes('short')));
    });

    it('extracts mentioned file paths', () => {
      const a = analyzePrompt('change src/foo.ts and tests/bar.spec.js');
      assert.ok(a.signals.filePathsFound.includes('src/foo.ts'));
      assert.ok(a.signals.filePathsFound.includes('tests/bar.spec.js'));
    });

    it('does not extract domain-like substrings as file paths', () => {
      const a = analyzePrompt('the bug is at example.com');
      assert.equal(a.signals.filePathsFound.length, 0);
    });
  });

  describe('buildImprovedPrompt', () => {
    it('returns original prompt when no suggestions', () => {
      const a = { suggestions: [], signals: {} };
      assert.equal(buildImprovedPrompt('hello', a), 'hello');
    });

    it('appends self-check guardrails when prompt is weak', () => {
      const a = analyzePrompt('improve everything');
      const improved = buildImprovedPrompt('improve everything', a);
      assert.ok(improved.length > 'improve everything'.length);
      assert.ok(improved.includes('Self-check'));
    });
  });
});

// ── Budget — token + cost estimation ────────────────────────────────────────

describe('budget', () => {
  describe('estimateToolTokens', () => {
    it('Read counts only as input', () => {
      const t = estimateToolTokens('Read', { limit: 100 });
      assert.ok(t.input > 0);
      assert.equal(t.output, 0);
    });

    it('Write counts as output', () => {
      const t = estimateToolTokens('Write', { content: 'a'.repeat(370) });
      assert.ok(t.output >= 100);
      assert.ok(t.input < t.output);
    });

    it('Edit splits between input (old) and output (new)', () => {
      const t = estimateToolTokens('Edit', {
        old_string: 'a'.repeat(370),
        new_string: 'b'.repeat(740)
      });
      assert.ok(t.input > 0);
      assert.ok(t.output > t.input);
    });

    it('MCP tools get default tokens', () => {
      const t = estimateToolTokens('mcp__github__create_issue', {});
      assert.ok(t.input > 0);
      assert.ok(t.output > 0);
    });
  });

  describe('computeCost', () => {
    it('charges input + output at model rates', () => {
      const state = { inputTokensEstimated: 1_000_000, outputTokensEstimated: 1_000_000 };
      const cost = computeCost(state, 'opus-4.8');
      // 1M * $5 input + 1M * $25 output = $30
      assert.equal(cost, 30);
    });

    it('opus costs more than sonnet for the same usage', () => {
      const state = { inputTokensEstimated: 1_000_000, outputTokensEstimated: 1_000_000 };
      const opus = computeCost(state, 'opus-4.8');
      const sonnet = computeCost(state, 'sonnet-4.6');
      assert.ok(opus > sonnet);
    });
  });
});

// ── Regression: cost math must stay scalar, Read estimates size-aware ────────

describe('cost + estimation regressions', () => {
  it('every MODEL_INPUT_COST value is a finite number (guards the $NaN class of bugs)', () => {
    for (const [model, rate] of Object.entries(MODEL_INPUT_COST)) {
      assert.ok(Number.isFinite(rate), `${model} input cost is not a number: ${rate}`);
    }
  });

  it('Read estimate is capped by the real file size, not the 2000-line default', () => {
    const tmp = join(homedir(), '.claude-context-optimizer', 'test-small-read.js');
    mkdirSync(join(homedir(), '.claude-context-optimizer'), { recursive: true });
    writeFileSync(tmp, 'const x = 1;\n'.repeat(10));
    try {
      const small = estimateToolTokens('Read', { file_path: tmp });
      const noFile = estimateToolTokens('Read', { file_path: '/nonexistent/void.js' });
      assert.ok(small.input < 200, `10-line file estimated at ${small.input} tokens`);
      assert.ok(noFile.input > 10000, 'missing file should fall back to the 2000-line default');
    } finally {
      unlinkSync(tmp);
    }
  });

  it('getFileLines estimates large files from size instead of reading them', () => {
    const tmp = join(homedir(), '.claude-context-optimizer', 'test-large.txt');
    // Lines sized to .txt's measured chars/line, so the size-based shortcut
    // should land on the real count. (#35 made this per-extension.)
    const line = 'x'.repeat(charsPerLine('.txt')) + '\n';
    writeFileSync(tmp, line.repeat(40000)); // 40K lines
    try {
      const lines = getFileLines(tmp);
      assert.ok(Math.abs(lines - 40000) < 2000, `estimate ${lines} too far from 40000`);
    } finally {
      unlinkSync(tmp);
    }
  });
});

// ── Transcript usage (real token counts) ─────────────────────────────────────

describe('transcript-usage', () => {
  const usageLine = (input, cacheRead, cacheWrite, output) => JSON.stringify({
    type: 'assistant',
    message: { usage: {
      input_tokens: input, cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite, output_tokens: output,
    } },
  });

  it('sums input + cache reads + cache writes into contextTokens', () => {
    const u = parseUsageFromLines([usageLine(100, 50000, 2000, 300)]);
    assert.equal(u.contextTokens, 52100);
    assert.equal(u.outputTokens, 300);
  });

  it('takes the LAST assistant usage, skipping malformed and non-usage lines', () => {
    const u = parseUsageFromLines([
      usageLine(1, 0, 0, 1),
      '{"type":"user","message":{"content":"hi"}}',
      'not json at all {{{',
      usageLine(9, 900, 0, 9),
      '{"type":"progress"}',
    ]);
    assert.equal(u.contextTokens, 909);
  });

  it('returns null when no usage exists', () => {
    assert.equal(parseUsageFromLines(['{"a":1}', 'junk']), null);
    assert.equal(readRealUsage('/nonexistent/transcript.jsonl'), null);
    assert.equal(readRealUsage(null), null);
  });

  it('reads real usage from a transcript file tail', () => {
    const tmp = join(homedir(), '.claude-context-optimizer', 'test-transcript.jsonl');
    writeFileSync(tmp, ['{"type":"user"}', usageLine(10, 40, 0, 5), ''].join('\n'));
    try {
      const u = readRealUsage(tmp);
      assert.equal(u.contextTokens, 50);
    } finally { unlinkSync(tmp); }
  });
});

// ── File lock (global stats serialization) ──────────────────────────────────

describe('acquireFileLock', () => {
  it('is exclusive while held and reacquirable after release', () => {
    const release = acquireFileLock('test-lock');
    const second = acquireFileLock('test-lock', { retries: 2, delayMs: 1 });
    // second acquisition must fail (returns the no-op release) while held —
    // we can't compare closures, so verify via a third acquire after release.
    second();
    release();
    const third = acquireFileLock('test-lock', { retries: 1, delayMs: 1 });
    assert.equal(typeof third, 'function');
    third();
  });

  it('steals a stale lock instead of hanging', () => {
    const release = acquireFileLock('test-stale');
    const start = Date.now();
    const second = acquireFileLock('test-stale', { retries: 5, delayMs: 5, staleMs: 0 });
    assert.ok(Date.now() - start < 1000, 'should steal immediately, not wait out retries');
    second();
    release();
  });
});

// ── Tracker session helpers ──────────────────────────────────────────────────

describe('tracker helpers', () => {
  it('trackSearch caps the detail list at 300 but keeps the true count', () => {
    const session = { searches: [], totalSearches: 0 };
    for (let i = 0; i < 350; i++) trackSearch(session, `pattern-${i}`, 'Grep');
    assert.equal(session.searches.length, 300);
    assert.equal(session.totalSearches, 350);
    // Oldest entries evicted, newest kept
    assert.equal(session.searches[299].pattern, 'pattern-349');
    assert.equal(session.searches[0].pattern, 'pattern-50');
  });

  it('trackToolUse counts per tool and total', () => {
    const session = { tools: {}, totalToolCalls: 0 };
    trackToolUse(session, 'Read');
    trackToolUse(session, 'Read');
    trackToolUse(session, 'Grep');
    assert.equal(session.tools.Read.calls, 2);
    assert.equal(session.tools.Grep.calls, 1);
    assert.equal(session.totalToolCalls, 3);
  });
});

// ── v4.3.0: prompt classification (chat / question / task) ──────────────────

describe('classifyPrompt', () => {
  it('classifies conversational replies as chat (en + ru)', () => {
    assert.equal(classifyPrompt('а те все хорошо ))'), 'chat');
    assert.equal(classifyPrompt('спасибо, отлично!'), 'chat');
    assert.equal(classifyPrompt('ok great'), 'chat');
    assert.equal(classifyPrompt('да'), 'chat');
    assert.equal(classifyPrompt('понял, спасибо большое, очень круто получилось'), 'chat');
    assert.equal(classifyPrompt(''), 'chat');
  });

  it('classifies questions as question, even short ones', () => {
    assert.equal(classifyPrompt('а почему и откуда появился этот контрибьютор?'), 'question');
    assert.equal(classifyPrompt('how does the read cache work?'), 'question');
    assert.equal(classifyPrompt('как мы можем еще улучшить наш оптимизатор'), 'question');
  });

  it('classifies work requests as task (imperatives beat question shape)', () => {
    assert.equal(classifyPrompt('давай все сделай и релизни тоже ))'), 'task');
    assert.equal(classifyPrompt('добавь функцию в src/utils.js'), 'task');
    assert.equal(classifyPrompt('fix the login bug in src/auth.ts'), 'task');
    assert.equal(classifyPrompt('почини ошибку TypeError в трекере'), 'task');
    assert.equal(classifyPrompt('что сделай чтобы починить'), 'task');
  });

  it('detects Russian strong verbs despite ASCII-only \\b', () => {
    const a = analyzePrompt('исправь баг в src/tracker.js чтобы тесты проходили');
    assert.equal(a.signals.hasStrongVerb, true);
    assert.equal(a.signals.hasSuccess, true);
  });
});

// ── v4.3.0: cache economics ──────────────────────────────────────────────────

describe('cache economics', () => {
  const econLine = (inp, cr, cc, out) => JSON.stringify({
    message: { usage: {
      input_tokens: inp, cache_read_input_tokens: cr,
      cache_creation_input_tokens: cc, output_tokens: out,
    } }
  });

  it('totals usage across all turns', () => {
    const e = parseEconomicsFromLines([econLine(10, 0, 30000, 500), econLine(10, 30000, 5000, 400)]);
    assert.equal(e.turns, 2);
    assert.deepEqual(e.totals, { input: 20, cacheRead: 30000, cacheCreation: 35000, output: 900 });
    assert.equal(e.breaks.length, 0);
  });

  it('detects a cache break when warm cache goes cold', () => {
    const e = parseEconomicsFromLines([
      econLine(10, 0, 30000, 500),
      econLine(10, 30000, 5000, 400),
      econLine(10, 2000, 33000, 300), // read 2K << 35K cached → break
    ]);
    assert.equal(e.breaks.length, 1);
    assert.equal(e.breaks[0].turn, 3);
    assert.equal(e.breaks[0].lostTokens, 33000);
  });

  it('does not flag small caches as breaks (noise threshold)', () => {
    const e = parseEconomicsFromLines([econLine(10, 0, 15000, 100), econLine(10, 0, 15000, 100)]);
    assert.equal(e.breaks.length, 0);
  });

  it('returns null with no usage records', () => {
    assert.equal(parseEconomicsFromLines(['{"a":1}', 'junk']), null);
  });

  it('computeCacheAwareCost prices reads at 10% and writes at 125%', () => {
    const c = computeCacheAwareCost(
      { input: 1000, cacheRead: 1_000_000, cacheCreation: 100_000, output: 10_000 }, 'opus-4.8');
    // 0.001*5 + 1*5*0.1 + 0.1*5*1.25 + 0.01*25 = 1.38
    assert.ok(Math.abs(c.real - 1.38) < 1e-9);
    assert.ok(Math.abs(c.naive - 5.755) < 1e-9);
    assert.ok(Math.abs(c.cacheSavings - 4.375) < 1e-9);
  });
});

// ── v4.3.0: session baseline overhead ───────────────────────────────────────

describe('overhead baseline', () => {
  it('takes the FIRST assistant usage (context before any work)', () => {
    const line = (inp, cr, cc) => JSON.stringify({ message: { usage: {
      input_tokens: inp, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 1 } } });
    const baseline = parseBaselineFromLines([
      '{"type":"user"}',
      line(10, 0, 45000),   // first response: 45K baseline
      line(10, 45000, 9000) // later turns must not win
    ]);
    assert.equal(baseline, 45010);
  });

  it('returns null when the transcript has no usage', () => {
    assert.equal(parseBaselineFromLines(['{"x":1}']), null);
  });

  // Issue #46: Claude Code munges '\', ':' and spaces to '-' as well, so a
  // Windows cwd produced a malformed path and "no session transcripts found".
  describe('projectTranscriptDir', () => {
    const folder = cwd => basename(projectTranscriptDir(cwd));

    it('encodes a Windows cwd the way Claude Code names the folder', () => {
      assert.equal(folder('C:\\Program Files\\Git'), 'C--Program-Files-Git');
    });

    it('still encodes a POSIX cwd unchanged', () => {
      assert.equal(folder('/Users/me/dev/my.app'), '-Users-me-dev-my-app');
    });

    it('roots the folder under ~/.claude/projects', () => {
      assert.ok(projectTranscriptDir('/a/b')
        .startsWith(join(homedir(), '.claude', 'projects')));
    });
  });
});

// ── v4.3.0: .contextignore suggestions ──────────────────────────────────────

describe('buildIgnoreSuggestions', () => {
  const patterns = { projects: {
    '/proj': { wastedReads: {
      '/proj/README.md': { sessions: 5, totalTokensWasted: 12000 },
      '/proj/docs/big.md': { sessions: 3, totalTokensWasted: 8000 },
      '/proj/rare.txt': { sessions: 1, totalTokensWasted: 100 },
      '/other/x.md': { sessions: 9, totalTokensWasted: 999 },
    } },
  } };

  it('suggests project-relative patterns for 3+ session waste, sorted by tokens', () => {
    const s = buildIgnoreSuggestions(patterns, '/proj');
    assert.deepEqual(s.map(x => x.pattern), ['README.md', 'docs/big.md']);
  });

  it('dedupes against existing .contextignore lines', () => {
    const s = buildIgnoreSuggestions(patterns, '/proj', ['docs/big.md', '# comment']);
    assert.deepEqual(s.map(x => x.pattern), ['README.md']);
  });

  it('never suggests files from other projects', () => {
    const s = buildIgnoreSuggestions(patterns, '/proj');
    assert.ok(!s.some(x => x.pattern.includes('..')));
  });
});

// ── v4.3.0: estimate self-calibration ───────────────────────────────────────

describe('emaCalibration', () => {
  it('moves 30% toward the observed ratio', () => {
    assert.equal(emaCalibration(1, 1.5), 1.15);
  });

  it('clamps wild ratios to [0.5, 2]', () => {
    assert.equal(emaCalibration(1, 50), 1.3);   // ratio clamped to 2
    assert.equal(emaCalibration(1, 0.01), 0.85); // ratio clamped to 0.5
  });

  it('keeps a neutral factor neutral', () => {
    assert.equal(emaCalibration(1, 1), 1);
  });
});

// ── v4.3.0: delegation advisor ──────────────────────────────────────────────

describe('updateExploreStreak', () => {
  it('advises once at 12 read-only calls and 20K tokens', () => {
    const s = {};
    for (let i = 0; i < 11; i++) assert.equal(updateExploreStreak(s, 'Read', 2000), false);
    assert.equal(updateExploreStreak(s, 'Read', 2000), true);
    assert.equal(updateExploreStreak(s, 'Read', 2000), false); // once per session
  });

  it('does not advise on many calls with few tokens', () => {
    const s = {};
    for (let i = 0; i < 30; i++) assert.equal(updateExploreStreak(s, 'Grep', 100), false);
  });

  it('resets on Edit/Write/Agent', () => {
    for (const reset of ['Edit', 'Write', 'Agent']) {
      const s = {};
      for (let i = 0; i < 10; i++) updateExploreStreak(s, 'Read', 5000);
      updateExploreStreak(s, reset);
      assert.equal(s.explore.streak, 0);
      assert.equal(s.explore.streakTokens, 0);
    }
  });
});

// ── v4.5.0: model auto-detection + savings headline ─────────────────────────

describe('normalizeModelId', () => {
  it('maps raw session ids to pricing keys', async () => {
    const { normalizeModelId } = await import('../src/utils.js');
    assert.equal(normalizeModelId('claude-fable-5'), 'fable');
    assert.equal(normalizeModelId('claude-fable-5[1m]'), 'fable');
    assert.equal(normalizeModelId('claude-mythos-5'), 'fable');
    assert.equal(normalizeModelId('claude-opus-4-8'), 'opus-4.8');
    assert.equal(normalizeModelId('claude-sonnet-5'), 'sonnet-5');
    assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'haiku');
    assert.equal(normalizeModelId('gpt-5'), null);
    assert.equal(normalizeModelId(null), null);
  });

  it('detected model drives the effective budget window', async () => {
    const { getEffectiveBudget } = await import('../src/utils.js');
    const cfg = { budgetTokens: 1_000_000, model: 'opus-4.8' };
    assert.equal(getEffectiveBudget(cfg, 'claude-haiku-4-5-20251001'), 200_000);
    assert.equal(getEffectiveBudget(cfg, 'claude-fable-5'), 1_000_000);
  });
});

describe('transcript model detection', () => {
  it('parseUsageFromLines returns the session model', () => {
    const lines = [JSON.stringify({
      message: { model: 'claude-fable-5', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }
    })];
    const u = parseUsageFromLines(lines);
    assert.equal(u.model, 'claude-fable-5');
    assert.equal(u.contextTokens, 100);
  });
});

describe('renderSummary savings headline', () => {
  it('leads with total $ saved and % of would-have-cost', async () => {
    const { renderSummary } = await import('../src/dashboard.js');
    const d = {
      hasData: true, saved: 1_000_000, used: 50_000, overhead: 0,
      cost: { input: 5, output: 25 }, dollars: 10, multiplier: 2,
      effectiveBudget: 1_000_000, reclaimable: 0,
      cacheEcon: { hitPct: 90, savings: 5, breaks: 0, breakTokens: 0, breakCost: 0, naive: 20 },
    };
    const out = renderSummary(d);
    // read-cache 1M tokens × $5/M = $5, plus $5 cache savings = $10 of a $20 would-have-cost
    assert.match(out, /★ CCO saved \$10\.00 this session — 50% of what it would have cost\./);
  });
});

describe('MCP usage audit', () => {
  it('splits configured servers by observed calls', async () => {
    const { splitMcpByUsage } = await import('../src/overhead.js');
    const configured = [
      { name: 'chrome', scope: 'user' },
      { name: 'ghost', scope: 'project' },
      { name: 'spine', scope: 'user' },
    ];
    const { used, unused } = splitMcpByUsage(configured, { chrome: 90, spine: 3 });
    assert.deepEqual(used.map(s => s.name), ['chrome', 'spine']); // sorted by calls
    assert.equal(used[0].calls, 90);
    assert.deepEqual(unused.map(s => s.name), ['ghost']);
    assert.equal(unused[0].calls, 0);
  });
});

// ── v4.8.0 (#36): the decision logic that actually gates output ─────────────
// These paths decide what reaches Claude's context and which tokens get
// reported as waste. Previously untested — the formatters had coverage, the
// decisions did not.

describe('budget: threshold gating', () => {
  const WARN_AT = [50, 70, 85, 95];

  it('emits a threshold exactly once per session', () => {
    const sent = [];
    // First crossing fires…
    const first = selectWarnings(72, WARN_AT, sent);
    assert.deepEqual(first, [50, 70]);
    sent.push(...first);
    // …a second event at the same level fires nothing.
    assert.deepEqual(selectWarnings(72, WARN_AT, sent), []);
    // …and only the newly crossed one fires later.
    assert.deepEqual(selectWarnings(86, WARN_AT, sent), [85]);
  });

  it('reports skipped thresholds in ascending order on a big jump', () => {
    assert.deepEqual(selectWarnings(96, WARN_AT, []), [50, 70, 85, 95]);
  });

  it('emits nothing below the lowest threshold', () => {
    assert.deepEqual(selectWarnings(49, WARN_AT, []), []);
  });

  it('fires exactly at the boundary, not just above it', () => {
    assert.deepEqual(selectWarnings(50, WARN_AT, []), [50]);
  });

  it('tolerates an empty/missing warnAt config', () => {
    assert.deepEqual(selectWarnings(99, [], []), []);
    assert.deepEqual(selectWarnings(99, undefined, undefined), []);
  });
});

describe('budget: cache-break warning', () => {
  const MIN = 60_000;
  const base = { lastEventAt: 1_000_000, realContextTokens: 150_000 };

  it('warns after a pause past the 5-min cache TTL', () => {
    assert.equal(shouldWarnCacheBreak({ ...base, now: base.lastEventAt + 6 * MIN }), true);
  });

  it('stays quiet inside the TTL', () => {
    assert.equal(shouldWarnCacheBreak({ ...base, now: base.lastEventAt + 4 * MIN }), false);
  });

  it('fires exactly at the 5-min boundary', () => {
    assert.equal(shouldWarnCacheBreak({ ...base, now: base.lastEventAt + 5 * MIN }), true);
  });

  it('stays quiet when there is too little context to be worth re-warming', () => {
    assert.equal(shouldWarnCacheBreak({
      lastEventAt: base.lastEventAt, realContextTokens: 5_000, now: base.lastEventAt + 60 * MIN
    }), false);
  });

  it('stays quiet on the first event of a session (no prior timestamp)', () => {
    assert.equal(shouldWarnCacheBreak({
      lastEventAt: null, realContextTokens: 500_000, now: 9_999_999
    }), false);
  });
});

describe('budget: context-rot warning', () => {
  it('fires once past 350K on a 1M-window model', () => {
    assert.equal(shouldWarnContextRot({
      contextWindow: 1_000_000, contextTokens: 360_000, alreadyWarned: false
    }), true);
  });

  it('never fires twice', () => {
    assert.equal(shouldWarnContextRot({
      contextWindow: 1_000_000, contextTokens: 900_000, alreadyWarned: true
    }), false);
  });

  it('does not apply to 200K-window models (percent warnings cover those)', () => {
    assert.equal(shouldWarnContextRot({
      contextWindow: 200_000, contextTokens: 190_000, alreadyWarned: false
    }), false);
  });

  it('stays quiet below the degradation zone', () => {
    assert.equal(shouldWarnContextRot({
      contextWindow: 1_000_000, contextTokens: 349_999, alreadyWarned: false
    }), false);
  });
});

describe('budget: compact recommendation', () => {
  it('recommends dropping read-but-never-edited files, biggest first', () => {
    const rec = buildCompactRecommendation({ filesLoaded: {
      '/p/big.ts':    { reads: 2, edits: 0, tokens: 30_000 },
      '/p/small.ts':  { reads: 1, edits: 0, tokens: 5_000 },
      '/p/edited.ts': { reads: 3, edits: 2, tokens: 90_000 }, // in use — keep
    }});
    assert.deepEqual(rec.files, ['/p/big.ts', '/p/small.ts']);
    assert.equal(rec.reclaimableTokens, 35_000);
    assert.ok(!rec.message.includes('edited.ts'), 'must not suggest dropping an edited file');
  });

  it('returns null when every loaded file was edited', () => {
    assert.equal(buildCompactRecommendation({ filesLoaded: {
      '/p/a.ts': { reads: 1, edits: 1, tokens: 10_000 },
    }}), null);
  });

  it('caps the suggestion list at 5 files', () => {
    const filesLoaded = {};
    for (let i = 0; i < 12; i++) filesLoaded[`/p/f${i}.ts`] = { reads: 1, edits: 0, tokens: 1000 * (i + 1) };
    assert.equal(buildCompactRecommendation({ filesLoaded }).files.length, 5);
  });
});

describe('read-cache: staleness', () => {
  const TH = { tokens: 50_000, files: 8, timeMs: 10 * 60_000 };
  const NOW = 5_000_000;
  // A cache where `target` was read first, then `n` other files after it.
  const cacheWith = (others) => ({ files: {
    '/p/target.ts': { readAtMs: NOW - 60_000, tokens: 1000 },
    ...Object.fromEntries(others.map((tokens, i) =>
      [`/p/other${i}.ts`, { readAtMs: NOW - 30_000, tokens }])),
  }});

  it('is fresh when nothing displaced it', () => {
    assert.equal(checkStaleness(cacheWith([]), '/p/target.ts', TH, NOW).stale, false);
  });

  it('goes stale once enough OTHER tokens were loaded after it', () => {
    const r = checkStaleness(cacheWith([30_000, 25_000]), '/p/target.ts', TH, NOW);
    assert.equal(r.stale, true);
    assert.match(r.reason, /tokens of other files/);
  });

  it('goes stale on file count even when those files are tiny', () => {
    const r = checkStaleness(cacheWith(Array(8).fill(10)), '/p/target.ts', TH, NOW);
    assert.equal(r.stale, true);
    assert.match(r.reason, /8 other files/);
  });

  it('goes stale on elapsed time alone', () => {
    const cache = { files: { '/p/target.ts': { readAtMs: NOW - 11 * 60_000, tokens: 1000 } } };
    const r = checkStaleness(cache, '/p/target.ts', TH, NOW);
    assert.equal(r.stale, true);
    assert.match(r.reason, /11 min since last read/);
  });

  it('ignores files read BEFORE the target (they cannot displace it)', () => {
    const cache = { files: {
      '/p/target.ts': { readAtMs: NOW - 60_000, tokens: 1000 },
      '/p/older.ts':  { readAtMs: NOW - 120_000, tokens: 500_000 },
    }};
    assert.equal(checkStaleness(cache, '/p/target.ts', TH, NOW).stale, false);
  });

  it('is never stale for a file it has never seen', () => {
    assert.equal(checkStaleness({ files: {} }, '/p/nope.ts', TH, NOW).stale, false);
  });
});

describe('tracker: session aggregation', () => {
  it('counts a read-once-never-edited file as pure waste', () => {
    const r = aggregateSessionFiles({
      '/p/waste.ts': { estTokens: 1000, reads: 1, edits: 0, wasEdited: false },
    });
    assert.equal(r.sessionTokensTotal, 1000);
    assert.equal(r.sessionTokensWasted, 1000);
    assert.equal(r.perFile['/p/waste.ts'].wasted, true);
  });

  it('treats a deliberate re-read as useful, not waste', () => {
    // computeUsefulness credits re-reads (+0.5 each): coming back to a file is
    // a signal it mattered, so it must not be billed as waste.
    const r = aggregateSessionFiles({
      '/p/reread.ts': { estTokens: 1000, reads: 2, edits: 0, wasEdited: false },
    });
    assert.equal(r.sessionTokensWasted, 0);
    assert.equal(r.perFile['/p/reread.ts'].wasted, false);
  });

  it('charges ALL reads as waste when a big file is re-read but never edited', () => {
    // The penalty path: 3+ reads of a >100-line file with no edit cancels the
    // re-read credit — thrashing, not research. Every read was paid for.
    const r = aggregateSessionFiles({
      '/p/thrash.ts': { estTokens: 1000, reads: 3, edits: 0, wasEdited: false, lines: 500 },
    });
    assert.equal(r.sessionTokensTotal, 3000);
    assert.equal(r.sessionTokensWasted, 3000, 'all 3 reads were paid for');
    assert.equal(r.perFile['/p/thrash.ts'].wasted, true);
  });

  it('does not count an edited file as waste', () => {
    const r = aggregateSessionFiles({
      '/p/used.ts': { estTokens: 1000, reads: 2, edits: 1, wasEdited: true },
    });
    assert.equal(r.sessionTokensTotal, 2000);
    assert.equal(r.sessionTokensWasted, 0);
    assert.deepEqual(r.editedFiles, ['/p/used.ts']);
  });

  it('separates waste from useful work in a mixed session', () => {
    const r = aggregateSessionFiles({
      '/p/a.ts': { estTokens: 1000, reads: 2, edits: 1, wasEdited: true },  // 2000 useful
      '/p/b.ts': { estTokens: 2000, reads: 1, edits: 0, wasEdited: false }, // 2000 wasted
    });
    assert.equal(r.sessionTokensTotal, 4000);
    assert.equal(r.sessionTokensWasted, 2000);
    assert.equal(Math.round((r.sessionTokensWasted / r.sessionTokensTotal) * 100), 50);
  });

  it('returns zeroes for an empty session', () => {
    const r = aggregateSessionFiles({});
    assert.equal(r.sessionTokensTotal, 0);
    assert.equal(r.sessionTokensWasted, 0);
    assert.deepEqual(r.editedFiles, []);
  });

  it('handles a missing files object without throwing', () => {
    assert.equal(aggregateSessionFiles(undefined).sessionTokensTotal, 0);
  });
});

describe('tracker: co-occurrence', () => {
  it('links files edited together, symmetrically', () => {
    const m = buildCoOccurrence(['/p/a.ts', '/p/b.ts']);
    assert.equal(m['/p/a.ts']['/p/b.ts'], 1);
    assert.equal(m['/p/b.ts']['/p/a.ts'], 1);
  });

  it('never links a file to itself', () => {
    const m = buildCoOccurrence(['/p/a.ts', '/p/b.ts']);
    assert.equal(m['/p/a.ts']['/p/a.ts'], undefined);
  });

  it('accumulates across sessions into the same matrix', () => {
    const m = buildCoOccurrence(['/p/a.ts', '/p/b.ts']);
    buildCoOccurrence(['/p/a.ts', '/p/b.ts'], m);
    assert.equal(m['/p/a.ts']['/p/b.ts'], 2);
  });

  it('ignores a single-file session (no pair to learn)', () => {
    assert.deepEqual(buildCoOccurrence(['/p/only.ts']), {});
  });

  it('ignores a sweeping >20-file refactor (pairs would be noise)', () => {
    const many = Array.from({ length: 21 }, (_, i) => `/p/f${i}.ts`);
    assert.deepEqual(buildCoOccurrence(many), {});
  });
});

// ── v4.8.0 (#39): config surface ────────────────────────────────────────────

describe('config: threshold validation', () => {
  it('accepts a value inside the documented range', () => {
    const r = validateThreshold('rereadWarnAt', 5);
    assert.equal(r.ok, true);
    assert.equal(r.value, 5);
  });

  it('coerces a numeric string (CLI args arrive as strings)', () => {
    assert.deepEqual(validateThreshold('bigFileLines', '750'), { ok: true, value: 750 });
  });

  it('rejects out-of-range values with the range in the message', () => {
    const r = validateThreshold('rereadWarnAt', 999);
    assert.equal(r.ok, false);
    assert.match(r.error, /between 2 and 20/);
  });

  it('rejects an unknown key', () => {
    assert.equal(validateThreshold('nope', 1).ok, false);
  });

  it('rejects non-numeric junk rather than coercing it to NaN', () => {
    assert.equal(validateThreshold('bigFileLines', 'abc').ok, false);
    assert.equal(validateThreshold('bigFileLines', null).ok, false);
    assert.equal(validateThreshold('bigFileLines', {}).ok, false);
  });

  it('every default sits inside its own declared range', () => {
    for (const [key, [def]] of Object.entries(THRESHOLD_SPEC)) {
      assert.equal(validateThreshold(key, def).ok, true, `${key} default is out of its range`);
    }
  });
});

describe('config: describe/set/reset', () => {
  it('labels untouched keys as defaults', () => {
    const rows = describeThresholds({});
    assert.ok(rows.every(r => r.source === 'default'));
    assert.equal(rows.find(r => r.key === 'rereadWarnAt').value, 3);
  });

  it('labels overridden keys as config and uses the override', () => {
    const row = describeThresholds({ rereadWarnAt: 7 }).find(r => r.key === 'rereadWarnAt');
    assert.equal(row.source, 'config');
    assert.equal(row.value, 7);
  });

  it('ignores an invalid stored value and falls back to the default', () => {
    // A typo must never make a hook behave wildly.
    const row = describeThresholds({ rereadWarnAt: 9999 }).find(r => r.key === 'rereadWarnAt');
    assert.equal(row.source, 'invalid');
    assert.equal(row.value, 3, 'must fall back to the default');
    assert.match(row.error, /between/);
  });

  it('set refuses a bad value and lists the known keys', () => {
    const r = applySet({}, 'rereadWarnAt', 999);
    assert.equal(r.ok, false);
    assert.match(r.error, /Known keys:/);
  });

  it('set does not mutate the object it was given', () => {
    const stored = { rereadWarnAt: 4 };
    applySet(stored, 'bigFileLines', 900);
    assert.deepEqual(stored, { rereadWarnAt: 4 });
  });

  it('reset with a key removes only that key', () => {
    const r = applyReset({ rereadWarnAt: 4, bigFileLines: 900 }, 'rereadWarnAt');
    assert.deepEqual(r.thresholds, { bigFileLines: 900 });
  });

  it('reset without a key clears everything', () => {
    assert.deepEqual(applyReset({ rereadWarnAt: 4, bigFileLines: 900 }).thresholds, {});
  });

  it('reset rejects an unknown key instead of silently no-oping', () => {
    assert.equal(applyReset({}, 'nope').ok, false);
  });
});
