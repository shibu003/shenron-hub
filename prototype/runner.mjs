// runner.mjs — single place to run a skill prompt against a vendor CLI (codex | claude) or a stub.
// Shared by the hub worker (and a candidate for reviewer-server.mjs / agents/agent.mjs to adopt later,
// to collapse the three copies of this spawn logic into one — "big simple part", философия #2).
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Async sibling of runVendor — for the HUB's in-process executor, which must NOT block its event loop
// on a 180s LLM call (the worker.mjs process can use the sync one; the single-process hub cannot).
// Cloud/remote path: a Docker'd hub has no `claude` CLI, so route the 'claude' vendor to the Anthropic API
// when ANTHROPIC_API_KEY is set (local dev keeps spawning `claude -p` = BYO subscription, 従量0).
// Same contract as runVendorAsync: resolves to the model's text, or a `[... → stub]` fallback string on failure.
// ponytail: raw fetch (Node ≥18 global), no SDK dep; no streaming — 16k max_tokens is well under the HTTP timeout.
async function runAnthropicApi(prompt, stub = '', model) {
  model = model || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';   // per-call model (Wave G: flow の step ごとに別モデル) > env > 既定
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) { const e = await r.text().catch(() => ''); return `[anthropic ${r.status} → stub] ${e.slice(0, 200)}\n` + stub; }
    const j = await r.json();
    if (j.stop_reason === 'refusal') return `[anthropic refusal → stub]\n` + stub;   // safety decline: empty content
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || `[anthropic empty → stub]\n` + stub;
  } catch (e) { return `[anthropic failed → stub] ${e.message}\n` + stub; }
}

// Wave G: ローカル Ollama provider — cheap step を完全無料に（cloud/API path でも cheap だけ $0）。
// `ollama serve` が localhost:11434 で動いてる前提。OLLAMA_HOST / OLLAMA_MODEL で上書き。Win/Linux/Mac 同じ。
async function runOllama(prompt, stub = '', model) {
  model = model || process.env.OLLAMA_MODEL || 'llama3.2';
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const r = await fetch(`${host}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt, stream: false }) });
    if (!r.ok) { const e = await r.text().catch(() => ''); return `[ollama ${r.status} → stub] ${e.slice(0, 150)}\n` + stub; }
    const j = await r.json();
    return String(j.response || '').trim() || `[ollama empty → stub]\n` + stub;
  } catch (e) { return `[ollama failed → stub] ${e.message} (is \`ollama serve\` running?)\n` + stub; }
}

// Wave G: clean OpenAI/GPT provider（chat/completions・BYO OPENAI_API_KEY）。判断=Claude/別視点=GPT/合議 用。
async function runOpenAiApi(prompt, stub = '', model) {
  model = model || process.env.OPENAI_MODEL || 'gpt-4o-mini';   // 現行モデル名は OPENAI_MODEL で（config/env）。不正なら API が 400 → stub に理由が出る
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) { const e = await r.text().catch(() => ''); return `[openai ${r.status} → stub] ${e.slice(0, 200)}\n` + stub; }
    const j = await r.json();
    return String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim() || `[openai empty → stub]\n` + stub;
  } catch (e) { return `[openai failed → stub] ${e.message}\n` + stub; }
}

// Wave G: Gemini provider（generativeLanguage v1beta・BYO GEMINI_API_KEY）。consensus 既定 vendor の1つ＝これが無いと既定合議が stub 混入していた。
// ponytail: key は x-goog-api-key ヘッダで（URL query に載せない＝ログ漏れ防止）。model は GEMINI_MODEL で上書き（不正なら API が 404/400 → stub に理由）。
async function runGeminiApi(prompt, stub = '', model) {
  model = model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!r.ok) { const e = await r.text().catch(() => ''); return `[gemini ${r.status} → stub] ${e.slice(0, 200)}\n` + stub; }
    const j = await r.json();
    const c = j.candidates && j.candidates[0];
    if (!c) return `[gemini blocked → stub] ${(j.promptFeedback && j.promptFeedback.blockReason) || 'no candidates'}\n` + stub;   // safety block: empty candidates
    const text = ((c.content && c.content.parts) || []).map((p) => p.text || '').join('').trim();
    return text || `[gemini empty → stub]\n` + stub;
  } catch (e) { return `[gemini failed → stub] ${e.message}\n` + stub; }
}

