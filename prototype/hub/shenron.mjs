// shenron.mjs — 神龍 plan 層（Wave 1）。自然文 goal → plan IR。docs/13 §1.5・§5 Wave 1。
// spike 接地の設計:
//  - LLM は steps[] だけ吐く（§1.5-G: claude -p は生テキスト・structured output 不可）。nodes/edges は確定コードで組む。
//  - 各 step の have/missing は LLM-resolve（§1.5-F gate1, spike0: 危険な過小検出 0%）。
//    プロンプトに「generic ツールは specific need を covered しない」を明記（spike0 でこれが効いた）。inventory を注入。
//  - nodes/edges の port 検証・layout は hub 側（validateFlow/layoutFlow）に委譲。ここは raw を返す。
import { runVendorAsync } from '../runner.mjs';
import { redact } from '../trust.mjs';                       // Wave R-1: judge は actual を vendor へ送る新 egress → 送信前に必ず firewall
import { callMcpTool, safeEnv, SECRET_RE } from '../mcp/mcp-client.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// LLM が step.tool に入れてよい id（または null）を列挙した inventory テキスト。
function inventoryText({ agents = [], tools = [], workflows = [] }) {
  const lines = [];
  for (const a of agents) lines.push(`agent:${a.id} — ${a.skill || 'task'}`);
  for (const t of tools) lines.push(`mcp:${t.id} — ${t.name}`);            // t = { id: "<integ>.<tool>", name }; Wave 9: 承認済み生成部品も実 integration の run tool (mcp:cmp-xxx.run) としてここに出る
  for (const w of workflows) lines.push(`workflow:${w.id} — ${w.name || w.id}`);
  return lines.length ? lines.join('\n') : '(no tools/agents registered yet — everything specific is a gap)';
}

// Wave 8/9 — 生成部品の cache 照合（pure・gen-component の重複生成回避）。componentKey で what を正規化、matchComponent は
// approved 済みのみ拾う（§I「無人パスで踏むのは vetted ノードのみ」）。承認後は実 integration になり planner inventory 経由で
// 解決される（buildPlanIR の vetted placeholder は Wave 9 で廃止）。fs は hub 側。
export const componentKey = (what) => String(what || '').toLowerCase().replace(/\s+/g, ' ').trim();   // ponytail: 文字正規化のみ。意味的 dedup は v2
export const matchComponent = (components, what) => {
  const k = componentKey(what);
  return (components || []).find((c) => c.approved && componentKey(c.what) === k) || null;
};

const PROMPT = (goal, inv, choices, cost) => `You plan an automation flow. Goal: "${goal}".${choices ? `\nThe user already answered these — use them and proceed to a plan:\n${choices}` : ''}
Inventory — tools/agents already registered here (use these exact ids in step.tool, or null):
${inv}
Built-in: kind "prompt" (an LLM step, no tool) is always available. Agent "agent:browser-control" drives a REAL BROWSER with the user's own login (open/click/type/submit; outbound actions are human-approved at run time) — use it for a service that has a UI but NO usable API/MCP.
COST MODE = ${cost === 'paid_ok' ? 'paid_ok' : 'free'}. ${cost === 'paid_ok'
  ? 'You MAY use paid tools/APIs/services, but ALWAYS disclose each recurring or per-use cost in blockers/summary so the user knows what they are paying.'
  : 'Prefer FREE / $0-marginal options only (free or free-tier APIs, free MCP servers, Apps Script free tier, browser-control on the user\'s own login, the user\'s own LLM subscription, local models). If a step can ONLY be done via a paid tool/service or a metered/paid API, DO NOT silently use it — surface it as a clarify/blocker so the user can opt in (or pick a free path).'}
MINIMIZE COST always (even in paid_ok): pick the cheapest path that still works — use the FEWEST LLM steps (collapse what one prompt can do; a deterministic API/MCP/code step costs ~nothing vs an LLM step), REUSE a registered tool or a cached generated component instead of generating anew, default each step to tier "cheap" (the user's free subscription / a small model), and ESCALATE to a strong/paid model or a paid tool ONLY when it genuinely changes the outcome.

DISCOVER FIRST (Wave: mandatory). Before planning, RESEARCH the goal (use web search if you have it) across EVERY way to do it — the registered tools above, public/free APIs, free MCP servers, external platforms (e.g. Google Apps Script for Google+schedule, Zapier), browser-control, or generating a new tool — AND check for BLOCKERS (no API exists; the service's ToS forbids automation; it needs a paid/registered account or a license; legal risk; the goal needs SCHEDULED/recurring runs — classify it: if the recurring work is API-only (no login/browser needed) it can run with NO always-on machine via a free serverless cron (e.g. Google Apps Script / Cloudflare Cron) — recommend that; if it needs the user's own login/browser (browser-control), it must run on the user's machine — the in-hub scheduler fires while the hub host is up and catches up missed runs on next boot, but a fully-off phone-only user can't run it, so surface that and offer "keep a cheap always-on box / wake the machine on schedule").
If the goal is AMBIGUOUS (several services/platforms could satisfy it — e.g. "start a social media" → X vs Instagram vs Facebook), or multiple mechanisms are genuinely viable, or you found a blocker the user must weigh — DO NOT invent steps. Output ONLY:
{"clarify":[{"question":"<ask the user>","options":["<opt>","<opt>"],"why":"<why it matters>"}],"blockers":["<blocker + the reason, e.g. ToS/license/no-API>"]}
Only when it is unambiguous (or the answers above resolve it), output the plan ONLY:
{"plain_summary":"<one sentence>","blockers":["<caveat or omit>"],"ui_hint":"none|generate","steps":[{"action":"<short>","kind":"mcp|agent|prompt|parser|structured|router|consensus","tool":"<inventory id or null>","tier":"cheap|strong","fields":"<structured only: comma-sep field names>","condition":"<router only: contains:<word> | clean | always>","branch":"<then|else — ONLY on a step that is a router branch>"}]}
ui_hint = "generate" ONLY when the flow's artifact genuinely requires human interaction beyond a simple approval — e.g. choosing from a list, filling a form, editing output, a dashboard to review before deciding, a visualization to interpret. ui_hint = "none" when notification/webhook/approval channels (Slack, email, message) are sufficient for the output — the user reads but does not need to operate a custom UI.
Per step: use the exact inventory id ONLY if it GENUINELY covers the need (a generic tool does NOT cover a specific need → null). Prefer an mcp tool/API; fall back to agent:browser-control only when UI-only (no API).
Per step also set "tier" to route the model by content & cost: "cheap" for mechanical work (summarize, classify, extract, format, route, simple rewrite) and "strong" for hard judgment (reasoning, decisions, code generation, planning, anything error-sensitive). The runtime maps cheap→a small/cheap model and strong→a frontier model per the user's budget — so default to "cheap" unless the step genuinely needs frontier judgment (saves the user money).
DESIGN THE WHOLE FLOW — pick the RIGHT node type per step (not just a prompt chain) and CONNECT them into the actual shape of the work:
- "parser" = DETERMINISTIC text formatting with NO LLM ($0). Use it instead of a prompt whenever the transform is mechanical (fill a template, join/wrap text, fixed reformat). Put the template in "action" with {input} where the upstream value goes.
- "structured" = the output must be JSON with specific fields — set "fields":"name,email,date". The runtime asks the model for that JSON.
- "router" = a CONDITIONAL BRANCH that splits the flow. Set "condition" (e.g. "contains:error" / "clean" / "always"). Immediately follow the router with its branch steps, each tagged "branch":"then" or "branch":"else"; the next plain step after the branches is where they rejoin.
  MANDATORY: if the goal contains ANY conditional ("if … otherwise / 緊急なら…そうでなければ / when X do A else B"), you MUST express it as a router + then/else branch steps — do NOT flatten the branch into a single prose prompt.
- "prompt" = free-form LLM step (writing/judgment). "consensus" = N-model vote (see below).
Prefer the cheapest correct type: parser (·$0) > one cheap prompt > structured/strong prompt > consensus.
EXAMPLE — goal "summarize each email; if it's urgent notify Slack, otherwise log it" →
"steps":[{"action":"fetch unread emails","kind":"mcp","tool":"mcp:gmail.search_threads"},
{"action":"summarize and judge urgency (output URGENT or NORMAL)","kind":"prompt","tier":"cheap"},
{"action":"urgent?","kind":"router","condition":"contains:URGENT"},
{"action":"post a Slack alert","kind":"mcp","tool":"mcp:slack.send","branch":"then"},
{"action":"append to the log","kind":"parser","branch":"else"}]
(the if/else became a router with then/else branch steps that rejoin — do the same for any conditional goal.)
kind "consensus" = run the step on N different models in parallel and take the voted (medoid) answer. It costs ~N× a normal step, so use it RARELY — ONLY for a HIGH-STAKES judgment that is error-sensitive or hard to undo AND has no deterministic check to fall back on (e.g. a final go/no-go decision, a legal/medical/financial reading). For everything else a single "cheap" prompt is correct. Never use consensus for mechanical work.
Output ONLY the JSON object.`;

