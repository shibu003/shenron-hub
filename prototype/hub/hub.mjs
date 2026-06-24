#!/usr/bin/env node
// hub.mjs — Shenron durable handoff hub (broker). Zero-dependency HTTP server.
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
import { setCredential, getCredential, listCredentials, deleteCredential } from './vault.mjs';
import { TOOLS, PROXY, forRemote, REMOTE_DENY } from '../mcp/tools.mjs';   // Wave U-1: tool defs single-sourced (shared with stdio server.mjs)
import { addMemory, listMemories, deleteMemory, relevantMemories } from './memory.mjs';
import { runDoctor } from './doctor.mjs';   // Wave N-3
import { register, verifyEmail, login, checkSession, logout, listUsers, userCount, resetRequest, resetPassword, getRole, setRole } from './auth.mjs';
import { plan as shenronPlan, toLangflowFlow, genComponent, genArtifactUi, flowSkill, componentKey, matchComponent, neededCredentials, renderPlan, evalExpect, goalStatus, visibleTo } from './shenron.mjs';
import { redact, applyPass, auditAppend, auditVerify, reputationFrom, buildReceipt, signReceipt, DEFAULT_PASSPORT, normalizePassport, sendMode, CAP_VOCAB } from '../trust.mjs';
import { readPermissions, writePermissions, addAllowRule } from '../permissions.mjs';   // Wave 11b: browser-control allow/ask/deny ruleset
import { MATCH_OPS, triggerMatches, cronMatch, lastDue } from '../match.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');           // spawn MCP servers from here so integrations.json can use repo-relative commands
const _SD = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : null;
const sp = (name, fallback) => _SD ? path.join(_SD, name) : fallback;  // ponytail: STATE_DIR → all state to one volume; unset → original layout
// Wave: 全設定を1か所に — shenron.config.json（STATE_DIR・gitignore）。⚠️ secret(API key) は置かない＝env/.dev.vars のみ。
// runner-side（provider の既定 model/host）は起動時に env へ流す（runner は env を読む）。hub-side の hot 設定
// （cost / routing / scheduler）は liveCfg() で都度ファイルを読む → set_config(MCP/NL) で再起動なしに即反映。env は ops 上書き。
const CFG_PATH = sp('shenron.config.json', path.join(HERE, 'shenron.config.json'));
const liveCfg = () => { try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { return {}; } };
const writeCfg = (obj) => fs.writeFileSync(CFG_PATH, JSON.stringify(obj, null, 2));
(function applyProvidersToEnv(c) {                                     // runner-side のみ env へ（変更は restart で反映）。env 優先。
  const set = (k, v) => { if (v != null && process.env[k] == null) process.env[k] = String(v); };
  const p = c.providers || {};
  set('OLLAMA_HOST', p.ollama && p.ollama.host); set('OLLAMA_MODEL', p.ollama && p.ollama.model);
  set('OPENAI_MODEL', p.openai && p.openai.model); set('ANTHROPIC_MODEL', p.anthropic && p.anthropic.model);
})(liveCfg());
const schedulerOn = () => process.env.SHENRON_NO_SCHEDULER == null && liveCfg().scheduler !== false;   // env hard-off > config(live)
const mergeCfg = (patch) => { const c = liveCfg(); const n = { ...c, ...patch, providers: { ...(c.providers || {}), ...(patch.providers || {}) }, routing: { ...(c.routing || {}), ...(patch.routing || {}) } }; delete n.providers.keyEnv; return n; };
function configStatus() {   // 1か所の設定 + 初期設定 hint（secret は値でなく在否のみ）
  const cfg = liveCfg(), env = process.env, needs = [];
  if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) needs.push('LLM: ローカル `claude -p`(サブスク・従量0) で動く。クラウド/別 provider なら ANTHROPIC_API_KEY か OPENAI_API_KEY を env に。');
  if (cfg.routing && cfg.routing.cheap && cfg.routing.cheap.vendor === 'ollama') needs.push('cheap=ollama: `ollama serve` 起動 + モデル pull（OLLAMA_MODEL）が必要。');
  needs.push('OpenClaw から繋ぐ: `~/.openclaw/openclaw.json` の mcp.servers に shenron を追加（stdio: `node prototype/mcp/server.mjs` / remote: `/mcp` を transport:"streamable-http"+auth:oauth）。skill は `clawhub skill install shenron`。');
  return { config: cfg, schedulerOn: schedulerOn(), keysPresent: { anthropic: !!env.ANTHROPIC_API_KEY, openai: !!env.OPENAI_API_KEY }, managed: managedMode(), needs };
}
const HUB_VERSION = '0.1.0';
const PORT = (() => { const i = process.argv.indexOf('--port'); return i > -1 ? Number(process.argv[i + 1]) : Number(process.env.PORT) || 8795; })();
const EXEC_VENDOR = (() => { const i = process.argv.indexOf('--vendor'); return i > -1 ? process.argv[i + 1] : null; })(); // force local-exec vendor (e.g. stub); null = each agent's own
let AUTORUN = !process.argv.includes('--no-autorun');     // global master: may the hub run LOCAL agents in-process (autorun)?
const autorunOn = (a) => AUTORUN && a.autorun !== false;  // per-agent autorun (default on) AND-ed with the global master; off → broker-only (waits for a worker)
const managedMode = () => !!process.env.SHENRON_MANAGED;  // managed hub: no local browser worker, no login credentials
const STATE_FILE = sp('inbox.json', path.join(HERE, 'inbox.json'));
const INDEX_FILE = path.join(HERE, 'index.html');   // Wave Cockpit-1: 玄関 launcher
const UI_FILE = path.join(HERE, 'ui.html');
const UI2_FILE = path.join(HERE, 'ui2.html');
const SETTINGS_FILE = path.join(HERE, 'settings.html');
const SHENRON_UI_FILE = path.join(HERE, 'shenron.html');
const MANIFEST_FILE = path.join(HERE, 'manifest.json');
const SW_FILE = path.join(HERE, 'sw.js');
const ONLINE_MS = 12000;                    // an agent is "online" if it polled within this window

