// Narou relay for Cloudflare Workers.
// Fetches syosetu content server-side and returns it with CORS headers,
// so a web page (PWA) can use it despite the origin's lack of CORS.
// Upstream is restricted to syosetu hosts, and responses are cached
// (1h) to be gentle on the origin.
const ALLOWED = [
  /^https:\/\/([a-z0-9-]+\.)?syosetu\.com\//i,
];
const UA = 'Mozilla/5.0 (compatible; narou-relay/1.0)';

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
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
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
