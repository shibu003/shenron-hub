// test_autopause.mjs — Wave drift→auto-pause: consecutive_fail(3連続)で automation 自動停止。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8920, HUB = 'http://localhost:' + PORT;
const ROOT = new URL('../..', import.meta.url).pathname;
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'autopause-test-'));
const get  = async (p) => (await fetch(HUB + p)).json();
const post = async (p, b) => (await fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, STATE_DIR, SHENRON_NO_AUTOSPAWN: '1', SHENRON_NO_SCHEDULER: '1' } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { try { await get('/api/health'); return; } catch { await sleep(100); } } throw new Error('no boot'); };

// 3連続失敗を automation 経由で起こす（input→output flow を fromAutomation 付きで run・expect は必ず外れる assert）
async function failThrice(wfId, autoId) {
  for (let i = 0; i < 3; i++) { await post('/api/runflow', { id: wfId, input: 'hello', fromAutomation: autoId }); await sleep(200); }   // checkOutcome は setImmediate＝各 run 後に待つ
}

let bad = false;
try {
  await waitUp();
  // input→output flow（output = input = 'hello'）
  const wf = await post('/api/workflows', { name: 'autopause flow', nodes: [{ id: 'i', kind: 'input' }, { id: 'o', kind: 'output' }], edges: [{ source: 'i', target: 'o' }] });
  assert.ok(wf.id, 'flow saved');

  // ── 既定 ON: automation A を 3連続 fail → 自動停止 ──
  const a1 = await post('/api/automations', { name: 'auto-a', trigger: { type: 'schedule', cron: '0 0 1 1 *' }, workflow: wf.id });
  await post('/api/check', { automation: a1.id, expect: { kind: 'assert', rule: 'contains:ZZZNEVER' } });   // 'hello' に ZZZNEVER は無い＝必ず fail
  await failThrice(wf.id, a1.id);
  await sleep(200);
  const autos = await get('/api/automations');
  const rowA = autos.find((a) => a.id === a1.id);
  assert.equal(rowA.enabled, false, '3連続 fail → automation 自動停止（enabled=false）');
  assert.equal(rowA.pausedReason, 'drift', 'pausedReason=drift が刻まれる');
  const alerts = await get('/api/drift-alerts');
  assert.ok(alerts.some((d) => d.automationId === a1.id && d.action === 'paused'), 'driftAlert に action=paused');

  // ── 再開: toggle on で pausedReason クリア ──
  await post('/api/automations/' + a1.id + '/toggle', { on: true });
  const rowA2 = (await get('/api/automations')).find((a) => a.id === a1.id);
  assert.equal(rowA2.enabled, true, 'toggle on → 再有効化');
  assert.equal(rowA2.pausedReason, undefined, '再開で pausedReason が消える');

  // ── config escape: driftAutoPause=false なら 3連続 fail でも停止しない ──
  await post('/api/config', { driftAutoPause: false });
  const a2 = await post('/api/automations', { name: 'auto-b', trigger: { type: 'schedule', cron: '0 0 1 1 *' }, workflow: wf.id });
  await post('/api/check', { automation: a2.id, expect: { kind: 'assert', rule: 'contains:ZZZNEVER' } });
  await failThrice(wf.id, a2.id);
  await sleep(200);
  const rowB = (await get('/api/automations')).find((a) => a.id === a2.id);
  assert.equal(rowB.enabled, true, 'config off → 3連続 fail でも停止しない');
  assert.ok((await get('/api/drift-alerts')).some((d) => d.automationId === a2.id && d.action === 'alert'), 'config off でも drift は検出（action=alert）');

  console.log('OK drift→auto-pause: 3連続fail→停止+pausedReason / 再開でクリア / config off で停止しない');
} catch (e) { bad = true; console.error('FAIL', e.message); }
finally { hub.kill(); }
process.exit(bad ? 1 : 0);
