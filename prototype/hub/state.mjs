// state.mjs — hub の永続 JSON store。atomic write(temp+rename)で torn-write を撲滅。
// 真の崖は「run 並行の last-write-wins」ではなく「writeFileSync 書込中のクラッシュで JSON が truncate→
// 次 load で空が返り全 state 消失」。rename は POSIX で原子的＝reader は半端ファイルを絶対に見ない。
// 将来の multi-process lock / per-key 書込 / DB 化はこの1モジュールに入れる seam（ROADMAP「崖の地図」）。
import fs from 'node:fs';

// 原子的書込: 対象と同ディレクトリに temp(.tmp.<pid>)を書き renameSync で差替。
// 同ディレクトリ＝必ず同 FS なので cross-device(EXDEV)にならない。pid 付きで別プロセスの temp と衝突しない。
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// state(inbox.json)の owner。1プロセス1 object（読み手は load 1か所）＝save は原子書込のみで足りる。
export function createStore(file) {
  const state = readJson(file, { handoffs: [], agents: {} });
  const save = () => { try { writeJsonAtomic(file, state); } catch (e) { console.error('[hub] save failed', e.message); } };
  return { state, save };
}
