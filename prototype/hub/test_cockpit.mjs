// test_cockpit.mjs — cockpit-logic.mjs の純ロジック番兵（client 側）。
// PC2「回答蒸発」バグは client にあった（旧 submitClarify は選択肢テキストのみ／2回目で reset→1回目消失）。
// pairChoices を importable module に出し、HTML と同一コードを単体で固定＝この契約を revert で壊すと落ちる番兵。
// server 端は T0 test_planflow_http（brief 蓄積）が固める＝両端で「ペアであること」を保証。
import assert from 'node:assert';
import { pairChoices } from './cockpit-logic.mjs';

let n = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// 基本: clarify の質問 × user 選択 → {question,answer} pair（bare 文字列だと planner がどの質問の答えか不明）
eq(pairChoices({ clarify: [{ question: 'Q1' }] }, { 0: 'A1' }), [{ question: 'Q1', answer: 'A1' }], '基本ペア化');

// PC2 核心: 未選択 index は除外（答えた分だけ送る・蒸発させない）
eq(pairChoices({ clarify: [{ question: 'Q1' }, { question: 'Q2' }] }, { 0: 'A1' }),
  [{ question: 'Q1', answer: 'A1' }], '未選択 Q2 を除外');

// 複数全選択
eq(pairChoices({ clarify: [{ question: 'Q1' }, { question: 'Q2' }] }, { 0: 'A1', 1: 'A2' }),
  [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }], '複数ペア');

// 空・null 安全（client は null/未設定を渡しうる＝PC2 で helper を total 化した教訓）
eq(pairChoices({ clarify: [] }, {}), [], 'clarify 空→[]');
eq(pairChoices(null, {}), [], 'plan null→[]');
eq(pairChoices({ clarify: [{ question: 'Q1' }] }, null), [], 'choices null→全除外で []');
eq(pairChoices({}, { 0: 'A1' }), [], 'clarify 無し→[]');

// `!= null`（`!` でない）境界: 0/'' な回答も「選択あり」として残す
eq(pairChoices({ clarify: [{ question: 'Q1' }] }, { 0: 0 }), [{ question: 'Q1', answer: 0 }], '回答 0 は有効（!= null）');

console.log(`test_cockpit: OK (${n} asserts — pairChoices / PC2 回答蒸発の client 番兵)`);
