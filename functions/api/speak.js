// POST /api/speak
// ElevenLabs reads a brief aloud. Two things matter here. The key never reaches a
// browser. The voice id is resolved from the account rather than copied from the
// docs, because accounts created after March 2026 do not carry the classic default
// voices and the documented example id simply 404s.

const MODEL = "eleven_flash_v2_5"; // 0.5 credits per character, half the cost of v2
const MAX_CHARS = 1800;

let cachedVoice = null;

async function pickVoice(key, preferred) {
  if (preferred) return preferred;
  if (cachedVoice) return cachedVoice;
  const r = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
    headers: { "xi-api-key": key },
  });
  if (!r.ok) throw new Error(`could not list voices (${r.status})`);
  const { voices = [] } = await r.json();
  if (!voices.length) throw new Error("this account holds no voices");
  // prefer a calm narrator if the account has one, else take the first available
  const pick =
    voices.find((v) => /news|narrat|calm|documentar/i.test(`${v.name} ${v.description || ""}`)) ||
    voices[0];
  cachedVoice = pick.voice_id;
  return cachedVoice;
}

export async function onRequestPost({ request, env }) {
  const bad = (msg, status) =>
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  if (!env.ELEVENLABS_API_KEY) return bad("no ElevenLabs key on this deploy", 503);

  let text = "";
  try {
    ({ text } = await request.json());
  } catch (e) {
    return bad("bad request body", 400);
  }
  text = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  if (text.length < 20) return bad("nothing to read", 400);

  try {
    const voice = await pickVoice(env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID);
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: env.ELEVENLABS_MODEL || MODEL,
          voice_settings: { stability: 0.45, similarity_boost: 0.7, speed: 1.0 },
        }),
      }
    );
    if (!r.ok) {
      const detail = await r.text();
      return bad(`ElevenLabs ${r.status}: ${detail.slice(0, 180)}`, 502);
    }
    return new Response(r.body, {
      headers: {
        "content-type": "audio/mpeg",
        // one month, keyed by the URL the client already hashes per brief
        "cache-control": "public, max-age=2592000",
      },
    });
  } catch (e) {
    return bad(String(e.message).slice(0, 200), 502);
  }
}