// pure: parsed LLM output → plan IR（raw nodes/edges, port 検証は呼び出し側）。test 対象。
// gap: 'off'|'ask'|'auto' — 解決不能 step（既存ツールで埋まらない mcp/agent）をどう扱うか。off=buildable gap を作らず
// best-effort prompt 化（神龍に自己拡張＝道具生成させない）／ask(既定)=⚠️ gap を出し人が codegen 起動／auto=同上＋自動起動(caller 側)。
const BUILTIN_KINDS = ['prompt', 'consensus', 'parser', 'structured', 'router', 'languagemodel'];   // node kinds the runtime runs WITHOUT an external tool (fireNode handles each)
// router "condition" → node config { predicate, value } that fireRouterNode understands (predicate ∈ redacted|clean|contains|always).
function routerCfg(condition) {
  const c = String(condition || 'always').trim();
  const m = c.match(/^contains\s*[:=]\s*(.+)$/i);
  if (m) return { predicate: 'contains', value: m[1].trim() };
  if (/^(redacted|clean|always)$/i.test(c)) return { predicate: c.toLowerCase() };
  return c ? { predicate: 'contains', value: c } : { predicate: 'always' };   // bare word → contains:<word>
}
export function buildPlanIR(goal, parsed, source = 'llm', gap = 'ask') {
  const steps = (parsed.steps || []).map((s, i) => ({ n: i + 1, action: s.action || '',
    kind: ['mcp', 'agent', ...BUILTIN_KINDS].includes(s.kind) ? s.kind : 'prompt', tool: s.tool || null, have: !!s.tool || BUILTIN_KINDS.includes(s.kind),   // built-ins (prompt/parser/structured/router/…) need no tool → never a gap
    tier: s.tier === 'strong' ? 'strong' : s.tier === 'cheap' ? 'cheap' : undefined,   // Wave G: 内容ごとのモデル階層（cheap=要約/分類/整形, strong=判断/codegen）
    fields: s.fields || '', condition: s.condition || '', branch: (s.branch === 'then' || s.branch === 'else') ? s.branch : null }));
  const needsTool = (s) => s.kind === 'mcp' || s.kind === 'agent';
  const missing = gap === 'off' ? [] : steps.filter((s) => needsTool(s) && !s.tool).map((s) => ({ what: s.action, kind: s.kind, step: s.n }));
  const tools_needed = steps.filter(needsTool).map((s) => ({ name: s.tool || s.action, kind: s.kind, have: !!s.tool, source: s.tool ? 'inventory' : 'gap' }));

  const nodes = [{ id: 'input-1', kind: 'input' }];
  for (const s of steps) {
    const id = `s${s.n}`, tier = s.tier ? { tier: s.tier } : {};
    if (s.kind === 'mcp' && s.tool) { const r = s.tool.replace(/^mcp:/, ''); const d = r.indexOf('.'); nodes.push({ id, kind: 'mcp', server: r.slice(0, d), tool: r.slice(d + 1) }); }
    else if (s.kind === 'agent' && s.tool) nodes.push({ id, kind: 'agent', agent: s.tool.replace(/^agent:/, '') });
    else if (s.kind === 'consensus') nodes.push({ id, kind: 'consensus', config: { prompt: s.action } });   // Wave G: high-stakes step → N vendor 合議（fireConsensusNode）
    else if (s.kind === 'parser') nodes.push({ id, kind: 'parser', config: { pattern: /\{input\}/.test(s.action) ? s.action : `${s.action}\n{input}` } });   // deterministic format, NO LLM ($0)
    else if (s.kind === 'structured') nodes.push({ id, kind: 'structured', config: { schema: s.fields || '', instructions: s.action, ...tier } });   // JSON-with-fields (prompt asking for JSON)
    else if (s.kind === 'router') nodes.push({ id, kind: 'router', config: routerCfg(s.condition) });   // conditional branch (then/else on its out-edges)
    else if (s.kind === 'languagemodel') nodes.push({ id, kind: 'languagemodel', config: { system: s.action, ...tier } });   // LLM with a system preamble
    else if (s.kind === 'prompt') nodes.push({ id, kind: 'prompt', config: { template: `${s.action}\n\n{input}`, ...tier } });   // Wave G: tier→model at run time
    else nodes.push({ id, kind: 'prompt', config: { template: `${s.action}\n\n{input}`, ...tier }, ...(gap === 'off' ? {} : { missing: true }) });   // mcp/agent w/o tool: ⚠️ gap（生成→承認で実 node）／off=ただの prompt
  }
  nodes.push({ id: 'output-1', kind: 'output' });

  // edges: linear by default; a router fans to its branch-tagged successors, which rejoin at the next plain step
  const edges = []; let eid = 0, prev = nodes[0].id, splitter = null, branchTails = [];
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i], st = steps[i - 1], br = st && st.branch;
    if (br && splitter) { edges.push({ id: `e${eid++}`, source: splitter, target: n.id, branch: br }); branchTails.push(n.id); }   // router → branch (labelled)
    else { const srcs = branchTails.length ? branchTails : [prev]; for (const s of srcs) edges.push({ id: `e${eid++}`, source: s, target: n.id }); branchTails = []; prev = n.id; }   // plain step joins prior branches (or the previous node)
    if (n.kind === 'router') splitter = n.id;   // the steps right after a router fan out from it
  }
  return { goal, plain_summary: parsed.plain_summary || goal, ui_hint: parsed.ui_hint === 'generate' ? 'generate' : 'none', steps, tools_needed, missing, nodes, edges, source };
}

