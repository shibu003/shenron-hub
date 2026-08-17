# Generated output policy

Shenron writes code. `gen_component` generates a standalone MCP server when no
existing tool covers a step; `gen_artifact_ui` generates a React component for a
flow step. This document says who owns the result.

## The rule

**Output that Shenron generates for you is yours.**

It is not licensed under Shenron's licence merely because Shenron produced it.
Running a tool over an input does not make the tool's licence attach to the
output — the same way a compiler's licence does not attach to the binary it
emits, or an editor's licence to the file you type in it.

You choose the licence for what you generate. You can keep it private, ship it
in a proprietary product, or publish it under any terms you like. Shenron
claims no rights in it and asks for no attribution.

The same applies to everything you put in: your prompts, your goals, your
workflow definitions, your `brief`, and the tool descriptors you register.

## The one exception

If generated output **contains code copied from this repository**, that copied
portion is still covered by this repository's licence (Apache-2.0 — permissive,
so in practice this costs you almost nothing: keep the notice).

This is why the generation path is built the way it is:

- **`prototype/templates/*.json` are workflow definitions, not code templates.**
  They describe steps, not implementation. Nothing from them is copied into a
  generated component.
- **`gen_component` generates from scratch.** It asks the configured coding
  agent (claude / codex) to write standard-library code for the described tool,
  then spawns it, handshakes, runs it, and repairs in a loop until it converges.
  The output is that agent's work against your spec — Shenron orchestrates the
  loop, it does not paste its own source into the result.
- **`gen_artifact_ui` generates a JSX component** that talks to the host through
  a small documented surface (`window.shenron.approve/decline/advance()`, fetch
  proxied via the hub). That surface is an interface, not a copied
  implementation.

**Rule for anyone changing the generator:** do not build generated output by
copying source out of this repository. If a generated artifact needs a runtime
shim, the shim goes in a separate file with an explicit permissive header, so
the boundary stays visible.

## Why this is written down

Shenron's whole premise is self-extension — it fills gaps by writing the missing
tool. That premise fails commercially if a user cannot tell whether the tool
they just generated is safe to ship. Ambiguity here is worse than any licence
choice, because it is discovered late, by a lawyer, after the tool is already in
production.

Today this repository is Apache-2.0, so even the exception above is mild. The
policy exists anyway, because the licence may change and the promise about
generated output should not.

## Not covered by this document

- **The coding agent you configure.** `gen_component` drives claude or codex.
  Whatever terms you have with that vendor govern what it produces — read them.
- **Third-party MCP servers** you connect. They keep their own licences.
- **Anything you generate that infringes someone else's rights.** This policy
  grants you Shenron's position; it cannot grant what Shenron does not hold.
