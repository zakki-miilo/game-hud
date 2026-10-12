export type Limit = { kind: string; pct: number; resetsAt?: string }

export type Stats = {
  ctxPct?: number
  ctxTokens?: number
  ctxWindow: number
  limits: Limit[]
  usd?: number
}

export type Member = { id: string; type: string; description: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'game-hud': { stats: Stats | null; party: Member[]; xp: number; frame: number }
  }
}
