// shenron.mjs — 神龍 plan 層（Wave 1）。自然文 goal → plan IR。docs/13 §1.5・§5 Wave 1。
// spike 接地の設計:
//  - LLM は steps[] だけ吐く（§1.5-G: claude -p は生テキスト・structured output 不可）。nodes/edges は確定コードで組む。
//  - 各 step の have/missing は LLM-resolve（§1.5-F gate1, spike0: 危険な過小検出 0%）。
//    プロンプトに「generic ツールは specific need を covered しない」を明記（spike0 でこれが効いた）。inventory を注入。
//  - nodes/edges の port 検証・layout は hub 側（validateFlow/layoutFlow）に委譲。ここは raw を返す。
import { runVendorAsync } from '../runner.mjs';
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

const PROMPT = (goal, inv) => `You plan an automation flow. Goal: "${goal}".
Inventory — the ONLY tools/agents that exist (use these exact ids in step.tool, or null):
${inv}
Built-in step kind "prompt" (an LLM step) is always available and needs no tool.
Built-in agent "agent:browser-control" drives a REAL BROWSER (open/click/type/submit, using the user's own login session) — use kind:"agent", tool:"agent:browser-control" for a step that needs a service with a UI but NO usable API/MCP tool (e.g. "register on site X", "apply on a job site", "message someone on a web app"). Outbound actions (submit/send) are human-approved at run time.
Decompose the goal into ordered steps. For EACH step choose kind ("mcp" external tool / "agent" / "prompt") and, if an inventory item GENUINELY covers it, its exact id — otherwise null. A GENERIC tool does NOT cover a SPECIFIC need (a generic HTTP fetch does NOT cover "get GitHub commits"); use null so the missing tool is surfaced. Prefer an mcp tool/API when one exists; fall back to agent:browser-control ONLY when the service is UI-only (no API).
Output ONLY JSON: {"plain_summary":"<one plain sentence>","steps":[{"action":"<short>","kind":"mcp|agent|prompt","tool":"<inventory id or null>"}]}`;

// pure: parsed LLM output → plan IR（raw nodes/edges, port 検証は呼び出し側）。test 対象。
// gap: 'off'|'ask'|'auto' — 解決不能 step（既存ツールで埋まらない mcp/agent）をどう扱うか。off=buildable gap を作らず
// best-effort prompt 化（神龍に自己拡張＝道具生成させない）／ask(既定)=⚠️ gap を出し人が codegen 起動／auto=同上＋自動起動(caller 側)。
export function buildPlanIR(goal, parsed, source = 'llm', gap = 'ask') {
  const steps = (parsed.steps || []).map((s, i) => ({ n: i + 1, action: s.action || '',
    kind: ['mcp', 'agent', 'prompt'].includes(s.kind) ? s.kind : 'prompt', tool: s.tool || null, have: !!s.tool || s.kind === 'prompt' }));
  const needsTool = (s) => s.kind === 'mcp' || s.kind === 'agent';
  const missing = gap === 'off' ? [] : steps.filter((s) => needsTool(s) && !s.tool).map((s) => ({ what: s.action, kind: s.kind, step: s.n }));
  const tools_needed = steps.filter(needsTool).map((s) => ({ name: s.tool || s.action, kind: s.kind, have: !!s.tool, source: s.tool ? 'inventory' : 'gap' }));

  const nodes = [{ id: 'input-1', kind: 'input' }];
  for (const s of steps) {
    const id = `s${s.n}`;
    if (s.kind === 'mcp' && s.tool) { const r = s.tool.replace(/^mcp:/, ''); const d = r.indexOf('.'); nodes.push({ id, kind: 'mcp', server: r.slice(0, d), tool: r.slice(d + 1) }); }
    else if (s.kind === 'agent' && s.tool) nodes.push({ id, kind: 'agent', agent: s.tool.replace(/^agent:/, '') });
    else if (s.kind === 'prompt') nodes.push({ id, kind: 'prompt', config: { template: `${s.action}\n\n{input}` } });
    else nodes.push({ id, kind: 'prompt', config: { template: `${s.action}\n\n{input}` }, ...(gap === 'off' ? {} : { missing: true }) });   // mcp/agent w/o tool: ask/auto=⚠️ gap（生成→承認で実 mcp node）／off=ただの prompt（自己拡張しない）
  }
  nodes.push({ id: 'output-1', kind: 'output' });
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) edges.push({ id: `e${i}`, source: nodes[i].id, target: nodes[i + 1].id });   // linear chain
  return { goal, plain_summary: parsed.plain_summary || goal, steps, tools_needed, missing, nodes, edges, source };
}

