// Keepalive. No framework, no build step. Three data sources, all static:
// meta.json for the headline numbers and the finding, o/<ein % 1024>.json for one
// organisation, i/<hash>.json for the name index. Everything else is a fetch to a
// function that holds a key we cannot ship to a browser.

const D = "/data";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = { meta: null, org: null, shardCache: new Map(), idxCache: new Map() };

const fmtMoney = (v) => {
  if (v === null || v === undefined) return "not reported";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}bn`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
  if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
};
const fmtNum = (v, d = 0) =>
  v === null || v === undefined ? "n/a" : Number(v).toLocaleString("en-US", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
const einDash = (e) => {
  const s = String(e).padStart(9, "0");
  return `${s.slice(0, 2)}-${s.slice(2)}`;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const titleish = (s) =>
  String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Of|And|The|For|In|On|To|A|An)\b/g, (m) => m.toLowerCase())
    .replace(/\b(Usa|Us|Inc|Llc|Ii|Iii|Iv|Nyc|Ymca|Ywca|Pta)\b/gi, (m) => m.toUpperCase());

// history row layout, kept in one place so the shape is documented once
const H = { FY: 0, FORM: 1, REV: 2, CONTRIB: 3, EXP: 4, LIQUID: 5, RUNWAY: 6, COST: 7 };

const STOP = new Set(("the of and for inc incorporated a an to in at on association foundation " +
  "trust org organization co company llc corp corporation society club group usa us national " +
  "american america").split(" "));

function norm(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
}
function toks(s) {
  const all = norm(s).split(/\s+/).filter((w) => w.length > 1);
  const kept = all.filter((w) => !STOP.has(w));
  return kept.length ? kept : all;
}
function tokShard(t) {
  let h = 2166136261;
  for (const ch of t) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 2048;
}

async function getJSON(url, cache, key) {
  if (cache && cache.has(key)) return cache.get(key);
  const p = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (cache) cache.set(key, p);
  return p;
}
const shard = (ein) => getJSON(`${D}/o/${Number(ein) % 1024}.json`, state.shardCache, Number(ein) % 1024);
const idxShard = (n) => getJSON(`${D}/i/${n}.json`, state.idxCache, n);

async function loadOrg(ein) {
  const s = await shard(ein);
  return s ? s[String(ein)] || null : null;
}

// -------------------------------------------------------------------- search

async function search(q) {
  const digits = q.replace(/[^0-9]/g, "");
  if (digits.length === 9) {
    const one = await loadOrg(Number(digits));
    if (one) return [one];
  }
  const t = toks(q);
  if (!t.length) return [];
  const lists = await Promise.all(t.map(async (tok) => {
    const sh = await idxShard(tokShard(tok));
    if (!sh) return [];
    if (sh[tok]) return sh[tok];
    // no exact token, so treat the last word as a prefix, which is what a person
    // half way through typing a name actually means
    const pref = Object.keys(sh).filter((k) => k.startsWith(tok)).slice(0, 24);
    return pref.flatMap((k) => sh[k]);
  }));
  const score = new Map();
  lists.forEach((l) => new Set(l).forEach((e) => score.set(e, (score.get(e) || 0) + 1)));
  if (!score.size) return [];
  const best = Math.max(...score.values());
  // Every query token has to hit. A long query is allowed to miss one. Looser than that
  // "chicago food depository" returns every organisation in Chicago.
  const need = t.length <= 2 ? t.length : Math.max(2, best);
  const ranked = [...score.entries()]
    .filter(([, c]) => c >= need)
    .sort((a, b) => b[1] - a[1]).slice(0, 260).map(([e]) => e);
  const recs = (await Promise.all(ranked.map(loadOrg))).filter(Boolean);
  const nq = norm(q);
  const rank = (o) => {
    const n = norm(o.n);
    if (n === nq) return 0;
    if (n.startsWith(nq)) return 1;
    if (n.includes(nq)) return 2;
    return t.every((w) => n.includes(w)) ? 3 : 4;
  };
  recs.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    return (latest(b)?.[H.EXP] || 0) - (latest(a)?.[H.EXP] || 0);
  });
  return recs.slice(0, 24);
}

const latest = (o) => (o && o.h && o.h.length ? o.h[o.h.length - 1] : null);
const latestWithRunway = (o) =>
  (o && o.h ? [...o.h].reverse().find((r) => r[H.RUNWAY] !== null && r[H.RUNWAY] !== undefined) : null);

// -------------------------------------------------------------------- runway wording

function band(m) {
  if (m === null || m === undefined) return { key: "unknown", label: "not computable", tone: "" };
  if (m < 1) return { key: "u1", label: "under one month", tone: "alarm" };
  if (m < 3) return { key: "u3", label: "one to three months", tone: "alarm" };
  if (m < 6) return { key: "u6", label: "three to six months", tone: "" };
  if (m < 12) return { key: "u12", label: "six to twelve months", tone: "calm" };
  if (m < 24) return { key: "u24", label: "one to two years", tone: "calm" };
  return { key: "o24", label: "over two years", tone: "calm" };
}

function survivalFor(o) {
  // the cohort rate for this organisation's own spending decile and runway band,
  // read out of the same table the finding section prints
  const m = state.meta;
  const row = m?.decile_runway?.find((r) => r.size_decile === o.d);
  const r = latestWithRunway(o)?.[H.RUNWAY];
  if (!row || r === null || r === undefined) return null;
  const pct = r < 3 ? row.thin : r < 12 ? row.mid : row.fat;
  return { pct, decile: o.d, median_spend: row.median_spend };
}

// -------------------------------------------------------------------- chart

function chart(h) {
  const rows = h.filter((r) => r[H.EXP] !== null);
  if (rows.length < 2) return "";
  const W = 720, HT = 190, PL = 52, PR = 12, PT = 14, PB = 26;
  const xs = rows.map((r) => r[H.FY]);
  const vals = rows.flatMap((r) => [r[H.EXP] || 0, r[H.REV] || 0, r[H.LIQUID] || 0]);
  const max = Math.max(...vals, 1);
  const x = (i) => PL + (i * (W - PL - PR)) / Math.max(1, rows.length - 1);
  const y = (v) => HT - PB - ((v || 0) / max) * (HT - PT - PB);
  const line = (k) => rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r[k]).toFixed(1)}`).join(" ");
  const area = `${line(H.LIQUID)} L${x(rows.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const ticks = [0, max / 2, max].map(
    (v) => `<line class="grid" x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W - PR}" y2="${y(v).toFixed(1)}"/>
      <text class="axis" x="${PL - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${esc(fmtMoney(v))}</text>`
  ).join("");
  const years = rows.map((r, i) =>
    `<text class="axis" x="${x(i).toFixed(1)}" y="${HT - 8}" text-anchor="middle">${r[H.FY]}</text>`).join("");
  return `
    <svg class="chart" viewBox="0 0 ${W} ${HT}" role="img"
         aria-label="Revenue, spending and liquid money by fiscal year">
      ${ticks}${years}
      <path class="liq" d="${area}"/>
      <path class="rev" d="${line(H.REV)}"/>
      <path class="exp" d="${line(H.EXP)}"/>
    </svg>
    <div class="legend">
      <span><i style="background:var(--accent)"></i>cash and savings</span>
      <span><i style="background:var(--ink-2)"></i>spending</span>
      <span><i style="background:var(--ink-3)"></i>revenue</span>
    </div>`;
}

