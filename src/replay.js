#!/usr/bin/env node

/**
 * Session Replay — Recent Session Summaries
 *
 * Shows summaries of recent sessions so the next session can
 * start with context about what was done previously.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SUMMARIES_DIR, getDonationMessage } from './utils.js';

function showReplay(count) {
  if (!existsSync(SUMMARIES_DIR)) {
    console.log('No session summaries yet.');
    return;
  }

  const files = readdirSync(SUMMARIES_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => {
      const fullPath = join(SUMMARIES_DIR, f);
      return { name: f, path: fullPath, mtime: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count);

  if (files.length === 0) {
    console.log('No session summaries yet.');
    return;
  }

  let output = '\n';
  output += `  \u2554${'═'.repeat(62)}\u2557\n`;
  output += '  \u2551                   RECENT SESSION SUMMARIES                  \u2551\n';
  output += `  \u255A${'═'.repeat(62)}\u255D\n`;

  for (let i = 0; i < files.length; i++) {
    const content = readFileSync(files[i].path, 'utf-8').trim();
    const lines = content.split('\n');

    output += '\n';
    output += `  [${i + 1}] ${lines[0]}\n`;
    for (let j = 1; j < lines.length; j++) {
      output += `      ${lines[j]}\n`;
    }
  }

  output += '\n  ─────────────────────────────────────────────────────────────\n';
  output += '  Tip: Start your session by reviewing these to avoid re-reading files!\n';

  output += getDonationMessage();

  console.log(output);
}

// ── CLI entry point ─────────────────────────────────────────────────────────

const count = parseInt(process.argv[2], 10) || 5;
showReplay(count);
