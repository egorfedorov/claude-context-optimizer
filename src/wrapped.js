#!/usr/bin/env node

/**
 * /cco wrapped — a short recap of your last week (or N days) of Claude Code,
 * read from the session transcripts on this machine. Nothing leaves it.
 */

import { collectSessions } from './audit.js';
import { isMainModule } from './utils.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const usd = (x) => `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`;
const share = (x, of) => (of > 0 ? `${Math.round((x / of) * 100)}%` : '0%');

/** `-Users-me-code-app` → `code-app`: the folder name Claude Code encodes a path into. */
export function projectName(path, root) {
  const rel = path.slice(root.length).replace(/^[\\/]+/, '');
  const enc = rel.split(/[\\/]/)[0] || '';
  return enc.replace(/^-Users-[^-]+-/, '').replace(/^-+/, '') || enc || 'unknown';
}

/**
 * Totals, the busiest day, the priciest projects and session, and one tip.
 * The day is the transcript's last-modified day (lazy: a session that spans
 * midnight counts on its last day; read per-message timestamps if that matters).
 * @param {any[]} sessions collectSessions() rows
 */
export function buildWrapped(sessions) {
  const total = sessions.reduce((s, x) => s + x.price.total, 0);
  const mains = sessions.filter(s => !s.subagent);
  const subTotal = sessions.reduce((s, x) => s + (x.subagent ? x.price.total : 0), 0);
  const byDay = {};
  const byProject = {};
  for (const s of sessions) {
    const d = new Date(s.mtimeMs);
    const dayKey = `${DAYS[d.getDay()]} ${d.getDate()}`;
    byDay[dayKey] = (byDay[dayKey] || 0) + s.price.total;
    const p = projectName(s.path, s.root);
    byProject[p] = (byProject[p] || 0) + s.price.total;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const priciest = [...mains].sort((a, b) => b.price.total - a.price.total)[0] || null;
  const cacheReads = sessions.reduce((s, x) => s + x.price.split.cacheReads, 0);
  const peak = Math.max(0, ...mains.map(s => s.facts.peak));
  const compactions = mains.reduce((s, x) => s + x.facts.compactions, 0);

  let tip = 'Nothing stands out: spend looks proportionate to the work.';
  if (peak >= 400_000 && compactions === 0) tip = `A session reached ${Math.round(peak / 1000)}K tokens without a /compact. Compacting near 200K is the single biggest saver.`;
  else if (total > 0 && subTotal / total < 0.05 && mains.length >= 3) tip = 'Almost nothing went to subagents. Handing file reading and test runs to the Haiku scout/runner is much cheaper.';
  else if (total > 0 && cacheReads / total > 0.6) tip = `${share(cacheReads, total)} of spend is re-reading context. Shorter sessions or /cco task before a /compact cut it most.`;

  return {
    total, sessions: mains.length, subagentRuns: sessions.length - mains.length,
    requests: sessions.reduce((s, x) => s + x.facts.requests, 0),
    busiestDay: top(byDay, 1)[0] || null,
    projects: top(byProject, 3),
    priciest: priciest && { project: projectName(priciest.path, priciest.root), total: priciest.price.total, peak: priciest.facts.peak },
    cacheReadShare: total > 0 ? cacheReads / total : 0,
    tip,
  };
}

export function renderWrapped(w, days) {
  if (!w.sessions) return `No Claude Code sessions in the last ${days} days.`;
  const lines = [
    `Your last ${days} days in Claude Code`,
    '',
    `  ${usd(w.total)} across ${w.sessions} session${w.sessions === 1 ? '' : 's'} (${w.requests.toLocaleString('en-US')} requests, ${w.subagentRuns} subagent runs)`,
  ];
  if (w.busiestDay) lines.push(`  Busiest day: ${w.busiestDay[0]} (${usd(w.busiestDay[1])})`);
  if (w.projects.length) {
    lines.push('', '  Where it went');
    for (const [name, cost] of w.projects) lines.push(`    ${name.padEnd(32)} ${usd(cost).padStart(8)}  ${share(cost, w.total)}`);
  }
  if (w.priciest) lines.push('', `  Priciest session: ${w.priciest.project}, ${usd(w.priciest.total)}, peaking at ${Math.round(w.priciest.peak / 1000)}K tokens`);
  lines.push(`  Re-reading context: ${share(w.cacheReadShare, 1)} of spend`, '', `  Tip: ${w.tip}`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--days');
  const days = parseInt(i >= 0 ? args[i + 1] : '7', 10) || 7;
  const sessions = collectSessions({ days });
  if (args.includes('--json')) console.log(JSON.stringify(buildWrapped(sessions), null, 2));
  else console.log(renderWrapped(buildWrapped(sessions), days));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[cco] wrapped error: ${e.message}`); process.exit(0); }
}
