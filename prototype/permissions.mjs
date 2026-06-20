// permissions.mjs — Wave 11b: a Claude-Code-style allow/ask/deny ruleset for the browser-control worker.
// The concierge "手" is a co-pilot, not an autopilot: each browser step is classified against persisted
// rules. allow → run silently. ask → PAUSE for a human checkpoint (screenshot + 承認/却下). deny → blocked.
// When a human picks 「常に許可」, an allow rule is appended here (addAllowRule) so it stops asking next time —
// exactly settings.json. Pure module (sibling of trust.mjs), imported by the hub, the worker, and the test.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const PERM_FILE = path.join(HERE, 'mcp', 'permissions.json');

// out-of-the-box defaults (no file needed): read-only browsing flows silently; anything that mutates the
// page or sends data defaults to ask — the ToS line. A human promotes specifics to allow via 「常に許可」.
export const SEED_RULES = [
  { effect: 'allow', tool: 'browser_navigate' },
  { effect: 'allow', tool: 'browser_snapshot' },
  { effect: 'allow', tool: 'browser_take_screenshot' },
  { effect: 'allow', tool: 'browser_wait_for' },
  { effect: 'ask', tool: 'browser_click' },
  { effect: 'ask', tool: 'browser_type' },
  { effect: 'ask', tool: 'browser_press_key' },
  { effect: 'ask', tool: 'browser_file_upload' },
  { effect: 'ask', tool: 'browser_select_option' },
];

// the seed IS the default → catch returns SEED_RULES (not []), so no boot-time seeding step is needed.
// permissions.json only ever gets created when a human first clicks 「常に許可」 (writePermissions).
export const readPermissions = () => { try { return JSON.parse(fs.readFileSync(PERM_FILE, 'utf8')); } catch { return SEED_RULES; } };
export const writePermissions = (arr) => fs.writeFileSync(PERM_FILE, JSON.stringify(arr, null, 2));

// classify one step against the rules. A rule matches when its tool (if set) equals the step's tool AND its
// domain (if set) is a suffix of the live page domain. Precedence: deny > allow > ask. No match → ask (the
// safe default = the ToS guardrail: outbound stays human until a human explicitly promotes it).
export function classify(step, currentDomain, rules) {
  const matches = (rules || []).filter((r) =>
    (!r.tool || r.tool === step.tool) &&
    (!r.domain || (currentDomain && currentDomain.endsWith(r.domain))));
  if (matches.some((r) => r.effect === 'deny')) return 'deny';
  if (matches.some((r) => r.effect === 'allow')) return 'allow';
  return 'ask';
}

// the 「常に許可」 write: append an allow rule, idempotent (repeated clicks don't bloat the file).
export function addAllowRule(rules, { tool, domain } = {}) {
  const next = Array.isArray(rules) ? rules : [];
  if (next.some((r) => r.effect === 'allow' && r.tool === tool && (r.domain || null) === (domain || null))) return next;
  return [...next, { effect: 'allow', ...(tool ? { tool } : {}), ...(domain ? { domain } : {}) }];
}
