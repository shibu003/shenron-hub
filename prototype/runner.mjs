// runner.mjs — single place to run a skill prompt against a vendor CLI (codex | claude) or a stub.
// Shared by the hub worker (and a candidate for reviewer-server.mjs / agents/agent.mjs to adopt later,
// to collapse the three copies of this spawn logic into one — "big simple part", философия #2).
import { spawnSync } from 'node:child_process';

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
