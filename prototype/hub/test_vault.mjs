// test_vault.mjs — Wave Vault-1: 非Mac vault の AES-256-GCM。
// HOME を tmpdir に振り（~/.shenron を隔離）SHENRON_VAULT_FORCE_FILE=1 で非Mac path を強制（Mac でも file-aes を検証）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'vault-home-'));
process.env.HOME = HOME;                       // os.homedir() → tmpdir（vault DIR 隔離）
process.env.SHENRON_VAULT_FORCE_FILE = '1';    // 非Mac path 強制（test seam）
delete process.env.SHENRON_VAULT_KEY;          // まず file-key path

const { setCredential, getCredential, deleteCredential, listCredentials, vaultBackend } = await import('./vault.mjs');
const FILE = path.join(HOME, '.shenron', 'credentials.json');
const readRaw = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

// 1. round-trip（multi-line / UTF-8 を含む）
const secret = 'sk-live-値\nline2-日本語-🐉';
setCredential('api', secret);
assert.equal(getCredential('api'), secret, 'round-trip multi-line/UTF-8');
assert.deepEqual(listCredentials().includes('api'), true, 'listed');

// 2. format: 暗号化済み（v1: 接頭辞・base64 平文でない）
assert.ok(readRaw().api.startsWith('v1:'), 'stored value is AES blob (v1:)');
assert.ok(!readRaw().api.includes(Buffer.from(secret).toString('base64')), 'not raw base64');

// 3. 改竄検出: ciphertext を1バイト書換 → get が null（GCM auth）
const all = readRaw();
const parts = all.api.split(':'); const ct = parts[3];
parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);   // 先頭1文字を別の base64 文字に
all.api = parts.join(':'); fs.writeFileSync(FILE, JSON.stringify(all));
assert.equal(getCredential('api'), null, 'tampered ciphertext → null (fail-closed)');

// 4. legacy 後方互換: 素の base64 値（v1: 無し）を直接書く → decode して読める
const leg = readRaw(); leg.old = Buffer.from('legacy-plain').toString('base64'); fs.writeFileSync(FILE, JSON.stringify(leg));
assert.equal(getCredential('old'), 'legacy-plain', 'legacy base64 still readable');

// 5. env key: SHENRON_VAULT_KEY で暗号化 → 同 key で読め、違う key では null
const keyA = '11'.repeat(32), keyB = '22'.repeat(32);   // 64 hex each
process.env.SHENRON_VAULT_KEY = keyA;
setCredential('envcred', 'env-secret');
assert.equal(getCredential('envcred'), 'env-secret', 'env-key round-trip');
process.env.SHENRON_VAULT_KEY = keyB;
assert.equal(getCredential('envcred'), null, 'wrong key → null');
process.env.SHENRON_VAULT_KEY = keyA;
assert.equal(getCredential('envcred'), 'env-secret', 'restore key → readable');

// 6. invalid env key は明確に throw
process.env.SHENRON_VAULT_KEY = 'not-hex';
assert.throws(() => getCredential('envcred'), /64 hex/, 'bad env key throws clear error');
delete process.env.SHENRON_VAULT_KEY;

// 7. backend 表示
assert.match(vaultBackend(), /aes/, 'vaultBackend = aes (file)');

// 8. delete
deleteCredential('api');
assert.equal(listCredentials().includes('api'), false, 'deleted from index');

console.log('OK Vault-1 AES-256-GCM: round-trip / format / tamper / legacy / env-key / bad-key / backend / delete');
