// trust.mjs — Wave H "Agent Trust Boundary" primitives (zero-dependency). The wedge n8n/Langflow/Zapier
// can't write, because they all assume a single owner: enforce trust at EVERY hop across owner boundaries.
//   • data firewall — redact secrets/PII/env (and per-agent `never`) BEFORE data crosses a boundary or
//     leaves to an external tool. Aligns with philosophy #4 (secrets never leak).
//   • tamper-evident audit — a hash-chained trail of grant/redact/deny/approve/send; any edit breaks the chain.
// Reused by the hub (enforcement point) and available to the MCP server.
import { createHash, sign, verify } from 'node:crypto';

// "never leave" patterns — secrets/PII that must not cross a trust boundary. {label, re}.
export const SECRET_PATTERNS = [
  { label: 'openai-key', re: /\bsk-[A-Za-z0-9_\-]{16,}\b/g },
  { label: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: 'bearer', re: /\bBearer\s+[A-Za-z0-9._\-]{12,}/gi },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g },
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'env-secret', re: /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*=\s*['"]?[^\s'"]{4,}['"]?/g },
  { label: 'email', re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
];
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Redact `never` from text. Built-in secret patterns always apply; `never` adds custom literal tags.
// Returns { text, removed:[{label,count}] } — `removed` records WHAT was stripped, never the values.
export function redact(text, { never = [] } = {}) {
  let out = String(text ?? ''); const removed = [];
  const pats = SECRET_PATTERNS.concat((never || []).filter(Boolean).map((n) => ({ label: 'never:' + n, re: new RegExp(escapeRe(n), 'gi') })));
  for (const { label, re } of pats) {
    let c = 0; out = out.replace(re, () => (c++, `[redacted:${label}]`));
    if (c) removed.push({ label, count: c });
  }
  return { text: out, removed };
}

// Structured-args allowlist — the pass-list sibling of redact's deny-list, for the one genuinely structured
// boundary (MCP egress config args). Empty/unset pass = allow-all (back-compat); else default-deny: keep ONLY
// keys named in pass, report what was dropped (labels, never values — same discipline as redact).
export function applyPass(obj, pass = []) {
  const o = (obj && typeof obj === 'object') ? obj : {};
  if (!Array.isArray(pass) || pass.length === 0) return { args: o, dropped: [] };
  const allow = new Set(pass); const args = {}, dropped = [];
  for (const k of Object.keys(o)) (allow.has(k) ? (args[k] = o[k]) : dropped.push(k));
  return { args, dropped };
}

// Capability passport: declared per agent; the hub enforces it every hop. Wave B productizes the vocabulary
// from a flat read/write/external_send list into a structured grant so a buyer can say "this 3rd-party agent
// gets diff-only repo access, no network, and must ask before any external send" in one passport.
//   net           none | read | full     — declared + audited (real sandbox is runner-side; honest label)
//   fs            none | diff-only | repo — declared + audited (ditto)
//   external_send deny | approval | allow — ENFORCED at the mcp hop (deny=fail fast, approval=force the fence)
//   secrets       deny                    — fixed guarantee: built-in secret/PII firewall always strips (philosophy #4)
export const CAP_VOCAB = { net: ['none', 'read', 'full'], fs: ['none', 'diff-only', 'repo'], external_send: ['deny', 'approval', 'allow'], secrets: ['deny'] };
export const DEFAULT_PASSPORT = { caps: { net: 'read', fs: 'repo', external_send: 'approval', secrets: 'deny' }, share: { never: [], pass: [] } };
const oneOf = (vocab, v, dflt) => (vocab.includes(v) ? v : dflt);
// Upgrade any stored passport (incl. the legacy {caps:['read','write','external_send']} array form) to the
// structured shape, clamping every field to its vocabulary. Idempotent — safe to call on every read.
export function normalizePassport(p) {
  const d = DEFAULT_PASSPORT.caps; p = (p && typeof p === 'object') ? p : {};
  let c = p.caps;
  if (Array.isArray(c)) c = { net: 'read', fs: c.includes('write') || c.includes('read') ? 'repo' : 'none', external_send: c.includes('external_send') ? 'approval' : 'deny', secrets: 'deny' };
  c = (c && typeof c === 'object') ? c : {};
  const caps = { net: oneOf(CAP_VOCAB.net, c.net, d.net), fs: oneOf(CAP_VOCAB.fs, c.fs, d.fs), external_send: oneOf(CAP_VOCAB.external_send, c.external_send, d.external_send), secrets: 'deny' };
  const s = (p.share && typeof p.share === 'object') ? p.share : {};
  return { caps, share: { never: Array.isArray(s.never) ? s.never : [], pass: Array.isArray(s.pass) ? s.pass : [] } };
}
export const sendMode = (passport) => (passport && passport.caps && passport.caps.external_send) || 'deny';   // deny | approval | allow

