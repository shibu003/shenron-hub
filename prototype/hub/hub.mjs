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
import { callMcpTool } from '../mcp/mcp-client.mjs';
import { redact, auditAppend, auditVerify, reputationFrom, DEFAULT_PASSPORT, normalizePassport, sendMode, CAP_VOCAB } from '../trust.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');           // spawn MCP servers from here so integrations.json can use repo-relative commands
const PORT = (() => { const i = process.argv.indexOf('--port'); return i > -1 ? Number(process.argv[i + 1]) : 8795; })();
const EXEC_VENDOR = (() => { const i = process.argv.indexOf('--vendor'); return i > -1 ? process.argv[i + 1] : null; })(); // force local-exec vendor (e.g. stub); null = each agent's own
let AUTORUN = !process.argv.includes('--no-autorun');     // global master: may the hub run LOCAL agents in-process (autorun)?
const autorunOn = (a) => AUTORUN && a.autorun !== false;  // per-agent autorun (default on) AND-ed with the global master; off → broker-only (waits for a worker)
const STATE_FILE = path.join(HERE, 'inbox.json');
const UI_FILE = path.join(HERE, 'ui.html');
const ONLINE_MS = 12000;                    // an agent is "online" if it polled within this window

const now = () => Date.now();
const WF_FILE = path.join(HERE, '..', 'mcp', 'workflows.json');   // shared workflow store (nodes/edges canonical + steps[] shim)
let state = load();
state.runs ||= {};                          // runId -> { nodes, edges, outputs, status } for in-flight DAG runs
state.audit ||= [];                         // Wave H: hash-chained, tamper-evident trust trail
const trail = (type, detail) => { const e = auditAppend(state.audit, { type, ts: now(), ...detail }); save(); return e; };
function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { handoffs: [], agents: {} }; } }
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('[hub] save failed', e.message); } }

// ---------- helpers ----------
const agent = (id) => { const a = (state.agents[id] ||= { id, policy: 'approval', autoFrom: [], lastSeen: 0 }); a.passport = normalizePassport(a.passport); return a; };   // Wave H/B: every agent carries a (structured, migrated) capability passport
const online = (a) => now() - (a.lastSeen || 0) < ONLINE_MS;
const isAuto = (a, from) => a.policy === 'auto' || (a.autoFrom || []).includes(from);
const find = (id) => { const h = state.handoffs.find((x) => x.id === id); if (!h) throw new Error(`no handoff "${id}"`); return h; };
const touch = (h, status, by) => { h.status = status; h.updatedAt = now(); (h.history ||= []).push({ ts: now(), status, by }); };
const publicAgents = () => Object.values(state.agents).map((a) => ({ id: a.id, policy: a.policy, autoFrom: a.autoFrom || [], online: online(a) || (!!a.local && autorunOn(a)), lastSeen: a.lastSeen || 0, skill: a.skill || null, company: a.company || null, accepts: a.accepts || ['*'], emits: a.emits || ['*'], local: !!a.local, autorun: a.autorun !== false, passport: normalizePassport(a.passport) }));
const ref = (h) => ({ id: h.id, from: h.from, to: h.to, skill: h.skill, status: h.status, createdAt: h.createdAt, updatedAt: h.updatedAt });
const runCancelled = (h) => !!(h && h.runId && state.runs[h.runId] && state.runs[h.runId].status === 'cancelled');   // ⏹ a stopped run must not advance / resume

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
for (const a of Object.values(state.agents)) a.passport = normalizePassport(a.passport);   // Wave B: migrate legacy array passports on boot
save();

