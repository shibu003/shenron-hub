// test_nodes.mjs — Wave Cockpit-0: ノード/component 種別の parity test。
// 作業場(ui2)の palette にある全 kind が runner(advanceFrom) で実際に動くと証明し、
// palette↔dispatch の drift を test で固定する（将来ノードを足したら未分類で即 fail）。
//
// 二層構造:
//   ① behavioral — 各 runnable kind を最小 flow→/api/runflow→完了まで走らせ outputs を assert。
//   ② static drift guard — ui2.html の COMP を抽出し、全 palette kind が run/fenced/strip/agent に分類されると assert。
//
// 隔離は test_tenancy.mjs と同型（STATE_DIR tmpdir + --vendor stub + AUTOSPAWN/SCHEDULER off）。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { genComponent } from './shenron.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
let bad = false;

// ───────────────────────────────────────────────────────────────────────────
// ① component 種別 — genComponent は run/sandbox を注入できる（LLM 不要で決定論的にテスト）。
//    生成→収束ループ→credential ゲートの分岐を、実 vendor/サンドボックスなしで検証。
// ───────────────────────────────────────────────────────────────────────────
{
  const okSandbox = async () => ({ ok: true, output: 'ran' });
  const codeRun = async () => '```python\ndef run(x):\n    return x.upper()\n```';   // creds 無し → 即収束
  const conv = await genComponent({ what: 'uppercase a string', vendor: 'stub', run: codeRun, sandbox: okSandbox });
  assert.equal(conv.converged, true, 'genComponent: sandbox ok → converged');
  assert.equal(conv.iters, 1, 'genComponent: 1 反復で収束');
  assert.ok(conv.code.includes('def run'), 'genComponent: code をフェンスから抽出');

  let n = 0;                                                                       // 1回 fail → repair → ok = 2 反復
  const flakySandbox = async () => (++n === 1 ? { ok: false, error: 'SyntaxError' } : { ok: true, output: 'ran' });
  const rep = await genComponent({ what: 'flaky', vendor: 'stub', run: codeRun, sandbox: flakySandbox });
  assert.equal(rep.converged, true, 'genComponent: repair ループで収束');
  assert.equal(rep.iters, 2, 'genComponent: 1回失敗→2反復目で収束');

  const noVendor = async () => '[claude failed → stub] no CLI';                    // vendor 不在 → fail-fast
  const nv = await genComponent({ what: 'x', vendor: 'stub', run: noVendor, sandbox: okSandbox });
  assert.equal(nv.converged, false, 'genComponent: vendor 不在 → 非収束');
  assert.ok(/no LLM vendor/.test(nv.error), 'genComponent: vendor 不在の理由を返す');
  console.log('OK component 種別 — genComponent 収束/repair/vendor不在 (3 分岐・LLM不要)');
}

