import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PALETTES, bar, burnRate, effectsOf, isBurning, levelOf, lookFor, mergeRoster, nextStreak, outcomeOf, paceOf, recordCall, targetOf } from './register'

const band = (maxRows: number) => ({
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows }, view: {} },
})

// Stand in for the engine beneath the mod: a clock, an empty band, a measurement echo.
const world = (on: On) => {
  mock.clock(on)
  on('ui.render', () => undefined as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
}

test('bars and levels', async () => {
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(150, 4)).toBe('████')
  expect(levelOf(0)).toBe(1)
  expect(levelOf(10)).toBe(2)
  expect(levelOf(39)).toBe(2)
})

test('HUD shows HP, stamina, gold, level and an empty party', async ($, on) => {
  world(on)
  await $.session.measure({
    context: { tokens: 60000, window: 200000, percent: 30 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 25 }],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'game-hud', surface, ...band(10) })
    expect(await ui.find({ type: 'Text', text: /LV 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /70%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5H/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resting at camp/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the HUD wears the opposite of the system appearance', async () => {
  expect(lookFor('light')).toBe('dark')
  expect(lookFor('dark')).toBe('light')
})

test('the HUD paints its own background and text', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'game-hud', surface: 'terminal', ...band(10) })
  const panel = await ui.find({ type: 'Box' })
  expect(Object.values(PALETTES).map(p => p.bg)).toContain(panel?.props.backgroundColor)
  await ui.unmount()
})

test('cramped band falls back to one line', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'game-hud', surface: 'terminal', ...band(3) })
  expect(await ui.find({ type: 'Box' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /LV1/ })).toBeDefined()
  await ui.unmount()
})

test('raid frames keep the last five calls per agent, running agents first', async () => {
  const scout = { id: 'a1', type: 'scout', description: 'find auth', status: 'running' }
  const critic = { id: 'a2', type: 'critic', description: 'review', status: 'completed' }
  let frames = mergeRoster([], [critic, scout])
  expect(frames.map(f => f.member.type)).toEqual(['scout', 'critic'])

  for (let i = 0; i < 7; i++) {
    frames = recordCall(frames, 'a1', { id: `t${i}`, tool: 'Grep', target: `p${i}`, state: 'run' })
  }
  frames = recordCall(frames, 'a1', { id: 't6', tool: 'Grep', target: 'p6', state: 'ok' })
  const f = frames[0]!
  expect(f.total).toBe(7)
  expect(f.calls.map(c => c.id)).toEqual(['t2', 't3', 't4', 't5', 't6'])
  expect(f.calls[4]!.state).toBe('ok')

  expect(targetOf({ file_path: 'C:\\repo\\src\\auth.ts' })).toBe('src/auth.ts')
  expect(targetOf({ pattern: 'login' })).toBe('login')
})

test('raid pane shows an empty camp before any agent', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({
    plugin: 'game-hud',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'raid-frames',
    props: {} as never,
  })
  expect(await ui.find({ type: 'Text', text: /No party yet/ })).toBeDefined()
  await ui.unmount()
})

test('pace compares stamina used with the clock', async () => {
  const now = Date.parse('2026-10-12T00:00:00Z')
  const resetsAt = new Date(now + 2.5 * 3600_000).toISOString() // half of the 5h window gone
  expect(paceOf({ kind: 'five_hour', pct: 80, resetsAt }, now)?.kind).toBe('fast')
  expect(paceOf({ kind: 'five_hour', pct: 20, resetsAt }, now)?.kind).toBe('slow')
  expect(paceOf({ kind: 'five_hour', pct: 52, resetsAt }, now)?.kind).toBe('even')
  expect(paceOf({ kind: 'spend_limit', pct: 80, resetsAt }, now)).toBeUndefined()
  expect(paceOf({ kind: 'five_hour', pct: 80 }, now)).toBeUndefined()
})

test('status effects follow errors, slow calls, spend and stamina', async () => {
  const base = { errStreak: 0, errAt: 1000, slowUntil: 0, burning: false, limits: [], now: 1000 }
  expect(effectsOf(base)).toEqual([])
  const labels = (o: Partial<typeof base>) => effectsOf({ ...base, ...o }).map(e => e.label)
  expect(labels({ errStreak: 2 })).toEqual([])
  expect(labels({ errStreak: 3 })).toEqual(['POISONED'])
  expect(labels({ slowUntil: 2000 })).toEqual(['SLOWED'])
  expect(labels({ slowUntil: 500 })).toEqual([])
  expect(labels({ burning: true })).toEqual(['BURNING'])
  expect(labels({ limits: [{ kind: 'five_hour', pct: 91 }] })).toEqual(['FROZEN'])
})

test('burn rate needs half a minute of samples', async () => {
  expect(burnRate([{ t: 0, usd: 0 }])).toBeUndefined()
  expect(burnRate([{ t: 0, usd: 0 }, { t: 10_000, usd: 1 }])).toBeUndefined()
  expect(burnRate([{ t: 0, usd: 0 }, { t: 60_000, usd: 0.75 }])).toBe(0.75)
})

test('burning cools off when the session goes idle', async () => {
  const hot = [{ t: 0, usd: 0 }, { t: 60_000, usd: 1 }]
  expect(isBurning(hot, 60_000)).toBe(true)
  expect(isBurning(hot, 200_000)).toBe(false)
  expect(isBurning([{ t: 0, usd: 0 }, { t: 60_000, usd: 0.1 }], 60_000)).toBe(false)
  expect(isBurning([], 0)).toBe(false)
})

test('a window that has reset is stale: no pace marker, no frozen', async () => {
  const now = Date.parse('2026-10-12T00:00:00Z')
  const past = new Date(now - 1000).toISOString()
  expect(paceOf({ kind: 'five_hour', pct: 92, resetsAt: past }, now)).toBeUndefined()
  const base = { errStreak: 0, errAt: 0, slowUntil: 0, burning: false, now }
  expect(effectsOf({ ...base, limits: [{ kind: 'five_hour', pct: 92, resetsAt: past }] })).toEqual([])
})

test('tool outcomes: refusals and interrupts do not poison', async () => {
  expect(outcomeOf({}, false)).toBe('ok')
  expect(outcomeOf({ isError: true }, false)).toBe('error')
  expect(outcomeOf({ deny: 'no' }, false)).toBe('refused')
  expect(outcomeOf(undefined, false)).toBe('error') // next threw
  expect(outcomeOf(undefined, true)).toBe('aborted')
  expect(outcomeOf({ isError: true }, true)).toBe('aborted')
  expect(outcomeOf({}, true)).toBe('ok') // finished fine as the signal aborted

  let n = 0
  for (const o of ['error', 'refused', 'aborted', 'error', 'aborted', 'error'] as const) n = nextStreak(n, o)
  expect(n).toBe(3)
  expect(nextStreak(n, 'ok')).toBe(0)
})

test('poison wears off once the session goes quiet', async () => {
  const base = { errStreak: 3, errAt: 0, slowUntil: 0, burning: false, limits: [] }
  expect(effectsOf({ ...base, now: 60_000 }).map(e => e.label)).toEqual(['POISONED'])
  expect(effectsOf({ ...base, now: 10 * 60_000 })).toEqual([])
})

test('a quiet streak starts over instead of re-arming on one error', async () => {
  expect(nextStreak(3, 'error', 10 * 60_000)).toBe(1)
  expect(nextStreak(3, 'error', 1000)).toBe(4)
  expect(nextStreak(3, 'refused', 10 * 60_000)).toBe(0)
})
