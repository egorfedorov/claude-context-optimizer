#!/usr/bin/env node

/**
 * Prompt Coach v1.0
 *
 * UserPromptSubmit hook + CLI that analyzes the user's prompt for clarity,
 * specificity, and scope — then either:
 *   • silently injects context hints into Claude's environment, or
 *   • prints suggestions back to the user via stderr so they can refine.
 *
 * Heuristics (model-free):
 *   1. Specificity — does the prompt name files, line numbers, identifiers?
 *   2. Scope       — bounded ("fix bug in src/auth.js") vs unbounded
 *                    ("fix all bugs", "rewrite the codebase")
 *   3. Success     — explicit acceptance criteria? tests? expected behaviour?
 *   4. Tech hints  — error messages, stack traces, framework names, versions
 *   5. Length      — too short (<10 words) is usually under-specified;
 *                    too long (>500 words) often buries the actual ask
 *   6. Ambiguity   — vague verbs (improve, optimise, clean up) without target
 *
 * Output behaviour:
 *   • In hook mode (stdin = JSON event): prints additionalContext via JSON
 *     output to stdout so Claude sees the coaching suggestions as system info,
 *     OR stays silent if the prompt is already strong (score ≥ 80).
 *   • In CLI mode (`node prompt-coach.js analyze "..."`): prints a human-
 *     readable report to stdout.
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import {
  PROMPTS_DIR, ensureDataDirs, loadJSON, saveJSON,
  estimateTokensFromString, isQuietMode, isMainModule
} from './utils.js';

ensureDataDirs();

// ── Heuristic patterns ───────────────────────────────────────────────────────

const VAGUE_VERBS = [
  'improve', 'optimize', 'optimise', 'clean up', 'refactor', 'better',
  'make it nice', 'fix issues', 'fix problems', 'tidy', 'polish'
];

const STRONG_VERBS = [
  'add', 'remove', 'rename', 'replace', 'extract', 'inline',
  'implement', 'create', 'delete', 'fix', 'debug', 'test', 'document'
];

const UNBOUNDED_PHRASES = [
  /\ball\s+(bugs|files|tests|errors|issues|problems)\b/i,
  /\brewrite\s+(everything|the\s+codebase|all\s+the)/i,
  /\bredesign\s+(everything|the\s+app|the\s+system)/i,
  /\bmake\s+it\s+(nice|better|good|cool|awesome|amazing|perfect)\b/i,
  /\b(improve|optimi[sz]e|fix|refactor|clean\s*up)\s+(everything|all|the\s+(codebase|whole|entire))/i,
];

const SUCCESS_HINTS = [
  /\btest(s)?\b.*\bpass/i,
  /\bso that\b/i,
  /\bexpected (output|result|behaviour|behavior)/i,
  /\backceptance criteri/i,
  /\bdone when\b/i,
  /\buntil\b/i,
];

const TECH_HINTS = [
  /\berror[:\s]/i,
  /\bstack\s*trace\b/i,
  /\bexception\b/i,
  /\bfailed\s+with\b/i,
  /\bcrash(es|ed)?\b/i,
  /Cannot read prop|TypeError|ReferenceError|SyntaxError/,
  /\bv?\d+\.\d+(\.\d+)?\b/, // version numbers
];

// File-path-like substrings: src/foo.ts, tests/bar.spec.js, /Users/.../foo, ./bar.py
// Allows multi-dot names like foo.spec.js by matching .ext greedily until last segment.
const FILE_PATH_REGEX = /(?:[a-zA-Z0-9_./-]*\/)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z][a-zA-Z0-9]{0,7})+\b/g;
const LINE_REF_REGEX = /:\d+(?::\d+)?\b/;
const IDENTIFIER_REGEX = /\b[a-z][a-zA-Z0-9_]+\(\)|`[^`]+`|\b[A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z0-9_]+)+\b/;

// ── Analyzer ─────────────────────────────────────────────────────────────────

export function analyzePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return { score: 0, grade: 'F', signals: {}, suggestions: ['Empty prompt — write what you want done.'] };
  }

  const trimmed = prompt.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // ── Detect signals ──
  const filePathMatches = (trimmed.match(FILE_PATH_REGEX) || []).filter(s =>
    !s.startsWith('http') && !s.endsWith('.com') && !s.endsWith('.io')
  );
  const hasLineRef = LINE_REF_REGEX.test(trimmed);
  const hasIdentifier = IDENTIFIER_REGEX.test(trimmed);
  const hasSuccess = SUCCESS_HINTS.some(re => re.test(trimmed));
  const hasTechContext = TECH_HINTS.some(re => re.test(trimmed));
  const hasVagueVerb = VAGUE_VERBS.some(v => trimmed.toLowerCase().includes(v));
  const hasStrongVerb = STRONG_VERBS.some(v => new RegExp(`\\b${v}\\b`, 'i').test(trimmed));
  const hasUnbounded = UNBOUNDED_PHRASES.some(re => re.test(trimmed));
  const hasCodeBlock = /```/.test(trimmed);
  const hasQuestionMark = /\?/.test(trimmed);

  // ── Score components (each 0–100) ──
  const specificity = Math.min(100,
    (filePathMatches.length > 0 ? 35 : 0) +
    (hasLineRef ? 15 : 0) +
    (hasIdentifier ? 25 : 0) +
    (hasCodeBlock ? 25 : 0)
  );

  const scope = Math.min(100,
    (hasUnbounded ? 0 : 50) +
    (hasStrongVerb ? 30 : 0) +
    (hasVagueVerb ? -20 : 0) +
    (wordCount >= 8 && wordCount <= 200 ? 20 : 0)
  );

  const successCriteria = hasSuccess ? 100 :
    (hasTechContext ? 60 : 30);

  const lengthScore = wordCount < 4 ? 0 :
    wordCount < 10 ? 40 :
    wordCount > 500 ? 50 :
    100;

  // Weighted overall (specificity matters most for prompt quality)
  const score = Math.max(0, Math.round(
    specificity      * 0.35 +
    scope            * 0.30 +
    successCriteria  * 0.20 +
    lengthScore      * 0.15
  ));

  let grade;
  if (score >= 90) grade = 'S';
  else if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'F';

  // ── Suggestions (concrete, actionable) ──
  const suggestions = [];

  if (specificity < 50 && filePathMatches.length === 0 && !hasIdentifier) {
    suggestions.push('Name the specific file(s), function(s), or module(s) you want changed (e.g. `src/auth/login.ts:42`).');
  }
  if (hasUnbounded) {
    suggestions.push('Bound the scope: instead of "all bugs / rewrite everything", pick one concrete failure or feature.');
  }
  if (hasVagueVerb && !hasStrongVerb) {
    const found = VAGUE_VERBS.find(v => trimmed.toLowerCase().includes(v));
    suggestions.push(`Replace vague "${found}" with a concrete action: add/remove/rename/extract/inline/replace.`);
  }
  if (!hasSuccess && !hasTechContext && wordCount > 8) {
    suggestions.push('State the success condition: what tests pass? what error disappears? what does the new behaviour look like?');
  }
  if (wordCount < 6) {
    suggestions.push('Prompt is very short — Claude will likely re-read many files to guess intent. Add 1–2 sentences of context.');
  }
  if (wordCount > 500) {
    suggestions.push('Prompt is long — the actual ask may be buried. Lead with one sentence stating the goal.');
  }
  if (hasQuestionMark && !hasStrongVerb && wordCount < 30) {
    suggestions.push('Open question without a target — be explicit if you want Claude to plan, implement, or just answer.');
  }

  // Detect inferred file path candidates the user may want to load
  const inferredFiles = [...new Set(filePathMatches)].slice(0, 8);

  return {
    score,
    grade,
    wordCount,
    estTokens: estimateTokensFromString(trimmed),
    signals: {
      specificity, scope, successCriteria, lengthScore,
      filePathsFound: inferredFiles,
      hasLineRef, hasIdentifier, hasSuccess,
      hasTechContext, hasVagueVerb, hasStrongVerb,
      hasUnbounded, hasCodeBlock,
    },
    suggestions,
  };
}

/** Build an enhanced version of the user's prompt by appending guardrails. */
export function buildImprovedPrompt(prompt, analysis) {
  const lines = [prompt.trim()];

  if (analysis.suggestions.length === 0) return prompt;

  lines.push('');
  lines.push('---');
  lines.push('Self-check before answering:');
  if (analysis.signals.specificity < 50) {
    lines.push('- I will identify the exact files/lines I plan to change before editing.');
  }
  if (analysis.signals.scope < 50) {
    lines.push('- I will limit changes to the smallest scope that satisfies the request.');
  }
  if (!analysis.signals.hasSuccess) {
    lines.push('- I will state the success criteria (tests, behaviour, error gone) before declaring done.');
  }
  return lines.join('\n');
}