// Wave A: plan IR → 人間可読（Mermaid + ASCII 図 + plain 要約）。CLI/Claude がそのまま描画＝cockpit 不要で「これで実行？」と確認できる。pure。
function nodeLabel(n, stepByN) {
  if (n.kind === 'input') return '📥 input';
  if (n.kind === 'output') return '📤 output';
  if (n.kind === 'mcp') return `🔧 mcp:${n.server}.${n.tool}`;
  if (n.kind === 'agent') return `${n.agent === 'browser-control' ? '🌐' : '🤖'} agent:${n.agent}`;
  if (n.kind === 'consensus') return `🗳️ consensus: ${((n.config && n.config.prompt) || '').slice(0, 34)}`;   // N vendor 合議
  if (n.kind === 'router') { const c = n.config || {}; return `🔀 router: ${c.predicate || 'always'}${c.value ? ` "${c.value}"` : ''}`; }   // conditional branch
  if (n.kind === 'parser') return `🔧 parser ($0 no LLM)`;                                   // deterministic format
  if (n.kind === 'structured') return `🧷 structured${(n.config && n.config.schema) ? `: ${n.config.schema}` : ''}`;   // JSON-with-fields
  if (n.kind === 'languagemodel') return `🧠 LLM`;                                            // model + system preamble
  const act = ((stepByN[Number(String(n.id).replace(/^s/, ''))] || {}).action || '').slice(0, 40);
  return n.missing ? `⚠️ ${act || 'gap'} (needs a tool)` : `💬 ${act || 'prompt'}`;
}
// Wave G: auto-routing 提案 — planner の tier(=capability) と user の cost 設定(=vendor) を合成し、各 step が
// 「どの AI で・いくらか」を plan に surface する。moat 整合: planner は vendor を押し付けず tier だけ決め、vendor は
// 財布設定(ctx)が決める。ctx は hub が実 tierRoute / defaultConsensusVendors から作る → 提案は実行時と同じ解決＝truthful。
// ctx = { cost, cheap:{vendor,model}, strong:{vendor,model}, consensusVendors, autoEscalate } | null（null=従来通り表示無し）。
const vendorName = (v) => v == null ? 'your Claude' : v;                          // vendor=null は本人 claude -p（subscription）
const vendorCost = (v) => v == null ? 'subscription ~$0' : v === 'ollama' ? 'local $0' : 'BYO-key (metered)';
export function routeFor(node, step, ctx) {
  if (!ctx || !node) return null;
  if (node.kind === 'mcp') return { kind: 'mcp', cost: '$0', label: 'tool call (no model · $0)' };
  if (node.kind === 'agent') return { kind: 'agent', cost: '$0', label: node.agent === 'browser-control' ? 'browser-control (your login · $0)' : `agent:${node.agent} (· $0)` };
  if (node.kind === 'parser') return { kind: 'parser', cost: '$0', label: 'parser (deterministic · $0)' };   // pure string format → no model
  if (node.kind === 'router') return { kind: 'router', cost: '$0', label: '🔀 router (branch · $0)' };        // routing decision → no model
  if (node.kind === 'consensus') { const vs = ctx.consensusVendors || ''; const n = vs.split(',').filter(Boolean).length || 1; return { kind: 'consensus', vendors: vs, cost: `${n}×`, label: `🗳️ consensus → ${vs || '—'} (${n}× cost)` }; }
  const tier = (step && step.tier) || (node.config && node.config.tier) || 'cheap';   // prompt/structured/languagemodel: tier→cheap/strong route（既定 cheap）
  const r = (tier === 'strong' ? ctx.strong : ctx.cheap) || {};
  const esc = tier === 'cheap' && !(node.config && node.config.vendor) && ctx.autoEscalate;   // cheap が落ちた時だけ strong に自動昇格
  const klabel = node.kind === 'structured' ? 'structured ' : node.kind === 'languagemodel' ? 'LLM ' : '';
  return { kind: node.kind === 'structured' || node.kind === 'languagemodel' ? node.kind : 'prompt', tier, vendor: r.vendor, model: r.model, cost: vendorCost(r.vendor),
    label: `${klabel}${tier} → ${vendorName(r.vendor)}${r.model ? ` (${r.model})` : ''} · ${vendorCost(r.vendor)}${esc ? ' ↑strong on fail' : ''}` };
}
export function renderPlan(ir, ctx = null) {
  if (ir.mode === 'unavailable') {                                              // PC0 honest failure: 計画モデル不在 → 偽フローを描かず理由と直し方だけ返す
    const lines = ['🐉 まだ計画できません：計画モデル未接続', '', '直し方:'];
    (ir.fix || []).forEach((f) => lines.push(`  - ${f}`));
    return { diagram_mermaid: '', diagram_ascii: '', summary_text: lines.join('\n') };
  }
  if (ir.mode === 'clarify' || (ir.clarify && ir.clarify.length)) {              // discover: plan の前に user に確認（図でなく質問を出す）
    const lines = [`🐉 まず確認させて（最適な道具を選ぶため）:`, ''];
    (ir.clarify || []).forEach((c, i) => { lines.push(`Q${i + 1}. ${c.question}${c.options && c.options.length ? `  [${c.options.join(' / ')}]` : ''}`); if (c.why) lines.push(`    （${c.why}）`); });
    if ((ir.blockers || []).length) { lines.push('', '⚠️ 注意/地雷:'); for (const b of ir.blockers) lines.push(`  - ${b}`); }
    lines.push('', '答えを選んだら、その回答を context.choices に入れて plan_flow を再度呼んでください。');
    return { diagram_mermaid: '', diagram_ascii: '', summary_text: lines.join('\n') };
  }
  const stepByN = Object.fromEntries((ir.steps || []).map((s) => [s.n, s]));
  const nodes = ir.nodes || [], label = (n) => nodeLabel(n, stepByN);
  const safe = (id) => String(id).replace(/[^a-zA-Z0-9]/g, '_');
  const diagram_mermaid = ['flowchart LR',
    ...nodes.map((n) => `  ${safe(n.id)}["${label(n).replace(/"/g, "'")}"]`),
    ...(ir.edges || []).map((e) => `  ${safe(e.source)} --> ${safe(e.target)}`)].join('\n');
  const diagram_ascii = nodes.map((n, i) => `${i ? '  ↓\n' : ''}  ${label(n)}`).join('\n');
  const nodeByN = Object.fromEntries(nodes.map((n) => [String(n.id).replace(/^s/, ''), n]));   // s<N> → node（routing 解決用）
  const routing = ctx ? (ir.steps || []).map((s) => { const r = routeFor(nodeByN[String(s.n)], s, ctx); return r ? { step: s.n, action: s.action, ...r } : null; }).filter(Boolean) : [];
  const routeByN = Object.fromEntries(routing.map((r) => [r.step, r]));
  const lines = [`🐉 ${ir.plain_summary || ir.goal}`, '', 'Steps:'];
  for (const s of (ir.steps || [])) { const rt = routeByN[s.n];
    lines.push(`  ${s.n}. ${s.action}` + (s.have ? `  → ✅ ${s.tool || s.kind}` : `  → ⚠️ needs a tool${s.kind === 'agent' ? ' (or browser-control)' : ''}`) + (rt ? `  · ${rt.label}` : '')); }
  if ((ir.missing || []).length) { lines.push('', 'Missing — build with gen_component → approve_component:'); for (const m of ir.missing) lines.push(`  - ${m.what} (${m.kind})`); }
  if ((ir.blockers || []).length) { lines.push('', '⚠️ 注意/地雷:'); for (const b of ir.blockers) lines.push(`  - ${b}`); }
  if (ir.ui_hint === 'generate') lines.push('', '🎨 成果物 UI 要 → gen_artifact_ui を呼んで操作+可視化 UI を生成してください（承認だけなら不要です）。');
  if (ctx) lines.push('', `🧭 Routing 提案 (お財布適応・COST=${ctx.cost || 'free'}): cheap→${vendorName(ctx.cheap && ctx.cheap.vendor)} / strong→${vendorName(ctx.strong && ctx.strong.vendor)} / consensus→${ctx.consensusVendors || '—'}（各 step の宛先は上の "·" 以降）。${ctx.autoEscalate ? 'cheap が失敗した時だけ strong に自動昇格。' : ''}`);
  lines.push('', 'Flow:', diagram_ascii, '', 'Run it with run_workflow (or re-plan to adjust).');
  return { diagram_mermaid, diagram_ascii, summary_text: lines.join('\n'), ...(ctx ? { routing } : {}) };
}

