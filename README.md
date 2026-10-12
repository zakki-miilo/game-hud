# game-hud

A video-game HUD for Claude Code, drawn above the prompt:

```
╭──────────────────────────────────────────────────────────────╮
│ ⚔ CLAUDE QUEST  ★ LV 3 ▓▓▓▓░░░░░░  18/50 XP        ◎ $1.42   │
│ ♥ HP  ████████░░░░ 68%  64k/200k used                        │
│ ◆ SP  5H ████░░ 77% ↻ 2h14m   7D ███░░░ 59% ↻ 3d4h           │
│ ⚑ PARTY [2] ♞ Explore find auth code   ♜ critic review diff │
╰──────────────────────────────────────────────────────────────╯
```

- **♥ HP**: free context window. Toast at 75% used.
- **◆ SP**: rate-limit windows left (subscription plans), with reset countdowns. Toast at 90% used.
- **◎**: session cost so far.
- **★ LV / XP**: one XP per tool call, main agent and subagents.
- **⚑ PARTY**: subagents currently running, starting or waiting.

## Raid Frames

`/raid` opens a side pane with one card per agent (it also opens by itself when an agent is summoned):

```
╭───────────────────────────────────────╮
│ ♞ scout [running] find auth code      │
│ ✓ Grep auth                           │
│ ✓ Read src/auth.ts                    │
│ ⟳ Read src/login.ts                   │
│ 3 actions                             │
╰───────────────────────────────────────╯
```

The band collapses to one line when space is tight. Collapse it with `[-]` or ctrl+x ctrl+a.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install game-hud --marketplace zakki-miilo/game-hud
```

Answer `y` to add the marketplace, then press Enter for the user scope.

## Develop

```
claude plugin validate .
claude plugin test .
```
