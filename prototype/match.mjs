// Wave J — build-state IR match DSL (no eval). Shared by hub.mjs + mcp/server.mjs so the two can't drift.
// A trigger fires when trig.match is a DEEP SUBSET of the event: nested objects recurse, arrays match
// positionally, primitives by ===; a match leaf may be an operator object (all keys start with "$").
export const MATCH_OPS = {
  $in: (v, a) => Array.isArray(a) && a.includes(v), $nin: (v, a) => Array.isArray(a) && !a.includes(v),
  $ne: (v, x) => v !== x, $gt: (v, x) => v > x, $gte: (v, x) => v >= x, $lt: (v, x) => v < x, $lte: (v, x) => v <= x,
  $exists: (v, b) => (v !== undefined) === !!b,
};
export const isOps = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0 && Object.keys(o).every((k) => k[0] === '$');
export const deepMatch = (pat, val) => {
  if (isOps(pat)) return Object.entries(pat).every(([op, arg]) => !!MATCH_OPS[op] && MATCH_OPS[op](val, arg));
  if (pat === null || typeof pat !== 'object') return pat === val;
  if (Array.isArray(pat)) return Array.isArray(val) && pat.every((p, i) => deepMatch(p, val[i]));
  return val !== null && typeof val === 'object' && Object.entries(pat).every(([k, v]) => deepMatch(v, val[k]));
};
export const triggerMatches = (trig, event) => !!trig && trig.type === 'build_state' && !!trig.match && deepMatch(trig.match, event);

// ponytail: one runnable self-check — `node prototype/match.mjs` asserts the DSL still matches. upgrade: more cases if a new operator lands.
if (process.argv[1] && process.argv[1].endsWith('match.mjs')) {
  const ok = (c, m) => { if (!c) throw new Error('match.mjs self-check failed: ' + m); };
  ok(deepMatch({ status: 'green' }, { status: 'green', repo: 'x' }), 'subset primitive');
  ok(!deepMatch({ status: 'green' }, { status: 'red' }), 'primitive mismatch');
  ok(deepMatch({ status: { $in: ['green', 'blue'] } }, { status: 'green' }), '$in true');
  ok(!deepMatch({ pr: { $gt: 5 } }, { pr: 3 }), '$gt false');
  ok(triggerMatches({ type: 'build_state', match: { status: 'green' } }, { status: 'green', repo: 'r' }), 'triggerMatches true');
  ok(!triggerMatches({ type: 'webhook', match: {} }, {}), 'non-build_state');
  console.log('match.mjs self-check OK');
}
