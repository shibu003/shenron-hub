// test_shenron.mjs — Wave 1 self-check for buildPlanIR (pure IR assembly; no LLM).
// run: node prototype/hub/test_shenron.mjs
import assert from 'node:assert';
import { buildPlanIR, suggestionFromSearch, discover, toLangflowFlow, extractCode, genComponent } from './shenron.mjs';

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

console.log('test_shenron OK');
