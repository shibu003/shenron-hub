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
console.log('test_runner OK');
