// Content relay for Cloudflare Workers.
// Fetches syosetu / aozora content server-side and returns it with CORS
// headers, so a web page (PWA) can use it despite the origins' lack of
// CORS. Upstream is restricted to those hosts, and responses are cached
// (1h) to be gentle on the origin.
//
// Added 2026-11-11:
// - GET /api/aozora/search?q=... : server-side search over the Aozora
//   Bunko works index. The index (index.txt in this repo, built from the
//   official list_person_all_extended_utf8.zip with the same rules the
//   app used on-device: public-domain works only, deduped by text-file
//   URL) is fetched once and held in the Cache API, so aozora.gr.jp is
//   not hit per search and every client shares one copy.
// - Search logging: aozora searches and narou API searches (novelapi
//   calls carrying a `word` parameter) are written to a KV log
//   (binding LOG_KV), one entry per key:
//   "log:YYYY-MM-DD:<ISO time>:<random>" (day in JST), value = a single
//   JSON object {t, src, q, n}. Per-entry keys avoid the
//   read-modify-write race that a single daily array key has under
//   KV's eventual consistency (an early version lost an entry that
//   way). Only the query text, source and result count are stored --
//   no IP address, no user agent, no identifiers.
//
// Added 2026-11-12:
// - POST /api/log/shelf : bookshelf-add logging. The app sends one
//   explicit event at the moment a book is added to the shelf (never
//   inferred from proxy traffic, which cannot distinguish a fetch
//   from an add). Body (JSON): {src: "aozora"|"narou", id, title,
//   author, via} -- id is the Aozora text-file URL or the Narou
//   ncode; via is the entry point: "search" | "recommend" |
//   "ranking" | "direct". Stored in the same KV under a separate
//   prefix, one entry per key: "add:YYYY-MM-DD:<ISO time>:<random>"
//   (day in JST), value = {t, src, id, title, author, via}. Only
//   book metadata is stored -- no IP address, no user agent, no
//   identifiers, same policy as the search log. Aggregation /
//   ranking display is intentionally NOT done yet; this only
//   accumulates the raw events.
const ALLOWED = [
  /^https:\/\/([a-z0-9-]+\.)?(syosetu\.com|aozora\.gr\.jp|kakuyomu\.jp)\//i,
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const INDEX_URL = 'https://raw.githubusercontent.com/uotamy/narou-relay/main/index.txt';
const INDEX_CACHE_KEY = 'https://narou-relay.internal/aozora-index-v1';
const SEARCH_CAP = 60;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

async function logSearch(env, src, q, n) {
  if (!env || !env.LOG_KV || !q) return;
  try {
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 3600 * 1000);
    const day = jst.toISOString().slice(0, 10);
    const entry = { t: now.toISOString(), src, q, n };
    const suffix = Math.random().toString(36).slice(2, 10);
    const key = 'log:' + day + ':' + entry.t + ':' + suffix;
    await env.LOG_KV.put(key, JSON.stringify(entry));
  } catch (e) { /* logging must never break a request */ }
}

const SHELF_SRCS = { aozora: 1, narou: 1 };
const SHELF_VIAS = { search: 1, recommend: 1, ranking: 1, direct: 1 };

// POST /api/log/shelf -- one explicit bookshelf-add event from the
// app. Validates and truncates the fields, then stores the entry in
// LOG_KV under the "add:" prefix (same per-entry key scheme as the
// search log). Always answers 200/400 JSON; a KV failure is reported
// as 503 so the caller can tell, but the app treats logging as
// fire-and-forget and never blocks a registration on it.
async function shelfLog(request, env) {
  if (!env || !env.LOG_KV) return jsonResponse({ ok: false, error: 'kv_unavailable' }, 503);
  let b;
  try { b = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'bad_json' }, 400); }
  if (!b || typeof b !== 'object') return jsonResponse({ ok: false, error: 'bad_body' }, 400);
  const src = String(b.src || '');
  const id = String(b.id || '').slice(0, 500);
  const via = String(b.via || '');
  if (!SHELF_SRCS[src] || !id || !SHELF_VIAS[via]) {
    return jsonResponse({ ok: false, error: 'bad_fields' }, 400);
  }
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = jst.toISOString().slice(0, 10);
  const entry = {
    t: now.toISOString(),
    src,
    id,
    title: String(b.title || '').slice(0, 300),
    author: String(b.author || '').slice(0, 300),
    via,
  };
  const suffix = Math.random().toString(36).slice(2, 10);
  const key = 'add:' + day + ':' + entry.t + ':' + suffix;
  try {
    await env.LOG_KV.put(key, JSON.stringify(entry));
  } catch (e) {
    return jsonResponse({ ok: false, error: 'kv_put_failed' }, 503);
  }
  return jsonResponse({ ok: true });
}

async function loadIndex(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(INDEX_CACHE_KEY, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return await hit.text();
  const up = await fetch(INDEX_URL);
  if (!up.ok) throw new Error('index fetch failed: ' + up.status);
  const text = await up.text();
  const store = new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=604800' },
  });
  ctx.waitUntil(cache.put(cacheKey, store.clone()));
  return text;
}

