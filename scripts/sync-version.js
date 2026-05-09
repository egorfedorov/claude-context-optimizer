#!/usr/bin/env node

/**
 * Sync version between package.json and .claude-plugin/plugin.json.
 * Run before publish: npm run sync-version
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const pluginPath = join(ROOT, '.claude-plugin', 'plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));

if (plugin.version === pkg.version && plugin.description === pkg.description) {
  console.log(`✓ versions already in sync: ${pkg.version}`);
  process.exit(0);
}

const before = plugin.version;
plugin.version = pkg.version;
plugin.description = pkg.description;
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');

console.log(`✓ plugin.json updated: ${before} → ${pkg.version}`);
