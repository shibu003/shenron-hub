// 🔗 Langflow run-layer. A flow with exotic components the cockpit can't run natively is delegated WHOLE to
// Langflow's own POST /v1/run/{flowId}; the hub stays the trust boundary — the input is firewalled (redact) and
// the external call is hash-chained into the audit. Kept here (out of hub.mjs) with an injectable fetch so the
// whole fence path is testable without booting the server or a live Langflow. See test_langflow.mjs.
import { redact, auditAppend } from '../trust.mjs';

// /api/v1/run expects a chat-shaped envelope; input_value carries the (already-redacted) user message.
export const lfRunBody = (input) => ({ input_value: String(input ?? ''), output_type: 'chat', input_type: 'chat' });
const lfHeaders = (key) => ({ 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) });   // local `langflow run` auto-logins; key only needed for secured instances

// Pull the human-readable chat text out of Langflow's deeply-nested /v1/run response. The carrier key drifts
// across Langflow versions, so try the known ones in order, then fall back to raw JSON (never throw).
export function lfRunText(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  const o = out?.outputs?.[0]?.outputs?.[0];
  const hit = [
    o?.results?.message?.text,
    o?.results?.message?.data?.text,
    o?.outputs?.message?.message,
    o?.messages?.[0]?.message,
    o?.artifacts?.message,
  ].find((c) => typeof c === 'string' && c.length);
  return hit ?? JSON.stringify(out);
}

// Delegate one flow to Langflow /api/v1/run, fenced. Appends audit entries to `audit` (caller persists).
// `fetchImpl` is injectable for tests; defaults to the platform fetch.
export async function langflowRun(audit, { host, flowId, input, key }, fetchImpl = globalThis.fetch) {
  host = String(host || 'http://localhost:7860').replace(/\/+$/, '');
  if (!flowId) throw new Error('flowId required — re-import the Langflow flow (its top-level id is the flowId)');
  const trail = (type, detail) => auditAppend(audit, { type, ts: Date.now(), ...detail });
  const fw = redact(input || '');                                            // data firewall: never leak secrets/PII to Langflow
  if (fw.removed.length) trail('redact', { to: `langflow:${flowId}`, egress: true, removed: fw.removed });
  const target = `${host}/api/v1/run/${encodeURIComponent(flowId)}`;
  let r, text;
  try { r = await fetchImpl(target, { method: 'POST', headers: lfHeaders(key), body: JSON.stringify(lfRunBody(fw.text)) }); text = await r.text(); }
  catch (e) { trail('langflow-run', { flowId, host, ok: false, error: e.message }); throw new Error(`Langflow unreachable at ${host} — is it running? (${e.message})`); }
  if (!r.ok) { trail('langflow-run', { flowId, host, ok: false, status: r.status }); throw new Error(`Langflow ${r.status}: ${text.slice(0, 300)}`); }
  let body; try { body = JSON.parse(text); } catch { body = text; }
  trail('langflow-run', { flowId, host, ok: true, redacted: fw.removed.length });
  return { flowId, status: r.status, output: lfRunText(body), redacted: fw.removed.length };
}

// Register a flow INTO Langflow so /api/v1/run can execute it (removes the manual "import the same .json on both
// sides" footgun). Uploads the ORIGINAL exported JSON VERBATIM (minus its local id/ownership, which Langflow
// re-issues) — reconstructing from cockpit's lossy node model would break Langflow's typed templates, so sending
// the source untouched is the only way to keep 100% type + setting fidelity. Audited; NOT redacted — a flow
// definition (and any keys it carries) goes to the user's OWN Langflow, not a third-party egress.
export async function langflowImport(audit, { host, flow, key }, fetchImpl = globalThis.fetch) {
  host = String(host || 'http://localhost:7860').replace(/\/+$/, '');
  if (!flow || typeof flow !== 'object') throw new Error('flow (the imported Langflow JSON) required');
  const trail = (type, detail) => auditAppend(audit, { type, ts: Date.now(), ...detail });
  const payload = {                                                          // FlowCreate: only `name` is required
    name: flow.name || 'cockpit-import', description: flow.description || '',
    data: flow.data || { nodes: flow.nodes || [], edges: flow.edges || [] }, endpoint_name: flow.endpoint_name || null,
  };
  const target = `${host}/api/v1/flows/`;
  let r, text;
  try { r = await fetchImpl(target, { method: 'POST', headers: lfHeaders(key), body: JSON.stringify(payload) }); text = await r.text(); }
  catch (e) { trail('langflow-import', { name: payload.name, host, ok: false, error: e.message }); throw new Error(`Langflow unreachable at ${host} — is it running? (${e.message})`); }
  if (!r.ok) { trail('langflow-import', { name: payload.name, host, ok: false, status: r.status }); throw new Error(`Langflow ${r.status}: ${text.slice(0, 300)}`); }
  let body; try { body = JSON.parse(text); } catch { body = {}; }
  const flowId = body.id || body.flow_id || '';
  trail('langflow-import', { name: payload.name, host, ok: true, flowId });
  return { flowId, name: body.name || payload.name };
}
