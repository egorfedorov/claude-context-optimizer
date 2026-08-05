#!/usr/bin/env node

/**
 * Sync version from package.json (single source of truth) into:
 *   - .claude-plugin/plugin.json      (version + description)
 *   - .claude-plugin/marketplace.json (plugins[].version + description)
 *   - docs/index.html                 (footer "vX.Y.Z" badge)
 * Run before publish: npm run sync-version
 *
 * With --check: writes nothing and exits 1 on any drift. CI runs this, because
 * marketplace.json silently sat at 4.3.0 through the 4.5.0 and 4.6.0 releases —
 * a stale version is invisible locally but ships to every marketplace user.
 *
 * Also CHECKS (can't write — different repo) the external marketplace
 * egorfedorov/claude-plugins, which pins its own copy of the version and sat
 * two releases stale once. Warns on mismatch; never fails the run, since it is
 * served through a CDN that caches for minutes after a push.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CHECK = process.argv.includes('--check');
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
let changed = 0;
const drift = [];

/** Apply a fix, or record it as drift when running under --check. */
function reconcile(label, before, write) {
  if (CHECK) {
    drift.push(`✗ ${label}: ${before} ≠ ${pkg.version}`);
    return;
  }
  write();
  console.log(`✓ ${label}: ${before} → ${pkg.version}`);
  changed++;
}

// plugin.json
const pluginPath = join(ROOT, '.claude-plugin', 'plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
if (plugin.version !== pkg.version || plugin.description !== pkg.description) {
  reconcile('plugin.json', plugin.version, () => {
    plugin.version = pkg.version;
    plugin.description = pkg.description;
    writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
  });
}

// marketplace.json
const marketPath = join(ROOT, '.claude-plugin', 'marketplace.json');
const market = JSON.parse(readFileSync(marketPath, 'utf-8'));
for (const p of market.plugins || []) {
  if (p.name !== pkg.name) continue;
  if (p.version !== pkg.version || p.description !== pkg.description) {
    reconcile('marketplace.json', p.version, () => {
      p.version = pkg.version;
      p.description = pkg.description;
      writeFileSync(marketPath, JSON.stringify(market, null, 2) + '\n');
    });
  }
}

// docs/index.html footer badge
const docsPath = join(ROOT, 'docs', 'index.html');
const html = readFileSync(docsPath, 'utf-8');
const synced = html.replace(/v\d+\.\d+\.\d+(?=\s*&middot;)/g, `v${pkg.version}`);
if (synced !== html) {
  const before = (html.match(/v\d+\.\d+\.\d+(?=\s*&middot;)/) || ['?'])[0];
  reconcile('docs/index.html', before, () => writeFileSync(docsPath, synced));
}

if (CHECK && drift.length) {
  console.error(`Version drift against package.json v${pkg.version}:\n  ${drift.join('\n  ')}`);
  console.error('\nRun `npm run sync-version` and commit the result.');
  process.exit(1);
}
if (!changed && !drift.length) console.log(`✓ versions already in sync: ${pkg.version}`);

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
    console.log(`  (raw.githubusercontent is CDN-cached for a few minutes — verify with \`gh api\` before believing this)`);
  } else if (ext) {
    console.log(`✓ ${EXT} marketplace in sync: v${ext.version}`);
  }
} catch {
  console.log(`? could not check ${EXT} (offline?) — verify its marketplace.json manually`);
}
