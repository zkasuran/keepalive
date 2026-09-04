// Prove the hand rolled transaction bytes are the same bytes @solana/web3.js produces.
// Run with: node web/functions/api/attest.test.mjs
// A wire format written by hand is only trustworthy if it is checked against the
// reference implementation, so this compares the serialized message byte for byte.

import { webcrypto } from "node:crypto";
import {
  Keypair, PublicKey, Transaction, TransactionInstruction,
} from "@solana/web3.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return new Uint8Array(bytes);
}
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out || "1";
}
function shortvec(n) {
  const out = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n === 0) { out.push(b); break; } out.push(b | 0x80); }
  return Uint8Array.from(out);
}
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const PKCS8_HEAD = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function buildMessage(pub, blockhash58, memo) {
  const data = new TextEncoder().encode(memo);
  return cat(
    Uint8Array.from([1, 0, 1]),
    shortvec(2), pub, b58decode(MEMO_PROGRAM),
    b58decode(blockhash58),
    shortvec(1),
    Uint8Array.from([1]),
    shortvec(1), Uint8Array.from([0]),
    shortvec(data.length), data
  );
}

const hex = (b) => Buffer.from(b).toString("hex");
let fails = 0;
function check(name, ours, theirs) {
  const ok = hex(ours) === hex(theirs);
  console.log(`${ok ? "pass" : "FAIL"}  ${name}  (${ours.length} bytes)`);
  if (!ok) {
    fails++;
    console.log("   ours   ", hex(ours));
    console.log("   web3js ", hex(theirs));
  }
}

// base58 round trip against web3.js PublicKey
const kp = Keypair.fromSeed(new Uint8Array(32).fill(7));
check("base58 decode of a pubkey", b58decode(kp.publicKey.toBase58()), kp.publicKey.toBytes());
console.log(
  `${b58encode(kp.publicKey.toBytes()) === kp.publicKey.toBase58() ? "pass" : "FAIL"}  base58 encode round trip`
);

// message bytes for three memo sizes, including one that crosses the shortvec boundary
const blockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
for (const memo of [
  "hi",
  JSON.stringify({ v: 1, app: "keepalive", kind: "brief-receipt", ein: 815106159, sha256: "a".repeat(64) }),
  "x".repeat(200),
]) {
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(
    new TransactionInstruction({
      keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }],
      programId: new PublicKey(MEMO_PROGRAM),
      data: Buffer.from(memo, "utf8"),
    })
  );
  check(
    `message bytes, memo of ${memo.length} chars`,
    buildMessage(kp.publicKey.toBytes(), blockhash, memo),
    tx.serializeMessage()
  );
}

// signature: crypto.subtle over the pkcs8 wrapped seed must match web3.js signing
const seed = new Uint8Array(32).fill(7);
const key = await crypto.subtle.importKey(
  "pkcs8", cat(PKCS8_HEAD, seed), { name: "Ed25519" }, false, ["sign"]
);
const msg = buildMessage(kp.publicKey.toBytes(), blockhash, "hi");
const ours = new Uint8Array(await crypto.subtle.sign("Ed25519", key, msg));
const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(
  new TransactionInstruction({
    keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }],
    programId: new PublicKey(MEMO_PROGRAM),
    data: Buffer.from("hi", "utf8"),
  })
);
tx.sign(kp);
check("ed25519 signature from crypto.subtle", ours, tx.signature);

// and the full wire transaction
check("serialized transaction", cat(shortvec(1), ours, msg), tx.serialize());

console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
