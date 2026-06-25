// doctor.mjs — Wave N-3: セットアップ診断（CLI + /api/doctor 共有ロジック）
import net from 'node:net';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultBackend } from './vault.mjs';   // Wave Vault-1: credential 暗号化 backend の可視化

const DEFAULT_PORT = Number(process.env.PORT) || 8795;

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));       // EADDRINUSE → in use
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

export async function runDoctor(port = DEFAULT_PORT) {
  const checks = [];

  // 1. Node version
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node ≥20',
    ok: major >= 20,
    detail: process.version,
    fix: major < 20 ? 'https://nodejs.org でインストール（または `nvm install 20`）' : null,
  });

  // 2. Playwright Chromium browsers
  const pwCaches = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')]
    : [path.join(os.homedir(), '.cache', 'ms-playwright'), '/ms-playwright'];
  const pwOk = pwCaches.some(d => existsSync(d) && readdirSync(d).some(f => f.startsWith('chromium')));
  checks.push({
    name: 'Playwright Chromium',
    ok: pwOk,
    detail: pwOk ? '検出済み' : '未インストール（browser-control に必要）',
    fix: pwOk ? null : 'npx playwright install chromium',
  });

  // 3. Port availability
  const portFree = await checkPort(port);
  checks.push({
    name: `Port ${port}`,
    ok: portFree,
    detail: portFree ? '空き' : '使用中（別プロセスが占有しています）',
    fix: portFree ? null : `PORT=<別ポート> node bin/shenron.mjs  または  lsof -i :${port} で確認`,
  });

  // 4. A2A_SHARED_TOKEN（未設定は warn=true、ok=true — 開発用途では許容）
  const hasToken = !!process.env.A2A_SHARED_TOKEN;
  checks.push({
    name: 'A2A_SHARED_TOKEN',
    ok: true,
    warn: !hasToken,
    detail: hasToken ? '設定済み' : '未設定（openDev モード — 本番前に設定してください）',
    fix: hasToken ? null : 'export A2A_SHARED_TOKEN=$(openssl rand -hex 32)  を ~/.zshrc に追加',
  });

  // 5. users.json（未登録は info — 起動後に作れる）
  const usersPath = path.join(os.homedir(), '.shenron', 'users.json');
  let userCount = 0;
  try { userCount = JSON.parse(readFileSync(usersPath, 'utf8')).length; } catch {}
  checks.push({
    name: 'ユーザー登録',
    ok: true,
    warn: userCount === 0,
    detail: userCount === 0 ? '未登録（ハブ起動後に POST /api/auth/register で作成）' : `${userCount} 件登録済み`,
    fix: userCount === 0 ? 'node bin/shenron.mjs を起動後: curl -s localhost:8795/api/auth/register -H "content-type: application/json" -d \'{"email":"you@example.com","password":"pw"}\'' : null,
  });

  // 6. Vault backend（Wave Vault-1: 非Mac は AES-256-GCM・info 表示）
  checks.push({
    name: 'Credential vault',
    ok: true,
    detail: vaultBackend(),
    fix: null,
  });

  const allOk = checks.every(c => c.ok);
  const hasWarn = checks.some(c => c.warn);
  return { checks, allOk, hasWarn };
}
