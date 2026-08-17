<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (c) 2026 shibu003 -->

# Shenron MCP protocol

This directory is the boundary between Shenron and everything else, in both
directions. It is **Apache-2.0** while the rest of the hub is Elastic License
2.0 — see [`../../LICENSE_SCOPE.md`](../../LICENSE_SCOPE.md). Build a client, a
connector, or an independent implementation against this boundary and you owe
nothing back here.

## The two directions

```
   an AI (Claude Code / Codex / …)
             │  JSON-RPC 2.0 over stdio
             ▼
   server.mjs ──── tools.mjs (89 tool descriptors)
             │
       [ hub core — Elastic License 2.0 ]
             │
   mcp-client.mjs
             │  JSON-RPC 2.0 over stdio or HTTP
             ▼
   some other MCP server (GitHub, Slack, …)
```

| File | Direction | What it is |
|---|---|---|
| `tools.mjs` | inbound | Single source of truth for tool descriptors — name, description, input schema. Adding a capability means adding it here. |
| `server.mjs` | inbound | Serves those descriptors over stdio JSON-RPC and dispatches calls into the hub. |
| `mcp-client.mjs` | outbound | Minimal zero-dependency MCP client. Lets the executor actually call another server's tool, riding that server's own auth. |
| `echo-mcp-server.mjs` | test | Reference server the contract tests run against. |

## Tool surface

89 tools. The verb prefix tells you the shape:

| Prefix | Count | Semantics |
|---|---:|---|
| `list_*` | 15 | enumerate, no side effects |
| `get_*` | 12 | fetch one by id, no side effects |
| `set_*` | 9 | mutate configuration |
| `run_*` | 5 | execute — may have side effects, may require approval |
| `search_*` | 4 | query by text |
| `delete_*` | 4 | remove |
| `approve_*` | 2 | advance an item past an approval gate |
| `gen_*` | 2 | generate an agent, component, or artifact |
| `export_*` | 2 | serialise state out |

Read the descriptors in `tools.mjs` for the authoritative list and schemas —
that file is the spec, this table is orientation.

## Rules a client can rely on

- **stdout is JSON-RPC only.** Diagnostics go to stderr. A stray `console.log`
  in a server corrupts the stream — this is the single most common integration
  bug.
- **Side-effecting work passes through a human checkpoint.** Runs move
  `submitted → awaiting_approval → approved → running → completed | failed |
  rejected` (A2A `TaskState`), and `approve_handoff` / `decline_handoff` are
  the tools that advance or stop one. Browser steps are additionally
  classified allow / ask / deny by `permissions.mjs`; `ask` pauses for a human.
  Discovery and read tools are not gated.
- **Credentials never cross this boundary.** `mcp-client.mjs` redacts anything
  matching `SECRET_RE` (`KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API|AUTH|COOKIE`)
  before a value can be logged or returned. Secrets live in the local vault and
  are referenced by id, never by value.
- **Zero dependencies.** Both server and client speak JSON-RPC 2.0 with nothing
  but the Node standard library. A conforming implementation needs no SDK.

## Contract tests

`echo-mcp-server.mjs` is the reference peer. Run the suite from the repo root:

```bash
node prototype/hub/test_all.mjs
```
