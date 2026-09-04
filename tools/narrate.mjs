// Pre-render the fixed narration once, at build time, into public/audio.
//
// The free ElevenLabs tier is about ten minutes of audio a month, so synthesising the same
// sentences again for every visitor is not an optimisation problem, it is the difference
// between a demo that works on Sunday and one that does not. Everything that never changes
// is rendered here and served as a static file, which costs a visitor nothing. Only a brief
// about one specific filer is synthesised live, cached by a hash of the text.
//
// The four languages are not decoration. A tax filing is hard enough to read in your first
// language. The people who most need to know whether a charity will still be there next
// year are not all reading English. Gemini does the translation, ElevenLabs speaks it, and
// the English source stays the source of truth.
//
//   node tools/narrate.mjs            render anything missing
//   node tools/narrate.mjs --force    re-render everything
//
// Needs ELEVENLABS_API_KEY and, for the translations, GEMINI_API_KEY.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const OUT = path.join(import.meta.dirname, "..", "public", "audio");
const VOICE = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const GEMINI = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const FORCE = process.argv.includes("--force");

// English is written here. Everything else is translated from it.
const SCRIPT = {
  tour:
    "Keepalive reads the tax returns that every American charity has to file, and computes " +
    "one number that no charity rating site will show you. Months of runway. The cash an " +
    "organisation holds, divided by one month of its spending. Across one and a half million " +
    "long form filings, the middle of the pack holds five and a half months. A third hold " +
    "under three months. One in seven hold under a month. Type in a charity you care about, " +
    "and Keepalive will tell you how many months it has, and what your own gift does to that " +
    "number.",
  finding:
    "Here is what the filings say. Take the three hundred and twenty eight thousand " +
    "organisations that filed a long form return for fiscal twenty eighteen or twenty " +
    "nineteen, then check which of them still file three years later. Almost nine percent do " +
    "not. Thin runway is the worst outcome in all ten spending brackets. Eighty seven percent " +
    "of the ones holding under three months of cash were still filing, against ninety three " +
    "percent of the ones holding more. Now the number you are actually shown. The charities " +
    "that spent under five cents to raise a dollar survived less often than the ones spending " +
    "five to fifteen cents. That held in all ten brackets. Judge a charity by how little it " +
    "spends on itself, and you reward the ones with no capacity left to raise next year's " +
    "money.",
  gift:
    "The same money is worth wildly different amounts depending on who receives it. Twenty " +
    "five dollars a month buys about twelve hours of runway at a two hundred and sixty " +
    "million dollar food bank. At a twenty three thousand dollar organisation, the same " +
    "twenty five dollars a month buys nine days. Neither of those is charity. Both are " +
    "arithmetic, and only one of them is on any website.",
};

// Which pieces get translated, into what. Language names go to Gemini as written.
const LANGS = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi" },
  { code: "ta", name: "Tamil" },
  { code: "es", name: "Spanish (Latin American)" },
];
const TRANSLATE = ["tour"];

const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function translate(text, langName) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY needed for translation");
  const rules =
    `Translate the following into ${langName}, for a narrator to read aloud. Keep every ` +
    `number exactly as it is stated. Do not add anything, do not omit anything. Do not ` +
    `explain. Write numbers as words the way a newsreader would say them in ${langName}. ` +
    `Return only the translation.`;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: rules }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4000 },
      }),
    }
  );
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `gemini ${r.status}`);
  const out = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim();
  if (!out) throw new Error("gemini returned no translation");
  return out;
}

async function speak(text, file) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.7, speed: 1.0 },
      }),
    }
  );
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(file, buf);
  return buf.length;
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.log("no ELEVENLABS_API_KEY, nothing to render");
    return;
  }
  await mkdir(OUT, { recursive: true });
  const manifestPath = path.join(OUT, "manifest.json");
  let manifest = {};
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch {}

  let chars = 0;
  const jobs = [];
  for (const [id, english] of Object.entries(SCRIPT)) {
    for (const lang of LANGS) {
      if (lang.code !== "en" && !TRANSLATE.includes(id)) continue;
      jobs.push({ id, lang, english });
    }
  }

  // Free tier allows two concurrent requests, so this stays deliberately sequential.
  for (const { id, lang, english } of jobs) {
    const name = `${id}.${lang.code}.mp3`;
    const file = path.join(OUT, name);
    let text = english;
    if (lang.code !== "en") {
      const cached = manifest[name];
      text = cached?.text && !FORCE ? cached.text : await translate(english, lang.name);
    }
    const d = digest(text);
    if (!FORCE && manifest[name]?.digest === d && (await exists(file))) {
      console.log(`skip   ${name}  (unchanged)`);
      manifest[name].text = text;
      continue;
    }
    const bytes = await speak(text, file);
    chars += text.length;
    manifest[name] = { id, lang: lang.code, language: lang.name, digest: d, text, bytes };
    console.log(`render ${name}  ${text.length} chars  ${bytes} bytes`);
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
  console.log(
    `\n${Object.keys(manifest).length} clips, ${chars} characters synthesised this run ` +
    `(about ${Math.round(chars / 2)} credits on ${MODEL}, half a credit per character)`
  );
}

main().catch((e) => { console.error(String(e.message)); process.exit(1); });
