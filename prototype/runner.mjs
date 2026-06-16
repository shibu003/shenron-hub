// runner.mjs — single place to run a skill prompt against a vendor CLI (codex | claude) or a stub.
// Shared by the hub worker (and a candidate for reviewer-server.mjs / agents/agent.mjs to adopt later,
// to collapse the three copies of this spawn logic into one — "big simple part", философия #2).
import { spawnSync, spawn } from 'node:child_process';

// Async sibling of runVendor — for the HUB's in-process executor, which must NOT block its event loop
// on a 180s LLM call (the worker.mjs process can use the sync one; the single-process hub cannot).
export function runVendorAsync(vendor, prompt, stub = '') {
  const stubOut = stub || `[stub] (no vendor "${vendor}")`;
  if (vendor !== 'codex' && vendor !== 'claude') return Promise.resolve(stubOut);
  const [cmd, args] = vendor === 'codex'
    ? ['codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]]
    : ['claude', ['-p', prompt]];
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