// -------------------------------------------------------------------- org view

async function showOrg(ein, push = true) {
  const o = await loadOrg(ein);
  if (!o) return;
  state.org = o;
  const box = $("#orgview");
  box.hidden = false;
  const l = latest(o), lr = latestWithRunway(o);
  const runway = lr ? lr[H.RUNWAY] : null;
  const b = band(runway);
  const surv = survivalFor(o);
  const cause = state.meta?.ntee?.[o.g] || "Unclassified";
  const gift = Number($("#amount")?.value || 25) * Number($("#cadence")?.value || 12);
  const daysPerYear = l && l[H.EXP] > 0 ? (365 * gift) / l[H.EXP] : null;

  box.innerHTML = `
    <div class="orghead">
      <div>
        <h2>${esc(titleish(o.n))}</h2>
        <p class="orgmeta">
          EIN ${esc(einDash(o.e))} &middot; ${esc(o.c || "")}${o.c && o.s ? ", " : ""}${esc(o.s || "")}
          &middot; ${esc(cause)} (NTEE ${esc(o.t || "n/a")})
          &middot; latest filing FY${l ? l[H.FY] : "n/a"} (Form ${l && l[H.FORM] === 1 ? "990-EZ" : "990"})
          &middot; <a href="https://projects.propublica.org/nonprofits/organizations/${o.e}"
                     rel="noopener" target="_blank">filings on ProPublica</a>
        </p>
      </div>
      <button class="btn" id="closeorg" aria-label="Close">Close</button>
    </div>

    <div class="bigrow">
      <div class="big ${b.tone}">
        <div class="k">Months of runway</div>
        <div class="v">${runway === null ? "n/a" : fmtNum(runway, 1)}</div>
        <div class="u">${esc(b.label)}${lr ? ` &middot; FY${lr[H.FY]}` : ""}</div>
        <div class="meter ${b.tone === "alarm" ? "alarm" : ""}">
          <i style="width:${Math.min(100, ((runway || 0) / 24) * 100).toFixed(1)}%"></i>
        </div>
      </div>
      <div class="big">
        <div class="k">Annual spending</div>
        <div class="v">${esc(fmtMoney(l && l[H.EXP]))}</div>
        <div class="u">${esc(fmtMoney(l && l[H.EXP] ? l[H.EXP] / 12 : null))} a month</div>
      </div>
      <div class="big">
        <div class="k">Cash and savings</div>
        <div class="v">${esc(fmtMoney(lr && lr[H.LIQUID]))}</div>
        <div class="u">${lr && lr[H.FORM] === 1
          ? "Form 990-EZ does not break out cash"
          : "line 1 plus line 2 of the balance sheet"}</div>
      </div>
      <div class="big ${surv && surv.pct < 90 ? "alarm" : "calm"}">
        <div class="k">Peers still filing five years on</div>
        <div class="v">${surv ? fmtNum(surv.pct, 1) + "%" : "n/a"}</div>
        <div class="u">${surv
          ? `same spending decile, same runway band`
          : "needs a long-form filing"}</div>
      </div>
    </div>

    <div class="subhead">What your gift does</div>
    <div class="pledge" id="giftbox">
      ${daysPerYear === null ? `<p class="empty">No spending figure on the latest filing, so there is nothing honest to divide.</p>` : `
      <p>$${fmtNum(gift, 0)} a year is
        <strong>${fmtNum(daysPerYear, daysPerYear < 1 ? 2 : 1)} days</strong>
        of runway here, and
        <strong>${fmtNum((gift / l[H.EXP]) * 100, 2)}%</strong>
        of everything this organisation spends in a year.</p>
      <p class="empty">Change the amount in the box above and this updates. The arithmetic is
        365 times your yearly gift, divided by their annual spending.</p>`}
    </div>

    <div class="subhead">Seven years, read off the filings</div>
    ${chart(o.h)}

    <div class="subhead">The honest brief</div>
    <div class="brief loading" id="brief">Reading the filings&hellip;</div>
    <div class="actions">
      <button class="btn" id="speak" disabled>Listen to this brief</button>
      <button class="btn" id="attest" disabled>Publish a checkable receipt</button>
    </div>
    <div id="audio"></div>
    <div id="attestout"></div>
  `;
  $("#closeorg").onclick = () => { box.hidden = true; history.pushState({}, "", "/"); };
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  if (push) history.pushState({ ein }, "", `/?ein=${o.e}`);
  loadBrief(o);
}