// ---------- core ops ----------
function create({ from, to, skill, input }) {
  if (!to || !skill) throw new Error('to + skill required');
  const a = agent(to);                       // only the recipient must exist; `from` is just a label
  // (do NOT auto-register `from` — flow-run entry handoffs carry the flow id / "cockpit" / "mcp" as
  //  from, and registering those would spawn phantom agents that clutter the canvas)
  const fw = redact(input || '', a.passport?.share || {});   // Wave H data firewall: secrets/PII never reach the recipient
  const h = { id: randomUUID().slice(0, 8), from: from || '?', to, skill, input: fw.text, status: 'submitted',
    result: null, error: null, contextId: randomUUID(), createdAt: now(), updatedAt: now(), history: [], redacted: fw.removed.length ? fw.removed : undefined };
  touch(h, 'submitted', from || '?');
  state.handoffs.push(h);
  if (fw.removed.length) trail('redact', { handoff: h.id, from: from || '?', to, removed: fw.removed });   // record WHAT was stripped (never the values)
  save();
  schedule(h);                              // local agent → hub runs it in-process; remote → waits in durable inbox
  return h;
}
// recipient comes online: heartbeat + advance its submitted handoffs by policy, return the ones to run now
function poll(agentId) {
  const a = agent(agentId); a.lastSeen = now();
  if (a.local && autorunOn(a)) { save(); return []; }   // hub runs it in-process → poll is heartbeat-only. autorun off → fall through, let a worker claim it
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
function approve(id) { const h = find(id); if (h.status !== 'awaiting_approval') throw new Error(`handoff ${id} is ${h.status}, not awaiting_approval`); touch(h, 'approved', 'human'); trail('approve', { handoff: id, to: h.to, skill: h.skill }); save(); if (h.mcp) runMcp(h); else schedule(h); return h; }
function decline(id) { const h = find(id); touch(h, 'rejected', 'human'); save(); return h; }
function setPolicy(id, { policy, autoFrom }) { const a = agent(id); if (policy) a.policy = policy === 'auto' ? 'auto' : 'approval'; if (Array.isArray(autoFrom)) a.autoFrom = autoFrom; save(); return { id: a.id, policy: a.policy, autoFrom: a.autoFrom, online: online(a) }; }
function resumePending() { for (const h of state.handoffs) { const a = state.agents[h.to]; if (a && a.local && autorunOn(a) && (h.status === 'submitted' || h.status === 'approved')) schedule(h); } } // turning autorun back on → run what was waiting
function setAutorun(id, on) { const a = agent(id); a.autorun = on !== false; save(); resumePending(); return { id: a.id, autorun: a.autorun }; }
function setGlobalAutorun(on) { AUTORUN = on !== false; save(); resumePending(); return { autorun: AUTORUN }; }

// ---------- in-process executor (LOCAL agents only: the hub runs the skill itself, no worker.mjs) ----------
// This deliberately revises the "broker never runs skills" stance for LOCAL agents (config present in
// prototype/agents/*.json): they have no separate runtime, so the hub embeds one. REMOTE/cross-company
// agents are still broker-only — their runtime is theirs (A2A); the durable inbox holds until they poll.
const running = new Set();                   // handoff ids executing in-process right now (de-dupe guard)
function schedule(h) {
  const a = agent(h.to);
  if (!a.local || !autorunOn(a)) return;     // remote, OR autorun off → durable inbox; a worker runs it (broker-only)
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
setImmediate(sweep);                                       // defer to after module init (sweep → runMcp → readIntegrations const)
function sweep() {
  for (const h of state.handoffs) {
    if (runCancelled(h)) continue;                          // ⏹ never resume a handoff whose run was stopped
    if (h.mcp) {                                            // external side-effect node (Wave G)
      if (h.status === 'approved') runMcp(h);               // approved but never sent → safe to run
      else if (h.status === 'running')                      // sent-or-sending when we died → do NOT auto-resend (not idempotent)
        postResult(h.id, { error: 'interrupted on restart — external side-effect not auto-resent; re-run the flow' }, 'hub');
      continue;                                             // awaiting_approval → leave for the human
    }
    if (h.prompt) { if (h.status === 'running' || h.status === 'approved') runPrompt(h); continue; }   // Wave K prompt = internal compute → safe to re-run
    if (h.consensus) { if (h.status === 'running' || h.status === 'approved') runConsensus(h); continue; }   // Wave I consensus = internal compute → safe to re-run
    const a = state.agents[h.to]; if (!a || !a.local || !autorunOn(a)) continue;
    if (h.status === 'submitted' || h.status === 'approved') schedule(h);
    else if (h.status === 'running') runLocal(h);          // exec was lost on restart → re-run (advanceRun resumes its DAG)
  }
}

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
function runFlow({ id, nodes, edges, input, parent }) {
  if (id && (!nodes || !edges)) { const w = readWorkflows().find((w) => w.id === id); if (!w) throw new Error(`no workflow "${id}"`); nodes = w.nodes; edges = w.edges; }
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes[] + edges[] (or a saved id) required');
  const depth = parent ? ((state.runs[parent.runId]?.depth || 0) + 1) : 0;   // 📦 sub-flow nesting — bound it so a self-referential flow can't loop forever
  if (depth > 8) throw new Error('sub-flow nesting too deep (>8)');
  const trg = new Set(nodes.filter((n) => n.kind === 'trigger').map((n) => n.id));   // triggers are entry markers, not executable
  if (trg.size) { nodes = nodes.filter((n) => !trg.has(n.id)); edges = edges.filter((e) => !trg.has(e.source) && !trg.has(e.target)); }
  edges.forEach((e, i) => { if (!e.id) e.id = 'e' + i; });   // Wave E2: dead-branch tracking keys on edge id
  const runId = randomUUID().slice(0, 8);
  const run = (state.runs[runId] = { id: runId, flowId: id || null, parent: parent || null, depth, nodes, edges, input: input || '', outputs: {}, dead: [], skipped: [], routerPick: {}, status: 'running', createdAt: now() });
  const entries = nodes.filter((n) => n.kind !== 'trigger' && !edges.some((e) => e.target === n.id));
  if (!entries.length) throw new Error('flow has no entry node (every node has an incoming edge — cycle?)');
  save();
  for (const n of entries) fireNode(run, n, input || '');
  return { runId: run.id, status: run.status, entries: entries.map((n) => n.id) };
}
// 📦 sub-flow node — run the referenced workflow as a NESTED run (Option A): the node stays one box, the nested
// flow runs with its OWN approvals / data-firewall / audit, and when it completes its terminal output flows to
// this node's output → the parent advances. Errors (missing ref, too deep) surface as the node's [error] output.
function fireWorkflowNode(run, node, input, from) {
  const wf = node.ref ? readWorkflows().find((w) => w.id === node.ref) : null;
  if (!wf) { run.outputs[node.id] = `[error] no workflow "${node.ref || '?'}"`; save(); return advanceFrom(run, node.id); }
  try { runFlow({ id: wf.id, input, parent: { runId: run.id, node: node.id } }); }   // nested run; its completion propagates back via advanceFrom
  catch (e) { run.outputs[node.id] = `[error] ${e.message}`; save(); advanceFrom(run, node.id); }
}
// the value a (sub-)flow hands upward: prefer a Chat Output, else a sink (no outgoing edge), else the last output.
function flowResult(run) {
  const out = run.nodes.find((n) => n.kind === 'output' && (n.id in run.outputs));
  if (out) return run.outputs[out.id];
  const sink = run.nodes.find((n) => n.kind !== 'trigger' && (n.id in run.outputs) && !run.edges.some((e) => e.source === n.id));
  if (sink) return run.outputs[sink.id];
  const ks = Object.keys(run.outputs); return ks.length ? run.outputs[ks[ks.length - 1]] : '';
}
function fireNode(run, node, input) {
  const inc = run.edges.filter((e) => e.target === node.id);
  const from = inc[0] ? (nodeById(run, inc[0].source)?.agent || inc[0].source) : (run.flowId || 'flow');
  if (node.kind === 'input')  { run.outputs[node.id] = (node.config && node.config.text) || input || ''; save(); return advanceFrom(run, node.id); }  // Wave K Chat Input: emit baked text or the run input
  if (node.kind === 'output') { run.outputs[node.id] = input || ''; save(); return advanceFrom(run, node.id); }                                       // Wave K Chat Output: terminal display
  if (node.kind === 'prompt') return firePromptNode(run, node, input, from);   // Wave K: inline LLM template (in-process vendor, no approval)
  if (node.kind === 'consensus') return fireConsensusNode(run, node, input, from);   // Wave I: fan to N vendors → agree
  if (node.kind === 'router') return fireRouterNode(run, node, input, from);   // Wave E2: trust-router — fire only the chosen branch
  if (node.kind === 'mcp') return fireMcpNode(run, node, input, from);   // Wave G: real external side-effect (approval-gated)
  if (node.kind === 'workflow') return fireWorkflowNode(run, node, input, from);   // 📦 sub-flow: run the referenced flow as a nested run
  const h = create({ from, to: node.agent, skill: node.skill, input });
  h.runId = run.id; h.node = node.id; save();
}
// Wave K — a prompt component is INTERNAL compute (an inline LLM template), not an external side-effect:
// it runs in-process via the vendor with NO approval fence (mirrors an auto agent). Reuses the run-handoff
// for cockpit visibility + crash-resume. `{input}` in the template is substituted with the upstream text.
function firePromptNode(run, node, input, from) {
  const h = { id: randomUUID().slice(0, 8), from: from || run.flowId || 'flow', to: 'prompt', skill: 'prompt',
    input: input || '', status: 'submitted', result: null, error: null, contextId: randomUUID(), createdAt: now(), updatedAt: now(),
    history: [], prompt: { template: (node.config && node.config.template) || '{input}' }, runId: run.id, node: node.id };
  touch(h, 'approved', 'auto'); state.handoffs.push(h); save();
  runPrompt(h);
}
function runPrompt(h) {
  if (running.has(h.id)) return; running.add(h.id);
  const vendor = EXEC_VENDOR || 'stub';
  const tmpl = String(h.prompt.template || '{input}').split('{input}').join(h.input || '');
  touch(h, 'running', 'hub'); save();
  console.log(`▶ [hub] prompt ${h.id}`);
  runVendorAsync(vendor, tmpl, `[prompt:stub] ${tmpl.slice(0, 120)}`)
    .then((result) => postResult(h.id, { result }, 'hub'))
    .catch((e) => postResult(h.id, { error: e.message }, 'hub'))
    .finally(() => { running.delete(h.id); console.log(`✓ [hub] prompt ${h.id} done`); });
}
// Wave I — consensus: fan the SAME task to N vendors in parallel, then pick the medoid (output most similar
// to the others) and report an agreement score. A single vendor can't do this — it's the structural answer to
// "why BuildHUD and not Claude-native?". Internal compute → no approval fence; handoff-backed for visibility.
const tokens = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
function jaccard(a, b) { const A = tokens(a), B = tokens(b); if (!A.size && !B.size) return 1; let i = 0; for (const x of A) if (B.has(x)) i++; return i / ((A.size + B.size - i) || 1); }
function consensusOf(results) {
  const n = results.length; if (!n) return { text: '', agreement: 1, picked: null };
  if (n === 1) return { text: results[0].text, agreement: 1, picked: results[0].vendor };
  let best = -1, bi = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) if (i !== j) s += jaccard(results[i].text, results[j].text); if (s > best) { best = s; bi = i; } }
  let sum = 0, p = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { sum += jaccard(results[i].text, results[j].text); p++; }
  return { text: results[bi].text, agreement: p ? Math.round(sum / p * 100) / 100 : 1, picked: results[bi].vendor };
}
function fireConsensusNode(run, node, input, from) {
  const vendors = String((node.config && node.config.vendors) || 'claude,codex,gemini').split(',').map((s) => s.trim()).filter(Boolean);
  const task = `${(node.config && node.config.prompt) || ''}\n${input || ''}`.trim();
  const h = { id: randomUUID().slice(0, 8), from: from || run.flowId || 'flow', to: 'consensus', skill: 'consensus', input: task,
    status: 'submitted', result: null, error: null, contextId: randomUUID(), createdAt: now(), updatedAt: now(), history: [], consensus: { vendors }, runId: run.id, node: node.id };
  touch(h, 'approved', 'auto'); state.handoffs.push(h); save(); runConsensus(h);
}
async function runConsensus(h) {
  if (running.has(h.id)) return; running.add(h.id);
  const vendors = (h.consensus && h.consensus.vendors) || ['stub']; const task = h.input || '';
  touch(h, 'running', 'hub'); save();
  console.log(`▶ [hub] consensus ${h.id} → ${vendors.join('+')}`);
  try {
    const results = await Promise.all(vendors.map((v) => runVendorAsync(EXEC_VENDOR || v, task, `[${v}] ${task.slice(0, 60)}`).then((text) => ({ vendor: v, text }))));
    const c = consensusOf(results);
    h.consensus = { vendors, picked: c.picked, agreement: c.agreement, results: results.map((r) => ({ vendor: r.vendor, chars: r.text.length })) }; save();
    postResult(h.id, { result: `[consensus ${c.picked} · agree ${c.agreement}]\n${c.text}` }, 'hub');
  } catch (e) { postResult(h.id, { error: e.message }, 'hub'); }
  finally { running.delete(h.id); console.log(`✓ [hub] consensus ${h.id} done`); }
}
// Wave E2 — trust-router: conditional control flow that fires ONLY the chosen branch (true DAG capability =
// Langflow If-Else parity), but with TRUST-NATIVE predicates the incumbent can't express: route on whether the
// firewall flagged the data upstream (the redaction marker survives in the text). Internal compute, no handoff —
// the routing decision lands in the tamper-evident audit so you can prove WHY the flow branched.
const routerEval = (cfg, input) => { const s = String(input || ''); switch (cfg.predicate) {
  case 'redacted': return s.includes('[redacted:');      // the data firewall stripped something on the way here
  case 'clean':    return !s.includes('[redacted:');     // nothing was stripped
  case 'contains': return !!cfg.value && s.includes(cfg.value);
  default:         return true; } };                      // 'always'
