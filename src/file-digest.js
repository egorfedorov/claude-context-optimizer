/**
 * File Digest v1.0
 *
 * Parses source files and extracts structural landmarks — function names,
 * class declarations, component sections, imports — with their line numbers.
 *
 * Used by read-cache v2.0 to return a navigational "file map" when blocking
 * redundant reads, giving the AI enough context to use offset/limit effectively.
 *
 * Cost: ~50-150 tokens for the digest vs ~5K-20K tokens for re-reading the file.
 */

import { readFileSync } from 'fs';
import { extname } from 'path';

/**
 * Parse a file and extract structural landmarks.
 * Returns array of { line: number, label: string }.
 */
export function parseFileStructure(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const ext = extname(filePath).toLowerCase();
  const landmarks = [];

  let importFirst = -1;
  let importLast = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const ln = i + 1;

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') && ext !== '.py') continue;

    // ── Imports (collapse to a single range) ──────────────────────────
    if (/^import[\s{(]/.test(trimmed) || /^from\s+\S+\s+import/.test(trimmed)) {
      if (importFirst === -1) importFirst = ln;
      importLast = ln;
      continue;
    }

    let m;

    // ── JS/TS ─────────────────────────────────────────────────────────
    if ((m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `function ${m[1]}()` });
      continue;
    }
    if ((m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?[\s(]/))) {
      // Only include if it looks like a function (arrow or function expression)
      const rest = trimmed.slice(m[0].length);
      if (/^\(|^[^=]*=>/.test(rest) || /function/.test(rest)) {
        landmarks.push({ line: ln, label: `const ${m[1]} = (...)` });
        continue;
      }
      // Large object/array assignments still worth noting
      if (trimmed.endsWith('{') || trimmed.endsWith('[')) {
        landmarks.push({ line: ln, label: `const ${m[1]}` });
        continue;
      }
    }
    if ((m = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `class ${m[1]}` });
      continue;
    }
    // Go type struct/interface (more specific — must check before generic TS type)
    if ((m = trimmed.match(/^type\s+(\w+)\s+(struct|interface)/))) {
      landmarks.push({ line: ln, label: `type ${m[1]} ${m[2]}` });
      continue;
    }
    if ((m = trimmed.match(/^(?:export\s+)?(?:interface|type)\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `type ${m[1]}` });
      continue;
    }
    if (/^export\s+default\s/.test(trimmed)) {
      landmarks.push({ line: ln, label: 'export default' });
      continue;
    }
    if (/^module\.exports/.test(trimmed)) {
      landmarks.push({ line: ln, label: 'module.exports' });
      continue;
    }

    // ── Svelte/Vue sections ───────────────────────────────────────────
    if (/^<script/.test(trimmed)) {
      landmarks.push({ line: ln, label: '<script>' });
      continue;
    }
    if (/^<\/script>/.test(trimmed)) {
      landmarks.push({ line: ln, label: '</script>' });
      continue;
    }
    if (/^<style/.test(trimmed)) {
      landmarks.push({ line: ln, label: '<style>' });
      continue;
    }
    if (/^<template/.test(trimmed)) {
      landmarks.push({ line: ln, label: '<template>' });
      continue;
    }
    // Svelte markup — detect the start of template after </script>
    if (ext === '.svelte' && /^[{<]/.test(trimmed) && !trimmed.startsWith('<script') && !trimmed.startsWith('<style')) {
      // Only mark the first markup element
      if (!landmarks.some(l => l.label === 'markup')) {
        landmarks.push({ line: ln, label: 'markup' });
      }
    }

    // ── Python ────────────────────────────────────────────────────────
    if ((m = trimmed.match(/^(?:async\s+)?def\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `def ${m[1]}()` });
      continue;
    }
    if (ext === '.py' && (m = trimmed.match(/^class\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `class ${m[1]}` });
      continue;
    }

    // ── Go ────────────────────────────────────────────────────────────
    if ((m = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/))) {
      landmarks.push({ line: ln, label: `func ${m[1]}()` });
      continue;
    }

    // ── Rust ──────────────────────────────────────────────────────────
    if ((m = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `fn ${m[1]}()` });
      continue;
    }
    if ((m = trimmed.match(/^(?:pub\s+)?struct\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `struct ${m[1]}` });
      continue;
    }
    if ((m = trimmed.match(/^(?:pub\s+)?enum\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `enum ${m[1]}` });
      continue;
    }
    if ((m = trimmed.match(/^(?:pub\s+)?trait\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `trait ${m[1]}` });
      continue;
    }
    if ((m = trimmed.match(/^impl(?:<[^>]+>)?\s+(\w+)/))) {
      landmarks.push({ line: ln, label: `impl ${m[1]}` });
      continue;
    }

    // ── C/C++ ─────────────────────────────────────────────────────────
    if ((m = trimmed.match(/^(?:class|struct)\s+(\w+)/)) && (ext === '.cpp' || ext === '.c' || ext === '.h' || ext === '.hpp')) {
      landmarks.push({ line: ln, label: m[0] });
      continue;
    }

    // ── JSON top-level keys ───────────────────────────────────────────
    if (ext === '.json' && (m = trimmed.match(/^"(\w[\w-]*)"\s*:/))) {
      if (raw.search(/\S/) <= 2) {
        landmarks.push({ line: ln, label: `"${m[1]}"` });
      }
      continue;
    }

    // ── YAML top-level keys ───────────────────────────────────────────
    if ((ext === '.yaml' || ext === '.yml') && (m = trimmed.match(/^(\w[\w-]*)\s*:/))) {
      if (raw.search(/\S/) === 0) {
        landmarks.push({ line: ln, label: `${m[1]}:` });
      }
      continue;
    }
  }

  // Prepend collapsed import block
  if (importFirst > 0) {
    const label = importFirst === importLast
      ? `import (line ${importFirst})`
      : `imports (${importFirst}–${importLast})`;
    landmarks.unshift({ line: importFirst, label });
  }

  return landmarks;
}

/**
 * Format landmarks into a compact navigational digest.
 * Caps at ~20 entries to keep token cost under ~150 tokens.
 */
export function formatDigest(landmarks, totalLines) {
  if (landmarks.length === 0) {
    return `📋 No structural landmarks detected (${totalLines} lines).`;
  }

  let selected = landmarks;
  if (selected.length > 20) {
    // Sample evenly to stay within token budget
    const step = Math.ceil(selected.length / 20);
    selected = selected.filter((_, i) => i % step === 0);
  }

  const rows = selected.map(lm => `  ${String(lm.line).padStart(4)}: ${lm.label}`);
  return `📋 File map (${totalLines} lines):\n${rows.join('\n')}`;
}
