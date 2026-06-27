// cockpit-logic.mjs — shenron.html（cockpit）の純ロジックを importable module に出した単一の正本。
// HTML（Alpine app）と test_cockpit.mjs が同じ関数を共有＝二重実装を消し、client 側ロジックに revert で落ちる番兵を作る。
// client 専用＝flow/node には触れない。hub は GET /cockpit-logic.mjs で配信（generic static は作らず明示 route 1 本のみ）。

// PC2「回答蒸発」バグの直撃点: clarify の各質問と user の選択を {question,answer} pair にする。
// bare 文字列だと planner がどの質問への答えか分からない／未選択(index が null)は除外。
// 出力は POST /api/shenron/plan の context.choices に入り、server 側 mergeBrief(PC2) が confirmed に蓄積する
// ＝T0 test_planflow_http が server 端、本関数が client 端で「ペアであること」の契約を両端から固める。
export function pairChoices(plan, clarifyChoices) {
  return (plan?.clarify || [])
    .map((q, qi) => (clarifyChoices?.[qi] != null ? { question: q.question, answer: clarifyChoices[qi] } : null))
    .filter(Boolean);
}
