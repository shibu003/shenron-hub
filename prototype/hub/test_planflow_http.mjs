// test_planflow_http.mjs — T0 seam の証明 ＋ PC2（多ターン相談）の HTTP 回帰オラクル。
// unit の run 注入では届かない client→HTTP→planFlow→shenronPlan→brief 蓄積→保存 の実配管を、
// `--vendor mock`（決定的 planner）で clarify→clarify→plan の 3 ターン踏んで固定する。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8913, HUB = 'http://localhost:' + PORT;
const get = async (p) => (await fetch(HUB + p)).json();
const post = async (p, b) => (await fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();

const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'planflow-test-'));
const MOCK = path.join(STATE_DIR, 'mock-planner.json');
// queue: planner の生出力を 1 コールずつ shift。① clarify(Q1) ② clarify(Q2) ②' clarify(再回答ターン用・mode=clarify を保つ) ③ plan(steps)
writeFileSync(MOCK, JSON.stringify([
  { clarify: [{ question: 'Q1' }] },
  { clarify: [{ question: 'Q2' }] },
  { clarify: [{ question: 'Q2' }] },
  { steps: [{ action: 'summarize the input', kind: 'prompt' }] },
]));

const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'mock'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, STATE_DIR, SHENRON_MOCK_PLANNER: MOCK, SHENRON_NO_AUTOSPAWN: '1', SHENRON_NO_SCHEDULER: '1', SHENRON_NO_ESCALATE: '1' } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { try { await get('/api/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('no boot'); };

try {
  await waitUp();

  // ① 1 ターン目: goal だけ → planner が clarify(Q1) を返す（plan せず質問・保存しない）
  const r1 = await post('/api/shenron/plan', { goal: 'build a thing' });
  assert.equal(r1.mode, 'clarify', '① mode=clarify');
  assert.equal(r1.clarify[0].question, 'Q1', '① clarify[0].question=Q1');

  // ② 2 ターン目: Q1 への回答 + 前 brief を返す → planner が clarify(Q2)、brief.confirmed に Q1:A1 が蓄積（PC2 の核心）
  const r2 = await post('/api/shenron/plan', { goal: 'build a thing', context: { choices: [{ question: 'Q1', answer: 'A1' }], brief: r1.brief } });
  assert.equal(r2.mode, 'clarify', '② mode=clarify');
  assert.ok(r2.brief.confirmed.includes('Q1: A1'), '② brief.confirmed に "Q1: A1"（多ターン蓄積＝回答が server に保持）');

  // ②' #2 dedup-by-question 番兵: 同じ Q1 を別回答で再送 → confirmed は最新だけ（古い "Q1: A1" を質問キーで上書き・重複させない）
  const r2b = await post('/api/shenron/plan', { goal: 'build a thing', context: { choices: [{ question: 'Q1', answer: 'A1-revised' }], brief: r2.brief } });
  assert.ok(r2b.brief.confirmed.includes('Q1: A1-revised'), "②' 再回答が最新で反映");
  assert.ok(!r2b.brief.confirmed.includes('Q1: A1'), "②' 旧回答は dedup-by-question で消える（#2・mergeBrief 質問キー上書き）");

  // ③ 4 ターン目: Q2 回答 + 前 brief + save → planner が steps を返し buildPlanIR→validateFlow→saveWorkflow が実走
  const r3 = await post('/api/shenron/plan', { goal: 'build a thing', save: true, context: { choices: [{ question: 'Q2', answer: 'A2' }], brief: r2b.brief } });
  assert.ok(r3.steps.length > 0, '③ steps.length>0（plan に遷移）');
  assert.ok(r3.workflowId, '③ workflowId 有り（保存パイプライン実走）');

  console.log('test_planflow_http: OK — 3 turns clarify→clarify→plan via mock seam (PC2 配管の HTTP 番兵)');
} finally {
  hub.kill();
}
