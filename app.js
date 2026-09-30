const $ = id => document.getElementById(id);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const ROUTER = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/';
const GEOCODER = 'https://nominatim.openstreetmap.org/';

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}
function fmtTime(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}` : `${m}:${String(ss).padStart(2,'0')}`;
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`; }
function haversine(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat/2)**2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function offset(p, dist, bearingDeg) {
  const R = 6371000, d = dist / R, b = bearingDeg * Math.PI / 180;
  const la1 = p.lat * Math.PI / 180, lo1 = p.lon * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lon: lo2 * 180 / Math.PI };
}

/* =====================================================================
   Maps
   ===================================================================== */
// standard OSM tiles, darkened with a CSS filter (see .leaflet-tile-pane in app.css)
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
function makeMap(el) {
  const m = L.map(el, { zoomControl: false, attributionControl: true }).setView([60.17, 24.94], 13);
  L.tileLayer(TILES, { attribution: ATTR, maxZoom: 19 }).addTo(m);
  m.attributionControl.setPrefix(false);
  return m;
}
const meStyle = { radius: 7, color: '#000', weight: 3, fillColor: '#fff', fillOpacity: 1 };
const homeMap = makeMap('homeMap');
const rideMap = makeMap('rideMap');
const homeMe = L.circleMarker([0, 0], meStyle);
const rideMe = L.circleMarker([0, 0], meStyle);

let follow = true;
rideMap.on('dragstart', () => { follow = false; });
$('recenter').addEventListener('click', () => {
  follow = true;
  if (lastFix) rideMap.setView([lastFix.lat, lastFix.lon], Math.max(rideMap.getZoom(), 16));
});

/* =====================================================================
   Tabs
   ===================================================================== */
const TABS = ['home', 'record', 'profile'];
let tab = null;
function showTab(name) {
  if (tab === name) return;
  tab = name;
  TABS.forEach((t, i) => {
    $('view-' + t).classList.toggle('active', t === name);
    document.querySelector(`.tabbar [data-tab=${t}]`).classList.toggle('active', t === name);
    if (t === name) $('indicator').style.transform = `translateX(${i * 100}%)`;
  });
  if (name === 'home') { homeMap.invalidateSize(); if (!routesGenerated && lastFix) generateRoutes(); }
  if (name === 'record') { rideMap.invalidateSize(); if (!rideActive) startRide(); }
  if (name === 'profile') renderProfile();
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* =====================================================================
   GPS
   ===================================================================== */
let lastFix = null, lastFixAt = 0, speedKmh = 0;
let gotFirstFix = false;

function onPos(p) {
  const c = p.coords;
  const fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: p.timestamp };
  let v = c.speed;
  if ((v === null || isNaN(v)) && lastFix) {
    const dt = (fix.t - lastFix.t) / 1000;
    v = dt > 0 ? haversine(lastFix, fix) / dt : 0;
  }
  speedKmh = Math.max(0, (v || 0) * 3.6);
  if (speedKmh < 1.5) speedKmh = 0;
  lastFix = fix; lastFixAt = Date.now();
  $('gps').textContent = '';

  const ll = [fix.lat, fix.lon];
  homeMe.setLatLng(ll); rideMe.setLatLng(ll);
  if (!gotFirstFix) {
    gotFirstFix = true;
    homeMe.addTo(homeMap); rideMe.addTo(rideMap);
    homeMap.setView(ll, 13);
    rideMap.setView(ll, 16);
    if (tab === 'home' && !routesGenerated) generateRoutes();
  } else if (follow && tab === 'record') {
    rideMap.panTo(ll, { animate: true });
  }

  onRideFix(fix);
  onNavFix(fix);
}
function onErr(e) {
  const msg = e.code === 1 ? 'Ei sijaintilupaa' : 'Ei GPS';
  $('gps').textContent = msg;
  if (!gotFirstFix) $('homeStatus').textContent = msg;
}
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && rideActive) keepAwake(); });

