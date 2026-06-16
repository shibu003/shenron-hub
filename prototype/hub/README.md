# prototype/hub — durable handoff inbox + drag-&-drop cockpit

Offline-tolerant cross-agent handoff: send work to an agent that's **offline**; the hub holds it (durable inbox) and delivers it on the agent's next poll, where it **auto-runs** or **waits for approval**. This is the piece A2A does **not** give us — A2A has `Task`/states/`pushNotificationConfig` but **no mailbox** (research-confirmed). Production durability later rides Trigger.dev waitpoints; this is the minimal zero-dep core.

## Pieces
- `hub.mjs` — zero-dep HTTP **broker + local executor**. Durable inbox (`inbox.json`, gitignored), A2A-aligned states (`submitted → awaiting_approval → approved → running → completed|failed|rejected`), per-agent **presence** (last poll) + **policy** (`approval` | `auto` | `autoFrom` allowlist). Serves the UI at `/`. **LOCAL agents** (config in `../agents/*.json`) run **in-process in the hub itself — no worker.mjs needed**; **REMOTE/cross-company** agents stay broker-only (their own runtime runs them, durable inbox holds until they poll). `--vendor stub|codex|claude` forces the local-exec vendor.
- `worker.mjs` — a **remote** agent's **pull-mode poller**: claims its approved handoffs, runs them via `../runner.mjs` (codex|claude|stub), posts results. Works offline→online. (Local agents no longer need this — the hub runs them.)
- `ui.html` — the **cockpit** (served at `/`): a guided flow-builder with a left palette, labeled **IN/OUT ports**, a one-click example flow, status-colored links, approve/decline cards, and per-agent approval⇄auto controls.
- MCP tools (`../mcp/server.mjs`): `send_handoff`, `list_handoffs`, `get_handoff`, `poll_inbox`, `approve_handoff`, `decline_handoff`, `set_policy` — so an AI can drive the inbox too (MCP-first).

## Quickstart
```bash
cd /Users/you/GioGio
node prototype/hub/hub.mjs --vendor stub         # → http://localhost:8795  (--vendor stub = instant local exec; omit for real LLM)
# open http://localhost:8795 — click "正解例を配置" or wire a node's right OUT port to the next node's left IN port, then ▶ Run.
# LOCAL agents (sales/marketing) run IN THE HUB — flip to ⚡auto → submit→running→completed with NO worker.
# (approval fence still applies: ✋approval holds at awaiting_approval until you approve in the UI.)

# only REMOTE agents (no local config) need their own poller to act on the inbox:
node prototype/hub/worker.mjs --config prototype/agents/marketing.json --vendor stub
```
Default port is **8795** (8790 may be taken by a local app). Override with `--port`.

## States & policy
- `submitted` → recipient hasn't polled. **Held durably even if offline.**
- on poll: `auto` (or sender in `autoFrom`) → `approved`→`running`→`completed`; else → `awaiting_approval` (human approve in the UI → `approved` → runs next poll).
- presence = polled within ~12s. `running` with no result = worker still executing (or crashed — no requeue yet; see roadmap).

## Roadmap (ride, don't build)
- **Durability**: ride Trigger.dev **waitpoint tokens** (`wait.createToken`/`forToken`/`completeToken`) or Hatchet durable event waits for retry/timeout/at-least-once — instead of the in-memory poll loop.
- **Push**: A2A `pushNotificationConfig` webhook to *wake* an agent (vs pull-poll), where reachable.
- **UI**: React Flow upgrade (docs G2) for richer canvas; the vanilla DnD here keeps the prototype zero-dep.
- **Requeue/lease**: time out `running` handoffs back to `approved` if a worker dies mid-run.

Related: `../../docs/08_OSS_PARTS.md` §1.5 (G1/G2) · `../mcp/README.md` (MCP control plane) · `../README.md` (sync 1-handoff).