// ── Hook mode ────────────────────────────────────────────────────────────────

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function logPrompt(sessionId, prompt, analysis) {
  try {
    const file = join(PROMPTS_DIR, `${sessionId}.jsonl`);
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      score: analysis.score,
      grade: analysis.grade,
      wordCount: analysis.wordCount,
      signals: analysis.signals,
      suggestions: analysis.suggestions,
      preview: prompt.slice(0, 200),
    }) + '\n';
    // jsonl append is safe — small, single-process per hook tick.
    if (existsSync(file)) {
      const prev = readFileSync(file, 'utf-8');
      writeFileSync(file, prev + entry);
    } else {
      writeFileSync(file, entry);
    }
  } catch { /* best-effort */ }
}

async function hookMode() {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  if (event.hook_event_name !== 'UserPromptSubmit') process.exit(0);

  const prompt = event.prompt || '';
  const sessionId = event.session_id || 'unknown';

  const analysis = analyzePrompt(prompt);
  logPrompt(sessionId, prompt, analysis);

  // Strong prompt or quiet mode — stay silent.
  if (analysis.score >= 80 || isQuietMode()) {
    process.exit(0);
  }

  // Weak prompt — inject coaching as additional context (visible to Claude).
  const top = analysis.suggestions.slice(0, 3);
  if (top.length === 0) process.exit(0);

  const lines = [
    `[prompt-coach] Prompt quality: ${analysis.grade} (${analysis.score}/100).`,
    'Suggestions to make this prompt produce better results:',
    ...top.map(s => `  - ${s}`),
  ];
  if (analysis.signals.filePathsFound.length > 0) {
    lines.push(`  Inferred files: ${analysis.signals.filePathsFound.join(', ')}`);
  }
  lines.push('');
  lines.push('Apply these mentally before reading files. If the prompt is too vague, ask one clarifying question instead of guessing.');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: lines.join('\n'),
    }
  }));
  process.exit(0);
}

