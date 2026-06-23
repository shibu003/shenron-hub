#!/usr/bin/env node
// First-run entry point: node check → launch hub.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const HUB = path.join(ROOT, 'prototype', 'hub', 'hub.mjs');

// Wave N-3: doctor サブコマンド（hub 未起動でもチェック可）
if (process.argv[2] === 'doctor') {
  const { runDoctor } = await import(path.join(ROOT, 'prototype', 'hub', 'doctor.mjs'));
  const port = (() => { const i = process.argv.indexOf('--port'); return i > -1 ? Number(process.argv[i + 1]) : Number(process.env.PORT) || 8795; })();
  const { checks } = await runDoctor(port);
  let exitCode = 0;
  for (const c of checks) {
    const icon = !c.ok ? '❌' : c.warn ? '⚠️ ' : '✅';
    console.log(`${icon} ${c.name}: ${c.detail}`);
    if (c.fix) console.log(`   → ${c.fix}`);
    if (!c.ok) exitCode = 1;
  }
  process.exit(exitCode);
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) { console.error(`神龍 requires Node ≥20 (found ${process.version})`); process.exit(1); }
if (!existsSync(HUB)) { console.error(`Hub not found: ${HUB}\nRun from the repo root or reinstall.`); process.exit(1); }

console.log('🐉 神龍 hub starting…');
const child = spawn(process.execPath, [HUB, ...process.argv.slice(2)], { stdio: 'inherit', cwd: ROOT });
child.on('exit', (code) => process.exit(code ?? 0));
