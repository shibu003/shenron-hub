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

// Wave: minimal 5-field cron matcher ("m h dom mon dow") — *, n, a-b, */n, comma lists. No seconds. dow 0=Sun. pure.
export function cronMatch(expr, d) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const v = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  const ok = (field, val, min, max) => field.split(',').some((part) => {
    let step = 1, range = part; const sl = part.split('/'); if (sl.length === 2) { range = sl[0] || '*'; step = Number(sl[1]) || 1; }
    let lo, hi;
    if (range === '*') { lo = min; hi = max; } else if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b; } else { lo = hi = Number(range); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || step < 1) return false;
    for (let x = lo; x <= hi; x += step) if (x === val) return true;
    return false;
  });
  return ok(f[0], v[0], 0, 59) && ok(f[1], v[1], 0, 23) && ok(f[2], v[2], 1, 31) && ok(f[3], v[3], 1, 12) && ok(f[4], v[4], 0, 6);
}

// ponytail: one runnable self-check — `node prototype/match.mjs` asserts the DSL still matches. upgrade: more cases if a new operator lands.
if (process.argv[1] && process.argv[1].endsWith('match.mjs')) {
  const ok = (c, m) => { if (!c) throw new Error('match.mjs self-check failed: ' + m); };
  ok(deepMatch({ status: 'green' }, { status: 'green', repo: 'x' }), 'subset primitive');
  ok(!deepMatch({ status: 'green' }, { status: 'red' }), 'primitive mismatch');
  ok(deepMatch({ status: { $in: ['green', 'blue'] } }, { status: 'green' }), '$in true');
  ok(!deepMatch({ pr: { $gt: 5 } }, { pr: 3 }), '$gt false');
  ok(triggerMatches({ type: 'build_state', match: { status: 'green' } }, { status: 'green', repo: 'r' }), 'triggerMatches true');
  ok(!triggerMatches({ type: 'webhook', match: {} }, {}), 'non-build_state');
  // cron: "0 9 * * 1" = Mon 09:00. Mon=2026-06-22, Tue=2026-06-23 (local time).
  const mon0900 = new Date(2026, 5, 22, 9, 0), mon0901 = new Date(2026, 5, 22, 9, 1), tue0900 = new Date(2026, 5, 23, 9, 0);
  ok(cronMatch('0 9 * * 1', mon0900), 'cron Mon 9:00 matches');
  ok(!cronMatch('0 9 * * 1', mon0901), 'cron 9:01 no match (minute)');
  ok(!cronMatch('0 9 * * 1', tue0900), 'cron Tue no match (dow)');
  ok(cronMatch('*/15 * * * *', new Date(2026, 5, 22, 13, 30)), 'cron */15 matches :30');
  ok(!cronMatch('*/15 * * * *', new Date(2026, 5, 22, 13, 31)), 'cron */15 no match :31');
  ok(cronMatch('0 9-17 * * 1-5', new Date(2026, 5, 22, 14, 0)), 'cron range hour+dow matches');
  ok(!cronMatch('bad', mon0900), 'cron malformed → false');
  console.log('match.mjs self-check OK');
}
