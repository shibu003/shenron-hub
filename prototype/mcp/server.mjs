#!/usr/bin/env node
// server.mjs — BuildHUD MCP server (MCP-first control plane, docs/10). Zero-dependency.
// Lets an AI operate BuildHUD: discover/search/run agents + workflows + automations over MCP (stdio, JSON-RPC).
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

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(HERE, '..', 'agents');
const TOKEN = process.env.A2A_SHARED_TOKEN || null;     // needed only for run_*/fire_event (act)
const UNATTENDED = process.argv.includes('--unattended') || process.env.BUILDHUD_UNATTENDED === '1';
const HUB = process.env.BUILDHUD_HUB || 'http://localhost:8795';     // durable handoff hub (prototype/hub)
const log = (...a) => console.error('[buildhud-mcp]', ...a);

// 登録だけで動く: MCP server 起動時に local hub が居なければ自動起動（detached＝MCP セッションを跨いで常駐・既に居れば再利用）。
// remote な BUILDHUD_HUB は触らない。initialize/tools-list は hub 不要なので即応答し、最初の tool 呼び出しが hubReady を待つ。
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
  (w) => ({ id: w.id, name: w.name, summary: w.summary, steps: w.steps.length, tags: w.tags }), q, limit);
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
  const r = await fetch(`${HUB}${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`hub ${p} → ${r.status} (is the hub running? node prototype/hub/hub.mjs)`);
  return r.json();
}
const hRef = (h) => ({ id: h.id, from: h.from, to: h.to, skill: h.skill, status: h.status });

// ---------- tools ----------
const TOOLS = [
  { name: 'search_agents', description: 'Search the agent index. Returns small refs (id/name/company/skill/tags) — token-light. Use get_agent for full detail.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'get_agent', description: 'Get one agent\'s full card by id (on demand).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'search_workflows', description: 'Search the workflow/automation index. Returns small refs. Use get_workflow for the full definition.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'get_workflow', description: 'Get one workflow\'s full definition (steps) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'search_automations', description: 'Search the automation index (trigger-bound workflow runs: schedule/build_state). Returns small refs — token-light. Use get_automation for the full definition.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'get_automation', description: 'Get one automation\'s full definition (trigger + bound workflow + default input) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'search_integrations', description: 'Search the integration index (connected MCP servers + their external-action tools: email/post/etc). Returns small refs (id/label/kind/enabled/toolCount/tags) — token-light. Use get_integration for the full tool list.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'get_integration', description: 'Get one integration\'s full definition (kind + command/url + tools with accepts/emits) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'build_state', description: 'Summary of the BuildHUD state (counts, ids, attended/unattended). Summary only — not a full dump.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'plan_flow', description: '神龍: turn a natural-language goal into a flow — ordered steps, which existing tools/agents cover each, and which are MISSING (gaps to build). Saves it to the workflow store so it is viewable in the web cockpit (🗂 Flows); pass save:false to design without saving. gap controls self-extension: "ask" (default) surfaces gaps to build, "auto" auto-generates them, "off" plans with existing tools only. Designs, does not run — act on it with run_workflow.',
    inputSchema: { type: 'object', properties: { goal: { type: 'string' }, save: { type: 'boolean' }, gap: { type: 'string', enum: ['off', 'ask', 'auto'] } }, required: ['goal'] } },
  { name: 'gen_component', description: '神龍: BUILD a missing tool for a gap — generates a standalone MCP server (claude/codex writes stdlib code), then spawn+handshake+run verifies it and repairs in a loop. Returns the converged code + a pending component id. The self-extension step: when no existing tool/MCP covers a step, 神龍 writes one. Approve it with approve_component to make it usable.',
    inputSchema: { type: 'object', properties: { what: { type: 'string' }, maxIters: { type: 'number' } }, required: ['what'] } },
  { name: 'list_components', description: 'List generated components (the build→vet→remember store). Small refs (id/what/approved/iters); pending (approved:false) await approve_component, approved ones are live integrations. Pass id for the full code.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'approve_component', description: 'Human gate: approve a generated component by id → writes prototype/mcp/generated/<id>.py and registers it as an MCP integration (ladder rejoin). After this, re-plan resolves the gap to a real mcp node and run_workflow can use it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_permissions', description: 'Get the browser-control permission ruleset (allow/ask/deny). Read-only browser tools default allow; mutating/outbound default ask. Controls when the computer-use worker pauses for a human checkpoint.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'set_permission', description: '「常に許可」: append an allow rule to the browser-control ruleset so a tool (optionally scoped to a domain) stops asking. Mirrors the cockpit always-allow button; audited.',
    inputSchema: { type: 'object', properties: { tool: { type: 'string' }, domain: { type: 'string' } }, required: ['tool'] } },
  { name: 'make_skill', description: '神龍 Wave 7: turn a saved workflow into a Claude Code SKILL.md (a thin wrapper that calls run_workflow). Returns the slug + path so a local agent can invoke the flow as a skill.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'run_handoff', description: 'ACT: send one handoff to an agent skill (A2A). confirm:true to execute; otherwise returns a dry-run plan (attended).',
    inputSchema: { type: 'object', properties: { toAgentId: { type: 'string' }, skill: { type: 'string' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['toAgentId', 'skill', 'input'] } },
  { name: 'run_workflow', description: 'ACT: run a workflow end-to-end (chained A2A handoffs). confirm:true to execute; otherwise returns a dry-run plan (attended).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['id', 'input'] } },
  { name: 'run_automation', description: 'ACT: fire one automation now (runs its bound workflow with its default input). confirm:true to execute; otherwise dry-run. --unattended mode fires enabled automations without confirm.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['id'] } },
  { name: 'fire_event', description: 'ACT: feed a build-state event (e.g. {event:"review_completed",status:"green"}); returns the enabled automations whose build_state trigger matches, and fires them when confirm:true / --unattended. The build-state-triggered run.',
    inputSchema: { type: 'object', properties: { event: { type: 'object' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['event'] } },
  // --- durable inbox (offline-tolerant handoffs via the hub). Unlike run_handoff (sync, recipient must be online),
  //     send_handoff survives the recipient being offline — delivered + acted on (approve/auto) at its next poll. ---
  { name: 'send_handoff', description: 'Durable handoff: enqueue work to an agent\'s inbox (hub). Survives the recipient being OFFLINE — delivered on its next poll. Does NOT need the recipient online (unlike run_handoff).',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, skill: { type: 'string' }, input: { type: 'string' }, from: { type: 'string' } }, required: ['to', 'skill'] } },
  { name: 'list_handoffs', description: 'List inbox handoffs (hub). Small refs (id/from/to/skill/status) — token-light. Optional agent/status/limit filter.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'get_handoff', description: 'Get one handoff\'s full record (input/result/error/history) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'poll_inbox', description: 'ACT as an agent coming online: heartbeat (presence) + claim its runnable (auto/approved) handoffs from the hub.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
  { name: 'approve_handoff', description: 'Approve an awaiting_approval handoff — it runs on the recipient\'s next poll.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'decline_handoff', description: 'Decline an awaiting_approval handoff.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'set_policy', description: 'Set an agent\'s inbox policy: "approval" (human gate) or "auto" (run on poll, automation-like).',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, policy: { type: 'string' } }, required: ['agent', 'policy'] } },
];

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
    case 'build_state': return { agents: Object.keys(AGENTS).length, workflows: WORKFLOWS.length, automations: AUTOMATIONS.length, integrations: INTEGRATIONS.length, unattended: UNATTENDED,
      agentIds: Object.keys(AGENTS), workflowIds: WORKFLOWS.map((w) => w.id), automationIds: AUTOMATIONS.map((m) => m.id) };
    case 'plan_flow':                                            // 神龍 over MCP → hub plans (inventory+validate+layout) and SAVES it (save:false to skip) → viewable in the web cockpit 🗂
      return await hub('/api/shenron/plan', { goal: args.goal, save: args.save !== false, ...(args.gap ? { gap: args.gap } : {}) });
    case 'run_handoff': {
      const a = AGENTS[args.toAgentId]; if (!a) throw new Error(`no agent "${args.toAgentId}"`);
      if (!shouldExec(args.confirm)) return { dryRun: true, plan: `would send skill "${args.skill}" to ${a.company} (${a.url}) — call again with confirm:true to execute` };
      assertToken();
      return { result: await a2aSend(a.url, args.skill, args.input) };
    }
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
    default: throw new Error(`unknown tool: ${name}`);
  }
}

const RESOURCES = [
  { uri: 'buildhud://agents', name: 'Agent index', description: 'Agent refs (token-light)', mimeType: 'application/json' },
  { uri: 'buildhud://workflows', name: 'Workflow index', description: 'Workflow refs', mimeType: 'application/json' },
  { uri: 'buildhud://automations', name: 'Automation index', description: 'Automation refs (trigger-bound)', mimeType: 'application/json' },
  { uri: 'buildhud://integrations', name: 'Integration index', description: 'Integration refs (MCP servers + tool counts)', mimeType: 'application/json' },
  { uri: 'buildhud://state', name: 'Build state summary', description: 'Counts/summary', mimeType: 'application/json' },
];

// ---------- MCP stdio (newline-delimited JSON-RPC) ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const asText = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  try {
    switch (method) {
      case 'initialize':
        return ok(id, { protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'buildhud-mcp', version: '0.1.0' } });
      case 'notifications/initialized': return;            // notification, no reply
      case 'ping': return ok(id, {});
      case 'tools/list': return ok(id, { tools: TOOLS });
      case 'tools/call': {
        try { return ok(id, asText(await callTool(params?.name, params?.arguments))); }
        catch (e) { return ok(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }); }
      }
      case 'resources/list': return ok(id, { resources: RESOURCES });
      case 'resources/read': {
        const uri = params?.uri;
        const body = uri === 'buildhud://agents' ? searchAgents('', 999)
          : uri === 'buildhud://workflows' ? searchWorkflows('', 999)
          : uri === 'buildhud://automations' ? searchAutomations('', 999)
          : uri === 'buildhud://integrations' ? searchIntegrations('', 999)
          : uri === 'buildhud://state' ? await callTool('build_state')
          : null;
        if (body == null) return err(id, -32602, `unknown resource: ${uri}`);
        return ok(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] });
      }
      default: if (id != null) return err(id, -32601, `method not found: ${method}`);
    }
  } catch (e) { if (id != null) err(id, -32603, e.message); }
});
log('ready on stdio');