// Wave 2 外部発見: MCP search 結果 → {title,url} or null。実 Tavily 未検証なので shape は最小（envelope→array|{results}）に絞る。
// 当て推量(.name/.link/単一オブジェクト)は実 shape を見てから足す。non-JSON/対象無しは null（graceful）。
export function suggestionFromSearch(result) {
  let v = result;
  if (v && Array.isArray(v.content)) {                                      // MCP tool-result envelope
    const text = v.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
    try { v = JSON.parse(text); } catch { return null; }                    // prose（JSON でない）→ ヒット無し
  } else if (v && v.structuredContent) v = v.structuredContent;
  const arr = Array.isArray(v) ? v : Array.isArray(v?.results) ? v.results : [];
  const top = arr.find((x) => x && typeof x === 'object' && (x.url || x.title));
  if (!top) return null;
  const url = String(top.url || '').slice(0, 300);
  const title = String(top.title || url).slice(0, 120);
  return title || url ? { title: title || url, url } : null;
}

// Wave 2: 各 gap を外部 search に通し missing[].suggestion を埋める。search: async (query)→MCP 結果（呼び出し側が redact+audit で fence）。
// gap 1 個の失敗や変な結果が plan を落とさない（try/catch）。ponytail: cap 3 件（コスト）。
export async function discover(missing, search, cap = 3) {
  for (const g of missing.slice(0, cap)) {
    try { const s = suggestionFromSearch(await search(g.what)); if (s) g.suggestion = { ...s, source: 'external' }; }
    catch { /* graceful: この gap は提案なし */ }
  }
}

// Wave 3: gio plan IR → Langflow flow JSON。ui.html の importLangflowFlow / LF_KIND の逆写像。
// 描画可能 kind 限定 → 再 import で 🔗(unknown type) ゼロ。mcp/agent は native Langflow type 無し →
// Prompt に落とす（placeholder, 🔗 ゼロ維持・tool 名は template に残す）。
// ponytail: 値の往復は primary field のみ。full template(outputs/base_classes/typed handles・auto-layout)は §5 Wave3 最終形。
const wrap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));   // {k:v} → Langflow template 形 {k:{value:v}}

