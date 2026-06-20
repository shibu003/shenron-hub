// test_shenron.mjs — Wave 1 self-check for buildPlanIR (pure IR assembly; no LLM).
// run: node prototype/hub/test_shenron.mjs
import assert from 'node:assert';
import { buildPlanIR, suggestionFromSearch, discover, toLangflowFlow, extractCode, genComponent, plan, flowSkill, componentKey, matchComponent, verifyMcpServer } from './shenron.mjs';
import { spawnSync } from 'node:child_process';

const parsed = {
  plain_summary: 'collect commits, summarize, post to Slack',
  steps: [
    { action: 'collect GitHub commits', kind: 'mcp', tool: null },                  // gap — no github tool in inventory
    { action: 'summarize them', kind: 'prompt', tool: null },                       // built-in prompt (not a gap)
    { action: 'post to Slack', kind: 'mcp', tool: 'mcp:slack.post_message' },        // have
  ],
};
const ir = buildPlanIR('weekly commits to Slack', parsed);

assert.equal(ir.steps.length, 3, 'steps');
assert.equal(ir.source, 'llm', 'source');
assert.equal(ir.missing.length, 1, 'exactly one gap');
assert.equal(ir.missing[0].step, 1, 'gap is step 1 (github)');
assert.equal(ir.tools_needed.filter((t) => t.have).length, 1, 'one tool have (slack)');
assert.equal(ir.tools_needed.filter((t) => !t.have).length, 1, 'one tool gap (github)');

// nodes: input + 3 steps + output = 5; linear edges = 4
assert.equal(ir.nodes.length, 5, 'node count');
assert.equal(ir.edges.length, 4, 'edge count (linear)');
assert.equal(ir.nodes[0].kind, 'input'); assert.equal(ir.nodes.at(-1).kind, 'output');
ir.edges.forEach((e, i) => assert.equal(e.source, ir.nodes[i].id, 'edge chains nodes'));

const slack = ir.nodes.find((n) => n.kind === 'mcp');
assert.ok(slack && slack.server === 'slack' && slack.tool === 'post_message', 'slack → mcp node {server,tool}');
assert.ok(ir.nodes.find((n) => n.missing), 'github gap → node flagged missing');

// heuristic fallback shape
const h = buildPlanIR('do a thing', { plain_summary: 'do a thing', steps: [{ action: 'do a thing', kind: 'prompt', tool: null }] }, 'heuristic');
assert.equal(h.nodes.length, 3, 'heuristic: input+prompt+output');
assert.equal(h.missing.length, 0, 'heuristic prompt is not a gap');

// Wave 2 — suggestionFromSearch: minimal shapes (envelope → array | {results})
const env = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });            // MCP tool-result envelope
assert.deepEqual(suggestionFromSearch(env({ results: [{ title: 'GitHub MCP', url: 'https://x/gh' }] })), { title: 'GitHub MCP', url: 'https://x/gh' }, 'envelope→{results}');
assert.deepEqual(suggestionFromSearch([{ url: 'https://y' }]), { title: 'https://y', url: 'https://y' }, 'bare array, url→title fallback');
assert.deepEqual(suggestionFromSearch({ structuredContent: { results: [{ title: 'T', url: 'https://z' }] } }), { title: 'T', url: 'https://z' }, 'structuredContent.results');
assert.equal(suggestionFromSearch({ content: [{ type: 'text', text: 'sorry, no idea' }] }), null, 'prose → null');
assert.equal(suggestionFromSearch(null), null, 'null → null');

// Wave 2 — discover: fills missing[].suggestion, caps at 3, never throws on a bad search
const fakeSearch = async (q) => env({ results: [{ title: `tool for ${q}`, url: 'https://t/' + encodeURIComponent(q) }] });
const gaps = [{ what: 'collect GitHub commits', kind: 'mcp', step: 1 }];
await discover(gaps, fakeSearch);
assert.equal(gaps[0].suggestion.title, 'tool for collect GitHub commits', 'suggestion attached');
assert.equal(gaps[0].suggestion.source, 'external', 'source tagged external');

const many = Array.from({ length: 5 }, (_, i) => ({ what: 'g' + i, kind: 'mcp', step: i }));
await discover(many, fakeSearch);
assert.ok(many[2].suggestion && !many[3].suggestion, 'cap 3: gap[2] filled, gap[3] past cap untouched');

const throwy = async () => { throw new Error('no key'); };
const g2 = [{ what: 'x', kind: 'mcp', step: 1 }];
await discover(g2, throwy);                                                                    // must not throw (graceful fallback)
assert.ok(!g2[0].suggestion, 'search failure → no suggestion, no throw');