function fireRouterNode(run, node, input, from) {
  const cfg = node.config || {}, result = routerEval(cfg, input);
  run.outputs[node.id] = input;                           // pass-through (the router transforms nothing)
  (run.routerPick ||= {})[node.id] = result ? 'then' : 'else';
  trail('route', { runId: run.id, node: node.id, predicate: cfg.predicate || 'always', result, branch: result ? 'then' : 'else' });
  save(); advanceFrom(run, node.id);
}
// Wave G — an mcp node is an external SIDE-EFFECT (Gmail/Slack…). Reuse the durable-inbox handoff so it
// shows in the cockpit, has history, and rides the SAME approval fence as agents: blast-radius gate →
// human approval by DEFAULT; node.auto opts in (still killed by the global autorun master).
function fireMcpNode(run, node, input, from) {
  const integ = readIntegrations().find((x) => x.id === node.server);
  const h = { id: randomUUID().slice(0, 8), from: from || run.flowId || 'flow', to: node.server || 'mcp', skill: node.tool || '?',
    input: input || '', status: 'submitted', result: null, error: null, contextId: randomUUID(), createdAt: now(), updatedAt: now(),
    history: [], mcp: { server: node.server, tool: node.tool, config: node.config || {} }, runId: run.id, node: node.id };
  touch(h, 'submitted', h.from); state.handoffs.push(h);
  if (!integ) return void postResult(h.id, { error: `no integration "${node.server}" (connect it in ⚙ Settings)` }, 'hub');
  if (integ.enabled === false) return void postResult(h.id, { error: `integration "${node.server}" is disabled` }, 'hub');
  const up = state.agents[from];                                  // Wave B: enforce the upstream agent's external_send capability
  const mode = up ? sendMode(up.passport) : 'approval';          // unknown/non-agent upstream → still behind the approval fence
  if (mode === 'deny') { trail('deny', { handoff: h.id, from, to: `${node.server}.${node.tool}`, why: 'external_send=deny' }); return void postResult(h.id, { error: `agent "${from}" external_send is denied` }, 'hub'); }
  const auto = node.auto === true && AUTORUN && mode === 'allow'; // approval mode forces the human fence even if node.auto opts in
  touch(h, auto ? 'approved' : 'awaiting_approval', auto ? 'auto' : 'policy'); save();
  if (auto) runMcp(h);
}
async function runMcp(h) {
  if (running.has(h.id)) return; running.add(h.id);
  const { server, tool, config } = h.mcp;
  touch(h, 'running', 'hub'); save();
  console.log(`▶ [hub] MCP ${h.id} → ${server}.${tool}`);
  try {
    const integ = readIntegrations().find((x) => x.id === server);
    if (!integ) throw new Error(`no integration "${server}"`);
    if (integ.enabled === false) throw new Error(`integration "${server}" is disabled`);
    const upstream = state.agents[h.from];                    // Wave H/B capability: a known upstream must not be external_send=deny (defense in depth)
    if (upstream && sendMode(upstream.passport) === 'deny') { trail('deny', { handoff: h.id, from: h.from, to: `${server}.${tool}`, why: 'external_send=deny' }); throw new Error(`agent "${h.from}" external_send is denied`); }
    const fw = redact(h.input, upstream?.passport?.share || {});   // data firewall at egress: scrub before it leaves to the external tool
    if (fw.removed.length) trail('redact', { handoff: h.id, to: `${server}.${tool}`, egress: true, removed: fw.removed });
    const out = await callMcpTool(integ, tool, { ...(config || {}), input: fw.text }, { cwd: REPO_ROOT });
    trail('send', { handoff: h.id, server, tool, redacted: fw.removed.length });
    postResult(h.id, { result: out }, 'hub');
  } catch (e) { postResult(h.id, { error: e.message }, 'hub'); }
  finally { running.delete(h.id); console.log(`✓ [hub] MCP ${h.id} done`); }
}
function setPassport(id, { caps, share }) {                   // Wave H/B: edit an agent's structured capability passport
  const a = agent(id);
  a.passport = normalizePassport({ caps: caps || a.passport.caps, share: share || a.passport.share });   // normalize clamps to CAP_VOCAB
  save(); trail('passport', { agent: id, caps: a.passport.caps, never: a.passport.share.never.length });
  return { id, passport: a.passport };
}
// Wave E1 — trust-as-you-build: dry-run the SAME firewall + capability enforcement over a draft flow WITHOUT
// executing any agent, so the cockpit can show "what would the trust boundary do" before Run. The thing Langflow
// structurally can't show (it has no trust model). Read-only — never mutates state, never sends. Concrete
// strip counts are shown only where the upstream text is known (input nodes / flow input); agent outputs are
// runtime, so their outgoing edges report the wire POLICY (fenced categories) instead of counts — honest, no overclaim.
function trustPreview({ nodes, edges, input }) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes[] + edges[] required');
  const trg = new Set(nodes.filter((n) => n.kind === 'trigger').map((n) => n.id));
  const N = nodes.filter((n) => !trg.has(n.id)), E = edges.filter((e) => !trg.has(e.source) && !trg.has(e.target));
  const byId = new Map(N.map((n) => [n.id, n]));
  const companyOfNode = (n) => { const a = n && n.agent && state.agents[n.agent]; return a ? (a.company || null) : null; };
  const known = new Map();                                   // node id -> text the firewall can evaluate concretely (input nodes + flow input)
  for (const n of N) if (n.kind === 'input') known.set(n.id, (n.config && n.config.text) || input || '');
  const wires = E.map((e) => {
    const s = byId.get(e.source), t = byId.get(e.target);
    const sc = companyOfNode(s), tc = companyOfNode(t), cross = !!sc && !!tc && sc !== tc;
    const never = (e.share && Array.isArray(e.share.never)) ? e.share.never : [];
    const fences = ['secrets/PII'].concat(never.length ? [`never:${never.join(',')}`] : []).concat(cross ? ['cross-company'] : []);
    const up = known.has(e.source) ? known.get(e.source) : undefined;   // concrete only when upstream emits known text
    const removed = up !== undefined ? redact(up, { never }).removed : null;
    return { id: e.id || `${e.source}→${e.target}`, source: e.source, target: e.target, crossCompany: cross, fences, previewRemoved: removed, knownUpstream: up !== undefined };
  });
  const gates = [];
  for (const n of N) {
    if (n.kind === 'agent') { const a = state.agents[n.agent]; if (a) gates.push({ node: n.id, kind: 'agent', caps: normalizePassport(a.passport).caps }); }
    if (n.kind === 'mcp') {
      const inc = E.filter((e) => e.target === n.id);
      const from = inc[0] ? (byId.get(inc[0].source)?.agent || inc[0].source) : null;
      const up = from && state.agents[from];
      const mode = up ? sendMode(up.passport) : 'approval';
      gates.push({ node: n.id, kind: 'mcp', server: n.server, tool: n.tool, externalSend: mode, gate: mode === 'deny' ? 'denied' : mode === 'allow' ? (n.auto ? 'auto' : 'approval') : 'approval' });
    }
  }
  const stripCount = wires.reduce((a, w) => a + (w.previewRemoved ? w.previewRemoved.reduce((x, r) => x + r.count, 0) : 0), 0);
  return { wires, gates, summary: { wiresFenced: wires.filter((w) => w.fences.length).length, stripCount, gatedSends: gates.filter((g) => g.kind === 'mcp' && g.gate !== 'auto').length, deniedSends: gates.filter((g) => g.gate === 'denied').length } };
}
function advanceRun(h) {
  const run = state.runs[h.runId]; if (!run) return;
  if (!(h.node in run.outputs)) run.outputs[h.node] = h.error ? `[error] ${h.error}` : (h.result || '');
  advanceFrom(run, h.node);                                 // no-ops if the run was cancelled (guard inside)
}
// ⏹ Stop a run. In-process agents already executing can't be aborted mid-flight (we don't own the vendor promise),
// so the realistic stop = mark the run cancelled (advanceFrom then fires nothing more, it never reaches completed)
// + reject this run's handoffs that haven't started or are paused at approval (so approve can't resume them).
// A handoff still 'running' finishes, but its postResult→advanceRun is a no-op on the cancelled run.
function stopRun(id) {
  const run = state.runs[id]; if (!run) throw new Error(`no run "${id}"`);
  if (run.status !== 'running') return { id, status: run.status, stopped: 0 };          // already terminal — nothing to stop
  run.status = 'cancelled'; run.stoppedAt = now();
  for (const child of Object.values(state.runs)) if (child.parent && child.parent.runId === id && child.status === 'running') stopRun(child.id);   // 📦 stop nested sub-flows too
  let stopped = 0;
  for (const h of state.handoffs) {
    if (h.runId !== id) continue;
    if (h.status === 'submitted' || h.status === 'awaiting_approval' || h.status === 'approved') { touch(h, 'rejected', 'stopped'); stopped++; }
  }
  console.log(`⏹ [hub] flow run ${id} stopped (${stopped} pending handoff(s) cancelled)`);
  save();
  return { id, status: run.status, stopped };
}
// Wave A — per-edge Data Firewall: the productized granularity over the per-agent firewall in create().
// Each EDGE may carry share.never (extra strings to strip on THIS wire); the built-in secret/PII firewall
// ALWAYS runs and cannot be disabled. A cross-company edge (source/target agents differ in `company`) is
// deny-by-default: the firewall is mandatory there (the pass-allowlist for structured payloads is a future
// refinement — see docs/11 §2.6 #2). Every removal lands in the tamper-evident audit, tagged with the edge.
const companyOf = (run, nodeId) => { const n = nodeById(run, nodeId); const a = n && n.agent && state.agents[n.agent]; return a ? (a.company || null) : null; };
function fenceEdge(run, edge, value) {
  const never = (edge && edge.share && Array.isArray(edge.share.never)) ? edge.share.never : [];
  const sc = companyOf(run, edge.source), tc = companyOf(run, edge.target);
  const cross = !!sc && !!tc && sc !== tc;
  const fw = redact(value, { never });
  if (fw.removed.length) trail('redact', { runId: run.id, edge: edge.id || `${edge.source}→${edge.target}`, from: edge.source, to: edge.target, crossCompany: cross || undefined, removed: fw.removed });
  return fw.text;
}
// Wave E2 — dataflow with dead-branch elimination (so a router can fire ONE branch). An edge is "dead" if it's
// a router branch not taken (or feeds from a skipped node); a node is "skipped" if EVERY incoming edge is dead.
// A node fires once all its incoming edges have settled (each has an output, is dead, or its source is skipped)
// and at least one is live. Completion = every non-trigger node has an output OR is skipped. dead/skipped are
// arrays (run is persisted to inbox.json as JSON — Sets don't serialize).
const settled = (run, x) => run.dead.includes(x.id) || run.skipped.includes(x.source) || (x.source in run.outputs);
const live = (run, x) => (x.source in run.outputs) && !run.dead.includes(x.id) && !run.skipped.includes(x.source);
function markDead(run, e) { if (run.dead.includes(e.id)) return; run.dead.push(e.id); tryFire(run, e.target); }   // a newly-dead branch may let its target skip
function markSkipped(run, nodeId) { if (run.skipped.includes(nodeId)) return; run.skipped.push(nodeId); console.log(`↷ [hub] flow run ${run.id} skipped ${nodeId}`); for (const e of run.edges.filter((e) => e.source === nodeId)) markDead(run, e); }
function tryFire(run, targetId) {
  const tgt = nodeById(run, targetId);
  if (!tgt || (targetId in run.outputs) || run.skipped.includes(targetId)) return;
  if (state.handoffs.some((h) => h.runId === run.id && h.node === targetId)) return;   // already running
  const incoming = run.edges.filter((x) => x.target === targetId);
  if (!incoming.every((x) => settled(run, x))) return;                                  // wait until every input edge settles
  const liveIn = incoming.filter((x) => live(run, x));
  if (!liveIn.length) return markSkipped(run, targetId);                                // all inputs dead → node unreachable
  fireNode(run, tgt, liveIn.map((x) => fenceEdge(run, x, run.outputs[x.source])).filter(Boolean).join('\n\n'));
}
function advanceFrom(run, nodeId) {
  if (run.status === 'cancelled') { save(); return; }                                   // ⏹ stopped run: record the result but fire nothing downstream (never completes)
  run.dead ||= []; run.skipped ||= []; run.routerPick ||= {};                           // tolerate runs created before Wave E2
  const pick = run.routerPick[nodeId];                                                  // 'then'|'else' if nodeId is a router that decided
  for (const e of run.edges.filter((e) => e.source === nodeId)) {
    if (pick !== undefined && (e.branch || 'then') !== pick) { markDead(run, e); continue; }   // router: prune the branch not taken
    tryFire(run, e.target);
  }
  if (run.nodes.filter((n) => n.kind !== 'trigger').every((n) => (n.id in run.outputs) || run.skipped.includes(n.id))) {
    run.status = 'completed'; console.log(`✓ [hub] flow run ${run.id} completed`);
    if (run.parent) { const p = state.runs[run.parent.runId];                       // 📦 nested sub-flow done → hand its result up to the parent node, then advance the parent
      if (p && p.status === 'running' && !(run.parent.node in p.outputs)) { p.outputs[run.parent.node] = flowResult(run); advanceFrom(p, run.parent.node); } }
  }
  save();
}

