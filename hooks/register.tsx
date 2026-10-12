import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Call, CostSample, Frame, Limit, Member, Stats } from '../types'

const stats = atom({ plugin: 'game-hud', key: 'stats' } as const, null)
const party = atom({ plugin: 'game-hud', key: 'party' } as const, [])
const xp = atom({ plugin: 'game-hud', key: 'xp' } as const, 0)
const frame = atom({ plugin: 'game-hud', key: 'frame' } as const, 0)
const raid = atom({ plugin: 'game-hud', key: 'raid' } as const, [])
const errStreak = atom({ plugin: 'game-hud', key: 'errStreak' } as const, 0)
const errAt = atom({ plugin: 'game-hud', key: 'errAt' } as const, 0)
const slowUntil = atom({ plugin: 'game-hud', key: 'slowUntil' } as const, 0)
const costSamples = atom({ plugin: 'game-hud', key: 'costSamples' } as const, [])

const RAID = 'raid-frames'
const RAID_TITLE = '⚔ Raid Frames'

const ACTIVE = ['pending', 'running', 'waiting']
const LIMIT_NAMES: Record<string, string> = { five_hour: '5H', seven_day: '7D', spend_limit: '$$' }
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86_400_000 }
const POISON_STREAK = 3
const POISON_SHOW_MS = 5 * 60_000
const SLOW_CALL_MS = 20_000
const SLOW_SHOW_MS = 10_000
const BURN_USD_PER_MIN = 0.5
const BURN_WINDOW_MS = 3 * 60_000
const BURN_STALE_MS = 60_000
// Tools that wait on the user or on other agents, not on themselves.
const NO_SLOW_TOOLS = ['Agent', 'Task', 'Workflow', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']
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

// Used vs. time elapsed in a rate-limit window: fast = burning stamina quicker than the clock refills it.
export const paceOf = (l: Limit, now: number): { kind: 'fast' | 'slow' | 'even'; elapsed: number } | undefined => {
  const span = WINDOW_MS[l.kind]
  if (!span || !l.resetsAt) return undefined
  const left = Date.parse(l.resetsAt) - now
  // A window that has already reset means the reading is stale.
  if (Number.isNaN(left) || left <= 0) return undefined
  const elapsed = Math.max(0, Math.min(100, 100 - (left / span) * 100))
  const delta = l.pct - elapsed
  return { kind: delta > 5 ? 'fast' : delta < -5 ? 'slow' : 'even', elapsed }
}

export type Outcome = 'ok' | 'error' | 'refused' | 'aborted'

// How a main-agent tool call ended. A hook's refusal or an interrupt is not a broken tool;
// a call that finished fine stays ok even if the signal aborted as it landed.
// (A permission "No" reaches us as a plain isError result, so it still counts as an error.)
export const outcomeOf = (ran: { isError?: boolean; deny?: unknown } | undefined, aborted: boolean): Outcome =>
  ran === undefined || ran.isError === true ? (aborted ? 'aborted' : 'error') : ran.deny !== undefined ? 'refused' : 'ok'

// Only errors build the streak; a success clears it; refusals and interrupts leave it be.
// A streak that went quiet for POISON_SHOW_MS starts over, so an old one can't re-arm on a single error.
export const nextStreak = (streak: number, outcome: Outcome, sinceError = 0) => {
  const base = sinceError > POISON_SHOW_MS ? 0 : streak
  return outcome === 'error' ? base + 1 : outcome === 'ok' ? 0 : base
}

export type Effect = { icon: string; label: string; color: string }

export const effectsOf = (o: { errStreak: number; errAt: number; slowUntil: number; burning: boolean; limits: Limit[]; now: number }): Effect[] => {
  const out: Effect[] = []
  if (o.errStreak >= POISON_STREAK && o.now - o.errAt <= POISON_SHOW_MS) out.push({ icon: '☠', label: 'POISONED', color: 'error' })
  if (o.slowUntil > o.now) out.push({ icon: '◔', label: 'SLOWED', color: 'warning' })
  if (o.burning) out.push({ icon: '✹', label: 'BURNING', color: 'warning' })
  if (o.limits.some(l => l.pct >= 90 && !(l.resetsAt && Date.parse(l.resetsAt) <= o.now))) out.push({ icon: '❄', label: 'FROZEN', color: 'suggestion' })
  return out
}

// Dollars per minute over the recent samples; undefined until they span half a minute.
export const burnRate = (samples: CostSample[]) => {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last || last.t - first.t < 30_000) return undefined
  return (last.usd - first.usd) / ((last.t - first.t) / 60_000)
}

