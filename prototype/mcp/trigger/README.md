# prototype/mcp/trigger — schedule trigger rides Trigger.dev (adopt, don't build)

BuildHUD does **not** ship its own cron scheduler. An automation's `schedule` trigger (`automations.json`, `trigger.type === "schedule"`) is run by **Trigger.dev v3 declarative schedules** (`docs/08 §1.5` G1, philosophy #1 「接続では戦わない、乗る」). BuildHUD owns *what runs*; Trigger.dev owns *when*.

```
automations.json ──gen-trigger.mjs──▶ buildhud.schedules.ts ──trigger.dev dev/deploy──▶ cron in Trigger.dev
   (single source)     (zero-dep)        schedules.task()           (sync)                     │
                                                                                      run() ────┘
                                                                                        │
                                                  node ../fire.mjs <id> ◀───────────────┘
                                                        │  (MCP-first: one-shot client)
                                                        ▼
                                          server.mjs · run_automation(confirm:true) → A2A handoffs
```

## Files
- `gen-trigger.mjs` — **zero-dep generator**. Reads `../automations.json`, emits one declarative `schedules.task()` per **enabled `schedule`** automation. `build_state` automations are skipped (those fire via `fire_event` from CI, not cron).
- `buildhud.schedules.ts` — **generated** (`// DO NOT EDIT`). The Trigger.dev task file. Needs `@trigger.dev/sdk`.

## Adopt it (in your Trigger.dev project)
1. `npx trigger.dev@latest init` in a project (creates `trigger.config.ts`, sets `dirs: ["./trigger"]`).
2. Regenerate after any schedule change, then copy the output into your `/trigger` dir:
   ```bash
   node prototype/mcp/trigger/gen-trigger.mjs    # writes buildhud.schedules.ts
   ```
3. `npx trigger.dev@latest dev` (or `deploy`) — **declarative schedules sync on dev/deploy** (you cannot edit them in the dashboard; the code is the source).
4. Ensure `A2A_SHARED_TOKEN` is in the worker env and the BuildHUD **agents are running and reachable** from the worker.

## Caveats (honest)
- ⚠️ **Trigger.dev Cloud cannot reach `localhost` agents.** Run a **self-hosted** Trigger.dev / `dev` worker on the machine where the agents (and `fire.mjs`) live, or expose the agents. The generated `FIRE` path is **absolute and machine-specific** (baked at gen time) — regenerate per host.
- Cron is **UTC** by default. For a timezone, change the emitted `cron` to `{ pattern, timezone }` (e.g. `"Asia/Tokyo"`) — or extend `gen-trigger.mjs` to read a `tz` field off the automation's trigger.
- The fence still holds: `fire.mjs` calls `run_automation(confirm:true)`, and execution requires `A2A_SHARED_TOKEN` (no token → refuses without touching the network). Disabled automations are not emitted.
- ⚠️ **`enabled:false` is not a live kill-switch for already-synced schedules.** Declarative schedules only change on `trigger.dev dev|deploy`. Setting `enabled:false` in `automations.json` stops *future* generated output, but a previously-synced cron keeps firing until you **regenerate and redeploy** (or delete the schedule in Trigger.dev). The "single source of truth" holds only after a sync.
- `buildhud.schedules.ts` is **gitignored** (machine-specific baked path). Regenerate per host; override the path at runtime with `BUILDHUD_FIRE=/abs/path/to/fire.mjs`.

## Why this shape
- **Single source of truth**: schedules are derived from `automations.json`, not hand-maintained in two places.
- **MCP-first**: the scheduled task fires through the MCP server (`run_automation`), not a side channel — same brain, same fence.
- **Adopt, not build**: no bespoke cron/at-least-once/retry/observability — that's Trigger.dev's job (`docs/09 §2.5`).

Related: `../README.md` (MCP server + automations) · `../../../docs/08_OSS_PARTS.md` §1.5 (G1) · `../../../docs/10_MCP_INTERFACE.md`.
