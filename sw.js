const CACHE = 'ride-v26';
const ASSETS = ['./', 'index.html', 'app.css', 'app.js', 'cloud.js', 'config.js', 'manifest.json', 'icon.svg', 'sounds/sos-chime.mp3', 'sounds/sos-siren.mp3', 'sounds/sos-siren-last.mp3', 'sounds/ui/tap.mp3', 'sounds/ui/tab-forward.mp3', 'sounds/ui/tab-back.mp3', 'sounds/ui/open.mp3', 'sounds/ui/close.mp3', 'sounds/ui/on.mp3', 'sounds/ui/off.mp3', 'sounds/ui/pause.mp3', 'sounds/ui/resume.mp3', 'sounds/ui/cancel.mp3', 'sounds/ui/error.mp3', 'sounds/ui/split.mp3', 'sounds/ui/offroute.mp3', 'sounds/ui/saved.mp3', 'sounds/ui/bookmark.mp3', 'sounds/ui/arrive.mp3', 'app-icon-180.png', 'app-icon-192.png', 'app-icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// own files: network first, cache fallback. Map tiles / APIs go straight to the network.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
