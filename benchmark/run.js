#!/usr/bin/env node

/**
 * CCO Benchmark Suite v1.0
 *
 * Reproducible scenarios that measure token savings from each CCO feature.
 * Inspired by tamp.dev's A/B testing methodology.
 *
 * Usage: node benchmark/run.js
 */

import { estimateTokens, TOKEN_RATIOS } from '../src/utils.js';
import { parseFileStructure, formatDigest } from '../src/file-digest.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ensureFixtures() {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  // 1. Large JS file (simulates reading a 500-line module)
  if (!existsSync(join(FIXTURES_DIR, 'large-module.js'))) {
    const lines = [];
    lines.push('import { something } from "./dep.js";');
    lines.push('');
    lines.push('export class DataProcessor {');
    lines.push('  constructor(config) {');
    lines.push('    this.config = config;');
    lines.push('    this.cache = new Map();');
    lines.push('  }');
    lines.push('');
    for (let i = 0; i < 30; i++) {
      lines.push(`  async process${i}(data) {`);
      for (let j = 0; j < 12; j++) {
        lines.push(`    const result${j} = await this.transform(data, ${j});`);
      }
      lines.push('    return data;');
      lines.push('  }');
      lines.push('');
    }
    lines.push('}');
    lines.push('');
    lines.push('export function helperFunction(x) {');
    lines.push('  return x * 2;');
    lines.push('}');
    writeFileSync(join(FIXTURES_DIR, 'large-module.js'), lines.join('\n'));
  }

  // 2. Large JSON config
  if (!existsSync(join(FIXTURES_DIR, 'config.json'))) {
    const config = {};
    for (let i = 0; i < 50; i++) {
      config[`section_${i}`] = {
        enabled: i % 2 === 0,
        timeout: 1000 + i * 100,
        retries: 3,
        endpoint: `https://api.example.com/v${i}`,
        options: { debug: false, verbose: true, maxConnections: 10 }
      };
    }
    writeFileSync(join(FIXTURES_DIR, 'config.json'), JSON.stringify(config, null, 2));
  }

  // 3. README.md
  if (!existsSync(join(FIXTURES_DIR, 'README.md'))) {
    const lines = ['# Project Title\n'];
    lines.push('## Installation\n');
    lines.push('```bash\nnpm install example\n```\n');
    lines.push('## Usage\n');
    for (let i = 0; i < 40; i++) {
      lines.push(`### Feature ${i}\n`);
      lines.push(`This feature does something useful. It integrates with the core module and provides functionality for case ${i}.\n`);
      lines.push(`\`\`\`js\nconst result = feature${i}();\nconsole.log(result);\n\`\`\`\n`);
    }
    lines.push('## License\n\nMIT\n');
    writeFileSync(join(FIXTURES_DIR, 'README.md'), lines.join('\n'));
  }

  // 4. package-lock.json (lockfile)
  if (!existsSync(join(FIXTURES_DIR, 'package-lock.json'))) {
    const lock = { name: 'example', version: '1.0.0', lockfileVersion: 3, packages: {} };
    for (let i = 0; i < 100; i++) {
      lock.packages[`node_modules/dep-${i}`] = {
        version: `${i}.0.0`,
        resolved: `https://registry.npmjs.org/dep-${i}/-/dep-${i}-${i}.0.0.tgz`,
        integrity: `sha512-${'a'.repeat(44)}=`,
        dependencies: { [`sub-dep-${i}`]: `^${i}.0.0` }
      };
    }
    writeFileSync(join(FIXTURES_DIR, 'package-lock.json'), JSON.stringify(lock, null, 2));
  }
}

// ── Benchmark scenarios ───────────────────────────────────────────────────────

function scenario_readCacheDedup(fixture, lineCount, ext) {
  const fullReadTokens = estimateTokens(lineCount, ext);
  // Second read: blocked by read-cache, returns digest instead
  const content = readFileSync(fixture, 'utf-8');
  const structure = parseFileStructure(content, fixture);
  const digest = formatDigest(structure, fixture);
  const digestTokens = Math.round(digest.length / 3.7);

  return {
    name: 'Read Cache Dedup',
    description: 'Second read of same file → file digest instead of full content',
    withoutCCO: fullReadTokens * 2,   // two full reads
    withCCO: fullReadTokens + digestTokens,  // first read + digest
    unit: 'tokens'
  };
}

function scenario_readCacheMultiple(fixture, lineCount, ext, reads) {
  const fullReadTokens = estimateTokens(lineCount, ext);
  const content = readFileSync(fixture, 'utf-8');
  const structure = parseFileStructure(content, fixture);
  const digest = formatDigest(structure, fixture);
  const digestTokens = Math.round(digest.length / 3.7);

  return {
    name: `Read Cache (${reads}x reads)`,
    description: `File read ${reads} times in a session`,
    withoutCCO: fullReadTokens * reads,
    withCCO: fullReadTokens + digestTokens * (reads - 1),
    unit: 'tokens'
  };
}

function scenario_contextignoreBlock(fixture, lineCount, ext) {
  const fullReadTokens = estimateTokens(lineCount, ext);
  return {
    name: 'Contextignore Block',
    description: 'Lockfile/generated file blocked entirely by .contextignore',
    withoutCCO: fullReadTokens,
    withCCO: 0,
    unit: 'tokens'
  };
}

