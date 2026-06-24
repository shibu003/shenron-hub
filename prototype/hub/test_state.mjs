// test_state.mjs — Wave Cliff-1: atomic write(temp+rename)の正当性。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { writeJsonAtomic, readJson, createStore } from './state.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
const file = path.join(dir, 'store.json');

// round-trip: 書いた JSON が読み戻せる
writeJsonAtomic(file, { a: 1, nested: { b: [2, 3] } });
assert.deepEqual(readJson(file, null), { a: 1, nested: { b: [2, 3] } }, 'round-trip');

// rename 済 → .tmp.* が残らない（torn の痕跡なし）
assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp.')).length, 0, 'no leftover .tmp file');

// 上書き: 既存ファイルを完全置換（rename 上書き）
writeJsonAtomic(file, { replaced: true });
assert.deepEqual(readJson(file, null), { replaced: true }, 'overwrite replaces content');

// fallback: 壊れた/不在ファイルで fallback を返す
fs.writeFileSync(file, '{ broken json');
assert.deepEqual(readJson(file, { ok: 'fb' }), { ok: 'fb' }, 'corrupt → fallback');
assert.deepEqual(readJson(path.join(dir, 'nope.json'), { ok: 'fb' }), { ok: 'fb' }, 'missing → fallback');

// createStore: 不在ファイルで既定 state、save() で原子書込
const s1 = createStore(path.join(dir, 'inbox.json'));
assert.deepEqual(s1.state, { handoffs: [], agents: {} }, 'createStore default state');
s1.state.runs = { r1: { status: 'done' } };
s1.save();
const s2 = createStore(path.join(dir, 'inbox.json'));   // 別 store で読み直し＝永続化を確認
assert.deepEqual(s2.state.runs, { r1: { status: 'done' } }, 'save persists, reload sees it');

console.log('OK Cliff-1 atomic write: round-trip / no-leftover-tmp / overwrite / fallback / createStore persist');
