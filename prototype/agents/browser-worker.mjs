#!/usr/bin/env node
// browser-worker.mjs — Wave 11a: a STATEFUL computer-use worker (the concierge "手"). Unlike worker.mjs
// (one runVendor call per handoff), this holds ONE persistent Playwright-MCP browser session and drives it
// step-by-step, so a single handoff can open→read→click across steps without losing the page. The hub's `mcp`
// node is one-shot (fresh session per call) → structurally can't multi-step browse; this worker is the
// stateful seam that closes the "API 無し / UI のみ" branch of the decision tree (docs/13 §J).
//
//   node prototype/agents/browser-worker.mjs [--hub …] [--once] [--vendor claude] [--max-steps 12] [--no-screenshot] [--isolated] [--pw "<cmd>"]
//   default = persistent login profile (~/.giogio/browser-profile); --isolated = ephemeral (tests/CI)
//
// Handoff input is EITHER JSON {steps:[{tool, args}]} (pre-baked Playwright-MCP steps, 11a/b) OR a plain
// natural-language goal (11c: the planner's agent:browser-control node hands off the intent). For an NL goal
// the worker runs an agentic loop — observe (snapshot) → the brain (--vendor) picks the next action → gate → act.
// Each step is audited (redacted) to the hub; the joined output is posted back as the handoff result.
//
// Wave 11b: each step is classified against the persisted permission ruleset (GET /api/permissions) — a
// 3-stage allow/ask/deny gate (NOT a hardcoded always-human rule). allow → run silently. ask → screenshot the
// page, POST a checkpoint, BLOCK until a human approves/declines in the cockpit. deny → throw. 「常に許可」
// promotes a tool to allow (stops asking). Read-only tools DEFAULT allow, mutating/outbound DEFAULT ask — both
// are just defaults the user can change per the 3 stages (see permissions.mjs).

import { openStdio } from '../mcp/mcp-client.mjs';
import { redact } from '../trust.mjs';
import { classify } from '../permissions.mjs';
import { runVendorAsync } from '../runner.mjs';   // Wave 11c: the agent's brain — decide the next browser action from a goal + the live page
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const HUB = (argOf('--hub') || 'http://localhost:8795').replace(/\/$/, '');
// Persistent browser profile: the user logs in ONCE and the session (cookies/login) is reused across runs —
// 「人のログイン session を資産化」, the no-API branch's substitute for an API key. The profile dir is OURS
// (~/.giogio/browser-profile), separate from the operator's own Chrome → no collision. --isolated → ephemeral
// in-memory profile (tests/CI, or to avoid touching the persistent one). --pw overrides the whole command.
// ponytail: one shared profile dir → one worker at a time (the ticking guard already serializes). Per-worker
// dirs if you ever run several. Path must be space-free (openStdio splits argv on whitespace).
const PROFILE = path.join(os.homedir(), '.giogio', 'browser-profile');
const ISOLATED = process.argv.includes('--isolated');
const PW = argOf('--pw') || (ISOLATED ? 'npx @playwright/mcp@latest --isolated' : `npx @playwright/mcp@latest --user-data-dir ${PROFILE}`);
if (!argOf('--pw') && !ISOLATED) fs.mkdirSync(PROFILE, { recursive: true });
const ONCE = process.argv.includes('--once');
const SHOT = !process.argv.includes('--no-screenshot');   // Wave 11b: capture a screenshot at each ask-checkpoint (default ON; --no-screenshot → text-only card)
const VENDOR = argOf('--vendor') || 'claude';             // Wave 11c: brain for the agentic NL-goal loop (claude|codex|stub)
const MAX_STEPS = Number(argOf('--max-steps')) || 12;     // bound the agentic loop (computer-use brittleness → keep it finite + human-in-loop)
const AGENT = 'browser-control', SKILL = 'browser-control';
let ticking = false;   // re-entrancy guard: a checkpoint pause makes a handoff long-lived → never run two ticks against the one shared browser

