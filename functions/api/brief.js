// POST /api/brief
// Gemini writes the organisation brief. The only thing it is given is a packet of that
// filer's own reported figures, so there is no room for it to invent one. The schema
// forces the shape, including a line about what the filings cannot tell you.

const MODEL = "gemini-3.5-flash";
const FALLBACK = "gemini-2.5-flash";

const SCHEMA = {
  type: "object",
  properties: {
    paragraphs: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: { type: "string" },
      description: "Two to four short paragraphs of plain English about this organisation.",
    },
    flags: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
      description: "Very short factual labels, three to six words each, no punctuation.",
    },
    cannot_know: {
      type: "string",
      description: "One sentence naming what a tax filing cannot tell a donor about this org.",
    },
  },
  required: ["paragraphs", "flags", "cannot_know"],
};

const RULES = `You write one honest brief about a US nonprofit for somebody deciding whether to
give it money. You are handed a JSON packet of figures taken from that organisation's own IRS
filings. Follow these rules exactly.

1. Every number you state must appear in the packet. Do not compute new ratios, do not estimate,
   do not round in a way that changes the figure. Never state a number that is not there.
2. Write money the way a reader expects it: $880,471 rather than 880471. Write months to one or
   two decimals. Always name the fiscal year a figure comes from.
3. Say the uncomfortable part. If runway is thin, lead with it. If the organisation looks steady,
   say that plainly instead of manufacturing worry.
4. Runway means cash and savings divided by one month of spending. It is the number this site
   exists to show. Treat under three months as strained, three to twelve as ordinary, over a year
   as comfortable. Say when the figure is missing because the filer used Form 990-EZ.
5. You know nothing about programme quality, outcomes, leadership or reputation. Say so in
   cannot_know, specifically, referring to this organisation's actual field of work.
6. No marketing voice. No adjectives doing work a number should do. No em dashes. No comma
   before "and" or "or". Short sentences. Never recommend or discourage giving. Describe.
7. If contributions are a small share of revenue, note that most of the money comes from
   programme fees or government, since that changes what a donation does.
8. A field that is absent from the packet was not reported. Do not mention it and never write
   that a figure is zero when it is simply missing.
9. Paragraph one is the runway and what it means. Paragraph two is where the money comes from.
   Paragraph three, if the packet supports it, is the direction of travel across the years.
10. Each flag is a short factual label of three to eight words, no full stop, naming the fiscal
   year when the label depends on one.`;

async function callGemini(key, model, packet) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: RULES }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(packet) }] }],
        generationConfig: {
          temperature: 0.35,
          // Gemini 3.5 spends thinking tokens out of this same budget, so a tight cap
          // truncates the JSON and the parse fails. Measured at about 2,200 thoughts
          // plus 400 of answer on a typical filer.
          maxOutputTokens: 6000,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
        },
      }),
    }
  );
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error?.message || `gemini ${r.status}`);
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error("gemini returned no text");
  return JSON.parse(text);
}

export async function onRequestPost({ request, env }) {
  const json = (o, s = 200) =>
    new Response(JSON.stringify(o), {
      status: s,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  if (!env.GEMINI_API_KEY) return json({ error: "no Gemini key on this deploy" }, 503);
  let facts;
  try {
    ({ facts } = await request.json());
  } catch (e) {
    return json({ error: "bad request body" }, 400);
  }
  if (!facts || !facts.ein) return json({ error: "facts.ein is required" }, 400);

  // Two models with one retry each, because a transient DNS or 503 on the way out should
  // not read to a visitor as "this organisation has no brief".
  const chain = [env.GEMINI_MODEL || MODEL, env.GEMINI_MODEL || MODEL, FALLBACK];
  let last = "unknown";
  for (let i = 0; i < chain.length; i++) {
    try {
      const out = await callGemini(env.GEMINI_API_KEY, chain[i], facts);
      return json({ ...out, model: chain[i] });
    } catch (e) {
      last = String(e.message).slice(0, 300);
      if (i < chain.length - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  return json({ error: last }, 502);
}
