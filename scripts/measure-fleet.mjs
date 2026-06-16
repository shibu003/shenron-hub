#!/usr/bin/env node
// measure-fleet.mjs — read-only sizing of an AI-coding "fleet" from local agent logs.
// Purpose: cheaply test R3 (does the mixed-vendor fleet-operator persona exist?) and
//          confirm the §4 contextFillPct fix (R2) on real data, before writing any product code.
//
// Reads ONLY local log files (no network, no writes). Safe to share with recruited builders
// so they can run it on their own machine and report the numbers.
//
//   node scripts/measure-fleet.mjs [--days=14] [--bin=5] [--top=8] [--json]
//
//   --days N   window to analyze (default 14)
//   --bin  M   concurrency bin size in minutes (default 5) — "active within the same M-min bucket" = concurrent
//   --top  K   how many recent sessions to show context-fill for (default 8)
//   --json     also print a machine-readable JSON summary block at the end

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// ---------- args ----------
const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  if (m) return m.split('=')[1];
  if (process.argv.includes(`--${k}`)) return true;
  return d;
};
const DAYS = Number(arg('days', 14));
const BIN_MIN = Number(arg('bin', 5));
const TOP = Number(arg('top', 8));
const JSON_OUT = !!arg('json', false);
const SINCE = Date.now() - DAYS * 86400_000;
const BIN_MS = BIN_MIN * 60_000;

// Model -> context window. The jsonl does NOT store the window or the [1m] suffix (see 04/IA2),
// so we show BOTH 200k and 1M and let the human pick. Override here if you know the true window.
const DEFAULT_WINDOW = 200_000;

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');

// Codex/Gemini are best-effort presence detection (paths vary by version).
const CODEX_CANDIDATES = [
  path.join(HOME, '.codex', 'sessions'),
  path.join(HOME, '.codex', 'log'),
  path.join(HOME, '.codex'),
  path.join(HOME, '.config', 'codex'),
];
const GEMINI_CANDIDATES = [
  path.join(HOME, '.gemini', 'tmp'),
  path.join(HOME, '.gemini'),
  path.join(HOME, '.config', 'gemini'),
];

// ---------- helpers ----------
function walkJsonl(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(p));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function detectVendor(candidates) {
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isDirectory()) {
        const files = fs.readdirSync(c);
        // count recently-touched files as a rough "did they use it lately" signal
        let recent = 0;
        for (const f of files) {
          try {
            const fst = fs.statSync(path.join(c, f));
            if (fst.mtimeMs >= SINCE) recent++;
          } catch {}
        }
        if (files.length > 0) return { path: c, files: files.length, recent };
      }
    } catch {}
  }
  return null;
}

async function readSession(file) {
  // returns { mtime, projectDir, bins:Set<number>, msgs, firstTs, lastTs, model, lastUsage, cumulative }
  const projectDir = path.basename(path.dirname(file));
  const bins = new Set();
  let msgs = 0, firstTs = null, lastTs = null, model = null;
  let lastUsage = null;
  let cumulative = 0; // sum of ALL token fields across ALL assistant turns (the BROKEN old formula)
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (ts >= SINCE) bins.add(Math.floor(ts / BIN_MS));
      firstTs = firstTs === null ? ts : Math.min(firstTs, ts);
      lastTs = lastTs === null ? ts : Math.max(lastTs, ts);
      msgs++;
    }
    const u = o?.message?.usage;
    if (u) {
      const inSide = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      cumulative += inSide + (u.output_tokens || 0);
      lastUsage = u; // keep the latest usage seen
      if (o?.message?.model) model = o.message.model;
    }
  }
  return { file, projectDir, bins, msgs, firstTs, lastTs, model, lastUsage, cumulative };
}

function fmtPct(n) { return n === null ? '  n/a' : `${n.toFixed(0).padStart(4)}%`; }
function fmtInt(n) { return String(n).padStart(6); }
function ago(ts) {
  if (ts == null) return 'never';
  const m = (Date.now() - ts) / 60000;
  if (m < 60) return `${m.toFixed(0)}m ago`;
  if (m < 1440) return `${(m / 60).toFixed(0)}h ago`;
  return `${(m / 1440).toFixed(0)}d ago`;
}

// ---------- main ----------
const files = walkJsonl(CLAUDE_DIR);
if (files.length === 0) {
  console.error(`No Claude Code logs found under ${CLAUDE_DIR}.`);
  console.error('If you use Claude Code on another machine, run this there too and add the numbers.');
}

const sessionsAll = [];
for (const f of files) sessionsAll.push(await readSession(f));

// sessions active within the window
const sessions = sessionsAll.filter((s) => s.lastTs != null && s.lastTs >= SINCE);
const projects = new Set(sessions.map((s) => s.projectDir));