function scenario_fileDigestVsFull(fixture, ext) {
  const content = readFileSync(fixture, 'utf-8');
  const lineCount = content.split('\n').length;
  const fullTokens = estimateTokens(lineCount, ext);
  const structure = parseFileStructure(content, fixture);
  const digest = formatDigest(structure, fixture);
  const digestTokens = Math.round(digest.length / 3.7);

  return {
    name: 'File Digest vs Full Read',
    description: 'Navigational digest (~landmarks) vs full file content',
    withoutCCO: fullTokens,
    withCCO: digestTokens,
    unit: 'tokens'
  };
}

function scenario_typicalSession() {
  // Simulate a realistic 45-min coding session
  const files = [
    { name: 'main.js', lines: 300, ext: '.js', reads: 3, edits: 2 },
    { name: 'utils.js', lines: 200, ext: '.js', reads: 2, edits: 1 },
    { name: 'config.json', lines: 150, ext: '.json', reads: 2, edits: 0 },
    { name: 'README.md', lines: 250, ext: '.md', reads: 1, edits: 0 },
    { name: 'test.js', lines: 400, ext: '.js', reads: 2, edits: 1 },
    { name: 'package.json', lines: 30, ext: '.json', reads: 1, edits: 0 },
    { name: 'types.ts', lines: 180, ext: '.ts', reads: 1, edits: 0 },
    { name: 'api.js', lines: 350, ext: '.js', reads: 2, edits: 1 },
    { name: 'styles.css', lines: 100, ext: '.css', reads: 1, edits: 0 },
    { name: 'helpers.js', lines: 120, ext: '.js', reads: 1, edits: 0 },
  ];

  let withoutCCO = 0;
  let withCCO = 0;

  for (const f of files) {
    const tokensPerRead = estimateTokens(f.lines, f.ext);
    const digestTokens = Math.round(tokensPerRead * 0.05); // ~5% of full read

    // Without CCO: every read is a full read
    withoutCCO += tokensPerRead * f.reads;

    // With CCO: first read is full, subsequent reads are digests
    // Files that are never edited and read once = could be blocked by contextignore
    withCCO += tokensPerRead; // first read always
    if (f.reads > 1) {
      withCCO += digestTokens * (f.reads - 1); // subsequent = digest
    }
  }

  return {
    name: 'Typical Session (10 files, 45 min)',
    description: 'Realistic coding session with mixed reads/edits across 10 files',
    withoutCCO,
    withCCO,
    unit: 'tokens'
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

function runBenchmarks() {
  ensureFixtures();

  const jsFile = join(FIXTURES_DIR, 'large-module.js');
  const jsonFile = join(FIXTURES_DIR, 'config.json');
  const mdFile = join(FIXTURES_DIR, 'README.md');
  const lockFile = join(FIXTURES_DIR, 'package-lock.json');

  const jsLines = readFileSync(jsFile, 'utf-8').split('\n').length;
  const jsonLines = readFileSync(jsonFile, 'utf-8').split('\n').length;
  const mdLines = readFileSync(mdFile, 'utf-8').split('\n').length;
  const lockLines = readFileSync(lockFile, 'utf-8').split('\n').length;

  const scenarios = [
    scenario_readCacheDedup(jsFile, jsLines, '.js'),
    scenario_readCacheMultiple(jsFile, jsLines, '.js', 5),
    scenario_fileDigestVsFull(jsFile, '.js'),
    scenario_readCacheDedup(jsonFile, jsonLines, '.json'),
    scenario_contextignoreBlock(lockFile, lockLines, '.json'),
    scenario_fileDigestVsFull(mdFile, '.md'),
    scenario_typicalSession(),
  ];

  // Output
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════════════╗');
  console.log('  ║             CCO Benchmark Suite — Token Savings Proof            ║');
  console.log('  ╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Scenario                            Without CCO   With CCO   Savings');
  console.log('  ──────────────────────────────────   ───────────   ────────   ───────');

  let totalWithout = 0;
  let totalWith = 0;

  for (const s of scenarios) {
    const savings = s.withoutCCO - s.withCCO;
    const pct = s.withoutCCO > 0 ? Math.round((savings / s.withoutCCO) * 100) : 0;
    totalWithout += s.withoutCCO;
    totalWith += s.withCCO;

    const name = s.name.padEnd(36);
    const without = String(s.withoutCCO).padStart(11);
    const withC = String(s.withCCO).padStart(8);
    const savStr = `${pct}%`.padStart(5);
    console.log(`  ${name}   ${without}   ${withC}   ${savStr}`);
  }

  const totalSavings = totalWithout - totalWith;
  const totalPct = totalWithout > 0 ? Math.round((totalSavings / totalWithout) * 100) : 0;

  console.log('  ──────────────────────────────────   ───────────   ────────   ───────');
  console.log(`  ${'TOTAL'.padEnd(36)}   ${String(totalWithout).padStart(11)}   ${String(totalWith).padStart(8)}   ${(totalPct + '%').padStart(5)}`);
  console.log('');
  console.log(`  Overall: ${totalPct}% fewer tokens with CCO enabled`);
  console.log(`  That's ${totalSavings.toLocaleString()} tokens saved across all scenarios`);
  console.log('');

  // JSON output for CI/landing page
  const results = {
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    totalSavingsPercent: totalPct,
    totalTokensWithout: totalWithout,
    totalTokensWith: totalWith,
    scenarios: scenarios.map(s => ({
      name: s.name,
      description: s.description,
      withoutCCO: s.withoutCCO,
      withCCO: s.withCCO,
      savingsPercent: s.withoutCCO > 0 ? Math.round(((s.withoutCCO - s.withCCO) / s.withoutCCO) * 100) : 0
    }))
  };

  const resultsFile = join(__dirname, 'results.json');
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`  Results saved to benchmark/results.json`);
  console.log('');
}

runBenchmarks();