// -------------------------------------------------------------------- the brief

function briefFacts(o) {
  // Exactly the numbers the model is allowed to talk about. Nothing else is sent, so
  // there is nothing else it can cite. A field the filer left blank is dropped rather
  // than sent as a zero, because zero and "not reported" are different claims.
  const l = latest(o), lr = latestWithRunway(o);
  const surv = survivalFor(o);
  const raw = {
    ein: o.e,
    name: o.n,
    city: o.c,
    state: o.s,
    ntee_code: o.t,
    cause: state.meta?.ntee?.[o.g] || null,
    latest_fiscal_year: l ? l[H.FY] : null,
    form: l && l[H.FORM] === 1 ? "990-EZ" : "990",
    annual_spending: l ? l[H.EXP] : null,
    annual_revenue: l ? l[H.REV] : null,
    contributions_and_grants: l ? l[H.CONTRIB] : null,
    program_revenue: o.pr || null,
    cash_and_savings: lr ? lr[H.LIQUID] : null,
    runway_months: lr ? lr[H.RUNWAY] : null,
    runway_fiscal_year: lr ? lr[H.FY] : null,
    cents_to_raise_a_dollar: lr && lr[H.COST] ? Math.round(lr[H.COST] * 100) : null,
    employees_reported: o.emp || null,
    grants_paid_out: o.go || null,
    officer_compensation: o.oc || null,
    net_assets: o.na ?? null,
    total_assets: o["as"] || null,
    total_liabilities: o.li || null,
    peer_runway_percentile: o.p,
    peer_group_size: o.pn,
    peers_still_filing_pct: surv ? surv.pct : null,
    history: o.h.map((r) => {
      const row = { fy: r[H.FY], form: r[H.FORM] === 1 ? "990-EZ" : "990" };
      if (r[H.REV]) row.revenue = r[H.REV];
      if (r[H.CONTRIB]) row.contributions = r[H.CONTRIB];
      if (r[H.EXP]) row.spending = r[H.EXP];
      if (r[H.LIQUID]) row.cash_and_savings = r[H.LIQUID];
      if (r[H.RUNWAY] !== null && r[H.RUNWAY] !== undefined) row.runway_months = r[H.RUNWAY];
      return row;
    }),
  };
  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== null && v !== undefined && v !== "")
  );
}