function lfNode(n, i) {
  const c = n.config || {};
  let type, tmpl;
  if (n.kind === 'input') { type = 'ChatInput'; tmpl = wrap({ input_value: c.text || '' }); }
  else if (n.kind === 'output') { type = 'ChatOutput'; tmpl = {}; }
  else {   // prompt | mcp | agent | gap → Prompt（描画可能）。tool step は何のツールか template に残す。
           // ponytail: plan IR は input/output/prompt/mcp/agent しか出さない → languagemodel/structured 写像は caller 出るまで足さない（§5 Wave3 最終形）。
    type = 'Prompt';
    const label = n.kind === 'mcp' ? `[mcp:${n.server}.${n.tool}] ` : n.kind === 'agent' ? `[agent:${n.agent}] ` : '';
    tmpl = wrap({ template: label ? `${label}{input}` : (c.template || '{input}') });
  }
  return { id: n.id, type: 'genericNode', position: { x: i * 320, y: 100 },
    data: { id: n.id, type, display_name: c.name || type, node: { template: tmpl } } };
}

export function toLangflowFlow(ir) {
  if (!ir || !Array.isArray(ir.nodes)) throw new Error('plan with nodes[] required');
  const nodes = ir.nodes.map(lfNode);
  const edges = (ir.edges || []).map((e) => ({ id: e.id, source: e.source, target: e.target,
    data: { sourceHandle: { output_types: ['Message'] }, targetHandle: { inputTypes: ['Message'] } } }));   // typed handle → import が型整合線を引く
  return { name: ir.plain_summary || ir.goal || 'shenron-flow', data: { nodes, edges } };
}