/* =====================================================================
   Ride recording
   ===================================================================== */
let rideActive = false, paused = false;
let elapsed = 0, lastTick = Date.now(), distance = 0, maxSpeed = 0, lastRidePos = null;
let track = null;

function startRide() {
  rideActive = true; paused = false;
  elapsed = 0; distance = 0; maxSpeed = 0; lastRidePos = null; lastTick = Date.now();
  if (track) track.remove();
  track = L.polyline([], { color: '#fff', weight: 3, opacity: .55 }).addTo(rideMap);
  document.body.classList.add('riding');
  setPaused(false);
  keepAwake();
}
function onRideFix(fix) {
  if (!rideActive || paused) return;
  if (fix.acc <= 30) {
    if (lastRidePos) {
      const d = haversine(lastRidePos, fix);
      if (d > 2 && d < 200) { distance += d; track.addLatLng([fix.lat, fix.lon]); }
    } else track.addLatLng([fix.lat, fix.lon]);
    if (speedKmh > maxSpeed) maxSpeed = speedKmh;
    lastRidePos = fix;
  }
}
function renderRide() {
  $('speed').textContent = Math.round(speedKmh);
  $('time').textContent = fmtTime(elapsed);
  $('dist').textContent = (distance / 1000).toFixed(2);
}
setInterval(() => {
  const now = Date.now();
  if (rideActive && !paused) elapsed += now - lastTick;
  lastTick = now;
  if (now - lastFixAt > 5000) speedKmh = 0;
  renderRide();
}, 250);

function setPaused(v) {
  paused = v;
  document.body.classList.toggle('paused', v);
  $('icoPause').hidden = v;
  $('icoPlay').hidden = !v;
  $('pause').setAttribute('aria-label', v ? 'Jatka' : 'Tauko');
  lastRidePos = null;
}
$('pause').addEventListener('click', () => {
  if (!rideActive) startRide();
  else setPaused(!paused);
  navigator.vibrate?.(20);
});
$('main').addEventListener('click', () => {
  if (!paused) return;
  navigator.vibrate?.(40);
  const avg = elapsed > 0 ? (distance / 1000) / (elapsed / 3600000) : 0;
  $('sTime').textContent = fmtTime(elapsed);
  $('sDist').textContent = (distance / 1000).toFixed(2);
  $('sAvg').textContent = Math.round(avg);
  $('sMax').textContent = Math.round(maxSpeed);
  if (elapsed > 10000) {
    const rides = store.get('rides', []);
    rides.unshift({ at: Date.now(), ms: elapsed, m: Math.round(distance), avg: +avg.toFixed(1), max: +maxSpeed.toFixed(1) });
    store.set('rides', rides.slice(0, 200));
  }
  $('summary').classList.add('open');
});
$('newRide').addEventListener('click', () => {
  rideActive = false;
  setPaused(false);
  elapsed = 0; distance = 0; maxSpeed = 0;
  if (track) { track.remove(); track = null; }
  document.body.classList.remove('riding');
  wakeLock?.release?.();
  $('summary').classList.remove('open');
  renderRide();
  showTab('home');
});

/* =====================================================================
   Routing (OSRM bike) + turn-by-turn
   ===================================================================== */
async function route(points) {
  const coords = points.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const r = await fetch(`${ROUTER}${coords}?overview=full&geometries=geojson&steps=true`);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error('route');
  const rt = j.routes[0];
  return {
    line: rt.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    distance: rt.distance,
    duration: rt.duration,
    steps: rt.legs.flatMap(l => l.steps).map(s => ({
      type: s.maneuver.type, mod: s.maneuver.modifier || '', name: s.name || '',
      lat: s.maneuver.location[1], lon: s.maneuver.location[0]
    })).filter(s => s.type !== 'depart' && s.type !== 'new name' && !(s.type === 'continue' && s.mod === 'straight')),
    points
  };
}

