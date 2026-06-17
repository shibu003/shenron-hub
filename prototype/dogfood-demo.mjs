#!/usr/bin/env node
// dogfood-demo.mjs — drive ONE per-field pass-drop run end-to-end and assert the trust chain holds:
// a passport `pass` allowlist (only `to`) → MCP send → the firewall PHYSICALLY drops subject+bcc →
// signed Trust Receipt carries the pass-drop → it verifies OFFLINE with the hub's pinned public key.
// This is the self-dogfood made repeatable + the e2e check the trust chain (firewall+pass+receipt+verify) lacked.
//
//   terminal 1:  node prototype/hub/hub.mjs --vendor stub --dev
//   terminal 2:  node prototype/dogfood-demo.mjs [port]        # default 8795
//
// Exits 0 = PASS, 1 = FAIL. Note: the FIRST MCP call is a cold `node` spawn + JSON-RPC handshake (~3-4s) —
// the send node sits in "running" until it completes; that's spawn latency, not a stall.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.argv[2] || 8795;
const B = `http://localhost:${PORT}`;
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(B + p).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error('❌ FAIL:', m); process.exit(1); };

// 1. upstream agent passport: default-deny the MCP config, allow ONLY `to` out
await post('/api/agents/dogfood-demo/passport', { caps: { external_send: 'approval' }, share: { pass: ['to'], never: [] } });

// 2. flow: input(tagged with that agent) → echo.send_email carrying to + subject + bcc
const run = await post('/api/runflow', {
  input: 'Q3 revenue was $4.2M, margin 38%',
  nodes: [
    { id: 'i1', kind: 'input', agent: 'dogfood-demo', config: { text: 'Q3 revenue was $4.2M, margin 38%' } },
    { id: 'm1', kind: 'mcp', server: 'echo', tool: 'send_email', config: { to: 'partner@acme.com', subject: 'Q3 numbers', bcc: 'leak@competitor.com' } },
  ],
  edges: [{ source: 'i1', target: 'm1' }],
});
const runId = run.runId || run.id;
if (!runId) die(`no runId from /api/runflow (${JSON.stringify(run)})`);

// 3. approve the gated send → applyPass drops subject+bcc at egress
await sleep(400);
let st = await get('/api/state');
const h = (st.handoffs || []).find((x) => x.runId === runId && x.status === 'awaiting_approval');
if (!h) die('no awaiting-approval send handoff (passport external_send denied? echo integration missing?)');
await post(`/api/handoffs/${h.id}/approve`, {});
for (let i = 0; i < 12; i++) { await sleep(1000); st = await get('/api/state'); const hh = (st.handoffs || []).find((x) => x.id === h.id); if (hh && hh.status !== 'running') break; if (i === 11) die('send never completed (>12s)'); }

// 4. assert: receipt carries the pass-drop with subject+bcc dropped
const rec = await get(`/api/receipt?runId=${runId}`);
const drop = (rec.entries || []).find((e) => e.type === 'pass-drop');
if (!drop) die(`receipt has no pass-drop entry (entries: ${(rec.entries || []).map((e) => e.type).join(',') || 'none'})`);
const dropped = (drop.dropped || []).slice().sort().join(',');
if (dropped !== 'bcc,subject') die(`expected subject+bcc dropped, got [${dropped}] allowlist [${drop.allowlist}]`);

// 5. assert: it verifies OFFLINE with the hub's pinned public key (the stronger-than-TOFU path)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dogfood-'));
fs.writeFileSync(path.join(tmp, 'receipt.json'), JSON.stringify(rec));
fs.writeFileSync(path.join(tmp, 'hub.pem'), await (await fetch(B + '/api/pubkey')).text());
try {
  execFileSync('node', [path.join(import.meta.dirname, 'verify-receipt.mjs'), path.join(tmp, 'receipt.json'), '--pubkey', path.join(tmp, 'hub.pem')], { stdio: 'ignore' });
} catch { die('offline receipt verification with pinned key returned non-zero'); }

console.log(`✅ PASS — run ${runId}: pass-drop dropped [${dropped}] (allowlist [${drop.allowlist}]); receipt verifies offline with pinned key.`);
console.log('   → the trust artifact a customer can check themselves, with no access to your hub.');
