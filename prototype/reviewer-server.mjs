#!/usr/bin/env node
// reviewer-server.mjs — B host (friend's machine). A2A-SHAPED, zero-dependency.
// (Named to disambiguate from the MCP control plane at prototype/mcp/server.mjs — two same-named
//  "server.mjs" files confused even a cross-vendor reviewer; see the Codex #1 false positive.)
// Implements the Persona C 1-handoff receiver (docs/07, docs/09 M1+G3):
//   - GET  /.well-known/agent-card.json   → Agent Card (skill: review-branch, bearer)
//   - POST /                              → JSON-RPC message/send → attended approve → review → return
//
// Trust is FAKED (docs/06 GATE-2, docs/09 M5): shared bearer token + repo allowlist + attended + audit log.
// This is A2A-shaped (agent-card.json + message/send) so it can be swapped for the real `a2a-sdk` later.
// NOT built: real auth (OBO/DPoP), unattended chains, multi-skill. Keep the fence (docs/07 §5).
//
//   A2A_SHARED_TOKEN=... node prototype/reviewer-server.mjs [--config prototype/config.json]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { runVendor } from './runner.mjs';

// ---------- config ----------
const cfgArg = (() => { const i = process.argv.indexOf('--config'); return i > -1 ? process.argv[i + 1] : null; })();
const cfgPath = cfgArg || path.join(process.cwd(), 'prototype', 'config.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const PORT = cfg.port || 8787;
const PUBLIC_URL = cfg.publicUrl || `http://localhost:${PORT}`;
const REPO_ALLOWLIST = cfg.repoAllowlist || [];
const REVIEWER = cfg.reviewer || 'stub';            // 'stub' | 'codex' | 'claude'
const AUTO_APPROVE = !!cfg.autoApprove;             // testing only — bypasses the attended gate
// audit log is configurable so an isolated dry-run doesn't contaminate the real handoff.log evidence (Codex)
const AUDIT_LOG = cfg.auditLog ? path.resolve(cfg.auditLog) : path.join(process.cwd(), 'prototype', 'handoff.log');

// Trust gate: require a shared token. Refuse to start without one unless --dev (Codex review #1).
const DEV = process.argv.includes('--dev');
const TOKEN = process.env.A2A_SHARED_TOKEN || (DEV ? 'dev-token' : null);
if (!TOKEN) {
  console.error('✗ A2A_SHARED_TOKEN is required.');
  console.error('  export A2A_SHARED_TOKEN=$(openssl rand -hex 16)   # recommended');
  console.error('  …or pass --dev to use the insecure "dev-token" (localhost smoke test only).');
  process.exit(1);
}
if (DEV && !process.env.A2A_SHARED_TOKEN) console.warn('⚠ --dev: insecure "dev-token" — localhost smoke only, never tunnel this');
if (AUTO_APPROVE) console.warn('⚠ autoApprove=true — attended gate BYPASSED (testing only)');

// ---------- Agent Card (A2A-shaped) ----------
const agentCard = () => ({
  name: 'friend-coding-reviewer',
  description: 'Reviews a git branch diff (attended, read-only). Persona C dogfood.',
  protocolVersion: '0.3',
  version: '0.1.0',
  url: PUBLIC_URL,
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: false },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  securitySchemes: { shared: { type: 'http', scheme: 'bearer' } },
  security: [{ shared: [] }],
  skills: [{
    id: 'review-branch',
    name: 'Review a branch',
    description: 'Given {repo, branch, diff}, return a concise code review. Returns review only — never writes.',
    tags: ['review', 'code'], inputModes: ['text'], outputModes: ['text'],
  }],
});

