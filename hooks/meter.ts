import type { EngineInterface, Register } from 'claude-code'

import { cacheMinutesLeft, learnTtl, LONG_TTL_MIN, meterLine, nudges } from '../src/meter-core.js'

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
}

async function refresh($: EngineInterface, m: Meter) {
  if (m.isOff) {
    $.ui.status(undefined)
    return
  }
  const usage = await $.session.usage()
  const cacheLeft = cacheMinutesLeft(m.lastReplyAt, await $.clock.now(), m.ttlMin)
  m.lastContext = usage.context.tokens ?? m.lastContext
  $.ui.status(meterLine(usage, cacheLeft))
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
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    m.ttlMin = Number(await $.store.get(TTL_KEY)) || LONG_TTL_MIN
    m.isOff = (await $.store.get(OFF_KEY)) === true
    await $.command.register({
      name: 'cco-meter',
      description: 'Context Optimizer: show or hide the live cost and context line',
      immediate: true,
    })
    await refresh($, m)
    // The cache countdown moves on its own between turns.
    $.clock.every(60_000, () => refresh($, m).catch(() => {}))
    return result
  })

  on('command.run', { command: 'cco-meter' }, async ($, e) => {
    m.isOff = !m.isOff
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