const MOD = {
  'straight': ['suoraan', 0], 'slight right': ['loivasti oikealle', 45], 'right': ['oikealle', 90],
  'sharp right': ['jyrkästi oikealle', 135], 'uturn': ['U-käännös', 180], 'sharp left': ['jyrkästi vasemmalle', -135],
  'left': ['vasemmalle', -90], 'slight left': ['loivasti vasemmalle', -45]
};
function describe(s) {
  if (s.type === 'arrive') return ['Perillä', 0];
  const [txt, deg] = MOD[s.mod] || ['jatka', 0];
  if (s.type === 'roundabout' || s.type === 'rotary') return [`Liikenneympyrästä ${txt}`, deg];
  return [txt[0].toUpperCase() + txt.slice(1) + (s.name ? ` · ${s.name}` : ''), deg];
}

let active = null, activeLine = null, stepIdx = 0;

function setActiveRoute(r) {
  clearRoute();
  active = r; stepIdx = 0;
  activeLine = L.polyline(r.line, { color: '#0a84ff', weight: 5, opacity: .9 }).addTo(rideMap);
  rideMap.invalidateSize();
  rideMap.fitBounds(activeLine.getBounds(), { padding: [30, 30], paddingTopLeft: [30, 130] });
  follow = false;
  $('nav').hidden = false;
  $('ext').hidden = false;
  $('clearRoute').hidden = false;

  const dest = r.points[r.points.length - 1];
  const via = r.points.slice(1, -1);
  const g = new URL('https://www.google.com/maps/dir/');
  g.searchParams.set('api', '1');
  g.searchParams.set('destination', `${dest.lat},${dest.lon}`);
  g.searchParams.set('travelmode', 'bicycling');
  if (via.length) g.searchParams.set('waypoints', via.map(p => `${p.lat},${p.lon}`).join('|'));
  $('gmaps').href = g.toString();
  $('amaps').href = `https://maps.apple.com/directions?destination=${dest.lat},${dest.lon}&mode=cycling`;
  updateNav();
}
function clearRoute() {
  if (activeLine) activeLine.remove();
  active = activeLine = null;
  $('nav').hidden = $('ext').hidden = $('clearRoute').hidden = true;
  $('search').value = '';
}
$('clearRoute').addEventListener('click', () => { clearRoute(); follow = true; });

function onNavFix(fix) {
  if (!active) return;
  // advance past any maneuver we have reached (look a few steps ahead in case one was skipped)
  for (let i = stepIdx; i < Math.min(stepIdx + 4, active.steps.length); i++) {
    if (haversine(fix, active.steps[i]) < 25 && active.steps[i].type !== 'arrive') { stepIdx = i + 1; }
  }
  updateNav();
}
function updateNav() {
  if (!active) return;
  const s = active.steps[stepIdx] || active.steps[active.steps.length - 1];
  if (!s) return;
  const [txt, deg] = describe(s);
  $('navArrow').style.transform = `rotate(${deg}deg)`;
  $('navStreet').textContent = txt;
  $('navDist').textContent = lastFix ? fmtDist(haversine(lastFix, s)) : '';
  $('navLeft').textContent = fmtDist(active.distance);
}

