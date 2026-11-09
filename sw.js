const BUILD = "0d576259bea5";

// Offline copy of the library. Every page and picture is cached on its own, keyed by a content hash listed in sw-manifest.json, so an update
// downloads only what changed. The trimmed bird-call clips are part of the library; the full recordings are on Wikimedia Commons and are not cached.
const FILES = 'vt-ref-files', META = 'vt-ref-meta';
const SCOPE = self.registration.scope;
const abs = u => new URL(u, SCOPE).href;
const say = async msg => { for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg); };
const readJSON = async (cache, key) => { const r = await cache.match(key); return r ? r.json() : null; };
let syncing = null;

async function status() {
  const meta = await caches.open(META), cache = await caches.open(FILES);
  const man = await readJSON(meta, 'manifest'), have = (await readJSON(meta, 'hashes')) || {};
  const files = man ? man.files : {}, urls = Object.keys(files);
  let done = 0;
  for (const u of urls) if (have[u] === files[u] && await cache.match(abs(u))) done++;
  return { type: 'offline-status', done, total: urls.length, build: man ? man.build : '', working: syncing !== null };
}

async function doSync() {
  const meta = await caches.open(META), cache = await caches.open(FILES);
  let man;
  try { const r = await fetch(abs('sw-manifest.json'), { cache: 'reload' }); if (!r.ok) throw 0; man = await r.json(); }
  catch (e) { return; }                                   // offline or the site is down: keep what is already saved
  const have = (await readJSON(meta, 'hashes')) || {};
  const files = man.files, urls = Object.keys(files), total = urls.length;
  const keep = {}, todo = [];
  for (const u of urls) {
    if (have[u] === files[u] && await cache.match(abs(u))) keep[u] = files[u]; else todo.push(u);
  }
  await meta.put('manifest', new Response(JSON.stringify(man)));
  let done = total - todo.length, i = 0, lastSaid = 0;
  const progress = async force => { if (force || done - lastSaid >= 5) { lastSaid = done; await say({ type: 'offline-status', done, total, build: man.build, working: true }); } };
  await progress(true);
  const worker = async () => {
    while (i < todo.length) {
      const u = todo[i++];
      try {
        const r = await fetch(abs(u), { cache: 'reload' });
        if (!r.ok) throw 0;
        await cache.put(abs(u), r);
        keep[u] = files[u]; done++;
      } catch (e) { /* left out of the saved list, so the next sync tries it again */ }
      await progress(false);
    }
  };
  await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
  for (const k of await cache.keys()) {                    // drop pages and pictures that are no longer in the library
    const rel = k.url.slice(SCOPE.length).split('?')[0];
    if (!(rel in files)) await cache.delete(k);
  }
  await meta.put('hashes', new Response(JSON.stringify(keep)));
  await say({ type: 'offline-status', done, total, build: man.build, working: false });
}
const sync = () => { if (!syncing) syncing = doSync().catch(() => {}).finally(() => { syncing = null; }); return syncing; };

self.addEventListener('install', e => { e.waitUntil(sync().then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== FILES && k !== META).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => {
  const t = e.data && e.data.type;
  if (t === 'status') e.waitUntil(status().then(s => e.source && e.source.postMessage(s)));
  if (t === 'sync') e.waitUntil(sync());
});
// Audio and video elements ask for byte ranges; Safari will not play a cached file unless the worker answers with a 206 slice.
async function rangeOf(req, resp) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (!m || (!m[1] && !m[2])) return resp;
  const buf = await resp.arrayBuffer(), size = buf.byteLength;
  let s = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10), e = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
  s = Math.max(0, s); e = Math.min(e, size - 1);
  if (s > e) return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(buf.slice(s, e + 1), { status: 206, statusText: 'Partial Content', headers: {
    'Content-Type': resp.headers.get('Content-Type') || 'audio/mpeg', 'Content-Range': 'bytes ' + s + '-' + e + '/' + size, 'Content-Length': String(e - s + 1), 'Accept-Ranges': 'bytes' } });
}
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(FILES);
    let hit = await c.match(req, { ignoreSearch: true });
    if (!hit && url.pathname.endsWith('/')) hit = await c.match(abs('index.html'));
    if (hit) return req.headers.has('range') ? rangeOf(req, hit) : hit;
    try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }
    catch (err) { return (await c.match(abs('index.html'))) || Response.error(); }
  })());
});