async function loadBrief(o) {
  const el = $("#brief");
  const facts = briefFacts(o);
  try {
    const r = await fetch("/api/brief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ facts }),
    });
    const j = await r.json();
    if (!r.ok || !j.paragraphs) throw new Error(j.error || "brief unavailable");
    el.classList.remove("loading");
    el.innerHTML = j.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("") +
      (j.cannot_know ? `<p class="cannot"><strong>What these filings cannot tell you:</strong> ${esc(j.cannot_know)}</p>` : "") +
      `<div class="chips">${(j.flags || []).map((f) =>
        `<span class="chip ${/thin|risk|falling|concentr|drop|late|no cash|deficit/i.test(f) ? "warn" : ""}">${esc(f)}</span>`
      ).join("")}</div>`;
    state.brief = j;
    const sp = $("#speak"), at = $("#attest");
    if (sp) { sp.disabled = false; sp.onclick = () => speak(o, j); }
    if (at) { at.disabled = false; at.onclick = () => attest(o, j); }
  } catch (e) {
    el.classList.remove("loading");
    el.innerHTML = `<p class="empty">The written brief needs the Gemini key on the server and it did not
      answer just now (${esc(e.message)}). Every number above is computed in the browser from the
      filings, so the page is still complete without it.</p>`;
  }
}

// -------------------------------------------------------------------- audio