/* ---------- destination search ---------- */
let searchTimer = null, searchAbort = null;
$('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 3) { $('results').innerHTML = ''; return; }
  searchTimer = setTimeout(() => search(q), 450);
});
$('search').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); search(e.target.value.trim()); } });
async function search(q) {
  if (!q) return;
  searchAbort?.abort(); searchAbort = new AbortController();
  const u = new URL(GEOCODER + 'search');
  u.searchParams.set('format', 'json'); u.searchParams.set('q', q); u.searchParams.set('limit', '5');
  u.searchParams.set('accept-language', 'fi');
  if (lastFix) {
    const d = 0.4;
    u.searchParams.set('viewbox', `${lastFix.lon - d},${lastFix.lat + d},${lastFix.lon + d},${lastFix.lat - d}`);
  }
  try {
    const res = await (await fetch(u, { signal: searchAbort.signal })).json();
    const box = $('results');
    box.innerHTML = '';
    res.forEach(r => {
      const b = document.createElement('button');
      const [first, ...rest] = r.display_name.split(', ');
      b.innerHTML = `${esc(first)}<small>${esc(rest.slice(0, 3).join(', '))}</small>`;
      b.addEventListener('click', () => pickDestination({ lat: +r.lat, lon: +r.lon }, first));
      box.appendChild(b);
    });
    if (!res.length) toast('Ei tuloksia');
  } catch (err) { if (err.name !== 'AbortError') toast('Haku epäonnistui'); }
}
async function pickDestination(dest, name) {
  $('results').innerHTML = '';
  $('search').value = name;
  $('search').blur();
  if (!lastFix) return toast('Odotetaan GPS-sijaintia…');
  try { setActiveRoute(await route([lastFix, dest])); $('search').value = name; }
  catch { toast('Reittiä ei löytynyt'); }
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* =====================================================================
   Home: generated routes
   ===================================================================== */
const TARGETS = [8, 15, 30];
const DIRS = ['Pohjoinen', 'Koillinen', 'Itäinen', 'Kaakkoinen', 'Eteläinen', 'Lounainen', 'Läntinen', 'Luoteinen'];
let routesGenerated = false, generating = false, homeRoutes = [], homeLines = [], selected = 0;

// Simple loop: waypoints on a circle that passes through the start point.
async function loopRoute(start, km, bearing) {
  let radius = (km * 1000) / (2 * Math.PI * 1.25);
  let best = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = offset(start, radius, bearing);
    const back = (bearing + 180) % 360;
    const pts = [90, 180, 270].map(a => offset(c, radius, back + a));
    const r = await route([start, ...pts, start]);
    if (!best || Math.abs(r.distance - km * 1000) < Math.abs(best.distance - km * 1000)) best = r;
    const ratio = r.distance / (km * 1000);
    if (ratio > 0.8 && ratio < 1.25) break;
    radius /= ratio;
  }
  return best;
}

async function claudeIdeas(start, apiKey) {
  let area = '';
  try {
    const rev = await (await fetch(`${GEOCODER}reverse?format=json&zoom=14&accept-language=fi&lat=${start.lat}&lon=${start.lon}`)).json();
    area = rev.display_name || '';
  } catch {}

  const { default: Anthropic } = await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const schema = {
    type: 'object', additionalProperties: false, required: ['routes'],
    properties: { routes: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'description', 'target_km', 'waypoints'],
      properties: {
        name: { type: 'string' }, description: { type: 'string' }, target_km: { type: 'number' },
        waypoints: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['name', 'lat', 'lon'],
          properties: { name: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } }
        } }
      }
    } } }
  };
  const res = await client.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content:
`Olen pyöräilijä sijainnissa ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}${area ? ` (${area})` : ''}.
Suunnittele kolme pyörälenkkiä, jotka alkavat ja päättyvät tähän pisteeseen: noin ${TARGETS.join(', ')} km.
Valitse jokaiselle 2–4 välipistettä todellisista paikoista, jotka ovat mukavia pyöräillä (puistot, rannat, pyörätiet, näköalapaikat) ja joita pitkin lenkki kulkee järkevässä järjestyksessä ympyränä.
Anna välipisteille tarkat koordinaatit. Nimi lyhyt (max 3 sanaa), kuvaus yksi lyhyt lause suomeksi.` }]
  });
  if (res.stop_reason === 'refusal') throw new Error('refusal');
  const text = res.content.find(b => b.type === 'text')?.text;
  return JSON.parse(text).routes;
}

