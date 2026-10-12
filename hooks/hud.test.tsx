import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, levelOf } from './register'

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

test('cramped band falls back to one line', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'game-hud', surface: 'terminal', ...band(3) })
  expect(await ui.find({ type: 'Box' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /LV1/ })).toBeDefined()
  await ui.unmount()
})