const TOKEN = process.env.A2A_SHARED_TOKEN || '';   // Wave C: inherited from the hub's env on spawn → auth act routes (no-op when hub is open)
async function api(p, body) {
  const r = await fetch(`${HUB}${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
}

// one warm browser session for the worker's life; respawn if it dies. ponytail: shared session = fast, but
// state bleeds across handoffs — fine for the single-service, human-in-loop scope (docs/13 §J Wave 11 risk).
let pw = null;
const browser = () => (pw ||= openStdio(PW, { timeoutMs: 60000 }));
const dropBrowser = () => { if (pw) { try { pw.close(); } catch {} pw = null; } };   // hard kill — for the mid-handoff error reset (clean slate next handoff)
const closeBrowser = async () => { if (pw) { try { await pw.call('browser_close', {}, { timeoutMs: 15000 }); } catch {} dropBrowser(); } };   // graceful: flush the persistent profile (cookies/login) to disk before exit, THEN kill

const textOf = (r) => {
  const t = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return (t || `[${(r?.content || []).map((c) => c.type).join(',') || 'no'} content]`).slice(0, 2000);   // cap: screenshots return base64 — don't bloat the result/audit
};
// live page domain from a tool result (every Playwright-MCP result carries "- Page URL: …") → tracks redirects/popups
const domainOf = (r) => { const m = textOf(r).match(/Page URL:\s*(\S+)/); if (m) try { return new URL(m[1]).hostname; } catch {} return null; };
const shotUri = (r) => { const img = (r?.content || []).find((c) => c.type === 'image'); return img ? `data:${img.mimeType};base64,${img.data}` : null; };

// run ONE browser action through the full 11b gate: audit → classify(allow/ask/deny) → on ask screenshot +
// checkpoint + BLOCK for human → execute (navigate cold-start 1-retry). Returns the result, or null if the
// human declined (caller aborts; hub already set 'rejected'). ctx.domain is the live page domain (mutated).
async function runOne(client, ctx, step, i) {
  const { tool, args = {} } = step;
  if (!tool) throw new Error(`step ${i}: missing tool`);
  const ref = [args.target, args.ref, args.element].find((v) => /^e\d+$/.test(v || ''));   // LLMs confuse target/element/ref (and which holds the e-number); this PW-MCP wants the ref in `target` → route it there
  if (ref) args.target = ref;
  await api('/api/audit', { type: 'browser-action', detail: { agent: AGENT, step: i, tool, args: redact(JSON.stringify(args), {}).text.slice(0, 500) } });   // redact → secrets/PII never hit the audit log; cap → a huge browser_type payload can't bloat the chain
  const eff = classify({ tool, args }, ctx.domain, ctx.rules);
  await api('/api/audit', { type: 'permission', detail: { agent: AGENT, step: i, tool, domain: ctx.domain, effect: eff } });
  if (eff === 'deny') throw new Error(`step ${i} ${tool}: denied by permission rule`);
  if (eff === 'ask') {
    const screenshot = SHOT ? shotUri(await client.call('browser_take_screenshot', { type: 'jpeg' }, { timeoutMs: 60000 })) : null;
    const label = `${tool}${ctx.domain ? ' @ ' + ctx.domain : ''} — ${redact(JSON.stringify(args), {}).text.slice(0, 200)}`;
    await api(`/api/handoffs/${ctx.h.id}/checkpoint`, { screenshot, label, tool, domain: ctx.domain });
    let decided = null;                                       // BLOCK until a human approves/declines in the cockpit
    while (decided === null) {
      await new Promise((res) => setTimeout(res, 1500));
      const hh = (await api('/api/state')).handoffs.find((x) => x.id === ctx.h.id);
      if (!hh) throw new Error(`handoff ${ctx.h.id} vanished during checkpoint`);
      if (hh.status === 'rejected') return null;              // declined → abort; hub owns the 'rejected' status
      decided = hh.checkpoint && hh.checkpoint.decided;
    }
    if (decided === 'declined') return null;
  }
  let r;
  try { r = await client.call(tool, args, { timeoutMs: 60000 }); }
  catch (e) { if (tool !== 'browser_navigate') throw e; r = await client.call(tool, args, { timeoutMs: 60000 }); }   // cold-start race: a fresh browser's first navigate can collide with about:blank. navigate is idempotent → one retry. ponytail: retry ONLY navigate, never a click/type/submit.
  if (r?.isError) throw new Error(`step ${i} ${tool}: ${textOf(r)}`);
  const d = domainOf(r); if (d) ctx.domain = d;              // live domain for the NEXT step's classify (redirects/popups followed)
  return r;
}

// returns the joined step log, or `null` when a human declined at a checkpoint.
async function runSteps(steps, rules, h) {                    // pre-baked steps (11a/b path)
  const ctx = { h, rules, domain: null }, client = browser(), log = [];
  for (let i = 0; i < steps.length; i++) {
    const r = await runOne(client, ctx, steps[i], i);
    if (r === null) return null;
    log.push(`#${i} ${steps[i].tool} → ${textOf(r)}`);
  }
  return log.join('\n\n');
}

