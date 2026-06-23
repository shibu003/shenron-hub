// vault.mjs — credential store. macOS Keychain primary (security command), file fallback.
// ponytail: per-machine local store only; values never in repo or env files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SVC = 'shenron-hub';
const DIR = path.join(os.homedir(), '.shenron');
const META = path.join(DIR, 'credential-index.json'); // key names only
const FILE = path.join(DIR, 'credentials.json');      // non-mac: base64-obfuscated values
const mac = process.platform === 'darwin';

const readMeta = () => { try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch { return []; } };
const saveMeta = (ids) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(META, JSON.stringify([...new Set(ids)])); };
const readFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };

export function setCredential(id, value) {
  if (mac) {
    try { execFileSync('security', ['delete-generic-password', '-a', SVC, '-s', id], { stdio: 'ignore' }); } catch {}
    execFileSync('security', ['add-generic-password', '-a', SVC, '-s', id, '-w', value], { stdio: 'ignore' });
  } else {
    fs.mkdirSync(DIR, { recursive: true });
    const all = readFile(); all[id] = Buffer.from(value).toString('base64'); // ponytail: obfuscation, not encryption; add AES if needed
    fs.writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 });
  }
  saveMeta([...readMeta(), id]);
  return { id, stored: true, backend: mac ? 'keychain' : 'file' };
}

export function getCredential(id) {
  if (mac) {
    try { return execFileSync('security', ['find-generic-password', '-a', SVC, '-s', id, '-w'], { encoding: 'utf8' }).trim(); } catch { return null; }
  }
  const v = readFile()[id]; return v ? Buffer.from(v, 'base64').toString() : null;
}

export function listCredentials() { return readMeta(); }

export function deleteCredential(id) {
  if (mac) { try { execFileSync('security', ['delete-generic-password', '-a', SVC, '-s', id], { stdio: 'ignore' }); } catch {} }
  else { const all = readFile(); delete all[id]; fs.writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 }); }
  saveMeta(readMeta().filter((x) => x !== id));
  return { id, deleted: true };
}
