# Licence scope

## Code — Apache License 2.0

The whole repository, including:

```
bin/                     entry point
prototype/hub/           hub, executor, vault, state, auth, UI
prototype/agents/        agent workers
prototype/mcp/           MCP server and client — the protocol boundary
prototype/templates/     workflow templates
prototype/*.mjs          runner, permissions, trust, matching, receipts
scripts/
```

Full text: [`LICENSE`](LICENSE) (also [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)).

Apache-2.0 is permissive: use it, modify it, ship it in a commercial product,
host it as a service. The only obligations are to keep the notices and to state
what you changed. It also carries an explicit patent grant, which matters
because connectors and independent implementations are meant to be built
against this code.

Files under `prototype/mcp/` carry an `SPDX-License-Identifier: Apache-2.0`
header and are documented in [`prototype/mcp/PROTOCOL.md`](prototype/mcp/PROTOCOL.md).
That directory is the protocol boundary in both directions — what an agent
sends to Shenron, and what Shenron sends to an MCP server.

## Not in this repository

This is a public mirror of the hub running at `hub.shibubu.ai`. The hosted
service around it — multi-tenant hosting, organisation management, centralised
policy, billing, support — is not part of this repository and is not licensed
by it.

## Trademarks

Apache-2.0 covers code. It does not grant rights to the **Shenron** or **神龍**
name, logo, or the right to describe a fork as official.

## Contributing

Contributions require a sign-off — see [`CLA.md`](CLA.md). It keeps the project
able to change how it is distributed in future while guaranteeing that every
released open-source version stays open source.

## History

Releases up to and including the last MIT version remain available under MIT.
There was also a brief period on Elastic License 2.0 (2026-08-17); that has
been reverted and no release shipped under it.