// Wave 7 — flow を local agent の skill に: 保存済み workflow → Claude Code SKILL.md。中身は MCP `run_workflow` を
// 呼ぶだけの薄いラッパ（実行は hub の DAG executor＝per-edge fence + audit 込み）。skill-aware な agent（Claude Code）が
// 自然文で発火→flow 実行。MCP/HTTP しか喋らない agent は run_workflow / /api/runflow を直叩きすればよく、この md は不要。
const KIND_LABEL = (n) => n.kind === 'mcp' ? `${n.server}.${n.tool}` : n.kind === 'agent' ? `agent:${n.agent}` : n.kind;
const yamlSafe = (s) => String(s).replace(/\s+/g, ' ').replace(/:\s/g, ' - ').trim();   // frontmatter は YAML: 改行と "key: " 衝突を潰す
export function flowSkill(wf) {
  if (!wf || !wf.id) throw new Error('workflow {id} required');
  const slug = (wf.name || wf.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'flow';   // [a-z0-9-] のみ＝path traversal 不能
  const title = wf.name || wf.id, desc = (wf.summary || title);
  const chain = (wf.nodes || []).map(KIND_LABEL).join(' → ') || '(no nodes)';
  const content = `---
name: ${slug}
description: ${yamlSafe(`${desc}. Use when the user wants to run "${title}" or asks to: ${desc}`)}
---

Runs the saved 神龍 (Shenron) flow **${title}** end-to-end via the connected 神龍 MCP server.

When this skill fires, call the \`run_workflow\` MCP tool with:
- \`id\`: "${wf.id}"
- \`input\`: the user's request (free text for the flow to act on)
- \`confirm\`: true

Flow: ${chain}

The hub runs the DAG (same executor as the cockpit ▶ Run), firewalls the input, and audits the call (hash-chain), then returns the flow's output. Prerequisite: the 神龍 MCP server must be connected so \`run_workflow\` is available.

<!-- shenron-flow: ${wf.id} -->
`;   // 機械可読マーカー: list_skills が神龍生成だけを拾い・delete_skill が手書き skill を誤殺せず・将来の逆同期で元 flow を辿る（DX-1）
  return { slug, content };
}

// Wave 5: 対話修正。現 plan の steps を見せ「指示の変更だけ当てて他 step は維持」させ steps[] を再生成（§5 Wave5 v1=再生成、差分適用は最終形）。
const stepsText = (steps) => (steps || []).map((s) => `${s.n}. [${s.kind}] ${s.action}${s.tool ? ` (tool: ${s.tool})` : s.kind !== 'prompt' ? ' (tool: none — gap)' : ''}`).join('\n');
const REFINE_PROMPT = (prev, instruction, inv) => `You are REVISING an existing automation plan. Apply ONLY the requested change and keep every OTHER step identical (same action/kind/tool).
Current plan: "${prev.plain_summary || prev.goal || ''}"
Steps:
${stepsText(prev.steps)}
Requested change: "${instruction}"
Inventory — the ONLY tools/agents that exist (use these exact ids in step.tool, or null):
${inv}
Built-in step kind "prompt" (an LLM step) is always available and needs no tool. A GENERIC tool does NOT cover a SPECIFIC need; use null so the missing tool is surfaced.
Output ONLY JSON: {"plain_summary":"<one plain sentence>","steps":[{"action":"<short>","kind":"mcp|agent|prompt","tool":"<inventory id or null>"}]}`;

// Wave(discover): clarify 再呼び出しの user 回答を prompt 文に。{question,answer} / 文字列どちらも受ける。
const choicesText = (c) => Array.isArray(c) ? c.map((x) => typeof x === 'string' ? x : `${x.question}: ${x.answer ?? x.choice ?? ''}`).join('\n') : String(c || '');

// context={prev_plan,instruction} なら refine（前 plan に指示を当てて再生成・失敗時は前 plan を維持＝壊さない）。run は test 用に注入可。
// Wave(discover・M1): planner が research→曖昧/地雷なら steps でなく {clarify,blockers} を返す→ caller(client) が user に聞いて context.choices で再呼び出し。検索は BYO AI 任せ（神龍は構造化のみ）。
export async function plan({ goal, agents = [], tools = [], workflows = [], vendor = 'claude', search = null, context = null, gap = 'ask', cost = 'free', run = runVendorAsync }) {
  goal = String(goal || '').trim();
  const refine = !!(context && context.instruction && context.prev_plan);
  if (!goal && !refine) throw new Error('goal required');
  const inv = inventoryText({ agents, tools, workflows });
  const choices = context && context.choices ? choicesText(context.choices) : '';
  const out = await run(vendor, refine ? REFINE_PROMPT(context.prev_plan, String(context.instruction), inv) : PROMPT(goal, inv, choices, cost), '');   // cost: 'free'(既定・従量0優先)|'paid_ok'(有料ツール可・要開示)
  let ir;
  try {
    const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    if (!refine && Array.isArray(parsed.clarify) && parsed.clarify.length)        // discover: 曖昧/地雷 → plan せず user に確認を返す（再呼び出しで context.choices）
      return { goal, mode: 'clarify', clarify: parsed.clarify, blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [], plain_summary: goal, source: 'clarify', nodes: [], edges: [], steps: [], missing: [], tools_needed: [] };
    if (Array.isArray(parsed.steps) && parsed.steps.length) { ir = buildPlanIR(goal || context.prev_plan.goal, parsed, refine ? 'refine' : 'llm', gap); if (Array.isArray(parsed.blockers) && parsed.blockers.length) ir.blockers = parsed.blockers; }   // 計画と一緒に残った注意点(blocker)を載せる
  } catch { /* fall through */ }
  if (!ir) {
    if (!refine && isStubFail(out))   // PC0 honest failure: 計画モデルが応答しない（APIキー無/--vendor stub/CLI 不達）→ 偽フロー(input→prompt→output)化せず unavailable を返す
      return { goal, mode: 'unavailable', reason: 'planner-model', detail: String(out).slice(0, 160),
        fix: ['hub env に ANTHROPIC_API_KEY を設定', 'または hub から claude/codex CLI を使える状態に', 'または起動時 --vendor を指定'],
        plain_summary: goal, source: 'unavailable', nodes: [], edges: [], steps: [], missing: [], blockers: [] };
    ir = refine ? context.prev_plan                                                                       // refine 失敗 → 元 plan 維持（編集を捨てない）
      : buildPlanIR(goal, { plain_summary: goal, steps: [{ action: goal, kind: 'prompt', tool: null }] }, 'heuristic', gap);   // LLM は動いたが JSON 壊れ＝稀
  }
  if (search && ir.missing.length) await discover(ir.missing, search);   // Wave 2: gap に外部ツール提案を mutate（caller が fence）
  return ir;
}

// ───────────────────────── Wave 4: 不足ノード生成（生成→使い捨てサンドボックス収束→修復ループ）─────────────────────────
// §1.5-E/F/H/I 接地。spike1 を復活させず §1.5-E 手順から再構築:
//  - 生成=LLM が langflow 1.10.0 Component を 1-shot（spike1: JSON/XML/nested/key-param 横断で収束）。
//  - 収束検証=使い捨てサンドボックスで standalone 実行し「Message.text に実データ」を assert（spike1 caveat: Data 許容を型 assert で潰す）。
//  - 失敗(traceback/型不一致)→そのまま LLM に戻して修復（spike1: forced-fail iter1→iter2 回復）。
//  - 本番無人パスで踏むのは初回 human-gate を通った vetted ノードのみ（§H）。ここは「生成フェーズ」=人ゲート前の収束測定。

export function extractCode(out) {                                        // LLM 生テキスト → ```python フェンス（無ければ任意フェンス→生）。
  const s = String(out || '');
  const py = s.match(/```(?:python|py)[^\n]*\n([\s\S]*?)```/i);
  if (py) return py[1].trim();
  const any = s.match(/```[a-z]*[^\n]*\n([\s\S]*?)```/i);
  return (any ? any[1] : s).trim();
}

// Wave 9: 生成ターゲット = standalone Python MCP server（JSON-RPC over stdio・1 tool `run`）。Langflow Component から転換
// （北極星: Langflow 独立）。利点3点: ① `mcp` node が消費＝Langflow runtime 不要 ② 検証が prod と同形（prod の stdio client で
// spawn → stub-gap が消える） ③ 一度生成した server が ladder 第1段に rejoin（integration 登録 → 再生成不要）。
const GEN_PROMPT = (what) => `Write ONE self-contained Python MCP server (Model Context Protocol, JSON-RPC 2.0 over stdio) that implements: "${what}".
It speaks this exact wire protocol on stdin/stdout — read stdin line by line; for each line parse JSON-RPC and reply with EXACTLY ONE line: print(json.dumps(msg), flush=True). flush=True is REQUIRED (no flush → the client hangs).
- "initialize" → result {"protocolVersion": params.get("protocolVersion","2025-06-18"), "capabilities":{"tools":{}}, "serverInfo":{"name":"<a slug>","version":"0.1.0"}}
- "notifications/initialized" → a NOTIFICATION (no "id"): do NOT reply.
- "tools/list" → result {"tools":[{"name":"run","description":"<one line>","inputSchema":{"type":"object","properties":{"input":{"type":"string"}}}}]}
- "tools/call" with params["name"] == "run" → call run(**(params.get("arguments") or {})); reply result {"content":[{"type":"text","text": <the result string>}]}. On ANY exception, reply result {"content":[{"type":"text","text": <traceback as string>}], "isError": true}.
- any other request that has an "id" → JSON-RPC error -32601.
The one tool:
    def run(input=None, **kw):
        # REAL implementation — actually fetch/compute and RETURN a non-empty string. No TODO, no pass, no placeholder.
        return "<the result as a non-empty string>"
Hard rules:
- Python STANDARD LIBRARY ONLY (urllib.request, json, sys, xml.etree.ElementTree, datetime, math…). No pip packages, no "requests".
- run() MUST work with NO arguments (input defaults to a real working value) and ignore unknown keyword args via **kw.
- Prefer PUBLIC / no-auth APIs. If the service REQUIRES an API key, read it with os.environ.get('DESCRIPTIVE_NAME') (e.g. os.environ.get('OPENWEATHER_API_KEY')); if that env var is missing, RETURN a clear string naming exactly which env var to set. NEVER hard-code a secret.
- stdout carries JSON-RPC ONLY: one compact JSON object per line, flush=True. Send any logging to sys.stderr, NEVER stdout.
- run() must return a NON-EMPTY string (the real data).
Output ONLY the Python code inside one \`\`\`python fence. No prose.`;

const REPAIR_PROMPT = (what, code, err) => `Your Python MCP server for "${what}" FAILED a spawn + JSON-RPC handshake + tools/call check.
--- your code ---
${code}
--- error / output (tail) ---
${err}
Fix it so: it speaks JSON-RPC 2.0 over stdio (initialize → tools/list → tools/call name="run"); every reply is ONE line printed with flush=True; run(input=None,**kw) returns a NON-EMPTY string; stdlib only; never hard-code a secret (a required key is read from os.environ.get('NAME')); stdout carries JSON-RPC ONLY (logs to stderr).
Output ONLY the corrected Python in one \`\`\`python fence. No prose.`;

// 使い捨てサンドボックス: 生成 MCP server を prod と同じ stdio client（callMcpTool）で spawn + handshake + `run` し、
// 非空の実データを返すか検証。prod パス = 検証パス → stub-gap が消える（Wave 9）。失敗時は traceback / handshake error の
// 末尾を返す（修復ループの入力）。fence: secret を抜いた env（safeEnv）で spawn = 生成コードからの credential exfil 防止。
// 検証は `{input:''}` で呼ぶ＝prod の arg 形（hub runMcp が input を渡す）を再現。OS サンドボックス(seccomp/egress)は v2（§1.5-I）。
// BYO-credential: 生成コードが読む env 名のうち secret-strip 対象（SECRET_RE 一致）を抽出 = この server の credential allowlist。
// 承認後 runMcp はこの名前だけ process.env から戻す（値は repo に乗らない・integrations.json には名前のみ）。pure・test 対象。
export function neededCredentials(code) {
  const names = new Set(), re = /os\.(?:environ\.get|getenv)\(\s*['"]([A-Z0-9_]+)['"]|os\.environ\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g;
  let m; while ((m = re.exec(String(code || '')))) { const n = m[1] || m[2]; if (n && SECRET_RE.test(n)) names.add(n); }   // SECRET_RE 不一致(HOME 等)は safeEnv が元から通すので allowlist 不要
  return [...names];
}

// creds = この server が宣言した credential allowlist。default-deny の safeEnv に**その名前だけ**通して spawn
// （= BYO-credential 注入）。allowlist 空なら従来通り全 secret strip。値は process.env のみ（repo に乗らない）。
export async function verifyMcpServer(code, { python = 'python3', timeout = 30000, creds = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shenron-'));
  try {
    writeFileSync(join(dir, 'server.py'), code);
    const text = await callMcpTool({ command: `${python} server.py` }, 'run', { input: '' }, { cwd: dir, timeoutMs: timeout, env: safeEnv(creds) });
    const out = String(text || '').trim();
    return out ? { ok: true, output: out.slice(0, 2000) } : { ok: false, error: 'run returned empty text' };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(-1500) };   // isError traceback / timeout(no flush) / spawn error
  } finally { rmSync(dir, { recursive: true, force: true }); }            // 使い捨て
}

// 生成→収束→（失敗なら）修復ループ。run/sandbox/hasEnv は test 用に注入可。
// BYO-credential: 各 iter でコードの宣言 cred を抽出。env に無い cred があれば live verify 不能 → repair 空回りを止めて
// needsCredentials を surface（operator が key を hub env に入れて再生成する導線）。揃っていれば allowlist を verify に通す。
export async function genComponent({ what, vendor = 'claude', maxIters = 3, run = runVendorAsync, sandbox = verifyMcpServer }) {
  what = String(what || '').trim();
  if (!what) throw new Error('what required');
  let code = '', err = null;
  for (let i = 1; i <= maxIters; i++) {
    const raw = String(await run(vendor, err ? REPAIR_PROMPT(what, code, err) : GEN_PROMPT(what), '') || '').trim();
    if (raw.startsWith('[') && raw.includes('stub]'))                                              // vendor unavailable/failed (runner returns `[... → stub]`) — feeding that to the sandbox crashes every iter (実機で判明). Fail fast with the fix.
      return { what, code: '', iters: i, converged: false, error: `no LLM vendor for codegen — set EXEC_VENDOR=claude (local) or ANTHROPIC_API_KEY (cloud). vendor said: ${raw.slice(0, 100)}` };
    code = extractCode(raw);
    const creds = neededCredentials(code);
    const missing = creds.filter((k) => process.env[k] == null);
    if (missing.length) return { what, code, iters: i, converged: false, needsCredentials: missing, error: `needs credentials (set in hub env, then re-generate): ${missing.join(', ')}` };
    const r = await sandbox(code, { creds });
    if (r.ok) return { what, code, iters: i, converged: true, output: r.output, credentials: creds };   // credentials = approve 時に integration へ載せる allowlist
    err = r.error;
  }
  return { what, code, iters: maxIters, converged: false, error: err };
}

// Wave UI S4 — 成果物 UI 生成。JSX はブラウザでしか実行できないので Python のサンドボックス検証は不要。
// bridge 規約（window.shenron.*・import 禁止・responsive）をプロンプトに埋め込む。
const GEN_UI_PROMPT = (what) => `Write a React JSX component for: "${what}".

RULES (non-negotiable):
- Export as: export default function App() { ... }
- NO import statements. React/ReactDOM are globals. Use React.useState, React.useEffect etc.
- Flow actions use window.shenron (available as a global in the sandbox):
    window.shenron.approve()             // approve the linked handoff
    window.shenron.decline()             // decline the linked handoff
    window.shenron.advance({ ...data })  // post a result and advance the flow
  Each returns a Promise — await it and show the result to the user.
- LLM calls: use fetch('https://api.anthropic.com/v1/messages', ...) normally — the sandbox proxies it via hub (API key stays on server, never exposed to the UI).
- Responsive: works on mobile (320px wide) and desktop. Use inline styles or simple CSS-in-JS.
- Show clear loading/error states for async actions.

Output ONLY the JSX code inside one \`\`\`jsx fence. No prose.`;

export async function genArtifactUi({ what, vendor = 'claude', run = runVendorAsync }) {
  what = String(what || '').trim();
  if (!what) throw new Error('what required');
  const raw = String(await run(vendor, GEN_UI_PROMPT(what), '') || '').trim();
  if (raw.startsWith('[') && raw.includes('stub]'))
    return { what, code: '', converged: false, error: `no LLM vendor — set EXEC_VENDOR=claude. vendor said: ${raw.slice(0, 100)}` };
  const code = extractCode(raw);
  return { what, code, converged: !!(code && (code.includes('function App') || code.includes('App ='))) };
}

// Wave R-1 — 成果検証の判定中核（evalExpect・実装済 99aa25b）。純粋関数（state 非依存）→ test_shenron が直接 import して検証可。
// 契約: (expect:{kind:'assert'|'judge', rule:string}, actual:string, {run, vendor, model}) → Promise<{ok:boolean, reason:string}>
//   ok=true ＝「run 出力(actual) が期待(rule) を満たした」。外れたら hub の checkOutcome が check_failed を通知する。
//   assert: LLM 不使用の決定論。rule の文法を決めて actual を判定（例 'contains:done' → actual.includes('done')）。
//   judge : cheap tier で yes/no。prompt 例『質問:${rule}\n出力:\n${actual}\nYES か NO のみで答えて』→ run(vendor||'stub', prompt, 'NO', {model})。
//     ⚠️ judge は actual(=run 出力・secret/PII を含みうる) を vendor に送る *新しい未 firewall egress*。
//        既存の redact()/fenceEdge は効かない → 送信前に redact(trust.mjs) するか最低限 audit する設計判断が要る。
//        vendor 失敗 sentinel（r.startsWith('[') && r.includes('→ stub]')）は fail-closed（{ok:false}）に倒す。
//   reason には生 output を入れない（短い判定理由のみ）— checkResults / list_check_results に保存され露出するため。
// runner の失敗 sentinel（`[<vendor> → stub] …` / `[<vendor> failed → stub] …` / `[stub] (no vendor …)`）を fail-closed に倒すための検出。
const isStubFail = (s) => /(?:→ stub\]|^\[stub\])/.test(String(s ?? '').trim());
export async function evalExpect(expect, actual, { run = runVendorAsync, vendor, model } = {}) {
  const rule = String(expect?.rule ?? '').trim();
  const text = String(actual ?? '');
  // assert — 決定論・LLM 不使用・$0。rule 文法 'op:arg'（prefix 無し＝contains フォールバック）。
  if (expect?.kind === 'assert') {
    if (!rule) return { ok: true, reason: 'assert: empty rule (no-op pass)' };
    const m = rule.match(/^(!?[a-z-]+):([\s\S]*)$/i);
    const op = m ? m[1].toLowerCase() : 'contains';
    const arg = m ? m[2] : rule;
    let ok, why;
    switch (op) {
      case 'contains': ok = text.includes(arg); why = `contains "${arg}"`; break;
      case '!contains': ok = !text.includes(arg); why = `lacks "${arg}"`; break;
      case 'equals': ok = text.trim() === arg.trim(); why = 'equals exactly'; break;
      case 'regex':
        try { ok = new RegExp(arg).test(text); why = `matches /${arg}/`; }
        catch (e) { return { ok: false, reason: `assert: bad regex (${e.message})` }; }    // 不正 rule は fail（黙って pass しない）
        break;
      case 'json': {                                                                        // 'json:dot.path=value'（一致）/ 'json:dot.path'（存在）
        const eq = arg.indexOf('=');
        const path = (eq >= 0 ? arg.slice(0, eq) : arg).trim();
        const want = eq >= 0 ? arg.slice(eq + 1).trim() : undefined;
        let val;
        try { val = path.split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), JSON.parse(text)); }
        catch { return { ok: false, reason: 'assert: output is not JSON' }; }
        ok = want === undefined ? (val !== undefined && val !== null) : (String(val) === want);
        why = want === undefined ? `has ${path}` : `${path} == ${want}`;
        break;
      }
      default: ok = text.includes(rule); why = `contains "${rule}"`;                        // 未知 op → rule 全体を contains 扱い（後方互換）
    }
    return { ok, reason: `assert ${op}: ${ok ? 'pass' : 'fail'} (${why})` };
  }
  // judge — cheap tier LLM の yes/no（従量0・本人サブスク）。⚠️ actual を vendor へ送る新 egress。
  if (expect?.kind === 'judge') {
    if (!rule) return { ok: true, reason: 'judge: empty rule (no-op pass)' };
    const fw = redact(text);                                                                // 送信前に secret/PII firewall（philosophy #4・既存 redact/fenceEdge は届かない経路）
    const prompt = `あなたは出力検査官です。次の出力が条件を満たすか YES か NO の一語だけで答えてください。\n条件: ${rule}\n--- 出力 ---\n${fw.text}\n--- ここまで ---\nYES か NO のみ:`;
    let r;
    try { r = await run(vendor || 'stub', prompt, 'NO', { model }); }
    catch (e) { return { ok: false, reason: `judge: vendor error (fail-closed: ${e.message})` }; }
    if (isStubFail(r)) return { ok: false, reason: 'judge: vendor unavailable (fail-closed)' };   // sentinel → fail-closed（沈黙の pass にしない）
    const ok = /^\s*(yes|true|pass)\b/i.test(String(r ?? ''));                              // 期待外の応答は false に倒す（fail-closed 寄り）
    const red = fw.removed.length ? ` [redacted ${fw.removed.reduce((n, x) => n + x.count, 0)}]` : '';
    return { ok, reason: `judge: ${ok ? 'pass' : 'fail'}${red}` };                          // reason に生 output は入れない（list_check_results に保存され露出するため）
  }
  return { ok: true, reason: `unknown expect.kind "${expect?.kind}" (no-op pass)` };
}

