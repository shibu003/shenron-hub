#!/usr/bin/env node
// fire.mjs — one-shot: fire ONE BuildHUD automation by id, THROUGH the MCP server (MCP-first).
// The external scheduler (Trigger.dev, prototype/mcp/trigger/) owns the cron; BuildHUD just exposes
// "fire this automation". Spawns server.mjs, calls run_automation(confirm:true), prints the result/trace.
//
//   A2A_SHARED_TOKEN=... node prototype/mcp/fire.mjs <automationId> [input]
//
// Exit: 0 = fired OK · 1 = tool error (e.g. token missing / agent unreachable) · 2 = bad usage.
// stdout = the run_automation result JSON (trace); the MCP server's own logs go to stderr.

import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const [, , id, input] = process.argv;
if (!id) { console.error('usage: fire.mjs <automationId> [input]'); process.exit(2); }

const server = spawn('node', [path.join(HERE, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });

const reqs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'run_automation', arguments: { id, ...(input != null ? { input } : {}), confirm: true } } },
];
server.stdin.write(reqs.map((r) => JSON.stringify(r)).join('\n') + '\n');

let buf = '';
let done = false;
const finish = (code) => { if (done) return; done = true; server.kill(); process.exit(code); };
server.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== 2) continue;                                  // wait for the run_automation reply
    process.stdout.write((m.result?.content?.[0]?.text ?? '') + '\n');
    finish(m.result?.isError ? 1 : 0);
  }
});
server.on('exit', (code) => finish(code ?? 0));
server.on('error', (e) => { console.error('fire: failed to spawn server —', e.message); finish(1); });