// ── CLI mode ─────────────────────────────────────────────────────────────────

function cliReport(analysis) {
  const out = [];
  out.push('');
  out.push(`  PROMPT QUALITY — ${analysis.grade}  (${analysis.score}/100)`);
  out.push('  ' + '─'.repeat(56));
  out.push(`  Words: ${analysis.wordCount}   Est. tokens: ${analysis.estTokens}`);
  out.push('');
  out.push('  Breakdown:');
  out.push(`    Specificity ......... ${String(analysis.signals.specificity).padStart(3)}/100`);
  out.push(`    Scope ............... ${String(analysis.signals.scope).padStart(3)}/100`);
  out.push(`    Success criteria .... ${String(analysis.signals.successCriteria).padStart(3)}/100`);
  out.push(`    Length .............. ${String(analysis.signals.lengthScore).padStart(3)}/100`);
  if (analysis.signals.filePathsFound.length > 0) {
    out.push(`    Files mentioned ..... ${analysis.signals.filePathsFound.join(', ')}`);
  }
  if (analysis.suggestions.length > 0) {
    out.push('');
    out.push('  Suggestions:');
    for (const s of analysis.suggestions) out.push(`    - ${s}`);
  } else {
    out.push('');
    out.push('  Strong prompt. No suggestions.');
  }
  out.push('');
  return out.join('\n');
}

function showHistory(count = 10) {
  if (!existsSync(PROMPTS_DIR)) {
    console.log('No prompt history yet.');
    return;
  }
  const files = readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.jsonl'));
  const all = [];
  for (const f of files) {
    try {
      const lines = readFileSync(join(PROMPTS_DIR, f), 'utf-8').split('\n').filter(Boolean);
      for (const ln of lines) {
        try { all.push(JSON.parse(ln)); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  all.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const recent = all.slice(0, count);

  console.log(`\n  PROMPT HISTORY — last ${recent.length}\n  ${'─'.repeat(56)}`);
  for (const e of recent) {
    const ts = e.ts.slice(0, 16).replace('T', ' ');
    const preview = (e.preview || '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`  [${e.grade}] ${ts}  ${preview}${preview.length === 60 ? '...' : ''}`);
  }
  if (all.length > 0) {
    const avg = Math.round(all.reduce((s, e) => s + (e.score || 0), 0) / all.length);
    console.log(`\n  Average score across ${all.length} prompts: ${avg}/100`);
  }
  console.log('');
}

async function main() {
  const action = process.argv[2];

  if (action === 'analyze') {
    const text = process.argv.slice(3).join(' ');
    if (!text) {
      console.error('Usage: node src/prompt-coach.js analyze "<prompt text>"');
      process.exit(1);
    }
    console.log(cliReport(analyzePrompt(text)));
    return;
  }

  if (action === 'history') {
    showHistory(parseInt(process.argv[3], 10) || 10);
    return;
  }

  if (action === 'improve') {
    const text = process.argv.slice(3).join(' ');
    if (!text) {
      console.error('Usage: node src/prompt-coach.js improve "<prompt text>"');
      process.exit(1);
    }
    const a = analyzePrompt(text);
    console.log(buildImprovedPrompt(text, a));
    return;
  }

  // Default: hook mode (read JSON event from stdin)
  await hookMode();
}

if (isMainModule(import.meta.url)) main().catch(() => process.exit(0));
