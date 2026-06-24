// test_tenancy.mjs — Wave T-0 テナンシー（owner/visibility）ユニット + HTTP smoke。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { visibleTo } from './shenron.mjs';

// ── 純粋: visibleTo の seat 可視性 ──
assert.equal(visibleTo({ owner: null }, 'u1'), true, 'owner null = 全員可視（後方互換）');
assert.equal(visibleTo({ owner: 'u1', visibility: 'private' }, 'u1'), true, '自分の private = 可視');
assert.equal(visibleTo({ owner: 'u1', visibility: 'private' }, 'u2'), false, '他人の private = 不可視');
assert.equal(visibleTo({ owner: 'u1', visibility: 'shared' }, 'u2'), true, '他人でも shared = 可視');
assert.equal(visibleTo({ owner: 'u1', visibility: 'private' }, null), true, 'uid null = operator 全可視');
assert.equal(visibleTo({ owner: 'u1' }, 'u2'), false, 'visibility 欠落 + 他人 = 不可視');
console.log('OK visibleTo 6-branch');

// ── HTTP smoke: hub 起動 → owner/visibility 保存 + share/unshare route flip ──
const PORT = 8911, HUB = 'http://localhost:' + PORT;
const ROOT = new URL('../..', import.meta.url).pathname;
const get  = async (p) => (await fetch(HUB + p)).json();
const post = async (p, b) => (await fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, SHENRON_NO_AUTOSPAWN: '1', SHENRON_NO_SCHEDULER: '1' } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { try { await get('/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); } } throw new Error('no boot'); };
let bad = false;
try {
  await waitUp();
  const saved = await post('/api/workflows', { name: 'tenancy smoke', nodes: [{ id: 'i', kind: 'input' }, { id: 'o', kind: 'output' }], edges: [{ source: 'i', target: 'o' }] });
  assert.ok(saved.id, 'flow saved');
  let row = (await get('/api/workflows')).find((w) => w.id === saved.id);
  assert.equal(row.visibility, 'private', 'default visibility=private');
  assert.equal(row.owner, null, 'openDev create owner=null');
  const sh = await post('/api/workflows/' + saved.id + '/share', {});
  assert.equal(sh.visibility, 'shared', 'share route -> shared');
  assert.equal((await get('/api/workflows')).find((w) => w.id === saved.id).visibility, 'shared', 'list reflects shared');
  const un = await post('/api/workflows/' + saved.id + '/unshare', {});
  assert.equal(un.visibility, 'private', 'unshare route -> private');
  console.log('OK HTTP smoke owner/visibility + share/unshare route');
} catch (e) { bad = true; console.error('FAIL', e.message); }
finally { hub.kill(); }
process.exit(bad ? 1 : 0);
