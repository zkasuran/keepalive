# Keepalive

**A charity does not close because its overhead was too high. It closes because it ran out
of months.**

Keepalive reads 3,697,515 IRS filings and computes, for 579,178 US nonprofits, the one
number no rating site puts in front of you: how many months of spending they hold in cash.
Then it tells you what your gift does to that number.

Live: **<https://keepalive.zkasuran.dev>**

Built for the [DEV Weekend Challenge: Generosity Edition](https://dev.to/challenges/weekend-2026-09-03),
4 to 7 September 2026. Everything in this repository was written inside that window.

## The finding

Two candidate signals, measured on the same 328,186 organisations that filed a long-form
Form 990 for fiscal 2018 or 2019, scored on whether the same EIN appears on any filing for
fiscal 2022 or later. 8.88% do not.

**Months of runway predicts survival.** Under three months is the worst of the three bands
in all ten spending deciles, with no exception.

| pooled, deciles weighted equally | under 3 months | 3 to 12 months | over 12 months |
| --- | --- | --- | --- |
| still filing | **86.79%** | 92.61% | 93.56% |

The gap is widest where the money is smallest: 10.3 points in the smallest decile, 1.6 in
the largest. Past three months the gain flattens. In the top three deciles a very large
reserve is very slightly worse than a middling one, so this is a floor effect rather than a
straight line.

**Cents spent to raise a dollar points the wrong way.** The thriftiest fundraisers, under
five cents to raise a dollar, had lower survival than the 5 to 15 cent band in all ten
deciles. The 5 to 15 cent band was the best of the three in all ten.

| pooled, deciles weighted equally | under 5 cents | 5 to 15 cents | over 15 cents |
| --- | --- | --- | --- |
| still filing | **91.16%** | 94.86% | 93.65% |

Spending more on fundraising went with surviving more, not less. In nine of the ten deciles
the under-five-cents band is the worst of the three outright. In the tenth, the largest
filers, it edges past the over-fifteen-cents band by half a point while still trailing the
middle band by 1.7. Only one of these two numbers is on the charity rating sites. It is the
one that is backwards.

Every comparison is inside a spending decile, so neither result is a story about big
charities. Fiscal 2022 is the cut because it is the last year covered by two processing
years of the IRS extract, so a late filer is not counted as a closure.

## What the site does

1. **Where does my gift buy the most time.** Say what you can give, pick a cause and a
   state. It ranks real organisations by days of runway your gift adds, which is
   `365 * yearly gift / annual spending`. The pool is filtered to organisations still
   filing for fiscal 2022 or later, spending at least $25,000 a year, with under six months
   of runway. All three filters are stated on the page.
2. **Look up any of 579,178 organisations** by name or EIN. Search is a static inverted
   index, no server, one fetch per query token.
3. **Read the honest brief.** Gemini writes it from a fixed packet of that filer's own
   figures and is not given anything else, so there is nothing for it to invent. It has to
   return a line naming what a tax filing cannot tell you.
4. **Hear it.** ElevenLabs reads the brief, for anyone who cannot read a wall of financial
   text on a screen.
5. **Check it.** One click publishes the SHA-256 of the figures shown and the brief written
   as a memo on Solana devnet, so the record of what this site said on a given date lives
   somewhere its author cannot edit.

## The four technologies and what each one carries

**Snowflake** holds the corpus and does the survival analysis. One statement cuts the
cohort into spending deciles and scores both candidate signals inside every decile at once.
Cortex does the language work next to the data. Only aggregates leave the warehouse:
Marketplace terms do not permit redistributing a dataset, so every per-organisation figure
the site serves comes from our own public domain IRS download instead. See
[DATA-SOURCES.md](DATA-SOURCES.md).

**Google AI** writes the brief under a JSON schema, from a packet containing every number
it is allowed to mention and no others, with an explicit rule that a missing field means
not reported rather than zero.

**ElevenLabs** speaks it. The voice id is resolved from the account with `GET /v2/voices`
rather than copied from the docs, because accounts created after March 2026 do not carry
the documented default voices and the example id 404s.

**Solana** is the only place the receipts live. Remove it and the app can no longer prove
that today's number is the number it computed from the filing.

The Solana transaction is built against the wire format rather than with a client library:
one signature, two account keys, one instruction. Ed25519 is already in
`crypto.subtle`. [`test/attest.wire.test.mjs`](test/attest.wire.test.mjs) proves those
bytes equal the ones `@solana/web3.js` produces, message, signature and full transaction.

One thing worth stating plainly. The signature is made on the server, where the key is, and
the transaction is submitted by the browser, because the public devnet RPC answers
Cloudflare's egress with `403 Your IP or provider is blocked from this endpoint` while a
visitor's own connection is fine. That RPC allows any origin. The client cannot change
what gets signed except the blockhash, which is length checked and which cannot turn a memo
into a transfer.

## Running it

```bash
npm install
cp .env.example .env          # GEMINI_API_KEY is the only one needed to see a brief
npm run data                  # downloads ~1 GB from the IRS, builds the warehouse, exports the site
npm run dev                   # http://localhost:8788
npm test                      # wire format checks
python3 test/browser.py       # drives the real site in headless Chrome
```

`npm run data` is four steps and needs no credentials: `data/fetch.sh` pulls the extracts,
`data/build.py` loads them into DuckDB, `data/analyse.py` prints the finding and
`data/export.py` writes the static shards the site reads. The shards are about 290 MB and
are not committed. `public/data/meta.json` is, so a clean clone still renders the tables.

## Honesty

- Every figure on an organisation page is that organisation's own reported number, labelled
  with the fiscal year it came from, computed in the browser from a static file. Nothing is
  modelled and nothing is imputed.
- Runway is cash plus savings over one month of spending. Form 990-EZ does not break out
  cash, so EZ filers show no runway rather than a guess.
- The survival tables are associations, not causal claims, controlled for size by decile
  and for nothing else.
- Keepalive is not a charity rating. It can tell you what an organisation's finances look
  like. It cannot tell you whether they are good at the work. Neither can any rating
  site.
- Solana devnet, not mainnet. No money moves anywhere in this project.
- AI assistance (Claude, Anthropic) was used in building this. The design, the analysis and
  the verification are the author's.

## Licence

[Source-Available No-Derivatives 1.0](LICENSE). Read it, run it, benchmark it, publish what
you find. Redistribution and derivative works are not granted.
