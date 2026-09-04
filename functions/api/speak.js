// POST /api/speak
// ElevenLabs reads a brief aloud.
//
// Three things matter here. The key never reaches a browser. The voice id is configured
// rather than discovered, because a scoped key with only text_to_speech permission answers
// 401 missing_permissions on GET /v2/voices. The fixed fallback list below holds default
// voices a free account can actually use, since a library voice answers 402 paid_plan_required.
// And the answer is cached by a hash of the text, so the second visitor to read the same
// brief costs nothing against a ten thousand credit monthly allowance.
//
// Everything that never changes is pre-rendered at build time into /audio by
// tools/narrate.mjs, so a visitor who only plays the tour spends no credits at all.

const MAX_CHARS = 1800;
// Default voices, in the order we would rather have them. All verified to synthesise on a
// free key. Library voices are deliberately absent: they answer 402 on the free plan.
const VOICES = [
  "JBFqnCBsd6RMkjVDRZzb", // George, warm narrator
  "onwK4e9ZLuTAKqWW03F9", // Daniel, news read
  "cgSgspJ2msm6clMCkdW9", // Jessica
  "EXAVITQu4vr4xnSDxMaL", // Sarah
];

async function hash(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
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

  const model = env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
  const key = `https://keepalive.invalid/tts/${model}/${await hash(text)}.mp3`;
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set("x-keepalive-audio", "cached");
    return r;
  }

  const order = env.ELEVENLABS_VOICE_ID ? [env.ELEVENLABS_VOICE_ID, ...VOICES] : VOICES;
  let last = "unknown";
  for (const voice of order) {
    let r;
    try {
      r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`,
        {
          method: "POST",
          headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: model,
            voice_settings: { stability: 0.45, similarity_boost: 0.7, speed: 1.0 },
          }),
        }
      );
    } catch (e) {
      last = String(e.message).slice(0, 160);
      continue;
    }
    if (!r.ok) {
      last = `${r.status} ${(await r.text()).slice(0, 160)}`;
      // 401 and 402 are about this voice or this key, so trying the next voice is worth it.
      // 429 means the monthly allowance is gone and no other voice will help.
      if (r.status === 429) break;
      continue;
    }
    const audio = new Response(r.body, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "public, max-age=2592000",
        "x-keepalive-audio": "fresh",
        "x-keepalive-voice": voice,
      },
    });
    const copy = audio.clone();
    await cache.put(key, copy);
    return audio;
  }
  return bad(`ElevenLabs refused every voice: ${last}`, 502);
}
