// mcp-client.mjs — minimal zero-dependency MCP client. Speaks JSON-RPC 2.0 to a connected MCP server
// so the hub executor can ACTUALLY CALL a server's tool (Wave G real side-effect), riding each server's
// OWN auth (philosophy #1: adopt, don't build authz). Two transports:
//   • stdio  — spawn `command`, exchange newline-delimited JSON-RPC (MCP stdio transport).
//   • http   — POST JSON-RPC to `url` (Streamable HTTP transport, best-effort: JSON or SSE response).
// Handshake every call: initialize → notifications/initialized → tools/call. (One-shot connection per call;
// no pooling — fine for an attended, approval-gated cockpit. Pooling is a later optimization.)
import { spawn } from 'node:child_process';

const PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'buildhud', version: '0.1' };

// secret-env fence (load-bearing for Wave 9): generated/untrusted server code runs with credentials stripped so it
// can't exfil keys. Single source of truth for the strip regex (shenron verifyMcpServer + hub runMcp import this).
export const SECRET_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_API|\bAPI_|AUTH|COOKIE/i;
export const safeEnv = (extra = {}) =>
  ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_RE.test(k))), ...extra });   // PATH/HOME/SSL stay

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

function callStdio(command, tool, args, { timeoutMs = 30000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const parts = argv(command);
    if (!parts.length) return reject(new Error('empty command'));
    let child;
    // env only when given → trusted servers keep inheriting process.env unchanged; generated servers get safeEnv().
    try { child = spawn(parts[0], parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], cwd, ...(env ? { env } : {}) }); }
    catch (e) { return reject(new Error(`spawn "${command}": ${e.message}`)); }
    let buf = '', errBuf = '', settled = false, nextId = 1;
    const pending = new Map();
    const timer = setTimeout(() => finish(new Error(`MCP "${command}" timed out after ${timeoutMs}ms`)), timeoutMs);
    function finish(err, val) {
      if (settled) return; settled = true; clearTimeout(timer);
      try { child.kill(); } catch {}
      err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(val);
    }
    function rpc(method, params) {
      return new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, (m) => (m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result)));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
      });
    }
    const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');   // string frames split on UTF-8 char boundaries (no multibyte corruption across chunks)
    child.on('error', (e) => finish(new Error(`MCP "${command}": ${e.message}`)));
    child.stderr.on('data', (d) => { errBuf += d; });
    child.on('close', (code) => { if (!settled) finish(new Error(`MCP "${command}" exited (${code}) ${errBuf.trim().slice(0, 200)}`)); });
    child.stdout.on('data', (d) => {                          // newline-delimited JSON-RPC frames
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); }
      }
    });
    rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO })
      .then(() => { notify('notifications/initialized'); return rpc('tools/call', { name: tool, arguments: args }); })
      .then((result) => finish(null, resultText(result)))
      .catch((e) => finish(e));
  });
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