// Tamper-evident audit: hash-chained append. `event` = {type, ...detail} (avoid keys seq/prev/hash in detail).
const hashOf = (seq, prev, event) => createHash('sha256').update(JSON.stringify({ seq, prev, event })).digest('hex').slice(0, 16);
export function auditAppend(chain, event) {
  const seq = chain.length, prev = seq ? chain[seq - 1].hash : 'genesis';
  const entry = { seq, ...event, prev, hash: hashOf(seq, prev, event) };
  chain.push(entry); return entry;
}
export function auditVerify(chain) {
  let prev = 'genesis';
  for (const e of chain) {
    const { seq, hash, prev: p, ...event } = e;
    if (p !== prev || hashOf(seq, p, event) !== hash) return { ok: false, at: seq, length: chain.length };
    prev = hash;
  }
  return { ok: true, length: chain.length };
}

// Wave R — audit-backed reputation: aggregate the tamper-evident trail into a LONGITUDINAL, per-agent trust
// signal (the per-run trust of E1/E2/E3, extended across time → the bridge toward a cross-owner work market).
// Pure + DERIVED: computed on read from the existing audit + handoffs, never persisted — inbox.json stays the
// single source of truth. Honest by design (no overclaim):
//   • only events that NAME an agent are attributed; edge redactions whose endpoints are node ids (in1/out1)
//     can't be tied to an agent, so they land in `unattributed` — never blamed on someone (fake precision is worse).
//   • a `deny` = the data firewall doing its job (the agent lacked the grant), so it's a NEUTRAL "blocks enforced"
//     count, NOT a demerit and NOT folded into cleanRunRate.
//   • cold-start (no audited runs) → tier 'new', never a 0% score; if the chain doesn't verify the evidence is
//     untrustworthy → tier 'chain-broken' overrides everything.
export function reputationFrom(audit = [], handoffs = [], agentIds = []) {
  const chain = auditVerify(audit);
  const isAgent = new Set(agentIds);
  const hById = new Map(handoffs.map((h) => [h.id, h]));
  const A = {};
  const acc = (id) => (A[id] ||= { runs: new Set(), dirtyRuns: new Set(), redactionsCaught: 0, denials: 0, approvalsRequired: 0, sendsMade: 0, attribution: 'direct' });
  for (const id of agentIds) acc(id);                                  // cold-start: every known agent shows up, even with zero activity
  const unattributed = { edgeRedactions: 0, routes: 0 };
  for (const h of handoffs) { if (!h.runId) continue; if (isAgent.has(h.to)) acc(h.to).runs.add(h.runId); if (isAgent.has(h.from)) acc(h.from).runs.add(h.runId); }   // honest denominator: runs the agent was actually in
  for (const e of audit) {
    const h = e.handoff ? hById.get(e.handoff) : null;
    if (e.type === 'redact') {
      const n = (e.removed || []).reduce((x, r) => x + (r.count || 0), 0);
      if (e.egress) {                                                  // egress to an external tool: no agent field → join handoff.from (the sender)
        if (h && isAgent.has(h.from)) { const a = acc(h.from); a.redactionsCaught += n; a.attribution = 'partial'; if (h.runId) a.dirtyRuns.add(h.runId); }
        else unattributed.edgeRedactions += n;
      } else if (isAgent.has(e.to)) {                                  // handoff-create OR edge-into-agent: `to` names the recipient agent
        const a = acc(e.to); a.redactionsCaught += n; const rid = h ? h.runId : e.runId; if (rid) a.dirtyRuns.add(rid);
      } else unattributed.edgeRedactions += n;                         // edge redact with node-id endpoints (in1/out1) → not attributable
    } else if (e.type === 'deny') {
      if (isAgent.has(e.from)) acc(e.from).denials += 1;               // firewall enforced a block — neutral (NOT counted against cleanRunRate)
    } else if (e.type === 'approve') {
      if (isAgent.has(e.to)) acc(e.to).approvalsRequired += 1;
    } else if (e.type === 'send') {
      if (h && isAgent.has(h.from)) { const a = acc(h.from); a.sendsMade += 1; a.attribution = 'partial'; }
    } else if (e.type === 'route') unattributed.routes += 1;
    // `passport` events configure caps (not a run signal) → not scored
  }
  const agents = {};
  for (const [id, a] of Object.entries(A)) {
    const auditedRuns = a.runs.size, cleanRuns = Math.max(0, auditedRuns - a.dirtyRuns.size);
    const cleanRunRate = auditedRuns ? cleanRuns / auditedRuns : null;
    const tier = !chain.ok ? 'chain-broken' : auditedRuns === 0 ? 'new'
      : (auditedRuns >= 3 && cleanRunRate >= 0.8 && a.attribution === 'direct') ? 'verified' : 'observed';
    agents[id] = { auditedRuns, cleanRuns, cleanRunRate, redactionsCaught: a.redactionsCaught, denials: a.denials,
      approvalsRequired: a.approvalsRequired, sendsMade: a.sendsMade, attribution: a.attribution, tier,
      score: auditedRuns ? Math.round(cleanRunRate * 100) : null };
  }
  return { agents, chainOk: chain.ok, unattributed };
}

