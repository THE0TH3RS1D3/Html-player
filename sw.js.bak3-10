const CACHE = 'pocket-arcade-v2';
const FILES = ['./', './index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pocket-arcade', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('games')) d.createObjectStore('games', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function serveGameFile(request, rest) {
  // rest looks like "<id>/<path inside the zip>"
  let key = rest.split('/').map(decodeURIComponent).join('/');
  if (key.endsWith('/')) key += 'index.html';
  const db = await openDB();
  const rec = await new Promise(res => {
    const q = db.transaction('files').objectStore('files').get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(null);
  });
  db.close();
  if (!rec) return new Response('Not found', { status: 404 });

  const headers = { 'Content-Type': rec.type, 'Accept-Ranges': 'bytes' };
  const total = rec.data.byteLength;
  const range = request.headers.get('Range');
  if (range) {
    // iOS needs byte-range support for audio and video
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (end >= total) end = total - 1;
    return new Response(rec.data.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }
    });
  }
  return new Response(rec.data, { headers: { ...headers, 'Content-Length': String(total) } });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const base = new URL('./play/', self.registration.scope);
  if (url.origin === base.origin && url.pathname.startsWith(base.pathname)) {
    e.respondWith(serveGameFile(e.request, url.pathname.slice(base.pathname.length)));
    return;
  }
  // Network first so app updates arrive; fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
