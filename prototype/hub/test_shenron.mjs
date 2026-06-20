// test_shenron.mjs — Wave 1 self-check for buildPlanIR (pure IR assembly; no LLM).
// run: node prototype/hub/test_shenron.mjs
import assert from 'node:assert';
import { buildPlanIR, suggestionFromSearch, discover, toLangflowFlow } from './shenron.mjs';

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

console.log('test_shenron OK');
