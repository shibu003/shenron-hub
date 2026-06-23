#!/usr/bin/env node
// server.mjs — Shenron MCP server (MCP-first control plane, docs/10). Zero-dependency.
// Lets an AI operate Shenron: discover/search/run agents + workflows + automations over MCP (stdio, JSON-RPC).
//
// clean-mcp token-light principle: search_* return SMALL refs; get_* load ONE full item on demand.
// Never dump everything into context — search the index, expand one, act. Three indexes share one searcher.
//
//   A2A_SHARED_TOKEN=... node prototype/mcp/server.mjs              # attended (default): run_* need confirm:true
//   A2A_SHARED_TOKEN=... node prototype/mcp/server.mjs --unattended # autonomous: enabled automations fire w/o confirm
//
// stdout = JSON-RPC only. All logs → stderr. MCP version/schema are minimal; verify vs MCP spec for prod.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { triggerMatches } from '../match.mjs';
import { TOOLS, forStdio } from './tools.mjs';   // Wave U-1: tool defs single-sourced (shared with hub remote-MCP)

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(HERE, '..', 'agents');
const TOKEN = process.env.A2A_SHARED_TOKEN || null;     // needed only for run_*/fire_event (act)
const UNATTENDED = process.argv.includes('--unattended') || process.env.SHENRON_UNATTENDED === '1';
const HUB = process.env.SHENRON_HUB || 'http://localhost:8795';     // durable handoff hub (prototype/hub)
const log = (...a) => console.error('[shenron-mcp]', ...a);

// 登録だけで動く: MCP server 起動時に local hub が居なければ自動起動（detached＝MCP セッションを跨いで常駐・既に居れば再利用）。
// remote な SHENRON_HUB は触らない。initialize/tools-list は hub 不要なので即応答し、最初の tool 呼び出しが hubReady を待つ。
const HUB_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(HUB);
async function ensureHub() {
  if (!HUB_LOCAL) return;                                            // remote hub → not ours to manage
  try { await fetch(`${HUB}/api/state`); return; } catch {}         // already up → reuse
  const script = path.join(HERE, '..', 'hub', 'hub.mjs');
  const port = (HUB.match(/:(\d+)/) || [])[1] || '8795';
  try { const child = spawn(process.execPath, [script, '--port', port], { cwd: path.join(HERE, '..', '..'), stdio: 'ignore', detached: true }); child.unref(); log('auto-starting hub on', HUB); }
  catch (e) { return void log('hub spawn failed:', e.message); }
  for (let i = 0; i < 40; i++) { try { await fetch(`${HUB}/api/state`); return void log('hub up'); } catch { await new Promise((r) => setTimeout(r, 250)); } }
  log('hub did not come up in 10s — tool calls may fail');
}
const hubReady = ensureHub();   // kick off now; do NOT block initialize/tools-list (they need no hub)

// ---------- build the indexes (token-light: refs only; full loaded on demand) ----------
function loadAgents() {
  const out = {};
  for (const f of fs.readdirSync(AGENTS_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
      if (!c.name || !c.skill) continue;
      out[c.name] = {
        id: c.name, name: c.name, company: c.company, url: c.publicUrl || `http://localhost:${c.port}`,
        skill: { id: c.skill.id, name: c.skill.name, description: c.skill.description, tags: c.skill.tags || [], vendor: c.skill.vendor },
      };
    } catch (e) { log('skip', f, e.message); }
  }
  return out;
}
const loadJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(HERE, file), 'utf8')); } catch { return fallback; } };
let AGENTS = loadAgents();
let WORKFLOWS = loadJson('workflows.json', []);
let AUTOMATIONS = loadJson('automations.json', []);
let INTEGRATIONS = loadJson('integrations.json', []);
log(`indexed ${Object.keys(AGENTS).length} agents, ${WORKFLOWS.length} workflows, ${AUTOMATIONS.length} automations, ${INTEGRATIONS.length} integrations${UNATTENDED ? ' [UNATTENDED]' : ''}`);

