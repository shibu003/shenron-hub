// test_all.mjs — このディレクトリの test_*.mjs を全部子プロセスで走らせ pass/fail を集計する。
// run: node prototype/hub/test_all.mjs  （exit 0=all green / 1=どれか fail）。新 test を足すだけで自動で対象に入る。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => /^test_.*\.mjs$/.test(f) && f !== 'test_all.mjs').sort();
const tail = (s) => String(s || '').trim().split('\n').slice(-12).join('\n').replace(/^/gm, '    ');

let fail = 0;
for (const f of files) {
  const r = spawnSync('node', [path.join(dir, f)], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}`);
  if (!ok) {                                                       // 失敗 file だけ末尾を出す（決定的な数行・全 dump しない）
    if (r.stdout) console.log('  ── stdout ──\n' + tail(r.stdout));
    if (r.stderr) console.log('  ── stderr ──\n' + tail(r.stderr));
  }
}
console.log(`\n${files.length - fail}/${files.length} green`);
process.exit(fail ? 1 : 0);
