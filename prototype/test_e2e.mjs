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
const ISOLATE = ['prototype/hub/inbox.json', 'prototype/mcp/workflows.json', 'prototype/mcp/components.json', 'prototype/mcp/integrations.json', 'prototype/mcp/goals.json', 'prototype/mcp/automations.json'].map((p) => path.join(ROOT, p));
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
const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, SHENRON_NO_AUTOSPAWN: '1' } });   // tests drive their own worker
let madeSkillSlug = null;
try {
  for (let i = 0; i < 40; i++) { try { await hubGet('/api/state'); break; } catch { await sleep(250); } }

  // ─── MCP control plane (server.mjs over stdio → hub) = 全て MCP で完結 ───
  const mcp = openStdio('node prototype/mcp/server.mjs', { cwd: ROOT, env: { ...process.env, SHENRON_HUB: HUB }, timeoutMs: 20000 });
  const call = async (t, a = {}) => { const r = await mcp.call(t, a, { timeoutMs: 20000 }); const x = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'); try { return JSON.parse(x); } catch { return x; } };
  const bs = await call('build_state'); ok('MCP build_state', bs && typeof bs.agents === 'number');
  const p0 = await call('get_permissions'); ok('MCP get_permissions seed (9 rules, click=ask)', Array.isArray(p0) && p0.length === 9 && p0.find((r) => r.tool === 'browser_click')?.effect === 'ask');
  const p1 = await call('set_permission', { tool: 'browser_click' }); ok('MCP set_permission browser_click→allow (send is 3-stage, not 必ず)', Array.isArray(p1) && p1.some((r) => r.effect === 'allow' && r.tool === 'browser_click'));
  const plOff = await call('plan_flow', { goal: 'do a thing', save: false, gap: 'off' }); ok('MCP plan_flow gap:off → no buildable gap', plOff && Array.isArray(plOff.nodes) && (plOff.missing || []).length === 0);
  const plSave = await call('plan_flow', { goal: 'summarize then post', save: true }); ok('MCP plan_flow save → workflowId', plSave && !!plSave.workflowId);
  const comps = await call('list_components'); ok('MCP list_components → array', Array.isArray(comps));
  if (plSave?.workflowId) { const sk = await call('make_skill', { id: plSave.workflowId }); madeSkillSlug = sk?.slug; ok('MCP make_skill → SKILL.md written', sk && sk.path && fs.existsSync(path.join(ROOT, sk.path))); } else ok('MCP make_skill', false);
  ok('MCP search_agents → array', Array.isArray(await call('search_agents', { query: 'x' })));

  // ─── Wave Goals-1: ゴール記憶 concierge — set→checkin→list が全て MCP で完結（cockpit 無し・北極星）───
  const g0 = await call('set_goal', { wish: '3ヶ月でフォロワー1000', metric: 'followers', target: 1000, unit: '人' });
  ok('MCP set_goal → id + 初期 pct=0 + active', g0 && !!g0.id && g0.pct === 0 && g0.status === 'active');
  const g1 = await call('goal_checkin', { id: g0.id, value: 250, note: 'week1' });
  ok('MCP goal_checkin 250 → current/pct 更新・未到達は active', g1.current === 250 && g1.pct === 25 && g1.status === 'active' && g1.checkins.length === 1);
  const g2 = await call('goal_checkin', { id: g0.id, value: 1000 });   // target 到達ブランチ
  ok('MCP goal_checkin target 到達 → status=reached + pct=100', g2.current === 1000 && g2.pct === 100 && g2.status === 'reached');
  const gl = await call('list_goals');
  ok('MCP list_goals → 作った goal が pct 付きで出る（両surface 機能確認）', Array.isArray(gl) && gl.some((g) => g.id === g0.id && g.pct === 100));

  // ─── Wave Goals-2: bound automation の成功 run → goal.current 自動 +1（カウント式・北極星①の能動性）───
  const plg = await call('plan_flow', { goal: 'summarize the input', save: true, gap: 'off' });   // input→prompt→output（stub で確実に完走・gap 無し）
  const auto = await hubPost('/api/automations', { name: 'goal-auto-e2e', trigger: { type: 'build_state', match: { event: 'goal_e2e' } }, workflow: plg.workflowId });
  const ga = await call('set_goal', { wish: '自動進捗テスト', metric: 'runs', target: 3, unit: '回', automationIds: [auto.id] });
  ok('MCP set_goal automationIds 紐付け → active・current 0', ga && ga.status === 'active' && ga.current === 0 && (ga.automationIds || []).includes(auto.id));
  await hubPost('/api/fire', { event: { event: 'goal_e2e' } });   // build_state event → bound automation を fromAutomation 付きで run
  let gp = ga; for (let i = 0; i < 20 && gp.current < 1; i++) { await sleep(300); gp = await call('get_goal', { id: ga.id }); }   // 完了→setImmediate(goalAutoProgress) を待つ
  ok('Goals-2: bound automation の run 完了 → current +1 + auto checkin が付く', gp.current === 1 && (gp.checkins || []).some((c) => c.auto && /^auto: /.test(c.note)));
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
