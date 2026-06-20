// test_e2e.mjs — integration test: drives the FULL 神龍 lifecycle through the MCP control plane (server.mjs
// over stdio → hub), proving "全て MCP で完結" (no web cockpit), plus the 3-stage browser permission gate
// (allow/ask/deny — NOT a hardcoded always-human rule). Deterministic: hub runs --vendor stub.
//   run: node prototype/test_e2e.mjs    (spawns a hub on a test port + the MCP server + a browser-worker)
// Isolates inbox.json (moved aside, restored at end). Needs node; the browser sub-tests need npx @playwright/mcp.
// gen_component/approve_component are real-claude codegen → covered by test_shenron's verifyMcpServer, not here.
import { spawn, spawnSync } from 'node:child_process';
import { openStdio } from './mcp/mcp-client.mjs';
import fs from 'node:fs';
import url from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));   // repo root (../ from prototype/)
const PORT = 8907, HUB = `http://localhost:${PORT}`;
const PERMFILE = path.join(ROOT, 'prototype/mcp/permissions.json');
// shared-store files the test mutates → saved aside before, restored after (so the real ones are never polluted)
const ISOLATE = ['prototype/hub/inbox.json', 'prototype/mcp/workflows.json', 'prototype/mcp/components.json', 'prototype/mcp/integrations.json'].map((p) => path.join(ROOT, p));
const results = []; const ok = (n, c) => { results.push(!!c); console.log((c ? '✅' : '❌') + ' ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hubGet = async (p) => (await fetch(HUB + p)).json();
const hubPost = async (p, b) => (await fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const FORM = 'https://www.selenium.dev/selenium/web/web-form.html';   // Selenium official test form — stable, built for automation
const CLAUDE = process.argv.includes('--claude') && spawnSync('which', ['claude']).status === 0;   // opt-in real-claude agentic headline
const STEPS = JSON.stringify({ steps: [{ tool: 'browser_navigate', args: { url: FORM } }, { tool: 'browser_press_key', args: { key: 'Tab' } }] });
const runWorker = async (hid, vendor = 'stub', maxStep = 90) => {   // spawn worker --once; approve any checkpoint; return {paused, status}
  const w = spawn('node', ['prototype/agents/browser-worker.mjs', '--hub', HUB, '--once', '--vendor', vendor, '--no-screenshot', '--isolated'], { cwd: ROOT, stdio: 'ignore' });   // --isolated: tests use an ephemeral profile, not the persistent login one
  let paused = false;
  for (let i = 0; i < maxStep; i++) {
    const h = (await hubGet('/api/state')).handoffs.find((x) => x.id === hid);
    if (h?.status === 'awaiting_approval' && h.checkpoint && h.checkpoint.decided === null) { paused = true; await hubPost(`/api/handoffs/${hid}/approve`, {}); }
    if (h?.status === 'completed' || h?.status === 'failed') break;
    await sleep(1000);
  }
  try { w.kill(); } catch {}
  const h = (await hubGet('/api/state')).handoffs.find((x) => x.id === hid);
  return { paused, status: h?.status };
};

const saved = {}; for (const f of ISOLATE) { if (fs.existsSync(f)) saved[f] = fs.readFileSync(f); fs.rmSync(f, { force: true }); }   // isolate shared stores
if (fs.existsSync(PERMFILE)) fs.rmSync(PERMFILE);
const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'], { cwd: ROOT, stdio: 'ignore' });
let madeSkillSlug = null;
try {
  for (let i = 0; i < 40; i++) { try { await hubGet('/api/state'); break; } catch { await sleep(250); } }

  // ─── MCP control plane (server.mjs over stdio → hub) = 全て MCP で完結 ───
  const mcp = openStdio('node prototype/mcp/server.mjs', { cwd: ROOT, env: { ...process.env, BUILDHUD_HUB: HUB }, timeoutMs: 20000 });
  const call = async (t, a = {}) => { const r = await mcp.call(t, a, { timeoutMs: 20000 }); const x = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'); try { return JSON.parse(x); } catch { return x; } };
  const bs = await call('build_state'); ok('MCP build_state', bs && typeof bs.agents === 'number');
  const p0 = await call('get_permissions'); ok('MCP get_permissions seed (9 rules, click=ask)', Array.isArray(p0) && p0.length === 9 && p0.find((r) => r.tool === 'browser_click')?.effect === 'ask');
  const p1 = await call('set_permission', { tool: 'browser_click' }); ok('MCP set_permission browser_click→allow (send is 3-stage, not 必ず)', Array.isArray(p1) && p1.some((r) => r.effect === 'allow' && r.tool === 'browser_click'));
  const plOff = await call('plan_flow', { goal: 'do a thing', save: false, gap: 'off' }); ok('MCP plan_flow gap:off → no buildable gap', plOff && Array.isArray(plOff.nodes) && (plOff.missing || []).length === 0);
  const plSave = await call('plan_flow', { goal: 'summarize then post', save: true }); ok('MCP plan_flow save → workflowId', plSave && !!plSave.workflowId);
  const comps = await call('list_components'); ok('MCP list_components → array', Array.isArray(comps));
  if (plSave?.workflowId) { const sk = await call('make_skill', { id: plSave.workflowId }); madeSkillSlug = sk?.slug; ok('MCP make_skill → SKILL.md written', sk && sk.path && fs.existsSync(path.join(ROOT, sk.path))); } else ok('MCP make_skill', false);
  ok('MCP search_agents → array', Array.isArray(await call('search_agents', { query: 'x' })));
  mcp.close();

  // ─── 3-stage browser permission gate (real browser, pre-baked steps, deterministic) ───
  const h1 = await hubPost('/api/handoffs', { to: 'browser-control', skill: 'browser-control', from: 't', input: STEPS });
  const r1 = await runWorker(h1.id);
  ok('gate: press_key DEFAULT ask → paused at checkpoint → human approve → completed', r1.paused && r1.status === 'completed');
  await hubPost('/api/permissions', { tool: 'browser_press_key' });   // 常に許可 (promote send to allow)
  const h2 = await hubPost('/api/handoffs', { to: 'browser-control', skill: 'browser-control', from: 't', input: STEPS });
  const r2 = await runWorker(h2.id);
  ok('gate: after 常に許可 press_key=allow → NO checkpoint → completed (3-stage proven, not 必ず)', !r2.paused && r2.status === 'completed');

  // ─── headline (opt-in --claude): real-claude AGENTIC mutating co-pilot on the Selenium form ───
  // claude drives: navigate → type into the text input → click Submit; type/click DEFAULT ask → checkpoint →
  // the test approves as the human → form actually submits → claude reports the confirmation.
  if (CLAUDE) {
    const goal = `Go to ${FORM} , type concierge-test into the first text input field, then click the Submit button. Report the confirmation message shown after submitting.`;
    const h3 = await hubPost('/api/handoffs', { to: 'browser-control', skill: 'browser-control', from: 't', input: goal });
    const r3 = await runWorker(h3.id, 'claude', 360);
    const hh = (await hubGet('/api/state')).handoffs.find((x) => x.id === h3.id);
    const fullySubmitted = r3.status === 'completed' && /submit|received|form/i.test(hh?.result || '');
    ok('headline: real-claude agentic Selenium form — mutating action hit the 3-stage gate (checkpoint)', r3.paused);   // reliable: claude's type/submit triggers the human gate on the real form
    console.log(`   ↳ full type→submit→confirm: ${fullySubmitted ? '✓ completed' : '(best-effort, computer-use 🔴: ' + (r3.status || '?') + ')'} — ${(hh?.result || '').split('\n')[0].slice(0, 110)}`);
  } else console.log('ℹ headline real-claude agentic run skipped (pass --claude with the claude CLI installed)');
} finally {
  try { hub.kill(); } catch {}
  try { spawn('pkill', ['-f', '@playwright/mcp']); } catch {}
  try { fs.rmSync(path.join(ROOT, '.playwright-mcp'), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(PERMFILE, { force: true }); } catch {}
  if (madeSkillSlug) try { fs.rmSync(path.join(ROOT, '.claude/skills', madeSkillSlug), { recursive: true, force: true }); } catch {}
  for (const f of ISOLATE) { try { if (saved[f] !== undefined) fs.writeFileSync(f, saved[f]); else fs.rmSync(f, { force: true }); } catch {} }   // restore shared stores
  const pass = results.filter(Boolean).length;
  console.log(`\n=== test_e2e: ${pass}/${results.length} passed ===`);
  process.exit(pass === results.length ? 0 : 1);
}
