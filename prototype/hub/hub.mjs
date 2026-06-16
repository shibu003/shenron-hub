#!/usr/bin/env node
// hub.mjs — BuildHUD durable handoff hub (broker). Zero-dependency HTTP server.
// The piece A2A does NOT give us: a store-and-forward inbox so a handoff survives the recipient being
// OFFLINE, then is delivered when it next polls. (A2A has Task/states/pushNotificationConfig but no mailbox
// — research confirmed. Production durability later rides Trigger.dev waitpoints; this is the minimal core.)
//
// States align with A2A TaskState: submitted → awaiting_approval → approved → running → completed | failed | rejected.
//
//   node prototype/hub/hub.mjs [--port 8790]
//
// Execution: for LOCAL agents (config in prototype/agents/*.json) the hub runs the skill IN-PROCESS itself
// (no worker.mjs needed — see the executor section below). For REMOTE/cross-company agents it stays a pure
// broker: the durable inbox holds the handoff until the agent's own worker.mjs polls, runs, and posts back.
// Per-agent policy: "approval" (human gate) | "auto" (run automatically) | autoFrom allowlist.
//   --vendor <stub|codex|claude>  forces the vendor for local in-process execution (default: each agent's own).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { randomUUID } from 'node:crypto';
import { runVendorAsync } from '../runner.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = (() => { const i = process.argv.indexOf('--port'); return i > -1 ? Number(process.argv[i + 1]) : 8795; })();
const EXEC_VENDOR = (() => { const i = process.argv.indexOf('--vendor'); return i > -1 ? process.argv[i + 1] : null; })(); // force local-exec vendor (e.g. stub); null = each agent's own
const STATE_FILE = path.join(HERE, 'inbox.json');
const UI_FILE = path.join(HERE, 'ui.html');
const ONLINE_MS = 12000;                    // an agent is "online" if it polled within this window

const now = () => Date.now();
const WF_FILE = path.join(HERE, '..', 'mcp', 'workflows.json');   // shared workflow store (nodes/edges canonical + steps[] shim)
let state = load();
state.runs ||= {};                          // runId -> { nodes, edges, outputs, status } for in-flight DAG runs
function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { handoffs: [], agents: {} }; } }
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('[hub] save failed', e.message); } }

// ---------- helpers ----------
const agent = (id) => (state.agents[id] ||= { id, policy: 'approval', autoFrom: [], lastSeen: 0 });
const online = (a) => now() - (a.lastSeen || 0) < ONLINE_MS;
const isAuto = (a, from) => a.policy === 'auto' || (a.autoFrom || []).includes(from);
const find = (id) => { const h = state.handoffs.find((x) => x.id === id); if (!h) throw new Error(`no handoff "${id}"`); return h; };
const touch = (h, status, by) => { h.status = status; h.updatedAt = now(); (h.history ||= []).push({ ts: now(), status, by }); };
const publicAgents = () => Object.values(state.agents).map((a) => ({ id: a.id, policy: a.policy, autoFrom: a.autoFrom || [], online: online(a) || !!a.local, lastSeen: a.lastSeen || 0, skill: a.skill || null, company: a.company || null, accepts: a.accepts || ['*'], emits: a.emits || ['*'], local: !!a.local }));
const ref = (h) => ({ id: h.id, from: h.from, to: h.to, skill: h.skill, status: h.status, createdAt: h.createdAt, updatedAt: h.updatedAt });

// pre-register known agents (prototype/agents/*.json) so the canvas has nodes to drag between
(function preseed() {
  try {
    const dir = path.join(HERE, '..', 'agents');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (c.name && c.skill) { const a = agent(c.name); a.skill = c.skill.id; a.company = c.company || null; a.accepts = c.skill.accepts || ['*']; a.emits = c.skill.emits || ['*'];
        a.local = { skillId: c.skill.id, vendor: c.skill.vendor || 'stub', systemPrompt: c.skill.systemPrompt || '', stub: c.skill.stub || '' }; } } catch {}   // hub has the config → it can RUN this agent in-process (no worker.mjs)
    }
    save();
  } catch {}
})();