// Burning only while the spend is recent: an idle session cools off.
export const isBurning = (samples: CostSample[], now: number) => {
  const last = samples[samples.length - 1]
  if (!last || now - last.t > BURN_STALE_MS) return false
  const rate = burnRate(samples)
  return rate !== undefined && rate >= BURN_USD_PER_MIN
}

const addSample = (samples: CostSample[], t: number, usd: number) =>
  [...samples, { t, usd }].filter(c => t - c.t <= BURN_WINDOW_MS)

let lastParty = ''
let warnedHp = false
const warnedLimits = new Set<string>()
let lastRoster = ''

// What a call is aimed at, in a few words: the file, the pattern, the command.
export const targetOf = (args: Record<string, unknown>) => {
  const pick = ['file_path', 'pattern', 'command', 'url', 'query', 'description', 'path']
  for (const k of pick) {
    const v = args[k]
    if (typeof v === 'string' && v) {
      const short = k === 'file_path' || k === 'path' ? v.split(/[\\/]/).slice(-2).join('/') : v
      return short.length > 48 ? `${short.slice(0, 47)}…` : short
    }
  }
  return ''
}

// Newest six agents, the running ones first; each keeps its last five calls.
export const mergeRoster = (frames: Frame[], members: Member[]): Frame[] => {
  const byId = new Map(frames.map(f => [f.member.id, f]))
  const merged = members.map(m => ({ ...(byId.get(m.id) ?? { calls: [], total: 0 }), member: m }))
  const live = merged.filter(f => ACTIVE.includes(f.member.status))
  const done = merged.filter(f => !ACTIVE.includes(f.member.status))
  return [...live, ...done.slice(-Math.max(0, 6 - live.length))].slice(0, 6)
}

export const recordCall = (frames: Frame[], agentId: string, call: Call): Frame[] =>
  frames.map(f => {
    if (f.member.id !== agentId) return f
    const has = f.calls.some(c => c.id === call.id)
    const calls = has ? f.calls.map(c => (c.id === call.id ? call : c)) : [...f.calls, call].slice(-5)
    return { ...f, calls, total: has ? f.total : f.total + 1 }
  })

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
  await update($, frame, f => (f + 1) % 2)
  const roster: Member[] = all.map(a => ({ id: a.id, type: a.type, description: a.description, status: a.status }))
  const rosterKey = JSON.stringify(roster)
  if (rosterKey !== lastRoster) {
    lastRoster = rosterKey
    await update($, raid, frames => mergeRoster(frames, roster))
  }
}

