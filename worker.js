// Content relay for Cloudflare Workers.
// Fetches syosetu / aozora content server-side and returns it with CORS
// headers, so a web page (PWA) can use it despite the origins' lack of
// CORS. Upstream is restricted to those hosts, and responses are cached
// (1h) to be gentle on the origin.
const ALLOWED = [
  /^https:\/\/([a-z0-9-]+\.)?(syosetu\.com|aozora\.gr\.jp)\//i,
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target || !ALLOWED.some((re) => re.test(target))) {
      return new Response('forbidden target', { status: 403, headers: corsHeaders() });
    }

    const cache = caches.default;
    const cacheKey = new Request(target, { method: 'GET' });
    let res = await cache.match(cacheKey);
    if (!res) {
      const up = await fetch(target, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8', 'Referer': 'https://syosetu.com/' },
      });
      const body = await up.arrayBuffer();
      res = new Response(body, {
        status: up.status,
        headers: {
          'Content-Type': up.headers.get('Content-Type') || 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
      if (up.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(corsHeaders())) out.headers.set(k, v);
    return out;
  },
};
