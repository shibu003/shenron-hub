// test_runner.mjs — runner.mjs vendor matrix（🔴 load-bearing なのに ZERO だった実行点）。
// 全 flow の各 step は runVendorAsync が最終実行点。ここが約束どおり「model text」か「正しい [..→stub] sentinel」を
// 返すかを固定する（壊れると上流 plan が本物でも出力が stub に化け、isStubFail が PC0 unavailable/node 失敗に拾う）。
// 実 HTTP は叩かず globalThis.fetch を差し替え（runner は bare fetch=グローバル参照・Node18+ 既定）。
// CLI spawn 経路（codex / claude -p・runner L82-93）は spawn を伴うので対象外＝key-direct path と stub fallback に集中。
import assert from 'node:assert';
import { runVendorAsync } from '../runner.mjs';

const realFetch = globalThis.fetch;
const env0 = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, g: process.env.GEMINI_API_KEY };
const setEnv = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };   // case ごとに key を制御し finally で原状復帰＝並列 claude の env を汚さない
const reply = ({ ok = true, status = 200, json = {}, text = '' }) => { globalThis.fetch = async () => ({ ok, status, json: async () => json, text: async () => text }); };
const throws = (msg) => { globalThis.fetch = async () => { throw new Error(msg); }; };

let n = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); n++; };
const match = (s, re, m) => { assert.ok(re.test(s), `${m}: got ${JSON.stringify(String(s).slice(0, 80))}`); n++; };

try {
  // ── anthropic（claude vendor + key → direct API path）。empty/refusal は !r.ok の後段ゆえ ok:true 必須 ──
  setEnv('ANTHROPIC_API_KEY', 'x');
  reply({ json: { content: [{ type: 'text', text: 'OK' }] } });
  eq(await runVendorAsync('claude', 'p'), 'OK', 'anthropic 成功→text');
  reply({ ok: false, status: 429, text: 'rate' });
  match(await runVendorAsync('claude', 'p'), /^\[anthropic 429 → stub\]/, 'anthropic 429');
  reply({ json: { content: [] } });
  match(await runVendorAsync('claude', 'p'), /anthropic empty → stub/, 'anthropic empty');
  reply({ json: { stop_reason: 'refusal' } });
  match(await runVendorAsync('claude', 'p'), /anthropic refusal → stub/, 'anthropic refusal（safety decline）');

  // ── openai（key gate は runVendorAsync L78）──
  setEnv('OPENAI_API_KEY', null);
  match(await runVendorAsync('openai', 'p'), /openai → stub\] OPENAI_API_KEY 未設定/, 'openai keyless→fetch 未呼で stub');
  setEnv('OPENAI_API_KEY', 'x');
  reply({ json: { choices: [{ message: { content: 'X' } }] } });
  eq(await runVendorAsync('openai', 'p'), 'X', 'openai 成功→choices content');
  reply({ ok: false, status: 500, text: 'boom' });
  match(await runVendorAsync('openai', 'p'), /openai 500 → stub/, 'openai 500');

  // ── ollama（key 不要・localhost）──
  reply({ json: { response: 'Y' } });
  eq(await runVendorAsync('ollama', 'p'), 'Y', 'ollama 成功→response');
  reply({ ok: false, status: 503, text: 'down' });
  match(await runVendorAsync('ollama', 'p'), /ollama \d+ → stub/, 'ollama !ok');
  throws('conn refused');
  match(await runVendorAsync('ollama', 'p'), /ollama failed → stub/, 'ollama fetch throw（serve 落ち）');

  // ── gemini（key gate L79・blocked は candidates 無）──
  setEnv('GEMINI_API_KEY', 'x');
  reply({ json: { candidates: [{ content: { parts: [{ text: 'Z' }] } }] } });
  eq(await runVendorAsync('gemini', 'p'), 'Z', 'gemini 成功→parts text');
  reply({ json: { promptFeedback: { blockReason: 'SAFETY' } } });
  match(await runVendorAsync('gemini', 'p'), /gemini blocked → stub/, 'gemini blocked（safety・candidates 無）');

  // ── 非対応 vendor → stubOut（fetch 未呼・mock 分岐も素通り）──
  match(await runVendorAsync('stub', 'p'), /^\[stub\] \(no vendor "stub"\)/, 'unknown vendor→stubOut');

  console.log(`test_runner: OK (${n} asserts — vendor 成功 parse ＋ 全 [..→stub] fallback sentinel)`);
} finally {
  globalThis.fetch = realFetch;
  setEnv('ANTHROPIC_API_KEY', env0.a); setEnv('OPENAI_API_KEY', env0.o); setEnv('GEMINI_API_KEY', env0.g);
}
