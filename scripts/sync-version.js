#!/usr/bin/env node

/**
 * Sync version from package.json (single source of truth) into:
 *   - .claude-plugin/plugin.json      (version + description)
 *   - .claude-plugin/marketplace.json (plugins[].version + description)
 *   - docs/index.html                 (footer "vX.Y.Z" badge)
 * Run before publish: npm run sync-version
 *
 * Also CHECKS (can't write — different repo) the external marketplace
 * egorfedorov/claude-plugins, which pins its own copy of the version and sat
 * two releases stale once. Warns on mismatch; best-effort on network failure.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
let changed = 0;

// plugin.json
const pluginPath = join(ROOT, '.claude-plugin', 'plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
if (plugin.version !== pkg.version || plugin.description !== pkg.description) {
  const before = plugin.version;
  plugin.version = pkg.version;
  plugin.description = pkg.description;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
  console.log(`✓ plugin.json: ${before} → ${pkg.version}`);
  changed++;
}

// marketplace.json
const marketPath = join(ROOT, '.claude-plugin', 'marketplace.json');
const market = JSON.parse(readFileSync(marketPath, 'utf-8'));
for (const p of market.plugins || []) {
  if (p.name !== pkg.name) continue;
  if (p.version !== pkg.version || p.description !== pkg.description) {
    const before = p.version;
    p.version = pkg.version;
    p.description = pkg.description;
    writeFileSync(marketPath, JSON.stringify(market, null, 2) + '\n');
    console.log(`✓ marketplace.json: ${before} → ${pkg.version}`);
    changed++;
  }
}

// docs/index.html footer badge
const docsPath = join(ROOT, 'docs', 'index.html');
const html = readFileSync(docsPath, 'utf-8');
const synced = html.replace(/v\d+\.\d+\.\d+(?=\s*&middot;)/g, `v${pkg.version}`);
if (synced !== html) {
  writeFileSync(docsPath, synced);
  console.log(`✓ docs/index.html → v${pkg.version}`);
  changed++;
}

if (!changed) console.log(`✓ versions already in sync: ${pkg.version}`);

// External marketplace repo — read-only check, never fails the run.
const EXT = 'egorfedorov/claude-plugins';
try {
  const res = await fetch(
    `https://raw.githubusercontent.com/${EXT}/main/.claude-plugin/marketplace.json`,
    { signal: AbortSignal.timeout(4000) }
  );
  const ext = (await res.json()).plugins?.find(p => p.name === pkg.name);
  if (ext && ext.version !== pkg.version) {
    console.log(`⚠ ${EXT} still lists v${ext.version} — bump its .claude-plugin/marketplace.json to v${pkg.version}`);
  } else if (ext) {
    console.log(`✓ ${EXT} marketplace in sync: v${ext.version}`);
  }
} catch {
  console.log(`? could not check ${EXT} (offline?) — verify its marketplace.json manually`);
}
