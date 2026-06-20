// shenron.mjs — 神龍 plan 層（Wave 1）。自然文 goal → plan IR。docs/13 §1.5・§5 Wave 1。
// spike 接地の設計:
//  - LLM は steps[] だけ吐く（§1.5-G: claude -p は生テキスト・structured output 不可）。nodes/edges は確定コードで組む。
//  - 各 step の have/missing は LLM-resolve（§1.5-F gate1, spike0: 危険な過小検出 0%）。
//    プロンプトに「generic ツールは specific need を covered しない」を明記（spike0 でこれが効いた）。inventory を注入。
//  - nodes/edges の port 検証・layout は hub 側（validateFlow/layoutFlow）に委譲。ここは raw を返す。
import { runVendorAsync } from '../runner.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// LLM が step.tool に入れてよい id（または null）を列挙した inventory テキスト。
function inventoryText({ agents = [], tools = [], workflows = [] }) {
  const lines = [];
  for (const a of agents) lines.push(`agent:${a.id} — ${a.skill || 'task'}`);
  for (const t of tools) lines.push(`mcp:${t.id} — ${t.name}`);            // t = { id: "<integ>.<tool>", name }
  for (const w of workflows) lines.push(`workflow:${w.id} — ${w.name || w.id}`);
  return lines.length ? lines.join('\n') : '(no tools/agents registered yet — everything specific is a gap)';
}

const PROMPT = (goal, inv) => `You plan an automation flow. Goal: "${goal}".
Inventory — the ONLY tools/agents that exist (use these exact ids in step.tool, or null):
${inv}
Built-in step kind "prompt" (an LLM step) is always available and needs no tool.
Decompose the goal into ordered steps. For EACH step choose kind ("mcp" external tool / "agent" / "prompt") and, if an inventory item GENUINELY covers it, its exact id — otherwise null. A GENERIC tool does NOT cover a SPECIFIC need (a generic HTTP fetch does NOT cover "get GitHub commits"); use null so the missing tool is surfaced.
Output ONLY JSON: {"plain_summary":"<one plain sentence>","steps":[{"action":"<short>","kind":"mcp|agent|prompt","tool":"<inventory id or null>"}]}`;

// pure: parsed LLM output → plan IR（raw nodes/edges, port 検証は呼び出し側）。test 対象。
export function buildPlanIR(goal, parsed, source = 'llm') {
  const steps = (parsed.steps || []).map((s, i) => ({
    n: i + 1, action: s.action || '', kind: ['mcp', 'agent', 'prompt'].includes(s.kind) ? s.kind : 'prompt',
    tool: s.tool || null, have: !!s.tool || s.kind === 'prompt',
  }));
  const needsTool = (s) => s.kind === 'mcp' || s.kind === 'agent';
  const missing = steps.filter((s) => needsTool(s) && !s.tool).map((s) => ({ what: s.action, kind: s.kind, step: s.n }));
  const tools_needed = steps.filter(needsTool).map((s) => ({ name: s.tool || s.action, kind: s.kind, have: !!s.tool, source: s.tool ? 'inventory' : 'gap' }));

  const nodes = [{ id: 'input-1', kind: 'input' }];
  for (const s of steps) {
    const id = `s${s.n}`;
    if (s.kind === 'mcp' && s.tool) { const r = s.tool.replace(/^mcp:/, ''); const d = r.indexOf('.'); nodes.push({ id, kind: 'mcp', server: r.slice(0, d), tool: r.slice(d + 1) }); }
    else if (s.kind === 'agent' && s.tool) nodes.push({ id, kind: 'agent', agent: s.tool.replace(/^agent:/, '') });
    else if (s.kind === 'prompt') nodes.push({ id, kind: 'prompt', config: { template: `${s.action}\n\n{input}` } });
    else nodes.push({ id, kind: 'prompt', config: { template: `${s.action}\n\n{input}` }, missing: true });   // mcp/agent w/ no tool = gap → placeholder prompt, flagged for Wave 4
  }
  nodes.push({ id: 'output-1', kind: 'output' });
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) edges.push({ id: `e${i}`, source: nodes[i].id, target: nodes[i + 1].id });   // linear chain
  return { goal, plain_summary: parsed.plain_summary || goal, steps, tools_needed, missing, nodes, edges, source };
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
const lfModelType = (m) => (/claude|anthropic/.test(m) ? 'AnthropicModel' : /gemini|google/.test(m) ? 'GoogleGenerativeAIModel' : 'OpenAIModel');

