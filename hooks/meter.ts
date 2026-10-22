import type { EngineInterface, Register } from 'claude-code'

import { cacheMinutesLeft, learnTtl, limitForecast, LONG_TTL_MIN, meterLine, nudges } from '../src/meter-core.js'

// Live meter: one line pinned under the prompt with the context's fill, what
// the session has cost, the plan's limits and how long the prompt cache stays
// warm. Every figure comes from the engine; nothing is read from disk and
// nothing leaves the machine. `/cco-meter` turns it off and on.

const TTL_KEY = 'cacheTtlMin'
const OFF_KEY = 'meterOff'

type Meter = {
  lastReplyAt: number
  turnStartedAt: number
  lastContext: number
  ttlMin: number
  isOff: boolean
  shown: Set<string>
  samples: Record<string, { t: number; pct: number }[]>
}

async function refresh($: EngineInterface, m: Meter) {
  if (m.isOff) {
    $.ui.status(undefined)
    return
  }
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const cacheLeft = cacheMinutesLeft(m.lastReplyAt, now, m.ttlMin)
  m.lastContext = usage.context.tokens ?? m.lastContext
  // Pace of each limit over the last half hour, in memory only.
  const forecasts: Record<string, number | null> = {}
  for (const l of usage.rateLimits ?? []) {
    if (!Number.isFinite(l.percentUsed)) continue
    const s = (m.samples[l.kind] ??= [])
    s.push({ t: now, pct: l.percentUsed })
    while (s.length > 40 || (s.length > 1 && now - s[0].t > 30 * 60_000)) s.shift()
    forecasts[l.kind] = limitForecast(s, l.resetsAt, now)
  }
  $.ui.status(meterLine(usage, cacheLeft, forecasts))
  for (const n of nudges(usage, { cacheLeft, shown: m.shown })) {
    m.shown.add(n.kind)
    $.ui.toast(n.text)
  }
}

export const register: Register = on => {
  const m: Meter = {
    lastReplyAt: 0,
    turnStartedAt: 0,
    lastContext: 0,
    ttlMin: LONG_TTL_MIN,
    isOff: false,
    shown: new Set(),
    samples: {},
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    m.ttlMin = Number(await $.store.get(TTL_KEY)) || LONG_TTL_MIN
    m.isOff = (await $.store.get(OFF_KEY)) === true
    await $.command.register({
      name: 'cco-meter',
      description: 'Context Optimizer: show or hide the live cost and context line',
      argumentHint: '[on|off]',
      immediate: true,
    })
    await refresh($, m)
    // The cache countdown moves on its own between turns.
    $.clock.every(60_000, () => refresh($, m).catch(() => {}))
    return result
  })

  // `/cco-meter on` and `/cco-meter off` say what they mean; bare `/cco-meter` toggles.
  on('command.run', { command: 'cco-meter' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    m.isOff = arg === 'off' ? true : arg === 'on' ? false : !m.isOff
    await $.store.set(OFF_KEY, m.isOff)
    await refresh($, m)
    return { text: m.isOff ? 'Live meter off. /cco-meter turns it back on.' : 'Live meter on.' }
  })

  // Main-thread turns only: a subagent's requests run on a cache of their own.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) m.turnStartedAt = await $.clock.now()
    return next(e)
  })

  // The first request after a pause shows whether the cache outlived it.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    if (e.index === 0 && !e.agentId && m.lastReplyAt && step?.usage) {
      const learned = learnTtl(m.ttlMin, (m.turnStartedAt - m.lastReplyAt) / 60_000, step.usage, m.lastContext)
      if (learned !== m.ttlMin) {
        m.ttlMin = learned
        await $.store.set(TTL_KEY, m.ttlMin)
      }
    }
    return step
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    m.lastReplyAt = await $.clock.now()
    await refresh($, m)
    return result
  })
}
