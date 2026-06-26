// test_routes.mjs — B8 不変条件（HTTP route 表化）の回帰網。docs/B8-auth-map.md §5 を符号化。
// closed hub（A2A_SHARED_TOKEN 設定）で「認証境界」が table 化の前後で同値かを固定する：
//   ・/api/* は token 無で 401（面ゲート）  ・公開例外（health/doctor/readiness/auth-verify）は token 無でも到達
//   ・POST auth/role は非 admin で 403       ・oauth/.well-known は公開        ・/mcp 系は自前 bearerOk で 401
// HOME/STATE_DIR を tmpdir に隔離（本番 ~/.shenron を汚さない）。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8917, HUB = 'http://localhost:' + PORT, TOKEN = 'b8-route-token';
const ROOT = new URL('../..', import.meta.url).pathname;
const HOME = mkdtempSync(path.join(os.tmpdir(), 'routes-home-'));
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'routes-state-'));
const hdr = (tok) => ({ 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) });
const GET = (p, tok) => fetch(HUB + p, { headers: hdr(tok), redirect: 'manual' });
const POST = (p, b, tok) => fetch(HUB + p, { method: 'POST', headers: hdr(tok), body: JSON.stringify(b || {}), redirect: 'manual' });

const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HOME, STATE_DIR, A2A_SHARED_TOKEN: TOKEN, SHENRON_NO_AUTOSPAWN: '1', SHENRON_NO_SCHEDULER: '1' } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { try { if ((await GET('/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error('no boot'); };

let bad = false;
try {
  await waitUp();

  // ── 公開例外（token 無で到達＝gate より上 or auth:open）──
  assert.equal((await GET('/api/health')).status, 200, 'health public');
  assert.equal((await GET('/api/shenron/readiness')).status, 200, 'readiness public');
  assert.equal((await GET('/api/doctor')).status, 200, 'doctor public');
  assert.equal((await GET('/api/auth/verify')).status, 400, 'auth/verify reachable (400 token required, NOT 401)');
  assert.equal((await GET('/api/auth/me')).status, 401, 'auth/me self-session 401 (no cookie)');

  // ── /api/* GET 面ゲート（token 無→401・token 有→200）──
  assert.equal((await GET('/api/state')).status, 401, 'state gated (no token)');
  assert.equal((await GET('/api/state', TOKEN)).status, 200, 'state ok (token)');
  assert.equal((await GET('/api/workflows')).status, 401, 'workflows gated');
  assert.equal((await GET('/api/auth/users')).status, 401, 'auth/users gated (own bearerOk)');
  assert.equal((await GET('/api/unknown-xyz')).status, 401, 'unknown /api GET still gated (no token)');

  // ── /api/* POST 面ゲート ──
  assert.equal((await POST('/api/runflow', { nodes: [], edges: [] })).status, 401, 'runflow gated (no token)');
  assert.notEqual((await POST('/api/runflow', { nodes: [], edges: [] }, TOKEN)).status, 401, 'runflow gate passes (token)');
  assert.equal((await POST('/api/unknown-xyz', {})).status, 401, 'unknown /api POST still gated (no token)');
  assert.equal((await POST('/api/unknown-xyz', {}, TOKEN)).status, 404, 'unknown /api POST → 404 (token)');

  // ── 公開 POST（auth）──
  assert.equal((await POST('/api/auth/register', { email: 'rt@x.com', password: 'pw123456' })).status, 201, 'register public');

  // ── admin gate（唯一の isAdmin route）──
  const u1 = await (await POST('/api/auth/register', { email: 'adm@x.com', password: 'pw123456' })).json();
  assert.equal((await POST('/api/auth/role', { userId: u1.userId, role: 'member' })).status, 403, 'auth/role non-admin → 403');
  assert.equal((await POST('/api/auth/role', { userId: u1.userId, role: 'admin' }, TOKEN)).status, 200, 'auth/role admin(token) → 200');

  // ── 非 /api は面ゲート素通り：oauth/discovery は公開、mcp は自前 bearerOk ──
  assert.equal((await GET('/.well-known/oauth-authorization-server')).status, 200, 'oauth discovery public');
  assert.equal((await GET('/oauth/authorize?redirect_uri=http://localhost')).status, 302, 'oauth/authorize public (302)');
  assert.equal((await POST('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401, '/mcp self bearerOk → 401 (no token)');
  assert.equal((await GET('/mcp/sse')).status, 401, '/mcp/sse self bearerOk → 401 (no token)');

  // ── 正常系：authed MCP・OPTIONS preflight・静的 HTML ──
  const mcp = await (await POST('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, TOKEN)).json();
  assert.ok(mcp.result && Array.isArray(mcp.result.tools), '/mcp tools/list ok (token)');
  assert.equal((await fetch(HUB + '/api/state', { method: 'OPTIONS', headers: hdr() })).status, 204, 'OPTIONS preflight 204');
  assert.equal((await GET('/')).status, 200, 'launcher HTML public');

  // ── regex route（capture）が表でも届く ──
  const stop = await POST('/api/runs/nope/stop', {}, TOKEN);
  assert.notEqual(stop.status, 401, 'runs/:id/stop regex auth passed (token)');
  assert.notEqual(stop.status, 404, 'runs/:id/stop regex matched, not unknown-route (token)');

  console.log('OK B8 route table — auth boundary + public exceptions + regex dispatch');
} catch (e) { bad = true; console.error('FAIL', e.message); }
finally { hub.kill(); }
process.exit(bad ? 1 : 0);
