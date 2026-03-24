import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { extname, basename } from 'path';
import { homedir } from 'os';

import {
  estimateTokens, formatTokens, displayPath,
  computeUsefulness, computeConfidence, TOKEN_RATIOS
} from '../src/utils.js';

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
