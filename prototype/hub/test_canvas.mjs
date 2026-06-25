// test_canvas.mjs — Wave Canvas-1: 成果物ギャラリー（/api/artifacts 集約・pending 同定・seat filter・/artifacts 配信）。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8922, HUB = 'http://localhost:' + PORT;
const ROOT = new URL('../..', import.meta.url).pathname;
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'canvas-test-'));
const get = async (p) => (await fetch(HUB + p)).json();
const getText = async (p) => (await fetch(HUB + p)).text();

// seed workflows.json: 3 flow — ui付き(操作待ち) / ui付き(run無し) / ui無し
writeFileSync(path.join(STATE_DIR, 'workflows.json'), JSON.stringify([
  { id: 'with-ui-pending', name: 'UI 操作待ち', ui: 'export default function App(){return <button onClick={()=>shenron.advance({ok:1})}>送信</button>}', owner: null, visibility: 'private', nodes: [], edges: [] },
  { id: 'with-ui-idle',    name: 'UI プレビュー', ui: 'export default function App(){return <h1>hi</h1>}', owner: null, visibility: 'shared', nodes: [], edges: [] },
  { id: 'no-ui',           name: 'UI 無し', owner: null, visibility: 'private', nodes: [], edges: [] },
]));
// seed inbox.json: with-ui-pending に running run + checkpoint handoff（操作待ち）
writeFileSync(path.join(STATE_DIR, 'inbox.json'), JSON.stringify({
  handoffs: [{ id: 'hp1', runId: 'r-pending', to: 'a', from: 'hub', status: 'awaiting_approval', checkpoint: { label: 'confirm', decided: null }, input: '' }],
  agents: {}, audit: [],
  runs: { 'r-pending': { id: 'r-pending', flowId: 'with-ui-pending', status: 'running', nodes: [], outputs: {}, parent: null, createdAt: Date.now() } },
}));

const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, STATE_DIR, SHENRON_NO_AUTOSPAWN: '1', SHENRON_NO_SCHEDULER: '1' } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { try { await get('/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); } } throw new Error('no boot'); };

let bad = false;
try {
  await waitUp();
  await new Promise(r => setTimeout(r, 300));   // boot 後の sweep/reconcile を待つ（reconcile は handoff awaiting_approval を生存扱い＝run 維持）

  const arts = await get('/api/artifacts');
  const byId = Object.fromEntries(arts.map(a => [a.id, a]));
  assert.ok(!byId['no-ui'], 'ui 無し flow は掲載されない');
  assert.ok(byId['with-ui-pending'] && byId['with-ui-idle'], 'ui 付き flow は掲載される');
  assert.equal(byId['with-ui-pending'].hasPending, true, 'running run + checkpoint handoff → hasPending=true');
  assert.equal(byId['with-ui-pending'].handoffId, 'hp1', '操作対象 handoffId を返す');
  assert.equal(byId['with-ui-idle'].hasPending, false, 'run 無し → hasPending=false（プレビューのみ）');

  // UI コードは get_flow_ui で取れる（一覧には載せない＝token-light）
  assert.ok(!('ui' in byId['with-ui-pending']), '一覧に UI コード本体は載せない');
  const ui = await get('/api/workflows/with-ui-pending/ui');
  assert.ok(ui.ui && ui.ui.includes('shenron.advance'), 'get_flow_ui で UI コード取得可');

  // /artifacts ページ配信 + viewer 要素
  const html = await getText('/artifacts');
  assert.ok(html.includes('artifactFrame') && html.includes('sandbox="allow-scripts"'), '/artifacts が sandbox viewer を含む HTML を配信');
  assert.ok(html.includes('/api/artifacts'), 'ギャラリーが /api/artifacts を引く');

  console.log('OK Canvas-1: /api/artifacts(ui filter/pending 同定/token-light) + get_flow_ui + /artifacts 配信');
} catch (e) { bad = true; console.error('FAIL', e.message); }
finally { hub.kill(); }
process.exit(bad ? 1 : 0);