// keyword scorer (MVP; swap for embeddings later) + one generic searcher over any index
function score(text, query) {
  const hay = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
}
function searchIndex(items, toText, toRef, query = '', limit = 5) {
  return items
    .map((it) => ({ it, s: score(toText(it), query) }))
    .filter((x) => x.s > 0 || !query).sort((x, y) => y.s - x.s).slice(0, limit)
    .map(({ it }) => toRef(it));
}
const searchAgents = (q, limit) => searchIndex(Object.values(AGENTS),
  (a) => `${a.name} ${a.company} ${a.skill.id} ${a.skill.name} ${a.skill.description} ${a.skill.tags.join(' ')}`,
  (a) => ({ id: a.id, name: a.name, company: a.company, skillId: a.skill.id, skill: a.skill.name, tags: a.skill.tags }), q, limit);
const searchWorkflows = (q, limit) => searchIndex(WORKFLOWS,
  (w) => `${w.name} ${w.summary} ${(w.tags || []).join(' ')}`,
  (w) => ({ id: w.id, name: w.name, summary: w.summary, steps: w.steps.length, tags: w.tags, lastRun: w.lastRun || null }), q, limit);
const searchAutomations = (q, limit) => searchIndex(AUTOMATIONS,
  (m) => `${m.name} ${m.summary} ${(m.tags || []).join(' ')} ${m.trigger?.type || ''} ${m.workflow}`,
  (m) => ({ id: m.id, name: m.name, summary: m.summary, trigger: m.trigger?.type, workflow: m.workflow, enabled: m.enabled !== false, tags: m.tags }), q, limit);
const searchIntegrations = (q, limit) => searchIndex(INTEGRATIONS,
  (it) => `${it.label} ${it.id} ${it.kind} ${(it.tools || []).map((tl) => tl.name).join(' ')} ${(it.tags || []).join(' ')}`,
  (it) => ({ id: it.id, label: it.label, kind: it.kind, enabled: it.enabled !== false, tools: (it.tools || []).length, tags: it.tags }), q, limit);

// build_state trigger matching (deep-subset + $-operator DSL) → ../match.mjs, shared with hub.mjs.

// ---------- A2A act helpers (run_*) ----------
// Ad-hoc dispatch (run_handoff/run_workflow) is ALWAYS attended — `--unattended` does NOT loosen it.
// Only pre-declared, enabled automations (run_automation/fire_event) honor --unattended.
const shouldExec = (confirm, allowUnattended = false) => confirm === true || (allowUnattended && UNATTENDED);
const assertToken = () => { if (!TOKEN) throw new Error('A2A_SHARED_TOKEN required to execute'); };

async function a2aSend(agentUrl, skill, inputText) {
  const r = await fetch(`${agentUrl.replace(/\/$/, '')}/`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'message/send',
      params: { message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: JSON.stringify({ input: inputText }) }] }, metadata: { skill } } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${agentUrl} RPC ${j.error.code}: ${j.error.message}`);
  return (j.result?.parts || []).find((p) => p.kind === 'text')?.text || '';
}
// run a workflow's chained handoffs; shared by run_workflow / run_automation / fire_event
async function execWorkflow(w, input) {
  let payload = input; const trace = [];
  for (const step of w.steps) {
    const a = AGENTS[step.agent]; if (!a) throw new Error(`workflow refs unknown agent "${step.agent}"`);
    const out = await a2aSend(a.url, step.skill, payload);
    trace.push({ agent: a.company, skill: step.skill, chars: out.length });
    payload = out;
  }
  return { result: payload, trace };
}
const planOf = (w) => w.steps.map((s, i) => `${i + 1}. ${AGENTS[s.agent]?.company || s.agent} · ${s.skill}`);

// ---------- durable inbox (hub proxy: prototype/hub) ----------
async function hub(p, body) {
  await hubReady;                                                    // ensure the (auto-started) hub is up before any call
  const r = await fetch(`${HUB}${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: body ? JSON.stringify(body) : undefined });   // Wave C: auth act routes (no-op when hub is open)
  if (!r.ok) throw new Error(`hub ${p} → ${r.status} (is the hub running? node prototype/hub/hub.mjs)`);
  return r.json();
}
const hRef = (h) => ({ id: h.id, from: h.from, to: h.to, skill: h.skill, status: h.status });

