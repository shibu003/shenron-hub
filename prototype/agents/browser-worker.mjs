#!/usr/bin/env node
// browser-worker.mjs — Wave 11a: a STATEFUL computer-use worker (the concierge "手"). Unlike worker.mjs
// (one runVendor call per handoff), this holds ONE persistent Playwright-MCP browser session and drives it
// step-by-step, so a single handoff can open→read→click across steps without losing the page. The hub's `mcp`
// node is one-shot (fresh session per call) → structurally can't multi-step browse; this worker is the
// stateful seam that closes the "API 無し / UI のみ" branch of the decision tree (docs/13 §J).
//
//   node prototype/agents/browser-worker.mjs [--hub http://localhost:8795] [--pw "npx @playwright/mcp@latest"] [--once]
//
// Handoff input = JSON {steps:[{tool, args}]} where tool is a Playwright-MCP tool (browser_navigate,
// browser_snapshot, browser_take_screenshot, browser_click, browser_type, …). Each step is audited (redacted)
// to the hub; the joined step output is posted back as the handoff result.
//
// ponytail: 11a is SCRIPTED — policy:auto, no human loop. The always-human outbound checkpoint (ToS line:
// submit/送信 系は必ず人) is Wave 11b, a new intra-handoff hub primitive that needs its own design pass.

import { openStdio } from '../mcp/mcp-client.mjs';
import { redact } from '../trust.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const HUB = (argOf('--hub') || 'http://localhost:8795').replace(/\/$/, '');
// --isolated → fresh in-memory profile so we don't collide with the operator's own browser/profile lock.
// Wave 11b (persist the user's login as an asset) will swap this for a per-worker persistent profile dir.
const PW = argOf('--pw') || 'npx @playwright/mcp@latest --isolated';
const ONCE = process.argv.includes('--once');
const AGENT = 'browser-control', SKILL = 'browser-control';

async function api(p, body) {
  const r = await fetch(`${HUB}${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
}

// one warm browser session for the worker's life; respawn if it dies. ponytail: shared session = fast, but
// state bleeds across handoffs — fine for the single-service, human-in-loop scope (docs/13 §J Wave 11 risk).
let pw = null;
const browser = () => (pw ||= openStdio(PW, { timeoutMs: 60000 }));
const dropBrowser = () => { if (pw) { try { pw.close(); } catch {} pw = null; } };

const textOf = (r) => {
  const t = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return (t || `[${(r?.content || []).map((c) => c.type).join(',') || 'no'} content]`).slice(0, 2000);   // cap: screenshots return base64 — don't bloat the result/audit
};

async function runSteps(steps) {
  const client = browser();
  const log = [];
  for (let i = 0; i < steps.length; i++) {
    const { tool, args = {} } = steps[i];
    if (!tool) throw new Error(`step ${i}: missing tool`);
    await api('/api/audit', { type: 'browser-action', detail: { agent: AGENT, step: i, tool, args: redact(JSON.stringify(args), {}).text.slice(0, 500) } });   // redact → secrets/PII never hit the audit log; cap → a huge browser_type payload can't bloat the chain
    let r;
    try { r = await client.call(tool, args, { timeoutMs: 60000 }); }
    catch (e) { if (tool !== 'browser_navigate') throw e; r = await client.call(tool, args, { timeoutMs: 60000 }); }   // cold-start race: a fresh browser's first navigate can collide with about:blank. navigate is idempotent → one retry. ponytail: retry ONLY navigate, never a click/type/submit.
    if (r?.isError) throw new Error(`step ${i} ${tool}: ${textOf(r)}`);
    log.push(`#${i} ${tool} → ${textOf(r)}`);
  }
  return log.join('\n\n');
}

async function tick() {
  const { runnable } = await api('/api/poll', { agent: AGENT });
  for (const h of runnable) {
    if (h.skill !== SKILL) { await api(`/api/handoffs/${h.id}/result`, { error: `browser-control does not serve skill "${h.skill}"` }); continue; }
    console.log(`▶ ${AGENT} running ${h.id} from ${h.from}`);
    let steps; try { steps = JSON.parse(h.input || '{}').steps; } catch { steps = null; }
    if (!Array.isArray(steps)) { await api(`/api/handoffs/${h.id}/result`, { error: 'input must be JSON {steps:[{tool,args}]}' }); continue; }
    try { const result = await runSteps(steps); await api(`/api/handoffs/${h.id}/result`, { result }); console.log(`✓ ${h.id} — ${steps.length} steps`); }
    catch (e) { dropBrowser(); await api(`/api/handoffs/${h.id}/result`, { error: e.message }); console.error(`✗ ${h.id}: ${e.message}`); }   // drop the browser on error → next handoff gets a clean session
  }
  return runnable.length;
}

// self-register: remote (worker-claimable) + auto (11a = no human loop). createAgent sets local+autorun, so we
// turn autorun OFF (→ poll falls through to a worker instead of running in-process) and policy to auto (→ no
// approval pause). Wave 11b flips policy back to 'approval' to enforce the always-human outbound gate.
async function boot() {
  await api('/api/agents', { name: AGENT, skill: SKILL, accepts: ['browser-task'], emits: ['browser-result'] });
  await api(`/api/agents/${AGENT}/autorun`, { on: false });
  await api(`/api/agents/${AGENT}/policy`, { policy: 'auto' });
  console.log(`[browser-worker] ${AGENT} polling ${HUB}  pw=${PW}${ONCE ? ' (once)' : ''}`);
}

await boot();
if (ONCE) tick().then((n) => { dropBrowser(); console.log(`done — ${n} run`); process.exit(0); }).catch((e) => { dropBrowser(); console.error('✗', e.message); process.exit(1); });
else { const loop = () => tick().catch((e) => console.error('tick:', e.message)); loop(); setInterval(loop, 3000); }