// Wave ③ Proof — a signed, offline-verifiable Trust Receipt for ONE run. The audit is tamper-evident but only
// checkable INSIDE the hub; a receipt is the PORTABLE artifact a buyer/auditor verifies WITHOUT the hub, via an
// ed25519 signature. Honest: it attests integrity + authenticity under the hub's key, NOT identity/authority —
// a self-generated hub key is TOFU (trust WHO signed only via an out-of-band public key). Receipt entries carry
// labels+counts, never the redacted values. signReceipt/verifyReceipt are pure; key persistence lives in the hub.
function runSubchain(audit, handoffs, runId) {
  const hById = new Map((handoffs || []).map((h) => [h.id, h]));
  return (audit || []).filter((e) => e.runId === runId || (e.handoff && hById.get(e.handoff) && hById.get(e.handoff).runId === runId));
}
// deterministic JSON (recursively sorted keys) so the signer and any verifier hash the EXACT same bytes.
// Mirrors JSON semantics for `undefined` (object props with undefined values are dropped; undefined → null
// elsewhere) so a sign-time in-memory `key:undefined` and a post-JSON-round-trip missing key canonicalize alike.
function canonical(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  if (obj && typeof obj === 'object') return '{' + Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  return JSON.stringify(obj) ?? 'null';
}
export function buildReceipt({ hub, runId, run, audit, handoffs, issuedAt }) {
  const entries = runSubchain(audit, handoffs, runId);
  const tip = (audit && audit.length) ? audit[audit.length - 1] : null;
  return { version: 1, alg: 'ed25519', hub: { id: hub.id, publicKey: hub.publicKey }, runId,
    run: run ? { status: run.status, createdAt: run.createdAt } : null, issuedAt,
    chainTip: { length: (audit || []).length, hash: tip ? tip.hash : 'genesis' }, entries };
}
export function signReceipt(receipt, privateKey) {
  return { ...receipt, signature: sign(null, Buffer.from(canonical(receipt)), privateKey).toString('base64') };
}
// Verify with NO hub: (a) every entry still hashes to its stored hash (untampered content), (b) the ed25519
// signature checks out against the given public key (or the one embedded in the receipt — TOFU).
export function verifyReceipt(receipt, publicKey) {
  const r = receipt || {}; const { signature, ...unsigned } = r;
  let entriesOk = true, at;
  for (const e of (r.entries || [])) { const { seq, hash, prev, ...event } = e; if (hashOf(seq, prev, event) !== hash) { entriesOk = false; at = seq; break; } }
  let signatureOk = false;
  try { signatureOk = !!signature && verify(null, Buffer.from(canonical(unsigned)), publicKey || (r.hub && r.hub.publicKey), Buffer.from(signature, 'base64')); } catch { signatureOk = false; }
  return { ok: entriesOk && signatureOk, signatureOk, entriesOk, ...(at !== undefined ? { at } : {}) };
}