// ---------- tools ---------- (defs live in ./tools.mjs; stdio surface = forStdio filter)
const STDIO_TOOLS = TOOLS.filter(forStdio);

async function callTool(name, args = {}) {
  switch (name) {
    case 'search_agents': return searchAgents(args.query || '', args.limit);
    case 'get_agent': { const a = AGENTS[args.id]; if (!a) throw new Error(`no agent "${args.id}"`); return a; }
    case 'search_workflows': return searchWorkflows(args.query || '', args.limit);
    case 'get_workflow': { const w = WORKFLOWS.find((x) => x.id === args.id); if (!w) throw new Error(`no workflow "${args.id}"`); return w; }
    case 'search_automations': return searchAutomations(args.query || '', args.limit);
    case 'get_automation': { const m = AUTOMATIONS.find((x) => x.id === args.id); if (!m) throw new Error(`no automation "${args.id}"`); return m; }
    case 'search_integrations': return searchIntegrations(args.query || '', args.limit);
    case 'get_integration': { const it = INTEGRATIONS.find((x) => x.id === args.id); if (!it) throw new Error(`no integration "${args.id}"`); return it; }
    case 'add_integration': {                                   // Wave B①: register an MCP server → hub saveIntegration → shows up in plan_flow available
      const saved = await hub('/api/integrations', { id: args.id, label: args.label, kind: args.kind || 'mcp', command: args.command || '', url: args.url || '', tools: args.tools || [] });
      INTEGRATIONS = loadJson('integrations.json', []);         // refresh local index so search_integrations/plan see it immediately
      return saved;
    }
    case 'add_automation':                                      // Wave: schedule(cron)/build-state → auto-run a saved workflow (in-hub scheduler fires while the hub is up)
      return await hub('/api/automations', { name: args.name, trigger: args.trigger, workflow: args.workflow, input: args.input || '' });
    case 'toggle_automation': {
      const r = await hub(`/api/automations/${encodeURIComponent(args.id)}/toggle`, { on: args.on });
      const a = AUTOMATIONS.find((x) => x.id === args.id); if (a) a.enabled = args.on !== false;   // keep the in-memory search index in sync (hub file is the source of truth for firing)
      return r;
    }
    case 'get_config': return await hub('/api/config');         // Wave: 全設定を1か所で読む（NL 設定変更の前後確認）
    case 'set_config': return await hub('/api/config', args || {});   // Wave: 設定を1か所で更新（自然文→構造化して渡す・即反映）
    case 'build_state': return { agents: Object.keys(AGENTS).length, workflows: WORKFLOWS.length, automations: AUTOMATIONS.length, integrations: INTEGRATIONS.length, unattended: UNATTENDED,
      agentIds: Object.keys(AGENTS), workflowIds: WORKFLOWS.map((w) => w.id), automationIds: AUTOMATIONS.map((m) => m.id) };
    case 'plan_flow':                                            // 神龍 over MCP → hub plans (inventory+validate+layout) and SAVES it (save:false to skip) → viewable in the web cockpit 🗂
      return await hub('/api/shenron/plan', { goal: args.goal, save: args.save !== false, ...(args.gap ? { gap: args.gap } : {}), ...(args.cost ? { cost: args.cost } : {}), ...(args.context ? { context: args.context } : {}) });   // cost(お財布) と context(discover clarify 回答) を転送
    case 'run_handoff': {
      const a = AGENTS[args.toAgentId]; if (!a) throw new Error(`no agent "${args.toAgentId}"`);
      if (!shouldExec(args.confirm)) return { dryRun: true, plan: `would send skill "${args.skill}" to ${a.company} (${a.url}) — call again with confirm:true to execute` };
      assertToken();
      return { result: await a2aSend(a.url, args.skill, args.input) };
    }
    case 'list_templates': return await hub('/api/templates');
    case 'install_template': return await hub(`/api/templates/${encodeURIComponent(args.id)}/install`, {});
    case 'run_workflow': {
      WORKFLOWS = loadJson('workflows.json', []);             // refresh: pick up flows saved from the cockpit
      const w = WORKFLOWS.find((x) => x.id === args.id); if (!w) throw new Error(`no workflow "${args.id}"`);
      const isDag = Array.isArray(w.nodes) && Array.isArray(w.edges);
      if (!shouldExec(args.confirm)) return { dryRun: true, workflow: w.id, plan: planOf(w), note: isDag ? 'DAG flow → runs via the hub (B1 executor, no agent servers); call again with confirm:true' : 'call again with confirm:true to execute (agents must be running)' };
      assertToken();
      if (isDag) return await hub('/api/runflow', { id: w.id, input: args.input });   // same DAG run as the cockpit ▶ (topo via hub + B1)
      return await execWorkflow(w, args.input);                // legacy linear steps via a2aSend
    }
    case 'run_automation': {
      const m = AUTOMATIONS.find((x) => x.id === args.id); if (!m) throw new Error(`no automation "${args.id}"`);
      if (m.enabled === false) throw new Error(`automation "${m.id}" is disabled`);   // before dry-run: don't promise a run we'd refuse
      const w = WORKFLOWS.find((x) => x.id === m.workflow); if (!w) throw new Error(`automation refs unknown workflow "${m.workflow}"`);
      const input = args.input ?? m.input ?? '';
      if (!shouldExec(args.confirm, true)) return { dryRun: true, automation: m.id, trigger: m.trigger, workflow: w.id, plan: planOf(w), input, note: 'call again with confirm:true (or run server --unattended) to fire' };
      assertToken();
      return { automation: m.id, ...(await execWorkflow(w, input)) };
    }
    case 'fire_event': {
      const event = args.event || {};
      const matched = AUTOMATIONS.filter((m) => m.enabled !== false && triggerMatches(m.trigger, event));
      const refs = matched.map((m) => ({ id: m.id, name: m.name, workflow: m.workflow }));
      if (!shouldExec(args.confirm, true)) return { event, matched: refs,
        note: matched.length ? 'call again with confirm:true (or run server --unattended) to fire matched automations' : 'no enabled automation matched this event' };
      assertToken();
      const fired = [];
      for (const m of matched) {                                  // one bad agent must not abort the other matched automations
        const w = WORKFLOWS.find((x) => x.id === m.workflow);
        if (!w) { fired.push({ automation: m.id, error: `unknown workflow "${m.workflow}"` }); continue; }
        try { fired.push({ automation: m.id, ...(await execWorkflow(w, args.input ?? m.input ?? '')) }); }
        catch (e) { fired.push({ automation: m.id, error: e.message }); }
      }
      return { event, fired };
    }
    case 'send_handoff': return hRef(await hub('/api/handoffs', { to: args.to, skill: args.skill, input: args.input || '', from: args.from || 'mcp' }));
    case 'list_handoffs': {
      const { handoffs } = await hub('/api/state');
      let hs = handoffs;
      if (args.agent) hs = hs.filter((h) => h.to === args.agent || h.from === args.agent);
      if (args.status) hs = hs.filter((h) => h.status === args.status);
      return hs.slice(-(args.limit || 20)).map(hRef);
    }
    case 'get_handoff': { const { handoffs } = await hub('/api/state'); const h = handoffs.find((x) => x.id === args.id); if (!h) throw new Error(`no handoff "${args.id}"`); return h; }
    case 'poll_inbox': { const { runnable } = await hub('/api/poll', { agent: args.agent }); return { runnable: runnable.map(hRef) }; }
    case 'approve_handoff': return hRef(await hub(`/api/handoffs/${args.id}/approve`, {}));
    case 'decline_handoff': return hRef(await hub(`/api/handoffs/${args.id}/decline`, {}));
    case 'set_policy': return await hub(`/api/agents/${args.agent}/policy`, { policy: args.policy });
    // 神龍 self-extension + co-pilot gates over MCP (web cockpit no longer required for the full lifecycle)
    case 'gen_component': return await hub('/api/shenron/gen-component', { what: args.what, ...(args.maxIters ? { maxIters: args.maxIters } : {}) });
    case 'list_components': return await hub(args.id ? `/api/shenron/components?id=${encodeURIComponent(args.id)}` : '/api/shenron/components');
    case 'approve_component': return await hub('/api/shenron/components/approve', { id: args.id });
    case 'get_permissions': return await hub('/api/permissions');
    case 'set_permission': return await hub('/api/permissions', { tool: args.tool, domain: args.domain });
    case 'make_skill': return await hub('/api/shenron/skill', { id: args.id });
    // Wave H: Push通知
    case 'set_notify': return await hub('/api/integrations', { id: args.id || (args.format === 'slack' ? 'slack-notify' : 'webhook-notify'), label: args.label || 'Webhook通知', kind: 'notify', url: args.url, format: args.format || 'json', token: args.token || '', enabled: args.enabled !== false, tools: [] });
    // Wave I: Credential vault
    case 'set_credential': return await hub('/api/credentials', { action: 'set', id: args.id, value: args.value });
    case 'get_credential': return await hub('/api/credentials', { action: 'get', id: args.id });
    case 'list_credentials': return await hub('/api/credentials', { action: 'list' });
    case 'delete_credential': return await hub('/api/credentials', { action: 'delete', id: args.id });
    // Wave J: Skill共有
    case 'export_skill': return await hub('/api/components/export', { id: args.id });
    case 'import_skill': { const b = args.blob || {}; return await hub('/api/components/import', { what: args.what || b.what, code: args.code || b.code, iters: b.iters }); }
    // Wave L: Auth
    case 'list_users': return await hub('/api/auth/users');
    // Wave M-1: reset
    case 'reset_password':
      if (args.token) return await hub('/api/auth/reset', { token: args.token, password: args.password });
      return await hub('/api/auth/reset-request', { email: args.email });
    // Wave M-2: run 履歴
    case 'list_runs': return await hub('/api/runs');
    case 'get_run': return await hub(`/api/runs/${encodeURIComponent(args.id)}`);
    case 'stream_run': {
      // hub の remote-MCP (POST /mcp) tools/call を直叩き — mcpDispatch の stream_run（待機集約）を再利用
      await hubReady;
      const r = await fetch(`${HUB}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stream_run', arguments: { id: args.id, timeout: args.timeout } } }) });
      if (!r.ok) throw new Error(`hub /mcp → ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return JSON.parse(j.result.content[0].text);
    }
    // Wave M-3: 通知テスト
    case 'test_notify': return await hub('/api/notify/test', {});
    // Wave P: Agent Factory
    case 'create_agent': return await hub('/api/agents', { name: args.name, systemPrompt: args.instructions, vendor: args.vendor, model: args.model });
    case 'run_agent': return await hub(`/api/agents/${encodeURIComponent(args.name)}/run`, { input: args.input });
    case 'delete_agent': return await hub(`/api/agents/${encodeURIComponent(args.name)}/delete`, {});
    case 'export_agent_mcp': return await hub(`/api/agents/${encodeURIComponent(args.name)}/export-mcp`, {});
    // Wave S: セッション横断メモリ（hub proxy 経由＝relevantMemories は hub 単一実装を共有）
    case 'remember': return await hub('/api/memory', { action: 'add', text: args.text, tags: args.tags || [] });
    case 'recall': return await hub('/api/memory', { action: 'recall', query: args.query || '', topN: args.topN });   // topN 未指定は hub 側 default に委譲（重複なし）
    case 'forget': return await hub('/api/memory', { action: 'delete', id: args.id });
    // Wave R-1: 成果検証
    case 'set_check': return await hub('/api/check', { automation: args.automation, expect: args.expect });
    case 'list_check_results': return await hub('/api/check-results');
    case 'login_status': return await hub(args.domain ? `/api/login-status?domain=${encodeURIComponent(args.domain)}` : '/api/login-status');   // Wave Login-1: ログイン生存状態（GET）
    case 'set_goal': return await hub('/api/goals', args || {});                                    // Wave Goals-1: ゴール作成/更新
    case 'get_goal': return await hub(`/api/goals/${encodeURIComponent(args.id)}`);
    case 'list_goals': return (await hub('/api/goals')).goals;
    case 'goal_checkin': return await hub(`/api/goals/${encodeURIComponent(args.id)}/checkin`, { value: args.value, note: args.note || '' });
    case 'delete_goal': return await hub(`/api/goals/${encodeURIComponent(args.id)}/delete`, {});
    default:
      if (name.startsWith('agent_')) return await hub(`/api/agents/${encodeURIComponent(name.slice(6))}/run`, { input: args.input });   // P-2: 動的露出した agent_<name> の実行
      throw new Error(`unknown tool: ${name}`);
  }
}

const RESOURCES = [
  { uri: 'shenron://agents', name: 'Agent index', description: 'Agent refs (token-light)', mimeType: 'application/json' },
  { uri: 'shenron://workflows', name: 'Workflow index', description: 'Workflow refs', mimeType: 'application/json' },
  { uri: 'shenron://automations', name: 'Automation index', description: 'Automation refs (trigger-bound)', mimeType: 'application/json' },
  { uri: 'shenron://integrations', name: 'Integration index', description: 'Integration refs (MCP servers + tool counts)', mimeType: 'application/json' },
  { uri: 'shenron://state', name: 'Build state summary', description: 'Counts/summary', mimeType: 'application/json' },
];

// ---------- MCP stdio (newline-delimited JSON-RPC) ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const asText = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
// P-2: hub の live state から local agent を引き、agent_<name> tool 定義に変換（create_agent 直後に tools/list へ反映）。
async function agentTools() {
  try {
    const { agents } = await hub('/api/state');
    return (agents || []).filter((a) => a.local).map((a) => ({
      name: `agent_${a.id}`,
      description: `エージェント「${a.id}」を実行${a.skill && a.skill !== 'task' ? `（skill: ${a.skill}）` : ''}。create_agent で作成された local agent。`,
      inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'エージェントへの入力（タスク内容）' } }, required: ['input'] },
    }));
  } catch { return []; }   // hub 未起動でも tools/list は静的分だけ返す
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  try {
    switch (method) {
      case 'initialize':
        return ok(id, { protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'shenron-mcp', version: '0.1.0' } });
      case 'notifications/initialized': return;            // notification, no reply
      case 'ping': return ok(id, {});
      case 'tools/list': return ok(id, { tools: [...STDIO_TOOLS, ...await agentTools()] });   // P-2: hub の live local agents を agent_<name> tool として append
      case 'tools/call': {
        try { return ok(id, asText(await callTool(params?.name, params?.arguments))); }
        catch (e) { return ok(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }); }
      }
      case 'resources/list': return ok(id, { resources: RESOURCES });
      case 'resources/read': {
        const uri = params?.uri;
        const body = uri === 'shenron://agents' ? searchAgents('', 999)
          : uri === 'shenron://workflows' ? searchWorkflows('', 999)
          : uri === 'shenron://automations' ? searchAutomations('', 999)
          : uri === 'shenron://integrations' ? searchIntegrations('', 999)
          : uri === 'shenron://state' ? await callTool('build_state')
          : null;
        if (body == null) return err(id, -32602, `unknown resource: ${uri}`);
        return ok(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] });
      }
      default: if (id != null) return err(id, -32601, `method not found: ${method}`);
    }
  } catch (e) { if (id != null) err(id, -32603, e.message); }
});
log('ready on stdio');
