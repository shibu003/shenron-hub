// spike0_detect.mjs — 神龍 ゲート1（gap 検出）精度スパイク。docs/13 §1.5-E/F。
// 問い: goal の各 step が「在庫ツールで covered か / 真の gap か」を、どの機構が一番正しく当てるか。
// 比較: keyword scorer（現 hub の searchIntegrationsRefs 相当）vs LLM-resolve（BYOAI = claude -p）。
//   port 代数は §1.5-F で accepts/emits が "*" 支配＝何でも交差 true と確定済み → ここでは比較しない。
// 使い方:  node spike0_detect.mjs            （keyword のみ・即時）
//          node spike0_detect.mjs --llm 6    （先頭 6 step を LLM-resolve でも判定。claude CLI 要・遅い）
// ponytail: throwaway 測定。production コードではない。labeled set がこのスパイクの本体。
import { runVendorAsync } from '../runner.mjs';

// ---- 在庫（name + 説明）。小さく現実的に。----
const INV = [
  { id: 'slack.post_message',  desc: 'Post a message to a Slack channel' },
  { id: 'gmail.send_email',    desc: 'Send an email via Gmail' },
  { id: 'gmail.create_draft',  desc: 'Create a draft email in Gmail' },
  { id: 'github.list_commits', desc: 'List commits in a GitHub repository' },
  { id: 'notion.create_page',  desc: 'Create a page in Notion' },
  { id: 'sheets.append_row',   desc: 'Append a row to a Google Sheet' },
  { id: 'llm.summarize',       desc: 'Summarize text with a language model' },
  { id: 'http.get',            desc: 'Fetch a URL over HTTP GET' },
];

// ---- 10 goal → step。truth = covered なら tool id、真の gap なら null。trap = 露出させたい失敗モード。----
const CASES = [
  { g: 1, step: "pull the past week of code changes from the repo", truth: 'github.list_commits', trap: 'OVER: semantic=commits, low token overlap' },
  { g: 1, step: "summarize them into three lines",                  truth: 'llm.summarize',       trap: '' },
  { g: 1, step: "post the summary to the team Slack channel",       truth: 'slack.post_message',  trap: '' },

  { g: 2, step: "extract the text from a PDF file",                 truth: null,                  trap: 'GAP: no pdf tool' },
  { g: 2, step: "summarize the extracted text",                    truth: 'llm.summarize',       trap: '' },
  { g: 2, step: "save the summary as a Notion page",               truth: 'notion.create_page',  trap: '' },

  { g: 3, step: "fetch yesterday's Stripe revenue",                truth: null,                  trap: 'GAP: no stripe tool' },
  { g: 3, step: "email the figure to the founders",                truth: 'gmail.send_email',    trap: '' },

  { g: 4, step: "detect a newly opened GitHub issue",              truth: null,                  trap: 'UNDER: shares "github" with list_commits, but issues≠commits' },
  { g: 4, step: "ping the team on Discord",                        truth: null,                  trap: 'GAP: only slack, no discord' },

  { g: 5, step: "grab the contents of a web address",              truth: 'http.get',            trap: 'OVER: semantic=http fetch, ~zero token overlap' },
  { g: 5, step: "pull out the key points",                        truth: 'llm.summarize',       trap: 'loose semantic' },
  { g: 5, step: "append them as a row in the spreadsheet",        truth: 'sheets.append_row',   trap: '' },

  { g: 6, step: "write a draft sales email to a prospect",        truth: 'gmail.create_draft',  trap: 'NEAR-DUP: send_email vs create_draft' },

  { g: 7, step: "read the questions people asked in the channel", truth: null,                  trap: 'UNDER: "channel" matches post_message, but it posts not reads' },
  { g: 7, step: "summarize the questions",                        truth: 'llm.summarize',       trap: '' },
  { g: 7, step: "email a digest every morning",                  truth: 'gmail.send_email',    trap: '' },

  { g: 8, step: "list the latest commits",                       truth: 'github.list_commits', trap: 'straight match' },
  { g: 8, step: "record them on a Notion page",                  truth: 'notion.create_page',  trap: '' },

  { g: 9, step: "transcribe an audio recording",                 truth: null,                  trap: 'GAP: no transcription tool' },
  { g: 9, step: "summarize the transcript",                      truth: 'llm.summarize',       trap: '' },

  { g: 10, step: "fetch the current weather forecast",           truth: null,                  trap: 'GAP: http.get too generic to be a usable node' },
  { g: 10, step: "post it to Slack each morning",                truth: 'slack.post_message',  trap: '' },
];

