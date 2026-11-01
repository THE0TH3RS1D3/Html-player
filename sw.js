const CACHE = 'pocket-arcade-v13';
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

/* ---- database (one shared connection, reopened if iOS drops it) ---- */
let dbp = null;
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
function getDB() {
  if (!dbp) {
    dbp = openDB().then(db => {
      db.onclose = () => { dbp = null; };
      db.onversionchange = () => { db.close(); dbp = null; };
      return db;
    }).catch(e => { dbp = null; throw e; });
  }
  return dbp;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function readKey(key) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const db = await getDB();
      return await new Promise((res, rej) => {
        const q = db.transaction('files').objectStore('files').get(key);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    } catch (e) { lastErr = e; dbp = null; await wait(150 * (i + 1)); }
  }
  throw lastErr;
}

// If an exact name is missing, look for the same name with different upper/lower case or accents
async function findLoose(key) {
  const prefix = key.split('/')[0] + '/';
  const db = await getDB();
  const keys = await new Promise((res, rej) => {
    const q = db.transaction('files').objectStore('files').getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const norm = s => s.normalize('NFC').toLowerCase();
  const want = norm(key);
  return keys.find(k => norm(k) === want) || null;
}

async function tell(msg) {
  try {
    const cs = await self.clients.matchAll({ includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type: 'pa-problem', msg }));
  } catch (e) {}
}

// itch.io's anti-hotlink script replaces the game with an "use itch.io" page when it
// is not on itch.io, so it is removed from game pages.
function stripItch(text) {
  return text.replace(/<script[^>]*\ssrc=["']https?:\/\/static\.itch\.io\/[^"']*["'][^>]*>\s*<\/script>/gi, '');
}

async function serveGameFile(request, rest) {
  // rest looks like "<id>/<path inside the zip>"
  let key;
  try { key = rest.split('/').map(decodeURIComponent).join('/'); } catch (e) { key = rest; }
  if (key.endsWith('/')) key += 'index.html';
  try {
    let rec = await readKey(key);
    if (!rec) {
      const alt = await findLoose(key);
      if (alt) rec = await readKey(alt);
    }
    if (!rec) {
      tell('Missing file: ' + key.slice(key.indexOf('/') + 1));
      return new Response('Not found: ' + key, { status: 404 });
    }
    let data = rec.data;
    if (rec.type === 'text/html') {
      const txt = new TextDecoder().decode(data), fixed = stripItch(txt);
      if (fixed !== txt) data = new TextEncoder().encode(fixed).buffer;
    }
    const headers = { 'Content-Type': rec.type, 'Accept-Ranges': 'bytes' };
    const total = data.byteLength;
    const range = request.headers.get('Range');
    if (range) {
      // iOS needs byte-range support for audio and video
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (end >= total) end = total - 1;
      return new Response(data.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }
      });
    }
    return new Response(data, { headers: { ...headers, 'Content-Length': String(total) } });
  } catch (e) {
    tell('Could not read ' + key.slice(key.indexOf('/') + 1) + ': ' + (e && e.message || e));
    return new Response('Read error: ' + (e && e.message || e), { status: 500 });
  }
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