// ---------- core ops ----------
function create({ from, to, skill, input }) {
  if (!to || !skill) throw new Error('to + skill required');
  agent(to); if (from) agent(from);
  const h = { id: randomUUID().slice(0, 8), from: from || '?', to, skill, input: input || '', status: 'submitted',
    result: null, error: null, contextId: randomUUID(), createdAt: now(), updatedAt: now(), history: [] };
  touch(h, 'submitted', from || '?');
  state.handoffs.push(h); save();
  schedule(h);                              // local agent → hub runs it in-process; remote → waits in durable inbox
  return h;
}
// recipient comes online: heartbeat + advance its submitted handoffs by policy, return the ones to run now
function poll(agentId) {
  const a = agent(agentId); a.lastSeen = now();
  if (a.local) { save(); return []; }       // local agents are run by the hub itself — poll is heartbeat-only (no double-run)
  for (const h of state.handoffs)
    if (h.to === agentId && h.status === 'submitted') touch(h, isAuto(a, h.from) ? 'approved' : 'awaiting_approval', isAuto(a, h.from) ? 'auto' : 'policy');
  const runnable = state.handoffs.filter((h) => h.to === agentId && h.status === 'approved');
  for (const h of runnable) touch(h, 'running', 'worker');
  save();
  return runnable;                          // full handoffs (worker needs .input)
}
function postResult(id, { result, error }, by = 'worker') {
  const h = find(id); h.result = result ?? null; h.error = error ?? null;
  touch(h, error ? 'failed' : 'completed', by); save();
  if (h.runId) advanceRun(h);               // this node is part of a DAG run → fire ready downstream nodes
  return h;
}
function approve(id) { const h = find(id); if (h.status !== 'awaiting_approval') throw new Error(`handoff ${id} is ${h.status}, not awaiting_approval`); touch(h, 'approved', 'human'); save(); schedule(h); return h; }
function decline(id) { const h = find(id); touch(h, 'rejected', 'human'); save(); return h; }
function setPolicy(id, { policy, autoFrom }) { const a = agent(id); if (policy) a.policy = policy === 'auto' ? 'auto' : 'approval'; if (Array.isArray(autoFrom)) a.autoFrom = autoFrom; save(); return { id: a.id, policy: a.policy, autoFrom: a.autoFrom, online: online(a) }; }

// ---------- in-process executor (LOCAL agents only: the hub runs the skill itself, no worker.mjs) ----------
// This deliberately revises the "broker never runs skills" stance for LOCAL agents (config present in
// prototype/agents/*.json): they have no separate runtime, so the hub embeds one. REMOTE/cross-company
// agents are still broker-only — their runtime is theirs (A2A); the durable inbox holds until they poll.
const running = new Set();                   // handoff ids executing in-process right now (de-dupe guard)
function schedule(h) {
  const a = agent(h.to);
  if (!a.local) return;                      // remote → durable inbox; their worker/server runs it
  if (h.status === 'submitted') { touch(h, isAuto(a, h.from) ? 'approved' : 'awaiting_approval', isAuto(a, h.from) ? 'auto' : 'policy'); save(); }
  if (h.status === 'approved') runLocal(h);
}
function runLocal(h) {
  if (running.has(h.id)) return; running.add(h.id);
  const lc = agent(h.to).local; const vendor = EXEC_VENDOR || lc.vendor || 'stub';
  if (h.skill !== lc.skillId) { running.delete(h.id); return void postResult(h.id, { error: `agent ${h.to} does not serve skill "${h.skill}"` }); }
  touch(h, 'running', 'hub'); save();
  console.log(`▶ [hub] running ${h.id} (${h.skill}) for ${h.to} — ${vendor}`);
  runVendorAsync(vendor, `${lc.systemPrompt}\n\n--- INPUT ---\n${h.input}\n--- END INPUT ---`, lc.stub)
    .then((result) => postResult(h.id, { result }, 'hub'))
    .catch((e) => postResult(h.id, { error: e.message }, 'hub'))
    .finally(() => { running.delete(h.id); console.log(`✓ [hub] ${h.id} done`); });
}
// crash recovery: on boot, resume local handoffs left mid-flight (running) or unprocessed (submitted/approved)
(function sweep() {
  for (const h of state.handoffs) {
    const a = state.agents[h.to]; if (!a || !a.local) continue;
    if (h.status === 'submitted' || h.status === 'approved') schedule(h);
    else if (h.status === 'running') runLocal(h);          // exec was lost on restart → re-run (advanceRun resumes its DAG)
  }
})();