// Wave A: plan IR → 人間可読（Mermaid + ASCII 図 + plain 要約）。CLI/Claude がそのまま描画＝cockpit 不要で「これで実行？」と確認できる。pure。
function nodeLabel(n, stepByN) {
  if (n.kind === 'input') return '📥 input';
  if (n.kind === 'output') return '📤 output';
  if (n.kind === 'mcp') return `🔧 mcp:${n.server}.${n.tool}`;
  if (n.kind === 'agent') return `${n.agent === 'browser-control' ? '🌐' : '🤖'} agent:${n.agent}`;
  const act = ((stepByN[Number(String(n.id).replace(/^s/, ''))] || {}).action || '').slice(0, 40);
  return n.missing ? `⚠️ ${act || 'gap'} (needs a tool)` : `💬 ${act || 'prompt'}`;
}
export function renderPlan(ir) {
  const stepByN = Object.fromEntries((ir.steps || []).map((s) => [s.n, s]));
  const nodes = ir.nodes || [], label = (n) => nodeLabel(n, stepByN);
  const safe = (id) => String(id).replace(/[^a-zA-Z0-9]/g, '_');
  const diagram_mermaid = ['flowchart LR',
    ...nodes.map((n) => `  ${safe(n.id)}["${label(n).replace(/"/g, "'")}"]`),
    ...(ir.edges || []).map((e) => `  ${safe(e.source)} --> ${safe(e.target)}`)].join('\n');
  const diagram_ascii = nodes.map((n, i) => `${i ? '  ↓\n' : ''}  ${label(n)}`).join('\n');
  const lines = [`🐉 ${ir.plain_summary || ir.goal}`, '', 'Steps:'];
  for (const s of (ir.steps || [])) lines.push(`  ${s.n}. ${s.action}` + (s.have ? `  → ✅ ${s.tool || s.kind}` : `  → ⚠️ needs a tool${s.kind === 'agent' ? ' (or browser-control)' : ''}`));
  if ((ir.missing || []).length) { lines.push('', 'Missing — build with gen_component → approve_component:'); for (const m of ir.missing) lines.push(`  - ${m.what} (${m.kind})`); }
  lines.push('', 'Flow:', diagram_ascii, '', 'Run it with run_workflow (or re-plan to adjust).');
  return { diagram_mermaid, diagram_ascii, summary_text: lines.join('\n') };
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

Runs the saved BuildHUD flow **${title}** end-to-end via the connected BuildHUD MCP server.

When this skill fires, call the \`run_workflow\` MCP tool with:
- \`id\`: "${wf.id}"
- \`input\`: the user's request (free text for the flow to act on)
- \`confirm\`: true

Flow: ${chain}

The hub runs the DAG (same executor as the cockpit ▶ Run), firewalls the input, and audits the call (hash-chain), then returns the flow's output. Prerequisite: the BuildHUD MCP server must be connected so \`run_workflow\` is available.
`;
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

// context={prev_plan,instruction} なら refine（前 plan に指示を当てて再生成・失敗時は前 plan を維持＝壊さない）。run は test 用に注入可。
export async function plan({ goal, agents = [], tools = [], workflows = [], vendor = 'claude', search = null, context = null, gap = 'ask', run = runVendorAsync }) {
  goal = String(goal || '').trim();
  const refine = !!(context && context.instruction && context.prev_plan);
  if (!goal && !refine) throw new Error('goal required');
  const inv = inventoryText({ agents, tools, workflows });
  const out = await run(vendor, refine ? REFINE_PROMPT(context.prev_plan, String(context.instruction), inv) : PROMPT(goal, inv), '');
  let ir;
  try {
    const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    if (Array.isArray(parsed.steps) && parsed.steps.length) ir = buildPlanIR(goal || context.prev_plan.goal, parsed, refine ? 'refine' : 'llm', gap);
  } catch { /* fall through */ }
  if (!ir) ir = refine ? context.prev_plan                                                                       // refine 失敗 → 元 plan 維持（編集を捨てない）
    : buildPlanIR(goal, { plain_summary: goal, steps: [{ action: goal, kind: 'prompt', tool: null }] }, 'heuristic', gap);   // 初回 LLM 不在/壊れ → 1 prompt step
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
