#!/usr/bin/env node
// server.mjs — BuildHUD MCP server (MCP-first control plane, docs/10). Zero-dependency.
// Lets an AI operate BuildHUD: discover/search/run agents + workflows over MCP (stdio, JSON-RPC).
//
// clean-mcp token-light principle: search_* return SMALL refs; get_* load ONE full item on demand.
// Never dump everything into context — search the index, expand one, act.
//
//   A2A_SHARED_TOKEN=... node prototype/mcp/server.mjs        # add to your MCP client config (docs/10 §7)
//
// stdout = JSON-RPC only. All logs → stderr. MCP version/schema are minimal; verify vs MCP spec for prod.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(HERE, '..', 'agents');
const TOKEN = process.env.A2A_SHARED_TOKEN || null;     // needed only for run_* (act)
const log = (...a) => console.error('[buildhud-mcp]', ...a);

// ---------- build the index (token-light: refs only; full loaded on demand) ----------
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
function loadWorkflows() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'workflows.json'), 'utf8')); } catch { return []; }
}
let AGENTS = loadAgents();
let WORKFLOWS = loadWorkflows();
log(`indexed ${Object.keys(AGENTS).length} agents, ${WORKFLOWS.length} workflows`);

// keyword scorer (MVP; swap for embeddings later)
function score(text, query) {
  const hay = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
}
function searchAgents(query, limit = 5) {
  return Object.values(AGENTS)
    .map((a) => ({ a, s: score(`${a.name} ${a.company} ${a.skill.id} ${a.skill.name} ${a.skill.description} ${a.skill.tags.join(' ')}`, query) }))
    .filter((x) => x.s > 0 || !query).sort((x, y) => y.s - x.s).slice(0, limit)
    .map(({ a }) => ({ id: a.id, name: a.name, company: a.company, skillId: a.skill.id, skill: a.skill.name, tags: a.skill.tags }));
}
function searchWorkflows(query, limit = 5) {
  return WORKFLOWS
    .map((w) => ({ w, s: score(`${w.name} ${w.summary} ${(w.tags || []).join(' ')}`, query) }))
    .filter((x) => x.s > 0 || !query).sort((x, y) => y.s - x.s).slice(0, limit)
    .map(({ w }) => ({ id: w.id, name: w.name, summary: w.summary, steps: w.steps.length, tags: w.tags }));
}

// ---------- A2A act helpers (run_*) ----------
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
  { name: 'build_state', description: 'Summary of the BuildHUD state (counts, agents, workflows). Summary only — not a full dump.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'run_handoff', description: 'ACT: send one handoff to an agent skill (A2A). Pass confirm:true to execute; otherwise returns a dry-run plan (attended).',
    inputSchema: { type: 'object', properties: { toAgentId: { type: 'string' }, skill: { type: 'string' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['toAgentId', 'skill', 'input'] } },
  { name: 'run_workflow', description: 'ACT: run a workflow end-to-end (chained A2A handoffs). Pass confirm:true to execute; otherwise returns a dry-run plan (attended).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['id', 'input'] } },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'search_agents': return searchAgents(args.query || '', args.limit);
    case 'get_agent': { const a = AGENTS[args.id]; if (!a) throw new Error(`no agent "${args.id}"`); return a; }
    case 'search_workflows': return searchWorkflows(args.query || '', args.limit);
    case 'get_workflow': { const w = WORKFLOWS.find((x) => x.id === args.id); if (!w) throw new Error(`no workflow "${args.id}"`); return w; }
    case 'build_state': return { agents: Object.keys(AGENTS).length, workflows: WORKFLOWS.length, agentIds: Object.keys(AGENTS), workflowIds: WORKFLOWS.map((w) => w.id) };
    case 'run_handoff': {
      const a = AGENTS[args.toAgentId]; if (!a) throw new Error(`no agent "${args.toAgentId}"`);
      if (!args.confirm) return { dryRun: true, plan: `would send skill "${args.skill}" to ${a.company} (${a.url}) — call again with confirm:true to execute` };
      if (!TOKEN) throw new Error('A2A_SHARED_TOKEN required to execute');
      return { result: await a2aSend(a.url, args.skill, args.input) };
    }
    case 'run_workflow': {
      const w = WORKFLOWS.find((x) => x.id === args.id); if (!w) throw new Error(`no workflow "${args.id}"`);
      const plan = w.steps.map((s, i) => `${i + 1}. ${AGENTS[s.agent]?.company || s.agent} · ${s.skill}`);
      if (!args.confirm) return { dryRun: true, workflow: w.id, plan, note: 'call again with confirm:true to execute (agents must be running)' };
      if (!TOKEN) throw new Error('A2A_SHARED_TOKEN required to execute');
      let payload = args.input; const trace = [];
      for (const step of w.steps) {
        const a = AGENTS[step.agent]; if (!a) throw new Error(`workflow refs unknown agent "${step.agent}"`);
        const out = await a2aSend(a.url, step.skill, payload);
        trace.push({ agent: a.company, skill: step.skill, chars: out.length });
        payload = out;
      }
      return { result: payload, trace };
    }
    default: throw new Error(`unknown tool: ${name}`);
  }
}

const RESOURCES = [
  { uri: 'buildhud://agents', name: 'Agent index', description: 'Agent refs (token-light)', mimeType: 'application/json' },
  { uri: 'buildhud://workflows', name: 'Workflow index', description: 'Workflow refs', mimeType: 'application/json' },
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
