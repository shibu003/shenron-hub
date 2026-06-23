// test_shenron.mjs — Wave 1 self-check for buildPlanIR (pure IR assembly; no LLM).
// run: node prototype/hub/test_shenron.mjs
import assert from 'node:assert';
import { buildPlanIR, suggestionFromSearch, discover, toLangflowFlow, extractCode, genComponent, plan, flowSkill, componentKey, matchComponent, verifyMcpServer, neededCredentials, renderPlan, evalExpect } from './shenron.mjs';
import { spawnSync } from 'node:child_process';
import { openStdio } from '../mcp/mcp-client.mjs';
import { classify, SEED_RULES, addAllowRule } from '../permissions.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

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

// full node-type palette + router branching (planner designs kinds AND wires them)
const br = buildPlanIR('if it has errors alert, else save', { plain_summary: 'p', steps: [
  { action: 'reformat', kind: 'parser' },                                          // deterministic, no LLM
  { action: 'has error?', kind: 'router', condition: 'contains:error' },           // conditional split
  { action: 'alert', kind: 'mcp', tool: 'mcp:slack.send', branch: 'then' },        // then-branch
  { action: 'save', kind: 'prompt', branch: 'else' },                              // else-branch
  { action: 'receipt', kind: 'structured', fields: 'status,detail' },              // join (JSON)
] }, 'llm', 'ask');
const k = (id) => br.nodes.find((n) => n.id === id).kind;
assert.deepEqual(br.nodes.map((n) => n.kind), ['input', 'parser', 'router', 'mcp', 'prompt', 'structured', 'output'], 'all picked kinds materialize (not collapsed to prompt)');
assert.equal(br.missing.length, 0, 'parser/router/structured are built-in → never gaps');
assert.deepEqual(br.nodes.find((n) => n.kind === 'router').config, { predicate: 'contains', value: 'error' }, 'router condition → predicate/value');
assert.equal(br.nodes.find((n) => n.kind === 'structured').config.schema, 'status,detail', 'structured fields → schema');
const has = (s, t, b) => br.edges.some((e) => e.source === s && e.target === t && (b === undefined || e.branch === b));
assert.ok(has('s2', 's3', 'then') && has('s2', 's4', 'else'), 'router fans to then/else branches (labelled)');
assert.ok(has('s3', 's5') && has('s4', 's5'), 'both branches rejoin at the next plain step');
assert.ok(has('s5', 'output-1'), 'join → output');
assert.ok(!br.edges.some((e) => e.source === 's2' && e.branch === undefined), 'router has no unlabelled out-edge (pure branch)');

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

// Wave C fix — no LLM vendor (runner returns a `[... → stub]` marker): fail fast with the fix, do NOT feed the stub
// to the sandbox and crash every iter (the 実機 red-team bug). converged:false + a clear "set EXEC_VENDOR/ANTHROPIC_API_KEY" error.
let stubSandboxed = 0;
const rStub = await genComponent({ what: 'fetch stars', run: async () => '[claude failed → stub] exit 1\n', sandbox: () => { stubSandboxed++; return { ok: true }; } });
assert.equal(rStub.converged, false, 'stub vendor: not converged');
assert.equal(stubSandboxed, 0, 'stub vendor: never reaches the sandbox (no crash-loop)');
assert.match(rStub.error, /EXEC_VENDOR|ANTHROPIC_API_KEY/, 'stub vendor: error names the fix');

// Wave 9.1 — BYO-credential: neededCredentials は secret-strip 対象の env 名だけ拾う（HOME 等は safeEnv が通すので allowlist 不要）。
assert.deepEqual(neededCredentials(`x = os.environ.get('OPENWEATHER_API_KEY')\ny = os.getenv("FOO_TOKEN")\nz = os.environ['HOME']`),
  ['OPENWEATHER_API_KEY', 'FOO_TOKEN'], 'scans env names, keeps secret-like, drops HOME');
