// run: node prototype/hub/test_langflow.mjs   (no live Langflow needed — these helpers are pure)
import assert from 'node:assert';
import { lfRunText, lfRunBody, langflowRun, langflowImport } from './langflow.mjs';

// real-ish /v1/run response → extract the chat text (prefers results.message.text)
assert.equal(lfRunText({ session_id: 's', outputs: [{ inputs: {}, outputs: [{ results: { message: { text: 'hello world' } }, outputs: { message: { message: 'dup' } } }] }] }), 'hello world');
// fallbacks, in order
assert.equal(lfRunText({ outputs: [{ outputs: [{ results: { message: { data: { text: 'via data' } } } }] }] }), 'via data');
assert.equal(lfRunText({ outputs: [{ outputs: [{ outputs: { message: { message: 'via om' } } }] }] }), 'via om');
assert.equal(lfRunText({ outputs: [{ outputs: [{ messages: [{ message: 'via msgs' }] }] }] }), 'via msgs');
// unknown shape / edge cases → raw JSON or string, never throws
assert.equal(lfRunText({ weird: 1 }), JSON.stringify({ weird: 1 }));
assert.equal(lfRunText('plain'), 'plain');
assert.equal(lfRunText(null), '');

// request envelope
assert.deepEqual(lfRunBody('hi'), { input_value: 'hi', output_type: 'chat', input_type: 'chat' });
assert.deepEqual(lfRunBody(null), { input_value: '', output_type: 'chat', input_type: 'chat' });

// langflowRun: hits /api/v1/run, fences input (secret never reaches LF), audits, extracts output — fake fetch
{
  const audit = []; let sent, sentUrl, sentHeaders;
  const fakeFetch = async (url, opts) => { sent = JSON.parse(opts.body); sentUrl = url; sentHeaders = opts.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify({ outputs: [{ outputs: [{ results: { message: { text: 'answer' } } }] }] }) }; };
  const res = await langflowRun(audit, { host: 'http://x:7860/', flowId: 'F1', key: 'sek', input: 'my key sk-ABCDEFGHIJKLMNOP1234 then hi' }, fakeFetch);
  assert.ok(sentUrl.endsWith('/api/v1/run/F1'), 'must hit /api/v1/run, got ' + sentUrl);   // regression: the /api prefix is required
  assert.equal(sentHeaders['x-api-key'], 'sek', 'api key forwarded');
  assert.equal(res.output, 'answer'); assert.equal(res.flowId, 'F1'); assert.ok(res.redacted >= 1);
  assert.ok(!sent.input_value.includes('sk-ABCDEFGHIJKLMNOP1234'), 'secret must not reach Langflow');
  assert.ok(audit.some((e) => e.type === 'langflow-run' && e.ok === true), 'success audited');
  assert.ok(audit.some((e) => e.type === 'redact'), 'redaction audited');
}
// langflowImport: uploads the raw flow VERBATIM to /api/v1/flows, returns the new id, audits — fake fetch
{
  const audit = []; let sentUrl, sent;
  const raw = { id: 'old-local-id', name: 'My Flow', description: 'd', data: { nodes: [{ id: 'n1' }], edges: [] }, user_id: 'u' };
  const fakeFetch = async (url, opts) => { sentUrl = url; sent = JSON.parse(opts.body);
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'new-server-id', name: 'My Flow' }) }; };
  const res = await langflowImport(audit, { host: 'http://x:7860', flow: raw }, fakeFetch);
  assert.ok(sentUrl.endsWith('/api/v1/flows/'), sentUrl);
  assert.deepEqual(sent.data, raw.data, 'graph uploaded verbatim (types preserved)');
  assert.equal(sent.name, 'My Flow'); assert.equal(res.flowId, 'new-server-id', 'uses Langflow-issued id, not the local one');
  assert.ok(audit.some((e) => e.type === 'langflow-import' && e.ok === true && e.flowId === 'new-server-id'));
}
// import down → friendly error + ok:false audit
{ const audit = [];
  await assert.rejects(() => langflowImport(audit, { flow: { name: 'x' } }, async () => { throw new Error('ECONNREFUSED'); }), /unreachable/);
  assert.ok(audit.some((e) => e.type === 'langflow-import' && e.ok === false)); }
// host down → friendly error + ok:false audit entry
{
  const audit = [];
  await assert.rejects(() => langflowRun(audit, { flowId: 'F1', input: 'x' }, async () => { throw new Error('ECONNREFUSED'); }), /unreachable/);
  assert.ok(audit.some((e) => e.type === 'langflow-run' && e.ok === false), 'failure audited');
}
// non-2xx → error surfaces Langflow's body
await assert.rejects(() => langflowRun([], { flowId: 'F1', input: 'x' }, async () => ({ ok: false, status: 422, text: async () => 'bad flow' })), /422.*bad flow/);
// missing flowId → throw before any fetch
await assert.rejects(() => langflowRun([], { input: 'x' }, async () => { throw new Error('should not fetch'); }), /flowId required/);

console.log('ok lfRunText/lfRunBody/langflowRun/langflowImport');