async function speak(o, brief) {
  const btn = $("#speak"), out = $("#audio");
  btn.disabled = true; btn.textContent = "Reading it out…";
  const text = [`${titleish(o.n)}.`, ...(brief.paragraphs || [])].join(" ");
  try {
    const r = await fetch("/api/speak", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ein: o.e }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `status ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    out.innerHTML = `<audio controls autoplay src="${url}"></audio>
      <p class="note">Spoken with ElevenLabs. Text to speech is here so that a donor who cannot
      read this screen still gets the whole brief, in a voice rather than a screen reader
      flattening the page.</p>`;
    btn.textContent = "Read again";
  } catch (e) {
    out.innerHTML = `<p class="note">No audio right now: ${esc(e.message)}. The pre-rendered tour
      under "How it works" does not depend on live credits.</p>`;
    btn.textContent = "Listen to this brief";
  }
  btn.disabled = false;
}

// -------------------------------------------------------------------- chain receipt

const RPC = "https://api.devnet.solana.com";

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// The signature is made on the server, where the key is. The submission happens here,
// because Cloudflare's egress is refused by the public devnet RPC while a browser's own
// connection is not. That RPC allows any origin.
async function attest(o, brief) {
  const btn = $("#attest"), out = $("#attestout");
  btn.disabled = true;
  const step = (s) => { btn.textContent = s; };
  try {
    step("Reading a blockhash…");
    const { value } = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]);

    step("Signing…");
    const r = await fetch("/api/attest", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ facts: briefFacts(o), brief, blockhash: value.blockhash }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `status ${r.status}`);

    step("Publishing…");
    const sig = await rpc("sendTransaction", [
      j.transaction, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 },
    ]);

    step("Confirming…");
    let confirmed = false;
    for (let i = 0; i < 30 && !confirmed; i++) {
      const st = await rpc("getSignatureStatuses", [[sig]]);
      const s = st?.value?.[0];
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) confirmed = true;
      else await new Promise((res) => setTimeout(res, 900));
    }

    out.innerHTML = `
      <div class="ledger">
        <div class="l"><span>receipt for EIN ${esc(einDash(o.e))}${confirmed ? ", confirmed on devnet" : ", submitted"}</span>
          <span class="amt">sha256 ${esc(j.digest.slice(0, 16))}…</span></div>
        <div class="l"><span><a href="https://solana.fm/tx/${esc(sig)}?cluster=devnet-solana"
          target="_blank" rel="noopener">${esc(sig.slice(0, 32))}…</a></span><span>open on solana.fm</span></div>
        <div class="l"><span>signed by ${esc(j.signer.slice(0, 12))}…</span>
          <span><a href="https://solana.fm/address/${esc(j.signer)}?cluster=devnet-solana"
            target="_blank" rel="noopener">every receipt this site has published</a></span></div>
      </div>
      <p class="note">That transaction carries the SHA-256 of the exact figures on this page and the brief
      you just read. Nobody, us included, can change what Keepalive said about this organisation on this
      date without the digest failing. Keepalive stores no copy: the signer address above is the whole
      publication history. One <code>getSignaturesForAddress</code> call returns it with the memo text
      inline.</p>`;
    btn.textContent = confirmed ? "Published" : "Submitted";
  } catch (e) {
    out.innerHTML = `<p class="note">Receipt not published: ${esc(e.message)}. The devnet signer needs a
      funded key. The public faucet hands out one grant per address per day.</p>`;
    btn.textContent = "Publish a checkable receipt";
    btn.disabled = false;
  }
}


// -------------------------------------------------------------------- gift matcher

let giftTab = "leverage";

async function runGift(ev) {
  if (ev) ev.preventDefault();
  const amount = Number($("#amount").value || 0);
  const per = Number($("#cadence").value || 12);
  const cause = $("#cause").value;
  const st = $("#state").value;
  const yearly = amount * per;
  const box = $("#giftresults");
  if (!(yearly > 0)) { box.innerHTML = ""; return; }
  box.innerHTML = `<p class="empty">Looking…</p>`;
  const key = `${cause || "all"}-${st || "us"}`;
  const bucket = await getJSON(`${D}/g/${key}.json`);
  if (!bucket || !bucket.leverage?.length) {
    box.innerHTML = `<p class="empty">Nothing in the pool for that combination. Widen the cause or the state.</p>`;
    return;
  }
  const list = bucket[giftTab] || bucket.leverage;
  const causeLabel = cause ? state.meta.ntee[cause] : "any cause";
  const stateLabel = st || "the whole US";
  box.innerHTML = `
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" data-tab="leverage" aria-selected="${giftTab === "leverage"}">Where it buys the most time</button>
      <button class="tab" role="tab" data-tab="urgent" aria-selected="${giftTab === "urgent"}">Where the runway is thinnest</button>
    </div>
    <div class="cards">${list.map((r) => giftCard(r, yearly)).join("")}</div>
    <p class="note">
      ${fmtNum(bucket.n, 0)} organisations match ${esc(causeLabel.toLowerCase())} in ${esc(stateLabel)}
      after three filters, all of them deliberate: still filing for fiscal 2022 or later, so they
      exist; spending at least $25,000 a year, so there is a real operation; under six months of
      runway, because that is the population under strain. Ranked by how many days of runway your
      $${fmtNum(yearly, 0)} a year adds, which is 365 times your gift over their annual spending.
      Keepalive can tell you what an organisation's finances look like. It cannot tell you whether
      they are good at the work. Neither can any rating site.
    </p>`;
  $$(".tab", box).forEach((t) => (t.onclick = () => { giftTab = t.dataset.tab; runGift(); }));
  $$(".card", box).forEach((c) => (c.onclick = () => showOrg(Number(c.dataset.ein))));
}

function giftCard(r, yearly) {
  const days = r.x > 0 ? (365 * yearly) / r.x : 0;
  const b = band(r.r);
  return `
    <button class="card" data-ein="${r.e}" type="button">
      <span>
        <span class="name">${esc(titleish(r.n))}</span>
        <span class="where">${esc(r.c || "")}${r.c && r.s ? ", " : ""}${esc(r.s || "")} &middot; ${esc(state.meta.ntee[r.g] || "")}</span>
      </span>
      <span class="lead">${fmtNum(days, days < 1 ? 2 : days < 10 ? 1 : 0)}<small>days of runway<br>your gift adds</small></span>
      <span class="figs">
        <span class="fig">runway <b>${fmtNum(r.r, 1)} mo</b> (${esc(b.label)})</span>
        <span class="fig">spends <b>${esc(fmtMoney(r.x))}</b>/yr</span>
        <span class="fig">your gift is <b>${fmtNum((yearly / r.x) * 100, 2)}%</b> of that</span>
        <span class="fig">FY${r.fy}</span>
      </span>
    </button>`;
}

// -------------------------------------------------------------------- the finding

function tableFrom(caption, note, head, rows, cellClass) {
  return `<figure>
    <figcaption>${note}</figcaption>
    <div class="tablewrap"><table>
      <caption>${esc(caption)}</caption>
      <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) =>
        `<td class="${cellClass ? cellClass(r, i) : ""}">${c === null || c === undefined ? "&ndash;" : esc(String(c))}</td>`
      ).join("")}</tr>`).join("")}</tbody>
    </table></div>
  </figure>`;
}