const now = () => Date.now();
const runListeners = new Map();   // runId -> Set<res>  (SSE clients; memory only, lost on restart — run state itself is in inbox.json)
function emitRunEvent(runId, event) {
  const set = runListeners.get(runId); if (!set || !set.size) return;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of [...set]) { try { res.write(frame); } catch { set.delete(res); } }   // closed/broken socket → drop silently
}
function closeRunListeners(runId) {   // terminal: flush 'done' already emitted by caller, then end every stream + free the set
  const set = runListeners.get(runId); if (!set) return;
  for (const res of [...set]) { try { res.end(); } catch {} }
  runListeners.delete(runId);
}
const parseFmt = (p, inp) => String(p || '{input}').split('{input}').join(inp || '');   // Parser node: substitute {input} (pure string transform)
const WF_FILE = sp('workflows.json', path.join(HERE, '..', 'mcp', 'workflows.json'));   // shared workflow store (nodes/edges canonical + steps[] shim)
// Wave O2 — 同梱フローテンプレ（read-only）。templates/*.json を読み、ワンクリック install で saveWorkflow へ。
const TEMPLATES_DIR = path.join(HERE, '..', 'templates');
const readTemplates = () => { try { return fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { return []; } };
// install 前の正直な gap 検査: requires 未設定 credential ＋ mcp ノードが参照する未登録/無効 integration を warning に集約（値は出さない・名前のみ）。
function templateGaps(t) {
  const warnings = [];
  const haveCreds = new Set(listCredentials());
  for (const id of (t.requires || [])) if (!haveCreds.has(id)) warnings.push(`未設定の credential "${id}" — ⚙ 設定で登録するまで run 時にこのテンプレが使う外部ツールは失敗します`);
  const integs = readIntegrations();
  for (const n of (t.nodes || [])) if (n.kind === 'mcp' && n.server) { const it = integs.find((x) => x.id === n.server); if (!it) warnings.push(`integration "${n.server}" が未登録 — install はできますが run 時に gap になります（⚙ 設定で接続）`); else if (it.enabled === false) warnings.push(`integration "${n.server}" が無効 — ⚙ 設定で有効化するまで run 時に gap になります`); }
  return warnings;
}
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
const receiptFor = (runId) => { if (!runId || !state.runs[runId]) throw new Error(`no run "${runId}"`); return signReceipt(buildReceipt({ hub: { id: 'shenron-hub', publicKey: HUB_KEY.publicKeyPem }, runId, run: state.runs[runId], audit: state.audit, handoffs: state.handoffs, issuedAt: now() }), HUB_KEY.privateKey); };

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
  if (process.env.SHENRON_NO_AUTOSPAWN) return;          // tests drive their own worker
  if (managedMode()) return;                              // managed hub: no login profile → browser-control unavailable
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
  if (to === 'browser-control' && managedMode()) throw new Error('browser-control は managed hub では利用できません（ログイン session は本人マシン上の神龍が必要）。');
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
  const lc = agent(h.to).local; const vendor = h.vendor || EXEC_VENDOR || lc.vendor || 'stub';   // Wave G: per-node 明示 > 全体 EXEC_VENDOR > agent 既定
  if (h.skill !== lc.skillId) { running.delete(h.id); return void postResult(h.id, { error: `agent ${h.to} does not serve skill "${h.skill}"` }); }
  touch(h, 'running', 'hub'); save();
  console.log(`▶ [hub] running ${h.id} (${h.skill}) for ${h.to} — ${vendor}${h.model ? ' / ' + h.model : ''}`);
  runVendorAsync(vendor, `${lc.systemPrompt}\n\n--- INPUT ---\n${h.input}\n--- END INPUT ---`, lc.stub, { model: h.model })   // per-node model（未指定なら runner 既定）
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
function touchWorkflowRun(flowId) {
  const arr = readWorkflows(); const i = arr.findIndex((w) => w.id === flowId);
  if (i < 0) return; arr[i].lastRun = now(); fs.writeFileSync(WF_FILE, JSON.stringify(arr, null, 2));
}
function saveWorkflow({ id, name, summary, tags, nodes, edges, ui, owner, visibility }) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes[] + edges[] required');
  id = id || (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'flow-' + randomUUID().slice(0, 4);
  const steps = toposort(nodes, edges).filter((n) => n.agent && n.skill).map((n) => ({ agent: n.agent, skill: n.skill })); // derived shim
  const wf = { id, name: name || id, summary: summary || '', tags: tags || [], nodes, edges, steps, ...(ui != null ? { ui } : {}) };
  const arr = readWorkflows(); const i = arr.findIndex((w) => w.id === id);
  if (i >= 0) { arr[i] = { ...arr[i], ...wf }; }                                                // T-0 update: 既存 owner/visibility を保持（...wf に含めないので上書きされない）
  else { wf.owner = owner ?? null; wf.visibility = visibility || 'private'; arr.push(wf); }     // T-0 create 時のみ owner/visibility を刻む（owner=null=MCP/ハブ共有）
  fs.writeFileSync(WF_FILE, JSON.stringify(arr, null, 2));
  return wf;
}
function setVisibility(id, visibility) {   // T-0: share/unshare = visibility flip のみ（owner は不変）。レコード未存在は throw。
  const arr = readWorkflows(); const i = arr.findIndex((w) => w.id === id);
  if (i < 0) throw new Error(`no workflow "${id}"`);
  arr[i].visibility = visibility;
  fs.writeFileSync(WF_FILE, JSON.stringify(arr, null, 2));
  return { id, visibility };
}
// Wave A1 — 共有エージェント庫: visibility==='shared' のフロー + 承認済み部品を集約し、信頼を「実数字」で見せる
// （trust theater の代わり: maker=作成者 / adoptedBy=再利用数 / reliability=検証pass率 / drift=劣化件数）。
// workflows は visibility ゲート、components は approval ゲート（§I）— 2つの共有メカニズムを1つの庫に集約。
function listShared(kind) {
  const users = listUsers();                                                  // [{id,email}] — owner(uid)→email
  const emailOf = (uid) => uid ? (users.find((u) => u.id === uid)?.email || null) : null;
  const out = [];
  if (kind !== 'component') {                                                 // ── 共有フロー ──
    const wfs = readWorkflows(), autos = readAutomations();
    const checks = state.checkResults || [], drifts = state.driftAlerts || [];
    for (const wf of wfs.filter((w) => w.visibility === 'shared')) {
      const autoIds = autos.filter((a) => a.workflow === wf.id).map((a) => a.id);
      const subRefs = wfs.filter((w) => w.id !== wf.id && (w.nodes || []).some((n) => n.ref === wf.id)).length;
      const myChecks = checks.filter((r) => r.flowId === wf.id || autoIds.includes(r.automationId));
      const passed = myChecks.filter((r) => r.passed).length;
      const drift = myChecks.length ? drifts.filter((d) => autoIds.includes(d.automationId)).length : null;  // 検証履歴ゼロ=評価不能=null（UI で「—」）
      out.push({
        kind: 'workflow', id: wf.id, name: wf.name, summary: wf.summary || '',
        maker: emailOf(wf.owner),                                             // owner null（MCP/個人ハブ作成）= null = 「—」
        adoptedBy: subRefs + autoIds.length,                                  // 他フローの sub-flow 参照 + automation 束縛 = 採用実績
        reliability: myChecks.length ? { passed, total: myChecks.length, rate: Math.round((100 * passed) / myChecks.length) } : null,
        drift,
      });
    }
  }
  if (kind !== 'workflow') {                                                  // ── 承認済み部品（approval が共有ゲート: §I 人が承認するまで再利用しない）──
    for (const c of readComponents().filter((c) => c.approved)) {
      out.push({ kind: 'component', id: c.id, name: c.what || c.id, summary: c.what || '', maker: null, adoptedBy: 0, reliability: null, drift: null });
    }
  }
  return out;
}
// Wave Remix-1 — fork a saved flow into a NEW editable copy. The reuse-as-a-part half already works:
// a saved flow can be dropped into another flow as a sub-flow node (kind:'workflow' + node.ref → fireWorkflowNode).
// What was missing is forking — making a copy you can modify WITHOUT touching the original. install_template
// clones bundled templates the same way (saveWorkflow); this generalizes it to your OWN flows.
function cloneWorkflow(id, name) {
  const src = readWorkflows().find((w) => w.id === id);
  if (!src) throw new Error(`no workflow "${id}"`);
  const newId = `${src.id}-copy-${randomUUID().slice(0, 4)}`;   // explicit fresh id (random suffix) → never overwrites src or a prior clone
  return saveWorkflow({
    id: newId,
    name: name || `${src.name} (copy)`,
    summary: src.summary || '',
    tags: src.tags || [],
    nodes: structuredClone(src.nodes || []),   // deep copy → editing the fork never mutates the original (no shared refs)
    edges: structuredClone(src.edges || []),
    ...(src.ui != null ? { ui: src.ui } : {}),  // carry the attached artifact UI so the fork still renders
  });   // lastRun intentionally not copied (per-copy); automations bind by id in automations.json → fork starts unbound to any trigger
}
function runFlow({ id, nodes, edges, input, parent, fromAutomation }) {
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
  const run = (state.runs[runId] = { id: runId, flowId: id || null, parent: parent || null, depth, nodes, edges, input: input || '', outputs: {}, dead: [], skipped: [], routerPick: {}, status: 'running', createdAt: now(), fromAutomation: fromAutomation || null, check: null });   // Wave R-1: fromAutomation = which automation launched this (null = manual/sub-flow → outcome-check no-op); check = result of outcome-check
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
// Wave R-1 — 成果検証: run を起動した automation が expect を持てば、完了後に flowResult を突き合わせ、外れたら通知。
// 呼び出しは完了ブロック(advanceFrom:585)から setImmediate で run 毎1回だけ（completedAt ガード済み）。判定は shenron.evalExpect（純粋・実装済）。

// Wave R-3: 出力の構造シグネチャ（JSON object → ソート済みキー列 / array → 'arr' / scalar → 'scalar' / string → 'str'）
function structureSig(result) {
  try {
    const o = typeof result === 'string' ? JSON.parse(result) : result;
    if (o && typeof o === 'object' && !Array.isArray(o)) return 'obj:' + Object.keys(o).sort().join(',');
    if (Array.isArray(o)) return 'arr';
    return 'scalar';
  } catch { return 'str'; }
}

// Wave R-3: drift 検出 — 連続 fail / 出力構造の急変を run 完了即時に通知（tick 遅延なし）
function checkDrift(run, autoId, currentSig, currentPassed) {
  if (run.driftAlert) return;                                             // 冪等ガード（R-2 の run.check パターンと同型）
  const DRIFT_N = 3;
  const tail = (state.checkResults || []).filter((r) => r.automationId === autoId).slice(-DRIFT_N);
  const consecutiveFail = tail.length >= DRIFT_N && tail.every((r) => !r.passed);
  const prevSigs = tail.slice(0, -1).map((r) => r.sig).filter(Boolean);
  const structShift = prevSigs.length >= 2 && prevSigs.every((s) => s === prevSigs[0]) && currentSig && currentSig !== prevSigs[0];
  if (!consecutiveFail && !structShift) return;
  run.driftAlert = true;
  const kind = consecutiveFail ? 'consecutive_fail' : 'structure_shift';
  const alert = { id: randomUUID().slice(0, 8), automationId: autoId, runId: run.id, kind, at: new Date().toISOString() };
  (state.driftAlerts ||= []).push(alert);
  if (state.driftAlerts.length > 50) state.driftAlerts = state.driftAlerts.slice(-50);
  emitRunNotify(run, 'drift_detected');
  trail('drift-detected', { automationId: autoId, runId: run.id, kind });
}

async function checkOutcome(run) {
  try {
    if (run.check) return;                                                // 冪等の二重防御: setImmediate が万一二重 queue されても / 将来 boot replay を足しても run 毎1回だけ記録
    const auto = run.fromAutomation ? readAutomations().find((a) => a.id === run.fromAutomation) : null;
    const expect = auto && auto.expect;
    if (!expect || !expect.kind) { if (auto) goalAutoProgress(auto.id); return; }   // automation 無し → no-op。expect 無し automation は完了=成功でゴール +1（Goals-2.1: 後方互換）
    const route = tierRoute('cheap');                                     // judge は従量0 の cheap tier（assert は LLM 不使用）
    const result = flowResult(run);                                       // R-3: structureSig でも使うためキャッシュ
    const r = await evalExpect(expect, result, { vendor: route.vendor, model: route.model });
    const sig = structureSig(result);
    const rec = { runId: run.id, flowId: run.flowId || null, automationId: auto.id, kind: expect.kind, rule: expect.rule || '', passed: !!r.ok, reason: r.reason || '', sig, at: new Date().toISOString() };
    run.check = rec;
    (state.checkResults ||= []).push(rec);
    if (state.checkResults.length > 50) state.checkResults = state.checkResults.slice(-50);   // ring buffer（list_check_results 用）。run 毎の run.check は inbox.json に残る
    checkDrift(run, auto.id, sig, !!r.ok);                               // Wave R-3: 連続 fail / 構造急変を即時検出
    if (r.ok) goalAutoProgress(auto.id);                                 // Wave Goals-2.1: expect 有り → 成果検証 pass の run だけゴールを +1（fail run はカウントしない）
    if (!r.ok) {
      emitRunNotify(run, 'check_failed');
      if (expect.onFail === 'repair' && (run.repairCount || 0) < (expect.maxRetry ?? 1))
        setImmediate(() => repairRun(run));                                // Wave R-2: 非同期修復（advanceFrom を止めない）
    }
    trail('outcome-check', { runId: run.id, automation: auto.id, kind: expect.kind, passed: !!r.ok });   // trail は save() 込み＝run.check + checkResults もここで永続化（明示 save 不要）
  } catch (e) {
    trail('outcome-check', { runId: run.id, error: e.message }); console.error('[checkOutcome]', run.id, e.message);   // setImmediate は例外を握り潰す → 明示 trail + log
  }
}
// Wave R-2: 壊れた run の generated component を再生成 → approved:false でペンディング化
async function repairRun(run) {
  const comps = readComponents();
  const compId = run.nodes && run.nodes.map((n) => n.agent).filter(Boolean).find((id) => comps.some((c) => c.id === id));
  if (!compId) { trail('repair-skip', { runId: run.id, reason: 'no generated component in run' }); return; }
  const comp = comps.find((c) => c.id === compId);
  try {
    const r = await genComponent({ what: comp.what, vendor: EXEC_VENDOR || 'claude', maxIters: 3 });
    if (!r.converged) { trail('repair-fail', { runId: run.id, componentId: compId }); return; }
    const arr = readComponents(); const i = arr.findIndex((c) => c.id === compId);
    const updated = { ...(i >= 0 ? arr[i] : {}), ...r, id: compId, approved: false };   // 再生成後は人が approve_component するまで無効化
    if (i >= 0) arr[i] = updated; else arr.push(updated);
    writeComponents(arr);
    run.repairCount = (run.repairCount || 0) + 1;
    trail('repair-pending', { runId: run.id, componentId: compId });
    emitRunNotify(run, 'repair_pending');
  } catch (e) {
    trail('repair-error', { runId: run.id, componentId: compId, error: e.message });
    console.error('[repairRun]', run.id, e.message);
  }
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
  h.runId = run.id; h.node = node.id;
  const nv = node.vendor || (node.config && node.config.vendor); if (nv) h.vendor = nv;   // Wave G: per-node vendor on an agent node（flow で「この step は別 AI」）
  const nm = node.model || (node.config && node.config.model); if (nm) h.model = nm;      // per-node model（同上）
  save();
}
// Wave K — a prompt component is INTERNAL compute (an inline LLM template), not an external side-effect:
// it runs in-process via the vendor with NO approval fence (mirrors an auto agent). Reuses the run-handoff
// for cockpit visibility + crash-resume. `{input}` in the template is substituted with the upstream text.
// Wave G: per-step routing — tier(cheap/strong) → {vendor, model}。env で per-budget 上書き（お財布適応）。
// cheap を完全無料にしたい人: SHENRON_CHEAP_VENDOR=ollama（＋ ollama serve）→ cheap step は localhost で $0。
const tierRoute = (tier) => {
  const r = liveCfg().routing || {};   // live: set_config(MCP/NL) で即反映。env が ops 上書き。
  if (tier === 'cheap') { const vendor = process.env.SHENRON_CHEAP_VENDOR || (r.cheap && r.cheap.vendor) || null; return { vendor, model: process.env.SHENRON_MODEL_CHEAP || (r.cheap && r.cheap.model) || (vendor === 'ollama' ? (process.env.OLLAMA_MODEL || 'llama3.2') : 'claude-haiku-4-5') }; }
  if (tier === 'strong') return { vendor: process.env.SHENRON_STRONG_VENDOR || (r.strong && r.strong.vendor) || null, model: process.env.SHENRON_MODEL_STRONG || (r.strong && r.strong.model) || 'claude-opus-4-8' };
  return { vendor: null, model: undefined };
};
function firePromptNode(run, node, input, from) {
  const c = node.config || {};
  const h = { id: randomUUID().slice(0, 8), from: from || run.flowId || 'flow', to: 'prompt', skill: 'prompt',
    input: input || '', status: 'submitted', result: null, error: null, contextId: randomUUID(), createdAt: now(), updatedAt: now(),
    history: [], prompt: { template: c.template || '{input}', vendor: c.vendor, model: c.model, tier: c.tier }, runId: run.id, node: node.id };   // Wave G: per-node vendor/model/tier を持ち越す
  touch(h, 'approved', 'auto'); state.handoffs.push(h); save();
  runPrompt(h);
}
// Wave G: auto-escalation — cheap step が落ちた時だけ strong で1回再試行。お財布適応の背骨＝成功すれば安いまま、
// 失敗時だけ課金。発火条件は (a) tier=cheap で (b) node が vendor 明示してない（明示は尊重）で (c) off でない。
const escalateOn = (p) => p.tier === 'cheap' && !p.vendor && process.env.SHENRON_NO_ESCALATE !== '1' && (liveCfg().routing || {}).autoEscalate !== false;
async function runPrompt(h) {
  if (running.has(h.id)) return; running.add(h.id);
  try {
    const p = h.prompt || {};
    const route = tierRoute(p.tier);                                  // Wave G: tier→{vendor,model}（cheap は env で ollama に＝無料化可）
    const vendor = p.vendor || route.vendor || EXEC_VENDOR || 'stub'; // node 明示 > tier route > 全体 EXEC_VENDOR > stub
    const model = p.model || route.model;                             // node 明示 > tier route（未指定なら runner 既定）
    const tmpl = String(h.prompt.template || '{input}').split('{input}').join(h.input || '');
    const stub = `[prompt:stub] ${tmpl.slice(0, 120)}`;
    touch(h, 'running', 'hub'); save();
    console.log(`▶ [hub] prompt ${h.id}`);
    let result = await runVendorAsync(vendor, tmpl, stub, { model });
    // 失敗 sentinel = runner が必ず付ける `→ stub]` 接頭辞（成功テキストには出ない）。cheap が落ちたら strong に上げる。
    if (escalateOn(p) && result.startsWith('[') && result.includes('→ stub]')) {
      const s = tierRoute('strong'); const sv = s.vendor || EXEC_VENDOR || 'stub';
      if (sv !== vendor || s.model !== model) {                       // 同じ宛先に上げ直しても無意味なので差がある時だけ
        console.log(`⤴ [hub] prompt ${h.id} escalate cheap→strong (${vendor}→${sv})`);
        const r2 = await runVendorAsync(sv, tmpl, stub, { model: s.model });
        if (r2.startsWith('[') && r2.includes('→ stub]')) { /* strong も失敗 → cheap の理由を残す */ } else result = r2;
      }
    }
    postResult(h.id, { result }, 'hub');
  } catch (e) { postResult(h.id, { error: e.message }, 'hub'); }
  finally { running.delete(h.id); console.log(`✓ [hub] prompt ${h.id} done`); }
}
// Wave I — consensus: fan the SAME task to N vendors in parallel, then pick the medoid (output most similar
// to the others) and report an agreement score. A single vendor can't do this — it's the structural answer to
// "why Shenron and not Claude-native?". Internal compute → no approval fence; handoff-backed for visibility.
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
// 既定 vendors は cost 連動（お財布適応）: free=本人サブスク+ローカル($0)・paid_ok=多様な frontier も。node が明示してたら尊重。
const defaultConsensusVendors = () => (liveCfg().cost === 'paid_ok' ? 'claude,codex,gemini' : 'claude,codex,ollama');
// Wave G: auto-routing 提案の ctx — 実行時と同じ解決（tierRoute / defaultConsensusVendors / cost / escalate）を renderPlan に渡す＝提案が truthful。
const routingCtx = () => ({ cost: liveCfg().cost === 'paid_ok' ? 'paid_ok' : 'free', cheap: tierRoute('cheap'), strong: tierRoute('strong'),
  consensusVendors: defaultConsensusVendors(), autoEscalate: process.env.SHENRON_NO_ESCALATE !== '1' && (liveCfg().routing || {}).autoEscalate !== false });
function fireConsensusNode(run, node, input, from) {
  const vendors = String((node.config && node.config.vendors) || defaultConsensusVendors()).split(',').map((s) => s.trim()).filter(Boolean);
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
// Wave N1: 宣言済み credential 名のうち vault に在るものだけ {NAME: value} を返す（null は skip）。
// 注入は allowlist 名のみ・値は絶対に log/audit/AI context に出さない（trail は名前のみ・hub.mjs send 行参照）。
function credentialEnv(names) {
  const env = {};
  for (const n of names || []) { const v = getCredential(n); if (v != null) env[n] = v; }
  return env;
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
    const creds = integ.credentials || [];
    const out = await callMcpTool(integ, tool, { ...pf.args, input: fw.text }, { cwd: REPO_ROOT, ...(integ.generated ? { env: { ...safeEnv(creds), ...credentialEnv(creds) } } : {}) });   // Wave 9: 生成 server は untrusted → default-deny の env で spawn。BYO-credential は宣言名だけ ride through。Wave N1: vault 値を宣言名に注入（process.env を上書き）＝vault に入れた credential が初めて実行時に効く
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
  emitRunEvent(id, { type: 'done', status: 'cancelled' }); closeRunListeners(id);   // O1: tell live streams the run was stopped, then end them
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
  emitRunEvent(run.id, { type: 'node', node: nodeId, output: run.outputs[nodeId], status: run.status });   // O1: live push — outputs[nodeId] is always set before advanceFrom is called
  if (run.status === 'cancelled') { save(); return; }                                   // ⏹ stopped run: record the result but fire nothing downstream (never completes)
  run.dead ||= []; run.skipped ||= []; run.routerPick ||= {};                           // tolerate runs created before Wave E2
  const pick = run.routerPick[nodeId];                                                  // 'then'|'else' if nodeId is a router that decided
  for (const e of run.edges.filter((e) => e.source === nodeId)) {
    if (pick !== undefined && (e.branch || 'then') !== pick) { markDead(run, e); continue; }   // router: prune the branch not taken
    tryFire(run, e.target);
  }
  if (run.nodes.filter((n) => n.kind !== 'trigger').every((n) => (n.id in run.outputs) || run.skipped.includes(n.id)) && !run.completedAt) {
    run.completedAt = now();   // Wave R-1: exactly-once ガード。完了ブロックは 'cancelled' しか見ず、ネスト親の再入で emit/notify/SSE-event が二重発火しうる既存バグ→1センチネルで完了 side-effect も成果検証も run 毎1回に。
    run.status = 'completed'; console.log(`✓ [hub] flow run ${run.id} completed`); if (run.flowId) touchWorkflowRun(run.flowId); emitRunNotify(run, 'completed'); emitRunEvent(run.id, { type: 'done', status: 'completed' }); closeRunListeners(run.id);   // O1: SSE 購読者に done（completedAt ガードで一度だけ）
    setImmediate(() => checkOutcome(run));   // Wave R-1: 成果検証は同期 advanceFrom 再帰の外へ（judge は async）。冪等は上の completedAt が担保。Goals-2.1: ゴール current +1 も checkOutcome 内へ移設（expect pass を尊重）
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
const schedulerNote = () => schedulerOn()
  ? '⏰ fires only while this hub process is running (your Mac on, or a 24/7 cloud host). If you only use a phone with no always-on hub, it will NOT fire — use an external scheduler (e.g. Google Apps Script).'
  : '⚠️ in-hub scheduler is OFF — scheduled automations will NOT fire. Enable in config (scheduler:true) or use an external scheduler (Apps Script / cron).';
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
// Wave H: Push通知 — enabled kind:'notify' integration へ webhook POST。run 完了/キャンセルと Goals-2 の goal イベントが共有する 1 ループ。
function pushNotify(jsonBody, slackText) {   // Wave Goals-2: 通知ループを単一化（emitRunNotify / emitGoalNotify が共有）
  const notifiers = readIntegrations().filter((i) => i.enabled !== false && i.kind === 'notify' && i.url);
  if (!notifiers.length) return;
  for (const n of notifiers) {
    const payload = n.format === 'slack' ? { text: slackText } : jsonBody;
    fetch(n.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(n.token ? { authorization: `Bearer ${n.token}` } : {}) }, body: JSON.stringify(payload) })
      .catch((e) => console.error('[notify]', n.id, e.message));
  }
}
function emitRunNotify(run, status) {
  const label = run.flowId || run.id;
  pushNotify({ status, runId: run.id, flowId: run.flowId || null, label, at: new Date().toISOString() },
    `神龍 ${status === 'completed' ? '✅' : '⚠️'} *${label}* (${status})`);
}
// Wave Goals-2: ゴールの停滞/期限接近を notify integration に push（goalId/wish/pct のみ・値は無し）。status=goal_stalled|goal_deadline|goal_reached。
function emitGoalNotify(g, status) {
  pushNotify({ status, goalId: g.id, wish: g.wish, pct: goalPct(g), at: new Date().toISOString() },
    `神龍 🎯 *${g.wish}* (${status}${goalPct(g) != null ? ` ${goalPct(g)}%` : ''})`);
}
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
  const arr = readAutomations(); const i = arr.findIndex((a) => a.id === id);
  const m = { id, name: name || id, summary: summary || '', tags: tags || [], trigger, workflow: workflowId, input: input || '', enabled: enabled !== false, ...(i >= 0 && arr[i].expect ? { expect: arr[i].expect } : {}) };   // Wave R-1: canvas 再保存で setCheck の expect を消さない（既存を持ち越し）
  if (i >= 0) arr[i] = m; else arr.push(m);
  fs.writeFileSync(AUTO_FILE, JSON.stringify(arr, null, 2));
  return trigger.type === 'schedule' ? { ...m, note: schedulerNote() } : m;   // Wave: be honest about the "fires only while hub up" limit at creation time
}
// pause/resume a saved automation without deleting it — scheduler & fireEvent both honor enabled (read fresh, no restart). Mirrors toggleIntegration.
function toggleAutomation(id, on) { const arr = readAutomations(); const it = arr.find((x) => x.id === id); if (!it) throw new Error(`no automation "${id}"`); it.enabled = on !== false; fs.writeFileSync(AUTO_FILE, JSON.stringify(arr, null, 2)); return { id: it.id, name: it.name, enabled: it.enabled }; }
// Wave R-1: automation に成果検証(expect)を付与/解除。toggleAutomation と同型（read-modify-write・他フィールド保持）。
function setCheck(id, expect) {
  const arr = readAutomations(); const a = arr.find((x) => x.id === id); if (!a) throw new Error(`no automation "${id}"`);
  if (expect == null) delete a.expect;
  else { if (!['assert', 'judge'].includes(expect.kind)) throw new Error('expect.kind must be assert|judge'); a.expect = { kind: expect.kind, rule: expect.rule || '', onFail: 'notify', maxRetry: expect.maxRetry || 0 }; }   // R-1: onFail は notify 固定・maxRetry は R-2 用に保存のみ
  fs.writeFileSync(AUTO_FILE, JSON.stringify(arr, null, 2));
  return { id: a.id, expect: a.expect || null };
}
// Wave Goals-1 — 長期ゴール記憶（automations.json 同型の自己完結 store）。最小＝CRUD + 手動 checkin で進捗表示。
// metric 自動計測はしない（人が値を入れる）＝北極星①「ゴールを神龍に預ける」需要を測る Mom Test の台。
// tick 相乗りの停滞/締切通知(Goals-2)・停滞時の次の手提案(Goals-3)は肉付け。
const GOALS_FILE = sp('goals.json', path.join(HERE, '..', 'mcp', 'goals.json'));
const readGoals = () => { try { return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); } catch { return []; } };
const writeGoals = (arr) => fs.writeFileSync(GOALS_FILE, JSON.stringify(arr, null, 2));
const goalPct = (g) => { const t = Number(g.target), c = Number(g.current); return Number.isFinite(t) && t !== 0 && Number.isFinite(c) ? Math.round((c / t) * 100) : null; };   // pure: 進捗率（target 無し/0 は null）
const goalView = (g) => ({ ...g, pct: goalPct(g) });
function saveGoal({ id, wish, metric, target, current, unit, deadline, automationIds, status }) {
  const arr = readGoals(); const i = id ? arr.findIndex((g) => g.id === id) : -1; const prev = i >= 0 ? arr[i] : null;   // id 既知＝更新（未指定フィールドは保持）・新規＝wish 必須
  if (!prev && !wish) throw new Error('goal needs a wish');
  id = id || (wish || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32) || 'goal-' + randomUUID().slice(0, 4);
  const g = { id, wish: wish ?? prev?.wish ?? '', metric: metric ?? prev?.metric ?? '', target: target ?? prev?.target ?? null,
    current: current ?? prev?.current ?? 0, unit: unit ?? prev?.unit ?? '', deadline: deadline ?? prev?.deadline ?? null,
    automationIds: automationIds ?? prev?.automationIds ?? [], checkins: prev?.checkins ?? [], status: status ?? prev?.status ?? 'active',
    createdAt: prev?.createdAt ?? Date.now(), notified: prev?.notified ?? {} };   // Wave Goals-2: createdAt=停滞判定の基準（checkin 無しゴールの起点）/ notified=通知冪等フラグ
  if (i >= 0) arr[i] = g; else arr.push(g);
  writeGoals(arr); return goalView(g);
}
// Wave Goals-2: 停滞ゴールに進捗が入ったら active に戻し、停滞通知の冪等フラグをクリア（次に停滞したら再通知できる）。
const reactivateGoal = (g) => { if (g.status === 'stalled') { g.status = 'active'; if (g.notified) g.notified.stalled = null; } };
// Wave Goals-2.1: target 到達なら reached + 一度だけ達成を祝う通知（notified.reached で冪等）。goalCheckin / goalAutoProgress 共有。
function reachGoal(g) {
  if (g.target == null || !Number.isFinite(Number(g.target)) || Number(g.current) < Number(g.target)) return;
  g.status = 'reached';
  if (!(g.notified ||= {}).reached) { g.notified.reached = Date.now(); emitGoalNotify(g, 'goal_reached'); }
}
function goalCheckin(id, value, note) {
  const arr = readGoals(); const g = arr.find((x) => x.id === id); if (!g) throw new Error(`no goal "${id}"`);
  const v = Number(value); if (!Number.isFinite(v)) throw new Error('checkin value must be a number');
  (g.checkins ||= []).push({ ts: Date.now(), value: v, note: note || '' });
  g.current = v;                                                              // 手動 checkin の最新値が現在値
  reactivateGoal(g);                                                          // Wave Goals-2: 手動 checkin は停滞を解除
  reachGoal(g);                                                               // Wave Goals-2.1: 到達なら reached + 達成通知（冪等）
  writeGoals(arr); return goalView(g);
}
function deleteGoal(id) { const arr = readGoals(); const i = arr.findIndex((g) => g.id === id); if (i < 0) throw new Error(`no goal "${id}"`); arr.splice(i, 1); writeGoals(arr); return { id, deleted: true }; }
// Wave Goals-2 — bound automation の run が成功したら、それを束ねるゴールの current を +1（カウント式）。
// Goals-2.1: 呼び出しは checkOutcome から — expect 有り automation は pass した run だけ / expect 無しは完了でカウント。
function goalAutoProgress(autoId) {
  if (!autoId) return;
  const arr = readGoals(); let changed = false;
  for (const g of arr) {
    if (!Array.isArray(g.automationIds) || !g.automationIds.includes(autoId) || g.status === 'reached') continue;
    g.current = (Number(g.current) || 0) + 1;
    (g.checkins ||= []).push({ ts: Date.now(), value: g.current, note: `auto: ${autoId}`, auto: true });
    reactivateGoal(g);
    reachGoal(g);                                                            // Wave Goals-2.1: 到達なら reached + 達成通知（冪等）
    changed = true; trail('goal-auto-progress', { goal: g.id, automation: autoId, current: g.current });   // trail は save() 込み（ただし goals.json は別 store → 明示 writeGoals 要）
  }
  if (changed) writeGoals(arr);
}
// Wave Goals-2 — tick 相乗り: active ゴールの期限接近/停滞を検出し、一度だけ通知（notified フラグで冪等）。
function checkGoals() {
  const now = Date.now(); const arr = readGoals(); let changed = false;
  for (const g of arr) {
    if (g.status !== 'active') continue;
    const s = goalStatus(g, now); g.notified ||= {};
    if (s.deadlineNear && !g.notified.deadline) { g.notified.deadline = now; emitGoalNotify(g, 'goal_deadline'); changed = true; trail('goal-deadline', { goal: g.id, deadline: g.deadline }); }
    if (s.stalled && !g.notified.stalled) { g.status = 'stalled'; g.notified.stalled = now; emitGoalNotify(g, 'goal_stalled'); changed = true; trail('goal-stalled', { goal: g.id }); setImmediate(() => goalSuggest(g.id).catch((e) => console.error('[goal-suggest]', g.id, e.message))); }   // Wave Goals-3: 停滞→次の手を自動提案（非同期・writeGoals 後に走る）
  }
  if (changed) writeGoals(arr);
}

// Wave Ambient-1 — 観察→提案（自分データのみ・外部受信箱は読まない）。
// suggestions.json に { id, kind, reason, evidence, workflowId?, status } を積む。
const SUGG_FILE = sp('suggestions.json', path.join(HERE, '..', 'mcp', 'suggestions.json'));
const readSuggestions = () => { try { return JSON.parse(fs.readFileSync(SUGG_FILE, 'utf8')); } catch { return []; } };
const writeSuggestions = (arr) => fs.writeFileSync(SUGG_FILE, JSON.stringify(arr, null, 2));
function dismissSuggestion(id) {
  const arr = readSuggestions(); const s = arr.find((x) => x.id === id); if (!s) throw new Error(`no suggestion "${id}"`);
  s.status = 'dismissed'; writeSuggestions(arr); return { id, status: 'dismissed' };
}
// Wave Goals-3 — 「次の手」提案プロンプト（goalSuggest の preview と applySuggestion の実体化で共有）。
function goalSuggestPrompt(g) {
  const u = g.unit || '';
  const cur = `${g.current ?? 0}${u}${g.target != null ? ` / ${g.target}${u}` : ''}`;
  return `${g.wish}（現状 ${cur}${g.deadline ? `・期限 ${g.deadline}` : ''}・停滞中）。このゴール達成に向けた具体的な次の一手を flow で提案して。`;
}
async function applySuggestion(id) {
  const arr = readSuggestions(); const s = arr.find((x) => x.id === id); if (!s) throw new Error(`no suggestion "${id}"`);
  s.status = 'applied';
  if (s.kind === 'automate' && s.workflowId) {
    const cron = '0 9 * * *';   // ponytail: 既定 daily 9am — 使う前に edit できる
    saveAutomation({ name: `定期化: ${s.reason.slice(0, 40)}`, trigger: { type: 'schedule', when: cron }, workflow: s.workflowId, input: '' });
  }
  if (s.kind === 'goal' && s.goalId && !s.workflowId) {                        // Wave Goals-3.1: 「次の手」提案を採用 → save:false で捨てた flow を save:true で実体化（採用時だけ生成＝遅延）
    const g = readGoals().find((x) => x.id === s.goalId);
    if (g) { const plan = await planFlow({ goal: goalSuggestPrompt(g), save: true }); s.workflowId = plan.workflowId || null; }   // clarify 等で workflow が出ない場合は null（apply 自体は成功）
  }
  writeSuggestions(arr); return { id, status: 'applied', applied: s };
}
// Wave Goals-3 — 停滞ゴールの「次の手」を planFlow で提案（save しない＝従量0・本人サブスク）。
// 既存 discover-first を再利用＝能動 concierge。停滞検出 tick から自動呼び＋ goal_suggest MCP でオンデマンドも可。
// suggestions.json に kind:'goal' を冪等 push（同 goalId の open が無ければ）＝受信箱に先回りで出す。
async function goalSuggest(id) {
  const g = readGoals().find((x) => x.id === id); if (!g) throw new Error(`no goal "${id}"`);
  const plan = await planFlow({ goal: goalSuggestPrompt(g), save: false });           // 提案のみ・保存しない（採用＝apply_suggestion で save:true 実体化）
  const summary = plan.plain_summary || plan.summary_text || plan.goal || '';
  const arr = readSuggestions();
  if (!arr.some((s) => s.status === 'open' && s.goalId === g.id)) {                    // 同 goal の open 提案が無ければ push（冪等）
    arr.push({ id: randomUUID().slice(0, 8), kind: 'goal', reason: `「${g.wish}」が停滞しています。次の一手: ${summary}`.slice(0, 280), evidence: [], goalId: g.id, status: 'open' });
    if (arr.length > 100) arr.splice(0, arr.length - 100);
    writeSuggestions(arr); trail('goal-suggest', { goal: g.id, nodes: (plan.nodes || []).length });
  }
  return { ...plan, goalId: g.id };   // goalId は distinct キー（plan.goal=元プロンプトと衝突させない）
}

// detectSuggestions — state.runs と state.audit を観察して提案を生成する。
// - kind:'automate': 同じ workflow を手動で REPEAT_THRESHOLD 回以上 fire している → 定期化を提案
// - kind:'fix': 同じ flow が FAIL_THRESHOLD 回連続 fail している → 調査/set_check を提案
// 提案は冪等（同じ workflowId/flowId の open 提案が既存なら追加しない）。cap=100。
function detectSuggestions() {
  const REPEAT_THRESHOLD = 3;   // 同 flow を手動でこれ以上 fire → 定期化提案
  const FAIL_THRESHOLD   = 3;   // 同 automation の連続 fail がこれ以上 → fix 提案
  const arr = readSuggestions();
  const openKeys = new Set(arr.filter((s) => s.status === 'open').map((s) => s.workflowId || s.automationId));
  let changed = false;

  // automate: 同 flowId の手動完了 run が REPEAT_THRESHOLD 回以上
  const runsByFlow = {};
  for (const r of Object.values(state.runs)) {
    if (r.status !== 'completed' || !r.flowId || r.fromAutomation) continue;   // 自動起動 run は除外
    (runsByFlow[r.flowId] ||= []).push(r);
  }
  for (const [flowId, runs] of Object.entries(runsByFlow)) {
    if (runs.length < REPEAT_THRESHOLD || openKeys.has(flowId)) continue;
    const wf = readWorkflows().find((w) => w.id === flowId);
    const name = wf ? (wf.name || flowId) : flowId;
    arr.push({ id: randomUUID().slice(0, 8), kind: 'automate', reason: `「${name}」を手動で ${runs.length} 回実行しています。定期自動化しませんか？`, evidence: runs.slice(-5).map((r) => r.id), workflowId: flowId, status: 'open' });
    openKeys.add(flowId); changed = true;
  }

  // fix: 同 automationId の checkResults が末尾 FAIL_THRESHOLD 件連続 fail
  const results = state.checkResults || [];
  const byAuto = {};
  for (const r of results) if (r.automationId) (byAuto[r.automationId] ||= []).push(r);
  for (const [autoId, recs] of Object.entries(byAuto)) {
    const tail = recs.slice(-FAIL_THRESHOLD);
    if (tail.length < FAIL_THRESHOLD || tail.some((r) => r.passed) || openKeys.has(autoId)) continue;
    arr.push({ id: randomUUID().slice(0, 8), kind: 'fix', reason: `automation "${autoId}" の成果検証が ${FAIL_THRESHOLD} 回連続 fail しています。確認してください。`, evidence: tail.map((r) => r.runId), automationId: autoId, status: 'open' });
    openKeys.add(autoId); changed = true;
  }

  if (!changed) return;
  if (arr.length > 100) arr.splice(0, arr.length - 100);   // cap
  writeSuggestions(arr);
}

const matchingAutomations = (event) => readAutomations().filter((m) => m.enabled !== false && triggerMatches(m.trigger, event));
function fireEvent(event, input) {                          // build-state event → run every enabled automation whose trigger matches
  const matched = matchingAutomations(event);
  const fired = [];
  for (const m of matched) {
    try { fired.push({ automation: m.id, ...runFlow({ id: m.workflow, input: input ?? m.input ?? '', fromAutomation: m.id }) }); }   // Wave R-1: thread automation id → checkOutcome が expect を引ける
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
// Wave Login-1 — クレデンシャル生命管理: browser-control がログイン要求を検出した/通過した状態を domain ごとに永続。
// login_status MCP tool が読む＝無人 run でログインが切れていないか外から確認できる。値（user/pass）は一切持たない（検出のみ）。
const LOGIN_FILE = sp('login-state.json', path.join(HERE, 'login-state.json'));
const readLoginState = () => { try { return JSON.parse(fs.readFileSync(LOGIN_FILE, 'utf8')); } catch { return {}; } };
const writeLoginState = (s) => { try { fs.writeFileSync(LOGIN_FILE, JSON.stringify(s)); } catch { /* best-effort */ } };
function recordLogin(domain, resolved) {
  if (!domain) return readLoginState();
  const s = readLoginState(); const e = s[domain] || {};
  if (resolved) { e.lastOk = Date.now(); e.needsLogin = false; } else { e.lastDetected = Date.now(); e.needsLogin = true; }   // resolved=ログイン画面を抜けた（成功）/ false=ログイン要求を検出
  s[domain] = e; writeLoginState(s); return s;
}
// tick: 各 schedule automation の「直近 due」を見て、まだ発火してなければ発火（live も catch-up も同経路）。
// first-sight は baseline のみ（インストール前の履歴は back-fire しない）。downtime で過ぎた due は次の tick/boot で1回だけ追い発火（coalesced）。
function tickScheduler() {
  if (!schedulerOn()) return;   // live gate: config scheduler:false / env hard-off で発火しない（再起動不要）
  const now = new Date(); const st = readSchedState(); let changed = false;
  for (const m of readAutomations()) {
    if (m.enabled === false || !m.trigger || m.trigger.type !== 'schedule') continue;
    const expr = m.trigger.when || m.trigger.cron; if (!expr) continue;
    const due = lastDue(expr, now); if (due == null) continue;
    if (!(m.id in st)) { st[m.id] = due; changed = true; continue; }   // 初見=baseline（過去履歴を追い発火しない）
    if (st[m.id] >= due) continue;                                      // この due（以降）は処理済み → 重複/再発火しない
    st[m.id] = now.getTime(); changed = true;
    const catchUp = due < now.getTime() - 90000;                       // due が過去（>1.5分前）= downtime 後の追い発火
    try { trail('schedule-fire', { automation: m.id, when: expr, due: new Date(due).toISOString(), catchUp }); runFlow({ id: m.workflow, input: m.input || '', fromAutomation: m.id }); }   // Wave R-1: thread automation id → 定期 run も成果検証対象
    catch (e) { trail('schedule-fire', { automation: m.id, error: e.message }); }
  }
  if (changed) writeSchedState(st);
  detectSuggestions();   // Ambient-1: 自分 run/audit を観察して提案を生成（外部 IO なし）
  checkGoals();          // Wave Goals-2: active ゴールの期限接近/停滞を検出して通知（外部 IO なし・notify push は best-effort）
}

// ---------- Ghost Writer (Wave L): NL → a validated, laid-out flow. Generation ≠ execution — the human
// reviews on the canvas and Run keeps the approval fence. Uses the agent index + connected MCP tools + the
// component kinds. A real vendor (claude/codex) generates the flow JSON; otherwise a deterministic heuristic
// builds one from the index so it works offline/stub. Every edge is typed-port validated (bad ones dropped). ----------
function createAgent({ name, skill, systemPrompt, accepts, emits, stub, vendor, model, company }) {
  if (!name) throw new Error('name required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('name must be lowercase [a-z0-9-] (used as the MCP tool id agent_<name>)');   // P-2: name は agent_<name> tool id になる → 安全な文字に限定
  const a = agent(name); a.skill = skill || a.skill || 'task'; a.company = company || a.company || null;
  a.accepts = Array.isArray(accepts) ? accepts : (a.accepts || ['*']); a.emits = Array.isArray(emits) ? emits : (a.emits || ['*']);
  a.local = { skillId: a.skill, vendor: vendor || 'stub', systemPrompt: systemPrompt || '', stub: stub || '', ...(model ? { model } : {}) };   // runnable in-process
  a.autorun = true; save(); return publicAgents().find((x) => x.id === name);
}
// P-1: エージェント定義を削除（state から消して save）。進行中の run/handoff は触らない＝新規受付を止めるだけの非破壊削除。
function removeAgent(name) {
  if (!state.agents[name]) throw new Error(`no agent "${name}"`);
  if (!state.agents[name].local) throw new Error(`agent "${name}" is not a local agent (cannot delete remote/preseeded)`);
  delete state.agents[name]; save(); trail('agent-delete', { name });
  return { name, deleted: true };
}
// P-2: 作ったエージェントを「すぐ使える MCP tool」に — local agent を同期実行して結果を返す純経路。
async function runAgentSync(name, input) {
  const a = state.agents[name];
  if (!a || !a.local) throw new Error(`no local agent "${name}"`);
  const lc = a.local; const vendor = EXEC_VENDOR || lc.vendor || 'stub';
  const mem = relevantMemories(input || '', 3);   // Wave S: セッション横断メモリをグローバル注入（該当無しなら空配列＝プロンプト不変）
  const memBlock = mem.length ? `関連する記憶:\n${mem.map((r) => `- ${r.text}`).join('\n')}\n\n` : '';
  const prompt = `${memBlock}${lc.systemPrompt}\n\n--- INPUT ---\n${input || ''}\n--- END INPUT ---`;   // Wave S: memBlock を systemPrompt の前に前置
  const result = await runVendorAsync(vendor, prompt, lc.stub, { model: lc.model });
  trail('agent-run', { agent: name, vendor, bytes: (result || '').length });
  return { agent: name, vendor, result };
}
// P-2: 各 local agent を agent_<name> という MCP tool として動的に露出（create_agent 直後に client の tools/list に出る）。
const agentTools = () => Object.values(state.agents).filter((a) => a.local).map((a) => ({
  name: `agent_${a.id}`,
  description: `エージェント「${a.id}」を実行${a.skill && a.skill !== 'task' ? `（skill: ${a.skill}）` : ''}。create_agent で作成された local agent。input にタスク内容を渡す。`,
  inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'エージェントへの入力（タスク内容）' } }, required: ['input'] },
}));
// P-3: local agent を hub 非依存の standalone stdio MCP server（Python・stdlib のみ）として書出 →
// ユーザーが任意の MCP client（claude.ai / Claude Code）に登録できるポータブル成果物。systemPrompt を埋め込み、
// run(input) tool 1本を出す。実行は `claude -p`（既定）にプロンプトを渡す = ユーザー自身のサブスクで動く（従量0 維持）。
function exportAgentMcp(name) {
  const a = state.agents[name];
  if (!a || !a.local) throw new Error(`no local agent "${name}"`);
  const GEN_DIR = path.join(HERE, '..', 'mcp', 'generated');
  fs.mkdirSync(GEN_DIR, { recursive: true });
  const file = path.join(GEN_DIR, `${name}-agent.py`);
  const sp = JSON.stringify(a.local.systemPrompt || '');   // Python str literal として安全に埋込（JSON は Python literal の部分集合）
  const code = `#!/usr/bin/env python3
# Standalone MCP server for agent "${name}" — exported by 神龍 (shenron). Depends on NOTHING but stdlib + the
# \`claude\` CLI on PATH (your own subscription → $0 marginal). Register this file as a stdio MCP server.
import sys, json, subprocess
SYSTEM_PROMPT = ${sp}
TOOLS = [{"name": "run", "description": "Run the ${name} agent on an input.",
          "inputSchema": {"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"]}}]
def run_agent(text):
    prompt = SYSTEM_PROMPT + "\\n\\n--- INPUT ---\\n" + (text or "") + "\\n--- END INPUT ---"
    try:
        out = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=180)
        return out.stdout.strip() or out.stderr.strip()
    except FileNotFoundError:
        return "error: 'claude' CLI not found on PATH"
    except subprocess.TimeoutExpired:
        return "error: agent timed out"
def send(o): sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    m = json.loads(line); mid, method, params = m.get("id"), m.get("method"), m.get("params") or {}
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "${name}-agent", "version": "1.0"}}})
    elif method == "notifications/initialized": pass
    elif method == "tools/list": send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        res = run_agent((params.get("arguments") or {}).get("input", ""))
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": res}]}})
    else:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found: " + str(method)}})
`;
  fs.writeFileSync(file, code, { mode: 0o755 });
  trail('agent-export-mcp', { name, path: path.relative(REPO_ROOT, file) });
  return { name, path: path.relative(REPO_ROOT, file),
    registerHint: `任意の MCP client に stdio server として登録: command="python3", args=["${path.relative(REPO_ROOT, file)}"]。'claude' CLI が PATH に必要（あなたのサブスクで動く）。` };
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
    kept.push({ id: e.id || 'e' + kept.length, source: e.source, target: e.target, ...(e.share ? { share: e.share } : {}), ...(e.branch ? { branch: e.branch } : {}) });   // keep router then/else branch labels (else a router fires both branches)
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
const cookieSession = (req) => { const c = req.headers['cookie'] || ''; const m = c.match(/shenron_session=([^;]+)/); return m ? m[1] : null; };
const sessionUid = (req) => checkSession(cookieSession(req))?.userId ?? null;   // T-0: Web UI cookie → seat userId（無ければ null = MCP 運用者/開放ハブ = 全可視）
// open flag: true until A2A_SHARED_TOKEN is set OR OAuth token issued — user registration alone does NOT close it.
// MCP stdio (server.mjs) and browser-worker use A2A_SHARED_TOKEN; cookie sessions are for Web UI only.
const openDev = !SHARED_TOKEN; // ponytail: evaluated once at startup; set A2A_SHARED_TOKEN to enforce
const bearerOk = (req) => {
  const t = (req.headers['authorization'] || '').replace(/^Bearer /i, '').trim();
  if ((SHARED_TOKEN && t === SHARED_TOKEN) || oauthTokens.has(t)) return true;
  if (checkSession(cookieSession(req))) return true;        // Web UI session cookie
  return openDev && !oauthTokens.size;                     // open only when no token-based auth is configured
};
// B1: admin gate。openDev(個人/開放ハブ)と MCP 運用者(SHARED_TOKEN/oauth)は admin＝後方互換。閉じた multi-seat の Web UI member だけが弾かれる。
const isAdmin = (req) => {
  if (openDev) return true;
  const t = (req.headers['authorization'] || '').replace(/^Bearer /i, '').trim();
  if ((SHARED_TOKEN && t === SHARED_TOKEN) || oauthTokens.has(t)) return true;
  const s = checkSession(cookieSession(req));
  return s ? getRole(s.userId) === 'admin' : false;
};

// ---------- Remote MCP (HTTP/SSE transport — Claude.ai mobile connects here, no API key needed) ----------
const mcpSessions = new Map(); // sessionId → SSE res
const REMOTE_TOOLS = TOOLS.filter(forRemote);   // Wave U-1: defs single-sourced in ../mcp/tools.mjs; remote surface = forRemote filter
// Wave U-1: pure /api-proxy tools loop back to the hub's own routes (route = single truth, no re-impl).
// ponytail: loopback self-call — tiny loopback cost; upgrade to direct fn calls only if it shows on a profile.
async function proxySelf(name, args) {
  const r = PROXY[name](args);
  const headers = { 'content-type': 'application/json', ...(SHARED_TOKEN ? { authorization: `Bearer ${SHARED_TOKEN}` } : {}) };
  const resp = await fetch(`http://localhost:${PORT}${r.path}`, { method: r.method, headers, body: r.method === 'GET' ? undefined : JSON.stringify(r.body || {}) });
  const text = await resp.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  if (!resp.ok) throw new Error(j && j.error ? j.error : `hub ${r.path} → ${resp.status}`);
  return j;
}
// Wave B: 何が「使える」かの正直な要約。registered（agents/tools/workflows）＋組込（browser-control/prompt）。
// 生成済み道具は integration.generated で印。⚠️ client が繋ぐ MCP（claude.ai の Gmail 等）は MCP 仕様上ここから見えない＝note で明示。
function availableSummary() {
  const integs = readIntegrations().filter((it) => it.enabled !== false);
  return {
    agents: publicAgents().map((a) => ({ id: a.id, skill: a.skill })),
    tools: integs.flatMap((it) => (it.tools || []).map((t) => ({ id: `${it.id}.${t.name}`, name: t.name, ...(it.generated ? { generated: true } : {}) }))),
    workflows: readWorkflows().map((w) => ({ id: w.id, name: w.name })),
    builtin: [
      managedMode()
        ? { id: 'agent:browser-control', kind: 'computer-use', unavailable: true, note: 'managed hub では利用不可（ログイン session 無し）。ローカル神龍または常駐箱で使えます。' }
        : { id: 'agent:browser-control', kind: 'computer-use', note: 'API のないサービスを実ブラウザで操作（ログイン session 利用）。送信系は実行時に人が承認。' },
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
  const ir = await shenronPlan({ goal, agents, tools, workflows, vendor: EXEC_VENDOR || 'claude', search, context, gap, cost: cost || (liveCfg().cost === 'paid_ok' ? 'paid_ok' : 'free') });   // cost 未指定なら config の既定（live）
  if (ir.mode === 'clarify') return { ...ir, available: availableSummary(), ...renderPlan(ir) };   // discover: plan せず user に確認を返す（保存しない）
  const v = validateFlow(ir.nodes, ir.edges); layoutFlow(ir.nodes, v.edges);
  const saved = save ? saveWorkflow({ name: ir.plain_summary || ir.goal, nodes: ir.nodes, edges: v.edges }) : null;   // persist → cockpit 🗂 に出る
  const out = { ...ir, edges: v.edges, warnings: v.warnings, ...(saved ? { workflowId: saved.id } : {}), available: availableSummary() };
  return { ...out, ...renderPlan(out, routingCtx()) };   // Wave A: 図+要約／Wave G: + auto-routing 提案（各 step の宛先 vendor/model/cost）＝cockpit 無しで「これで実行？」確認できる

}

async function mcpDispatch(name, args) {
  if (REMOTE_DENY.has(name)) throw new Error(`tool "${name}" is not available on the remote surface`);   // Wave U-1: REMOTE_DENY は advertise を絞るだけでなく dispatch も塞ぐ（hidden ≠ blocked・remote 専用経路 = ここで一括拒否）
  if (name === 'plan_flow')          return planFlow({ goal: args.goal, save: args.save !== false, gap: args.gap, context: args.context, cost: args.cost });   // Wave B③: 在庫返しでなく実 plan（have/missing/図）に統一
  if (name === 'add_integration')    return saveIntegration({ id: args.id, label: args.label, kind: args.kind || 'mcp', command: args.command || '', url: args.url || '', enabled: args.enabled, tools: args.tools || [] });
  if (name === 'add_automation')     return saveAutomation({ name: args.name, trigger: args.trigger, workflow: args.workflow, input: args.input || '' });   // Wave: schedule/build-state 起点で workflow 自動実行（schedule は in-hub scheduler が hub 起動中に発火）
  if (name === 'hub_health')         return { ok: true, uptime: Math.round(process.uptime()), scheduler: schedulerOn(), version: HUB_VERSION };
  if (name === 'get_config')         return configStatus();
  if (name === 'set_config')         { writeCfg(mergeCfg(args || {})); trail('config-set', { keys: Object.keys(args || {}) }); return configStatus(); }   // 即反映（liveCfg）
  if (name === 'save_workflow')      return saveWorkflow(args);
  if (name === 'clone_workflow')     return cloneWorkflow(args.id, args.name);   // Wave Remix-1: fork a saved flow → new editable copy
  if (name === 'share_workflow')     return setVisibility(args.id, 'shared');    // T-0: 庫に publish（visibility flip・owner 不変）
  if (name === 'unshare_workflow')   return setVisibility(args.id, 'private');   // T-0: 庫から下げる
  if (name === 'list_workflows')     return readWorkflows().map((w) => ({ id: w.id, name: w.name, summary: w.summary || '', steps: (w.steps || []).length, lastRun: w.lastRun || null }));
  if (name === 'list_templates')     return readTemplates().map((t) => ({ id: t.id, name: t.name, summary: t.summary || '', requires: t.requires || [], nodes: (t.nodes || []).length, warnings: templateGaps(t) }));
  if (name === 'install_template')   { const t = readTemplates().find((x) => x.id === args.id); if (!t) throw new Error(`no template "${args.id}"`); const wf = saveWorkflow({ id: t.id, name: t.name, summary: t.summary || '', nodes: t.nodes, edges: t.edges }); const warnings = templateGaps(t); trail('template-install', { id: t.id, workflow: wf.id, gaps: warnings.length }); return { workflowId: wf.id, name: wf.name, requires: t.requires || [], warnings }; }
  if (name === 'run_workflow')       return runFlow({ id: args.id, input: args.input || '' });
  if (name === 'run_automation') {   // Wave U-2: remote 露出（confirm ゲートなし＝ツール呼び出し自体がユーザーの明示操作）
    const m = readAutomations().find((x) => x.id === args.id);
    if (!m) throw new Error(`no automation "${args.id}"`);
    if (m.enabled === false) throw new Error(`automation "${m.id}" is disabled`);
    return runFlow({ id: m.workflow, input: args.input ?? m.input ?? '', fromAutomation: m.id });
  }
  if (name === 'fire_event')         return fireEvent(args.event || {}, args.input);   // Wave U-2: remote 露出（既存 fireEvent 直呼び）
  if (name === 'gen_component') {
    const cached = matchComponent(readComponents(), args.what);
    if (cached) return { what: cached.what, iters: 0, converged: true, id: cached.id, approved: true, cached: true };
    const r = await genComponent({ what: args.what, vendor: EXEC_VENDOR || 'claude', maxIters: 3 });   // Wave C fix: remote-MCP も実生成（claude -p / API）。旧 'stub' は claude.ai 経由で必ず crash していた（実機 red-team で判明）
    const saved = r.converged ? saveComponent(r) : null;
    return saved ? { ...r, id: saved.id, approved: false } : r;
  }
  if (name === 'gen_artifact_ui')    return genArtifactUi({ what: args.what, vendor: EXEC_VENDOR || 'claude' });
  if (name === 'create_agent')       return createAgent({ name: args.name, systemPrompt: args.instructions, vendor: args.vendor, model: args.model });   // P-1: 作成 → 直後に agent_<name> が tools/list に出る
  if (name === 'run_agent')          return runAgentSync(args.name, args.input);                 // P-2
  if (name === 'delete_agent')       return removeAgent(args.name);                              // P-1
  if (name === 'export_agent_mcp')   return exportAgentMcp(args.name);                           // P-3
  if (name.startsWith('agent_'))     return runAgentSync(name.slice(6), args.input);             // P-2: 動的露出した agent_<name> tool の実行
  if (name === 'get_checkpoint')     return managedMode() ? { managed: true, note: 'browser-control は managed hub では利用できません。ローカル神龍または常駐箱を使用してください。' } : state.handoffs.filter((h) => h.checkpoint && h.checkpoint.decided === null).map((h) => ({ id: h.id, label: h.checkpoint.label, tool: h.checkpoint.tool, domain: h.checkpoint.domain }));
  if (name === 'resolve_checkpoint') return managedMode() ? { managed: true, note: 'browser-control は managed hub では利用できません。ローカル神龍または常駐箱を使用してください。' } : ref(args.allow ? approve(args.id) : decline(args.id));
  if (name === 'stream_run') {
    const run = state.runs[args.id]; if (!run) throw new Error(`no run "${args.id}"`);
    const snapshot = Object.entries(run.outputs).map(([node, output]) => ({ node, output }));
    if (run.status !== 'running') return { id: run.id, status: run.status, done: true, nodes: snapshot };
    const secs = Math.min(Math.max(Number(args.timeout) || 30, 1), 120);
    const seen = new Set(Object.keys(run.outputs));
    return await new Promise((resolve) => {
      const events = [];
      const sink = { write(frame) { try { const e = JSON.parse(frame.slice(6)); if (e.type === 'node' && !seen.has(e.node)) { seen.add(e.node); events.push({ node: e.node, output: e.output }); } if (e.type === 'done') finish(e.status); } catch {} }, end() {} };   // frame = 'data: {json}\n\n' → slice(6)
      let done = false;
      const finish = (status) => { if (done) return; done = true; clearTimeout(t); const s = runListeners.get(run.id); if (s) s.delete(sink); resolve({ id: run.id, status: status || state.runs[run.id]?.status || run.status, done: status != null, nodes: [...snapshot, ...events] }); };
      const t = setTimeout(() => finish(null), secs * 1000);
      let set = runListeners.get(run.id); if (!set) runListeners.set(run.id, (set = new Set())); set.add(sink);
    });
  }
  if (name === 'remember')           return addMemory(args.text, args.tags || []);   // Wave S
  if (name === 'recall')             return { memories: relevantMemories(args.query || '', args.topN || (args.query ? 3 : 5)) };   // Wave S: HTTP route と shape 統一（{ memories:[...] }）
  if (name === 'forget')             return deleteMemory(args.id);
  if (name === 'set_check')          return setCheck(args.automation, args.expect);   // Wave R-1
  if (name === 'list_check_results') return (state.checkResults || []).slice(-(args.limit || 20));   // Wave R-1
  if (name === 'list_drift_alerts')  return (state.driftAlerts  || []).slice(-(args.limit || 20));   // Wave R-3
  if (name === 'repair_run') {                                                          // Wave R-2: 手動修復トリガー
    const run = state.runs[args.runId]; if (!run) throw new Error(`no run "${args.runId}"`);
    setImmediate(() => repairRun(run)); return { ok: true, runId: args.runId, status: 'repair_queued' };
  }
  if (name === 'set_goal')           return saveGoal(args);                              // Wave Goals-1
  if (name === 'get_goal')           { const g = readGoals().find((x) => x.id === args.id); if (!g) throw new Error(`no goal "${args.id}"`); return goalView(g); }
  if (name === 'list_goals')         return readGoals().map(goalView);
  if (name === 'goal_checkin')       return goalCheckin(args.id, args.value, args.note);
  if (name === 'goal_suggest')       return goalSuggest(args.id);                       // Wave Goals-3: 停滞ゴールの次の一手を planFlow で提案
  if (name === 'delete_goal')        return deleteGoal(args.id);
  if (name === 'list_suggestions')   { const all = readSuggestions(); const st = args.status || 'open'; return st === 'all' ? all : all.filter((s) => s.status === st); }   // Ambient-1
  if (name === 'dismiss_suggestion') return dismissSuggestion(args.id);   // Ambient-1
  if (name === 'apply_suggestion')   return await applySuggestion(args.id);     // Ambient-1 + Goals-3.1（goal 提案は flow を実体化）
  // Wave U-1: stdio-parity tools — list/get_handoff filter live state in-process; the rest loop back to /api.
  if (name === 'list_handoffs') { let hs = state.handoffs; if (args.agent) hs = hs.filter((h) => h.to === args.agent || h.from === args.agent); if (args.status) hs = hs.filter((h) => h.status === args.status); return hs.slice(-(args.limit || 20)).map(ref); }
  if (name === 'get_handoff')        return find(args.id);
  if (PROXY[name])                   return proxySelf(name, args);
  throw new Error(`unknown tool "${name}"`);
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };   // Wave C: CORS so claude.ai Artifacts (sandbox origin ≠ claude.ai) can fetch /api/runflow etc. OPTIONS preflight already handled. ponytail: '*' fits self-host/ngrok; gate act routes with bearer when public.
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (req.method === 'GET' && p === '/') {                          // Wave Cockpit-1: / は玄関 launcher（旧 cockpit は /ui-old へ退避）
    try { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(INDEX_FILE)); }
    catch { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Shenron hub</h1><p>玄関 UI not installed yet (prototype/hub/index.html). JSON API under /api/*.</p>'); }
  }
  if (req.method === 'GET' && p === '/ui-old') {                    // Wave Cockpit-1: 旧 cockpit（ui.html）退避先
    try { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(UI_FILE)); }
    catch { return json(res, 404, { error: 'ui.html not found' }); }
  }
  if (req.method === 'GET' && p === '/ui2') {
    try { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(UI2_FILE)); }
    catch { return json(res, 404, { error: 'ui2.html not found' }); }
  }
  if (req.method === 'GET' && p === '/settings') {
    try { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(SETTINGS_FILE)); }
    catch { return json(res, 404, { error: 'settings.html not found' }); }
  }
  if (req.method === 'GET' && p === '/shenron') {
    try { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(SHENRON_UI_FILE)); }
    catch { return json(res, 404, { error: 'shenron.html not found' }); }
  }
  if (req.method === 'GET' && p === '/manifest.json') {
    try { res.writeHead(200, { 'content-type': 'application/manifest+json', 'access-control-allow-origin': '*' }); return res.end(fs.readFileSync(MANIFEST_FILE)); }
    catch { return json(res, 404, { error: 'manifest.json not found' }); }
  }
  if (req.method === 'GET' && p === '/sw.js') {
    // SW は root から配信 → scope='/' で /shenron も /api/* も網羅（Service-Worker-Allowed 不要）。
    try { res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(SW_FILE)); }
    catch { return json(res, 404, { error: 'sw.js not found' }); }
  }
  // Wave L: Auth — public GET routes (no auth required)
  if (req.method === 'GET' && p === '/api/auth/verify') {
    const tok = u.searchParams.get('token'); if (!tok) return json(res, 400, { error: 'token required' });
    try { return json(res, 200, verifyEmail(tok)); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'GET' && p === '/api/auth/me') {
    const s = checkSession(cookieSession(req)); if (!s) return json(res, 401, { error: 'not logged in' });
    return json(res, 200, { userId: s.userId, email: s.email });
  }
  if (req.method === 'GET' && p === '/api/auth/users') {
    if (!bearerOk(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, listUsers());
  }
  // Wave O-3: health check — no auth (external cron / watchdog can call this)
  if (req.method === 'GET' && p === '/api/health')
    return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), scheduler: schedulerOn(), version: HUB_VERSION });
  // Wave N-3: doctor — no auth (初回セットアップ診断・問題を抱えている状態でも呼べる)
  // この handler は非 async（POST は内側 async cb で処理）→ 外側 sync スコープでは await 不可。Promise を直接返す。
  if (req.method === 'GET' && p === '/api/doctor')
    return runDoctor(PORT).then((d) => json(res, 200, d), (e) => json(res, 500, { error: e.message }));
  // Gate: protect all /api/* GET routes when auth is configured (A2A_SHARED_TOKEN set or OAuth issued)
  if (req.method === 'GET' && p.startsWith('/api/') && !bearerOk(req)) return json(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET' && p === '/api/state')
    return json(res, 200, { autorun: AUTORUN, agents: publicAgents(), handoffs: state.handoffs.map((h) => ({ ...ref(h), input: h.input, result: h.result, error: h.error, history: h.history, runId: h.runId || null, redacted: h.redacted || null, consensus: h.consensus || null, checkpoint: h.checkpoint || null })), runs: Object.values(state.runs).slice(-20).map((r) => ({ id: r.id, flowId: r.flowId, status: r.status, done: Object.keys(r.outputs).length, total: r.nodes.length, outputs: r.outputs, skipped: r.skipped || [], routerPick: r.routerPick || {} })), reputation: reputationFrom(state.audit, state.handoffs, Object.keys(state.agents)), scheduler: { on: schedulerOn(), note: schedulerNote() } });   // Wave R: reputation. + scheduler 状態（live）
  if (req.method === 'GET' && p === '/api/check-results')   // Wave R-1: 直近の成果検証結果（list_check_results）
    return json(res, 200, (state.checkResults || []).slice(-(Number(u.searchParams.get('limit')) || 20)));
  if (req.method === 'GET' && p === '/api/drift-alerts')    // Wave R-3: drift 検出アラート（list_drift_alerts）
    return json(res, 200, (state.driftAlerts || []).slice(-(Number(u.searchParams.get('limit')) || 20)));
  if (req.method === 'GET' && p === '/api/shared')          // Wave A1: 共有エージェント庫（list_shared の HTTP 面・MCP は PROXY 経由で同ルートを叩く＝単一実装）
    return json(res, 200, listShared(u.searchParams.get('kind') || undefined));
  if (req.method === 'GET' && p === '/api/runs')  // M-2: last 20 runs (token-light)
    return json(res, 200, Object.values(state.runs).slice(-20).map((r) => ({ id: r.id, flowId: r.flowId, status: r.status, done: Object.keys(r.outputs).length, total: r.nodes.length, outputs: r.outputs })));
  if (req.method === 'GET') { const sm = p.match(/^\/api\/runs\/([^/]+)\/stream$/);   // O1: SSE live run stream (inherits the bearerOk gate above)
    if (sm) {
      const run = state.runs[sm[1]];
      if (!run) return json(res, 404, { error: `no run "${sm[1]}"` });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'access-control-allow-origin': '*' });
      for (const [node, output] of Object.entries(run.outputs)) res.write(`data: ${JSON.stringify({ type: 'node', node, output, status: run.status })}\n\n`);   // snapshot of progress so far
      if (run.status !== 'running') { res.write(`data: ${JSON.stringify({ type: 'done', status: run.status })}\n\n`); return res.end(); }   // already terminal → no live tail needed
      let set = runListeners.get(run.id); if (!set) runListeners.set(run.id, (set = new Set())); set.add(res);
      req.on('close', () => { const s = runListeners.get(run.id); if (s) { s.delete(res); if (!s.size) runListeners.delete(run.id); } });
      return;
    }
  }
  if (req.method === 'GET') { const rm = p.match(/^\/api\/runs\/([^/]+)$/);   // M-2: full run by id
    if (rm) { const r = state.runs[rm[1]]; return r ? json(res, 200, r) : json(res, 404, { error: `no run "${rm[1]}"` }); } }
  if (req.method === 'GET' && p === '/api/templates')   // Wave O2: 同梱テンプレ refs（id/name/summary/requires/nodeCount）＋未設定 gap 警告
    return json(res, 200, readTemplates().map((t) => ({ id: t.id, name: t.name, summary: t.summary || '', requires: t.requires || [], nodes: (t.nodes || []).length, warnings: templateGaps(t) })));
  if (req.method === 'GET' && p === '/api/workflows') {
    const wid = u.searchParams.get('id');                                                 // ?id= → full flow (🗂 overview opens on click); else token-light counts
    if (wid) { const w = readWorkflows().find((w) => w.id === wid); return w ? json(res, 200, w) : json(res, 404, { error: `no workflow "${wid}"` }); }
    return json(res, 200, readWorkflows().filter((w) => visibleTo(w, sessionUid(req))).map((w) => ({ id: w.id, name: w.name, summary: w.summary || '', nodes: (w.nodes || []).length, edges: (w.edges || []).length, steps: (w.steps || []).length, lastRun: w.lastRun || null, hasUi: !!w.ui, owner: w.owner ?? null, visibility: w.visibility || 'private' })));   // T-0: seat 可視性 filter + UI トグル用 owner/visibility
  }
  { const um = p.match(/^\/api\/workflows\/([^/]+)\/ui$/);   // Wave UI S3: get artifact UI code for a workflow
    if (um && req.method === 'GET') { const w = readWorkflows().find((w) => w.id === decodeURIComponent(um[1])); return w ? json(res, 200, { id: w.id, ui: w.ui || null }) : json(res, 404, { error: `no workflow "${um[1]}"` }); } }
  if (req.method === 'GET' && p === '/api/shenron/components') {                           // Wave 8: 生成部品の登録庫。?id= で full code、無しは token-light refs（pending は人ゲート待ち）
    const cid = u.searchParams.get('id');
    if (cid) { const c = readComponents().find((c) => c.id === cid); return c ? json(res, 200, c) : json(res, 404, { error: `no component "${cid}"` }); }
    return json(res, 200, readComponents().map((c) => ({ id: c.id, what: c.what, iters: c.iters, approved: c.approved, credentials: c.credentials || [], createdAt: c.createdAt })));   // credentials=BYO-credential 名のみ（値は持たない）→ panel の 🔑 バッジ
  }
  if (req.method === 'GET' && p === '/api/automations')
    return json(res, 200, readAutomations().map((m) => ({ id: m.id, name: m.name, trigger: m.trigger, workflow: m.workflow, enabled: m.enabled !== false, ...(m.expect ? { expect: m.expect } : {}) })));   // UI-Compat-2: expect を surface（成果検証 UI が「設定済み」を表示）
  if (req.method === 'GET' && p === '/api/integrations')         // connected MCP servers (Wave F.2)
    return json(res, 200, readIntegrations());
  if (req.method === 'GET' && p === '/api/integrations/search')  // clean-mcp token-light index: SMALL refs (id/label/kind/enabled/toolCount/tags)
    return json(res, 200, searchIntegrationsRefs(u.searchParams.get('q') || '', Number(u.searchParams.get('limit')) || 999));
  if (req.method === 'GET') { const im = p.match(/^\/api\/integrations\/([^/]+)$/);   // get ONE integration's full tool list on demand
    if (im) { const it = readIntegrations().find((x) => x.id === decodeURIComponent(im[1])); return it ? json(res, 200, it) : json(res, 404, { error: `no integration "${im[1]}"` }); } }
  if (req.method === 'GET' && p === '/api/audit')                // Wave H: tamper-evident trust trail + chain verification
    return json(res, 200, { entries: state.audit, verify: auditVerify(state.audit) });
  if (req.method === 'GET' && p === '/api/permissions') return json(res, 200, readPermissions());   // Wave 11b: browser-control allow/ask/deny ruleset (worker fetches to classify)
  if (req.method === 'GET' && p === '/api/login-status') { const s = readLoginState(); const dom = u.searchParams.get('domain'); return json(res, 200, dom ? { domain: dom, ...(s[dom] || { needsLogin: false }) } : { logins: s }); }   // Wave Login-1: ログイン生存状態（domain 指定 or 全件）
  if (req.method === 'GET' && p === '/api/suggestions') { const st = u.searchParams.get('status') || 'open'; const all = readSuggestions(); return json(res, 200, { suggestions: st === 'all' ? all : all.filter((s) => s.status === st) }); }   // Ambient-1
  if (req.method === 'GET' && p === '/api/goals') return json(res, 200, { goals: readGoals().map(goalView) });   // Wave Goals-1: ゴール一覧（進捗率付き）
  if (req.method === 'GET' && p.startsWith('/api/goals/')) { const id = decodeURIComponent(p.slice('/api/goals/'.length)); const g = readGoals().find((x) => x.id === id); return g ? json(res, 200, goalView(g)) : json(res, 404, { error: `no goal "${id}"` }); }
  if (req.method === 'GET' && p === '/api/receipt') {            // Wave ③: signed, offline-verifiable per-run Trust Receipt
    try { return json(res, 200, receiptFor(u.searchParams.get('runId'))); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (req.method === 'GET' && p === '/api/pubkey') {             // the hub's ed25519 public key as raw PEM — `curl .../api/pubkey > hub.pem`, pin it, verify receipts with NO hub
    res.writeHead(200, { 'content-type': 'application/x-pem-file' }); return res.end(HUB_KEY.publicKeyPem); }   // was JSON-wrapped: broke verify-receipt.mjs --pubkey (the pinned, stronger-than-TOFU path)
  if (req.method === 'GET' && p === '/api/buildstate')           // Wave J: the build-state IR vocabulary + match operators
    return json(res, 200, { events: BUILD_EVENTS, operators: Object.keys(MATCH_OPS) });
  if (req.method === 'GET' && p === '/api/capvocab')             // Wave B: the capability-passport vocabulary (drives the passport editor)
    return json(res, 200, CAP_VOCAB);
  if (req.method === 'GET' && p === '/api/mcp')                  // how to connect Shenron's MCP server (for "copy MCP call")
    return json(res, 200, { name: 'shenron-mcp', command: 'node', args: [path.resolve(HERE, '..', 'mcp', 'server.mjs')], hub: `http://localhost:${PORT}`, tokenEnv: 'A2A_SHARED_TOKEN' });
  if (req.method === 'GET' && p === '/api/config') return json(res, 200, configStatus());   // Wave: 全設定を1か所で読む（初期設定 hint 付き・secret は在否のみ）
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
        if (method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id, result: { tools: [...REMOTE_TOOLS, ...agentTools()] } });   // P-2: 作成済み agent も tool として露出
        if (method === 'tools/call') {
          mcpDispatch((params || {}).name, (params || {}).arguments || {})
            .then((r) => json(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] } }))
            .catch((e) => json(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }));
          return;
        }
        return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      }
      // Wave L: Auth POST routes — public (no bearer required)
      if (p === '/api/auth/register') {
        try {
          const { userId, email, verifyToken } = register(j.email, j.password);
          const base = reqBase(req);
          const link = `${base}/api/auth/verify?token=${verifyToken}`;
          console.log(`\n🐉 [auth] メール認証リンク (${email}):\n  ${link}\n`);
          trail('auth-register', { email });
          return json(res, 201, { userId, email, note: 'verification link printed to hub terminal' });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (p === '/api/auth/login') {
        try {
          const result = login(j.email, j.password);
          const cookie = `shenron_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`;
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie, 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ email: result.email, userId: result.userId, expiresAt: result.expiresAt }));
          trail('auth-login', { email: j.email });
          return;
        } catch (e) { return json(res, 401, { error: e.message }); }
      }
      if (p === '/api/auth/logout') {
        const tok = cookieSession(req); if (tok) logout(tok);
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'shenron_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ ok: true }));
      }
      // Wave M-1: password reset — public (no bearer required, same as register/login)
      if (p === '/api/auth/reset-request') {
        try {
          const r = resetRequest(j.email);
          if (r.resetToken) { const base = reqBase(req); console.log(`\n🔑 [auth] パスワードリセットリンク (${r.email}):\n  ${base}/api/auth/reset?token=${r.resetToken}\n`); }
          trail('auth-reset-request', { email: j.email || '?' });
          return json(res, 200, { note: 'if registered, reset link printed to hub terminal' });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (p === '/api/auth/reset') {
        try { return json(res, 200, resetPassword(j.token, j.password)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      // Wave B1: role 付替え（admin 専用）。set_role MCP(stdio) と settings.html admin が同ルートを叩く。
      if (p === '/api/auth/role') {
        if (!isAdmin(req)) return json(res, 403, { error: 'admin only' });
        try { return json(res, 200, setRole(j.userId, j.role)); }
        catch (e) { return json(res, 400, { error: e.message }); }
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
          send({ jsonrpc: '2.0', id, result: { tools: [...REMOTE_TOOLS, ...agentTools()] } });   // P-2: 作成済み agent も tool として露出
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
      if (p === '/api/login-detected') { const s = recordLogin(j.domain, !!j.resolved); trail('login-detected', { domain: j.domain || null, resolved: !!j.resolved }); return json(res, 200, { ok: true, state: j.domain ? s[j.domain] : null }); }   // Wave Login-1: worker → hub。ログイン要求の検出/解消を記録（audited・値は持たない）
      if (p === '/api/artifact-llm') {                                              // Wave UI S1: artifact が api.anthropic.com に fetch → hub が server-side proxy（鍵は箱に残る）
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return json(res, 400, { error: 'ANTHROPIC_API_KEY not set — artifact LLM proxy unavailable' });
        fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(j) })
          .then((r) => r.json().then((d) => json(res, r.status, d)))
          .catch((e) => json(res, 502, { error: e.message }));
        return;
      }
      if (p.startsWith('/api/suggestions/') && p.endsWith('/dismiss')) { const id = decodeURIComponent(p.slice('/api/suggestions/'.length, -'/dismiss'.length)); return json(res, 200, dismissSuggestion(id)); }   // Ambient-1
      if (p.startsWith('/api/suggestions/') && p.endsWith('/apply'))   { const id = decodeURIComponent(p.slice('/api/suggestions/'.length, -'/apply'.length)); applySuggestion(id).then((r) => json(res, 200, r)).catch((e) => json(res, 400, { error: e.message })); return; }   // Ambient-1 + Goals-3.1（goal 提案は save:true 実体化で async）
      if (p === '/api/goals') return json(res, 200, saveGoal(j || {}));                                     // Wave Goals-1: ゴール作成/更新
      if (p.startsWith('/api/goals/') && p.endsWith('/checkin')) { const id = decodeURIComponent(p.slice('/api/goals/'.length, -'/checkin'.length)); return json(res, 200, goalCheckin(id, j.value, j.note)); }   // 手動 checkin（最新値が現在値）
      if (p.startsWith('/api/goals/') && p.endsWith('/delete')) { const id = decodeURIComponent(p.slice('/api/goals/'.length, -'/delete'.length)); return json(res, 200, deleteGoal(id)); }
      if (p.startsWith('/api/goals/') && p.endsWith('/suggest')) { const id = decodeURIComponent(p.slice('/api/goals/'.length, -'/suggest'.length)); goalSuggest(id).then((r) => json(res, 200, r)).catch((e) => json(res, 400, { error: e.message })); return; }   // Wave Goals-3: 次の手提案（planFlow async）
      if (p === '/api/workflows') return json(res, 200, saveWorkflow({ ...j, owner: sessionUid(req) }));     // save wired DAG (nodes/edges + derived steps[])・T-0: 作成者=seat owner
      { const um = p.match(/^\/api\/workflows\/([^/]+)\/ui$/);   // Wave UI S3: set artifact UI code for a workflow
        if (um) { const wid = decodeURIComponent(um[1]); const arr = readWorkflows(); const i = arr.findIndex((w) => w.id === wid); if (i < 0) return json(res, 404, { error: `no workflow "${wid}"` }); arr[i] = { ...arr[i], ui: j.code ?? null }; fs.writeFileSync(WF_FILE, JSON.stringify(arr, null, 2)); trail('workflow-ui-set', { id: wid }); return json(res, 200, { id: wid, ui: arr[i].ui }); } }
      { const cm = p.match(/^\/api\/workflows\/([^/]+)\/clone$/);   // Wave Remix-1: fork a saved flow → new editable copy
        if (cm) { try { return json(res, 200, cloneWorkflow(decodeURIComponent(cm[1]), j.name)); } catch (e) { return json(res, 404, { error: String(e.message || e) }); } } }
      { const sm = p.match(/^\/api\/workflows\/([^/]+)\/(share|unshare)$/);   // T-0: 庫への共有/非共有トグル（visibility flip・owner 不変）。MCP の share_workflow と同じ setVisibility を cockpit にも露出
        if (sm) { try { return json(res, 200, setVisibility(decodeURIComponent(sm[1]), sm[2] === 'share' ? 'shared' : 'private')); } catch (e) { return json(res, 404, { error: String(e.message || e) }); } } }
      { const tm = p.match(/^\/api\/templates\/([^/]+)\/install$/);   // Wave O2: ワンクリック install → saveWorkflow（同梱テンプレを編集可能な workflow として複製）。local const = この行は `let m;`(後方宣言)より前
        if (tm) {
          const t = readTemplates().find((x) => x.id === decodeURIComponent(tm[1])); if (!t) return json(res, 404, { error: `no template "${tm[1]}"` });
          const wf = saveWorkflow({ id: t.id, name: t.name, summary: t.summary || '', nodes: t.nodes, edges: t.edges });
          const warnings = templateGaps(t);
          trail('template-install', { id: t.id, workflow: wf.id, gaps: warnings.length });   // 値は出さない・件数のみ
          return json(res, 200, { workflowId: wf.id, name: wf.name, requires: t.requires || [], warnings });
        } }
      if (p === '/api/runflow') return json(res, 200, runFlow(j));            // topo-run a DAG (draft nodes/edges, or saved id)
      if (p === '/api/langflow/run') { langflowRun(state.audit, j).then((r) => { save(); json(res, 200, r); }).catch((e) => { save(); json(res, 400, { error: e.message }); }); return; }  // 🔗 delegate an exotic Langflow flow to /api/v1/run, fenced (audit appended → persist)
      if (p === '/api/langflow/import') { langflowImport(state.audit, j).then((r) => { save(); json(res, 200, r); }).catch((e) => { save(); json(res, 400, { error: e.message }); }); return; }  // ⤴ register a flow INTO Langflow (raw, verbatim) so /api/v1/run can run it
      if (p === '/api/automations') return json(res, 200, saveAutomation(j)); // save trigger + wired workflow as an automation
      if (p === '/api/check') return json(res, 200, setCheck(j.automation, j.expect));   // Wave R-1: set_check（automation に expect 付与/解除）
      if (p === '/api/fire') return json(res, 200, fireEvent(j.event || {}, j.input)); // build-state event → fire matching automations
      if (p === '/api/tick') { tickScheduler(); return json(res, 200, { ok: true, at: new Date().toISOString(), schedulerOn: schedulerOn() }); }
      if (p === '/api/notify/test') {   // M-3: ping all enabled notify integrations with a test payload
        const notifiers = readIntegrations().filter((i) => i.enabled !== false && i.kind === 'notify');
        const payload = JSON.stringify({ type: 'test', at: new Date().toISOString(), message: 'Shenron test notification' });
        Promise.all(notifiers.map((n) => {
          const headers = { 'content-type': 'application/json' };
          if (n.token) headers['authorization'] = `Bearer ${n.token}`;
          const body = n.format === 'slack' ? JSON.stringify({ text: '🧪 Shenron test notification' }) : payload;
          return fetch(n.url, { method: 'POST', headers, body })
            .then((r) => ({ id: n.id, url: n.url, ok: r.ok, status: r.status }))
            .catch((e) => ({ id: n.id, url: n.url, ok: false, error: e.message }));
        })).then((results) => json(res, 200, { sent: results.length, results }));
        return;
      }   // Wave: 無料外部 cron(Cloudflare/cron-job.org 等)が叩く seam＝now due な schedule automation を発火（hub が起きてる時のみ届く）
      if (p === '/api/config') { writeCfg(mergeCfg(j)); trail('config-set', { keys: Object.keys(j) }); return json(res, 200, configStatus()); }   // Wave: 設定を1か所で更新（MCP/NL set_config も here）。secret は受けない（keyEnv は剥がす）
      if (p === '/api/fire/preview') return json(res, 200, firePreview(j.event || {})); // Wave 2: dry-run — what this event would fire (no run)
      if (p === '/api/autorun') return json(res, 200, setGlobalAutorun(j.on));         // global master autorun on/off
      if (p === '/api/integrations') return json(res, 200, saveIntegration(j));        // add/update an MCP server integration
      if (p === '/api/agents') return json(res, 200, createAgent(j));                  // create a (runnable, in-process) agent from a draft
      if (p === '/api/shenron/plan') {                                                 // 神龍 Wave 1: NL goal → plan IR（Wave B③: planFlow に集約＝remote-MCP と同一経路。have/missing は LLM-resolve §1.5-F、nodes/edges validate+layout、available も返す）
        planFlow({ goal: j.goal, save: j.save, gap: j.gap, context: j.context, cost: j.cost, owner: sessionUid(req) })       // Wave 5: context で対話修正／gap 道具生成の枝／cost／T-0: plan→save に seat owner
          .then((r) => json(res, 200, r))
          .catch((e) => json(res, 400, { error: e.message }));
        return;
      }
      if (p === '/api/shenron/gen-artifact-ui') {   // Wave UI S4: JSX 成果物 UI 生成
        genArtifactUi({ what: j.what, vendor: EXEC_VENDOR || 'claude' })
          .then((r) => { trail('gen-artifact-ui', { what: r.what, converged: r.converged }); json(res, 200, r); })
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
      // Wave I: Credential vault
      if (p === '/api/credentials') {
        if (j.action === 'set') return json(res, 200, setCredential(j.id, j.value));
        if (j.action === 'get') return json(res, 200, { id: j.id, present: getCredential(j.id) !== null }); // 値は返さない — AI context に Secret を流さない
        if (j.action === 'list') return json(res, 200, { ids: listCredentials() });
        if (j.action === 'delete') return json(res, 200, deleteCredential(j.id));
        return json(res, 400, { error: 'action required: set|get|list|delete' });
      }
      // Wave S: セッション横断メモリ
      if (p === '/api/memory') {
        if (j.action === 'add') return json(res, 200, addMemory(j.text, j.tags || []));
        if (j.action === 'list') return json(res, 200, { memories: listMemories() });
        if (j.action === 'recall') return json(res, 200, { memories: relevantMemories(j.query || '', j.topN || (j.query ? 3 : 5)) });
        if (j.action === 'delete') return json(res, 200, deleteMemory(j.id));
        return json(res, 400, { error: 'action required: add|list|recall|delete' });
      }
      // 注: この block は p.startsWith('/api/') の bearerOk gate の後にあるため認証済み。memory は secret でないが credentials と同じ保護面に置く。
      // Wave J: Skill共有
      if (p === '/api/components/export') {
        const c = readComponents().find((x) => x.id === j.id); if (!c) return json(res, 404, { error: `no component "${j.id}"` });
        const { what, code, iters, output } = c;
        return json(res, 200, { what, code, iters: iters || 0, output: output || '', shenron: '1', exportedAt: new Date().toISOString() });
      }
      if (p === '/api/components/import') {
        if (!j.code || !j.what) return json(res, 400, { error: 'need code + what' });
        const saved = saveComponent({ what: j.what, code: j.code, output: j.output || '', iters: j.iters || 0 });
        trail('component-import', { id: saved.id, what: saved.what });
        return json(res, 200, { ...saved, approved: false, note: 'imported — approve with approve_component to activate' });
      }
      let m;
      if ((m = p.match(/^\/api\/runs\/([^/]+)\/stop$/))) return json(res, 200, stopRun(m[1]));   // ⏹ stop an in-flight DAG run
      if ((m = p.match(/^\/api\/integrations\/([^/]+)\/toggle$/))) return json(res, 200, toggleIntegration(m[1], j.on));
      if ((m = p.match(/^\/api\/integrations\/([^/]+)\/delete$/))) { const id = decodeURIComponent(m[1]); const arr = readIntegrations().filter((x) => x.id !== id); writeIntegrations(arr); trail('integration-delete', { id }); return json(res, 200, { id, deleted: true }); }   // UI-Compat-1: 誤登録の通知先/サーバーを削除（settings UI から）
      if ((m = p.match(/^\/api\/automations\/([^/]+)\/toggle$/))) return json(res, 200, toggleAutomation(m[1], j.on));
      if ((m = p.match(/^\/api\/handoffs\/([^/]+)\/(approve|decline|result|checkpoint)$/)))
        return json(res, 200, m[2] === 'approve' ? ref(approve(m[1])) : m[2] === 'decline' ? ref(decline(m[1])) : m[2] === 'checkpoint' ? ref(checkpoint(m[1], j)) : ref(postResult(m[1], j)));
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/policy$/))) return json(res, 200, setPolicy(m[1], j));
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/autorun$/))) return json(res, 200, setAutorun(m[1], j.on)); // per-agent autorun on/off
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/passport$/))) return json(res, 200, setPassport(m[1], j));  // Wave H: edit capability passport
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/run$/))) {   // P-2: run a local agent synchronously, return its output
        runAgentSync(m[1], j.input).then((r) => json(res, 200, r)).catch((e) => json(res, 400, { error: e.message })); return;
      }
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/delete$/))) return json(res, 200, removeAgent(m[1]));   // P-1
      if ((m = p.match(/^\/api\/agents\/([^/]+)\/export-mcp$/))) return json(res, 200, exportAgentMcp(m[1]));   // P-3: standalone MCP server を書出
      return json(res, 404, { error: `unknown route ${p}` });
    } catch (e) { return json(res, 400, { error: e.message }); }
  });
});
server.on('error', (e) => { console.error(`[hub] cannot listen on ${PORT}: ${e.message} — pass --port <free>`); process.exit(1); });
server.listen(PORT, () => console.log(`[hub] Shenron durable handoff hub on http://localhost:${PORT}  (state: ${path.relative(process.cwd(), STATE_FILE)})`));
if (process.env.SHENRON_NO_SCHEDULER == null) { setTimeout(tickScheduler, 1500); setInterval(tickScheduler, 60000); console.log('⏰ [hub] scheduler armed — config.scheduler で live on/off・boot+60s tick で catch-up（SHENRON_NO_SCHEDULER=1 で hard 無効）'); }   // tick は schedulerOn() で live gate（config:false でも interval は回るが発火しない）
else console.log('⏰ [hub] scheduler hard-OFF (SHENRON_NO_SCHEDULER)');