assert.deepEqual(neededCredentials('print("no env here")'), [], 'no env refs → empty allowlist');
// genComponent: 宣言 cred が hub env に無ければ live verify せず needsCredentials を surface（repair 空回りを止める）
const credCode = async () => '```python\nimport os\nx=os.environ.get("WEATHER_API_KEY")\n```';
delete process.env.WEATHER_API_KEY;
const rNoKey = await genComponent({ what: 'weather', run: credCode, sandbox: () => ({ ok: true }) });
assert.ok(!rNoKey.converged && rNoKey.needsCredentials.includes('WEATHER_API_KEY') && rNoKey.iters === 1, 'missing cred → surfaced, not verified/repaired');
// 揃っていれば allowlist を sandbox に通し、converged 結果に credentials が載る
process.env.WEATHER_API_KEY = 'present';
const rKey = await genComponent({ what: 'weather', run: credCode,
  sandbox: (code, opt) => { assert.deepEqual(opt.creds, ['WEATHER_API_KEY'], 'allowlist threaded to verify'); return { ok: true, output: 'sunny' }; } });
assert.ok(rKey.converged && rKey.credentials.includes('WEATHER_API_KEY'), 'cred present → verified, credentials recorded for approval');
delete process.env.WEATHER_API_KEY;

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

// Wave(discover・M1) — 曖昧な願い → planner が clarify を返す → plan せず user に確認（再呼び出しで context.choices）
let promptSeen = '';
const clarifyRun = async (_v, p) => { promptSeen = p; return '{"clarify":[{"question":"どのSNS？","options":["X","Instagram","Facebook"],"why":"機構が変わる"}],"blockers":["転売の自動購入は ToS 違反"]}'; };
const cl = await plan({ goal: 'SNSを始めたい', run: clarifyRun });
assert.equal(cl.mode, 'clarify', 'discover: ambiguous goal → clarify mode (not a plan)');
assert.equal(cl.nodes.length, 0, 'discover: clarify returns no plan nodes');
assert.equal(cl.clarify[0].options.length, 3, 'discover: options carried (X/Insta/FB)');
assert.ok(cl.blockers.length && /ToS/.test(cl.blockers[0]), 'discover: blockers surfaced');
assert.ok(/DISCOVER FIRST/.test(promptSeen), 'discover: prompt mandates research-first');
const clr = renderPlan(cl);
assert.ok(/どのSNS/.test(clr.summary_text) && /context\.choices/.test(clr.summary_text), 'discover: renderPlan shows questions + re-call hint');
assert.equal(clr.diagram_ascii, '', 'discover: no flow diagram while clarifying');

// 回答(context.choices)を渡すと prompt に乗り、plan へ進む（blocker も計画に同梱）
let answeredPrompt = '';
const stepsRun = async (_v, p) => { answeredPrompt = p; return '{"plain_summary":"X に投稿","blockers":["X API は有料枠あり"],"steps":[{"action":"投稿する","kind":"agent","tool":"agent:browser-control"}]}'; };
const planned = await plan({ goal: 'SNSを始めたい', context: { choices: [{ question: 'どのSNS？', answer: 'X' }] }, run: stepsRun });
assert.notEqual(planned.mode, 'clarify', 'with choices → proceeds to a plan');
assert.ok(/どのSNS.*X/s.test(answeredPrompt), 'choices passed into the prompt');
assert.ok((planned.blockers || []).some((b) => /API/.test(b)), 'plan carries blockers alongside steps');

// Wave G — per-step model routing: planner の tier(cheap/strong) を step と prompt ノード config に持ち越す（実行時 tier→model）
const tierIR = buildPlanIR('g', { plain_summary: 'x', steps: [
  { action: 'summarize', kind: 'prompt', tool: null, tier: 'cheap' },
  { action: 'decide', kind: 'prompt', tool: null, tier: 'strong' },
  { action: 'plain', kind: 'prompt', tool: null },                 // tier 無し → undefined
  { action: 'bad', kind: 'prompt', tool: null, tier: 'weird' },    // 不正 → undefined
] });
assert.equal(tierIR.steps[0].tier, 'cheap', 'tier: cheap carried to step');
assert.equal(tierIR.steps[1].tier, 'strong', 'tier: strong carried to step');
assert.equal(tierIR.steps[2].tier, undefined, 'tier: none → undefined');
assert.equal(tierIR.steps[3].tier, undefined, 'tier: invalid → undefined (no garbage)');
const pn = (n) => tierIR.nodes.find((x) => x.id === `s${n}`);
assert.equal(pn(1).config.tier, 'cheap', 'tier: cheap on the prompt node config (→ runtime model)');
assert.equal(pn(2).config.tier, 'strong', 'tier: strong on the prompt node config');
assert.ok(!('tier' in pn(3).config), 'tier: untiered prompt node has no tier key');

