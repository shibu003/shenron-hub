// test_role.mjs — Wave B1 role(admin/member): 付与 + admin gate + last-admin ガード。
// closed multi-seat hub を再現するため A2A_SHARED_TOKEN を設定し、HOME を tmpdir に振って
// auth.mjs の ~/.shenron(users.json) を隔離する（本番アカウントを汚染しない）。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8912, HUB = 'http://localhost:' + PORT, TOKEN = 'b1-test-token';
const ROOT = new URL('../..', import.meta.url).pathname;
const HOME = mkdtempSync(path.join(os.tmpdir(), 'role-home-'));      // ~/.shenron をここに隔離（G1）
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'role-state-'));
const hdr = (tok) => ({ 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) });
const get  = async (p, tok) => (await fetch(HUB + p, { headers: hdr(tok) })).json();
const post = async (p, b, tok) => (await fetch(HUB + p, { method: 'POST', headers: hdr(tok), body: JSON.stringify(b || {}) }));

const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME, STATE_DIR, A2A_SHARED_TOKEN: TOKEN, SHENRON_NO_AUTOSPAWN: '1', SHENRON_NO_SCHEDULER: '1' } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { try { await get('/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); } } throw new Error('no boot'); };

let bad = false;
try {
  await waitUp();
  // register は public（bearer 不要・G5）。1人目=admin, 2人目=member。
  const u1 = await (await post('/api/auth/register', { email: 'a@x.com', password: 'pw123456' })).json();
  const u2 = await (await post('/api/auth/register', { email: 'b@x.com', password: 'pw123456' })).json();
  assert.ok(u1.userId && u2.userId, 'both registered');

  const users = await get('/api/auth/users', TOKEN);   // GET は bearer 必須（closed hub）
  const r1 = users.find((u) => u.id === u1.userId), r2 = users.find((u) => u.id === u2.userId);
  assert.equal(r1.role, 'admin', '1人目 = admin');
  assert.equal(r2.role, 'member', '2人目 = member');

  // gate: bearer 無し（member でもない外部）→ 403
  assert.equal((await post('/api/auth/role', { userId: u2.userId, role: 'admin' })).status, 403, 'no-bearer → 403');

  // admin(運用者 token)が u2 を昇格 → 200
  const promote = await post('/api/auth/role', { userId: u2.userId, role: 'admin' }, TOKEN);
  assert.equal(promote.status, 200, 'admin promote → 200');
  assert.equal((await promote.json()).role, 'admin', 'u2 now admin');

  // u1 を降格 → admin が u2 だけ残るので OK
  assert.equal((await post('/api/auth/role', { userId: u1.userId, role: 'member' }, TOKEN)).status, 200, 'demote u1 ok (u2 still admin)');

  // last-admin ガード: 残った唯一の admin(u2)を降格 → 400
  const last = await post('/api/auth/role', { userId: u2.userId, role: 'member' }, TOKEN);
  assert.equal(last.status, 400, 'last admin demote → 400');
  assert.match((await last.json()).error, /last admin/, 'guard message');

  console.log('OK B1 role assignment + admin gate + last-admin guard');
} catch (e) { bad = true; console.error('FAIL', e.message); }
finally { hub.kill(); }
process.exit(bad ? 1 : 0);
