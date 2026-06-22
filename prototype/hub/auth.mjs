// auth.mjs — 登録・ログイン・メール認証。外部依存ゼロ(Node.js crypto のみ)。
// Users → ~/.giogio/users.json (mode 0o600)
// Sessions → in-memory Map (再起動で無効化。自己ホスト用途では許容範囲)
// Session secret → ~/.giogio/session-secret.key (初回生成・再起動後も維持)
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'; // timingSafeEqual: パスワード比較用(タイミング攻撃防止)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR   = path.join(os.homedir(), '.giogio');
const USERS = path.join(DIR, 'users.json');
const SKEY  = path.join(DIR, 'session-secret.key');

// Session secret: stable across restarts (generated once)
function loadSecret() {
  try { return fs.readFileSync(SKEY, 'utf8').trim(); } catch {}
  const s = randomBytes(32).toString('hex');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SKEY, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

// ponytail: in-memory sessions; persist to file if multi-user matters later
const sessions = new Map(); // token → { userId, email, expiresAt }

const readUsers = () => { try { return JSON.parse(fs.readFileSync(USERS, 'utf8')); } catch { return []; } };
const saveUsers = (u) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(USERS, JSON.stringify(u, null, 2), { mode: 0o600 }); };

function hashPw(pw, salt) { return scryptSync(pw, salt, 64).toString('hex'); }

function makeToken(userId, expiresAt) {
  const payload = `${userId}.${expiresAt}`;
  const sig = createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

// --- Public API ---

export function register(email, password) {
  if (!email || !password) throw new Error('email and password required');
  const users = readUsers();
  if (users.find((u) => u.email === email)) throw new Error('email already registered');
  const salt       = randomBytes(16).toString('hex');
  const verifyToken = randomBytes(24).toString('hex');
  const user = { id: randomBytes(8).toString('hex'), email, passwordHash: hashPw(password, salt), salt, verified: false, verifyToken, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  return { userId: user.id, email, verifyToken }; // caller prints the link
}

export function verifyEmail(token) {
  const users = readUsers();
  const user = users.find((u) => u.verifyToken === token);
  if (!user) throw new Error('invalid or expired verification token');
  user.verified = true;
  delete user.verifyToken;
  saveUsers(users);
  return { userId: user.id, email: user.email, verified: true };
}

export function login(email, password) {
  const users = readUsers();
  const user = users.find((u) => u.email === email);
  if (!user) throw new Error('invalid credentials');
  if (!user.verified) throw new Error('email not verified — check your terminal for the verification link');
  const hash = Buffer.from(hashPw(password, user.salt), 'hex');
  const stored = Buffer.from(user.passwordHash, 'hex');
  if (hash.length !== stored.length || !timingSafeEqual(hash, stored)) throw new Error('invalid credentials');
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  const token = makeToken(user.id, expiresAt);
  sessions.set(token, { userId: user.id, email: user.email, expiresAt });
  return { token, email: user.email, userId: user.id, expiresAt };
}

export function checkSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
  // ponytail: no cold-start HMAC fallback — sessions clear on hub restart (self-hosted, acceptable)
}

export function logout(token) { sessions.delete(token); return { ok: true }; }

export function listUsers() {
  return readUsers().map(({ id, email, verified, createdAt }) => ({ id, email, verified, createdAt }));
}

export function userCount() { return readUsers().length; }
