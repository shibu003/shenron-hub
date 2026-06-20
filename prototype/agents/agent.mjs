#!/usr/bin/env node
// agent.mjs — ONE generic A2A-shaped agent, configured per company (big-simple-part philosophy).
// Run twice with different configs to stand up two companies' agents, then wire.mjs connects them.
//
//   A2A_SHARED_TOKEN=... node prototype/agents/agent.mjs --config prototype/agents/sales.json [--dev]
//
// A2A-shaped: GET /.well-known/agent-card.json + JSON-RPC message/send + bearer. Swap to a2a-sdk later.
// Unattended on purpose (this demo is about WIRING agents into a workflow). Real cross-company would add
// the trust gate + attended approval (docs/09 M5). reviewer/vendor: codex | claude | stub (offline fallback).

import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runVendor } from '../runner.mjs';

const cfgPath = (() => { const i = process.argv.indexOf('--config'); return i > -1 ? process.argv[i + 1] : null; })();
if (!cfgPath) { console.error('✗ --config <file> required'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const DEV = process.argv.includes('--dev');
const TOKEN = process.env.A2A_SHARED_TOKEN || (DEV ? 'dev-token' : null);
if (!TOKEN) { console.error('✗ A2A_SHARED_TOKEN required (or pass --dev for the insecure dev-token)'); process.exit(1); }
const PORT = cfg.port;
const PUBLIC_URL = cfg.publicUrl || `http://localhost:${PORT}`;

const card = () => ({
  name: cfg.name,
  description: `${cfg.company}: ${cfg.skill.description}`,
  protocolVersion: '0.3', version: '0.1.0', url: PUBLIC_URL, preferredTransport: 'JSONRPC',
  provider: { organization: cfg.company },
  capabilities: { streaming: false },
  defaultInputModes: ['text'], defaultOutputModes: ['text'],
  securitySchemes: { shared: { type: 'http', scheme: 'bearer' } }, security: [{ shared: [] }],
  skills: [{ id: cfg.skill.id, name: cfg.skill.name, description: cfg.skill.description,
             tags: cfg.skill.tags || [], inputModes: ['text'], outputModes: ['text'] }],
});

function run(input) {
  const prompt = `${cfg.skill.systemPrompt}\n\n--- INPUT ---\n${input}\n--- END INPUT ---`;
  return runVendor(cfg.skill.vendor, prompt, stub(input));   // shared spawn (codex|claude|stub) — runner.mjs
}
const stub = () => cfg.skill.stub || `[stub:${cfg.name}] (no vendor / offline)`;

const rpcOk = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
const textMsg = (text, status) => ({ kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text }], metadata: { status } });

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(card(), null, 2));
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST / (JSON-RPC) or GET the agent card'); }
  let body = ''; req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let rpc; try { rpc = JSON.parse(body); } catch { res.writeHead(400); return res.end(rpcErr(null, -32700, 'parse error')); }
    const id = rpc.id ?? null;
    const reply = (code, p) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(p); };
    if ((req.headers['authorization'] || '') !== `Bearer ${TOKEN}`) return reply(401, rpcErr(id, -32001, 'unauthorized'));
    if (rpc.method !== 'message/send') return reply(404, rpcErr(id, -32601, `method not found: ${rpc.method}`));
    // input = the message text part; accept {input:"..."} JSON or raw text
    const raw = (rpc.params?.message?.parts || []).find((p) => p.kind === 'text')?.text || '';
    let input = raw; try { const j = JSON.parse(raw); if (j && j.input != null) input = String(j.input); } catch {}
    console.log(`← ${cfg.skill.id}: input ${input.length}B, running ${cfg.skill.vendor}…`);
    const out = run(input);
    console.log(`→ ${cfg.skill.id}: returned ${out.length}B`);
    reply(200, rpcOk(id, textMsg(out, 'COMPLETED')));
  });
}).listen(PORT, () => {
  console.log(`[${cfg.company}] ${cfg.name} on ${PUBLIC_URL}  skill=${cfg.skill.id} vendor=${cfg.skill.vendor}`);
});
