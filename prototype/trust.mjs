// trust.mjs — Wave H "Agent Trust Boundary" primitives (zero-dependency). The wedge n8n/Langflow/Zapier
// can't write, because they all assume a single owner: enforce trust at EVERY hop across owner boundaries.
//   • data firewall — redact secrets/PII/env (and per-agent `never`) BEFORE data crosses a boundary or
//     leaves to an external tool. Aligns with philosophy #4 (secrets never leak).
//   • tamper-evident audit — a hash-chained trail of grant/redact/deny/approve/send; any edit breaks the chain.
// Reused by the hub (enforcement point) and available to the MCP server.
import { createHash } from 'node:crypto';

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
