#!/usr/bin/env node
// First-run entry point: node check → launch hub.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const HUB = path.join(ROOT, 'prototype', 'hub', 'hub.mjs');

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) { console.error(`神龍 requires Node ≥20 (found ${process.version})`); process.exit(1); }
if (!existsSync(HUB)) { console.error(`Hub not found: ${HUB}\nRun from the repo root or reinstall.`); process.exit(1); }

console.log('🐉 神龍 hub starting…');
const child = spawn(process.execPath, [HUB, ...process.argv.slice(2)], { stdio: 'inherit', cwd: ROOT });
child.on('exit', (code) => process.exit(code ?? 0));