// ───────────────────────────────────────────────────────────────────────────
// ② static drift guard — ui2.html palette の全 kind が dispatch を持つと assert。
//    COMP(10種) + 別管理の mcp/trigger/agent/note。各 kind は以下のどれかに分類されねばならない:
//      run    = fireNode(hub.mjs:486-495) に dispatch があり、下の behavioral test で実走する
//      fenced = runFlow(hub.mjs:373) が throw（langflow=host 要）→ behavioral で error を確認
//      strip  = runFlow(hub.mjs:377) で実行前に除去（trigger/note=注釈/入口マーカー）
//      agent  = fireNode fallthrough の create()（runner 要 → test_shenron が実走を担保）
//    未分類の kind が現れたら fail = palette にノードを足したのに dispatch/test を書き忘れた証拠。
//    ※ ui.html palette は Cockpit-1 で退役予定なので guard 対象外（[[feedback_skip_record]]）。
{
  const html = readFileSync(path.join(ROOT, 'prototype/hub/ui2.html'), 'utf8');
  const start = html.indexOf('const COMP = {');
  assert.ok(start >= 0, 'ui2.html: const COMP = { が見つかる');
  const block = html.slice(start, html.indexOf('\n};', start));
  const compKinds = [...block.matchAll(/^\s+(\w+):\s*\{/gm)].map((m) => m[1]);
  const palette = new Set([...compKinds, 'mcp', 'trigger', 'agent', 'note']);     // COMP 外で addMcpNode/addTrigger/agent picker/NOTES が生む kind

  const RUN = new Set(['input', 'output', 'model', 'router', 'mcp', 'workflow', 'parser']);   // R1: prompt/languagemodel/structured/consensus → 統合 model（旧 kind は backend dispatch に温存し ③ で後方互換を実走確認）
  const FENCED = new Set(['langflow']);
  const STRIP = new Set(['trigger', 'note']);
  const AGENT = new Set(['agent']);
  const classified = new Set([...RUN, ...FENCED, ...STRIP, ...AGENT]);

  for (const k of palette)
    assert.ok(classified.has(k), `palette kind "${k}" が未分類 — fireNode(hub.mjs:486) に dispatch を足し test_nodes.mjs に run test を追加せよ`);
  for (const k of classified)
    assert.ok(palette.has(k), `分類済み kind "${k}" が palette(ui2.html COMP)に無い — palette から消えた？ test 側も整理せよ`);
  console.log(`OK parity guard — palette ${palette.size} kind すべて分類済み (run/fenced/strip/agent)`);
}

// ───────────────────────────────────────────────────────────────────────────
// ③ behavioral — hub を起動し、各 runnable kind を最小 flow で実走して完了を assert。
// ───────────────────────────────────────────────────────────────────────────
const PORT = 8912, HUB = 'http://localhost:' + PORT;
const get = async (p) => (await fetch(HUB + p)).json();
const post = async (p, b) => (await fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'nodes-test-'));
const GEN_PY = path.join(ROOT, 'prototype/mcp/generated/test-nodes-comp.py');     // approve が repo に書く → finally で掃除
const hub = spawn('node', ['prototype/hub/hub.mjs', '--port', String(PORT), '--vendor', 'stub'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, STATE_DIR, SHENRON_NO_AUTOSPAWN: '1', SHENRON_NO_SCHEDULER: '1', SHENRON_NO_ESCALATE: '1' } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { try { await get('/api/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('no boot'); };

// flow を走らせて完了 run を返す（async ノードはポーリングで待つ）。POST が throw した場合は {error} を返す。
const runAndWait = async (nodes, edges, input) => {
  const r = await post('/api/runflow', { nodes, edges, input: input || '' });
  if (!r.runId) return r;                                                         // 例: langflow → {error}
  for (let i = 0; i < 80; i++) {                                                  // 最大 8s
    const run = await get('/api/runs/' + r.runId);
    if (run.status !== 'running') return run;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('run did not finish: ' + r.runId);
};

try {
  await waitUp();

  // input → output（baked text の素通り・同期）
  let run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'hello' } }, { id: 'o', kind: 'output' }], [{ source: 'i', target: 'o' }]);
  assert.equal(run.status, 'completed', 'input/output run 完了');
  assert.equal(run.outputs.o, 'hello', 'input が baked text を emit → output が素通し');
  console.log('OK input + output');

  // prompt（テンプレート整形 + in-process vendor=stub）
  run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'world' } }, { id: 'p', kind: 'prompt', config: { template: 'Hi {input}' } }, { id: 'o', kind: 'output' }],
    [{ source: 'i', target: 'p' }, { source: 'p', target: 'o' }]);
  assert.equal(run.status, 'completed', 'prompt run 完了');
  assert.ok(run.outputs.p.includes('world') && !run.outputs.p.includes('→ stub]'), 'prompt: {input} 置換 + stub 成功');
  console.log('OK prompt');

  // languagemodel（= prompt + system preamble）
  run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'world' } }, { id: 'lm', kind: 'languagemodel', config: { system: 'You are X' } }, { id: 'o', kind: 'output' }],
    [{ source: 'i', target: 'lm' }, { source: 'lm', target: 'o' }]);
  assert.equal(run.status, 'completed', 'languagemodel run 完了');
  assert.ok(run.outputs.lm.includes('world') && !run.outputs.lm.includes('→ stub]'), 'languagemodel: 入力を含む stub 出力');
  console.log('OK languagemodel');

  // structured（JSON を求める prompt）
  run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'world' } }, { id: 's', kind: 'structured', config: { schema: 'name,age', instructions: 'extract' } }, { id: 'o', kind: 'output' }],
    [{ source: 'i', target: 's' }, { source: 's', target: 'o' }]);
  assert.equal(run.status, 'completed', 'structured run 完了');
  assert.ok(run.outputs.s.includes('JSON') && !run.outputs.s.includes('→ stub]'), 'structured: JSON 指示を含む stub 出力');
  console.log('OK structured');

  // consensus（複数 vendor → 合意・stub なので決定論的）
  run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'topic' } }, { id: 'c', kind: 'consensus', config: { vendors: 'claude,codex', prompt: 'rank' } }, { id: 'o', kind: 'output' }],
    [{ source: 'i', target: 'c' }, { source: 'c', target: 'o' }]);
  assert.equal(run.status, 'completed', 'consensus run 完了');
  assert.ok(run.outputs.c.includes('consensus'), 'consensus: 合意ヘッダ付き出力');
  console.log('OK consensus');

  // model（R1 統合ノード — config.mode で旧4種に委譲。plain と consensus を代表で実走）
  run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'world' } }, { id: 'mp', kind: 'model', config: { mode: 'plain', template: 'Hi {input}' } }, { id: 'o', kind: 'output' }],
    [{ source: 'i', target: 'mp' }, { source: 'mp', target: 'o' }]);
  assert.equal(run.status, 'completed', 'model(plain) run 完了');
  assert.ok(run.outputs.mp.includes('world') && !run.outputs.mp.includes('→ stub]'), 'model(plain): {input} 置換 + stub 成功');
  run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'topic' } }, { id: 'mc', kind: 'model', config: { mode: 'consensus', vendors: 'claude,codex', prompt: 'rank' } }, { id: 'o', kind: 'output' }],
    [{ source: 'i', target: 'mc' }, { source: 'mc', target: 'o' }]);
  assert.equal(run.status, 'completed', 'model(consensus) run 完了');
  assert.ok(run.outputs.mc.includes('consensus'), 'model(consensus): 合意ヘッダ付き出力');
  console.log('OK model (plain + consensus modes)');

  // parser（純文字列整形・LLM 不使用・同期）
  run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'NAME' } }, { id: 'pp', kind: 'parser', config: { pattern: 'Hello {input}!' } }, { id: 'o', kind: 'output' }],
    [{ source: 'i', target: 'pp' }, { source: 'pp', target: 'o' }]);
  assert.equal(run.outputs.pp, 'Hello NAME!', 'parser: {input} 置換（LLM なし）');
  console.log('OK parser');

  // router（条件分岐 — then を発火・else を dead/skip）
  run = await runAndWait(
    [{ id: 'i', kind: 'input', config: { text: '[redacted:ssn] hi' } }, { id: 'r', kind: 'router', config: { predicate: 'redacted' } }, { id: 't', kind: 'output' }, { id: 'e', kind: 'output' }],
    [{ source: 'i', target: 'r' }, { source: 'r', target: 't', branch: 'then' }, { source: 'r', target: 'e', branch: 'else' }]);
  assert.equal(run.status, 'completed', 'router run 完了');
  assert.equal(run.routerPick.r, 'then', 'router: redacted → then 分岐');
  assert.ok('t' in run.outputs, 'router: then 側 output が発火');
  assert.ok(run.skipped.includes('e'), 'router: else 側は skip（dead-branch elimination）');
  console.log('OK router');

  // workflow（保存済みフローを sub-flow として nested run）
  const child = await post('/api/workflows', { name: 'tn-child', nodes: [{ id: 'ci', kind: 'input', config: { text: 'CHILD' } }, { id: 'co', kind: 'output' }], edges: [{ source: 'ci', target: 'co' }] });
  assert.ok(child.id, 'sub-flow 用 child flow 保存');
  run = await runAndWait([{ id: 'w', kind: 'workflow', ref: child.id }, { id: 'o', kind: 'output' }], [{ source: 'w', target: 'o' }]);
  assert.equal(run.status, 'completed', 'workflow run 完了');
  assert.equal(run.outputs.o, 'CHILD', 'workflow: nested run の結果が親に伝播');
  console.log('OK workflow (sub-flow)');

  // mcp（外部副作用 — integration 無しの error-path で dispatch + 完了を確認）
  run = await runAndWait([{ id: 'i', kind: 'input', config: { text: 'x' } }, { id: 'm', kind: 'mcp', server: 'ghost-xyz', tool: 'run' }, { id: 'o', kind: 'output' }],
    [{ source: 'i', target: 'm' }, { source: 'm', target: 'o' }]);
  assert.equal(run.status, 'completed', 'mcp run 完了（error でも run は終わる）');
  assert.ok(run.outputs.m.startsWith('[error]') && run.outputs.m.includes('integration'), 'mcp: 未接続 integration を error として表面化');
  console.log('OK mcp (error-path dispatch)');

  // langflow（host 要 → 実行不可。runFlow が fence して throw → POST は 400+error）
  const lf = await runAndWait([{ id: 'l', kind: 'langflow', config: {} }], []);
  assert.ok(lf.error && /Langflow/.test(lf.error), 'langflow: runFlow が fence して error（host 要・[[feedback_skip_record]]）');
  console.log('OK langflow (fenced — host 要で skip)');

  // component 再利用（approve → mcp integration として ladder rejoin）
  writeFileSync(path.join(STATE_DIR, 'components.json'),
    JSON.stringify([{ id: 'test-nodes-comp', what: 'echo input', code: 'def run(input):\n    return input\n', iters: 1, approved: false, createdAt: new Date().toISOString() }]));
  const appr = await post('/api/shenron/components/approve', { id: 'test-nodes-comp' });
  assert.equal(appr.integration, 'test-nodes-comp', 'approve: 部品が mcp integration として登録（ladder rejoin）');
  const integ = (await get('/api/integrations')).find((x) => x.id === 'test-nodes-comp');
  assert.ok(integ && integ.generated === true && /generated\/test-nodes-comp\.py/.test(integ.command), 'approve: integration が生成 py を指す（mcp node として再利用可能）');
  assert.ok((integ.tools || []).some((t) => t.name === 'run'), 'approve: run tool を持つ');
  console.log('OK component approve → mcp integration (ladder rejoin)');

  console.log('\n✅ test_nodes.mjs — 全ノード/component 種別 parity green');
} catch (e) { bad = true; console.error('FAIL', e.stack || e.message); }
finally {
  hub.kill();
  if (existsSync(GEN_PY)) rmSync(GEN_PY, { force: true });                         // approve が repo に書いた py を掃除（commit 混入防止）
}
process.exit(bad ? 1 : 0);