async function generateRoutes() {
  if (generating || !lastFix) return;
  generating = true; routesGenerated = true;
  const start = { lat: lastFix.lat, lon: lastFix.lon };
  $('regen').classList.add('spin');
  const apiKey = store.get('apikey', '');
  $('homeStatus').textContent = apiKey ? 'AI suunnittelee reittejä…' : 'Luodaan reittejä…';
  $('cards').innerHTML = '';
  homeLines.forEach(l => l.remove()); homeLines = []; homeRoutes = [];

  let results = [];
  if (apiKey) {
    try {
      const ideas = await claudeIdeas(start, apiKey);
      for (const idea of ideas.slice(0, 3)) {
        const maxAway = Math.max(idea.target_km, 5) * 1000 * 0.6;
        const wps = idea.waypoints.filter(w => haversine(start, w) < maxAway);
        if (!wps.length) continue;
        try {
          const r = await route([start, ...wps, start]);
          results.push({ ...r, name: idea.name, desc: idea.description, ai: true });
        } catch {}
      }
    } catch (e) {
      console.warn(e);
      toast('AI-reitit epäonnistuivat, käytetään automaattisia');
    }
  }
  if (!results.length) {
    const base = Math.floor(Math.random() * 360);
    for (let i = 0; i < TARGETS.length; i++) {
      const bearing = (base + i * 120) % 360;
      try {
        const r = await loopRoute(start, TARGETS[i], bearing);
        results.push({ ...r, name: `${DIRS[Math.round(bearing / 45) % 8]} lenkki`, desc: 'Lenkki lähialueen pyöräteitä pitkin, takaisin lähtöpisteeseen.', ai: false });
      } catch {}
    }
  }

  homeRoutes = results;
  generating = false;
  $('regen').classList.remove('spin');
  $('homeStatus').textContent = results.length ? 'Reitit lähelläsi' : 'Reittejä ei löytynyt';
  renderCards();
  selectRoute(0);
}

function renderCards() {
  const box = $('cards');
  box.innerHTML = '';
  homeLines.forEach(l => l.remove());
  homeLines = homeRoutes.map((r, i) =>
    L.polyline(r.line, { color: '#3a3a3c', weight: 4, opacity: .9 }).addTo(homeMap).on('click', () => selectRoute(i, true)));
  homeRoutes.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="t"><span class="name">${esc(r.name)}</span>${r.ai ? '<span class="ai">AI</span>' : ''}</div>
      <div class="meta">${(r.distance / 1000).toFixed(1)} km · ~${Math.round(r.duration / 60)} min</div>
      <div class="desc">${esc(r.desc)}</div>
      <button class="go">Aja tämä</button>`;
    el.addEventListener('click', e => { if (!e.target.closest('.go')) selectRoute(i, true); });
    el.querySelector('.go').addEventListener('click', () => { showTab('record'); setActiveRoute(r); $('search').value = r.name; });
    box.appendChild(el);
  });
}
function selectRoute(i, scrollCard) {
  if (!homeRoutes[i]) return;
  selected = i;
  homeLines.forEach((l, j) => {
    l.setStyle(j === i ? { color: '#0a84ff', weight: 5 } : { color: '#3a3a3c', weight: 4 });
    if (j === i) l.bringToFront();
  });
  [...$('cards').children].forEach((c, j) => c.classList.toggle('sel', j === i));
  const cardsH = $('cards').offsetHeight + 24;
  homeMap.fitBounds(homeLines[i].getBounds(), { paddingTopLeft: [30, 80], paddingBottomRight: [30, cardsH] });
  if (scrollCard) $('cards').children[i].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}
// highlight whichever card is centred after swiping
let scrollT;
$('cards').addEventListener('scroll', () => {
  clearTimeout(scrollT);
  scrollT = setTimeout(() => {
    const box = $('cards'), mid = box.scrollLeft + box.clientWidth / 2;
    let best = 0, bd = Infinity;
    [...box.children].forEach((c, i) => { const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = i; } });
    if (best !== selected) selectRoute(best, false);
  }, 120);
});
$('regen').addEventListener('click', () => { if (!lastFix) return toast('Odotetaan GPS-sijaintia…'); routesGenerated = false; generateRoutes(); });

/* =====================================================================
   Profile + settings
   ===================================================================== */
const DEFAULT_MSG = 'SOS! Tarvitsen apua pyörälenkillä.';
let includeLoc = store.get('loc', true);

function renderProfile() {
  const rides = store.get('rides', []);
  const km = rides.reduce((a, r) => a + r.m, 0) / 1000;
  const ms = rides.reduce((a, r) => a + r.ms, 0);
  $('tRides').textContent = rides.length;
  $('tKm').textContent = km < 100 ? km.toFixed(1) : Math.round(km);
  $('tTime').textContent = ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`;
  $('history').innerHTML = rides.length
    ? rides.slice(0, 10).map(r => {
        const d = new Date(r.at);
        return `<div class="item"><span>${d.getDate()}.${d.getMonth() + 1}. · ${(r.m / 1000).toFixed(1)} km</span><span>${fmtTime(r.ms)} · ${Math.round(r.avg)} km/h</span></div>`;
      }).join('')
    : '<div class="empty">Ei vielä lenkkejä.</div>';

  $('numbers').value = store.get('numbers', []).join('\n');
  $('message').value = store.get('message', DEFAULT_MSG);
  $('apikey').value = store.get('apikey', '');
  includeLoc = store.get('loc', true);
  $('loc').classList.toggle('on', includeLoc);
}
$('loc').addEventListener('click', () => { includeLoc = !includeLoc; $('loc').classList.toggle('on', includeLoc); });
$('saveSettings').addEventListener('click', () => {
  const nums = $('numbers').value.split(/[\n,;]+/).map(s => s.replace(/[^\d+]/g, '')).filter(Boolean);
  const keyChanged = $('apikey').value.trim() !== store.get('apikey', '');
  store.set('numbers', nums);
  store.set('message', $('message').value.trim() || DEFAULT_MSG);
  store.set('loc', includeLoc);
  store.set('apikey', $('apikey').value.trim());
  if (keyChanged) routesGenerated = false;
  $('saved').classList.add('show');
  setTimeout(() => $('saved').classList.remove('show'), 1500);
});

