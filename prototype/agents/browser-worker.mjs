#!/usr/bin/env node
// browser-worker.mjs — Wave 11a: a STATEFUL computer-use worker (the concierge "手"). Unlike worker.mjs
// (one runVendor call per handoff), this holds ONE persistent Playwright-MCP browser session and drives it
// step-by-step, so a single handoff can open→read→click across steps without losing the page. The hub's `mcp`
// node is one-shot (fresh session per call) → structurally can't multi-step browse; this worker is the
// stateful seam that closes the "API 無し / UI のみ" branch of the decision tree (docs/13 §J).
//
//   node prototype/agents/browser-worker.mjs [--hub http://localhost:8795] [--pw "npx @playwright/mcp@latest"] [--once] [--no-screenshot]
//
// Handoff input = JSON {steps:[{tool, args}]} where tool is a Playwright-MCP tool (browser_navigate,
// browser_snapshot, browser_take_screenshot, browser_click, browser_type, …). Each step is audited (redacted)
// to the hub; the joined step output is posted back as the handoff result.
//
// Wave 11b: each step is classified against the persisted permission ruleset (GET /api/permissions). allow →
// run silently. ask → screenshot the page, POST a checkpoint, and BLOCK until a human approves/declines in the
// cockpit (the always-human outbound gate / ToS line). deny → throw. 「常に許可」 in the UI promotes a rule so
// it stops asking. Read-only tools default allow, mutating/outbound default ask (see permissions.mjs).

import { openStdio } from '../mcp/mcp-client.mjs';
import { redact } from '../trust.mjs';
import { classify } from '../permissions.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const HUB = (argOf('--hub') || 'http://localhost:8795').replace(/\/$/, '');
// --isolated → fresh in-memory profile so we don't collide with the operator's own browser/profile lock.
// Wave 11b (persist the user's login as an asset) will swap this for a per-worker persistent profile dir.
const PW = argOf('--pw') || 'npx @playwright/mcp@latest --isolated';
const ONCE = process.argv.includes('--once');
const SHOT = !process.argv.includes('--no-screenshot');   // Wave 11b: capture a screenshot at each ask-checkpoint (default ON; --no-screenshot → text-only card)
const AGENT = 'browser-control', SKILL = 'browser-control';
let ticking = false;   // re-entrancy guard: a checkpoint pause makes a handoff long-lived → never run two ticks against the one shared browser

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
// live page domain from a tool result (every Playwright-MCP result carries "- Page URL: …") → tracks redirects/popups
const domainOf = (r) => { const m = textOf(r).match(/Page URL:\s*(\S+)/); if (m) try { return new URL(m[1]).hostname; } catch {} return null; };
const shotUri = (r) => { const img = (r?.content || []).find((c) => c.type === 'image'); return img ? `data:${img.mimeType};base64,${img.data}` : null; };