function renderFinding() {
  const m = state.meta;
  const c = m.cohort;
  const dr = m.decile_runway, df = m.decile_fundraising;
  const drRows = dr.map((r) => [
    `decile ${r.size_decile}`, fmtMoney(r.median_spend), `${fmtNum(r.thin, 1)}%`,
    `${fmtNum(r.mid, 1)}%`, `${fmtNum(r.fat, 1)}%`,
  ]);
  const dfRows = df.map((r) => [
    `decile ${r.size_decile}`, fmtMoney(r.median_spend), `${fmtNum(r.under5c, 1)}%`,
    `${fmtNum(r.c5to15, 1)}%`, `${fmtNum(r.over15c, 1)}%`,
  ]);
  const worstIsFirst = (row, i) => (i === 2 ? "worst" : i === 3 ? "best" : "");

  $("#findingtables").innerHTML =
    tableFrom(
      "Still filing five years later, by months of runway at the start",
      `Runway is the signal. Thin runway is the worst outcome in <b>all ten</b> spending deciles,
       and the gap runs from ${fmtNum(dr[0].mid - dr[0].thin, 1)} points in the smallest decile to
       ${fmtNum(dr[9].mid - dr[9].thin, 1)} points in the largest. No charity rating site shows you
       this number.`,
      ["spending decile", "median spend", "under 3 months", "3 to 12 months", "over 12 months"],
      drRows, worstIsFirst
    ) +
    tableFrom(
      "Still filing five years later, by cents spent to raise a dollar",
      `And here is the number you <b>are</b> shown, pointing the wrong way. The organisations that
       spent under five cents to raise a dollar had the <b>lowest</b> survival in every one of the
       ten deciles. Spending more on fundraising went with surviving more, not less. That is the
       starvation cycle showing up in tax returns.`,
      ["spending decile", "median spend", "under 5 cents", "5 to 15 cents", "over 15 cents"],
      dfRows, worstIsFirst
    ) +
    `<figure><figcaption>
      Cohort: <b>${fmtNum(c.orgs, 0)}</b> organisations that filed a long-form Form 990 for fiscal
      2018 or 2019. Outcome: whether the same EIN appears on any filing for fiscal 2022 or later.
      <b>${fmtNum(100 - c.pct_survived, 2)}%</b> did not.
      Fiscal 2022 is the cut because it is the last year covered by two processing years of the IRS
      extract, so a late filer is not counted as a closure. Runway is cash plus savings over one
      month of spending, from the balance sheet, which Form 990-EZ does not break out, so EZ filers
      are outside the cohort. Deciles are cut on the cohort's own spending, which is why every
      comparison above is inside a size band rather than across them.
    </figcaption></figure>`;
}

