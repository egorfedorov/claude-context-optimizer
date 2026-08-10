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
// Read through the API, NOT raw.githubusercontent: the raw CDN kept serving a
// stale `x-cache: HIT` to fetch() long after the bump landed — through
// cache-busting query strings and no-cache headers alike — so the check
// reported a bump it had just been told to make. The API reflects the commit
// immediately. Falls back to raw (with the caveat) if the API is unreachable.
async function fetchExtVersion() {
  const opts = { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'cco-sync-version' } };
  try {
    const res = await fetch(`https://api.github.com/repos/${EXT}/contents/.claude-plugin/marketplace.json`,
      { ...opts, headers: { ...opts.headers, Accept: 'application/vnd.github.raw' } });
    if (!res.ok) throw new Error(`api ${res.status}`);
    return { data: JSON.parse(await res.text()), stale: false };
  } catch {
    const res = await fetch(`https://raw.githubusercontent.com/${EXT}/main/.claude-plugin/marketplace.json`, opts);
    return { data: await res.json(), stale: true };
  }
}

try {
  const { data, stale } = await fetchExtVersion();
  const ext = data.plugins?.find(p => p.name === pkg.name);
  if (ext && ext.version !== pkg.version) {
    console.log(`⚠ ${EXT} still lists v${ext.version} — bump its .claude-plugin/marketplace.json to v${pkg.version}`);
    if (stale) console.log('  (read via the CDN, which can serve a stale copy — confirm with `gh api` before believing it)');
  } else if (ext) {
    console.log(`✓ ${EXT} marketplace in sync: v${ext.version}`);
  }
} catch {
  console.log(`? could not check ${EXT} (offline?) — verify its marketplace.json manually`);
}
