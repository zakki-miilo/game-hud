import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Member, Stats } from '../types'

const stats = atom({ plugin: 'game-hud', key: 'stats' } as const, null)
const party = atom({ plugin: 'game-hud', key: 'party' } as const, [])
const xp = atom({ plugin: 'game-hud', key: 'xp' } as const, 0)
const frame = atom({ plugin: 'game-hud', key: 'frame' } as const, 0)

const ACTIVE = ['pending', 'running', 'waiting']
const LIMIT_NAMES: Record<string, string> = { five_hour: '5H', seven_day: '7D', spend_limit: '$$' }
const SPRITES = [
  ['☻', '☺'],
  ['♞', '♘'],
  ['♜', '♖'],
  ['♝', '♗'],
]

export const toStats = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Stats => ({
  ctxPct: u.context.percent,
  ctxTokens: u.context.tokens,
  ctxWindow: u.context.window,
  limits: u.rateLimits.map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt })),
  usd: u.cost?.usd,
})

// XP needed to reach a level: 10, 40, 90, 160, ...
export const levelOf = (points: number) => Math.floor(Math.sqrt(points / 10)) + 1
const floorOf = (level: number) => 10 * (level - 1) ** 2

export const bar = (pct: number, width: number) => {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const tone = (remaining: number) => (remaining > 50 ? 'success' : remaining > 20 ? 'warning' : 'error')

const kilo = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

const countdown = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`
}

let lastParty = ''
let warnedHp = false
const warnedLimits = new Set<string>()

async function refreshParty($: EngineInterface) {
  const all = await $.agent.list()
  const active: Member[] = all
    .filter(a => ACTIVE.includes(a.status))
    .map(a => ({ id: a.id, type: a.type, description: a.description, status: a.status }))
  const key = JSON.stringify(active)
  if (key !== lastParty) {
    lastParty = key
    await update($, party, () => active)
  }
  if (active.length > 0) {
    await update($, frame, f => (f + 1) % 2)
  }
}

function alarms($: EngineInterface, s: Stats) {
  if (s.ctxPct !== undefined) {
    if (s.ctxPct >= 80 && !warnedHp) {
      warnedHp = true
      $.ui.toast(`☠ LOW HP! Context ${s.ctxPct}% full. Cast /compact to heal.`, { timeoutMs: 8000 })
    } else if (s.ctxPct < 70) {
      warnedHp = false
    }
  }
  for (const l of s.limits) {
    if (l.pct >= 90 && !warnedLimits.has(l.kind)) {
      warnedLimits.add(l.kind)
      $.ui.toast(`⚠ STAMINA CRITICAL: ${LIMIT_NAMES[l.kind] ?? l.kind} limit at ${l.pct}%`, { timeoutMs: 8000 })
    } else if (l.pct < 80) {
      warnedLimits.delete(l.kind)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    const usage = await $.session.usage()
    await update($, stats, () => toStats(usage))
    await refreshParty($)
    $.clock.every(1000, () => void refreshParty($))

    return ran
  })

  on('session.measure', async ($, e, next) => {
    const s = toStats(e)
    await update($, stats, () => s)
    alarms($, s)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await refreshParty($)

    return spawned
  })

  on('tool.call', async ($, e, next) => {
    await update($, xp, n => n + 1)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, stats)
    const members = await read($, party)
    const points = await read($, xp)
    const f = await read($, frame)
    const now = await $.clock.now()

    const level = levelOf(points)
    const lo = floorOf(level)
    const hi = floorOf(level + 1)
    const cols = e.props.bodyColumns
    const w = Math.max(6, Math.min(20, Math.floor((cols - 44) / 3)))

    const hp = s?.ctxPct === undefined ? undefined : 100 - s.ctxPct
    const gold = s?.usd === undefined ? '--' : `$${s.usd.toFixed(2)}`

    const hpText =
      hp === undefined ? (
        <Text dimColor>{'?'.repeat(w)} awaiting first battle</Text>
      ) : (
        <Text>
          <Text color={tone(hp)}>{bar(hp, w)}</Text> {hp}%{' '}
          <Text dimColor>
            {kilo(s!.ctxTokens ?? 0)}/{kilo(s!.ctxWindow)} used
          </Text>
        </Text>
      )

    const partyText =
      members.length === 0 ? (
        <Text dimColor>resting at camp</Text>
      ) : (
        <Text>
          {members.slice(0, 4).map((m, i) => (
            <Text>
              <Text color="claude" bold>
                {SPRITES[i % SPRITES.length]?.[(f + i) % 2] ?? '☻'}
              </Text>{' '}
              <Text bold>{m.type}</Text>
              <Text dimColor>
                {' '}
                {m.description}
                {'   '}
              </Text>
            </Text>
          ))}
          {members.length > 4 && <Text dimColor>+{members.length - 4} more</Text>}
        </Text>
      )

    // Too little room for the full panel: one line.
    if (e.props.maxRows < 6) {
      return (
        <Text wrap="truncate">
          <Text color="claude" bold>
            LV{level}
          </Text>{' '}
          <Text color="error">♥</Text>
          {hp ?? '?'}%{' '}
          {s?.limits.map(l => (
            <Text>
              <Text color="warning">◆</Text>
              {LIMIT_NAMES[l.kind] ?? l.kind} {100 - l.pct}%{' '}
            </Text>
          ))}
          <Text color="warning">{gold}</Text> <Text color="claude">⚔</Text>
          {members.length} active
        </Text>
      )
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Box justifyContent="space-between">
          <Text wrap="truncate">
            <Text color="claude" bold>
              ⚔ CLAUDE QUEST
            </Text>
            {'  '}
            <Text bold>★ LV {level}</Text>{' '}
            <Text color="suggestion">{bar(((points - lo) / (hi - lo)) * 100, w)}</Text>{' '}
            <Text dimColor>
              {points - lo}/{hi - lo} XP
            </Text>
          </Text>
          <Text color="warning" bold>
            ◎ {gold}
          </Text>
        </Box>
        <Text wrap="truncate">
          <Text color="error" bold>
            ♥ HP{'  '}
          </Text>
          {hpText}
        </Text>
        <Text wrap="truncate">
          <Text color="warning" bold>
            ◆ SP{'  '}
          </Text>
          {!s || s.limits.length === 0 ? (
            <Text dimColor>no rate-limit readings yet</Text>
          ) : (
            s.limits.map(l => (
              <Text>
                <Text dimColor>{LIMIT_NAMES[l.kind] ?? l.kind} </Text>
                <Text color={tone(100 - l.pct)}>{bar(100 - l.pct, Math.max(4, Math.floor(w / 2)))}</Text>{' '}
                {100 - l.pct}%
                <Text dimColor> ↻{countdown(l.resetsAt, now)}</Text>
                {'   '}
              </Text>
            ))
          )}
        </Text>
        <Text wrap="truncate">
          <Text color="claude" bold>
            ⚑ PARTY [{members.length}]{' '}
          </Text>
          {partyText}
        </Text>
      </Box>
    )
  })
}
