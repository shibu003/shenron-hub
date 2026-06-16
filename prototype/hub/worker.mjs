#!/usr/bin/env node
// worker.mjs — an agent's PULL-mode poller for the BuildHUD hub. Polls for handoffs addressed to this
// agent, runs the approved ones with its skill (vendor), posts the result back. Works even if this agent
// was OFFLINE when the handoff was sent — the hub held it (durable inbox). PULL is the opposite of
// reviewer-server's PUSH model, and is what makes offline-tolerant delivery possible.
//
//   node prototype/hub/worker.mjs --config prototype/agents/marketing.json [--hub http://localhost:8790] [--vendor stub] [--once]
//
// --vendor overrides the config's vendor (use "stub" for a fast offline demo). --once does a single tick.

import fs from 'node:fs';
import { runVendor } from '../runner.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const cfgPath = argOf('--config'); if (!cfgPath) { console.error('✗ --config <agent.json> required'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const HUB = (argOf('--hub') || 'http://localhost:8795').replace(/\/$/, '');
const VENDOR = argOf('--vendor') || cfg.skill.vendor;
const ONCE = process.argv.includes('--once');
const AGENT = cfg.name;

async function api(p, body) {
  const r = await fetch(`${HUB}${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
}

async function tick() {
  const { runnable } = await api('/api/poll', { agent: AGENT });        // heartbeat (presence) + claim runnable
  for (const h of runnable) {
    if (h.skill !== cfg.skill.id) { await api(`/api/handoffs/${h.id}/result`, { error: `agent ${AGENT} does not serve skill "${h.skill}"` }); continue; }
    console.log(`▶ ${AGENT} running ${h.id} (${h.skill}) from ${h.from} — ${VENDOR}`);
    let result, error;
    try { result = runVendor(VENDOR, `${cfg.skill.systemPrompt}\n\n--- INPUT ---\n${h.input}\n--- END INPUT ---`, cfg.skill.stub); }
    catch (e) { error = e.message; }
    await api(`/api/handoffs/${h.id}/result`, error ? { error } : { result });
    console.log(`✓ ${AGENT} posted ${error ? 'error' : 'result'} for ${h.id} (${(result || error || '').length}B)`);
  }
  return runnable.length;
}

console.log(`[worker] ${AGENT} polling ${HUB}  skill=${cfg.skill.id} vendor=${VENDOR}${ONCE ? ' (once)' : ''}`);
if (ONCE) tick().then((n) => { console.log(`done — ${n} run`); process.exit(0); }).catch((e) => { console.error('✗', e.message); process.exit(1); });
else { const loop = () => tick().catch((e) => console.error('tick:', e.message)); loop(); setInterval(loop, 3000); }
