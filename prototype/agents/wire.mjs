#!/usr/bin/env node
// wire.mjs — connect TWO companies' agents into one workflow (the "handoff" BuildHUD sells).
//   A社 linkedin-sales-agent (find-prospects)  →  B社 marketing-outreach-agent (draft-outreach)
//
//   A2A_SHARED_TOKEN=... node prototype/agents/wire.mjs ["<target brief>"]
//
// Each hop = A2A-shaped discover-card + message/send. Cross-company, cross-vendor (Codex → Claude),
// cross-machine when each URL is a tunnel. This is docs/09 M1 (handoff) + M2 (chain) over A2A.

import { randomUUID } from 'node:crypto';

const A_URL = (process.env.A_URL || 'http://localhost:8810').replace(/\/$/, '');   // A社 sales
const B_URL = (process.env.B_URL || 'http://localhost:8811').replace(/\/$/, '');   // B社 marketing
const DEV = process.argv.includes('--dev');
const TOKEN = process.env.A2A_SHARED_TOKEN || (DEV ? 'dev-token' : null);
if (!TOKEN) { console.error('✗ A2A_SHARED_TOKEN required (or --dev)'); process.exit(1); }

const PRODUCT = 'Product context: we sell an AI SDR tool that auto-researches prospects and books qualified meetings.';
const brief = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] ||
  'Target: Series-A B2B SaaS startups in fintech. ICP roles: VP Sales / Head of Growth / Sales Ops. ' + PRODUCT;

async function hop(url, skill, inputText) {
  // 1) discover the company's Agent Card
  const card = await (await fetch(`${url}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const s = (card.skills || []).find((x) => x.id === skill);
  if (!s) throw new Error(`${url}: no skill "${skill}"`);
  console.log(`\n▶ ${card.provider?.organization || card.name}  ·  skill=${skill}`);
  // 2) message/send
  const r = await fetch(`${url}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: randomUUID(), method: 'message/send',
      params: { message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: JSON.stringify({ input: inputText }) }] }, metadata: { skill } },
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${url} RPC ${j.error.code}: ${j.error.message}`);
  return (j.result?.parts || []).find((p) => p.kind === 'text')?.text || '';
}

(async () => {
  console.log('═'.repeat(64));
  console.log('  CROSS-COMPANY AGENT WORKFLOW  (A社 sales → B社 marketing)');
  console.log('═'.repeat(64));
  console.log(`\nBrief → A社:\n  ${brief}`);

  // Hop 1: A社 sales agent finds prospects
  const prospects = await hop(A_URL, 'find-prospects', brief);
  console.log(`\n── A社 prospects ──\n${prospects}`);

  // Hop 2: hand the prospects to B社 marketing agent for outreach
  const mInput = `${PRODUCT}\n\nProspects:\n${prospects}`;
  const outreach = await hop(B_URL, 'draft-outreach', mInput);
  console.log(`\n── B社 outreach (per prospect) ──\n${outreach}`);

  console.log('\n' + '═'.repeat(64));
  console.log('  ✓ two companies\' agents, wired into one workflow over A2A');
  console.log('═'.repeat(64));
})().catch((e) => { console.error('✗', e.message, '\n(are both agents running? see prototype/agents/README.md)'); process.exit(1); });