// returns the joined step log, or `null` when a human declined at a checkpoint (caller must NOT post /result —
// the hub already set the handoff to 'rejected'; a result would override it to failed/completed).
async function runSteps(steps, rules, h) {
  const client = browser();
  const log = [];
  let currentDomain = null;   // tracked from each result's live Page URL (commit: classify step N uses step N-1's page)
  for (let i = 0; i < steps.length; i++) {
    const { tool, args = {} } = steps[i];
    if (!tool) throw new Error(`step ${i}: missing tool`);
    await api('/api/audit', { type: 'browser-action', detail: { agent: AGENT, step: i, tool, args: redact(JSON.stringify(args), {}).text.slice(0, 500) } });   // redact → secrets/PII never hit the audit log; cap → a huge browser_type payload can't bloat the chain
    const eff = classify({ tool, args }, currentDomain, rules);
    await api('/api/audit', { type: 'permission', detail: { agent: AGENT, step: i, tool, domain: currentDomain, effect: eff } });
    if (eff === 'deny') throw new Error(`step ${i} ${tool}: denied by permission rule`);
    if (eff === 'ask') {
      const screenshot = SHOT ? shotUri(await client.call('browser_take_screenshot', { type: 'jpeg' }, { timeoutMs: 60000 })) : null;
      const label = `${tool}${currentDomain ? ' @ ' + currentDomain : ''} — ${redact(JSON.stringify(args), {}).text.slice(0, 200)}`;
      await api(`/api/handoffs/${h.id}/checkpoint`, { screenshot, label, tool, domain: currentDomain });
      let decided = null;                                       // BLOCK until a human approves/declines in the cockpit
      while (decided === null) {
        await new Promise((res) => setTimeout(res, 1500));
        const hh = (await api('/api/state')).handoffs.find((x) => x.id === h.id);
        if (!hh) throw new Error(`handoff ${h.id} vanished during checkpoint`);
        if (hh.status === 'rejected') return null;              // declined → abort; hub owns the 'rejected' status
        decided = hh.checkpoint && hh.checkpoint.decided;
      }
      if (decided === 'declined') return null;
    }
    let r;
    try { r = await client.call(tool, args, { timeoutMs: 60000 }); }
    catch (e) { if (tool !== 'browser_navigate') throw e; r = await client.call(tool, args, { timeoutMs: 60000 }); }   // cold-start race: a fresh browser's first navigate can collide with about:blank. navigate is idempotent → one retry. ponytail: retry ONLY navigate, never a click/type/submit.
    if (r?.isError) throw new Error(`step ${i} ${tool}: ${textOf(r)}`);
    const d = domainOf(r); if (d) currentDomain = d;            // live domain for the NEXT step's classify (redirects/popups followed)
    log.push(`#${i} ${tool} → ${textOf(r)}`);
  }
  return log.join('\n\n');
}

async function tick() {
  if (ticking) return 0; ticking = true;   // a prior tick may be blocked at a checkpoint — don't drive the shared browser twice
  try {
    const { runnable } = await api('/api/poll', { agent: AGENT });
    for (const h of runnable) {
      if (h.skill !== SKILL) { await api(`/api/handoffs/${h.id}/result`, { error: `browser-control does not serve skill "${h.skill}"` }); continue; }
      console.log(`▶ ${AGENT} running ${h.id} from ${h.from}`);
      let steps; try { steps = JSON.parse(h.input || '{}').steps; } catch { steps = null; }
      if (!Array.isArray(steps)) { await api(`/api/handoffs/${h.id}/result`, { error: 'input must be JSON {steps:[{tool,args}]}' }); continue; }
      const rules = await api('/api/permissions');   // per-handoff snapshot → a 「常に許可」 written mid-run takes effect on the NEXT handoff
      try {
        const result = await runSteps(steps, rules, h);
        if (result === null) { console.log(`⏹ ${h.id} declined at checkpoint`); continue; }   // hub already set 'rejected' — do NOT post /result
        await api(`/api/handoffs/${h.id}/result`, { result }); console.log(`✓ ${h.id} — ${steps.length} steps`);
      } catch (e) { dropBrowser(); await api(`/api/handoffs/${h.id}/result`, { error: e.message }); console.error(`✗ ${h.id}: ${e.message}`); }   // drop the browser on error → next handoff gets a clean session
    }
    return runnable.length;
  } finally { ticking = false; }
}

// self-register: remote (worker-claimable) + auto. createAgent sets local+autorun, so we turn autorun OFF
// (→ poll falls through to a worker, not in-process) and keep policy auto (the task starts without a start-gate).
// Wave 11b: the human gate is the PER-STEP permission checkpoint (ask → pause), not the task-start policy.
async function boot() {
  await api('/api/agents', { name: AGENT, skill: SKILL, accepts: ['browser-task'], emits: ['browser-result'] });
  await api(`/api/agents/${AGENT}/autorun`, { on: false });
  await api(`/api/agents/${AGENT}/policy`, { policy: 'auto' });
  console.log(`[browser-worker] ${AGENT} polling ${HUB}  pw=${PW}${ONCE ? ' (once)' : ''}`);
}

await boot();
if (ONCE) tick().then((n) => { dropBrowser(); console.log(`done — ${n} run`); process.exit(0); }).catch((e) => { dropBrowser(); console.error('✗', e.message); process.exit(1); });
else { const loop = () => tick().catch((e) => console.error('tick:', e.message)); loop(); setInterval(loop, 3000); }
