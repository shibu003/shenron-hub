#!/usr/bin/env node
// send.mjs — A host (founder's machine). A2A-SHAPED client, zero-dependency.
// Persona C 1-handoff sender (docs/07, docs/09 M2 trigger + A2A client):
//   compute branch diff → discover B's Agent Card → message/send(review-branch) → print returned review.
//
//   A2A_SHARED_TOKEN=... B_URL=https://friend.example node prototype/send.mjs <branch> [base]
//
//   <branch>  branch to hand off for review (default: current branch)
//   [base]    diff base (default: origin/main, then main, then HEAD~1)
// Used as the M2 trigger: call it from a git pre-push hook (see hooks/pre-push.sample) or manually.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const B_URL = (process.env.B_URL || 'http://localhost:8787').replace(/\/$/, '');
// Trust gate: require a shared token unless --dev (Codex review #1).
const DEV = process.argv.includes('--dev');
const TOKEN = process.env.A2A_SHARED_TOKEN || (DEV ? 'dev-token' : null);
if (!TOKEN) { console.error('✗ A2A_SHARED_TOKEN required (or pass --dev for the insecure dev-token).'); process.exit(1); }
const MAX_DIFF = 200 * 1024;   // cap payload (docs/04 R4: minimize; real product sends a ref, not the body)

const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));   // positionals, ignoring flags like --dev
const cur = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim() || 'HEAD';
const branch = pos[0] || cur;

// pick a base that exists
function firstExistingRef(cands) {
  for (const r of cands) if (git(['rev-parse', '--verify', '--quiet', r]).status === 0) return r;
  return 'HEAD~1';
}
const base = pos[1] || firstExistingRef(['origin/main', 'origin/master', 'main', 'master', 'HEAD~1']);

// repo name: from origin url, else cwd basename
function repoName() {
  const url = git(['config', '--get', 'remote.origin.url']).stdout?.trim();
  const m = url && url.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return m[1];
  return spawnSync('basename', [process.cwd()], { encoding: 'utf8' }).stdout?.trim() || 'local';
}
const repo = process.env.REPO || repoName();

// compute diff
let diff = git(['diff', `${base}...${branch}`]).stdout || git(['diff', base, branch]).stdout || '';
if (!diff.trim()) { console.warn(`⚠ empty diff for ${base}...${branch} — sending a placeholder so the handoff still demos`); diff = `# (no diff between ${base} and ${branch})`; }
if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + `\n# …truncated at ${MAX_DIFF} bytes`;

async function jrpc(method, params) {
  const r = await fetch(`${B_URL}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`RPC ${j.error.code}: ${j.error.message}`);
  return j.result;
}

(async () => {
  // 1) discover B's Agent Card (A2A: /.well-known/agent-card.json)
  let card;
  try {
    card = await (await fetch(`${B_URL}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  } catch (e) { console.error(`✗ cannot reach B at ${B_URL} — is the server running / tunnel up?`); process.exit(1); }
  const skill = (card.skills || []).find((s) => s.id === 'review-branch');
  if (!skill) { console.error(`✗ B's agent "${card.name}" has no review-branch skill`); process.exit(1); }
  console.log(`→ handing off to ${card.name} (${B_URL})  repo=${repo} branch=${branch} base=${base}  diff=${diff.length}B`);

  // 2) message/send with the handoff payload (docs/09 M1 semantics carried in the A2A message text part)
  const payload = { repo, branch, base, from: process.env.USER || 'A', notes: '', diff };
  const result = await jrpc('message/send', {
    message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: JSON.stringify(payload) }] },
    metadata: { skill: 'review-branch' },
  });

  // 3) print the returned review
  const text = (result?.parts || []).find((p) => p.kind === 'text')?.text || '(no text)';
  const status = result?.metadata?.status || '?';
  console.log(`\n── REVIEW FROM FRIEND'S AGENT (${status}) ──\n${text}\n`);
  process.exit(status === 'COMPLETED' ? 0 : 2);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