// ---------- flow engine (Wave B2): save a wired DAG, run it topologically via the executor above ----------
// Save shape = nodes/edges CANONICAL (Langflow-style); steps[] is a derived linear shim so the existing
// MCP run_workflow / run_automation (a2aSend) stay compatible. Execution is REACTIVE: each node is a handoff
// (run by B1 for local agents), and when it completes, downstream nodes whose inputs are all ready fire next
// — so per-agent approval pauses the run cleanly until approved, and the cockpit animates it via handoff edges.
const readWorkflows = () => { try { return JSON.parse(fs.readFileSync(WF_FILE, 'utf8')); } catch { return []; } };
const nodeById = (run, id) => run.nodes.find((n) => n.id === id);
function toposort(nodes, edges) {                          // Kahn's; returns best-effort order (cycle → partial)
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) if (indeg.has(e.target)) indeg.set(e.target, indeg.get(e.target) + 1);
  const q = nodes.filter((n) => indeg.get(n.id) === 0), order = [];
  while (q.length) { const n = q.shift(); order.push(n);
    for (const e of edges.filter((e) => e.source === n.id)) { const d = indeg.get(e.target) - 1; indeg.set(e.target, d);
      if (d === 0) { const t = nodes.find((x) => x.id === e.target); if (t) q.push(t); } } }
  return order;
}
function saveWorkflow({ id, name, summary, tags, nodes, edges }) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes[] + edges[] required');
  id = id || (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'flow-' + randomUUID().slice(0, 4);
  const steps = toposort(nodes, edges).filter((n) => n.agent && n.skill).map((n) => ({ agent: n.agent, skill: n.skill })); // derived shim
  const wf = { id, name: name || id, summary: summary || '', tags: tags || [], nodes, edges, steps };
  const arr = readWorkflows(); const i = arr.findIndex((w) => w.id === id);
  if (i >= 0) arr[i] = wf; else arr.push(wf);
  fs.writeFileSync(WF_FILE, JSON.stringify(arr, null, 2));
  return wf;
}
function runFlow({ id, nodes, edges, input }) {
  if (id && (!nodes || !edges)) { const w = readWorkflows().find((w) => w.id === id); if (!w) throw new Error(`no workflow "${id}"`); nodes = w.nodes; edges = w.edges; }
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes[] + edges[] (or a saved id) required');
  const trg = new Set(nodes.filter((n) => n.kind === 'trigger').map((n) => n.id));   // triggers are entry markers, not executable
  if (trg.size) { nodes = nodes.filter((n) => !trg.has(n.id)); edges = edges.filter((e) => !trg.has(e.source) && !trg.has(e.target)); }
  const runId = randomUUID().slice(0, 8);
  const run = (state.runs[runId] = { id: runId, flowId: id || null, nodes, edges, input: input || '', outputs: {}, status: 'running', createdAt: now() });
  const entries = nodes.filter((n) => n.kind !== 'trigger' && !edges.some((e) => e.target === n.id));
  if (!entries.length) throw new Error('flow has no entry node (every node has an incoming edge — cycle?)');
  save();
  for (const n of entries) fireNode(run, n, input || '');
  return { runId: run.id, status: run.status, entries: entries.map((n) => n.id) };
}
function fireNode(run, node, input) {
  if (node.kind === 'mcp') { run.outputs[node.id] = `[mcp "${node.tool || '?'}" — executed in Wave G]`; save(); return advanceFrom(run, node.id); } // placeholder until Wave G
  const inc = run.edges.filter((e) => e.target === node.id);
  const from = inc[0] ? (nodeById(run, inc[0].source)?.agent || inc[0].source) : (run.flowId || 'flow');
  const h = create({ from, to: node.agent, skill: node.skill, input });
  h.runId = run.id; h.node = node.id; save();
}
function advanceRun(h) {
  const run = state.runs[h.runId]; if (!run) return;
  if (!(h.node in run.outputs)) run.outputs[h.node] = h.error ? `[error] ${h.error}` : (h.result || '');
  advanceFrom(run, h.node);
}
function advanceFrom(run, nodeId) {
  for (const e of run.edges.filter((e) => e.source === nodeId)) {
    const tgt = nodeById(run, e.target); if (!tgt || tgt.id in run.outputs) continue;
    const incoming = run.edges.filter((x) => x.target === tgt.id);
    if (incoming.every((x) => x.source in run.outputs) && !state.handoffs.some((x) => x.runId === run.id && x.node === tgt.id)) {
      fireNode(run, tgt, incoming.map((x) => run.outputs[x.source]).filter(Boolean).join('\n\n'));
    }
  }
  if (run.nodes.filter((n) => n.kind !== 'trigger').every((n) => n.id in run.outputs)) { run.status = 'completed'; console.log(`✓ [hub] flow run ${run.id} completed`); }
  save();
}