function lfNode(n, i) {
  const c = n.config || {};
  let type, tmpl;
  if (n.kind === 'input') { type = 'ChatInput'; tmpl = wrap({ input_value: c.text || '' }); }
  else if (n.kind === 'output') { type = 'ChatOutput'; tmpl = {}; }
  else if (n.kind === 'structured') { type = 'StructuredOutput'; tmpl = wrap({ output_schema: c.schema || '', instructions: c.instructions || '' }); }
  else if (n.kind === 'languagemodel') { type = lfModelType(String(c.model || '')); tmpl = wrap({ model_name: c.model || '', system_message: c.system || '', ...(c.temperature != null ? { temperature: c.temperature } : {}) }); }
  else {   // prompt | mcp | agent | gap → Prompt（描画可能）。tool step は何のツールか template に残す。
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

export async function plan({ goal, agents = [], tools = [], workflows = [], vendor = 'claude', search = null }) {
  goal = String(goal || '').trim();
  if (!goal) throw new Error('goal required');
  const out = await runVendorAsync(vendor, PROMPT(goal, inventoryText({ agents, tools, workflows })), '');
  let ir;
  try {
    const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    if (Array.isArray(parsed.steps) && parsed.steps.length) ir = buildPlanIR(goal, parsed, 'llm');
  } catch { /* fall through to heuristic */ }
  if (!ir) ir = buildPlanIR(goal, { plain_summary: goal, steps: [{ action: goal, kind: 'prompt', tool: null }] }, 'heuristic');   // LLM 不在/壊れ → 1 prompt step
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

const GEN_PROMPT = (what) => `Write ONE Langflow 1.10.0 custom Component in Python that implements: "${what}".
Exact API shape:
from langflow.custom import Component
from langflow.io import MessageTextInput, Output
from langflow.schema.message import Message
class Thing(Component):
    display_name = "..."
    description = "..."
    inputs = [MessageTextInput(name="x", display_name="X", value="<a real working default>")]
    outputs = [Output(name="result", display_name="Result", method="build")]
    def build(self) -> Message:
        # real implementation — actually fetch/compute. No TODO, no pass, no placeholder.
        return Message(text=<the result as a non-empty string>)
Hard rules:
- Python STANDARD LIBRARY ONLY (urllib.request, json, xml.etree.ElementTree, datetime, math…). No pip packages, no "requests".
- build() must RUN STANDALONE with NO caller input: give every input a real default value, and read self.<name> with a fallback to that default.
- build() MUST return a Message whose .text is the non-empty result string.
Output ONLY the Python code inside one \`\`\`python fence. No prose.`;

const REPAIR_PROMPT = (what, code, err) => `Your Langflow Component for "${what}" FAILED when executed standalone.
--- your code ---
${code}
--- error / output (tail) ---
${err}
Fix it so it runs standalone and returns a Message with non-empty .text. Same hard rules (stdlib only; real default inputs; no pip).
Output ONLY the corrected Python in one \`\`\`python fence. No prose.`;

// 使い捨てサンドボックス: 生成 Component を langflow を install せず stub 注入で standalone 実行し、
// build() が「Message.text に非空の実データ」を返すか検証。失敗時は traceback/出力の末尾を返す（修復ループの入力）。
// ponytail: プロセス隔離 = 使い捨て cwd + timeout + secret を抜いた env。OS サンドボックス(container/seccomp/egress allowlist)は v2（§1.5-I）。
const HARNESS = `import sys, types, traceback
def _mod(n):
    m = types.ModuleType(n); sys.modules[n] = m; return m
class Message:
    def __init__(self, text="", **kw):
        self.text = text if isinstance(text, str) else ("" if text is None else str(text))
        for k, v in kw.items(): setattr(self, k, v)
class Data:
    def __init__(self, data=None, **kw):
        self.data = data
        for k, v in kw.items(): setattr(self, k, v)
class _In:
    def __init__(self, name=None, display_name=None, value=None, **kw):
        self.name = name; self.display_name = display_name; self.value = value
class Output:
    def __init__(self, name=None, display_name=None, method=None, **kw):
        self.name = name; self.display_name = display_name; self.method = method
class Component:
    def __init__(self, **kw):
        for k, v in kw.items(): setattr(self, k, v)
    def log(self, *a, **k): pass
_mod("langflow"); _mod("langflow.custom").Component = Component
io = _mod("langflow.io")
for n in ["MessageTextInput","MessageInput","MultilineInput","SecretStrInput","IntInput","FloatInput","BoolInput","DropdownInput","DataInput","StrInput","HandleInput","NestedDictInput"]:
    setattr(io, n, _In)
io.Output = Output
_mod("langflow.schema.message").Message = Message
_mod("langflow.schema").Data = Data
_mod("langflow.schema.data").Data = Data
src = open("component.py", encoding="utf-8").read()
ns = {}
try:
    exec(compile(src, "component.py", "exec"), ns)
except Exception:
    print("HARNESS_ERR: component did not import"); traceback.print_exc(); sys.exit(2)
cls = next((v for v in ns.values() if isinstance(v, type) and issubclass(v, Component) and v is not Component), None)
if cls is None:
    print("HARNESS_ERR: no Component subclass found"); sys.exit(2)
inst = cls()
for inp in (getattr(cls, "inputs", None) or []):
    nm = getattr(inp, "name", None)
    if nm and getattr(inst, nm, None) in (None, ""): setattr(inst, nm, getattr(inp, "value", None) or "")
method = "build"
outs = getattr(cls, "outputs", None) or []
if outs and getattr(outs[0], "method", None): method = outs[0].method
fn = getattr(inst, method, None)
if not callable(fn):
    print("RUN_ERR: no method %r" % method); sys.exit(3)
try:
    out = fn()
except Exception:
    print("RUN_ERR: build() raised"); traceback.print_exc(); sys.exit(3)
text = getattr(out, "text", None)
if text is None and isinstance(out, str): text = out
if not text or not str(text).strip():
    print("TYPE_ERR: build() returned no Message text (got %s)" % type(out).__name__); sys.exit(4)
print("OK"); print(str(text)[:2000])
`;

export function runInSandbox(code, { python = 'python3', timeout = 30000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shenron-'));
  try {
    writeFileSync(join(dir, 'component.py'), code);
    writeFileSync(join(dir, 'harness.py'), HARNESS);
    const env = Object.fromEntries(Object.entries(process.env)   // secret を抜く（生成コードが env から exfil するのを防ぐ。PATH/SSL/HOME は残す）
      .filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_API|\bAPI_|AUTH|COOKIE/i.test(k)));
    const r = spawnSync(python, ['harness.py'], { cwd: dir, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env });
    const out = r.stdout || '', err = r.stderr || '';
    if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, error: `timeout after ${timeout}ms` };
    if (r.status === 0 && out.startsWith('OK')) return { ok: true, output: out.slice(3).trim() };
    return { ok: false, error: ((out ? out + '\n' : '') + err || `exit ${r.status}`).slice(-1500) };   // 末尾＝traceback（修復の手掛かり）
  } finally { rmSync(dir, { recursive: true, force: true }); }                                          // 使い捨て
}

// 生成→収束→（失敗なら）修復ループ。run/sandbox は test 用に注入可。
export async function genComponent({ what, vendor = 'claude', maxIters = 3, run = runVendorAsync, sandbox = runInSandbox }) {
  what = String(what || '').trim();
  if (!what) throw new Error('what required');
  let code = '', err = null;
  for (let i = 1; i <= maxIters; i++) {
    code = extractCode(await run(vendor, err ? REPAIR_PROMPT(what, code, err) : GEN_PROMPT(what), ''));
    const r = sandbox(code);
    if (r.ok) return { what, code, iters: i, converged: true, output: r.output };
    err = r.error;
  }
  return { what, code, iters: maxIters, converged: false, error: err };
}
