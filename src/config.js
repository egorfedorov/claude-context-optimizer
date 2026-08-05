#!/usr/bin/env node

/**
 * Config surface — /cco-config
 *
 * CCO's aggressiveness used to live as magic numbers across four modules:
 * when a re-read is worth complaining about, when a cached file counts as
 * evicted, what the prompt coach calls too short, how much budget /cco-pack
 * may spend. Different context sizes and workflows want different answers,
 * and tuning should never mean editing source.
 *
 * Usage:
 *   node src/config.js                    # show all values + source
 *   node src/config.js get <key>
 *   node src/config.js set <key> <value>
 *   node src/config.js reset [key]        # one key, or all when omitted
 */

import {
  THRESHOLD_SPEC, DEFAULT_THRESHOLDS, validateThreshold, getThresholds,
  clearThresholdCache, loadConfig, saveConfig, CONFIG_FILE,
  isMainModule, getDonationMessage,
} from './utils.js';

// ── Pure core (exported for tests) ──────────────────────────────────────────

/**
 * Merge stored overrides onto defaults and label where each value came from.
 * Invalid stored values are reported as such rather than silently applied —
 * a typo must never make a hook behave wildly.
 */
export function describeThresholds(stored = {}) {
  return Object.entries(THRESHOLD_SPEC).map(([key, [def, min, max, description]]) => {
    const raw = stored[key];
    if (raw === undefined) return { key, value: def, def, min, max, description, source: 'default' };
    const r = validateThreshold(key, raw);
    return r.ok
      ? { key, value: r.value, def, min, max, description, source: 'config' }
      : { key, value: def, def, min, max, description, source: 'invalid', error: r.error };
  });
}

/** Apply one set operation. Returns { ok, thresholds, error }. */
export function applySet(stored, key, rawValue) {
  const r = validateThreshold(key, rawValue);
  if (!r.ok) {
    const known = Object.keys(THRESHOLD_SPEC).join(', ');
    return { ok: false, error: `${r.error}\nKnown keys: ${known}` };
  }
  return { ok: true, thresholds: { ...stored, [key]: r.value } };
}

/** Remove one key, or all of them when key is omitted. */
export function applyReset(stored, key) {
  if (!key) return { ok: true, thresholds: {} };
  if (!THRESHOLD_SPEC[key]) return { ok: false, error: `unknown key "${key}"` };
  const next = { ...stored };
  delete next[key];
  return { ok: true, thresholds: next };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function readStored() {
  return loadConfig().thresholds || {};
}

function writeStored(thresholds) {
  const cfg = loadConfig();
  cfg.thresholds = thresholds;
  saveConfig(cfg);
  clearThresholdCache();
}

function show() {
  const rows = describeThresholds(readStored());
  const width = Math.max(...rows.map(r => r.key.length));

  console.log('\n  CCO CONFIG — tunable thresholds');
  console.log('  ' + '─'.repeat(72));
  for (const r of rows) {
    const mark = r.source === 'config' ? '*' : r.source === 'invalid' ? '!' : ' ';
    const val = String(r.value).padEnd(9);
    console.log(`  ${mark} ${r.key.padEnd(width)}  ${val}  ${r.description}`);
    if (r.source === 'config') console.log(`  ${' '.repeat(width + 4)}(default ${r.def})`);
    if (r.source === 'invalid') console.log(`  ${' '.repeat(width + 4)}IGNORED: ${r.error} — using ${r.def}`);
  }
  console.log('  ' + '─'.repeat(72));
  console.log('  * = set by you   ! = invalid, ignored');
  console.log(`  ${CONFIG_FILE}`);
  console.log('\n  node src/config.js set <key> <value>   node src/config.js reset [key]\n');
  const donation = getDonationMessage();
  if (donation) console.log(donation);
}

function main() {
  const [cmd, key, value] = process.argv.slice(2);

  if (!cmd || cmd === 'show' || cmd === 'list') return show();

  if (cmd === 'get') {
    if (!key) { console.error('Usage: config.js get <key>'); process.exitCode = 1; return; }
    const row = describeThresholds(readStored()).find(r => r.key === key);
    if (!row) {
      console.error(`Unknown key "${key}". Known: ${Object.keys(THRESHOLD_SPEC).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${row.key} = ${row.value}  (source: ${row.source}, default ${row.def}, range ${row.min}–${row.max})`);
    return;
  }

  if (cmd === 'set') {
    const before = getThresholds()[key];   // read BEFORE the write invalidates it
    const r = applySet(readStored(), key, value);
    if (!r.ok) { console.error(r.error); process.exitCode = 1; return; }
    writeStored(r.thresholds);
    const after = r.thresholds[key];
    console.log(after === before
      ? `✓ ${key} = ${after} (unchanged)`
      : `✓ ${key} = ${after}  (was ${before})`);
    return;
  }

  if (cmd === 'reset') {
    const r = applyReset(readStored(), key);
    if (!r.ok) { console.error(r.error); process.exitCode = 1; return; }
    writeStored(r.thresholds);
    console.log(key ? `✓ ${key} reset to ${DEFAULT_THRESHOLDS[key]}` : '✓ all thresholds reset to defaults');
    return;
  }

  console.error(`Unknown command "${cmd}". Use: show | get <key> | set <key> <value> | reset [key]`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main();
