---
title: A charity does not close because its overhead was too high. I checked 328,186 tax returns.
published: true
tags: devchallenge, weekendchallenge
cover_image:
---

*This is a submission for [Weekend Challenge: Generosity Edition](https://dev.to/challenges/weekend-2026-09-03)*

I have given money to charities for years and I have never once known whether the one I
gave to was about to close. The number everybody puts in front of you is overhead, the
share of spending that does not go to programmes. Every rating site leads with it. I
assumed it meant something.

So this weekend I downloaded the IRS Statistics of Income extracts of Form 990 and Form
990-EZ, which is 3,697,515 filings covering 700,873 organisations across fiscal 2017 to
2024, then asked a narrower question. Not whether a charity is efficient. Whether it is
going to still be there.

I took the 328,186 organisations that filed a long-form Form 990 for fiscal 2018 or 2019,
then checked which of them appear on any filing for fiscal 2022 or later. **8.88% do not.**
Then I scored two candidate signals inside each of ten spending deciles, so that nothing I
found could turn out to be a story about big charities outliving small ones.

**Feeding America spends $4.93 billion a year and holds 1.04 months of it in cash.** The
Greater Chicago Food Depository spends $261 million and holds half a month. Second Harvest
Food Bank of Central Florida holds nine days. None of that is on any rating site, because
the number nobody computes for you is the one that decides whether the lights stay on.

## What I Built

**[Keepalive](https://keepalive.zkasuran.dev)** computes months of runway for 579,178 US
nonprofits, straight off their own filings. Runway is cash plus savings divided by one
month of spending. It is the number a finance director lives by and the number a donor
never sees.

Across 1,573,687 long-form filings the median is **5.5 months**. **33.5% hold under three
months.** 15.1% hold under one.

The site does four things with that.

1. **Where does my gift buy the most time.** Say what you can give, pick a cause and a
   state. It ranks real organisations by days of runway your money adds, which is
   `365 * yearly gift / annual spending`. $25 a month is 12 hours of runway at a $260
   million food bank and 9.4 days at a $23,000 one. The same money, three orders of
   magnitude apart in effect. That single line changed how I give.
2. **Look up any of the 579,178** by name or EIN, with seven years of revenue, spending
   and cash on one chart.
3. **Read the brief.** Gemini writes it from a fixed packet of that filer's own figures
   and is handed nothing else, so there is nothing for it to invent. It has to return a
   line naming what a tax filing cannot tell you.
4. **Check it.** One click publishes the SHA-256 of the figures on screen and the brief
   just written as a memo on Solana devnet, so what Keepalive said about an organisation
   on a given date lives somewhere its author cannot quietly edit.

### The finding

Both tables below hold inside every one of ten spending deciles.

**Runway predicts survival.** Thin runway is the worst of the three bands in all ten
deciles. Pooled with deciles weighted equally: **86.79%** of the under-three-months group
was still filing, against 92.61% at three to twelve months and 93.56% above a year. The gap
is 10.3 points in the smallest decile and 1.6 in the largest, so it bites hardest exactly
where the money is smallest.

**Fundraising thrift points the wrong way.** The organisations that spent under five cents
to raise a dollar survived *less* than the five-to-fifteen-cent band, in all ten deciles:
**91.16%** against 94.86%. Spending more on fundraising went with surviving more. In nine of
the ten deciles the thriftiest band is the worst of the three outright. Only one of these
two numbers is on the rating sites. It is the one that is backwards.

That is the starvation cycle, visible in tax returns. Judge a charity on how little it
spends on itself and you reward the ones with no capacity to raise next year's money.

## Demo

**Live: <https://keepalive.zkasuran.dev>** No sign-in, nothing to install.

Try it in 30 seconds:

1. Open the site. The two survival tables under **The finding** are the whole result, drawn
   from the same query.
2. In the search box type **greater chicago food depository**. Open it. The runway card
   reads **0.5 months** on a **$261m** budget. The peer card shows **95.6%** of
   organisations in its own spending decile and runway band still filing.
3. Scroll to **The honest brief** and wait about eight seconds. Gemini writes it live. Read
   the last line, the one that starts "What these filings cannot tell you".
4. Press **Publish a checkable receipt**. About four seconds later you get a Solana devnet
   signature. Open it. The memo on chain holds the SHA-256 of exactly what you just read.
5. Back at the top, set the amount to **25 per month**, cause **Food, agriculture and
   nutrition**, state **TN**. The list re-ranks by days of runway your $300 a year adds.

## Code

{% embed https://github.com/zkasuran/keepalive %}

`npm run data` reproduces every number: it pulls the IRS extracts, loads 3.7 million
filings, prints the finding and writes the static shards the site reads. It needs no
credentials and no account.

## How I Built It

There is no runtime database. The site is 4,542 static files on a CDN plus four small
functions that hold keys a browser cannot have.

**Search is a static inverted index.** 579,178 names tokenise to 1,910,797 postings, hashed
into 2,048 shard files. The browser hashes your query tokens, fetches only the shards it
needs and intersects them. Typing "greater chicago food depository" costs three fetches and
no server. Each posting list is ordered by spending, which matters more than it sounds:
truncate a common token like "food" and the intersection silently stops finding real names.
That was my first real bug.

**Organisation records are sharded by EIN modulo 1024**, so one lookup is one 250 KB fetch
that the CDN then holds.

**Google AI** writes the brief under a JSON schema, from a packet containing every number it
is permitted to mention and no others. Absent fields are dropped rather than sent as zero,
because "not reported" and "$0" are different claims and a model handed a zero will tell you
the charity has no employees. The system prompt forbids computing a new ratio. One measured
detail: Gemini 3.5 Flash spends its thinking tokens out of the same `maxOutputTokens`
budget, about 2,200 of them here, so a tight cap truncates the JSON and the parse fails.
That looks exactly like a bad model and is not.

**Solana** is the only place the receipts live. Keepalive keeps no copy. Remove Solana and
the app can no longer prove that today's number is the number it computed from the filing,
which is the honest answer to "how do I know your AI did not make this up".

The transaction is built against the wire format rather than with a client library. A memo
transaction is one signature, two account keys and one instruction. Ed25519 is already in
`crypto.subtle`, so an SDK would have added megabytes to buy nothing.
[`test/attest.wire.test.mjs`](https://github.com/zkasuran/keepalive/blob/main/test/attest.wire.test.mjs)
proves those bytes equal the ones `@solana/web3.js` produces: message, signature and full
serialized transaction, byte for byte, including a memo that crosses the compact-u16
boundary.

One thing I want to state plainly rather than hide. The signature is made on the server,
where the key is. The transaction is submitted by your browser. That is not a design
flourish. The public devnet RPC answers Cloudflare's egress with
`403 Your IP or provider is blocked from this endpoint` while a visitor's own connection is
fine. That RPC allows any origin. So the key stays server side and the network call
happens where the network works. The only thing a client controls is the blockhash, which is
length checked and which cannot turn a memo into a transfer.

**Snowflake** is the warehouse path, in
[`data/snowflake.sql`](https://github.com/zkasuran/keepalive/blob/main/data/snowflake.sql):
the same cohort plus one statement that cuts it into deciles then scores both signals inside
every decile at once. Cortex does the language work next to the data, with `AI_CLASSIFY` over
names the IRS only gave a letter code and `AI_AGG` writing one sentence per filer from all of
its returns together. There is a licensing line I held to: Marketplace
terms do not permit redistributing a dataset, so every per-organisation figure this site
serves comes from my own public domain IRS download instead. Only aggregates ever leave a
warehouse. Sources and the exact granting sentence for each are in
[DATA-SOURCES.md](https://github.com/zkasuran/keepalive/blob/main/DATA-SOURCES.md).

**ElevenLabs** reads a brief aloud, because the reason a lot of people cannot use a giving
tool is that it is a wall of financial text. The free tier is ten minutes of audio a month,
so fixed narration is pre-rendered once at build time and a visitor costs zero credits. Only
a brief about a specific filer is synthesised live. The voice id is resolved with
`GET /v2/voices` rather than copied from the docs, since accounts created after March 2026
do not carry the documented defaults and the example id 404s.

### What is real and what is not

- Every figure on an organisation page is that organisation's own reported number, labelled
  with the fiscal year, computed in your browser from a static file. Nothing is modelled and
  nothing is imputed.
- Form 990-EZ does not break out cash, so EZ filers show no runway rather than a guess.
- The survival tables are associations, not causation, controlled for size by decile and for
  nothing else.
- Solana devnet, not mainnet. No money moves anywhere in this project. Keepalive is not a
  payment processor and never touches a donation.
- Keepalive is not a charity rating. It can tell you what an organisation's finances look
  like. It cannot tell you whether they are good at the work. Neither can any rating site.
- AI assistance (Claude) was used in building this. The design, the analysis and the
  verification are mine. Every number above came out of SQL I can rerun in front of you.

## Prize Categories

- **Best Use of Google AI.** Gemini writes every brief under a JSON schema from a packet of
  that filer's own figures, with a rule that a missing field means not reported.
- **Best Use of Solana.** A devnet memo is the only store of record for what this site
  published. Remove it and no claim on the page is checkable. The transaction is hand built
  and proved byte-identical to the reference implementation.

The ElevenLabs and Snowflake paths are written and in the repository, and the live deploy
tells you plainly that neither credential is bound to it: `/api/status` returns them false,
the Listen button says so instead of failing silently, and the finding tables you are
reading were produced by the same SQL run locally in DuckDB rather than in a warehouse. I
would rather say that than claim two categories a judge cannot see working. If that changes
before the deadline I will say so here in an edit, with the timestamp.

Thanks for a theme worth building for. The most useful thing I learned is that the kindest
gift to a small charity is not the largest one, it is the predictable one. The number to ask
about is months.
