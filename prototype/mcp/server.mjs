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

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(HERE, '..', 'agents');
const TOKEN = process.env.A2A_SHARED_TOKEN || null;     // needed only for run_*/fire_event (act)
const UNATTENDED = process.argv.includes('--unattended') || process.env.BUILDHUD_UNATTENDED === '1';
const log = (...a) => console.error('[buildhud-mcp]', ...a);

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
log(`indexed ${Object.keys(AGENTS).length} agents, ${WORKFLOWS.length} workflows, ${AUTOMATIONS.length} automations${UNATTENDED ? ' [UNATTENDED]' : ''}`);

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

// build_state trigger fires when every key in trigger.match equals the incoming event's value (no eval, subset-match)
const triggerMatches = (trig, event) =>
  !!trig && trig.type === 'build_state' && !!trig.match && Object.entries(trig.match).every(([k, v]) => event?.[k] === v);

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
  { name: 'build_state', description: 'Summary of the BuildHUD state (counts, ids, attended/unattended). Summary only — not a full dump.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'run_handoff', description: 'ACT: send one handoff to an agent skill (A2A). confirm:true to execute; otherwise returns a dry-run plan (attended).',
    inputSchema: { type: 'object', properties: { toAgentId: { type: 'string' }, skill: { type: 'string' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['toAgentId', 'skill', 'input'] } },
  { name: 'run_workflow', description: 'ACT: run a workflow end-to-end (chained A2A handoffs). confirm:true to execute; otherwise returns a dry-run plan (attended).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['id', 'input'] } },
  { name: 'run_automation', description: 'ACT: fire one automation now (runs its bound workflow with its default input). confirm:true to execute; otherwise dry-run. --unattended mode fires enabled automations without confirm.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['id'] } },
  { name: 'fire_event', description: 'ACT: feed a build-state event (e.g. {event:"review_completed",status:"green"}); returns the enabled automations whose build_state trigger matches, and fires them when confirm:true / --unattended. The build-state-triggered run.',
    inputSchema: { type: 'object', properties: { event: { type: 'object' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['event'] } },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'search_agents': return searchAgents(args.query || '', args.limit);
    case 'get_agent': { const a = AGENTS[args.id]; if (!a) throw new Error(`no agent "${args.id}"`); return a; }
    case 'search_workflows': return searchWorkflows(args.query || '', args.limit);
    case 'get_workflow': { const w = WORKFLOWS.find((x) => x.id === args.id); if (!w) throw new Error(`no workflow "${args.id}"`); return w; }
    case 'search_automations': return searchAutomations(args.query || '', args.limit);
    case 'get_automation': { const m = AUTOMATIONS.find((x) => x.id === args.id); if (!m) throw new Error(`no automation "${args.id}"`); return m; }
    case 'build_state': return { agents: Object.keys(AGENTS).length, workflows: WORKFLOWS.length, automations: AUTOMATIONS.length, unattended: UNATTENDED,
      agentIds: Object.keys(AGENTS), workflowIds: WORKFLOWS.map((w) => w.id), automationIds: AUTOMATIONS.map((m) => m.id) };
    case 'run_handoff': {
      const a = AGENTS[args.toAgentId]; if (!a) throw new Error(`no agent "${args.toAgentId}"`);
      if (!shouldExec(args.confirm)) return { dryRun: true, plan: `would send skill "${args.skill}" to ${a.company} (${a.url}) — call again with confirm:true to execute` };
      assertToken();
      return { result: await a2aSend(a.url, args.skill, args.input) };
    }
    case 'run_workflow': {
      const w = WORKFLOWS.find((x) => x.id === args.id); if (!w) throw new Error(`no workflow "${args.id}"`);
      if (!shouldExec(args.confirm)) return { dryRun: true, workflow: w.id, plan: planOf(w), note: 'call again with confirm:true to execute (agents must be running)' };
      assertToken();
      return await execWorkflow(w, args.input);
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
    default: throw new Error(`unknown tool: ${name}`);
  }
}

const RESOURCES = [
  { uri: 'buildhud://agents', name: 'Agent index', description: 'Agent refs (token-light)', mimeType: 'application/json' },
  { uri: 'buildhud://workflows', name: 'Workflow index', description: 'Workflow refs', mimeType: 'application/json' },
  { uri: 'buildhud://automations', name: 'Automation index', description: 'Automation refs (trigger-bound)', mimeType: 'application/json' },
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
