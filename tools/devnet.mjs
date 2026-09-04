// Devnet housekeeping for the receipt signer. Prints the address and balance, then asks
// the public faucet for a grant. The public RPC allows one airdrop per IP per 24 hours
// and answers 429 after that, so a failure here is normal rather than a bug. When it is
// exhausted, faucet.solana.com hands out up to 5 SOL after a GitHub sign in, which is a
// human step by design: the page says agents should not use it.
//
//   SOLANA_SECRET_KEY=<base64 of the 64 byte secret key> node tools/devnet.mjs [airdrop]
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const sk = process.env.SOLANA_SECRET_KEY;
if (!sk) { console.error("set SOLANA_SECRET_KEY"); process.exit(2); }
const kp = Keypair.fromSecretKey(Buffer.from(sk, "base64"));
const conn = new Connection(process.env.SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");

console.log("address ", kp.publicKey.toBase58());
console.log("balance ", (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL, "SOL");

if (process.argv[2] === "airdrop") {
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    console.log("airdrop", sig, "->", (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  } catch (e) {
    console.log("airdrop refused:", String(e.message).split("\n")[0]);
    console.log("use https://faucet.solana.com with", kp.publicKey.toBase58());
  }
}