// ---------- attended approval (G3): serialized stdin prompt ----------
let promptChain = Promise.resolve();
function askApprove(summary) {
  if (AUTO_APPROVE) return Promise.resolve(true);
  const run = () => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n── INBOUND HANDOFF ──\n${summary}\nApprove? [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
  const result = promptChain.then(run);
  promptChain = result.catch(() => {});            // keep the chain alive on error
  return result;
}

// ---------- reviewer (Agent Runner): stub | codex | claude ----------
function runReviewer(payload) {
  const { repo, branch, diff = '' } = payload;
  const prompt =
    `You are reviewing a code change. Repo: ${repo}, branch: ${branch}.\n` +
    `List concrete bugs, risks, and concerns concisely. Do not rewrite the code.\n\n` +
    `--- DIFF ---\n${diff}\n--- END DIFF ---`;

  return runVendor(REVIEWER, prompt, stubReview(payload));   // shared spawn (codex|claude|stub) — runner.mjs
}

// Deterministic offline reviewer so the dogfood runs without any agent CLI.
function stubReview({ branch, diff = '' }) {
  const lines = diff.split('\n');
  const files = lines.filter((l) => l.startsWith('diff --git')).length || lines.filter((l) => l.startsWith('+++ ')).length;
  const adds = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const dels = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  const flags = [];
  if (/\bTODO\b|\bFIXME\b/.test(diff)) flags.push('contains TODO/FIXME');
  if (adds + dels > 400) flags.push('large diff (>400 changed lines) — consider splitting');
  if (/console\.log|print\(|debugger/.test(diff)) flags.push('possible leftover debug output');
  if (/password|secret|api[_-]?key|token/i.test(diff)) flags.push('⚠ possible secret/credential in diff');
  return [
    `[stub reviewer] branch=${branch}`,
    `files≈${files}, +${adds}/-${dels}`,
    flags.length ? `flags: ${flags.join('; ')}` : 'flags: none obvious',
    `(set "reviewer":"codex" in config + run Codex to get a real cross-vendor review)`,
  ].join('\n');
}

// ---------- audit (seed of M5 trust chain) ----------
function audit(entry) {
  try { fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
  // NOTE: do NOT log the full diff (docs/04 R4 / docs/07 §8). Path/summary only.
}

// ---------- JSON-RPC helpers ----------
const rpcOk = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
const textMsg = (text, status) => ({
  kind: 'message', role: 'agent', messageId: randomUUID(),
  parts: [{ kind: 'text', text }], metadata: { status },
});

// ---------- server ----------
const server = http.createServer((req, res) => {
  // Agent Card discovery
  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(agentCard(), null, 2));
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end('use POST / (JSON-RPC) or GET the agent card'); }

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
  req.on('end', async () => {
    let rpc;
    try { rpc = JSON.parse(body); } catch { res.writeHead(400); return res.end(rpcErr(null, -32700, 'parse error')); }
    const id = rpc.id ?? null;
    const reply = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(payload); };

    // trust gate (FAKE): bearer
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${TOKEN}`) { audit({ actor: 'B', action: 'rejected_auth' }); return reply(401, rpcErr(id, -32001, 'unauthorized')); }

    if (rpc.method !== 'message/send') return reply(404, rpcErr(id, -32601, `method not found: ${rpc.method}`));

    // extract handoff payload from the A2A message text part (docs/09 M1 semantics on A2A transport)
    let payload;
    try {
      const text = (rpc.params?.message?.parts || []).find((p) => p.kind === 'text')?.text;
      payload = JSON.parse(text);
    } catch { return reply(400, rpcErr(id, -32602, 'invalid params: message.parts[text] must be handoff JSON')); }

    const { repo, branch, from } = payload;
    // trust gate (FAKE): repo allowlist
    if (REPO_ALLOWLIST.length && !REPO_ALLOWLIST.includes(repo)) {
      audit({ actor: 'B', action: 'rejected_repo', repo, from });
      return reply(200, rpcOk(id, textMsg(`declined: repo "${repo}" not in allowlist`, 'REJECTED')));
    }

    // attended gate (G3)
    const summary = `from: ${from || 'unknown'}\nrepo: ${repo}\nbranch: ${branch}\nskill: review-branch\ndiff: ${(payload.diff || '').length} bytes`;
    audit({ actor: 'B', action: 'received', repo, branch, from });
    const approved = await askApprove(summary);
    if (!approved) {
      audit({ actor: 'B', action: 'declined', repo, branch, from });
      console.log('→ declined\n');
      return reply(200, rpcOk(id, textMsg('declined by reviewer', 'REJECTED')));
    }

    // run reviewer (returns review only — never writes)
    console.log(`→ approved, running ${REVIEWER} reviewer…`);
    const review = runReviewer(payload);
    audit({ actor: 'B', action: 'returned', repo, branch, from, reviewer: REVIEWER, reviewChars: review.length });
    console.log('→ review returned\n');
    return reply(200, rpcOk(id, textMsg(review, 'COMPLETED')));
  });
});

server.listen(PORT, () => {
  console.log(`B host (A2A-shaped) listening on ${PUBLIC_URL}`);
  console.log(`  card:   ${PUBLIC_URL}/.well-known/agent-card.json`);
  console.log(`  reviewer: ${REVIEWER}   allowlist: ${REPO_ALLOWLIST.join(', ') || '(none → all allowed)'}`);
  console.log(`  waiting for handoffs… (Ctrl-C to stop)`);
});