// ---------- automations (Wave C): trigger node + wired workflow; fire on manual / build_state event ----------
// An automation = { trigger:{type:'manual'|'schedule'|'build_state', when?, match?}, workflow:<id>, input }.
// "save as automation" splits the canvas: the trigger node's config + the agent chain saved as a workflow it refs.
const AUTO_FILE = path.join(HERE, '..', 'mcp', 'automations.json');
const readAutomations = () => { try { return JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8')); } catch { return []; } };
const deepMatch = (pat, val) => {                          // same semantics as mcp/server.mjs (shared trigger matching)
  if (pat === null || typeof pat !== 'object') return pat === val;
  if (Array.isArray(pat)) return Array.isArray(val) && pat.every((p, i) => deepMatch(p, val[i]));
  return val !== null && typeof val === 'object' && Object.entries(pat).every(([k, v]) => deepMatch(v, val[k]));
};
const triggerMatches = (trig, event) => !!trig && trig.type === 'build_state' && !!trig.match && deepMatch(trig.match, event);
function saveAutomation({ id, name, summary, tags, trigger, nodes, edges, workflow, input, enabled }) {
  if (!trigger || !trigger.type) throw new Error('trigger {type} required');
  let workflowId = workflow;
  if (Array.isArray(nodes) && Array.isArray(edges)) {      // save the wired agent chain (triggers stripped) as a workflow, ref it
    const trg = new Set(nodes.filter((n) => n.kind === 'trigger').map((n) => n.id));
    const wf = saveWorkflow({ name: (name || 'automation') + ' flow', nodes: nodes.filter((n) => !trg.has(n.id)), edges: edges.filter((e) => !trg.has(e.source) && !trg.has(e.target)) });
    workflowId = wf.id;
  }
  if (!workflowId) throw new Error('workflow id (or nodes/edges) required');
  id = id || (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'auto-' + randomUUID().slice(0, 4);
  const m = { id, name: name || id, summary: summary || '', tags: tags || [], trigger, workflow: workflowId, input: input || '', enabled: enabled !== false };
  const arr = readAutomations(); const i = arr.findIndex((a) => a.id === id);
  if (i >= 0) arr[i] = m; else arr.push(m);
  fs.writeFileSync(AUTO_FILE, JSON.stringify(arr, null, 2));
  return m;
}
function fireEvent(event, input) {                          // build-state event → run every enabled automation whose trigger matches
  const matched = readAutomations().filter((m) => m.enabled !== false && triggerMatches(m.trigger, event));
  const fired = [];
  for (const m of matched) {
    try { fired.push({ automation: m.id, ...runFlow({ id: m.workflow, input: input ?? m.input ?? '' }) }); }
    catch (e) { fired.push({ automation: m.id, error: e.message }); }
  }
  return { event, matched: matched.map((m) => m.id), fired };
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (req.method === 'GET' && p === '/') {
    try { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(UI_FILE)); }
    catch { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>BuildHUD hub</h1><p>UI not installed yet (prototype/hub/ui.html). JSON API under /api/*.</p>'); }
  }
  if (req.method === 'GET' && p === '/api/state')
    return json(res, 200, { agents: publicAgents(), handoffs: state.handoffs.map((h) => ({ ...ref(h), input: h.input, result: h.result, error: h.error, history: h.history, runId: h.runId || null })), runs: Object.values(state.runs).map((r) => ({ id: r.id, flowId: r.flowId, status: r.status, done: Object.keys(r.outputs).length, total: r.nodes.length })) });
  if (req.method === 'GET' && p === '/api/workflows')
    return json(res, 200, readWorkflows().map((w) => ({ id: w.id, name: w.name, nodes: (w.nodes || []).length, edges: (w.edges || []).length, steps: (w.steps || []).length })));
  if (req.method === 'GET' && p === '/api/automations')
    return json(res, 200, readAutomations().map((m) => ({ id: m.id, name: m.name, trigger: m.trigger, workflow: m.workflow, enabled: m.enabled !== false })));
  if (req.method !== 'POST') { if (p.startsWith('/api/')) return json(res, 405, { error: 'use POST' }); res.writeHead(404); return res.end(); }

  let body = ''; req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'bad json' }); }
    try {
      if (p === '/api/handoffs') return json(res, 200, ref(create(j)));
      if (p === '/api/poll') return json(res, 200, { runnable: poll(j.agent) });
      if (p === '/api/workflows') return json(res, 200, saveWorkflow(j));     // save wired DAG (nodes/edges + derived steps[])
      if (p === '/api/runflow') return json(res, 200, runFlow(j));            // topo-run a DAG (draft nodes/edges, or saved id)
      if (p === '/api/automations') return json(res, 200, saveAutomation(j)); // save trigger + wired workflow as an automation
      if (p === '/api/fire') return json(res, 200, fireEvent(j.event || {}, j.input)); // build-state event → fire matching automations
      let m;
      if ((m = p.match(/^\/api\/handoffs\/([^/]+)\/(approve|decline|result)$/)))
        return json(res, 200, m[2] === 'approve' ? ref(approve(m[1])) : m[2] === 'decline' ? ref(decline(m[1])) : ref(postResult(m[1], j)));
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/policy$/))) return json(res, 200, setPolicy(m[1], j));
      return json(res, 404, { error: `unknown route ${p}` });
    } catch (e) { return json(res, 400, { error: e.message }); }
  });
});
server.on('error', (e) => { console.error(`[hub] cannot listen on ${PORT}: ${e.message} — pass --port <free>`); process.exit(1); });
server.listen(PORT, () => console.log(`[hub] BuildHUD durable handoff hub on http://localhost:${PORT}  (state: ${path.relative(process.cwd(), STATE_FILE)})`));
