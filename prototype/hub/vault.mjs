// vault.mjs — credential store. macOS Keychain primary (security command), file fallback.
// 非Mac fallback は AES-256-GCM で at-rest 暗号化（旧 base64 は誤 commit / backup 同期漏れ / casual 閲覧に無防備だった）。
// master key: SHENRON_VAULT_KEY env(64hex・managed/Fly で鍵をディスク外に) → 無ければ ~/.shenron/vault-master.key(0600 生成)。
// 脅威モデル: ~/.shenron を read できる攻撃者には鍵も ciphertext も渡る（= unlocked Mac の Keychain と同条件）。
// それ以上を堅くしたい managed は env で鍵を deploy secret に出す。
// ponytail: per-machine local store only; values never in repo or env files.
import { execFileSync } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SVC = 'shenron-hub';
const DIR = path.join(os.homedir(), '.shenron');
const META = path.join(DIR, 'credential-index.json'); // key names only
const FILE = path.join(DIR, 'credentials.json');      // non-mac: AES-256-GCM encrypted values
const KEYF = path.join(DIR, 'vault-master.key');      // non-mac: generated 32-byte master key (0600)
const mac = process.platform === 'darwin' && process.env.SHENRON_VAULT_FORCE_FILE !== '1';   // SHENRON_VAULT_FORCE_FILE=1: 非Mac path を強制（test 用 seam）

const readMeta = () => { try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch { return []; } };
const saveMeta = (ids) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(META, JSON.stringify([...new Set(ids)])); };
const readFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };

// master key を 32 バイト Buffer で返す（env 優先・無ければ生成鍵ファイル・auth.loadSecret と同型）
function vaultKey() {
  const env = process.env.SHENRON_VAULT_KEY;
  if (env) {
    if (!/^[0-9a-f]{64}$/i.test(env)) throw new Error('SHENRON_VAULT_KEY must be 64 hex chars (openssl rand -hex 32)');
    return Buffer.from(env, 'hex');
  }
  try { return Buffer.from(fs.readFileSync(KEYF, 'utf8').trim(), 'hex'); } catch {}
  fs.mkdirSync(DIR, { recursive: true });
  const hex = randomBytes(32).toString('hex');
  fs.writeFileSync(KEYF, hex, { mode: 0o600 });
  return Buffer.from(hex, 'hex');
}

// AES-256-GCM（認証付き＝改竄検出）。format: v1:b64(iv):b64(tag):b64(ciphertext)
function encrypt(value) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', vaultKey(), iv);
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decrypt(blob) {
  if (!blob.startsWith('v1:')) return Buffer.from(blob, 'base64').toString();   // 後方互換: 旧 base64 値を読む（データ損失防止）
  const key = vaultKey();   // 設定エラー（env key が不正 hex）は loud に伝播させる（改竄と混同しない）
  try {
    const [, iv, tag, ct] = blob.split(':');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString();
  } catch { return null; }   // 改竄 / 鍵不一致（valid だが別 key）= fail-closed（値・鍵は log に出さない）
}

export function setCredential(id, value) {
  if (mac) {
    try { execFileSync('security', ['delete-generic-password', '-a', SVC, '-s', id], { stdio: 'ignore' }); } catch {}
    execFileSync('security', ['add-generic-password', '-a', SVC, '-s', id, '-w', value], { stdio: 'ignore' });
  } else {
    fs.mkdirSync(DIR, { recursive: true });
    const all = readFile(); all[id] = encrypt(value);
    fs.writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 });
  }
  saveMeta([...readMeta(), id]);
  return { id, stored: true, backend: mac ? 'keychain' : 'file-aes' };
}

export function getCredential(id) {
  if (mac) {
    try { return execFileSync('security', ['find-generic-password', '-a', SVC, '-s', id, '-w'], { encoding: 'utf8' }).trim(); } catch { return null; }
  }
  const v = readFile()[id]; return v ? decrypt(v) : null;
}

export function listCredentials() { return readMeta(); }

export function deleteCredential(id) {
  if (mac) { try { execFileSync('security', ['delete-generic-password', '-a', SVC, '-s', id], { stdio: 'ignore' }); } catch {} }
  else { const all = readFile(); delete all[id]; fs.writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 }); }
  saveMeta(readMeta().filter((x) => x !== id));
  return { id, deleted: true };
}

// doctor 用: 現在の vault backend を返す（値は触らない）
export function vaultBackend() {
  if (mac) return 'keychain';
  return process.env.SHENRON_VAULT_KEY ? 'aes (env key)' : 'aes (key file ~/.shenron/vault-master.key)';
}
