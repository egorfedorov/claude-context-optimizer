import { expect, mock, test } from 'claude-code/testing'

// Runs under `claude plugin test .`: the meter module in the real engine,
// with the session's figures and the clock answered from memory.

const usage = {
  startedAt: 0,
  context: { tokens: 142_000, window: 1_000_000, percent: 14 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 63 }],
  cost: { usd: 3.1 },
}

const turn = { answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' } as const

test('pins the meter after each reply, and a new reply restarts the cache clock', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const lines: (string | undefined)[] = []
  on('session.usage', () => ({ value: usage }))
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'ok' }))

  await $.turn.complete(turn)
  expect(lines.at(-1)).toBe('CCO · ctx 142K/1M 14% · $3.10 · 5h 63% · cache 60m')

  await clock.advance(13 * 60_000)
  await $.turn.complete({ ...turn, turnId: 't2' })
  expect(lines.at(-1)).toBe('CCO · ctx 142K/1M 14% · $3.10 · 5h 63% · cache 60m')
})

test("a subagent's turn leaves the meter alone", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const lines: (string | undefined)[] = []
  on('session.usage', () => ({ value: usage }))
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'ok' }))

  await $.turn.complete({ ...turn, agentId: 'a1' })
  expect(lines).toEqual([])
})

test('counts the cache down between turns, and /cco-meter hides it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const lines: (string | undefined)[] = []
  on('session.usage', () => ({ value: usage }))
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn)
  await clock.advance(13 * 60_000)
  expect(lines.at(-1)).toBe('CCO · ctx 142K/1M 14% · $3.10 · 5h 63% · cache 47m')

  const off = await $.command.run({ command: 'cco-meter' })
  expect(off.text).toContain('off')
  expect(lines.at(-1)).toBeUndefined()
})
