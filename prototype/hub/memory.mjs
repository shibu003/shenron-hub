// memory.mjs — cross-session memory store. ~/.giogio/memory.json に [{id,text,tags,createdAt}]。
// ponytail: per-machine local JSON; embedding 無しの keyword/tag マッチ（server.mjs searchIndex と同型）。秘密値は入れない前提だが量制御は topN で。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DIR = path.join(os.homedir(), '.giogio');
const FILE = path.join(DIR, 'memory.json');
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const write = (rows) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(rows), { mode: 0o600 }); };

export function addMemory(text, tags = []) {
  if (!text || !String(text).trim()) throw new Error('text required');
  const row = { id: randomUUID().slice(0, 8), text: String(text).trim(), tags: Array.isArray(tags) ? tags : String(tags).split(/[ ,]+/).filter(Boolean), createdAt: new Date().toISOString() };
  const rows = read(); rows.push(row); write(rows);
  return { id: row.id, stored: true, count: rows.length };
}

export function listMemories() { return read(); }

export function deleteMemory(id) {
  const rows = read(); const next = rows.filter((r) => r.id !== id);
  write(next);
  return { id, deleted: rows.length !== next.length, count: next.length };
}

// server.mjs ~66-76 の score/searchIndex と同じ keyword スコアラ（tag は重み2）。query 未指定なら新しい順に topN。
export function relevantMemories(query = '', topN = 3) {
  const rows = read(); if (!rows.length) return [];
  const q = String(query || '').toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return rows.slice(-topN).reverse();
  const scored = rows.map((r) => {
    const hay = r.text.toLowerCase();
    const tagHay = (r.tags || []).join(' ').toLowerCase();
    const s = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0) + (tagHay.includes(t) ? 2 : 0), 0);
    return { r, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, topN).map((x) => x.r);
}