// Wave 11c — agentic: drive the browser toward an NL goal. Observe (snapshot) → the brain picks the next single
// action → run it through the SAME gate (so outbound stays human-approved) → repeat, bounded by MAX_STEPS.
const AGENT_PROMPT = (goal, snapshot, schema) => `You operate a web browser to achieve a goal, one step at a time.
Goal: ${goal}
Available tools — use the EXACT arg names shown:
${schema}
For a target/element-reference arg, use the ref from the snapshot (a line like 'button "Submit" [ref=e11]' → "e11").
Current page (accessibility snapshot):
${snapshot}
Output ONLY JSON for the NEXT single action that progresses the goal:
{"tool":"<one of the tools above>","args":{...}}
or {"done":true,"answer":"<for a report/read goal: the information you found, stated directly>"} when the goal is achieved (or you cannot proceed). No prose.`;
// compact, version-robust tool reference straight from the live server: name(required) [+optional]
const toolLine = (t) => { const req = t.inputSchema?.required || [], all = Object.keys(t.inputSchema?.properties || {}); const opt = all.filter((k) => !req.includes(k)); return `${t.name}(${req.join(', ')})${opt.length ? ' [opt: ' + opt.join(', ') + ']' : ''}`; };
async function runGoal(goal, rules, h) {
  const ctx = { h, rules, domain: null }, client = browser(), log = [];
  const schema = (await client.listTools()).filter((t) => t.name.startsWith('browser_')).map(toolLine).join('\n');   // real Playwright-MCP schema (arg names drift across versions) → agent uses correct args
  let answer = '';
  for (let i = 0; i < MAX_STEPS; i++) {
    const snap = textOf(await client.call('browser_snapshot', {}, { timeoutMs: 60000 }));   // observe (read-only → classify allow, no gate)
    const d = domainOf({ content: [{ type: 'text', text: snap }] }); if (d) ctx.domain = d;
    const out = await runVendorAsync(VENDOR, AGENT_PROMPT(goal, snap, schema), '{"done":true}');   // stub vendor → done (loop terminates)
    let act; try { act = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch { act = { done: true }; }
    if (act.done || !act.tool) { answer = act.answer || ''; break; }                         // capture the agent's final answer (report goals)
    const r = await runOne(client, ctx, { tool: act.tool, args: act.args || {} }, i);
    if (r === null) return null;                              // declined → abort
    log.push(`#${i} ${act.tool} → ${textOf(r)}`);
  }
  return [answer, log.length ? '— actions —\n' + log.join('\n') : ''].filter(Boolean).join('\n\n') || '(no actions taken)';
}

async function tick() {
  if (ticking) return 0; ticking = true;   // a prior tick may be blocked at a checkpoint — don't drive the shared browser twice
  try {
    const { runnable } = await api('/api/poll', { agent: AGENT });
    for (const h of runnable) {
      if (h.skill !== SKILL) { await api(`/api/handoffs/${h.id}/result`, { error: `browser-control does not serve skill "${h.skill}"` }); continue; }
      console.log(`▶ ${AGENT} running ${h.id} from ${h.from}`);
      let steps; try { steps = JSON.parse(h.input || '{}').steps; } catch { steps = null; }   // {steps:[…]} = pre-baked (11a/b); anything else = an NL goal → agentic loop (11c)
      const goal = Array.isArray(steps) ? null : (h.input || '').trim();
      if (!Array.isArray(steps) && !goal) { await api(`/api/handoffs/${h.id}/result`, { error: 'input must be JSON {steps:[{tool,args}]} or an NL goal' }); continue; }
      const rules = await api('/api/permissions');   // per-handoff snapshot → a 「常に許可」 written mid-run takes effect on the NEXT handoff
      try {
        const result = goal ? await runGoal(goal, rules, h) : await runSteps(steps, rules, h);
        if (result === null) { console.log(`⏹ ${h.id} declined at checkpoint`); continue; }   // hub already set 'rejected' — do NOT post /result
        await api(`/api/handoffs/${h.id}/result`, { result }); console.log(`✓ ${h.id} — ${goal ? 'goal' : steps.length + ' steps'}`);
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
if (ONCE) tick().then(async (n) => { await closeBrowser(); console.log(`done — ${n} run`); process.exit(0); }).catch(async (e) => { await closeBrowser(); console.error('✗', e.message); process.exit(1); });   // graceful close → persistent login flushed to disk
else { const loop = () => tick().catch((e) => console.error('tick:', e.message)); loop(); setInterval(loop, 3000); }
