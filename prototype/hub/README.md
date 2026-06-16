# prototype/hub — durable handoff inbox + drag-&-drop cockpit

Offline-tolerant cross-agent handoff: send work to an agent that's **offline**; the hub holds it (durable inbox) and delivers it on the agent's next poll, where it **auto-runs** or **waits for approval**. This is the piece A2A does **not** give us — A2A has `Task`/states/`pushNotificationConfig` but **no mailbox** (research-confirmed). Production durability later rides Trigger.dev waitpoints; this is the minimal zero-dep core.

## Pieces
- `hub.mjs` — zero-dep HTTP **broker**. Durable inbox (`inbox.json`, gitignored), A2A-aligned states (`submitted → awaiting_approval → approved → running → completed|failed|rejected`), per-agent **presence** (last poll) + **policy** (`approval` | `auto` | `autoFrom` allowlist). Serves the UI at `/`. Brokers only — never runs skills.
- `worker.mjs` — an agent's **pull-mode poller**: claims its approved handoffs, runs them via `../runner.mjs` (codex|claude|stub), posts results. Works offline→online.
- `ui.html` — the **cockpit** (served at `/`): agents as nodes with presence dots, **drag one onto another to hand off**, live status-colored links, approve/decline cards, per-agent approval⇄auto toggle.
- MCP tools (`../mcp/server.mjs`): `send_handoff`, `list_handoffs`, `get_handoff`, `poll_inbox`, `approve_handoff`, `decline_handoff`, `set_policy` — so an AI can drive the inbox too (MCP-first).

## Quickstart
```bash
cd /Users/you/GioGio
node prototype/hub/hub.mjs                       # → http://localhost:8795  (state: prototype/hub/inbox.json)
# open http://localhost:8795 — drag one agent onto another to send a handoff (works while it's offline)

# bring an agent ONLINE to act on its inbox (stub = instant; codex/claude = real LLM):
node prototype/hub/worker.mjs --config prototype/agents/marketing.json --vendor stub
# flip that agent to ⚡auto in the UI (or set_policy) → handoffs run on poll with no human gate.
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