// -------------------------------------------------------------------- how it works

async function renderHow() {
  const m = state.meta;
  let live = {};
  try { live = await (await fetch("/api/status")).json(); } catch (e) { live = {}; }
  const off = (k, what) => live[k] ? "" : `<p class="off">Not wired on this deploy: ${what}</p>`;
  $("#howbody").innerHTML = `
    <div class="tech">
      <h3>Snowflake <span>warehouse</span></h3>
      <p>${fmtNum(m.filings_total, 0)} filings across ${m.fy_range[0]} to ${m.fy_range[1]} land in a
      warehouse, then one SQL statement cuts the cohort into spending deciles and scores both
      candidate signals inside every decile at once. The survival tables above are that query's
      output.</p>
      <p>Cortex runs the language work next to the data: <code>AI_CLASSIFY</code> puts a donor-facing
      cause on organisations the IRS only gave a letter code. <code>AI_AGG</code> writes one
      sentence about a filer from all of its returns at once. No rows leave the warehouse to do it.</p>
      <p>Only aggregates ship. Marketplace terms do not allow redistributing a dataset, so the
      per-organisation figures on this site come from our own IRS download, which is public domain.</p>
      ${off("snowflake", "the survival tables here are the warehouse output, exported to JSON.")}
    </div>
    <div class="tech">
      <h3>Google AI <span>Gemini</span></h3>
      <p>The brief on an organisation page is written by Gemini from a fixed JSON packet of that
      filer's own numbers and nothing else. The schema forces it to return paragraphs, flags and one
      "what these filings cannot tell you" line. Every figure it may mention is in the packet, so
      there is nothing for it to invent.</p>
      <p>It also reads plain language into a filter, so "helps kids read in rural Tennessee" becomes a
      cause code, a state and a size band rather than a keyword search.</p>
      ${off("gemini", "briefs fall back to the computed numbers, which are all client side.")}
    </div>
    <div class="tech">
      <h3>ElevenLabs <span>voice</span></h3>
      <p>Every brief can be spoken. That is not a novelty: a third of the reason people cannot use a
      giving tool is that it is a wall of financial text. The tour and the finding are pre-rendered at
      build time so a visitor costs zero credits. Live briefs stream on demand.</p>
      ${off("elevenlabs", "the Listen button reports that plainly instead of failing silently.")}
    </div>
    <div class="tech">
      <h3>Solana <span>devnet</span></h3>
      <p>Keepalive keeps no database of what it published. Every receipt is a signed memo on Solana
      devnet carrying the SHA-256 of the figures shown and the brief written, so the record of what
      this site said about an organisation on a given date is held somewhere we cannot edit.</p>
      <p>Remove Solana and the app can no longer prove that today's number is the number it computed
      from the filing. That is the whole point of putting it there.</p>
      ${off("solana", "receipts need a funded devnet key; the button says so rather than pretending.")}
    </div>`;
}

