/**
 * Live meter — the pure part.
 *
 * hooks/meter.ts pins one line under Claude Code's prompt: how full the
 * context is, what the session has cost, how much of the plan's limits is
 * used, and how long the prompt cache stays warm. Every figure comes from the
 * engine ($.session.usage() and each request's usage); this file only turns
 * them into text, so it runs in the mod's sandbox and under Node's tests
 * alike. No imports, no I/O.
 */

/** The prompt cache lasts 5 minutes on the API's default, an hour on most Claude Code plans. */
export const SHORT_TTL_MIN = 5;
export const LONG_TTL_MIN = 60;

/** Below this much context a lapsed cache costs pennies: not worth a word. */
export const COLD_WARN_TOKENS = 50_000;

export function formatTokens(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

function money(usd) {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/**
 * Whole minutes the cache has left after the last reply, or 0 once it lapsed.
 * null before the first reply of the session.
 * @param {number} lastReplyAt
 * @param {number} now
 * @param {number} ttlMin
 * @returns {number | null}
 */
export function cacheMinutesLeft(lastReplyAt, now, ttlMin) {
  if (!lastReplyAt) return null;
  const left = ttlMin - (now - lastReplyAt) / 60_000;
  return left > 0 ? Math.ceil(left) : 0;
}

/**
 * What the first request after a pause says about the cache's lifetime.
 * A hit after more than 5 minutes proves the long cache; a miss within the
 * hour, on a context worth caching, proves the short one. Anything else
 * leaves `ttlMin` as it was.
 * @param {number} ttlMin
 * @param {number} gapMin
 * @param {{ cache_read_input_tokens?: number, cache_creation_input_tokens?: number } | null} usage
 * @param {number} contextTokens
 * @returns {number}
 */
export function learnTtl(ttlMin, gapMin, usage, contextTokens) {
  if (!usage || !(gapMin > SHORT_TTL_MIN) || !(contextTokens > 10_000)) return ttlMin;
  const read = usage.cache_read_input_tokens || 0;
  const written = usage.cache_creation_input_tokens || 0;
  if (read >= contextTokens / 2) return LONG_TTL_MIN;
  if (gapMin < LONG_TTL_MIN && written >= contextTokens / 2) return SHORT_TTL_MIN;
  return ttlMin;
}

function limitLabel(kind) {
  return { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }[kind] || kind;
}

const FORECAST_WINDOW_MIN = 30;
const FORECAST_MIN_SPAN_MIN = 10;
const FORECAST_MAX_MIN = 180;

/**
 * Minutes until a rate limit is used up at the pace of the last half hour, or
 * null when there is no honest answer: too little history, no climb, a pace
 * that reaches 100% only after the window resets, or more than 3 hours out.
 * `samples` is [{ t: ms, pct }] in time order.
 * @param {{ t: number, pct: number }[]} samples
 * @param {string | undefined} resetsAt ISO time the limit resets
 * @param {number} now ms
 * @returns {number | null}
 */
export function limitForecast(samples, resetsAt, now) {
  const recent = (samples || []).filter(x => now - x.t <= FORECAST_WINDOW_MIN * 60_000);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const spanMin = (last.t - first.t) / 60_000;
  const rise = last.pct - first.pct;
  if (spanMin < FORECAST_MIN_SPAN_MIN || rise < 1 || last.pct >= 100) return null;
  const left = Math.round((100 - last.pct) / (rise / spanMin));
  const resetMin = (new Date(resetsAt).getTime() - now) / 60_000;
  if (Number.isFinite(resetMin) && left >= resetMin) return null;
  return left > FORECAST_MAX_MIN ? null : left;
}

/**
 * The status line. Before the first reply it says so, with any limits known.
 * `usage` is $.session.usage()'s answer; `cacheLeft` is cacheMinutesLeft's.
 * @param {any} usage
 * @param {number | null} [cacheLeft]
 * @param {Record<string, number | null>} [forecasts] minutes to full, by limit kind
 * @returns {string}
 */
export function meterLine(usage, cacheLeft = null, forecasts = {}) {
  const ctx = usage?.context;
  const parts = [];
  // Before the session's first reply there is no context figure yet; show
  // what is known rather than nothing, so turning the meter on is visible.
  if (ctx && Number.isFinite(ctx.tokens)) {
    const pct = Number.isFinite(ctx.percent) ? ` ${ctx.percent}%` : '';
    parts.push(`ctx ${formatTokens(ctx.tokens)}/${formatTokens(ctx.window)}${pct}`);
  } else {
    parts.push('ctx after the first reply');
  }
  if (usage?.cost && Number.isFinite(usage.cost.usd) && usage.cost.usd > 0) parts.push(money(usage.cost.usd));
  for (const l of usage?.rateLimits || []) {
    if (!Number.isFinite(l.percentUsed)) continue;
    const eta = forecasts[l.kind];
    parts.push(`${limitLabel(l.kind)} ${Math.round(l.percentUsed)}%${eta ? ` (full in ~${eta}m)` : ''}`);
  }
  if (cacheLeft === 0) parts.push('cache cold');
  else if (cacheLeft != null) parts.push(`cache ${cacheLeft}m`);
  // Claude Code already prefixes the line with the plugin's name.
  return parts.join(' · ');
}

function resetTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return ` (resets ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')})`;
}

/**
 * One-time nudges worth a toast: [{ kind, text }]. `shown` holds the kinds
 * already shown this session, so each appears once.
 * @param {any} usage
 * @param {{ cacheLeft?: number | null, shown?: Set<string> }} [options]
 * @returns {{ kind: string, text: string }[]}
 */
export function nudges(usage, { cacheLeft = null, shown = new Set() } = {}) {
  const out = [];
  const ctx = usage?.context || {};
  const add = (kind, text) => { if (!shown.has(kind)) out.push({ kind, text }); };

  if (ctx.percent >= 70) {
    add('context', `Context ${ctx.percent}% full. Every message re-sends all of it: /compact at the next break, or ask for a fresh-start handoff.`);
  }
  for (const l of usage?.rateLimits || []) {
    if (l.kind === 'five_hour' && l.percentUsed >= 80) {
      add('five_hour', `5-hour limit ${Math.round(l.percentUsed)}% used${resetTime(l.resetsAt)}. Hand reading and test runs to the Haiku agents (scout, runner) to stretch it.`);
    }
    if (l.kind === 'seven_day' && l.percentUsed >= 80) {
      add('seven_day', `Weekly limit ${Math.round(l.percentUsed)}% used${resetTime(l.resetsAt)}. Prefer Sonnet or Haiku for routine work until it resets.`);
    }
  }
  if (cacheLeft === 0 && ctx.tokens >= COLD_WARN_TOKENS) {
    add('cache', `Prompt cache expired: the next message re-sends ${formatTokens(ctx.tokens)} tokens at full price. Before a long break, /compact first to shrink that.`);
  }
  return out;
}