function alarms($: EngineInterface, s: Stats) {
  if (s.ctxPct !== undefined) {
    if (s.ctxPct >= 75 && !warnedHp) {
      warnedHp = true
      $.ui.toast(`☠ LOW HP! Context ${s.ctxPct}% full. Cast /compact to heal.`, { timeoutMs: 8000 })
    } else if (s.ctxPct < 65) {
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
    await update($, errStreak, () => 0)
    await update($, errAt, () => 0)
    await update($, slowUntil, () => 0)
    await update($, costSamples, () => [])
    await refreshParty($)
    $.clock.every(1000, () => void refreshParty($))
    await $.command.register({ name: 'raid', description: 'Open the Raid Frames pane: live tool calls of every agent' })

    return ran
  })

  on('session.measure', async ($, e, next) => {
    const s = toStats(e)
    await update($, stats, () => s)
    alarms($, s)
    if (s.usd !== undefined) {
      const usd = s.usd
      const t = await $.clock.now()
      await update($, costSamples, c => addSample(c, t, usd))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await refreshParty($)
    void $.ui.open({ id: RAID, title: RAID_TITLE })

    return spawned
  })

  on('tool.call', async ($, e, next) => {
    await update($, xp, n => n + 1)
    const agentId = e.agentId
    const call: Call = { id: e.tool_use_id, tool: e.tool, target: targetOf(e as Record<string, unknown>), state: 'run' }
    if (agentId) {
      await update($, raid, frames => recordCall(frames, agentId, call))
    }
    const started = await $.clock.now()
    let ran: Awaited<ReturnType<typeof next>> | undefined
    try {
      ran = await next(e)
    } finally {
      // Bookkeeping must never mask the tool's own result or error.
      try {
        const outcome = outcomeOf(ran, next.signal.aborted)
        if (agentId) {
          await update($, raid, frames => recordCall(frames, agentId, { ...call, state: outcome === 'ok' ? 'ok' : 'err' }))
        } else {
          const t = await $.clock.now()
          const since = t - (await read($, errAt))
          await update($, errStreak, n => nextStreak(n, outcome, since))
          if (outcome === 'error') {
            await update($, errAt, () => t)
          }
          if (outcome !== 'aborted' && t - started >= SLOW_CALL_MS && !NO_SLOW_TOOLS.includes(e.tool)) {
            await update($, slowUntil, () => t + SLOW_SHOW_MS)
          }
          const usd = (await $.session.usage()).cost?.usd
          if (usd !== undefined) {
            await update($, costSamples, c => addSample(c, t, usd))
          }
        }
      } catch (err) {
        $.ui.log(`game-hud: tool bookkeeping failed: ${String(err)}`, { to: 'debug' })
      }
    }

    return ran!
  })

  on('command.run', { command: 'raid' }, async $ => {
    await $.ui.open({ id: RAID, title: RAID_TITLE })

    return { text: 'Raid Frames opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: RAID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const frames = await read($, raid)
    const f = await read($, frame)

    if (frames.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No party yet. Agents appear here when they're summoned.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {frames.map((fr, i) => {
          const live = ACTIVE.includes(fr.member.status)
          const color = live ? 'claude' : fr.member.status === 'completed' ? 'success' : 'error'
          return (
            <Box key={fr.member.id} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={!live} paddingX={1}>
              <Text wrap="truncate">
                <Text color={color} bold>
                  {SPRITES[i % SPRITES.length]?.[live ? (f + i) % 2 : 0] ?? '☻'} {fr.member.type}
                </Text>
                <Text dimColor>
                  {' '}
                  [{fr.member.status}] {fr.member.description}
                </Text>
              </Text>
              {fr.calls.length === 0 && <Text dimColor>  …gearing up</Text>}
              {fr.calls.map(c => (
                <Text wrap="truncate" dimColor={!live}>
                  {c.state === 'run' ? <Text color="warning">⟳</Text> : c.state === 'ok' ? <Text color="success">✓</Text> : <Text color="error">✗</Text>}{' '}
                  <Text bold>{c.tool}</Text> <Text dimColor>{c.target}</Text>
                </Text>
              ))}
              <Text dimColor>
                {fr.total} action{fr.total === 1 ? '' : 's'}
                {fr.total > fr.calls.length ? ` (last ${fr.calls.length} shown)` : ''}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
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
    const streak = await read($, errStreak)
    const slow = await read($, slowUntil)
    const errTime = await read($, errAt)
    const samples = await read($, costSamples)
    const effects = effectsOf({ errStreak: streak, errAt: errTime, slowUntil: slow, burning: isBurning(samples, now), limits: s?.limits ?? [], now })

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
        <Text>
          <Text dimColor>resting at camp </Text>
          <Text color={f === 0 ? 'warning' : 'error'}>♨</Text>
        </Text>
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
          {effects.map(x => (
            <Text color={x.color}>
              {'  '}
              {x.icon}
              {cols >= 100 ? ` ${x.label}` : ''}
            </Text>
          ))}
        </Text>
        <Text wrap="truncate">
          <Text color="warning" bold>
            ◆ SP{'  '}
          </Text>
          {!s || s.limits.length === 0 ? (
            <Text dimColor>no rate-limit readings yet</Text>
          ) : (
            s.limits.map(l => {
              const pace = paceOf(l, now)
              return (
                <Text>
                  <Text dimColor>{LIMIT_NAMES[l.kind] ?? l.kind} </Text>
                  <Text color={tone(100 - l.pct)}>{bar(100 - l.pct, Math.max(4, Math.floor(w / 2)))}</Text>{' '}
                  {100 - l.pct}%
                  {pace && (
                    <Text color={pace.kind === 'fast' ? 'error' : pace.kind === 'slow' ? 'success' : undefined} dimColor={pace.kind === 'even'}>
                      {' '}
                      {pace.kind === 'fast' ? '▲' : pace.kind === 'slow' ? '▼' : '≈'}
                    </Text>
                  )}
                  <Text dimColor> ↻ {countdown(l.resetsAt, now)}</Text>
                  {'   '}
                </Text>
              )
            })
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
