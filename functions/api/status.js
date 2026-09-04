// GET /api/status
// Which integrations this deployment can actually reach. The site uses this to say so on
// the page instead of showing a button that fails, which is the difference between a demo
// that looks broken and a demo that is honest about what is wired.

export async function onRequestGet({ env }) {
  const body = {
    gemini: Boolean(env.GEMINI_API_KEY),
    elevenlabs: Boolean(env.ELEVENLABS_API_KEY),
    solana: Boolean(env.SOLANA_SECRET_KEY),
    snowflake: Boolean(env.SNOWFLAKE_ACCOUNT && env.SNOWFLAKE_PRIVATE_KEY),
    model: env.GEMINI_MODEL || "gemini-3.5-flash",
    cluster: "devnet",
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
}
