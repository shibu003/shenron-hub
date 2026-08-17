#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 shibu003
// echo-mcp-server.mjs — a tiny zero-dep MCP server (stdio) used to VERIFY Wave G end-to-end without any
// external credentials. Its tools perform a real, observable side-effect: they APPEND the message to
// prototype/mcp/.echo-outbox.log (gitignored) and return a confirmation. So "agent → mcp node → Run →
// real send" can be proven with a real JSON-RPC round-trip — a real Gmail/Slack server is bring-your-own
// (its own command + OAuth; philosophy #1: adopt, don't build authz), this stands in for the demo.
//
// Speaks newline-delimited JSON-RPC 2.0 on stdio (MCP stdio transport). Logs nothing to stdout but JSON-RPC.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUTBOX = path.join(HERE, '.echo-outbox.log');

const TOOLS = [
  { name: 'send_email', description: 'Pretend to send an email; appends it to the outbox.',
    inputSchema: { type: 'object', properties: { input: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' } } } },
  { name: 'post_message', description: 'Pretend to post a chat message; appends it to the outbox.',
    inputSchema: { type: 'object', properties: { input: { type: 'string' }, channel: { type: 'string' } } } },
];

function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `no tool "${name}"` }] };
  const line = JSON.stringify({ ts: new Date().toISOString(), tool: name, args });
  fs.appendFileSync(OUTBOX, line + '\n');                    // the real side-effect
  const who = args.to || args.channel || '(echo)';
  const text = `✓ ${name} → ${who}: ${String(args.input ?? '').slice(0, 200)}`;
  return { content: [{ type: 'text', text }] };
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'echo-mcp', version: '0.1' } } };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') return { jsonrpc: '2.0', id, result: callTool(params?.name, params?.arguments) };
  if (method && method.startsWith('notifications/')) return null;   // notifications get no reply
  if (id != null) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  return null;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const out = handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