// Wave 3 — toLangflowFlow: 描画可能 kind 限定 → 再 import で 🔗 ゼロ + node/edge 数一致（round-trip）。
// LF_KIND の描画可能サブセット（ui.html）を複写: unknown type → 'langflow'(🔗) で検出。
const LF_KIND = { ChatInput: 'input', ChatOutput: 'output', Prompt: 'prompt', AnthropicModel: 'languagemodel', OpenAIModel: 'languagemodel', GoogleGenerativeAIModel: 'languagemodel', StructuredOutput: 'structured' };
const flow = toLangflowFlow(ir);   // ir = github(gap→prompt) + summarize(prompt) + slack(mcp) plan
assert.equal(flow.data.nodes.length, ir.nodes.length, 'node count preserved');
assert.equal(flow.data.edges.length, ir.edges.length, 'edge count preserved');
for (const n of flow.data.nodes) assert.ok(LF_KIND[n.data.type], `node type ${n.data.type} is renderable (🔗 ゼロ)`);   // 全 node が known type
const mcpNode = flow.data.nodes.find((n) => /\[mcp:slack\.post_message\]/.test(n.data.node.template.template?.value || ''));
assert.ok(mcpNode && mcpNode.data.type === 'Prompt', 'mcp step → Prompt placeholder, tool 名は template に残る');
flow.data.edges.forEach((e) => assert.ok(e.data.sourceHandle.output_types.length && e.data.targetHandle.inputTypes.length, 'edge は typed handle'));
assert.equal(flow.data.nodes[0].data.type, 'ChatInput', 'input → ChatInput');
assert.equal(flow.data.nodes.at(-1).data.type, 'ChatOutput', 'output → ChatOutput');
assert.throws(() => toLangflowFlow(null), /nodes\[\]/, 'guard: nodes[] required');

// Wave 4 — extractCode: fenced python → code; prefer python fence; raw fallback.
assert.equal(extractCode('blah\n```python\nx=1\n```\nbye'), 'x=1', 'python fence');
assert.equal(extractCode('```py\ny=2\n```'), 'y=2', 'py fence');
assert.equal(extractCode('```\nz=3\n```'), 'z=3', 'any fence fallback');
assert.equal(extractCode('no fence here'), 'no fence here', 'raw fallback');

// Wave 4 — genComponent repair loop (inject fake run+sandbox; no LLM/python).
const fakeRun = (calls) => async (_v, prompt) => { calls.push(prompt); return '```python\n# gen ' + calls.length + '\n```'; };
// converge on iter1
let c1 = []; let r1 = await genComponent({ what: 'x', run: fakeRun(c1), sandbox: () => ({ ok: true, output: 'real data' }) });
assert.ok(r1.converged && r1.iters === 1 && r1.output === 'real data', 'iter1 converge');
assert.equal(c1.length, 1, 'one LLM call when iter1 converges');
// fail once → repair → converge iter2 (2nd prompt must be the REPAIR prompt carrying the error)
let c2 = []; let n = 0; let r2 = await genComponent({ what: 'fetch stars', run: fakeRun(c2), sandbox: () => (++n === 1 ? { ok: false, error: 'Traceback: NameError boom' } : { ok: true, output: 'ok' }) });
assert.ok(r2.converged && r2.iters === 2, 'converge on iter2 after repair');
assert.ok(/FAILED|Traceback: NameError boom/.test(c2[1]), 'iter2 prompt is repair w/ traceback fed back');
// never converges → converged:false after maxIters, code from last attempt retained
let c3 = []; let r3 = await genComponent({ what: 'y', maxIters: 3, run: fakeRun(c3), sandbox: () => ({ ok: false, error: 'still broken' }) });
assert.ok(!r3.converged && r3.iters === 3 && r3.error === 'still broken' && r3.code === '# gen 3', 'maxIters then give up, keep last code+error');
assert.equal(c3.length, 3, 'maxIters LLM calls');
await assert.rejects(() => genComponent({ what: '   ', run: fakeRun([]), sandbox: () => ({ ok: true }) }), /what required/, 'guard: empty what');

// Wave 5 — refine: context={prev_plan,instruction} → 再生成。run 注入で LLM 不要。
const prev = buildPlanIR('post commits to slack', { plain_summary: 'summarize commits, post to Slack',
  steps: [{ action: 'summarize commits', kind: 'prompt', tool: null }, { action: 'post to Slack', kind: 'mcp', tool: 'mcp:slack.post_message' }] }, 'llm');
