#!/usr/bin/env node
// verify-receipt.mjs — verify a BuildHUD Trust Receipt with NO hub (Wave ③ Proof). Zero-dependency: reads the
// receipt JSON + (optionally) a pinned public-key PEM, recomputes the audit-entry hashes, and checks the ed25519
// signature. Honest: this proves integrity + that the receipt was signed by the holder of the public key and is
// unmodified — NOT who that holder is (pin the key out-of-band for real trust).
//   node prototype/verify-receipt.mjs <receipt.json> [--pubkey <hub-pubkey.pem>]
import fs from 'node:fs';
import { verifyReceipt } from './trust.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const pkIdx = args.indexOf('--pubkey');
if (!file) { console.error('usage: node prototype/verify-receipt.mjs <receipt.json> [--pubkey <file.pem>]'); process.exit(2); }
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!receipt || receipt.error || !receipt.runId || !Array.isArray(receipt.entries) || !receipt.signature) {
  console.error('not a Trust Receipt:', (receipt && receipt.error) || 'missing runId / entries / signature'); process.exit(2);
}
const pubkey = pkIdx > -1 ? fs.readFileSync(args[pkIdx + 1], 'utf8') : undefined;   // pinned key (stronger) vs the receipt-embedded one (TOFU)
const v = verifyReceipt(receipt, pubkey);

console.log(`run        ${receipt.runId}`);
console.log(`issued     ${receipt.issuedAt ? new Date(receipt.issuedAt).toISOString() : '—'}`);
console.log(`entries    ${(receipt.entries || []).length}  (chain tip: len ${receipt.chainTip?.length} · ${receipt.chainTip?.hash})`);
console.log(`pubkey     ${pubkey ? 'pinned (--pubkey)' : 'embedded in receipt (TOFU — pin out-of-band for real trust)'}`);
console.log(`entriesOk  ${v.entriesOk}${v.at !== undefined ? ` (broke at seq ${v.at})` : ''}`);
console.log(`signature  ${v.signatureOk}`);
console.log(v.ok ? '\n✅ VALID — integrity + signature verified (attests integrity, not identity/authority)' : '\n❌ INVALID');
process.exit(v.ok ? 0 : 1);
