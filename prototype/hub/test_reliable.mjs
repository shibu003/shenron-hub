// test_reliable.mjs — Wave Reliable-1: boot で crash 後のゾンビ run を reconcile（interrupted 化）。
// STATE_DIR に inbox.json を seed → hub 起動（sweep→reconcileRuns）→ GET /api/runs で status を検証。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8918, HUB = 'http://localhost:' + PORT;
const ROOT = new URL('../..', import.meta.url).pathname;
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'reliable-test-'));

// seed inbox.json: 4 run + 1 handoff（awaiting_approval）。run には /api/runs マッパ用に nodes[]/outputs{} を持たせる。
const run = (id, status, extra = {}) => ({ id, flowId: id + '-flow', status, nodes: [], outputs: {}, parent: null, createdAt: Date.now(), ...extra });
const seed = {
  handoffs: [{ id: 'h1', runId: 'waiting', status: 'awaiting_approval', to: 'someagent', from: 'hub', input: '' }],
  agents: {},
  audit: [],
  runs: {
    orphan: run('orphan', 'running'),                                              // handoff 無し → interrupted
    waiting: run('waiting', 'running'),                                            // awaiting_approval handoff 有り → 残存
    parent: run('parent', 'running'),                                              // child 経由で interrupted（fixpoint）
    child: run('child', 'running', { parent: { runId: 'parent', node: 'n1' } }),   // handoff 無し → interrupted → 親も
    done1: run('done1', 'completed'),                                              // 不変
  },
};
writeFileSync(path.join(STATE_DIR, 'inbox.json'), JSON.stringify(seed));

const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, STATE_DIR, SHENRON_NO_AUTOSPAWN: '1', SHENRON_NO_SCHEDULER: '1' } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { try { await (await fetch(HUB + '/api/health')).json(); return; } catch { await new Promise(r => setTimeout(r, 100)); } } throw new Error('no boot'); };

let bad = false;
try {
  await waitUp();
  await new Promise(r => setTimeout(r, 300));   // sweep は setImmediate＝boot 直後。reconcile 完了を待つ。
  const runs = await (await fetch(HUB + '/api/runs')).json();
  const byId = Object.fromEntries((Array.isArray(runs) ? runs : []).map(r => [r.id, r.status]));

  assert.equal(byId.orphan, 'interrupted', 'orphan running run（handoff 無し）→ interrupted');
  assert.equal(byId.waiting, 'running', 'awaiting_approval handoff を持つ run → running のまま（誤殺しない）');
  assert.equal(byId.child, 'interrupted', 'sub-flow child（handoff 無し）→ interrupted');
  assert.equal(byId.parent, 'interrupted', 'sub-flow parent（child がゾンビ）→ interrupted（fixpoint 伝播）');
  assert.equal(byId.done1, 'completed', 'completed run → 不変');
  console.log('OK Reliable-1 reconcile: orphan/child/parent → interrupted, awaiting_approval 残存, completed 不変');
} catch (e) { bad = true; console.error('FAIL', e.message); }
finally { hub.kill(); }
process.exit(bad ? 1 : 0);