// ---------- automations (Wave C): trigger node + wired workflow; fire on manual / build_state event ----------
// An automation = { trigger:{type:'manual'|'schedule'|'build_state', when?, match?}, workflow:<id>, input }.
// "save as automation" splits the canvas: the trigger node's config + the agent chain saved as a workflow it refs.
const AUTO_FILE = path.join(HERE, '..', 'mcp', 'automations.json');
const readAutomations = () => { try { return JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8')); } catch { return []; } };
// ---------- integrations (Wave F.2): connected MCP servers, on/off. Only enabled servers' tools reach palette/executor ----------
const INTEG_FILE = path.join(HERE, '..', 'mcp', 'integrations.json');
const readIntegrations = () => { try { return JSON.parse(fs.readFileSync(INTEG_FILE, 'utf8')); } catch { return []; } };
const writeIntegrations = (arr) => fs.writeFileSync(INTEG_FILE, JSON.stringify(arr, null, 2));
function saveIntegration({ id, label, kind, command, url, enabled, tools }) {
  id = id || (label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'mcp-' + randomUUID().slice(0, 4);
  const it = { id, label: label || id, kind: kind || 'mcp', command: command || '', url: url || '', enabled: enabled !== false, tools: Array.isArray(tools) ? tools : [] };
  const arr = readIntegrations(); const i = arr.findIndex((x) => x.id === id);
  if (i >= 0) arr[i] = { ...arr[i], ...it }; else arr.push(it);
  writeIntegrations(arr); return it;
}
function toggleIntegration(id, on) { const arr = readIntegrations(); const it = arr.find((x) => x.id === id); if (!it) throw new Error(`no integration "${id}"`); it.enabled = on !== false; writeIntegrations(arr); return it; }
// Wave J — build-state IR: a first-class, named event vocabulary (vs n8n's generic webhook) + a small,
// no-eval match DSL. The deeper this IR, the harder it is for a generic iPaaS to copy ("IR depth = moat").
const BUILD_EVENTS = [
  { event: 'pr_opened', fields: ['repo', 'pr', 'author', 'branch'] },
  { event: 'pr_merged', fields: ['repo', 'pr', 'branch', 'base'] },
  { event: 'review_completed', fields: ['repo', 'pr', 'status'] },   // status: green | red | changes_requested
  { event: 'ci_passed', fields: ['repo', 'sha', 'suite'] },
  { event: 'test_red', fields: ['repo', 'suite', 'failures'] },
  { event: 'rc_built', fields: ['repo', 'version', 'artifact'] },
  { event: 'deploy_green', fields: ['env', 'version', 'service'] },
  { event: 'deploy_failed', fields: ['env', 'version', 'reason'] },
  { event: 'issue_filed', fields: ['repo', 'issue', 'severity'] },
  { event: 'release_tagged', fields: ['repo', 'tag', 'version'] },
];
const MATCH_OPS = {                                        // operators usable in a trigger.match leaf, e.g. {status:{$in:["green"]}}
  $in: (v, a) => Array.isArray(a) && a.includes(v), $nin: (v, a) => Array.isArray(a) && !a.includes(v),
  $ne: (v, x) => v !== x, $gt: (v, x) => v > x, $gte: (v, x) => v >= x, $lt: (v, x) => v < x, $lte: (v, x) => v <= x,
  $exists: (v, b) => (v !== undefined) === !!b,
};
const isOps = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0 && Object.keys(o).every((k) => k[0] === '$');
const deepMatch = (pat, val) => {                          // same semantics as mcp/server.mjs (shared trigger matching)
  if (isOps(pat)) return Object.entries(pat).every(([op, arg]) => !!MATCH_OPS[op] && MATCH_OPS[op](val, arg));   // operator leaf
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
const matchingAutomations = (event) => readAutomations().filter((m) => m.enabled !== false && triggerMatches(m.trigger, event));
function fireEvent(event, input) {                          // build-state event → run every enabled automation whose trigger matches
  const matched = matchingAutomations(event);
  const fired = [];
  for (const m of matched) {
    try { fired.push({ automation: m.id, ...runFlow({ id: m.workflow, input: input ?? m.input ?? '' }) }); }
    catch (e) { fired.push({ automation: m.id, error: e.message }); }
  }
  return { event, matched: matched.map((m) => m.id), fired };
}
// Wave 2 (usability): dry-run a build-state event — which enabled automations would fire and what each one runs —
// so "⚡ Fire" can say in plain language what happens BEFORE it happens (no agents run, nothing is sent).
const nodeLabel = (n) => n.kind === 'mcp' ? `🔌 ${n.tool || n.server || 'mcp'}` : n.kind === 'router' ? '◇ router'
  : n.kind === 'input' ? 'Chat Input' : n.kind === 'output' ? 'Chat Output' : n.kind === 'prompt' ? 'Prompt' : (n.agent || n.id);
const edgeFenced = (e) => !!(e && e.share && ((Array.isArray(e.share.never) && e.share.never.length) || (Array.isArray(e.share.classes) && e.share.classes.length)));
function firePreview(event) {                               // read-only: same matcher as fireEvent, but describes instead of runs
  const wfs = readWorkflows();
  const matches = matchingAutomations(event).map((m) => {
    const wf = wfs.find((w) => w.id === m.workflow);
    const nodes = wf ? wf.nodes.filter((n) => n.kind !== 'trigger') : [];
    const edges = wf ? wf.edges : [];
    return { id: m.id, name: m.name || m.id, summary: m.summary || '', chain: toposort(nodes, edges).map(nodeLabel), fenced: edges.some(edgeFenced) };
  });
  return { event, matches };
}

// ---------- Ghost Writer (Wave L): NL → a validated, laid-out flow. Generation ≠ execution — the human
// reviews on the canvas and Run keeps the approval fence. Uses the agent index + connected MCP tools + the
// component kinds. A real vendor (claude/codex) generates the flow JSON; otherwise a deterministic heuristic
// builds one from the index so it works offline/stub. Every edge is typed-port validated (bad ones dropped). ----------
function createAgent({ name, skill, systemPrompt, accepts, emits, stub, vendor, company }) {
  if (!name) throw new Error('name required');
  const a = agent(name); a.skill = skill || a.skill || 'task'; a.company = company || a.company || null;
  a.accepts = Array.isArray(accepts) ? accepts : (a.accepts || ['*']); a.emits = Array.isArray(emits) ? emits : (a.emits || ['*']);
  a.local = { skillId: a.skill, vendor: vendor || 'stub', systemPrompt: systemPrompt || '', stub: stub || '' };   // runnable in-process
  a.autorun = true; save(); return publicAgents().find((x) => x.id === name);
}
const PORTS = { input: { accepts: [], emits: ['text', '*'] }, prompt: { accepts: ['*'], emits: ['text', '*'] }, output: { accepts: ['*'], emits: [] }, trigger: { accepts: [], emits: ['*'] } };
function portsOf(node) {
  if (node.kind === 'agent') { const a = state.agents[node.agent || node.id]; return { accepts: a?.accepts || ['*'], emits: a?.emits || ['*'] }; }
  if (node.kind === 'mcp') { const it = readIntegrations().find((x) => x.id === node.server); const tl = (it?.tools || []).find((t) => t.name === node.tool); return { accepts: tl?.accepts || ['*'], emits: tl?.emits || ['*'] }; }
  return PORTS[node.kind] || { accepts: ['*'], emits: ['*'] };
}
const portIntersect = (emits, accepts) => emits.includes('*') || accepts.includes('*') || emits.some((x) => accepts.includes(x));
function validateFlow(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n])); const warnings = []; const kept = [];
  for (const e of edges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) { warnings.push(`dropped ${e.source}→${e.target} (missing node)`); continue; }
    const so = portsOf(s), to = portsOf(t);
    if (!so.emits.length || !to.accepts.length || !portIntersect(so.emits, to.accepts)) { warnings.push(`dropped ${e.source}→${e.target} (port mismatch)`); continue; }
    kept.push({ id: e.id || 'e' + kept.length, source: e.source, target: e.target, ...(e.share ? { share: e.share } : {}) });
  }
  return { edges: kept, warnings };
}
function layoutFlow(nodes, edges) {                          // left→right by longest-path depth
  const order = toposort(nodes, edges); const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (const n of order) for (const e of edges.filter((e) => e.source === n.id)) depth.set(e.target, Math.max(depth.get(e.target) || 0, (depth.get(n.id) || 0) + 1));
  const rows = {};
  for (const n of nodes) { const d = depth.get(n.id) || 0; n.x = 40 + d * 240; n.y = 40 + (rows[d] = (rows[d] || 0)) * 120; rows[d]++; }
  return nodes;
}
const tok = (s) => (s || '').toLowerCase().match(/[a-z0-9]+/g) || [];   // tokenize on non-alphanumerics (so "find-prospects" ≈ "find prospects")
const kw = (text, q) => { const hay = ' ' + tok(text).join(' ') + ' '; return [...new Set(tok(q))].filter((t) => t.length >= 3).reduce((n, t) => n + (hay.includes(` ${t} `) ? 1 : 0), 0); };  // ≥3 chars: skip stopwords like "a"/"is"/"to"
function firstHit(p, a) { let m = Infinity; for (const t of tok(`${a.id} ${a.skill} ${a.company || ''}`)) { const i = p.indexOf(t); if (i >= 0) m = Math.min(m, i); } return m; }
function heuristicFlow(prompt) {
  const p = prompt.toLowerCase();
  const cand = Object.values(state.agents).filter((a) => a.skill).map((a) => ({ a, s: kw(`${a.id} ${a.skill} ${a.company || ''}`, p), at: firstHit(p, a) })).filter((x) => x.s > 0);
  cand.sort((x, y) => x.at - y.at || y.s - x.s);                // chain by order of mention, then score
  const mid = []; let agentDraft = null;
  if (cand.length) { cand.forEach(({ a }) => mid.push({ id: a.id, kind: 'agent', agent: a.id, skill: a.skill })); }
  else {                                                       // no agent matched → a generic Prompt step + draft a fitting agent
    mid.push({ id: 'prompt-1', kind: 'prompt', config: { template: `${prompt.trim()}\n\n{input}` } });
    const slug = tok(prompt).slice(0, 3).join('-') + '-agent';
    agentDraft = { name: slug || 'new-agent', skill: 'task', accepts: ['*'], emits: ['text', '*'], systemPrompt: `You are an agent that: ${prompt.trim()}` };
  }
  const mcp = matchMcpTool(p);                                  // append an external action if the prompt asks to send/post
  if (mcp) mid.push({ id: 'mcp-1', kind: 'mcp', server: mcp.server, tool: mcp.tool, config: {} });
  const trig = matchTrigger(p);                                 // event-driven → trigger is the entry (no Chat Input); else Chat Input
  const entry = trig ? { id: 'trigger-1', kind: 'trigger', trigger: trig } : { id: 'input-1', kind: 'input', config: {} };
  const nodes = [entry, ...mid, { id: 'output-1', kind: 'output', config: {} }];
  const edges = []; for (let i = 0; i < nodes.length - 1; i++) edges.push({ source: nodes[i].id, target: nodes[i + 1].id });
  return { nodes, edges, agentDraft };
}
function matchMcpTool(p) {
  const tools = readIntegrations().filter((it) => it.enabled !== false).flatMap((it) => (it.tools || []).map((t) => ({ server: it.id, tool: t.name })));
  if (/email|e-mail|メール/.test(p)) { const t = tools.find((x) => /email|mail/.test(x.tool)); if (t) return t; }
  if (/slack|post|message|通知|チャンネル|channel|notify/.test(p)) { const t = tools.find((x) => /post|message|chat/.test(x.tool)); if (t) return t; }
  if (/\bsend\b|送/.test(p)) return tools.find((x) => /send|email|mail/.test(x.tool)) || tools[0] || null;
  return null;
}
function matchTrigger(p) {
  if (/\bpr\b|pull request|merge|マージ/.test(p)) return { type: 'build_state', match: { event: 'pr_merged' } };
  if (/deploy|デプロイ|green|本番|release/.test(p)) return { type: 'build_state', match: { event: 'deploy_green' } };
  if (/review|レビュー/.test(p)) return { type: 'build_state', match: { event: 'review_completed', status: 'green' } };
  if (/when|whenever|on |毎|every|trigger|きっかけ|たら/.test(p)) return { type: 'build_state', match: { event: 'build_state' } };
  return null;
}
async function llmFlow(prompt) {
  const agents = publicAgents().map((a) => ({ id: a.id, skill: a.skill, company: a.company, accepts: a.accepts, emits: a.emits }));
  const tools = readIntegrations().filter((it) => it.enabled !== false).flatMap((it) => (it.tools || []).map((t) => ({ server: it.id, tool: t.name, accepts: t.accepts, emits: t.emits })));
  const sys = `You design a BuildHUD flow as JSON. Output ONLY JSON: {"nodes":[...],"edges":[...]}.
Node kinds: "input"(Chat Input, emits text), "agent"{agent:<id from AGENTS>}, "prompt"{config:{template}} (use {input}), "mcp"{server,tool from TOOLS}, "output"(Chat Output). Edges {source,target} by node id. An edge is valid only if source.emits ∩ target.accepts ≠ ∅ ("*"=any).
AGENTS=${JSON.stringify(agents)}
TOOLS=${JSON.stringify(tools)}
TASK: ${prompt}`;
  const out = await runVendorAsync(EXEC_VENDOR || 'claude', sys, '');
  const m = out.match(/\{[\s\S]*\}/); if (!m) throw new Error('no JSON');
  const flow = JSON.parse(m[0]); if (!Array.isArray(flow.nodes) || !flow.nodes.length) throw new Error('empty');
  return { nodes: flow.nodes, edges: flow.edges || [], agentDraft: null };
}
async function ghostwrite({ prompt }) {
  prompt = String(prompt || '').trim(); if (!prompt) throw new Error('prompt required');
  let flow, source;
  if (EXEC_VENDOR && EXEC_VENDOR !== 'stub') { try { flow = await llmFlow(prompt); source = 'llm'; } catch { flow = null; } }
  if (!flow) { flow = heuristicFlow(prompt); source = 'heuristic'; }
  for (const n of flow.nodes) if (n.kind === 'agent' && !n.skill) { const a = state.agents[n.agent || n.id]; if (a) n.skill = a.skill; }   // backfill skill from the index (covers the LLM path)
  const v = validateFlow(flow.nodes, flow.edges); layoutFlow(flow.nodes, v.edges);
  return { nodes: flow.nodes, edges: v.edges, agentDraft: flow.agentDraft || null, warnings: v.warnings, source };
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
    return json(res, 200, { autorun: AUTORUN, agents: publicAgents(), handoffs: state.handoffs.map((h) => ({ ...ref(h), input: h.input, result: h.result, error: h.error, history: h.history, runId: h.runId || null, redacted: h.redacted || null, consensus: h.consensus || null })), runs: Object.values(state.runs).slice(-20).map((r) => ({ id: r.id, flowId: r.flowId, status: r.status, done: Object.keys(r.outputs).length, total: r.nodes.length, outputs: r.outputs, skipped: r.skipped || [], routerPick: r.routerPick || {} })), reputation: reputationFrom(state.audit, state.handoffs, Object.keys(state.agents)) });   // Wave R: per-agent audit-backed reputation (derived, read-time)
  if (req.method === 'GET' && p === '/api/workflows')
    return json(res, 200, readWorkflows().map((w) => ({ id: w.id, name: w.name, nodes: (w.nodes || []).length, edges: (w.edges || []).length, steps: (w.steps || []).length })));
  if (req.method === 'GET' && p === '/api/automations')
    return json(res, 200, readAutomations().map((m) => ({ id: m.id, name: m.name, trigger: m.trigger, workflow: m.workflow, enabled: m.enabled !== false })));
  if (req.method === 'GET' && p === '/api/integrations')         // connected MCP servers (Wave F.2)
    return json(res, 200, readIntegrations());
  if (req.method === 'GET' && p === '/api/audit')                // Wave H: tamper-evident trust trail + chain verification
    return json(res, 200, { entries: state.audit, verify: auditVerify(state.audit) });
  if (req.method === 'GET' && p === '/api/buildstate')           // Wave J: the build-state IR vocabulary + match operators
    return json(res, 200, { events: BUILD_EVENTS, operators: Object.keys(MATCH_OPS) });
  if (req.method === 'GET' && p === '/api/capvocab')             // Wave B: the capability-passport vocabulary (drives the passport editor)
    return json(res, 200, CAP_VOCAB);
  if (req.method === 'GET' && p === '/api/mcp')                  // how to connect BuildHUD's MCP server (for "copy MCP call")
    return json(res, 200, { name: 'buildhud-mcp', command: 'node', args: [path.resolve(HERE, '..', 'mcp', 'server.mjs')], hub: `http://localhost:${PORT}`, tokenEnv: 'A2A_SHARED_TOKEN' });
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
      if (p === '/api/fire/preview') return json(res, 200, firePreview(j.event || {})); // Wave 2: dry-run — what this event would fire (no run)
      if (p === '/api/autorun') return json(res, 200, setGlobalAutorun(j.on));         // global master autorun on/off
      if (p === '/api/integrations') return json(res, 200, saveIntegration(j));        // add/update an MCP server integration
      if (p === '/api/agents') return json(res, 200, createAgent(j));                  // create a (runnable, in-process) agent from a draft
      if (p === '/api/ghostwrite') { ghostwrite(j).then((r) => json(res, 200, r)).catch((e) => json(res, 400, { error: e.message })); return; }  // Wave L: NL → validated flow
      if (p === '/api/trust/preview') return json(res, 200, trustPreview(j));   // Wave E1: dry-run the firewall + cap gates over a draft flow (read-only)
      let m;
      if ((m = p.match(/^\/api\/runs\/([^/]+)\/stop$/))) return json(res, 200, stopRun(m[1]));   // ⏹ stop an in-flight DAG run
      if ((m = p.match(/^\/api\/integrations\/([^/]+)\/toggle$/))) return json(res, 200, toggleIntegration(m[1], j.on));
      if ((m = p.match(/^\/api\/handoffs\/([^/]+)\/(approve|decline|result)$/)))
        return json(res, 200, m[2] === 'approve' ? ref(approve(m[1])) : m[2] === 'decline' ? ref(decline(m[1])) : ref(postResult(m[1], j)));
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/policy$/))) return json(res, 200, setPolicy(m[1], j));
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/autorun$/))) return json(res, 200, setAutorun(m[1], j.on)); // per-agent autorun on/off
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/passport$/))) return json(res, 200, setPassport(m[1], j));  // Wave H: edit capability passport
      return json(res, 404, { error: `unknown route ${p}` });
    } catch (e) { return json(res, 400, { error: e.message }); }
  });
});
server.on('error', (e) => { console.error(`[hub] cannot listen on ${PORT}: ${e.message} — pass --port <free>`); process.exit(1); });
server.listen(PORT, () => console.log(`[hub] BuildHUD durable handoff hub on http://localhost:${PORT}  (state: ${path.relative(process.cwd(), STATE_FILE)})`));