/* =====================================================================
   SOS (hold 5 s)
   ===================================================================== */
const HOLD_MS = 5000;
let holdTimer = null, countTimer = null;
function startHold(e) {
  e.preventDefault();
  if (holdTimer) return;
  $('sos').classList.add('holding');
  document.body.classList.add('sos-holding');
  $('hint').classList.add('show');
  let left = 5;
  $('sosLabel').textContent = left;
  navigator.vibrate?.(30);
  countTimer = setInterval(() => { if (--left > 0) { $('sosLabel').textContent = left; navigator.vibrate?.(30); } }, 1000);
  holdTimer = setTimeout(fireSOS, HOLD_MS);
}
function endHold() {
  clearTimeout(holdTimer); clearInterval(countTimer);
  holdTimer = countTimer = null;
  $('sos').classList.remove('holding');
  document.body.classList.remove('sos-holding');
  $('hint').classList.remove('show');
  $('sosLabel').textContent = 'SOS';
}
function fireSOS() {
  endHold();
  navigator.vibrate?.([200, 100, 200]);
  const nums = store.get('numbers', []);
  if (!nums.length) { showTab('profile'); $('numbers').focus(); toast('Lisää ensin SOS-numerot'); return; }
  let body = store.get('message', DEFAULT_MSG);
  if (store.get('loc', true) && lastFix) body += `\nSijainti: https://maps.google.com/?q=${lastFix.lat.toFixed(6)},${lastFix.lon.toFixed(6)}`;
  const enc = encodeURIComponent(body);
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  location.href = iOS ? `sms:/open?addresses=${nums.join(',')}&body=${enc}` : `sms:${nums.join(',')}?body=${enc}`;
}
const sos = $('sos');
sos.addEventListener('pointerdown', startHold);
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => sos.addEventListener(ev, endHold));
sos.addEventListener('contextmenu', e => e.preventDefault());

/* ===================================================================== */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
showTab('home');
renderRide();
if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
} else onErr({});
