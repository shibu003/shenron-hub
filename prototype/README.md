# prototype — Persona C 1-handoff (MVP minimal)

Implements the minimal self-build set from `docs/09` for the `docs/07` dogfood:
**M1** cross-person handoff semantics · **M2** push→handoff trigger · **G3** inbound attended approval.
Trust is **faked** (shared bearer + repo allowlist + attended + `handoff.log`) — `docs/09 M5` real trust is North Star.

Zero dependencies (Node ≥ 18). A2A-**shaped** (Agent Card at `/.well-known/agent-card.json` + JSON-RPC `message/send` + bearer) so it swaps to the real `a2a-sdk` later (`docs/08 §1`).

```
reviewer-server.mjs  B host (friend): card + message/send + attended approve + reviewer (stub|codex|claude)
send.mjs     A host (founder): diff branch → discover card → message/send → print review
config.example.json   copy to config.json
hooks/pre-push.sample M2 trigger
```

## A. Smoke test on ONE machine (no friend, no tunnel, no agent CLI)

```bash
cp prototype/config.example.json prototype/config.json     # reviewer:"stub", autoApprove:false
export A2A_SHARED_TOKEN=$(openssl rand -hex 16)

# terminal 1 — B host:
A2A_SHARED_TOKEN=$A2A_SHARED_TOKEN node prototype/reviewer-server.mjs
# terminal 2 — A host (point at localhost):
A2A_SHARED_TOKEN=$A2A_SHARED_TOKEN B_URL=http://localhost:8787 node prototype/send.mjs main
```
Terminal 1 prompts `Approve? [y/N]`; type `y` → terminal 2 prints the review. `handoff.log` records the round-trip.

Hands-off test (CI-style): set `"autoApprove": true` in config to skip the prompt.

## B. Cross-vendor review (B uses Codex / Claude)

Edit `prototype/config.json` → `"reviewer": "codex"` (or `"claude"`), ensure that CLI is installed/authed on B.
B runs Codex with `--ask-for-approval never --sandbox read-only` — the human gate is BuildHUD's prompt, OUTSIDE codex (`docs/08 §5`).

## C. Two machines (real Persona C)

```bash
# B machine:
A2A_SHARED_TOKEN=<shared> node prototype/reviewer-server.mjs
cloudflared tunnel --url http://localhost:8787      # → https://xxxx.trycloudflare.com
#   put that URL in config.json "publicUrl" (so the card advertises it), restart server, share URL + token with A

# A machine (in the repo you want reviewed):
A2A_SHARED_TOKEN=<shared> B_URL=https://xxxx.trycloudflare.com node prototype/send.mjs <branch>
# or install hooks/pre-push.sample to fire automatically on push
```

## Fence (do NOT add here — `docs/07 §5`)
real auth (OBO/DPoP) · multi-tenant · billing · arbitrary connections · unattended chains · auto-merge · multiple skills.
The reviewer **returns a review (or a `REJECTED` decline) — never writes/merges**.
A shared token is **required**: set `A2A_SHARED_TOKEN`, or pass `--dev` to both reviewer-server.mjs and send.mjs for the insecure `dev-token` (localhost only).

## Success = `docs/07 §6`
friend+repo+task named · a real A2A round-trip happened · both say "again" · `handoff.log` has the trace.