// peak concurrency: tally how many distinct sessions touched each time-bin
const binCount = new Map();
for (const s of sessions) for (const b of s.bins) binCount.set(b, (binCount.get(b) || 0) + 1);
let peak = 0;
const hist = new Map(); // concurrency level -> # of bins at that level
for (const c of binCount.values()) { peak = Math.max(peak, c); hist.set(c, (hist.get(c) || 0) + 1); }

// vendors
const codex = detectVendor(CODEX_CANDIDATES);
const gemini = detectVendor(GEMINI_CANDIDATES);
const vendors = ['claude-code', codex && 'codex', gemini && 'gemini'].filter(Boolean);

// ---------- output ----------
const L = (s = '') => console.log(s);
L('═'.repeat(64));
L(`  FLEET SIZING  —  window: last ${DAYS} days  •  host: ${os.hostname()}`);
L('═'.repeat(64));
L();
L('  R3 — does the mixed-vendor fleet-operator persona exist? (this machine)');
L('  ' + '-'.repeat(60));
L(`  Claude Code sessions (active in window) : ${fmtInt(sessions.length).trim()}  (of ${sessionsAll.length} total)`);
L(`  Distinct project roots                  : ${projects.size}`);
L(`  Peak CONCURRENT sessions (${BIN_MIN}-min bins)   : ${peak}`);
if (hist.size) {
  L(`  Concurrency histogram (level → #bins)   :`);
  [...hist.entries()].sort((a, b) => a[0] - b[0]).forEach(([lvl, n]) => {
    L(`      ${String(lvl).padStart(2)} parallel : ${'█'.repeat(Math.min(40, n))} ${n}`);
  });
}
L();
L(`  Vendors detected on THIS machine        : ${vendors.join(', ')}`);
L(`      claude-code : ${files.length} session files`);
L(`      codex       : ${codex ? `${codex.files} files (${codex.recent} recent) @ ${codex.path}` : 'not found'}`);
L(`      gemini      : ${gemini ? `${gemini.files} files (${gemini.recent} recent) @ ${gemini.path}` : 'not found'}`);
L();
L('  ⚠ Cannot auto-detect "across machines" from one host. SELF-REPORT:');
L('      # of machines you run agents on in a typical week : ____');
L('      Run this script on EACH and sum the numbers.');
L();

// context fill (R2 formula fix) — most recent sessions
const recent = [...sessions].sort((a, b) => b.lastTs - a.lastTs).slice(0, TOP);
L('  R2 — context-fill formula check (§4 fix vs old broken formula)');
L('  ' + '-'.repeat(60));
L('  fill% = last-request input-side ÷ window   (NOT cumulative ÷ window)');
L('  input-side = input_tokens + cache_read + cache_creation');
L();
L('   last        model                  fill@200k  fill@1M    OLD(cum/200k)');
for (const s of recent) {
  const u = s.lastUsage;
  const inSide = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
  const f200 = inSide == null ? null : (inSide / 200_000) * 100;
  const f1m = inSide == null ? null : (inSide / 1_000_000) * 100;
  const old = (s.cumulative / DEFAULT_WINDOW) * 100;
  const model = (s.model || '—').replace('claude-', '').slice(0, 20).padEnd(20);
  L(`   ${ago(s.lastTs).padEnd(9)} ${model}  ${fmtPct(f200)}     ${fmtPct(f1m)}     ${fmtPct(old)}`);
}
L();
L('  → If OLD column is wildly >100% while fill@(correct window) is sane,');
L('    the old "cumulative ÷ window" formula is confirmed broken on YOUR data.');
L('  → The correct window is NOT in the jsonl (model lacks the [1m] suffix);');
L('    pick 200k vs 1M per the model you actually run.');
L();
L('═'.repeat(64));

if (JSON_OUT) {
  const summary = {
    host: os.hostname(), windowDays: DAYS, binMinutes: BIN_MIN,
    claudeSessionsInWindow: sessions.length, claudeSessionsTotal: sessionsAll.length,
    distinctProjects: projects.size, peakConcurrent: peak,
    concurrencyHistogram: Object.fromEntries([...hist.entries()].sort((a, b) => a[0] - b[0])),
    vendorsDetected: vendors,
    codex: codex || null, gemini: gemini || null,
    recentContextFill: recent.map((s) => {
      const u = s.lastUsage;
      const inSide = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
      return {
        lastTs: s.lastTs, model: s.model, inputSideTokens: inSide,
        fillPct200k: inSide == null ? null : +((inSide / 200_000) * 100).toFixed(1),
        fillPct1m: inSide == null ? null : +((inSide / 1_000_000) * 100).toFixed(1),
        oldCumulativePct200k: +((s.cumulative / DEFAULT_WINDOW) * 100).toFixed(1),
      };
    }),
  };
  L('\nJSON_SUMMARY ' + JSON.stringify(summary));
}
