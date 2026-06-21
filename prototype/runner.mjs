// runner.mjs — single place to run a skill prompt against a vendor CLI (codex | claude) or a stub.
// Shared by the hub worker (and a candidate for reviewer-server.mjs / agents/agent.mjs to adopt later,
// to collapse the three copies of this spawn logic into one — "big simple part", философия #2).
import { spawnSync, spawn } from 'node:child_process';

// Async sibling of runVendor — for the HUB's in-process executor, which must NOT block its event loop
// on a 180s LLM call (the worker.mjs process can use the sync one; the single-process hub cannot).
// Cloud/remote path: a Docker'd hub has no `claude` CLI, so route the 'claude' vendor to the Anthropic API
// when ANTHROPIC_API_KEY is set (local dev keeps spawning `claude -p` = BYO subscription, 従量0).
// Same contract as runVendorAsync: resolves to the model's text, or a `[... → stub]` fallback string on failure.
// ponytail: raw fetch (Node ≥18 global), no SDK dep; no streaming — 16k max_tokens is well under the HTTP timeout.
async function runAnthropicApi(prompt, stub = '', model) {
  model = model || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';   // per-call model (Wave G: flow の step ごとに別モデル) > env > 既定
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) { const e = await r.text().catch(() => ''); return `[anthropic ${r.status} → stub] ${e.slice(0, 200)}\n` + stub; }
    const j = await r.json();
    if (j.stop_reason === 'refusal') return `[anthropic refusal → stub]\n` + stub;   // safety decline: empty content
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || `[anthropic empty → stub]\n` + stub;
  } catch (e) { return `[anthropic failed → stub] ${e.message}\n` + stub; }
}

export function runVendorAsync(vendor, prompt, stub = '', { model } = {}) {   // Wave G: opts.model = この呼び出しだけ別モデル（flow の step ごと routing）
  const stubOut = stub || `[stub] (no vendor "${vendor}")`;
  if (vendor === 'claude' && process.env.ANTHROPIC_API_KEY) return runAnthropicApi(prompt, stub, model);   // cloud: no CLI → direct API
  if (vendor !== 'codex' && vendor !== 'claude') return Promise.resolve(stubOut);
  const [cmd, args] = vendor === 'codex'
    ? ['codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]]
    : ['claude', model ? ['-p', '--model', model, prompt] : ['-p', prompt]];
  return new Promise((resolve) => {
    let out = '', err = '', child;
    const fail = (why) => resolve(`[${vendor} failed → stub] ${why}\n` + stub);
    try { child = spawn(cmd, args, { timeout: 180000 }); } catch (e) { return fail(e.message); }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => fail(e.message));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : `[${vendor} failed → stub] ${err.trim() || 'exit ' + code}\n` + stub));
  });
}

export function runVendor(vendor, prompt, stub = '') {
  const fallback = (tag, r) => `[${tag} failed → stub] ${r.error?.message || (r.stderr || '').trim() || 'exit ' + r.status}\n` + stub;
  if (vendor === 'codex') {
    // codex exec is non-interactive by default — no --ask-for-approval flag in 0.137.x (docs/08 §5)
    const r = spawnSync('codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
    return r.status === 0 && r.stdout?.trim() ? r.stdout.trim() : fallback('codex', r);
  }
  if (vendor === 'claude') {
    const r = spawnSync('claude', ['-p', prompt], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
    return r.status === 0 && r.stdout?.trim() ? r.stdout.trim() : fallback('claude', r);
  }
  return stub || `[stub] (no vendor "${vendor}")`;
}
