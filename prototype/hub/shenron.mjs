// shenron.mjs — 神龍 plan 層（Wave 1）。自然文 goal → plan IR。docs/13 §1.5・§5 Wave 1。
// spike 接地の設計:
//  - LLM は steps[] だけ吐く（§1.5-G: claude -p は生テキスト・structured output 不可）。nodes/edges は確定コードで組む。
//  - 各 step の have/missing は LLM-resolve（§1.5-F gate1, spike0: 危険な過小検出 0%）。
//    プロンプトに「generic ツールは specific need を covered しない」を明記（spike0 でこれが効いた）。inventory を注入。
//  - nodes/edges の port 検証・layout は hub 側（validateFlow/layoutFlow）に委譲。ここは raw を返す。
import { runVendorAsync } from '../runner.mjs';

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

export async function plan({ goal, agents = [], tools = [], workflows = [], vendor = 'claude' }) {
  goal = String(goal || '').trim();
  if (!goal) throw new Error('goal required');
  const out = await runVendorAsync(vendor, PROMPT(goal, inventoryText({ agents, tools, workflows })), '');
  try {
    const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    if (Array.isArray(parsed.steps) && parsed.steps.length) return buildPlanIR(goal, parsed, 'llm');
  } catch { /* fall through to heuristic */ }
  return buildPlanIR(goal, { plain_summary: goal, steps: [{ action: goal, kind: 'prompt', tool: null }] }, 'heuristic');   // LLM 不在/壊れ → 1 prompt step
}
