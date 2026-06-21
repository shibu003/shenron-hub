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
import { randomUUID, generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { runVendorAsync } from '../runner.mjs';
import { callMcpTool, safeEnv } from '../mcp/mcp-client.mjs';
import { langflowRun, langflowImport } from './langflow.mjs';
import { plan as shenronPlan, toLangflowFlow, genComponent, flowSkill, componentKey, matchComponent, neededCredentials, renderPlan } from './shenron.mjs';
import { redact, applyPass, auditAppend, auditVerify, reputationFrom, buildReceipt, signReceipt, DEFAULT_PASSPORT, normalizePassport, sendMode, CAP_VOCAB } from '../trust.mjs';
import { readPermissions, writePermissions, addAllowRule } from '../permissions.mjs';   // Wave 11b: browser-control allow/ask/deny ruleset
import { MATCH_OPS, triggerMatches, cronMatch, lastDue } from '../match.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');           // spawn MCP servers from here so integrations.json can use repo-relative commands
const _SD = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : null;
const sp = (name, fallback) => _SD ? path.join(_SD, name) : fallback;  // ponytail: STATE_DIR → all state to one volume; unset → original layout
const PORT = (() => { const i = process.argv.indexOf('--port'); return i > -1 ? Number(process.argv[i + 1]) : Number(process.env.PORT) || 8795; })();
const EXEC_VENDOR = (() => { const i = process.argv.indexOf('--vendor'); return i > -1 ? process.argv[i + 1] : null; })(); // force local-exec vendor (e.g. stub); null = each agent's own
let AUTORUN = !process.argv.includes('--no-autorun');     // global master: may the hub run LOCAL agents in-process (autorun)?
const autorunOn = (a) => AUTORUN && a.autorun !== false;  // per-agent autorun (default on) AND-ed with the global master; off → broker-only (waits for a worker)
const STATE_FILE = sp('inbox.json', path.join(HERE, 'inbox.json'));
const UI_FILE = path.join(HERE, 'ui.html');
const ONLINE_MS = 12000;                    // an agent is "online" if it polled within this window