const refineRun = async (_v, prompt) => { assert.ok(/REVISING|Requested change/.test(prompt), 'refine prompt used'); assert.ok(/post to Slack/.test(prompt), 'prev steps shown to LLM');
  return JSON.stringify({ plain_summary: 'summarize commits, email it', steps: [{ action: 'summarize commits', kind: 'prompt', tool: null }, { action: 'send email', kind: 'mcp', tool: 'mcp:gmail.send' }] }); };
const refined = await plan({ goal: 'post commits to slack', context: { prev_plan: prev, instruction: 'email instead of Slack' }, run: refineRun });
assert.equal(refined.source, 'refine', 'source=refine');
assert.ok(refined.nodes.find((n) => n.kind === 'mcp' && n.tool === 'send'), 'slack step → email mcp node (changed)');
assert.ok(!refined.nodes.find((n) => n.tool === 'post_message'), 'old slack node gone');
assert.ok(refined.nodes.find((n) => n.kind === 'prompt' && /summarize/.test(n.config.template)), 'untouched summarize step preserved');
// refine の LLM 失敗 → 前 plan を維持（編集を捨てない）
const kept = await plan({ goal: 'x', context: { prev_plan: prev, instruction: 'whatever' }, run: async () => 'no json here' });
assert.equal(kept, prev, 'refine parse fail → prev_plan returned unchanged');
// 初回(context 無し)は従来通り goal 必須
await assert.rejects(() => plan({ goal: '', run: async () => '{}' }), /goal required/, 'initial plan still needs a goal');

// Wave 6 — 実行: a shenron flow is run AS-IS by the hub DAG executor (cockpit ▶ 実行 and MCP run_workflow's isDag
// branch both POST /api/runflow). No per-Wave execution code — the invariant that makes that free is: every node
// kind the planner emits is one hub.mjs fireNode() handles. This pins it; emit a kind fireNode can't run and it fails.
const RUNNABLE = new Set(['input', 'output', 'prompt', 'mcp', 'agent', 'parser', 'languagemodel', 'structured', 'consensus', 'router', 'workflow']);
for (const n of [...ir.nodes, ...refined.nodes]) assert.ok(RUNNABLE.has(n.kind), `plan node kind "${n.kind}" is natively runnable (fireNode handles it)`);
assert.ok(ir.nodes.every((n) => n.kind !== 'mcp' || (n.server && n.tool)), 'mcp nodes carry server+tool → not NODE_UNSET → run button fires');

// Wave 7 — flowSkill: 保存済み flow → SKILL.md（run_workflow ラッパ）。slug は path-safe、frontmatter は YAML-safe、
// body は run_workflow を正しい id/confirm で呼ぶ。これが崩れると local agent が flow を呼べない or 別ディレクトリに書く。
const sk = flowSkill({ id: 'wf_abc123', name: 'Weekly Commits → Slack: digest', summary: 'post a weekly commit digest', nodes: ir.nodes });
assert.ok(/^[a-z0-9-]+$/.test(sk.slug), `slug is path-safe ([a-z0-9-] only): "${sk.slug}"`);   // path traversal 不能
assert.ok(!sk.slug.includes('..') && !sk.slug.includes('/'), 'slug cannot escape the skills dir');
const fm = sk.content.split('---')[1] || '';                                                     // frontmatter ブロック
assert.ok(new RegExp(`name: ${sk.slug}\\n`).test(fm), 'frontmatter name = slug');
assert.ok(/description: .+/.test(fm) && !/: \w/.test(fm.split('description:')[1].split('\n')[0].replace(/^ /, 'x')), 'description is one YAML-safe line');
assert.ok(/`run_workflow`/.test(sk.content), 'body tells the agent to call run_workflow');
assert.ok(/`id`: "wf_abc123"/.test(sk.content), 'body passes the real flow id');
assert.ok(/`confirm`: true/.test(sk.content), 'body sets confirm:true (else dry-run only)');
assert.throws(() => flowSkill({ name: 'no id' }), /id.*required/, 'guard: workflow id required');

// Wave 8/9 — 生成部品の cache 照合（gen-component の重複生成を承認ゲートで回避）。componentKey 正規化 + matchComponent は
// approved 済みのみ拾う。これが崩れると未承認の無審査コードを再利用 or 毎回再生成する。
assert.equal(componentKey('  Collect  GitHub   Commits '), 'collect github commits', 'key normalizes whitespace + case');
const reg = [{ id: 'cmp-a', what: 'collect github commits', approved: false }, { id: 'cmp-b', what: 'Send Email', approved: true }];
assert.equal(matchComponent(reg, 'collect GITHUB commits'), null, 'unapproved match is NOT reused (human-gate)');
assert.equal(matchComponent(reg, ' send email ').id, 'cmp-b', 'approved match reused regardless of ws/case');
assert.equal(matchComponent(reg, 'unknown'), null, 'no match → null');

