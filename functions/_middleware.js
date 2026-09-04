// Pages Functions run for every request under /. Keep the API answers uncacheable and
// send a plain 404 for anything under /api that has no handler, so a typo does not fall
// through to the static asset handler and return index.html with a 200.
export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  const res = await next();
  if (url.pathname.startsWith("/api/") && res.status === 404) {
    return new Response(JSON.stringify({ error: "no such endpoint" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  return res;
}