// Wave: cost mode — free(既定)=有料は opt-in 化 / paid_ok=有料可だがコスト開示。プロンプトに反映されるか。
let costPrompt = '';
const capRun = async (_v, p) => { costPrompt = p; return '{"plain_summary":"x","steps":[{"action":"a","kind":"prompt","tool":null}]}'; };
await plan({ goal: 'g', run: capRun });                                   // default
assert.ok(/COST MODE = free/.test(costPrompt) && /Prefer FREE/.test(costPrompt), 'cost: default=free → prompt prefers free / opt-in for paid');
assert.ok(/MINIMIZE COST/.test(costPrompt) && /FEWEST LLM steps/.test(costPrompt), 'cost: planner actively minimizes (fewest LLM steps, reuse, default cheap, escalate only when outcome-changing)');
await plan({ goal: 'g', cost: 'paid_ok', run: capRun });
assert.ok(/COST MODE = paid_ok/.test(costPrompt) && /MAY use paid/.test(costPrompt) && /disclose/.test(costPrompt), 'cost: paid_ok → prompt allows paid but requires cost disclosure');

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
  // BYO-credential: an allowlisted env name IS injected; a non-allowlisted secret stays stripped.
  process.env.WEATHER_API_KEY = 'sunny-key';
  const wsnoop = good.replace('def run(input=None, **kw): return "hello " + (input or "world")',
    'import os\ndef run(input=None, **kw): return "W=" + os.environ.get("WEATHER_API_KEY","") + " F=" + os.environ.get("FAKE_API_KEY","")');
  const credR = await verifyMcpServer(wsnoop, { timeout: 8000, creds: ['WEATHER_API_KEY'] });
  assert.ok(credR.ok && /W=sunny-key/.test(credR.output) && !/F=\S/.test(credR.output), 'allowlisted WEATHER_API_KEY injected; non-allowlisted FAKE_API_KEY still stripped (' + JSON.stringify(credR) + ')');
  const noCredR = await verifyMcpServer(wsnoop, { timeout: 8000, creds: [] });
  assert.ok(noCredR.ok && !/W=sunny/.test(noCredR.output), 'empty allowlist → WEATHER_API_KEY stripped (Wave 9 default)');
  delete process.env.WEATHER_API_KEY; delete process.env.FAKE_API_KEY;

  // Wave 11a — openStdio: a PERSISTENT client keeps ONE child across calls, so server-side session state survives
  // step→step (a one-shot callStdio would spawn fresh and reset it). A stateful counter that increments per
  // tools/call proves the session persists — exactly what the browser-control worker needs for multi-step browsing.
  const counter = `import sys, json
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    m = json.loads(line); mid = m.get("id"); meth = m.get("method")
    if meth == "initialize":
        print(json.dumps({"jsonrpc":"2.0","id":mid,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"c","version":"0"}}}), flush=True)
    elif meth == "notifications/initialized": pass
    elif meth == "tools/call":
        n += 1
        print(json.dumps({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":str(n)}]}}), flush=True)
`;
  const dir = mkdtempSync(path.join(tmpdir(), 'shenron-pw-'));
  try {
    writeFileSync(path.join(dir, 'counter.py'), counter);
    const c = openStdio('python3 ' + path.join(dir, 'counter.py'), { timeoutMs: 8000 });
    const r1 = await c.call('tick', {}); const r2 = await c.call('tick', {});   // two calls, SAME child
    c.close();
    assert.equal(r1.content[0].text, '1', 'openStdio call 1 → counter 1');
    assert.equal(r2.content[0].text, '2', 'openStdio call 2 → counter 2 (session persisted across calls in one child)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else console.warn('  (skipped verifyMcpServer/openStdio spawn tests: no python3 on PATH)');

// Wave 11b — classify(): the Claude-Code-style allow/ask/deny gate for browser-control. Pure (no browser/hub).
// Seeded defaults: read-only tools run silently, mutating/outbound tools pause for a human (the ToS line).
assert.equal(classify({ tool: 'browser_navigate' }, null, SEED_RULES), 'allow', 'navigate (read-only) → allow');
assert.equal(classify({ tool: 'browser_snapshot' }, null, SEED_RULES), 'allow', 'snapshot → allow');
assert.equal(classify({ tool: 'browser_click' }, null, SEED_RULES), 'ask', 'click (mutating) → ask');
assert.equal(classify({ tool: 'browser_type' }, null, SEED_RULES), 'ask', 'type → ask');
assert.equal(classify({ tool: 'browser_unknown' }, null, SEED_RULES), 'ask', 'unknown tool → ask (safe default)');
// precedence deny > allow > ask
assert.equal(classify({ tool: 'browser_click' }, null, [{ effect: 'allow', tool: 'browser_click' }, { effect: 'deny', tool: 'browser_click' }]), 'deny', 'deny beats allow');
assert.equal(classify({ tool: 'browser_click' }, null, [{ effect: 'allow', tool: 'browser_click' }]), 'allow', 'promoted click → allow');
// domain scoping: rule domain is a suffix of the live page domain
const dr = [{ effect: 'allow', tool: 'browser_click', domain: 'example.com' }];
assert.equal(classify({ tool: 'browser_click' }, 'app.example.com', dr), 'allow', 'domain rule matches subdomain (endsWith)');
assert.equal(classify({ tool: 'browser_click' }, 'evil.com', dr), 'ask', 'domain rule does not match other domain');
assert.equal(classify({ tool: 'browser_click' }, null, dr), 'ask', 'domain rule needs a known currentDomain');
// addAllowRule idempotency — 「常に許可」 連打でも膨らまない
const a1 = addAllowRule(SEED_RULES, { tool: 'browser_click' });
assert.equal(addAllowRule(a1, { tool: 'browser_click' }).length, a1.length, 'addAllowRule is idempotent');
assert.ok(a1.some((r) => r.effect === 'allow' && r.tool === 'browser_click'), 'addAllowRule appended the allow rule');

// gap toggle: 'off' → 解決不能 step を buildable gap にしない（missing 空・⚠️ なし＝既存ツールのみ）／'ask'(既定) → gap を作る
const gapParsed = { plain_summary: 'x', steps: [{ action: 'get GitHub commits', kind: 'mcp', tool: null }] };
const askIR = buildPlanIR('g', gapParsed);                 // default 'ask'
assert.equal(askIR.missing.length, 1, 'gap=ask: unresolvable mcp step → 1 gap');
assert.ok(askIR.nodes.some((n) => n.missing), 'gap=ask: ⚠️ placeholder node');
const offIR = buildPlanIR('g', gapParsed, 'llm', 'off');
assert.equal(offIR.missing.length, 0, 'gap=off: no buildable gap created');
assert.ok(!offIR.nodes.some((n) => n.missing), 'gap=off: no ⚠️ node (best-effort prompt instead)');

// Wave 11c — planner routes a UI-only / no-API step to the built-in browser-control agent (decision-tree
// "UIのみ → computer-use" 枝). It resolves to a real agent node (have:true), NOT a buildable gap.
const uiIR = buildPlanIR('女の子と付き合いたい', { plain_summary: 'register on a dating site', steps: [{ action: 'register on the dating site', kind: 'agent', tool: 'agent:browser-control' }] });
assert.equal(uiIR.missing.length, 0, '11c: browser-control step is resolved, not a gap');
const bc = uiIR.nodes.find((n) => n.kind === 'agent' && n.agent === 'browser-control');
assert.ok(bc, '11c: emits an agent node targeting browser-control');
assert.ok(uiIR.tools_needed.find((t) => t.name === 'agent:browser-control' && t.have), '11c: browser-control marked have (computer-use covers it)');

// Wave A — renderPlan: plan IR → 人間可読（Mermaid + ASCII + plain 要約）。cockpit 無しで確認できる。
const rp = renderPlan(buildPlanIR('email the team', { plain_summary: 'Email the team', steps: [
  { action: 'draft it', kind: 'prompt', tool: null },
  { action: 'send via gmail', kind: 'mcp', tool: 'mcp:gmail.send' },
  { action: 'post on the careers site', kind: 'agent', tool: 'agent:browser-control' },
  { action: 'scrape github stars', kind: 'mcp', tool: null },   // gap
] }));
assert.ok(rp.diagram_mermaid.startsWith('flowchart LR'), 'renderPlan: mermaid header');
assert.ok(/mcp:gmail\.send/.test(rp.diagram_mermaid), 'renderPlan: mermaid has the gmail node');
assert.ok(/input_1\[/.test(rp.diagram_mermaid) && !/input-1\[/.test(rp.diagram_mermaid), 'renderPlan: mermaid sanitizes hyphenated ids');
assert.ok(rp.diagram_mermaid.includes('-->'), 'renderPlan: mermaid has edges');
assert.ok(rp.diagram_ascii.includes('↓') && rp.diagram_ascii.includes('🌐 agent:browser-control'), 'renderPlan: ascii chain + browser-control');
assert.ok(/✅ mcp:gmail\.send/.test(rp.summary_text), 'renderPlan: summary marks resolved tool');
assert.ok(/Missing/.test(rp.summary_text) && /scrape github stars/.test(rp.summary_text), 'renderPlan: summary surfaces the gap');

// Wave G — consensus を planner から emit: high-stakes step → consensus node（gap でなく built-in）。
const cir = buildPlanIR('decide go/no-go', { plain_summary: 'Decide', steps: [
  { action: 'summarize the inputs', kind: 'prompt', tier: 'cheap' },
  { action: 'final go/no-go decision', kind: 'consensus' },
] });
const cnode = cir.nodes.find((n) => n.kind === 'consensus');
assert.ok(cnode && cnode.config.prompt === 'final go/no-go decision', 'consensus step → consensus node w/ prompt');
assert.equal(cir.missing.length, 0, 'consensus is built-in, not a gap');
assert.ok(cir.steps.find((s) => s.kind === 'consensus' && s.have), 'consensus step marked have');
assert.ok(/🗳️ consensus/.test(renderPlan(cir).diagram_ascii), 'renderPlan labels the consensus node');

// Wave G — auto-routing 提案: planner の tier + 財布設定(ctx) → 各 step の vendor/model/cost を plan に surface。
const rir = buildPlanIR('mixed routing', { plain_summary: 'Mixed', steps: [
  { action: 'summarize', kind: 'prompt', tier: 'cheap' },
  { action: 'decide architecture', kind: 'prompt', tier: 'strong' },
  { action: 'send via gmail', kind: 'mcp', tool: 'mcp:gmail.send' },
  { action: 'final go/no-go', kind: 'consensus' },
] });
const fakeCtx = { cost: 'free', cheap: { vendor: 'ollama', model: 'llama3.2' }, strong: { vendor: null, model: 'claude-opus-4-8' }, consensusVendors: 'claude,codex,ollama', autoEscalate: true };
const rr = renderPlan(rir, fakeCtx);
assert.ok(/🧭 Routing 提案/.test(rr.summary_text), 'routing: posture line present');
assert.ok(/cheap → ollama \(llama3.2\) · local \$0 ↑strong on fail/.test(rr.summary_text), 'routing: cheap→ollama $0 + escalate note');
assert.ok(/strong → your Claude \(claude-opus-4-8\) · subscription/.test(rr.summary_text), 'routing: strong→your Claude subscription');
assert.equal(rr.routing.length, 4, 'routing: one entry per step');
assert.equal(rr.routing.find((r) => r.action === 'send via gmail').cost, '$0', 'routing: mcp tool call is $0 (no model)');
assert.equal(rr.routing.find((r) => r.kind === 'consensus').cost, '3×', 'routing: consensus is 3× (3 vendors)');
assert.ok(!('routing' in renderPlan(rir)), 'routing: omitted when no ctx (backward compat)');

// ---------- Wave R-1: 成果検証（evalExpect 純粋判定 + 完了ブロックの冪等ガード/リングバッファのロジック） ----------
{
  // evalExpect 契約: 常に {ok:boolean, reason:string}（TODO(human) 実装前は pass の stub）
  const a = await evalExpect({ kind: 'assert', rule: 'contains:done' }, 'task done');
  assert.equal(typeof a.ok, 'boolean', 'R-1 evalExpect.ok is boolean');
  assert.equal(typeof a.reason, 'string', 'R-1 evalExpect.reason is string');
  // judge path は run を注入できる＝実 LLM 不要で配線を検証（TODO(human) 実装後はここで yes/no が効く）
  const j = await evalExpect({ kind: 'judge', rule: 'polite?' }, 'hello', { run: async () => 'YES' });
  assert.equal(typeof j.ok, 'boolean', 'R-1 evalExpect judge with injected run returns boolean ok');
  // 完了ブロックの exactly-once ガード（hub.mjs:585 completedAt のロジックを isolation で固定）
  let fires = 0; const run = {}; const fire = () => { if (!run.completedAt) { run.completedAt = 1; fires++; } };
  fire(); fire(); fire();
  assert.equal(fires, 1, 'R-1 completedAt guard fires checkOutcome exactly once');
  // checkResults リングバッファ上限（hub.mjs:checkOutcome の cap・最新を残す）
  let buf = []; for (let i = 0; i < 60; i++) { buf.push(i); if (buf.length > 50) buf = buf.slice(-50); }
  assert.ok(buf.length <= 50 && buf[buf.length - 1] === 59, 'R-1 checkResults ring buffer caps at 50, keeps newest');
}
// ---------- Wave U-1: MCP surface divergence guard ----------
// 公開している tool は必ず dispatch 経路を持つこと。TOOLS に足して配線を忘れたらここで red。
{
  const { TOOLS, PROXY, forStdio, forRemote } = await import('../mcp/tools.mjs');
  const { readFileSync } = await import('node:fs');
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'U-1: no duplicate tool names in TOOLS');
  for (const k of Object.keys(PROXY)) assert.ok(names.includes(k), `U-1: PROXY key "${k}" must be a defined tool`);

  // stdio: server.mjs callTool の case ラベルが forStdio tool を全部覆うこと
  const serverSrc = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const stdioHandled = new Set([...serverSrc.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
  for (const t of TOOLS.filter(forStdio)) assert.ok(stdioHandled.has(t.name), `U-1: stdio tool "${t.name}" advertised but no callTool case`);

  // remote: mcpDispatch の name=== 分岐 ∪ PROXY ∪ in-process special-case が forRemote tool を全部覆うこと
  const hubSrc = readFileSync(new URL('./hub.mjs', import.meta.url), 'utf8');
  const remoteHandled = new Set([...hubSrc.matchAll(/name === '([a-z_]+)'/g)].map((m) => m[1]));
  for (const k of Object.keys(PROXY)) remoteHandled.add(k);
  for (const t of TOOLS.filter(forRemote)) assert.ok(remoteHandled.has(t.name), `U-1: remote tool "${t.name}" advertised but mcpDispatch can't serve it`);

  // 構造不変: REMOTE_DENY で明示的に塞いだ以外の proxy tool は必ず remote に出る（人間の許可判断を尊重しつつ回帰検出）
  const { REMOTE_DENY } = await import('../mcp/tools.mjs');
  const remoteNames = new Set(TOOLS.filter(forRemote).map((t) => t.name));
  for (const k of Object.keys(PROXY)) {
    if (REMOTE_DENY.has(k)) assert.ok(!remoteNames.has(k), `U-1: "${k}" is REMOTE_DENY'd → must NOT be on remote`);
    else assert.ok(remoteNames.has(k), `U-1: proxy tool "${k}" should be remote-exposed (or add to REMOTE_DENY)`);
  }
  // hidden ≠ blocked: mcpDispatch (remote 専用経路) は REMOTE_DENY を advertise から外すだけでなく dispatch でも拒否すること
  // （tools/list に出さなくても名前で直接呼べば proxySelf が通る穴を塞いだ・E2E 確認済 2026-06-22）。guard 行が消えたらここで red。
  assert.ok(/REMOTE_DENY\.has\(name\)/.test(hubSrc), 'U-1: mcpDispatch must reject REMOTE_DENY tools at dispatch (not just hide them)');
  console.log(`U-1 surface guard OK — stdio ${TOOLS.filter(forStdio).length} / remote ${remoteNames.size} tools, all dispatchable (REMOTE_DENY: ${REMOTE_DENY.size})`);
}
console.log('test_shenron OK');