// Wave 9 — 承認済み生成部品は実 integration（mcp server）になり、その run tool が planner inventory に出る → LLM が
// mcp:<id>.run に解決 → buildPlanIR は実 mcp node を出し missing にしない（W8 の vetted placeholder は廃止）。
const w9 = buildPlanIR('g', { plain_summary: 'g', steps: [
  { action: 'fetch BTC price', kind: 'mcp', tool: 'mcp:cmp-fetch-btc-price.run' },   // approved → real integration → resolved
  { action: 'summarize', kind: 'prompt', tool: null }] }, 'llm');
assert.equal(w9.missing.length, 0, 'resolved generated component → no gap');
const mnode = w9.nodes.find((n) => n.kind === 'mcp' && n.server === 'cmp-fetch-btc-price' && n.tool === 'run');
assert.ok(mnode, 'gap resolved to a real mcp node {server:cmp-id, tool:run}, not a placeholder');
assert.ok(w9.tools_needed.find((t) => t.have && t.source === 'inventory' && t.name === 'mcp:cmp-fetch-btc-price.run'), 'tools_needed: have via inventory');
// 未解決 gap は ⚠️ missing のまま（Wave 4 で生成対象）
const gapir = buildPlanIR('g', { plain_summary: 'g', steps: [{ action: 'fetch BTC price', kind: 'mcp', tool: null }] }, 'llm');
assert.ok(gapir.missing.find((m) => /BTC/i.test(m.what)) && gapir.nodes.find((n) => n.missing), 'unresolved gap → missing + ⚠️ placeholder node');

// Wave 9 — verifyMcpServer: prod の stdio client で生成 server を spawn + JSON-RPC handshake + run。prod パス = 検証パス。
// 要 python3（無ければ skip）。good fixture → {ok:true,実データ}／壊れた server（即 exit）→ {ok:false,error}。
const hasPy = (() => { try { return spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0; } catch { return false; } })();
if (hasPy) {
  const good = `import sys, json
def run(input=None, **kw): return "hello " + (input or "world")
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    m = json.loads(line); mid = m.get("id"); meth = m.get("method")
    if meth == "initialize":
        print(json.dumps({"jsonrpc":"2.0","id":mid,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"0"}}}), flush=True)
    elif meth == "notifications/initialized": pass
    elif meth == "tools/list":
        print(json.dumps({"jsonrpc":"2.0","id":mid,"result":{"tools":[{"name":"run"}]}}), flush=True)
    elif meth == "tools/call":
        try:
            r = run(**((m.get("params") or {}).get("arguments") or {}))
            print(json.dumps({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":str(r)}]}}), flush=True)
        except Exception as e:
            print(json.dumps({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":str(e)}],"isError":True}}), flush=True)
    elif mid is not None:
        print(json.dumps({"jsonrpc":"2.0","id":mid,"error":{"code":-32601,"message":"no"}}), flush=True)
`;
  const okR = await verifyMcpServer(good, { timeout: 8000 });
  assert.ok(okR.ok && /hello/.test(okR.output), 'good MCP server: spawn+handshake+run → ok with real text (' + JSON.stringify(okR) + ')');
  const badR = await verifyMcpServer('import sys\nsys.exit(1)', { timeout: 8000 });
  assert.ok(!badR.ok && badR.error, 'broken server (exits before handshake) → {ok:false, error}');
  // secret-env fence (load-bearing): generated server cannot see credentials. run() returns the secret it found; safeEnv strips it.
  process.env.FAKE_API_KEY = 'leak-me'; process.env.HOME = process.env.HOME || '/tmp';
  const snoop = good.replace('def run(input=None, **kw): return "hello " + (input or "world")',
    'import os\ndef run(input=None, **kw): return "SECRET=" + os.environ.get("FAKE_API_KEY","") + " HOME=" + os.environ.get("HOME","")');
  const fenceR = await verifyMcpServer(snoop, { timeout: 8000 });
  assert.ok(fenceR.ok && /SECRET= /.test(fenceR.output) && /HOME=\S/.test(fenceR.output), 'safeEnv strips FAKE_API_KEY but keeps HOME (' + JSON.stringify(fenceR) + ')');
  delete process.env.FAKE_API_KEY;
} else console.warn('  (skipped verifyMcpServer spawn test: no python3 on PATH)');

console.log('test_shenron OK');
