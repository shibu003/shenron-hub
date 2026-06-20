// spike1_gen.mjs — 神龍 gate2 (生成→実行→修復ループ) 収束スパイク。docs/13 §1.5-E / §賭けの中心。
// 問い: LLM は「動く Langflow custom component」を、生成→実行→エラー→修復のループで収束させられるか。
// killer: ② Component API ドリフト / ③ 依存欠落 / ④ 外部 API 形の幻覚。keyless 公開 API で creds 無しに ②③④ を一度に test。
// 設計: production は API を memory 頼みにせず注入する → 現行 Component API を introspect して /tmp/lf_api.txt から prompt に注入。
//       それでも収束するか（残る ③④ と微妙な形ズレ）を、修復ループ ≤5 反復で測る。BYOAI = claude -p。
// 使い方: node spike1_gen.mjs            （全 gap）  /  node spike1_gen.mjs github  （1 gap だけ）
// 前提: /tmp/lf-venv に langflow、/tmp/lf_api.txt に API ヒント、prototype/hub/spike1_runner.py。
// ponytail: throwaway 測定。production コードではない。
import { runVendorAsync } from '../runner.mjs';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const VENV_PY = '/tmp/lf-venv/bin/python';
const RUNNER = new URL('./spike1_runner.py', import.meta.url).pathname;
const DIR = '/tmp/spike1'; mkdirSync(DIR, { recursive: true });
const API_HINT = (() => { try { return readFileSync('/tmp/lf_api.txt', 'utf8'); } catch { return '(no API hint file — generating from model memory only)'; } })();
const MAX_ITERS = 5;

// keyless 公開 API（creds 不要・build() が実際に完走できる＝exit0 到達可能）。target は hardcode させ input 配線を排除。
const GAPS = [
  { key: 'github', name: 'GithubStars', task: "return the star count of the public GitHub repo 'langflow-ai/langflow'. Use the public REST API https://api.github.com/repos/langflow-ai/langflow (no auth; the JSON field is 'stargazers_count'). Hardcode that repo." },
  { key: 'weather', name: 'TokyoTemp', task: "return the current temperature in Tokyo. Use the free open-meteo API https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.69&current=temperature_2m (no key; read current.temperature_2m). Hardcode those coordinates." },
  { key: 'xkcd', name: 'LatestXkcd', task: "return the title of the latest xkcd comic. Use https://xkcd.com/info.0.json (no key; the JSON field is 'title')." },
];

const fence = (s) => { const m = s.match(/```(?:python|py)?\s*([\s\S]*?)```/i); return (m ? m[1] : s).trim(); };

function genPrompt(g, prev, err) {
  const base = `Write a Langflow custom component in Python that ${g.task}
Return it as a langflow Message whose .text is the result (string).
It MUST be runnable standalone: instantiating the class and calling its single output method with NO inputs configured must work (do not require any input to be set).
Use the CURRENT Langflow Component API shown here — do not invent fields:
${API_HINT}
Output ONLY the Python code, no prose, no markdown fences.`;
  if (!err) return base;
  return `${base}

Your previous attempt FAILED. Here is the exact code you wrote:
\`\`\`python
${prev}
\`\`\`
Running it produced this error:
\`\`\`
${err}
\`\`\`
Fix it. Output ONLY the corrected full Python code.`;
}

async function converge(g) {
  let prev = '', err = '';
  for (let i = 1; i <= MAX_ITERS; i++) {
    const out = await runVendorAsync('claude', genPrompt(g, prev, err), '');
    const code = fence(out);
    const file = `${DIR}/${g.key}.py`;
    writeFileSync(file, code);
    try {
      const res = execFileSync(VENV_PY, [RUNNER, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
      console.log(`  ✓ ${g.key} CONVERGED @ iter ${i} — ${res.trim().split('\n').pop()}`);
      return { key: g.key, ok: true, iters: i };
    } catch (e) {
      err = ((e.stderr || '') + (e.stdout || '')).trim() || e.message;
      prev = code;
      console.log(`  · ${g.key} iter ${i} failed: ${err.split('\n').filter(Boolean).pop()?.slice(0, 120)}`);
    }
  }
  return { key: g.key, ok: false, iters: MAX_ITERS };
}

const only = process.argv[2];
const gaps = only ? GAPS.filter((g) => g.key === only) : GAPS;
console.log(`=== spike1: generate→run→repair (≤${MAX_ITERS} iters), ${gaps.length} gap(s), API hint ${API_HINT.length} chars ===`);
const results = [];
for (const g of gaps) results.push(await converge(g));
const ok = results.filter((r) => r.ok);
console.log(`\n=== RESULT: ${ok.length}/${results.length} converged ` +
  `${results.map((r) => `${r.key}:${r.ok ? r.iters : 'FAIL'}`).join('  ')} ===`);
