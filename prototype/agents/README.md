# prototype/agents — connect two companies' agents

Demo of the core BuildHUD thesis: **wire other people's / other companies' agents into one workflow.**
Use case: **A社 LinkedIn sales agent → B社 marketing agent.**

- `agent.mjs` — ONE generic A2A-shaped agent (big-simple-part). Configured per company.
- `sales.json` — A社 / Acme Outbound · skill `find-prospects` · vendor **codex**
- `marketing.json` — B社 / Globex Creative · skill `draft-outreach` · vendor **claude**
- `wire.mjs` — the connector: A社 finds prospects → hands off to B社 → drafts outreach.

Cross-**company**, cross-**vendor** (Codex → Claude), and cross-**machine** when each URL is a tunnel.
Each agent falls back to a built-in `stub` if its CLI is unavailable, so the demo always runs.

## Run (localhost)

```bash
export A2A_SHARED_TOKEN=$(openssl rand -hex 16)      # or pass --dev to all three for an insecure dev token

# terminal 1 — A社 sales agent:
A2A_SHARED_TOKEN=$A2A_SHARED_TOKEN node prototype/agents/agent.mjs --config prototype/agents/sales.json
# terminal 2 — B社 marketing agent:
A2A_SHARED_TOKEN=$A2A_SHARED_TOKEN node prototype/agents/agent.mjs --config prototype/agents/marketing.json
# terminal 3 — wire them:
A2A_SHARED_TOKEN=$A2A_SHARED_TOKEN node prototype/agents/wire.mjs
#   optional: node prototype/agents/wire.mjs "Target: dev-tools startups, ICP = Head of DevRel ..."
```

## Cross-machine (real "other company")
Each company runs its own `agent.mjs` + `cloudflared tunnel --url http://localhost:<port>`, puts the tunnel URL in
its config `publicUrl`, and shares URL + token. Then: `A_URL=<A tunnel> B_URL=<B tunnel> node wire.mjs`.

## Fence / what this is NOT (docs/09)
This demo runs **unattended** to show the WIRING. A real cross-company handoff needs the trust layer (M5):
per-company identity, scoped permission, attended approval, audit — faked/absent here. Don't ship as-is.