// Wave Goals-2 — ゴールの停滞/期限接近を判定する純粋関数（state 非依存・evalExpect 踏襲）→ test_shenron が直接 import。
// 契約: (g, now:ms, {stallMs, deadlineMs}) → { stalled, deadlineNear }
//   lastActivity = max(最新 checkin.ts, g.createdAt)。stalled = active かつ無活動 > stallMs。
//   deadlineNear = active かつ deadline まで <= deadlineMs（overdue=過ぎた期限も near）。active 以外は両方 false。
export const GOAL_STALL_MS = 14 * 24 * 60 * 60 * 1000;     // 14日 checkin 無し → 停滞
export const GOAL_DEADLINE_MS = 3 * 24 * 60 * 60 * 1000;   // 期限 3日前以内（overdue 含む）→ 接近
export function goalStatus(g, now, { stallMs = GOAL_STALL_MS, deadlineMs = GOAL_DEADLINE_MS } = {}) {
  if (!g || g.status !== 'active') return { stalled: false, deadlineNear: false };
  const checkins = Array.isArray(g.checkins) ? g.checkins : [];
  const lastCheckin = checkins.length ? Number(checkins[checkins.length - 1].ts) || 0 : 0;
  const lastActivity = Math.max(lastCheckin, Number(g.createdAt) || 0);
  const stalled = lastActivity > 0 && (now - lastActivity) > stallMs;   // createdAt/checkin が無い旧データは停滞判定しない（誤発火防止）
  const dl = g.deadline ? Date.parse(g.deadline) : NaN;
  const deadlineNear = Number.isFinite(dl) && (dl - now) <= deadlineMs;
  return { stalled, deadlineNear };
}

// --- Wave T-0 テナンシー: レコード可視性（純粋）。課金の"対象物"の核 = seat 境界の可視性分離。
// uid==null       = MCP 運用者(A2A_SHARED_TOKEN identity) / 開放ハブ = 全可視（ハブ所有者は全部見える）
// rec.owner==null = owner 欄の無い旧データ / MCP 作成 = ハブ共有 = 全員可視（移行スクリプト不要の後方互換）
// rec.owner===uid = 自分の private / visibility==='shared' = publish 済み（庫掲載）= 全員可視
export const visibleTo = (rec, uid) => uid == null || rec.owner == null || rec.owner === uid || rec.visibility === 'shared';
