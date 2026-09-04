// POST /api/attest
// Sign a receipt for Solana devnet: the SHA-256 of the figures a page showed plus the
// brief it wrote, inside an SPL Memo instruction.
//
// The signature is made here, where the key is. The transaction goes back to the browser
// to submit, because Cloudflare's egress is refused by the public devnet RPC
// ("Your IP or provider is blocked from this endpoint") while a visitor's own connection
// is not. That RPC is CORS open. The key never reaches the client and the client
// cannot change what gets signed except for the blockhash, which is checked below and
// which cannot turn a memo into a transfer.
//
// Written against the wire format rather than a client library. A memo transaction is one
// signature, two account keys and one instruction, Workers already have Ed25519 in
// crypto.subtle. test/attest.wire.test.mjs proves these bytes equal the ones
// @solana/web3.js produces. Bundling an SDK would add megabytes to buy nothing.

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_MEMO = 560;

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

// Solana's compact-u16: seven bits per byte, high bit means another byte follows
function shortvec(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return Uint8Array.from(out);
}

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function sha256hex(str) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A raw 32 byte Ed25519 seed inside the fixed PKCS8 envelope crypto.subtle wants.
const PKCS8_HEAD = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

async function signerFrom(secretB64) {
  const raw = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  if (raw.length !== 64) throw new Error("SOLANA_SECRET_KEY must be base64 of the 64 byte secret key");
  const key = await crypto.subtle.importKey(
    "pkcs8", cat(PKCS8_HEAD, raw.slice(0, 32)), { name: "Ed25519" }, false, ["sign"]
  );
  return { key, pub: raw.slice(32) };
}

function buildMessage(pub, blockhash32, memoBytes) {
  return cat(
    // one required signature, no readonly signers, one readonly unsigned (the program)
    Uint8Array.from([1, 0, 1]),
    shortvec(2), pub, b58decode(MEMO_PROGRAM),
    blockhash32,
    shortvec(1),
    Uint8Array.from([1]),               // instruction runs the memo program
    shortvec(1), Uint8Array.from([0]),  // one account, the signer, so the memo is attributable
    shortvec(memoBytes.length), memoBytes
  );
}

export async function onRequestPost({ request, env }) {
  const json = (o, s = 200) =>
    new Response(JSON.stringify(o), {
      status: s,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  if (!env.SOLANA_SECRET_KEY) return json({ error: "no devnet signer on this deploy" }, 503);

  let facts, brief, blockhash;
  try {
    ({ facts, brief, blockhash } = await request.json());
  } catch (e) {
    return json({ error: "bad request body" }, 400);
  }
  if (!facts || !facts.ein) return json({ error: "facts.ein is required" }, 400);

  let blockhash32;
  try {
    blockhash32 = b58decode(String(blockhash || ""));
    if (blockhash32.length !== 32) throw new Error("wrong length");
  } catch (e) {
    return json({ error: "blockhash must be 32 bytes of base58" }, 400);
  }

  // The digest covers the numbers and the words together, so neither can be edited alone.
  const digest = await sha256hex(JSON.stringify({ facts, brief: brief?.paragraphs || [] }));
  const memo = JSON.stringify({
    v: 1,
    app: "keepalive",
    kind: "brief-receipt",
    ein: facts.ein,
    fy: facts.latest_fiscal_year ?? null,
    runway_months: facts.runway_months ?? null,
    spend: facts.annual_spending ?? null,
    sha256: digest,
  });
  const memoBytes = new TextEncoder().encode(memo);
  if (memoBytes.length > MAX_MEMO) return json({ error: "memo too large" }, 400);

  try {
    const { key, pub } = await signerFrom(env.SOLANA_SECRET_KEY);
    const message = buildMessage(pub, blockhash32, memoBytes);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, message));
    return json({
      transaction: b64(cat(shortvec(1), sig, message)),
      signature: b58encode(sig),
      signer: b58encode(pub),
      digest,
      memo,
      cluster: "devnet",
      rpc: env.SOLANA_RPC || "https://api.devnet.solana.com",
    });
  } catch (e) {
    return json({ error: String(e.message).slice(0, 250) }, 500);
  }
}
