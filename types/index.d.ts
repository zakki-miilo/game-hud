export type Limit = { kind: string; pct: number; resetsAt?: string }

export type Stats = {
  ctxPct?: number
  ctxTokens?: number
  ctxWindow: number
  limits: Limit[]
  usd?: number
}

export type Member = { id: string; type: string; description: string; status: string }

export type Call = { id: string; tool: string; target: string; state: 'run' | 'ok' | 'err' }

export type CostSample = { t: number; usd: number }

export type Frame = { member: Member; calls: Call[]; total: number }

declare module 'claude-code' {
  interface PluginState {
    'game-hud': {
      stats: Stats | null
      party: Member[]
      xp: number
      frame: number
      raid: Frame[]
      errStreak: number
      errAt: number
      slowUntil: number
      costSamples: CostSample[]
    }
  }
}
