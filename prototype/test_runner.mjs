// test_runner.mjs — vendor routing without network/keys (the stub-fallback contract).
// ponytail: no API calls — just asserts the no-key branches return a *labeled* stub, so a
// consensus default that lists gemini/openai gets a diagnosable fallback, not silent garbage.
import assert from 'node:assert';
delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY;   // deterministic regardless of dev env
const { runVendorAsync } = await import('./runner.mjs');

for (const v of ['gemini', 'google']) {
  const r = await runVendorAsync(v, 'hi', 'STUB');
  assert.ok(r.startsWith('[gemini → stub]') && r.includes('STUB'), `${v} no-key → labeled gemini stub`);
}
for (const v of ['openai', 'gpt']) {
  const r = await runVendorAsync(v, 'hi', 'STUB');
  assert.ok(r.startsWith('[openai → stub]') && r.includes('STUB'), `${v} no-key → labeled openai stub`);
}
assert.equal(await runVendorAsync('nope', 'hi', 'STUB'), 'STUB', 'unknown vendor → stub passthrough');

// auto-escalation (hub.runPrompt) の発火条件 = この失敗 sentinel。runner が format を変えたらここで落ちる＝契約固定。
const failed = await runVendorAsync('gemini', 'hi', 'STUB');
assert.ok(failed.startsWith('[') && failed.includes('→ stub]'), 'failure carries the → stub] sentinel (escalation trigger)');
assert.ok(!'a normal model answer → maybe'.includes('→ stub]'), 'success text does not trip escalation');
console.log('test_runner OK');