// Index line format: searchText \t title \t subtitle \t author \t textZipUrl
// searchText is the lowercased "title subtitle author yomi..." string,
// identical to what the app built on-device. A query word only counts
// when it occurs inside searchText (before the first tab), exactly like
// the on-device substring match. Multiple words are ANDed; the app also
// split on ASCII/fullwidth spaces.
function searchIndex(blob, q) {
  const words = q.toLowerCase().split(/[\s　]+/).filter(Boolean);
  if (!words.length) return { total: 0, items: [] };
  let lines = null;
  for (const w of words) {
    const found = [];
    let pos = 0;
    while (pos <= blob.length) {
      const i = blob.indexOf(w, pos);
      if (i < 0) break;
      const ls = blob.lastIndexOf('\n', i) + 1;
      const tab = blob.indexOf('\t', ls);
      if (tab >= 0 && i < tab) {
        let le = blob.indexOf('\n', ls);
        if (le < 0) le = blob.length;
        found.push(blob.slice(ls, le));
        pos = le + 1;
        if (found.length >= 5000) break;
      } else {
        pos = i + w.length;
      }
    }
    if (lines === null) lines = found;
    else {
      const set = new Set(found);
      lines = lines.filter((l) => set.has(l));
    }
    if (!lines.length) break;
  }
  const items = lines.slice(0, SEARCH_CAP).map((line) => {
    const p = line.split('\t');
    return { t: p[1] || '', sub: p[2] || '', a: p[3] || '', u: p[4] || '' };
  });
  return { total: lines.length, items };
}

// Aggregate the KV search log into counts for the operations
// dashboard: totals by source, today's counts (JST), and a per-day
// breakdown. Handles both key shapes: the retired daily-array key
// ("log:YYYY-MM-DD", value = JSON array) and the current per-entry
// keys ("log:YYYY-MM-DD:<ISO time>:<random>", value = one entry).
// Cached for 5 minutes so dashboard refreshes stay gentle on KV.
async function statsResponse(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://narou-relay.internal/stats-v1', { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const byDay = {};
  const bySrc = { aozora: 0, narou: 0 };
  let total = 0;
  const add = (day, src) => {
    if (!byDay[day]) byDay[day] = { date: day, aozora: 0, narou: 0, total: 0 };
    byDay[day].total += 1;
    total += 1;
    if (src === 'aozora' || src === 'narou') {
      byDay[day][src] += 1;
      bySrc[src] += 1;
    }
  };
  try {
    if (env && env.LOG_KV) {
      let cursor;
      let scanned = 0;
      do {
        const page = await env.LOG_KV.list({ prefix: 'log:', cursor, limit: 1000 });
        for (const k of page.keys) {
          const day = k.name.slice(4, 14);
          if (k.name.length === 14) {
            const arr = await env.LOG_KV.get(k.name, 'json');
            if (Array.isArray(arr)) for (const e of arr) add(day, e && e.src);
          } else if (scanned < 500) {
            scanned += 1;
            const e = await env.LOG_KV.get(k.name, 'json');
            if (e) add(day, e.src);
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
  } catch (e) { /* return whatever was aggregated */ }
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const todayStr = jst.toISOString().slice(0, 10);
  const days = Object.values(byDay).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 14);
  const out = {
    updated: new Date().toISOString(),
    total,
    bySrc,
    today: byDay[todayStr] || { date: todayStr, aozora: 0, narou: 0, total: 0 },
    days,
  };
  const res = new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...corsHeaders() },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function aozoraSearch(request, env, ctx) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jsonResponse({ total: 0, items: [] });
  let blob;
  try {
    blob = await loadIndex(ctx);
  } catch (e) {
    return jsonResponse({ error: 'index_unavailable' }, 503);
  }
  const r = searchIndex(blob, q);
  ctx.waitUntil(logSearch(env, 'aozora', q, r.total));
  return jsonResponse(r);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    if (url.pathname === '/api/aozora/search') {
      return aozoraSearch(request, env, ctx);
    }
    if (url.pathname === '/api/stats') {
      return statsResponse(env, ctx);
    }
    if (url.pathname === '/api/log/shelf') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
      return shelfLog(request, env);
    }
    const target = url.searchParams.get('url');
    if (!target || !ALLOWED.some((re) => re.test(target))) {
      return new Response('forbidden target', { status: 403, headers: corsHeaders() });
    }

    // Narou keyword searches go through the novel API with a `word`
    // parameter; log them server-side (the response itself is proxied
    // untouched below).
    try {
      const t = new URL(target);
      if (t.hostname === 'api.syosetu.com' && t.pathname.indexOf('/novelapi/') === 0) {
        const w = (t.searchParams.get('word') || '').trim();
        if (w) ctx.waitUntil(logSearch(env, 'narou', w, null));
      }
    } catch (e) { /* ignore */ }

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