// T0（test 基盤）: 決定的 planner seam。`--vendor mock` + env SHENRON_MOCK_PLANNER=<生 planner 出力(JSON 配列)のパス> で
// HTTP/E2E から planner を決定化する。queue はモジュール level state＝runner は hub に 1 回 import されるので index がプロセス内で持続
// （1 boot=1 シナリオ・reset=hub 再起動 or 別 STATE_DIR）。dispatch 窓口 1 箇所ゆえ plan/node 実行/goal_suggest 全てが mock を通る。
let _mockQueue = null, _mockIdx = 0;
export function runVendorAsync(vendor, prompt, stub = '', { model } = {}) {   // Wave G: opts.model = この呼び出しだけ別モデル（flow の step ごと routing）
  const stubOut = stub || `[stub] (no vendor "${vendor}")`;
  if (vendor === 'mock') {   // 1 コールずつ shift。文字列は生 planner 出力／オブジェクトは JSON.stringify。
    if (_mockQueue === null) { try { _mockQueue = JSON.parse(readFileSync(process.env.SHENRON_MOCK_PLANNER, 'utf8')); } catch { _mockQueue = []; } }
    if (!_mockQueue.length) return Promise.resolve(stubOut);   // 未設定/空 → 生 stub sentinel（plan が isStubFail→unavailable へ・無害な退行）
    const r = _mockIdx < _mockQueue.length ? _mockQueue[_mockIdx++] : _mockQueue[_mockQueue.length - 1];   // ponytail: 枯渇→最後を再利用（1 プロセス 1 シナリオ）
    return Promise.resolve(typeof r === 'string' ? r : JSON.stringify(r));
  }
  if (vendor === 'ollama') return runOllama(prompt, stub, model);   // ローカル無料（cheap step 用）
  if (vendor === 'openai' || vendor === 'gpt') return process.env.OPENAI_API_KEY ? runOpenAiApi(prompt, stub, model) : Promise.resolve(`[openai → stub] OPENAI_API_KEY 未設定\n` + stub);   // clean GPT（BYO-key）
  if (vendor === 'gemini' || vendor === 'google') return process.env.GEMINI_API_KEY ? runGeminiApi(prompt, stub, model) : Promise.resolve(`[gemini → stub] GEMINI_API_KEY 未設定\n` + stub);   // Gemini（BYO-key・consensus 既定の1つ）
  if (vendor === 'claude' && process.env.ANTHROPIC_API_KEY) return runAnthropicApi(prompt, stub, model);   // cloud: no CLI → direct API
  if (vendor !== 'codex' && vendor !== 'claude') return Promise.resolve(stubOut);
  const [cmd, args] = vendor === 'codex'
    ? ['codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]]
    : ['claude', model ? ['-p', '--model', model, prompt] : ['-p', prompt]];
  return new Promise((resolve) => {
    let out = '', err = '', child;
    const fail = (why) => resolve(`[${vendor} failed → stub] ${why}\n` + stub);
    try { child = spawn(cmd, args, { timeout: 180000 }); } catch (e) { return fail(e.message); }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => fail(e.message));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : `[${vendor} failed → stub] ${err.trim() || 'exit ' + code}\n` + stub));
  });
}

export function runVendor(vendor, prompt, stub = '') {
  const fallback = (tag, r) => `[${tag} failed → stub] ${r.error?.message || (r.stderr || '').trim() || 'exit ' + r.status}\n` + stub;
  if (vendor === 'codex') {
    // codex exec is non-interactive by default — no --ask-for-approval flag in 0.137.x (docs/08 §5)
    const r = spawnSync('codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
    return r.status === 0 && r.stdout?.trim() ? r.stdout.trim() : fallback('codex', r);
  }
  if (vendor === 'claude') {
    const r = spawnSync('claude', ['-p', prompt], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
    return r.status === 0 && r.stdout?.trim() ? r.stdout.trim() : fallback('claude', r);
  }
  return stub || `[stub] (no vendor "${vendor}")`;
}
