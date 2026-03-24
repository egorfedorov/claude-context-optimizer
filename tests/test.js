import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { extname, basename, join } from 'path';
import { homedir } from 'os';

import {
  estimateTokens, formatTokens, displayPath,
  computeUsefulness, computeConfidence, TOKEN_RATIOS,
  loadBudgetConfig, saveBudgetConfig, clearBudgetConfigCache,
  BUDGET_CONFIG_FILE, loadJSON
} from '../src/utils.js';
import {
  isContextIgnored, _globToRegex, _parseIgnoreFile, clearContextIgnoreCache
} from '../src/contextignore.js';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';

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

// ── Recreated pure functions from anatomy.js ────────────────────────────────

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
  '.cpp', '.c', '.h', '.hpp', '.rb', '.java', '.swift', '.kt',
]);
const CONFIG_EXTS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini']);
const STYLE_EXTS = new Set(['.css', '.scss', '.less']);
const DOC_EXTS = new Set(['.md', '.txt', '.rst']);
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.lock', '.map', '.min.js', '.min.css',
  '.zip', '.tar', '.gz', '.br', '.zst',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
]);
const SKIP_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock',
]);

function categorize(filePath) {
  const ext = extname(filePath);
  const name = basename(filePath);
  const lower = filePath.toLowerCase();
  if (/\.(test|spec)\./.test(name) || /\/__tests__\//.test(lower) || /\/tests?\//.test(lower)) return 'test';
  if (DOC_EXTS.has(ext) || /\/docs?\//.test(lower)) return 'docs';
  if (SOURCE_EXTS.has(ext)) return 'source';
  if (STYLE_EXTS.has(ext) || /\.styled\./.test(name)) return 'style';
  if (CONFIG_EXTS.has(ext) || /\.config\./.test(name) || /\.env/.test(name) ||
      name.startsWith('tsconfig') || name === 'Makefile' || name === 'CMakeLists.txt' ||
      name === 'Dockerfile' || name === '.eslintrc' || name === '.prettierrc') return 'config';
  return 'other';
}

function shouldSkip(filePath) {
  const ext = extname(filePath);
  const name = basename(filePath);
  if (SKIP_EXTS.has(ext)) return true;
  if (SKIP_NAMES.has(name)) return true;
  if (name.endsWith('.min.js') || name.endsWith('.min.css')) return true;
  return false;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('utils', () => {
  describe('estimateTokens', () => {
    it('uses extension-specific ratio for .js', () => {
      // 100 lines * 35 chars / 3.8 ratio = 921
      assert.equal(estimateTokens(100, '.js'), Math.round((100 * 35) / 3.8));
    });

    it('uses extension-specific ratio for .md', () => {
      assert.equal(estimateTokens(100, '.md'), Math.round((100 * 35) / 4.2));
    });

    it('uses extension-specific ratio for .json', () => {
      assert.equal(estimateTokens(100, '.json'), Math.round((100 * 35) / 3.2));
    });

    it('falls back to 3.7 for unknown extensions', () => {
      assert.equal(estimateTokens(100, '.xyz'), Math.round((100 * 35) / 3.7));
    });

    it('returns 0 for 0 lines', () => {
      assert.equal(estimateTokens(0, '.js'), 0);
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
