# Licence scope

This repository is not covered by a single licence. The control plane and the
interfaces other software connects through are licensed differently.

## 1. Core — Elastic License 2.0

Everything not listed under §2 below, including:

```
bin/                     entry point
prototype/hub/           hub, executor, vault, state, auth, UI
prototype/agents/        agent workers
prototype/templates/     workflow templates
prototype/*.mjs          runner, permissions, trust, matching, receipts
scripts/
```

Full text: [`LICENSE`](LICENSE) (also [`LICENSES/Elastic-2.0.txt`](LICENSES/Elastic-2.0.txt)).

You may use, copy, modify and redistribute the core. You may **not** provide it
to third parties as a hosted or managed service that gives users access to a
substantial set of its features, and you may not remove or obscure licensing,
copyright or trademark notices.

Self-hosting Shenron for yourself, your machine, or your own team is exactly
what it is for and is unrestricted. The restriction exists because a managed
Shenron is how this project is funded — see `hub.shibubu.ai`.

## 2. Connection surface — Apache License 2.0

```
prototype/mcp/server.mjs           MCP server: how an AI operates Shenron
prototype/mcp/mcp-client.mjs       MCP client: how Shenron calls other servers
prototype/mcp/echo-mcp-server.mjs  reference server used by the contract tests
prototype/mcp/tools.mjs            tool descriptors exposed over MCP
```

Full text: [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

These files define the protocol boundary in both directions — what an agent
sends to Shenron, and what Shenron sends to an MCP server. Anyone writing a
connector, a client, or an independent implementation against this boundary
should carry no obligation back to us. Apache-2.0 also grants an explicit
patent licence, which matters for an interface other people build on.

Files under §2 carry an `SPDX-License-Identifier: Apache-2.0` header.

## 3. Not in this repository

The managed service (multi-tenant hosting, organisation management, centralised
policy, billing, support) is not part of this repository and is not licensed by
it.

## Trademarks

The licences above cover code. They do not grant rights to the **Shenron** or
**神龍** name, logo, or the right to describe a fork as official.

## Commercial licensing

The copyright is held in full by the author, so terms other than Elastic
License 2.0 can be granted. Open an issue if you need one.

## History

Versions up to and including the last MIT-licensed release remain available
under MIT; that grant cannot be and is not withdrawn. This scope applies from
the relicensing commit forward.