// self-check: labeled set が在庫と整合しているか（truth の tool が実在するか）。
for (const c of CASES) if (c.truth !== null && !INV.find((t) => t.id === c.truth)) throw new Error('bad test data: ' + c.truth);

// ---- keyword 検出器（hub の tok/kw を faithful 再実装）----
const tok = (s) => (s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const hits = (toolText, step) => { const hay = ' ' + tok(toolText).join(' ') + ' '; return [...new Set(tok(step))].filter((t) => t.length >= 3).reduce((n, t) => n + (hay.includes(` ${t} `) ? 1 : 0), 0); };
function kwDetect(step) {
  let best = { id: null, s: 0 };
  for (const t of INV) { const s = hits(t.id.replace(/[._]/g, ' ') + ' ' + t.desc, step); if (s > best.s) best = { id: t.id, s }; }
  return best.s > 0 ? best.id : null;     // null = 「missing」と予測
}

// ---- LLM-resolve 検出器（BYOAI = claude -p）----
async function llmDetect(step) {
  const inv = INV.map((t) => `${t.id}: ${t.desc}`).join('\n');
  const sys = `Available tools:\n${inv}\n\nStep: "${step}"\nDoes one of the tools above genuinely cover this step? A generic tool does NOT cover a specific need. Reply ONLY JSON: {"covered":true|false,"tool":"<id or null>"}.`;
  const out = await runVendorAsync('claude', sys, '');
  try { const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); return j.covered ? j.tool : null; }
  catch { return '__ERR__'; }
}

// ---- 混同行列（positive = 「missing」）----
async function evaluate(name, detect, cases) {
  let TP = 0, FP = 0, FN = 0, TN = 0, wrongTool = 0, err = 0;
  const misses = [];
  for (const c of cases) {
    const pred = await detect(c.step);
    if (pred === '__ERR__') { err++; continue; }
    const predMissing = pred === null, truthMissing = c.truth === null;
    if (predMissing && truthMissing) TP++;
    else if (predMissing && !truthMissing) { FP++; misses.push(`  OVER  "${c.step}" → said gap, but ${c.truth} exists`); }
    else if (!predMissing && truthMissing) { FN++; misses.push(`  UNDER "${c.step}" → said ${pred} covers it, but it's a real gap`); }
    else { TN++; if (pred !== c.truth) { wrongTool++; misses.push(`  WRONG "${c.step}" → matched ${pred}, should be ${c.truth}`); } }
  }
  const haveN = cases.filter((c) => c.truth !== null).length, missN = cases.filter((c) => c.truth === null).length;
  const pct = (n, d) => d ? (100 * n / d).toFixed(0) + '%' : '–';
  console.log(`\n=== ${name} (${cases.length - err}/${cases.length} scored${err ? `, ${err} LLM errors` : ''}) ===`);
  console.log(`  gap 正解 TP=${TP}  過検出 FP=${FP}  過小検出 FN=${FN}  covered TN=${TN}  うち誤ツール wrongTool=${wrongTool}`);
  console.log(`  過検出率(FP/have=${haveN}) ${pct(FP, haveN)}   過小検出率(FN/missing=${missN}) ${pct(FN, missN)}   誤ツール率(/covered=${TN + wrongTool}) ${pct(wrongTool, TN + wrongTool)}`);
  if (misses.length) console.log(misses.join('\n'));
}

// ---- run ----
const i = process.argv.indexOf('--llm');
const N = i > -1 ? (Number(process.argv[i + 1]) || CASES.length) : 0;
await evaluate('keyword', (s) => Promise.resolve(kwDetect(s)), CASES);
if (N) await evaluate(`LLM-resolve (first ${N})`, llmDetect, CASES.slice(0, N));