const now = () => Date.now();
const parseFmt = (p, inp) => String(p || '{input}').split('{input}').join(inp || '');   // Parser node: substitute {input} (pure string transform)
const WF_FILE = sp('workflows.json', path.join(HERE, '..', 'mcp', 'workflows.json'));   // shared workflow store (nodes/edges canonical + steps[] shim)
let state = load();
state.runs ||= {};                          // runId -> { nodes, edges, outputs, status } for in-flight DAG runs
state.audit ||= [];                         // Wave H: hash-chained, tamper-evident trust trail
const trail = (type, detail) => { const e = auditAppend(state.audit, { type, ts: now(), ...detail }); save(); return e; };
function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { handoffs: [], agents: {} }; } }
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('[hub] save failed', e.message); } }
// Wave ③ — the hub's ed25519 signing key for Trust Receipts. Generated on first boot, persisted to a gitignored
// PEM (*.pem). The public key is exported (safe); the private key NEVER leaves the box and is never committed.
function loadOrCreateKeypair(pemPath) {
  let privateKey;
  try { privateKey = createPrivateKey(fs.readFileSync(pemPath, 'utf8')); }
  catch { const kp = generateKeyPairSync('ed25519'); fs.writeFileSync(pemPath, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); privateKey = kp.privateKey; console.log('[hub] generated ed25519 receipt key →', path.relative(process.cwd(), pemPath)); }
  return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) };
}
const HUB_KEY = loadOrCreateKeypair(sp('hub-key.pem', path.join(HERE, 'hub-key.pem')));
const receiptFor = (runId) => { if (!runId || !state.runs[runId]) throw new Error(`no run "${runId}"`); return signReceipt(buildReceipt({ hub: { id: 'buildhud-hub', publicKey: HUB_KEY.publicKeyPem }, runId, run: state.runs[runId], audit: state.audit, handoffs: state.handoffs, issuedAt: now() }), HUB_KEY.privateKey); };

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
// Wave: 登録だけで動く — computer-use の worker を hub がオンデマンド自動起動（手動 `node browser-worker.mjs` 不要）。
// 二重起動防止: 自分が spawn したプロセスを保持 + 既に worker が poll 中（online）なら起こさない。worker は永続 profile を使う。
let browserWorkerProc = null;
function ensureBrowserWorker() {
  if (process.env.BUILDHUD_NO_AUTOSPAWN) return;          // tests drive their own worker
  if (browserWorkerProc) return;                          // already auto-spawned by us
  const a = state.agents['browser-control'];
  if (a && online(a)) return;                             // a worker (manual or prior) is already polling
  const script = path.join(HERE, '..', 'agents', 'browser-worker.mjs');
  try {
    browserWorkerProc = spawn(process.execPath, [script, '--hub', `http://localhost:${PORT}`], { cwd: REPO_ROOT, stdio: 'ignore' });
    browserWorkerProc.on('exit', () => { browserWorkerProc = null; });   // crashed/exited → allow respawn on next browser task
    trail('worker-spawn', { agent: 'browser-control' });
    console.log('▶ [hub] auto-spawned browser-worker (computer-use)');
  } catch (e) { browserWorkerProc = null; console.error('[hub] browser-worker spawn failed:', e.message); }
}
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
  if (to === 'browser-control') ensureBrowserWorker();   // computer-use: bring up the worker on demand (no manual start)
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
  if (h.checkpoint) h.checkpoint.screenshot = null;   // Wave 11b: drop the base64 once the handoff is done (STATE_FILE bloat)
  touch(h, error ? 'failed' : 'completed', by); save();
  if (h.runId) advanceRun(h);               // this node is part of a DAG run → fire ready downstream nodes
  return h;
}
// Wave 11b — intra-handoff checkpoint: a RUNNING handoff (a browser-control worker mid-task) pauses for a
// human ok before an `ask`-classified step. Invariant: poll() never claims awaiting_approval/running, and
// browser-control stays REMOTE (no a.local) — so this state round-trip kicks off NO in-process execution;
// only the alive worker (polling /api/state for checkpoint.decided) resumes. Break either → double-exec.
function checkpoint(id, { screenshot, label, tool, domain } = {}) {
  const h = find(id);
  if (h.status !== 'running') throw new Error(`handoff ${id} is ${h.status}, not running`);
  h.checkpoint = { screenshot: screenshot || null, label: label || '', tool: tool || null, domain: domain || null, decided: null };
  touch(h, 'awaiting_approval', 'worker');
  trail('checkpoint', { handoff: id, tool: tool || null, domain: domain || null, label: label || '' });   // never the base64 screenshot
  save(); return h;
}
function approve(id) {
  const h = find(id);
  if (h.checkpoint && h.checkpoint.decided === null) {   // checkpoint fast-path: resume a paused worker IN PLACE — NOT a fresh task-start approval
    h.checkpoint.decided = 'approved'; touch(h, 'running', 'human'); trail('approve', { handoff: id, checkpoint: true, tool: h.checkpoint.tool, domain: h.checkpoint.domain }); save();
    return h;   // ⛔ no runMcp/schedule — the remote worker owns execution (touch('running') is not re-claimable by poll)
  }
  if (h.status !== 'awaiting_approval') throw new Error(`handoff ${id} is ${h.status}, not awaiting_approval`);
  touch(h, 'approved', 'human'); trail('approve', { handoff: id, to: h.to, skill: h.skill }); save(); if (h.mcp) runMcp(h); else schedule(h); return h;
}
function decline(id) {
  const h = find(id);
  if (h.checkpoint && h.checkpoint.decided === null) { h.checkpoint.decided = 'declined'; touch(h, 'rejected', 'human'); trail('decline', { handoff: id, checkpoint: true }); save(); return h; }
  touch(h, 'rejected', 'human'); save(); return h;
}
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
// Wave 8 — 生成部品の登録庫（§H: 生成→収束→人が一度承認→cache・再利用）。workflows.json と同じ shared store パターン。
const COMP_FILE = sp('components.json', path.join(HERE, '..', 'mcp', 'components.json'));
const readComponents = () => { try { return JSON.parse(fs.readFileSync(COMP_FILE, 'utf8')); } catch { return []; } };
const writeComponents = (arr) => fs.writeFileSync(COMP_FILE, JSON.stringify(arr, null, 2));
function saveComponent({ what, code, output, iters, credentials }) {    // 収束した部品を pending(approved:false) で登録。人が承認するまで再利用しない（§I）
  const arr = readComponents();
  const slug = componentKey(what).replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32);
  const id = 'cmp-' + (slug || randomUUID().slice(0, 6));
  const i = arr.findIndex((c) => c.id === id);
  const comp = { id, what, code, output: output || '', iters: iters || 0, credentials: credentials || [], approved: i >= 0 ? arr[i].approved : false, createdAt: i >= 0 ? arr[i].createdAt : now() };   // credentials = BYO-credential 名のみ（値は env）。再生成は上書き・承認状態は維持
  if (i >= 0) arr[i] = comp; else arr.push(comp);
  writeComponents(arr); return comp;
}
function approveComponent(id) { const arr = readComponents(); const c = arr.find((x) => x.id === id); if (!c) throw new Error(`no component "${id}"`); c.approved = true; writeComponents(arr); return c; }   // 人ゲート: これ以降この部品は再利用される
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
  const lf = nodes.find((n) => n.kind === 'langflow');   // 🔗 exotic component → not natively runnable; the whole flow must go to Langflow /v1/run
  if (lf) throw new Error(`flow has a Langflow component (${(lf.config && lf.config._lfType) || '🔗'}) — run via POST /api/langflow/run with flowId ${(lf.config && lf.config._lfFlowId) || '(missing — re-import the flow)'}`);
  const depth = parent ? ((state.runs[parent.runId]?.depth || 0) + 1) : 0;   // 📦 sub-flow nesting — bound it so a self-referential flow can't loop forever
  if (depth > 8) throw new Error('sub-flow nesting too deep (>8)');
  const trg = new Set(nodes.filter((n) => n.kind === 'trigger' || n.kind === 'note').map((n) => n.id));   // triggers = entry markers, notes = annotations — neither is executable
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
  if (node.kind === 'parser') { run.outputs[node.id] = parseFmt((node.config && node.config.pattern) || '{input}', input); save(); return advanceFrom(run, node.id); }   // Langflow-style Parser: pure string format (no LLM)
  if (node.kind === 'languagemodel') return firePromptNode(run, { ...node, config: { template: ((node.config && node.config.system) ? node.config.system + '\n\n' : '') + '{input}' } }, input, from);   // = prompt + system preamble (in-process vendor)
  if (node.kind === 'structured') return firePromptNode(run, { ...node, config: { template: `Return JSON${(node.config && node.config.schema) ? ` with fields: ${node.config.schema}` : ''}.\n${(node.config && node.config.instructions) || ''}\n--- INPUT ---\n{input}` } }, input, from);   // structured-output ≈ prompt asking for JSON
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
    const pass = upstream?.passport?.share?.pass || [];            // capability passport: structured-args allowlist (default-deny when set)
    const pf = applyPass(config || {}, pass);                      // gate the CONFIG fields only; the scrubbed `input` payload always flows
    if (pf.dropped.length) trail('pass-drop', { handoff: h.id, to: `${server}.${tool}`, allowlist: pass, dropped: pf.dropped });
    const out = await callMcpTool(integ, tool, { ...pf.args, input: fw.text }, { cwd: REPO_ROOT, ...(integ.generated ? { env: safeEnv(integ.credentials || []) } : {}) });   // Wave 9: 生成 server は untrusted → default-deny の env で spawn。BYO-credential は宣言名だけ ride through（信頼済 server は env 継承のまま）
    trail('send', { handoff: h.id, server, tool, redacted: fw.removed.length, ...(integ.generated && (integ.credentials || []).length ? { creds: integ.credentials } : {}) });   // creds=注入した名前のみ・値は絶対に出さない
    postResult(h.id, { result: out }, 'hub');
  } catch (e) { postResult(h.id, { error: e.message }, 'hub'); }
  finally { running.delete(h.id); console.log(`✓ [hub] MCP ${h.id} done`); }
}
function setPassport(id, { caps, share }) {                   // Wave H/B: edit an agent's structured capability passport
  const a = agent(id);
  a.passport = normalizePassport({ caps: caps || a.passport.caps, share: share || a.passport.share });   // normalize clamps to CAP_VOCAB
  save(); trail('passport', { agent: id, caps: a.passport.caps, never: a.passport.share.never.length, pass: a.passport.share.pass.length });
  return { id, passport: a.passport };
}
// Wave E1 — trust-as-you-build: dry-run the SAME firewall + capability enforcement over a draft flow WITHOUT
// executing any agent, so the cockpit can show "what would the trust boundary do" before Run. The thing Langflow
// structurally can't show (it has no trust model). Read-only — never mutates state, never sends. Concrete
// strip counts are shown only where the upstream text is known (input nodes / flow input); agent outputs are
// runtime, so their outgoing edges report the wire POLICY (fenced categories) instead of counts — honest, no overclaim.
function trustPreview({ nodes, edges, input }) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes[] + edges[] required');
  const trg = new Set(nodes.filter((n) => n.kind === 'trigger' || n.kind === 'note').map((n) => n.id));
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
      const pass = up ? normalizePassport(up.passport).share.pass : [];   // structured-args allowlist on this send (empty = allow-all)
      gates.push({ node: n.id, kind: 'mcp', server: n.server, tool: n.tool, externalSend: mode, gate: mode === 'deny' ? 'denied' : mode === 'allow' ? (n.auto ? 'auto' : 'approval') : 'approval', pass });
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
const AUTO_FILE = sp('automations.json', path.join(HERE, '..', 'mcp', 'automations.json'));
const readAutomations = () => { try { return JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8')); } catch { return []; } };
// Wave: in-hub scheduler. ⚠️ HONEST — fires ONLY while THIS hub process runs (Mac on / 24/7 cloud host).
// Phone-only users with no always-on hub: it can't fire. Operator sets SHENRON_NO_SCHEDULER=1 to turn it off,
// and the planner then steers scheduled goals to an external always-on option (e.g. Google Apps Script).
const SCHEDULER_ON = process.env.SHENRON_NO_SCHEDULER == null;
const SCHEDULER_NOTE = SCHEDULER_ON
  ? '⏰ fires only while this hub process is running (your Mac on, or a 24/7 cloud host). If you only use a phone with no always-on hub, it will NOT fire — use an external scheduler (e.g. Google Apps Script).'
  : '⚠️ in-hub scheduler is OFF here (SHENRON_NO_SCHEDULER) — scheduled automations will NOT fire. Use an external scheduler (Apps Script / cron).';
// ---------- integrations (Wave F.2): connected MCP servers, on/off. Only enabled servers' tools reach palette/executor ----------
const INTEG_FILE = sp('integrations.json', path.join(HERE, '..', 'mcp', 'integrations.json'));
const readIntegrations = () => { try { return JSON.parse(fs.readFileSync(INTEG_FILE, 'utf8')); } catch { return []; } };
const writeIntegrations = (arr) => fs.writeFileSync(INTEG_FILE, JSON.stringify(arr, null, 2));
// clean-mcp token-light index for integrations (mirrors server.mjs search_integrations): keyword score → SMALL refs.
// The cockpit/AI search the index and get_integration ONE for its full tool list (vs the old /api/integrations dump).
const searchIntegrationsRefs = (q = '', limit = 999) => {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hayOf = (it) => `${it.label} ${it.id} ${it.kind} ${(it.tools || []).map((tl) => tl.name).join(' ')} ${(it.tags || []).join(' ')}`.toLowerCase();
  return readIntegrations()
    .map((it) => ({ it, s: terms.reduce((n, t) => n + (hayOf(it).includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.s > 0 || !terms.length).sort((x, y) => y.s - x.s).slice(0, limit)
    .map(({ it }) => ({ id: it.id, label: it.label, kind: it.kind, enabled: it.enabled !== false, tools: (it.tools || []).length, tags: it.tags }));
};
function saveIntegration({ id, label, kind, command, url, enabled, tools, generated, credentials }) {
  id = id || (label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'mcp-' + randomUUID().slice(0, 4);
  const it = { id, label: label || id, kind: kind || 'mcp', command: command || '', url: url || '', enabled: enabled !== false, tools: Array.isArray(tools) ? tools : [], ...(generated ? { generated: true } : {}), ...(credentials && credentials.length ? { credentials } : {}) };   // Wave 9: generated=神龍 untrusted server → run 時 safeEnv で fence。credentials=BYO-credential 名のみ(値は env・repo に乗せない)
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
// MATCH_OPS / deepMatch / triggerMatches → ../match.mjs (shared with mcp/server.mjs so they can't drift)
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
  return trigger.type === 'schedule' ? { ...m, note: SCHEDULER_NOTE } : m;   // Wave: be honest about the "fires only while hub up" limit at creation time
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

// Wave: persisted schedule state（automation id → 最後に発火した epoch ms）。STATE_DIR に置く＝再起動/volume を跨いで catch-up が効く。
const SCHED_FILE = sp('schedule-state.json', path.join(HERE, 'schedule-state.json'));
const readSchedState = () => { try { return JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8')); } catch { return {}; } };
const writeSchedState = (s) => { try { fs.writeFileSync(SCHED_FILE, JSON.stringify(s)); } catch { /* best-effort */ } };
// tick: 各 schedule automation の「直近 due」を見て、まだ発火してなければ発火（live も catch-up も同経路）。
// first-sight は baseline のみ（インストール前の履歴は back-fire しない）。downtime で過ぎた due は次の tick/boot で1回だけ追い発火（coalesced）。
function tickScheduler() {
  const now = new Date(); const st = readSchedState(); let changed = false;
  for (const m of readAutomations()) {
    if (m.enabled === false || !m.trigger || m.trigger.type !== 'schedule') continue;
    const expr = m.trigger.when || m.trigger.cron; if (!expr) continue;
    const due = lastDue(expr, now); if (due == null) continue;
    if (!(m.id in st)) { st[m.id] = due; changed = true; continue; }   // 初見=baseline（過去履歴を追い発火しない）
    if (st[m.id] >= due) continue;                                      // この due（以降）は処理済み → 重複/再発火しない
    st[m.id] = now.getTime(); changed = true;
    const catchUp = due < now.getTime() - 90000;                       // due が過去（>1.5分前）= downtime 後の追い発火
    try { trail('schedule-fire', { automation: m.id, when: expr, due: new Date(due).toISOString(), catchUp }); runFlow({ id: m.workflow, input: m.input || '' }); }
    catch (e) { trail('schedule-fire', { automation: m.id, error: e.message }); }
  }
  if (changed) writeSchedState(st);
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

// ---------- OAuth 2.1 minimal (personal server — auto-approve, PKCE only) ----------
// ponytail: no user DB, no sessions — single-owner personal use via ngrok/Railway
const oauthClients = new Map();  // client_id → {name}
const oauthCodes   = new Map();  // code → {client_id, code_challenge}
const oauthTokens  = new Set();  // valid Bearer tokens (in-memory; cleared on restart)
const reqBase = (req) => { const proto = req.headers['x-forwarded-proto'] || 'http'; const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`; return `${proto}://${host}`; };
const SHARED_TOKEN = process.env.A2A_SHARED_TOKEN || '';   // Wave C: internal credential — server.mjs / browser-worker / Artifact / CLI auth to act routes (same token as A2A reach). Set it (and/or use OAuth) to enforce; unset = local dev open.
const bearerOk = (req) => {                                 // valid if OAuth bearer (claude.ai via /mcp) OR the shared token (internal callers via /api). Open only when NEITHER is configured.
  if (!oauthTokens.size && !SHARED_TOKEN) return true;
  const t = (req.headers['authorization'] || '').replace(/^Bearer /i, '').trim();
  return (SHARED_TOKEN && t === SHARED_TOKEN) || oauthTokens.has(t);
};

// ---------- Remote MCP (HTTP/SSE transport — Claude.ai mobile connects here, no API key needed) ----------
const mcpSessions = new Map(); // sessionId → SSE res
const MCP_TOOLS = [
  { name: 'plan_flow',          description: '神龍: 自然文ゴール → 実フロー（順序ステップ＋既存ツールでの解決 have / 不足 gap）。DISCOVER-FIRST: 願いを全機構横断で研究し地雷(API無/ToS/許可)も検出。曖昧 or 地雷があれば plan でなく `clarify`(question+options・mode:"clarify") を返す→ ユーザーに提示し、回答を `context.choices`(例 [{question,answer}]) に入れて再呼び出し。`available`（登録済みエージェント/ツール/フロー＋組込 agent:browser-control）と人間可読 `summary_text` + `diagram_mermaid`/`diagram_ascii` も返す。既定で保存（save:false で設計のみ）。NOTE: あなたの MCP client が接続しているツール（claude.ai の Gmail 等）はここからは見えません（MCP 仕様: server 同士は互いを見られない）→ 使わせたいツールは add_integration で登録するか、UI のみのサービスは agent:browser-control に解決されます。', inputSchema: { type: 'object', properties: { goal: { type: 'string', description: '実現したいこと' }, save: { type: 'boolean' }, gap: { type: 'string', description: 'off|ask|auto' }, cost: { type: 'string', description: 'free(既定・従量0優先・有料は opt-in 化)|paid_ok(有料ツール可・コスト開示)' } }, required: ['goal'] } },
  { name: 'add_integration',    description: '自分の MCP server を giogio に登録 → plan_flow の available に出て、フローのノードとして解決される。client 接続は giogio から見えないので、使わせたいツールはこれで登録する。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string', description: 'mcp（既定）| search' }, command: { type: 'string', description: 'stdio MCP の起動コマンド' }, url: { type: 'string', description: 'HTTP MCP の URL' }, tools: { type: 'array', description: '[{name, accepts?, emits?}]' } }, required: ['id', 'label'] } },
  { name: 'add_automation',     description: 'スケジュール(cron) or build-state イベントで保存済み workflow を自動実行する automation を登録。schedule 例: trigger {type:"schedule", when:"0 9 * * 1"}（毎週月曜9時）。⚠️ in-hub scheduler は hub 起動中のみ発火（スマホのみ/常駐hub無しでは動かない→外部 scheduler を使う）。返りの note を確認。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, trigger: { type: 'object', description: '{type:"schedule",when:"<cron 5-field>"} or {type:"build_state",match:{...}}' }, workflow: { type: 'string', description: '実行する保存済み workflow id' }, input: { type: 'string' } }, required: ['name', 'trigger', 'workflow'] } },
  { name: 'save_workflow',      description: 'nodes/edges でフローを保存', inputSchema: { type: 'object', properties: { name: { type: 'string' }, nodes: { type: 'array' }, edges: { type: 'array' } }, required: ['name', 'nodes', 'edges'] } },
  { name: 'list_workflows',     description: '保存済みフロー一覧', inputSchema: { type: 'object', properties: {} } },
  { name: 'run_workflow',       description: '保存済みフローを実行', inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' } }, required: ['id'] } },
  { name: 'gen_component',      description: '不足ツールを Python MCP サーバーとして生成', inputSchema: { type: 'object', properties: { what: { type: 'string' } }, required: ['what'] } },
  { name: 'get_checkpoint',     description: 'browser-control の承認待ちステップ取得', inputSchema: { type: 'object', properties: {} } },
  { name: 'resolve_checkpoint', description: 'browser ステップをモバイルから承認/拒否', inputSchema: { type: 'object', properties: { id: { type: 'string' }, allow: { type: 'boolean' } }, required: ['id', 'allow'] } },
];
// Wave B: 何が「使える」かの正直な要約。registered（agents/tools/workflows）＋組込（browser-control/prompt）。
// 生成済み道具は integration.generated で印。⚠️ client が繋ぐ MCP（claude.ai の Gmail 等）は MCP 仕様上ここから見えない＝note で明示。
function availableSummary() {
  const integs = readIntegrations().filter((it) => it.enabled !== false);
  return {
    agents: publicAgents().map((a) => ({ id: a.id, skill: a.skill })),
    tools: integs.flatMap((it) => (it.tools || []).map((t) => ({ id: `${it.id}.${t.name}`, name: t.name, ...(it.generated ? { generated: true } : {}) }))),
    workflows: readWorkflows().map((w) => ({ id: w.id, name: w.name })),
    builtin: [
      { id: 'agent:browser-control', kind: 'computer-use', note: 'API のないサービスを実ブラウザで操作（ログイン session 利用）。送信系は実行時に人が承認。' },
      { id: 'prompt', kind: 'llm', note: '組込 LLM ステップ（ツール不要）。' },
    ],
    note: 'あなたの MCP client が接続しているツール（例: claude.ai の Gmail）はここには出ません — MCP server は互いを見られない仕様です。使わせたい外部サービスは add_integration で登録、UI のみなら agent:browser-control に解決、無ければ gen_component で生成します。',
  };
}

// Wave B③: server.mjs と hub remote-MCP で同一の「実 plan」エントリ。HTTP /api/shenron/plan と mcpDispatch(plan_flow) の両方が呼ぶ。
async function planFlow({ goal, save, gap, context, cost }) {
  const agents = publicAgents().map((a) => ({ id: a.id, skill: a.skill }));
  const tools = readIntegrations().filter((it) => it.enabled !== false).flatMap((it) => (it.tools || []).map((t) => ({ id: `${it.id}.${t.name}`, name: t.name })));
  const workflows = readWorkflows().map((w) => ({ id: w.id, name: w.name }));
  const si = readIntegrations().find((it) => it.kind === 'search' && it.enabled !== false);   // Wave 2: 有効な search MCP が在れば gap を外部発見、無ければ内部のみ
  const search = si ? async (q) => {                                                          // fence: redact で goal の secret を外部に流さない＋egress を audit
    const fw = redact(String(q || ''), {});
    const r = await callMcpTool(si, si.searchTool || 'search', { query: fw.text }, { cwd: REPO_ROOT });
    trail('external-search', { integ: si.id, egress: true, removed: fw.removed });
    return r;
  } : null;
  const ir = await shenronPlan({ goal, agents, tools, workflows, vendor: EXEC_VENDOR || 'claude', search, context, gap, cost });
  if (ir.mode === 'clarify') return { ...ir, available: availableSummary(), ...renderPlan(ir) };   // discover: plan せず user に確認を返す（保存しない）
  const v = validateFlow(ir.nodes, ir.edges); layoutFlow(ir.nodes, v.edges);
  const saved = save ? saveWorkflow({ name: ir.plain_summary || ir.goal, nodes: ir.nodes, edges: v.edges }) : null;   // persist → cockpit 🗂 に出る
  const out = { ...ir, edges: v.edges, warnings: v.warnings, ...(saved ? { workflowId: saved.id } : {}), available: availableSummary() };
  return { ...out, ...renderPlan(out) };   // Wave A: Mermaid + ASCII 図 + plain 要約を同梱＝cockpit 無しで「これで実行？」確認できる

}

async function mcpDispatch(name, args) {
  if (name === 'plan_flow')          return planFlow({ goal: args.goal, save: args.save !== false, gap: args.gap, context: args.context, cost: args.cost });   // Wave B③: 在庫返しでなく実 plan（have/missing/図）に統一
  if (name === 'add_integration')    return saveIntegration({ id: args.id, label: args.label, kind: args.kind || 'mcp', command: args.command || '', url: args.url || '', enabled: args.enabled, tools: args.tools || [] });
  if (name === 'add_automation')     return saveAutomation({ name: args.name, trigger: args.trigger, workflow: args.workflow, input: args.input || '' });   // Wave: schedule/build-state 起点で workflow 自動実行（schedule は in-hub scheduler が hub 起動中に発火）
  if (name === 'save_workflow')      return saveWorkflow(args);
  if (name === 'list_workflows')     return readWorkflows().map((w) => ({ id: w.id, name: w.name, summary: w.summary || '', steps: (w.steps || []).length }));
  if (name === 'run_workflow')       return runFlow({ id: args.id, input: args.input || '' });
  if (name === 'gen_component') {
    const cached = matchComponent(readComponents(), args.what);
    if (cached) return { what: cached.what, iters: 0, converged: true, id: cached.id, approved: true, cached: true };
    const r = await genComponent({ what: args.what, vendor: EXEC_VENDOR || 'claude', maxIters: 3 });   // Wave C fix: remote-MCP も実生成（claude -p / API）。旧 'stub' は claude.ai 経由で必ず crash していた（実機 red-team で判明）
    const saved = r.converged ? saveComponent(r) : null;
    return saved ? { ...r, id: saved.id, approved: false } : r;
  }
  if (name === 'get_checkpoint')     return state.handoffs.filter((h) => h.checkpoint && h.checkpoint.decided === null).map((h) => ({ id: h.id, label: h.checkpoint.label, tool: h.checkpoint.tool, domain: h.checkpoint.domain }));
  if (name === 'resolve_checkpoint') return ref(args.allow ? approve(args.id) : decline(args.id));
  throw new Error(`unknown tool "${name}"`);
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };   // Wave C: CORS so claude.ai Artifacts (sandbox origin ≠ claude.ai) can fetch /api/runflow etc. OPTIONS preflight already handled. ponytail: '*' fits self-host/ngrok; gate act routes with bearer when public.
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (req.method === 'GET' && p === '/') {
    try { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(UI_FILE)); }
    catch { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>BuildHUD hub</h1><p>UI not installed yet (prototype/hub/ui.html). JSON API under /api/*.</p>'); }
  }
  if (req.method === 'GET' && p === '/api/state')
    return json(res, 200, { autorun: AUTORUN, agents: publicAgents(), handoffs: state.handoffs.map((h) => ({ ...ref(h), input: h.input, result: h.result, error: h.error, history: h.history, runId: h.runId || null, redacted: h.redacted || null, consensus: h.consensus || null, checkpoint: h.checkpoint || null })), runs: Object.values(state.runs).slice(-20).map((r) => ({ id: r.id, flowId: r.flowId, status: r.status, done: Object.keys(r.outputs).length, total: r.nodes.length, outputs: r.outputs, skipped: r.skipped || [], routerPick: r.routerPick || {} })), reputation: reputationFrom(state.audit, state.handoffs, Object.keys(state.agents)), scheduler: { on: SCHEDULER_ON, note: SCHEDULER_NOTE } });   // Wave R: reputation. + scheduler 状態（client が「スマホでは使えない」を表示できる）
  if (req.method === 'GET' && p === '/api/workflows') {
    const wid = u.searchParams.get('id');                                                 // ?id= → full flow (🗂 overview opens on click); else token-light counts
    if (wid) { const w = readWorkflows().find((w) => w.id === wid); return w ? json(res, 200, w) : json(res, 404, { error: `no workflow "${wid}"` }); }
    return json(res, 200, readWorkflows().map((w) => ({ id: w.id, name: w.name, nodes: (w.nodes || []).length, edges: (w.edges || []).length, steps: (w.steps || []).length })));
  }
  if (req.method === 'GET' && p === '/api/shenron/components') {                           // Wave 8: 生成部品の登録庫。?id= で full code、無しは token-light refs（pending は人ゲート待ち）
    const cid = u.searchParams.get('id');
    if (cid) { const c = readComponents().find((c) => c.id === cid); return c ? json(res, 200, c) : json(res, 404, { error: `no component "${cid}"` }); }
    return json(res, 200, readComponents().map((c) => ({ id: c.id, what: c.what, iters: c.iters, approved: c.approved, credentials: c.credentials || [], createdAt: c.createdAt })));   // credentials=BYO-credential 名のみ（値は持たない）→ panel の 🔑 バッジ
  }
  if (req.method === 'GET' && p === '/api/automations')
    return json(res, 200, readAutomations().map((m) => ({ id: m.id, name: m.name, trigger: m.trigger, workflow: m.workflow, enabled: m.enabled !== false })));
  if (req.method === 'GET' && p === '/api/integrations')         // connected MCP servers (Wave F.2)
    return json(res, 200, readIntegrations());
  if (req.method === 'GET' && p === '/api/integrations/search')  // clean-mcp token-light index: SMALL refs (id/label/kind/enabled/toolCount/tags)
    return json(res, 200, searchIntegrationsRefs(u.searchParams.get('q') || '', Number(u.searchParams.get('limit')) || 999));
  if (req.method === 'GET') { const im = p.match(/^\/api\/integrations\/([^/]+)$/);   // get ONE integration's full tool list on demand
    if (im) { const it = readIntegrations().find((x) => x.id === decodeURIComponent(im[1])); return it ? json(res, 200, it) : json(res, 404, { error: `no integration "${im[1]}"` }); } }
  if (req.method === 'GET' && p === '/api/audit')                // Wave H: tamper-evident trust trail + chain verification
    return json(res, 200, { entries: state.audit, verify: auditVerify(state.audit) });
  if (req.method === 'GET' && p === '/api/permissions') return json(res, 200, readPermissions());   // Wave 11b: browser-control allow/ask/deny ruleset (worker fetches to classify)
  if (req.method === 'GET' && p === '/api/receipt') {            // Wave ③: signed, offline-verifiable per-run Trust Receipt
    try { return json(res, 200, receiptFor(u.searchParams.get('runId'))); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (req.method === 'GET' && p === '/api/pubkey') {             // the hub's ed25519 public key as raw PEM — `curl .../api/pubkey > hub.pem`, pin it, verify receipts with NO hub
    res.writeHead(200, { 'content-type': 'application/x-pem-file' }); return res.end(HUB_KEY.publicKeyPem); }   // was JSON-wrapped: broke verify-receipt.mjs --pubkey (the pinned, stronger-than-TOFU path)
  if (req.method === 'GET' && p === '/api/buildstate')           // Wave J: the build-state IR vocabulary + match operators
    return json(res, 200, { events: BUILD_EVENTS, operators: Object.keys(MATCH_OPS) });
  if (req.method === 'GET' && p === '/api/capvocab')             // Wave B: the capability-passport vocabulary (drives the passport editor)
    return json(res, 200, CAP_VOCAB);
  if (req.method === 'GET' && p === '/api/mcp')                  // how to connect BuildHUD's MCP server (for "copy MCP call")
    return json(res, 200, { name: 'buildhud-mcp', command: 'node', args: [path.resolve(HERE, '..', 'mcp', 'server.mjs')], hub: `http://localhost:${PORT}`, tokenEnv: 'A2A_SHARED_TOKEN' });
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' }); return res.end(); }
  // OAuth 2.1 discovery + auto-approve authorize
  if (p === '/.well-known/oauth-protected-resource') { const b = reqBase(req); return json(res, 200, { resource: b, authorization_servers: [b] }); }
  if (p === '/.well-known/oauth-authorization-server') { const b = reqBase(req); return json(res, 200, { issuer: b, registration_endpoint: `${b}/oauth/register`, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }); }
  if (p === '/oauth/authorize') {  // auto-approve: generate code and redirect immediately
    const code = randomUUID().replace(/-/g, '');
    oauthCodes.set(code, { client_id: u.searchParams.get('client_id'), code_challenge: u.searchParams.get('code_challenge') });
    const loc = new URL(u.searchParams.get('redirect_uri') || 'http://localhost');
    loc.searchParams.set('code', code);
    if (u.searchParams.get('state')) loc.searchParams.set('state', u.searchParams.get('state'));
    res.writeHead(302, { location: loc.toString(), 'access-control-allow-origin': '*' }); return res.end();
  }
  if (p === '/mcp/sse') {  // Remote MCP: Claude.ai connects here
    if (!bearerOk(req)) { const b = reqBase(req); res.writeHead(401, { 'www-authenticate': `Bearer realm="${b}", resource_metadata="${b}/.well-known/oauth-protected-resource"`, 'access-control-allow-origin': '*' }); return res.end(); }
    const sid = randomUUID().slice(0, 8);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'access-control-allow-origin': '*' });
    res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sid}\n\n`);
    mcpSessions.set(sid, res);
    req.on('close', () => { mcpSessions.delete(sid); console.log(`[mcp] session ${sid} closed`); });
    console.log(`[mcp] session ${sid} connected (${mcpSessions.size} active)`);
    return;
  }
  if (req.method !== 'POST') { if (p.startsWith('/api/')) return json(res, 405, { error: 'use POST' }); res.writeHead(404); return res.end(); }

  let body = ''; req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let j = {}; try { if (body) { const ct = req.headers['content-type'] || ''; j = ct.includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body); } } catch { return json(res, 400, { error: 'bad json' }); }
    try {
      // Streamable HTTP MCP transport (POST /mcp or POST / — Claude.ai 2025 protocol)
      if (p === '/mcp' || (p === '/' && j.jsonrpc === '2.0')) {
        if (!bearerOk(req)) return json(res, 401, { error: 'unauthorized' });
        const { id, method, params } = j;
        if (method === 'initialize' || method === 'notifications/initialized') {
          return json(res, 200, method === 'initialize' ? { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shenron', version: '1.0' } } } : {});
        }
        if (method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
        if (method === 'tools/call') {
          mcpDispatch((params || {}).name, (params || {}).arguments || {})
            .then((r) => json(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] } }))
            .catch((e) => json(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }));
          return;
        }
        return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      }
      // OAuth POST endpoints
      if (p === '/oauth/register') { const client_id = randomUUID().replace(/-/g, ''); oauthClients.set(client_id, { name: j.client_name || 'client' }); return json(res, 201, { client_id, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }); }
      if (p === '/oauth/token') {
        if (j.grant_type !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
        const entry = oauthCodes.get(j.code);
        if (!entry) return json(res, 400, { error: 'invalid_grant' });
        if (entry.code_challenge && createHash('sha256').update(j.code_verifier || '').digest('base64url') !== entry.code_challenge) return json(res, 400, { error: 'invalid_grant' });
        oauthCodes.delete(j.code);
        const access_token = randomUUID().replace(/-/g, '');
        oauthTokens.add(access_token); console.log(`[oauth] token issued (${oauthTokens.size} active)`);
        return json(res, 200, { access_token, token_type: 'bearer', expires_in: 86400 * 365 });
      }
      if (p === '/mcp/messages') {  // Remote MCP: JSON-RPC 2.0 dispatch; response via SSE
        if (!bearerOk(req)) return json(res, 401, { error: 'unauthorized' });
        const sid = u.searchParams.get('sessionId');
        const sse = sid && mcpSessions.get(sid);
        const send = (obj) => { if (sse) sse.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`); };
        json(res, 202, {});  // ack immediately; real response goes over SSE
        const { id, method, params } = j;
        if (method === 'initialize' || method === 'notifications/initialized') {
          if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shenron', version: '1.0' } } });
        } else if (method === 'tools/list') {
          send({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
        } else if (method === 'tools/call') {
          mcpDispatch((params || {}).name, (params || {}).arguments || {})
            .then((r) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] } }))
            .catch((e) => send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }));
        } else {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
        }
        return;
      }
      // Wave C: act routes (mutating /api/* POST) require the same auth as /mcp/* — OAuth bearer or A2A_SHARED_TOKEN.
      // bearerOk is open when neither is configured (local dev). Reads (GET) stay open. /oauth/* and /mcp* handled above.
      if (p.startsWith('/api/') && !bearerOk(req)) return json(res, 401, { error: 'unauthorized', hint: 'Authorization: Bearer <A2A_SHARED_TOKEN or OAuth access token>' });
      if (p === '/api/handoffs') return json(res, 200, ref(create(j)));
      if (p === '/api/poll') return json(res, 200, { runnable: poll(j.agent) });
      if (p === '/api/audit') return json(res, 200, trail(j.type || 'note', j.detail || {}));   // Wave 11: out-of-process worker (browser-control) appends its per-action trail to the central audit (it can't call trail() in-process)
      if (p === '/api/permissions') { const rules = addAllowRule(readPermissions(), { tool: j.tool, domain: j.domain }); writePermissions(rules); trail('permission', { effect: 'allow', tool: j.tool || null, domain: j.domain || null, by: 'human' }); return json(res, 200, rules); }   // Wave 11b: 「常に許可」 — append an allow rule (audited)
      if (p === '/api/workflows') return json(res, 200, saveWorkflow(j));     // save wired DAG (nodes/edges + derived steps[])
      if (p === '/api/runflow') return json(res, 200, runFlow(j));            // topo-run a DAG (draft nodes/edges, or saved id)
      if (p === '/api/langflow/run') { langflowRun(state.audit, j).then((r) => { save(); json(res, 200, r); }).catch((e) => { save(); json(res, 400, { error: e.message }); }); return; }  // 🔗 delegate an exotic Langflow flow to /api/v1/run, fenced (audit appended → persist)
      if (p === '/api/langflow/import') { langflowImport(state.audit, j).then((r) => { save(); json(res, 200, r); }).catch((e) => { save(); json(res, 400, { error: e.message }); }); return; }  // ⤴ register a flow INTO Langflow (raw, verbatim) so /api/v1/run can run it
      if (p === '/api/automations') return json(res, 200, saveAutomation(j)); // save trigger + wired workflow as an automation
      if (p === '/api/fire') return json(res, 200, fireEvent(j.event || {}, j.input)); // build-state event → fire matching automations
      if (p === '/api/tick') { tickScheduler(); return json(res, 200, { ok: true, at: new Date().toISOString(), schedulerOn: SCHEDULER_ON }); }   // Wave: 無料外部 cron(Cloudflare/cron-job.org 等)が叩く seam＝now due な schedule automation を発火（hub が起きてる時のみ届く）
      if (p === '/api/fire/preview') return json(res, 200, firePreview(j.event || {})); // Wave 2: dry-run — what this event would fire (no run)
      if (p === '/api/autorun') return json(res, 200, setGlobalAutorun(j.on));         // global master autorun on/off
      if (p === '/api/integrations') return json(res, 200, saveIntegration(j));        // add/update an MCP server integration
      if (p === '/api/agents') return json(res, 200, createAgent(j));                  // create a (runnable, in-process) agent from a draft
      if (p === '/api/shenron/plan') {                                                 // 神龍 Wave 1: NL goal → plan IR（Wave B③: planFlow に集約＝remote-MCP と同一経路。have/missing は LLM-resolve §1.5-F、nodes/edges validate+layout、available も返す）
        planFlow({ goal: j.goal, save: j.save, gap: j.gap, context: j.context, cost: j.cost })       // Wave 5: context で対話修正／gap:'off'|'ask'|'auto' = 道具生成の枝／cost:'free'|'paid_ok'
          .then((r) => json(res, 200, r))
          .catch((e) => json(res, 400, { error: e.message }));
        return;
      }
      if (p === '/api/shenron/gen-component') {                                         // 神龍 Wave 4+8: gap "what" → 生成→使い捨てサンドボックス収束検証→登録庫。承認済みは再生成せず即返す（§H/§I）。
        const cached = matchComponent(readComponents(), j.what);                        // Wave 8: vetted 済みなら LLM+サンドボックスを skip（cache hit）
        if (cached) { trail('gen-component', { what: cached.what, cached: true, id: cached.id }); return json(res, 200, { what: cached.what, code: cached.code, iters: 0, converged: true, output: cached.output, id: cached.id, approved: true, cached: true }); }
        genComponent({ what: j.what, vendor: EXEC_VENDOR || 'claude', maxIters: j.maxIters || 3 })
          .then((r) => {
            const saved = r.converged ? saveComponent(r) : null;                       // 収束→pending(approved:false) で登録。承認後に再利用される（§H 人ゲート）
            trail('gen-component', { what: r.what, iters: r.iters, converged: r.converged, registered: saved ? saved.id : null });
            json(res, 200, saved ? { ...r, id: saved.id, approved: false } : r);
          })
          .catch((e) => json(res, 400, { error: e.message }));
        return;
      }
      if (p === '/api/shenron/components/approve') {                                  // Wave 9 人ゲート: 承認 → server.py 書出 + integration 登録 = ladder rejoin（生成部品が ladder 第1段に戻る・再生成不要・以降は実 mcp node として plan/run）
        const c = approveComponent(j.id);                                             // Wave 8: approved フラグ（gen-component cache の再利用ゲート）
        const GEN_DIR = path.join(HERE, '..', 'mcp', 'generated');                    // command は REPO_ROOT 相対 → runMcp が cwd:REPO_ROOT で spawn（echo と同形）
        fs.mkdirSync(GEN_DIR, { recursive: true }); fs.writeFileSync(path.join(GEN_DIR, c.id + '.py'), c.code);
        const credentials = c.credentials && c.credentials.length ? c.credentials : neededCredentials(c.code);   // BYO-credential allowlist（旧 component に未保存でも承認時に再 scan）
        const integ = saveIntegration({ id: c.id, label: c.what, kind: 'mcp', command: 'python3 prototype/mcp/generated/' + c.id + '.py', url: '', enabled: true, generated: true, credentials, tools: [{ name: 'run', accepts: ['*'], emits: ['*'] }] });
        trail('component-approve', { id: c.id, integration: integ.id, credentials });   // 名前のみ・値は出さない
        return json(res, 200, { ...c, integration: integ.id, credentials });
      }
      if (p === '/api/shenron/build') {                                                // 神龍 Wave 3: plan IR → Langflow flow JSON (importLangflowFlow の逆)。cockpit が importLangflowFlow(flow) で描画。
        try { const flow = toLangflowFlow(j.plan || j); trail('langflow-build', { nodes: flow.data.nodes.length, edges: flow.data.edges.length }); return json(res, 200, { flow }); }   // §5 Wave3 fence: audit 記録（実 Langflow 登録は既存 /api/langflow/import = Wave 6）
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (p === '/api/shenron/skill') {                                                // 神龍 Wave 7: 保存済み flow → Claude Code SKILL.md（run_workflow を呼ぶ薄ラッパ）。local agent に flow を skill 化。
        const wf = readWorkflows().find((w) => w.id === j.id); if (!wf) return json(res, 404, { error: `no workflow "${j.id}"` });
        const { slug, content } = flowSkill(wf);                                        // slug は [a-z0-9-] のみ＝下の join で path 外に出られない
        const dir = path.join(HERE, '..', '..', '.claude', 'skills', slug);            // repo-root .claude/skills = この project の skill
        fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'SKILL.md'); fs.writeFileSync(file, content);
        trail('flow-skill', { id: wf.id, slug });
        return json(res, 200, { slug, path: path.relative(process.cwd(), file), content });
      }
      if (p === '/api/trust/preview') return json(res, 200, trustPreview(j));   // Wave E1: dry-run the firewall + cap gates over a draft flow (read-only)
      let m;
      if ((m = p.match(/^\/api\/runs\/([^/]+)\/stop$/))) return json(res, 200, stopRun(m[1]));   // ⏹ stop an in-flight DAG run
      if ((m = p.match(/^\/api\/integrations\/([^/]+)\/toggle$/))) return json(res, 200, toggleIntegration(m[1], j.on));
      if ((m = p.match(/^\/api\/handoffs\/([^/]+)\/(approve|decline|result|checkpoint)$/)))
        return json(res, 200, m[2] === 'approve' ? ref(approve(m[1])) : m[2] === 'decline' ? ref(decline(m[1])) : m[2] === 'checkpoint' ? ref(checkpoint(m[1], j)) : ref(postResult(m[1], j)));
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/policy$/))) return json(res, 200, setPolicy(m[1], j));
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/autorun$/))) return json(res, 200, setAutorun(m[1], j.on)); // per-agent autorun on/off
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/passport$/))) return json(res, 200, setPassport(m[1], j));  // Wave H: edit capability passport
      return json(res, 404, { error: `unknown route ${p}` });
    } catch (e) { return json(res, 400, { error: e.message }); }
  });
});
server.on('error', (e) => { console.error(`[hub] cannot listen on ${PORT}: ${e.message} — pass --port <free>`); process.exit(1); });
server.listen(PORT, () => console.log(`[hub] BuildHUD durable handoff hub on http://localhost:${PORT}  (state: ${path.relative(process.cwd(), STATE_FILE)})`));
if (SCHEDULER_ON) { setTimeout(tickScheduler, 1500); setInterval(tickScheduler, 60000); console.log('⏰ [hub] scheduler on — fires schedule automations while this hub runs + catch-up on boot for misses during downtime (not for phone-only/ephemeral; SHENRON_NO_SCHEDULER=1 to disable)'); }   // Wave: boot tick = downtime の取りこぼしを起動時に追い発火。
else console.log('⏰ [hub] scheduler OFF (SHENRON_NO_SCHEDULER) — scheduled automations will NOT fire here');
