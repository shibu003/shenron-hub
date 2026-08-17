// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 shibu003
// mcp-client.mjs — minimal zero-dependency MCP client. Speaks JSON-RPC 2.0 to a connected MCP server
// so the hub executor can ACTUALLY CALL a server's tool (Wave G real side-effect), riding each server's
// OWN auth (philosophy #1: adopt, don't build authz). Two transports:
//   • stdio  — spawn `command`, exchange newline-delimited JSON-RPC (MCP stdio transport).
//   • http   — POST JSON-RPC to `url` (Streamable HTTP transport, best-effort: JSON or SSE response).
// Handshake every call: initialize → notifications/initialized → tools/call. (One-shot connection per call;
// no pooling — fine for an attended, approval-gated cockpit. Pooling is a later optimization.)
import { spawn } from 'node:child_process';

const PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'shenron', version: '0.1' };

// secret-env fence (load-bearing for Wave 9): generated/untrusted server code runs with credentials stripped so it
// can't exfil keys. `allow` = BYO-credential names that ride through (their values stay in the operator's env, never the
// repo). safeEnv() strips all secrets; safeEnv(['X_API_KEY']) keeps that one. Single source of truth for the strip regex.
export const SECRET_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_API|\bAPI_|AUTH|COOKIE/i;
export const safeEnv = (allow = []) =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_RE.test(k) || allow.includes(k)));   // PATH/HOME/SSL stay

// Call `tool` on a connected MCP server (an integrations.json entry). Returns the tool's text output.
export async function callMcpTool(integ, tool, args = {}, opts = {}) {
  if (!integ) throw new Error('no integration');
  if (integ.command) return callStdio(integ.command, tool, args, opts);
  if (integ.url) return callHttp(integ.url, tool, args, opts);
  throw new Error(`integration "${integ.id || '?'}" has no command or url`);
}

// pull the human-readable text out of an MCP tool result; throw if the tool reported an error.
function resultText(result) {
  if (result == null) return '';
  const c = Array.isArray(result.content)
    ? result.content.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n').trim() : '';
  if (result.isError) throw new Error(c || 'tool returned isError');
  return c || (result.structuredContent ? JSON.stringify(result.structuredContent) : JSON.stringify(result));
}

// split a command string into argv (space-delimited; configured commands need no quoted-arg grammar)
const argv = (cmd) => cmd.trim().split(/\s+/);

// PERSISTENT stdio client (Wave 11): spawn ONCE, handshake ONCE, then issue many tools/call on the SAME child so
// server-side session state (e.g. a Playwright browser tab) survives step→step. The one-shot callStdio below can't —
// it kills the child after a single call. Returns raw tool results; call close() when done. The browser-control
// worker holds one of these for its lifetime (a stateful computer-use session — the concierge "手").
export function openStdio(command, { cwd, env, timeoutMs = 30000 } = {}) {
  const parts = argv(command);
  if (!parts.length) throw new Error('empty command');
  // env only when given → trusted servers keep inheriting process.env unchanged; generated/untrusted get safeEnv().
  const child = spawn(parts[0], parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], cwd, ...(env ? { env } : {}) });
  let buf = '', errBuf = '', nextId = 1, dead = null;
  const pending = new Map();
  const fail = (e) => { dead = e instanceof Error ? e : new Error(String(e)); for (const cb of pending.values()) cb({ error: { message: dead.message } }); pending.clear(); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');   // string frames split on UTF-8 char boundaries (no multibyte corruption across chunks)
  child.on('error', (e) => fail(new Error(`MCP "${command}": ${e.message}`)));
  child.stderr.on('data', (d) => { errBuf += d; });
  child.on('close', (code) => fail(new Error(`MCP "${command}" exited (${code}) ${errBuf.trim().slice(0, 200)}`)));
  child.stdout.on('data', (d) => {                            // newline-delimited JSON-RPC frames
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); }
    }
  });
  const rpc = (method, params, ms) => new Promise((res, rej) => {
    if (dead) return rej(dead);
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`MCP "${command}" ${method} timed out after ${ms}ms`)); }, ms);
    pending.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
  const ready = rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO }, timeoutMs)
    .then(() => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'));
  ready.catch(() => {});   // mark handled: an open()→close() with no call() must not surface an unhandled rejection. call() still sees the failure via its own `await ready`.
  return {
    async call(tool, args = {}, opts = {}) { await ready; return rpc('tools/call', { name: tool, arguments: args }, opts.timeoutMs || timeoutMs); },   // raw result; caller decides text vs image
    async listTools(opts = {}) { await ready; return (await rpc('tools/list', {}, opts.timeoutMs || timeoutMs)).tools || []; },   // live tool schemas (name + inputSchema) — drive an agent off the REAL server, version-robust
    close() { try { child.kill(); } catch {} },
  };
}

// one-shot: open → one call → close. resultText throws on isError / strips to text (unchanged contract).
function callStdio(command, tool, args, { timeoutMs = 30000, cwd, env } = {}) {
  const c = openStdio(command, { cwd, env, timeoutMs });
  return c.call(tool, args, { timeoutMs }).then(resultText).finally(() => c.close());
}

async function callHttp(url, tool, args, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let sessionId, id = 0;
  async function rpc(method, params, isNotification) {
    const msg = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(isNotification ? {} : { id: ++id }) };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(msg), signal: ctrl.signal });
    const sid = r.headers.get('mcp-session-id'); if (sid) sessionId = sid;
    if (isNotification) return null;
    if (!r.ok) throw new Error(`MCP ${url} → HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    const payload = ct.includes('text/event-stream') ? parseSse(text) : JSON.parse(text);
    if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    return payload.result;
  }
  try {
    await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO });
    await rpc('notifications/initialized', undefined, true);
    return resultText(await rpc('tools/call', { name: tool, arguments: args }));
  } finally { clearTimeout(timer); }
}

function parseSse(text) {                                     // grab the last `data: {json}` frame
  const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  for (let i = data.length - 1; i >= 0; i--) { try { return JSON.parse(data[i]); } catch {} }
  throw new Error('no JSON in SSE response');
}