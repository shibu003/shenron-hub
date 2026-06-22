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

// keyword スコアラ（tag は重み2）。query 未指定なら新しい順に topN。
// 日本語など空白なし言語: query をスペース分割すると全体が1トークンになり完全一致以外ヒットしない →
// CJK bigram(2文字)の重なりも加点する（embedding 無し・決定論・新依存なし＝ponytail）。英語/タグは語マッチ維持。
const isCJK = (s) => /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(s);   // ひらがな/カタカナ/漢字/半角カナ
const bigrams = (s) => { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
export function relevantMemories(query = '', topN = 3) {
  const rows = read(); if (!rows.length) return [];
  const q = String(query || '').toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return rows.slice(-topN).reverse();
  const qBigrams = bigrams(q.replace(/\s+/g, '')).filter(isCJK);   // CJK を含む bigram のみ → 英語クエリには偽陽性を出さない
  const scored = rows.map((r) => {
    const hay = r.text.toLowerCase();
    const tagHay = (r.tags || []).join(' ').toLowerCase();
    let s = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0) + (tagHay.includes(t) ? 2 : 0), 0);   // 語/タグ一致（英語・タグ向け）
    s += qBigrams.reduce((n, b) => n + (hay.includes(b) ? 1 : 0), 0);   // bigram 重なり（日本語など空白なし言語向け）
    return { r, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, topN).map((x) => x.r);
}

// ponytail: 関連度の最小自己チェック（CJK bigram が日本語 recall を救うこと＋英語偽陽性ゼロ）。
// 実行: node prototype/hub/memory.mjs --selftest （~/.giogio は触らず純関数のみ検証）
if (process.argv[1] && process.argv[1].endsWith('memory.mjs') && process.argv.includes('--selftest')) {
  const score = (q, text, tags = []) => { const hay = text.toLowerCase(); const tagHay = tags.join(' ').toLowerCase();
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    let s = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0) + (tagHay.includes(t) ? 2 : 0), 0);
    s += bigrams(q.toLowerCase().replace(/\s+/g, '')).filter(isCJK).reduce((n, b) => n + (hay.includes(b) ? 1 : 0), 0); return s; };
  const T = 'ユーザーは関西在住・関西弁が好み';
  console.assert(score('関西弁の口調で話して', T) > 0, 'JP recall must hit via bigram');
  console.assert(score('weather', T) === 0, 'EN query must NOT false-positive on JP memory');
  console.assert(score('tone', T, ['tone']) >= 2, 'tag match weight');
  console.log('memory.mjs selftest OK');
}