// -------------------------------------------------------------------- init

function fillSelects() {
  const m = state.meta;
  const cause = $("#cause");
  m.causes.filter((c) => m.ntee[c.g]).forEach((c) => {
    const o = document.createElement("option");
    o.value = c.g; o.textContent = `${m.ntee[c.g]} (${fmtNum(c.n, 0)})`;
    cause.append(o);
  });
  const st = $("#state");
  m.states.forEach((s) => {
    const o = document.createElement("option");
    o.value = s; o.textContent = s; st.append(o);
  });
}

function fillStats() {
  const m = state.meta, rd = m.runway_distribution;
  const set = (k, v) => $$(`[data-stat="${k}"]`).forEach((el) => (el.textContent = v));
  set("orgs", fmtNum(m.orgs, 0));
  set("filings", `${(m.filings_total / 1e6).toFixed(1)}M`);
  set("p50", fmtNum(rd.p50, 1));
  set("under3", `${Math.round(rd.pct_under_3)}%`);
  set("years", `${m.fy_range[0]}–${m.fy_range[1]}`);
}

function wireSearch() {
  const input = $("#q"), sug = $("#suggest");
  let t = null, seq = 0;
  const close = () => { sug.hidden = true; sug.innerHTML = ""; };
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 3) return close();
    t = setTimeout(async () => {
      const mine = ++seq;
      const res = await search(q);
      if (mine !== seq) return;
      if (!res.length) {
        sug.hidden = false;
        sug.innerHTML = `<button type="button" disabled><span class="s-name">Nothing found</span>
          <span class="s-meta">try fewer words or paste the nine digit EIN</span></button>`;
        return;
      }
      sug.hidden = false;
      sug.innerHTML = res.map((o) => {
        const l = latest(o), lr = latestWithRunway(o);
        return `<button type="button" data-ein="${o.e}">
          <span class="s-name">${esc(titleish(o.n))}</span>
          <span class="s-meta">${esc(o.c || "")}${o.c && o.s ? ", " : ""}${esc(o.s || "")}
            &middot; spends ${esc(fmtMoney(l && l[H.EXP]))}
            &middot; ${lr && lr[H.RUNWAY] !== null ? fmtNum(lr[H.RUNWAY], 1) + " mo runway" : "runway n/a"}
            &middot; EIN ${esc(einDash(o.e))}</span>
        </button>`;
      }).join("");
      $$("button[data-ein]", sug).forEach((b) => (b.onclick = () => {
        close(); input.value = ""; showOrg(Number(b.dataset.ein));
      }));
    }, 160);
  });
  input.addEventListener("blur", () => setTimeout(close, 180));
  $$("[data-q]").forEach((b) => (b.onclick = async () => {
    input.value = b.dataset.q;
    input.dispatchEvent(new Event("input"));
    input.focus();
  }));
}

async function boot() {
  state.meta = await getJSON(`${D}/meta.json`);
  if (!state.meta) return;
  fillStats();
  fillSelects();
  renderFinding();
  renderHow();
  wireSearch();
  $("#giftform").addEventListener("submit", runGift);
  ["amount", "cadence", "cause", "state"].forEach((id) =>
    $(`#${id}`).addEventListener("change", () => { if ($("#giftresults").innerHTML) runGift(); }));
  $("#amount").addEventListener("input", () => {
    if (state.org) showOrg(state.org.e, false);
  });
  const ein = new URLSearchParams(location.search).get("ein");
  if (ein) showOrg(Number(ein), false);
  window.addEventListener("popstate", (e) => {
    const q = new URLSearchParams(location.search).get("ein");
    if (q) showOrg(Number(q), false); else $("#orgview").hidden = true;
  });
  runGift();
}

boot();




