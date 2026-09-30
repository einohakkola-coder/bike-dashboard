import * as cloud from './cloud.js';

const VERSION = '2.7';   // bump here and in version.json on every release
const $ = id => document.getElementById(id);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const ROUTER = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/';
const GEOCODER = 'https://nominatim.openstreetmap.org/';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* =====================================================================
   Settings
   ===================================================================== */
const DEFAULT_MSG = 'SOS! Tarvitsen apua pyörälenkillä.';
const DEFAULTS = {
  name: '', units: 'km', autoPause: false, keepAwake: true, haptics: true,
  mapStyle: 'liberty', routeLen: 'normal',
  sosNumbers: [], sosMessage: DEFAULT_MSG, sosLocation: true, sosHold: 5, sosAction: 'sms',
  aiProvider: 'claude', keyClaude: '', keyOpenai: ''
};
const S = (() => {
  const saved = store.get('settings', null);
  if (saved) return { ...DEFAULTS, ...saved };
  // carry over settings from 1.x
  return { ...DEFAULTS,
    sosNumbers: store.get('numbers', []), sosMessage: store.get('message', DEFAULT_MSG), sosLocation: store.get('loc', true),
    aiProvider: store.get('aiprovider', 'claude'), keyClaude: store.get('key_claude', store.get('apikey', '')), keyOpenai: store.get('key_openai', '') };
})();
function setSetting(k, v) {
  S[k] = v;
  store.set('settings', S);
  if (!k.startsWith('key')) touch();
  onSettingChanged(k);
}
const buzz = p => { if (S.haptics) navigator.vibrate?.(p); };

/* ---------- units ---------- */
const isMi = () => S.units === 'mi';
const toSpeed = kmh => isMi() ? kmh / 1.609344 : kmh;
const toDist = m => isMi() ? m / 1609.344 : m / 1000;
const dUnit = () => isMi() ? 'mi' : 'km';
const sUnit = () => isMi() ? 'mph' : 'km/h';
function fmtShort(m) {   // for turn-by-turn
  if (isMi()) return m < 160 ? `${Math.round(m * 3.28084 / 10) * 10} ft` : `${(m / 1609.344).toFixed(1)} mi`;
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
function fmtTime(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}` : `${m}:${String(ss).padStart(2,'0')}`;
}
const fmtDate = t => { const d = new Date(t); return `${d.getDate()}.${d.getMonth() + 1}.`; };

/* =====================================================================
   Data (saved routes + ride history), synced to the cloud when signed in
   ===================================================================== */
const D = {
  routes: store.get('routes', []),
  rides: store.get('rides', []).map(r => ({ id: r.id || String(r.at), ...r })),
  updatedAt: store.get('updatedAt', 0)
};
function touch() { D.updatedAt = Date.now(); store.set('updatedAt', D.updatedAt); schedulePush(); }
function persist() { store.set('routes', D.routes); store.set('rides', D.rides); touch(); }

/* =====================================================================
   Small helpers: toast, geo maths
   ===================================================================== */
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}
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
// thin a [[lat,lon]] line so saved routes stay small
function simplify(line, minM = 12) {
  if (line.length < 3) return line;
  const out = [line[0]];
  for (let i = 1; i < line.length - 1; i++) {
    const a = out[out.length - 1], b = line[i];
    if (haversine({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) >= minM) out.push(b);
  }
  out.push(line[line.length - 1]);
  return out.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]);
}
const samplePoints = (line, n = 5) => Array.from({ length: n }, (_, i) => line[Math.round(i * (line.length - 1) / (n - 1))]).map(([lat, lon]) => ({ lat, lon }));

/* =====================================================================
   Maps
   ===================================================================== */
const STYLES = { liberty: 'liberty', positron: 'positron', dark: 'dark' };
const styleUrl = () => `https://tiles.openfreemap.org/styles/${STYLES[S.mapStyle] || 'liberty'}`;
const ATTR = '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OSM</a>';
function makeMap(el) {
  const m = L.map(el, { zoomControl: false, attributionControl: true }).setView([60.17, 24.94], 13);
  m._gl = L.maplibreGL({ style: styleUrl(), attribution: ATTR }).addTo(m);
  m.attributionControl.setPrefix(false);
  return m;
}
function applyMapStyle() {
  [homeMap, rideMap].forEach(m => { try { m._gl.getMaplibreMap().setStyle(styleUrl()); } catch {} });
  document.querySelectorAll('.map').forEach(el => el.style.background = S.mapStyle === 'dark' ? '#1b1b1d' : '');
}
const homeMap = makeMap('homeMap');
const rideMap = makeMap('rideMap');
const meIcon = () => L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const homeMe = L.marker([0, 0], { icon: meIcon(), interactive: false, keyboard: false });
const rideMe = L.marker([0, 0], { icon: meIcon(), interactive: false, keyboard: false });

let follow = true;
rideMap.on('dragstart', () => { follow = false; });
$('recenter').addEventListener('click', () => {
  follow = true;
  if (lastFix) rideMap.setView([lastFix.lat, lastFix.lon], Math.max(rideMap.getZoom(), 16), { animate: true });
});

/* =====================================================================
   Tabs, pushed pages, sheets
   ===================================================================== */
const TABS = ['home', 'record', 'profile'];
let tab = null;
function showTab(name) {
  if (tab === name) return;
  while (pageStack.length) closePage();
  const from = TABS.indexOf(tab), to = TABS.indexOf(name);
  const enter = $('view-' + name);
  enter.style.transition = 'none';
  enter.style.setProperty('--from', from < 0 ? '0px' : to > from ? '28px' : '-28px');
  void enter.offsetWidth;
  enter.style.transition = '';
  TABS.forEach((t, i) => {
    const v = $('view-' + t);
    if (t !== name) v.style.setProperty('--from', i < to ? '-28px' : '28px');
    v.classList.toggle('active', t === name);
    document.querySelector(`.tabbar [data-tab=${t}]`).classList.toggle('active', t === name);
  });
  $('indicator').style.transform = `translateX(${to * 100}%)`;
  tab = name;
  if (name === 'home') { homeMap.invalidateSize(); if (listMode === 'suggested' && !routesGenerated && lastFix) generateRoutes(); }
  if (name === 'record') rideMap.invalidateSize();
  if (name === 'profile') renderProfile();
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => { buzz(8); showTab(b.dataset.tab); }));

const pageStack = [];
function openPage(id) {
  const under = pageStack.length ? $(pageStack.at(-1)) : $('view-profile');
  under.classList.add('covered');
  pageStack.push(id);
  $(id).classList.add('open');
}
function closePage() {
  const id = pageStack.pop();
  if (!id) return;
  $(id).classList.remove('open');
  (pageStack.length ? $(pageStack.at(-1)) : $('view-profile')).classList.remove('covered');
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closePage));
// the large page title scrolls away and a small one appears in the bar, like iOS
document.querySelectorAll('.page').forEach(p => p.addEventListener('scroll', () => p.classList.toggle('scrolled', p.scrollTop > 44), { passive: true }));

function openSheet(id) { $('backdrop').classList.add('show'); $(id).classList.add('open'); }
function closeSheet(id) {
  $(id).classList.remove('open');
  if (!document.querySelector('.sheet.open')) $('backdrop').classList.remove('show');
}
function askName(def) {
  return new Promise(resolve => {
    const input = $('routeName');
    input.value = def;
    openSheet('nameSheet');
    setTimeout(() => { input.focus(); input.select(); }, 380);
    const done = v => {
      input.blur();
      closeSheet('nameSheet');
      $('nameOk').onclick = $('nameCancel').onclick = $('backdrop').onclick = input.onkeydown = null;
      resolve(v);
    };
    $('nameOk').onclick = () => done(input.value.trim() || def);
    input.onkeydown = e => { if (e.key === 'Enter') done(input.value.trim() || def); };
    $('nameCancel').onclick = $('backdrop').onclick = () => done(null);
  });
}

/* =====================================================================
   GPS
   ===================================================================== */
let lastFix = null, lastFixAt = 0, speedKmh = 0, gotFirstFix = false;
let peakWin = [];
let recent = [];   // fixes from the last few seconds, for computing speed when the device doesn't report it

function onPos(p) {
  const c = p.coords;
  const fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: Date.now() };

  // Prefer the speed the phone reports (Doppler-based). Some devices give null or -1;
  // then derive it from the distance covered over the last ~5 s.
  let v = (typeof c.speed === 'number' && c.speed >= 0 && !isNaN(c.speed)) ? c.speed : null;
  if (c.accuracy <= 50) { recent.push(fix); recent = recent.filter(f => fix.t - f.t <= 5000); }
  if (v === null && recent.length >= 2) {
    const a = recent[0], dt = (fix.t - a.t) / 1000;
    if (dt >= 1.5) v = haversine(a, fix) / dt;
  }
  if (v !== null) {
    const k = v * 3.6;
    speedKmh = k < 1.5 ? 0 : (speedKmh ? speedKmh * 0.35 + k * 0.65 : k);
    // peak speed only counts when 3 good fixes in a row agree, so a single GPS jump can't set it
    if (c.accuracy <= 20) { peakWin.push(k); if (peakWin.length > 3) peakWin.shift(); } else peakWin = [];
  }
  lastFix = fix; lastFixAt = Date.now();

  const g = $('gps');
  g.textContent = `±${Math.round(isMi() ? c.accuracy * 3.28084 : c.accuracy)} ${isMi() ? 'ft' : 'm'}`;
  g.className = 'gps ' + (c.accuracy <= 15 ? 'good' : c.accuracy <= 40 ? 'ok' : 'bad');

  const ll = [fix.lat, fix.lon];
  homeMe.setLatLng(ll); rideMe.setLatLng(ll);
  if (!gotFirstFix) {
    gotFirstFix = true;
    homeMe.addTo(homeMap); rideMe.addTo(rideMap);
    homeMap.setView(ll, 13);
    rideMap.setView(ll, 16);
    if (tab === 'home' && listMode === 'suggested' && !routesGenerated) generateRoutes();
  } else if (follow && tab === 'record') {
    rideMap.panTo(ll, { animate: true });
  }
  onRideFix(fix);
  onNavFix(fix);
}
function onErr(e) {
  const msg = e.code === 1 ? 'Ei sijaintilupaa' : 'Ei GPS';
  $('gps').textContent = msg;
  $('gps').className = 'gps bad';
  if (!gotFirstFix) $('homeStatus').textContent = msg;
}

let wakeLock = null;
async function keepAwake() {
  if (!S.keepAwake) return;
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && rideActive) keepAwake(); });

/* =====================================================================
   Ride recording
   ===================================================================== */
let rideActive = false, paused = false, autoPaused = false, stillSince = 0;
let elapsed = 0, lastTick = Date.now(), distance = 0, maxSpeed = 0, lastRidePos = null;
let track = null, trackPts = [];

function startRide() {
  rideActive = true;
  elapsed = 0; distance = 0; maxSpeed = 0; lastRidePos = null; lastTick = Date.now(); trackPts = [];
  if (track) track.remove();
  track = L.polyline([], { color: '#ff3b30', weight: 4, opacity: .85 }).addTo(rideMap);
  document.body.classList.add('riding');
  setPaused(false);
  keepAwake();
}
function onRideFix(fix) {
  if (!rideActive || paused || fix.acc > 30) return;
  if (lastRidePos) {
    const d = haversine(lastRidePos, fix);
    if (d <= 2 || d >= 200) return;
    distance += d;
  }
  trackPts.push([fix.lat, fix.lon]);
  track.addLatLng([fix.lat, fix.lon]);
  if (peakWin.length === 3) maxSpeed = Math.max(maxSpeed, Math.min(...peakWin));
  lastRidePos = fix;
}
function renderRide() {
  const avg = elapsed > 0 ? (distance / 1000) / (elapsed / 3600000) : 0;
  $('speed').textContent = Math.round(toSpeed(speedKmh));
  $('speedUnit').textContent = sUnit().toUpperCase();
  $('time').textContent = fmtTime(elapsed);
  $('dist').textContent = toDist(distance).toFixed(2);
  $('distUnit').textContent = dUnit();
  $('avg').textContent = Math.round(toSpeed(avg));
  $('avgUnit').textContent = `Keski ${sUnit()}`;
}
setInterval(() => {
  const now = Date.now();
  if (rideActive && !paused) elapsed += now - lastTick;
  lastTick = now;
  if (now - lastFixAt > 5000) speedKmh = 0;

  if (rideActive && S.autoPause) {
    if (!paused && speedKmh === 0) {
      stillSince ||= now;
      if (now - stillSince > 8000) { setPaused(true); autoPaused = true; toast('Automaattinen tauko'); buzz(30); }
    } else if (speedKmh > 0) stillSince = 0;
    if (paused && autoPaused && speedKmh > 4) { setPaused(false); toast('Jatketaan'); buzz(30); }
  }
  renderRide();
}, 250);

function setPaused(v) {
  paused = v; autoPaused = false; stillSince = 0;
  document.body.classList.toggle('paused', v);
  $('pause').setAttribute('aria-label', v ? 'Jatka' : 'Tauko');
  lastRidePos = null;
}
$('pause').addEventListener('click', () => { if (!rideActive) return; setPaused(!paused); buzz(20); });
$('main').addEventListener('click', () => {
  if (!rideActive) { startRide(); buzz(40); return; }
  if (!paused) return;
  buzz(40);
  const avg = elapsed > 0 ? (distance / 1000) / (elapsed / 3600000) : 0;
  $('sTime').textContent = fmtTime(elapsed);
  $('sDist').textContent = toDist(distance).toFixed(2);
  $('sDistUnit').textContent = dUnit();
  $('sAvg').textContent = `${Math.round(toSpeed(avg))}`;
  $('sMax').textContent = `${Math.round(toSpeed(maxSpeed))}`;
  lastRide = null;
  if (elapsed > 10000) {
    lastRide = { id: uid(), at: Date.now(), ms: elapsed, m: Math.round(distance), avg: +avg.toFixed(1), max: +maxSpeed.toFixed(1), line: simplify(trackPts).slice(-800) };
    D.rides.unshift(lastRide);
    D.rides = D.rides.slice(0, 300);
    persist();
  }
  const sr = $('saveRide');
  sr.hidden = !(lastRide && lastRide.line.length >= 2);
  sr.classList.remove('saved'); sr.disabled = false;
  sr.lastChild.textContent = 'Tallenna reitiksi';
  openSheet('summary');
});
let lastRide = null;
$('saveRide').addEventListener('click', async () => {
  if (!lastRide) return;
  const name = await askName(`Lenkki ${fmtDate(lastRide.at)}`);
  if (!name) return;
  saveRoute({ name, kind: 'ride', desc: 'Oma ajettu lenkki', line: lastRide.line, distance: lastRide.m, duration: lastRide.ms / 1000, points: samplePoints(lastRide.line), steps: [] });
  const sr = $('saveRide');
  sr.classList.add('saved'); sr.disabled = true; sr.lastChild.textContent = 'Tallennettu';
});
$('newRide').addEventListener('click', () => {
  rideActive = false;
  setPaused(false);
  elapsed = 0; distance = 0; maxSpeed = 0;
  if (track) { track.remove(); track = null; }
  document.body.classList.remove('riding');
  wakeLock?.release?.();
  closeSheet('summary');
  renderRide();
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
      lat: +s.maneuver.location[1].toFixed(6), lon: +s.maneuver.location[0].toFixed(6)
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
  activeLine = L.polyline(r.line, { color: '#0a84ff', weight: 6, opacity: .95 }).addTo(rideMap);
  rideMap.invalidateSize();
  rideMap.fitBounds(activeLine.getBounds(), { paddingTopLeft: [30, 140], paddingBottomRight: [30, 60], animate: true });
  follow = false;
  $('nav').classList.toggle('show', !!r.steps?.length);
  $('ext').classList.add('show');
  $('clearRoute').hidden = false;
  $('saveActive').hidden = false;
  refreshSaveActive();
  $('search').value = r.name || '';

  const pts = r.points?.length ? r.points : samplePoints(r.line);
  const dest = pts[pts.length - 1];
  const via = pts.slice(1, -1).slice(0, 8);
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
  $('nav').classList.remove('show');
  $('ext').classList.remove('show');
  $('clearRoute').hidden = $('saveActive').hidden = true;
  $('search').value = '';
}
$('clearRoute').addEventListener('click', () => { clearRoute(); follow = true; });
function refreshSaveActive() { $('saveActive').classList.toggle('saved', !!active && isSaved(active)); }
$('saveActive').addEventListener('click', () => toggleSave(active).then(refreshSaveActive));

function onNavFix(fix) {
  if (!active?.steps?.length) return;
  for (let i = stepIdx; i < Math.min(stepIdx + 4, active.steps.length); i++) {
    if (haversine(fix, active.steps[i]) < 25 && active.steps[i].type !== 'arrive') stepIdx = i + 1;
  }
  updateNav();
}
function updateNav() {
  if (!active?.steps?.length) return;
  const s = active.steps[stepIdx] || active.steps[active.steps.length - 1];
  const [txt, deg] = describe(s);
  $('navArrow').style.transform = `rotate(${deg}deg)`;
  $('navStreet').textContent = txt;
  $('navDist').textContent = lastFix ? fmtShort(haversine(lastFix, s)) : '';
  $('navLeft').textContent = fmtShort(active.distance);
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
  $('search').blur();
  if (!lastFix) return toast('Odotetaan GPS-sijaintia…');
  try {
    const r = await route([lastFix, dest]);
    setActiveRoute({ ...r, name, kind: 'dest', desc: 'Reitti kohteeseen', key: `dest:${dest.lat.toFixed(4)},${dest.lon.toFixed(4)}` });
  } catch { toast('Reittiä ei löytynyt'); }
}

/* =====================================================================
   Saved routes
   ===================================================================== */
const isSaved = r => !!r && (D.routes.some(s => s.id === r.id) || (!!r.key && D.routes.some(s => s.key === r.key)));
function saveRoute(r) {
  const saved = {
    id: uid(), key: r.key || null, name: r.name, kind: r.kind || 'loop', desc: r.desc || '',
    distance: Math.round(r.distance), duration: Math.round(r.duration || 0), created: Date.now(),
    line: simplify(r.line), points: (r.points || []).map(p => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })), steps: r.steps || []
  };
  D.routes.unshift(saved);
  persist();
  toast('Tallennettu omiin reitteihin');
  if (listMode === 'saved') renderCards();
  return saved;
}
function deleteRoute(r) {
  D.routes = D.routes.filter(s => s.id !== r.id && !(r.key && s.key === r.key));
  persist();
}
async function toggleSave(r) {
  if (!r) return;
  if (isSaved(r)) { deleteRoute(r); toast('Poistettu omista reiteistä'); return; }
  const name = await askName(r.name || 'Oma reitti');
  if (name) saveRoute({ ...r, name });
}

/* =====================================================================
   Home: suggestions + my routes
   ===================================================================== */
const LENGTHS = { short: [5, 10, 20], normal: [8, 15, 30], long: [20, 40, 60] };
const targets = () => LENGTHS[S.routeLen] || LENGTHS.normal;
const DIRS = ['Pohjoinen', 'Koillinen', 'Itäinen', 'Kaakkoinen', 'Eteläinen', 'Lounainen', 'Läntinen', 'Luoteinen'];
let routesGenerated = false, generating = false, suggested = [], homeLines = [], selected = 0, listMode = 'suggested';
const currentList = () => listMode === 'saved' ? D.routes : suggested;

async function loopRoute(start, km, bearing) {
  let radius = (km * 1000) / (2 * Math.PI * 1.25), best = null;
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

const OPENAI_MODEL = 'gpt-5';
const ROUTE_SCHEMA = {
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
async function aiIdeas(start, provider, apiKey) {
  let area = '';
  try {
    const rev = await (await fetch(`${GEOCODER}reverse?format=json&zoom=14&accept-language=fi&lat=${start.lat}&lon=${start.lon}`)).json();
    area = rev.display_name || '';
  } catch {}
  const prompt =
`Olen pyöräilijä sijainnissa ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}${area ? ` (${area})` : ''}.
Suunnittele kolme pyörälenkkiä, jotka alkavat ja päättyvät tähän pisteeseen: noin ${targets().join(', ')} km.
Valitse jokaiselle 2–4 välipistettä todellisista paikoista, jotka ovat mukavia pyöräillä (puistot, rannat, pyörätiet, näköalapaikat) ja joita pitkin lenkki kulkee järkevässä järjestyksessä ympyränä.
Anna välipisteille tarkat koordinaatit. Nimi lyhyt (max 3 sanaa), kuvaus yksi lyhyt lause suomeksi.`;

  if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'routes', strict: true, schema: ROUTE_SCHEMA } }
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `OpenAI ${r.status}`);
    return JSON.parse(j.choices[0].message.content).routes;
  }

  const { default: Anthropic } = await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const res = await client.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ROUTE_SCHEMA } },
    messages: [{ role: 'user', content: prompt }]
  });
  if (res.stop_reason === 'refusal') throw new Error('refusal');
  return JSON.parse(res.content.find(b => b.type === 'text')?.text).routes;
}

async function generateRoutes() {
  if (generating || !lastFix) return;
  generating = true; routesGenerated = true;
  const start = { lat: lastFix.lat, lon: lastFix.lon };
  const provider = S.aiProvider;
  const apiKey = provider === 'openai' ? S.keyOpenai : S.keyClaude;
  $('regen').classList.add('spin');
  $('homeStatus').textContent = apiKey ? 'AI suunnittelee reittejä…' : 'Luodaan reittejä…';
  suggested = [];
  if (listMode === 'suggested') renderCards();

  const results = [];
  if (apiKey) {
    try {
      const ideas = await aiIdeas(start, provider, apiKey);
      for (const idea of ideas.slice(0, 3)) {
        const maxAway = Math.max(idea.target_km, 5) * 1000 * 0.6;
        const wps = idea.waypoints.filter(w => haversine(start, w) < maxAway);
        if (!wps.length) continue;
        try {
          const r = await route([start, ...wps, start]);
          results.push({ ...r, name: idea.name, desc: idea.description, ai: true, kind: 'loop', key: `ai:${idea.name}:${Math.round(r.distance / 100)}` });
        } catch {}
      }
    } catch (e) {
      console.warn(e);
      toast(`AI-reitit epäonnistuivat (${e.message}), käytetään automaattisia`, 4500);
    }
  }
  if (!results.length) {
    const base = Math.floor(Math.random() * 360);
    const T = targets();
    for (let i = 0; i < T.length; i++) {
      // a direction that runs into water or a dead end gives a stub; try the neighbouring directions then
      for (const turn of [0, 60, -60]) {
        const bearing = (base + i * 120 + turn + 360) % 360;
        try {
          const r = await loopRoute(start, T[i], bearing);
          if (r.distance < T[i] * 1000 * 0.6) continue;
          results.push({ ...r, name: `${DIRS[Math.round(bearing / 45) % 8]} lenkki`, desc: 'Lähialueen pyöräteitä pitkin takaisin lähtöpisteeseen.', ai: false, kind: 'loop',
            key: `loop:${start.lat.toFixed(3)},${start.lon.toFixed(3)}:${Math.round(bearing)}:${T[i]}` });
          break;
        } catch {}
      }
    }
  }
  suggested = results;
  generating = false;
  $('regen').classList.remove('spin');
  updateGreeting();
  if (listMode === 'suggested') { renderCards(); selectRoute(0); }
}

function renderCards() {
  const box = $('cards');
  const list = currentList();
  box.innerHTML = '';
  homeLines.forEach(l => l.remove());
  homeLines = list.map((r, i) =>
    L.polyline(r.line, { color: '#8e8e93', weight: 4, opacity: .85 }).addTo(homeMap).on('click', () => selectRoute(i, true)));

  if (!list.length) {
    const empty = listMode === 'saved'
      ? ['Ei vielä omia reittejä', 'Tallenna reitti kirjanmerkki-napista tai lenkin jälkeen, niin se löytyy täältä.']
      : generating ? ['Luodaan reittejä…', 'Haetaan lähialueen pyöräteitä.'] : ['Ei ehdotuksia', lastFix ? 'Kokeile luoda uudet reitit ✨-napista.' : 'Odotetaan GPS-sijaintia…'];
    box.innerHTML = `<div class="glass empty-card"><svg><use href="#i-route"/></svg><b>${empty[0]}</b><p>${empty[1]}</p></div>`;
    return;
  }
  list.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'glass card';
    el.style.setProperty('--i', i);
    const saved = listMode === 'saved';
    const meta = `${toDist(r.distance).toFixed(1)} ${dUnit()}${r.duration ? ` · ~${Math.round(r.duration / 60)} min` : ''}${saved ? ` · ${fmtDate(r.created)}` : ''}`;
    el.innerHTML = `
      <div class="t"><span class="name">${esc(r.name)}</span>${r.ai ? '<span class="badge">AI</span>' : ''}</div>
      <div class="meta">${meta}</div>
      <div class="desc">${esc(r.desc || '')}</div>
      <div class="actions"><button class="go">Aja tämä</button></div>
      <button class="corner ${saved ? '' : isSaved(r) ? 'saved' : ''}" aria-label="${saved ? 'Poista' : 'Tallenna'}">
        <svg><use href="#${saved ? 'i-trash' : 'i-bookmark'}"/></svg></button>`;
    el.addEventListener('click', e => { if (!e.target.closest('button')) selectRoute(i, true); });
    el.querySelector('.go').addEventListener('click', () => { buzz(15); showTab('record'); setTimeout(() => setActiveRoute(r), 120); });
    const corner = el.querySelector('.corner');
    corner.addEventListener('click', async () => {
      if (saved) {
        if (!corner.classList.contains('confirm')) {
          corner.classList.add('confirm'); buzz(10);
          setTimeout(() => corner.classList.remove('confirm'), 2500);
          return;
        }
        deleteRoute(r); toast('Reitti poistettu'); renderCards(); selectRoute(Math.min(i, D.routes.length - 1));
      } else {
        await toggleSave(r);
        corner.classList.toggle('saved', isSaved(r));
      }
    });
    box.appendChild(el);
  });
}
function selectRoute(i, scrollCard) {
  const list = currentList();
  if (!list[i]) return;
  selected = i;
  homeLines.forEach((l, j) => {
    l.setStyle(j === i ? { color: '#0a84ff', weight: 6, opacity: 1 } : { color: '#8e8e93', weight: 4, opacity: .85 });
    if (j === i) l.bringToFront();
  });
  [...$('cards').children].forEach((c, j) => c.classList.toggle('sel', j === i));
  const bottomPad = $('view-home').querySelector('.home-bottom').offsetHeight + 20;
  homeMap.fitBounds(homeLines[i].getBounds(), { paddingTopLeft: [30, 100], paddingBottomRight: [30, bottomPad], animate: true });
  if (scrollCard) $('cards').children[i].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}
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
$('regen').addEventListener('click', () => {
  if (!lastFix) return toast('Odotetaan GPS-sijaintia…');
  setListMode('suggested');
  routesGenerated = false; generateRoutes();
});
function setListMode(mode) {
  if (listMode === mode) return;
  listMode = mode;
  $('homeSeg').classList.toggle('right', mode === 'saved');
  $('homeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.list === mode));
  selected = 0;
  renderCards();
  if (currentList().length) selectRoute(0);
  else if (lastFix) homeMap.setView([lastFix.lat, lastFix.lon], 13, { animate: true });
  if (mode === 'suggested' && !routesGenerated && lastFix) generateRoutes();
}
$('homeSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { buzz(8); setListMode(b.dataset.list); }));

function updateGreeting() {
  const h = new Date().getHours();
  const hi = h < 5 ? 'Hyvää yötä' : h < 10 ? 'Huomenta' : h < 17 ? 'Päivää' : h < 22 ? 'Iltaa' : 'Hyvää yötä';
  $('greetHi').textContent = S.name ? `${hi}, ${S.name.split(' ')[0]}` : hi;
  if (!generating && gotFirstFix) $('homeStatus').textContent = 'Reitit lähelläsi';
}

/* =====================================================================
   Profile
   ===================================================================== */
const WEEKDAYS = ['su', 'ma', 'ti', 'ke', 'to', 'pe', 'la'];
function renderProfile() {
  const who = S.name || user?.email || '';
  $('avatar').textContent = who ? who.trim()[0].toUpperCase() : '?';
  $('profName').textContent = S.name || 'Pyöräilijä';
  $('profAcc').textContent = user ? user.email : 'Ei kirjautunut';
  $('profAcc').classList.toggle('on', !!user);

  const rides = D.rides;
  const km = toDist(rides.reduce((a, r) => a + r.m, 0));
  const ms = rides.reduce((a, r) => a + r.ms, 0);
  $('tRides').textContent = rides.length;
  $('tKm').textContent = km < 100 ? km.toFixed(1) : Math.round(km);
  $('tKmUnit').textContent = dUnit();
  $('tTime').textContent = ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`;

  // last 7 days, today on the right
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const start = day0.getTime() - (6 - i) * 86400000;
    const m = rides.filter(r => r.at >= start && r.at < start + 86400000).reduce((a, r) => a + r.m, 0);
    return { label: WEEKDAYS[new Date(start).getDay()], v: toDist(m), today: i === 6 };
  });
  const max = Math.max(...days.map(d => d.v), 0.1);
  const total = days.reduce((a, d) => a + d.v, 0);
  $('weekVal').textContent = `${total.toFixed(1)} ${dUnit()}`;
  $('week').innerHTML = days.map((d, i) =>
    `<button class="bar${d.today ? ' today' : ''}" data-v="${d.v.toFixed(1)}" data-l="${d.label}" aria-label="${d.label} ${d.v.toFixed(1)} ${dUnit()}">
       <i class="${d.v ? '' : 'zero'}" style="height:${d.v ? Math.max(6, d.v / max * 100) : 3}%;--i:${i}"></i><span>${d.label}</span></button>`).join('');
  $('week').querySelectorAll('.bar').forEach(b => b.addEventListener('click', () => {
    $('weekVal').textContent = `${b.dataset.l} ${b.dataset.v} ${dUnit()}`;
    clearTimeout(renderProfile.t);
    renderProfile.t = setTimeout(() => $('weekVal').textContent = `${total.toFixed(1)} ${dUnit()}`, 2500);
  }));

  $('history').innerHTML = rides.length
    ? rides.slice(0, 8).map(r => `
      <div class="item"><div class="ic"><svg><use href="#i-route"/></svg></div>
        <div class="mid"><b>${toDist(r.m).toFixed(1)} ${dUnit()}</b>
        <small>${fmtDate(r.at)} · ${fmtTime(r.ms)} · ${Math.round(toSpeed(r.avg))} ${sUnit()}</small></div></div>`).join('')
    : '<div class="empty">Ei vielä lenkkejä. Aloita Ajo-välilehdeltä.</div>';
}
$('openSettings').addEventListener('click', () => { renderSettings(); openPage('settings'); });
$('openSettings2').addEventListener('click', () => { renderSettings(); openPage('settings'); });

/* =====================================================================
   Settings page
   ===================================================================== */
function renderSettings() {
  document.querySelectorAll('.seg[data-setting]').forEach(seg =>
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(S[seg.dataset.setting]))));
  document.querySelectorAll('.switch[data-setting]').forEach(sw => sw.classList.toggle('on', !!S[sw.dataset.setting]));
  $('setName').value = S.name;
  renderNumbers();
  $('setMessage').value = S.sosMessage;
  renderKeyField();
  $('version').textContent = VERSION;
  $('accTitle').textContent = user ? user.email : 'Kirjaudu sisään';
  $('accSub').textContent = user ? 'Reitit ja lenkit synkronoidaan' : 'Tallenna reitit ja lenkit pilveen';
}
function renderKeyField() {
  const openai = S.aiProvider === 'openai';
  $('keyLabel').textContent = openai ? 'OpenAI API -avain' : 'Claude API -avain';
  $('setKey').placeholder = openai ? 'sk-… (valinnainen)' : 'sk-ant-… (valinnainen)';
  $('setKey').value = openai ? S.keyOpenai : S.keyClaude;
}
document.querySelectorAll('.seg[data-setting]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  const k = seg.dataset.setting;
  seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  buzz(8);
  setSetting(k, typeof DEFAULTS[k] === 'number' ? Number(b.dataset.v) : b.dataset.v);
})));
document.querySelectorAll('.switch[data-setting]').forEach(sw => sw.addEventListener('click', () => {
  const k = sw.dataset.setting;
  sw.classList.toggle('on');
  buzz(8);
  setSetting(k, sw.classList.contains('on'));
}));
const debounce = (fn, ms = 400) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
$('setName').addEventListener('input', debounce(e => setSetting('name', e.target.value.trim())));

/* ---------- SOS number list ---------- */
const cleanNum = v => v.replace(/[^\d+]/g, '');
const validNum = v => /^\+?\d{6,15}$/.test(cleanNum(v));
function saveNumbers() {
  const vals = [...$('numList').querySelectorAll('input')].map(i => cleanNum(i.value)).filter(validNum);
  setSetting('sosNumbers', vals);
}
const saveNumbersSoon = debounce(saveNumbers, 400);
function numRow(value = '') {
  const row = document.createElement('div');
  row.className = 'num-row';
  row.innerHTML = `<span class="num-badge"></span>
    <input class="field" type="tel" inputmode="tel" autocomplete="tel" placeholder="+358 40 123 4567">
    <button class="icon-btn del" aria-label="Poista numero"><svg><use href="#i-trash"/></svg></button>`;
  const input = row.querySelector('input');
  input.value = value;
  input.addEventListener('input', () => { input.classList.remove('bad'); saveNumbersSoon(); });
  input.addEventListener('blur', () => input.classList.toggle('bad', !!input.value.trim() && !validNum(input.value)));
  row.querySelector('.del').addEventListener('click', () => {
    buzz(10);
    row.classList.add('out');
    setTimeout(() => { row.remove(); renumber(); saveNumbers(); }, 200);
  });
  return row;
}
function renumber() { $('numList').querySelectorAll('.num-badge').forEach((b, i) => b.textContent = i + 1); }
function renderNumbers() {
  const list = $('numList');
  list.innerHTML = '';
  S.sosNumbers.forEach(n => list.appendChild(numRow(n)));
  renumber();
}
function addNumber() {
  const row = numRow();
  $('numList').appendChild(row);
  renumber();
  row.querySelector('input').focus();
}
$('addNum').addEventListener('click', () => { buzz(8); addNumber(); });
$('setMessage').addEventListener('input', debounce(e => setSetting('sosMessage', e.target.value.trim() || DEFAULT_MSG)));
$('setKey').addEventListener('input', debounce(e => setSetting(S.aiProvider === 'openai' ? 'keyOpenai' : 'keyClaude', e.target.value.trim())));

function onSettingChanged(k) {
  if (k === 'units') { renderRide(); renderProfile(); if (listMode) renderCards(); updateNav(); }
  if (k === 'mapStyle') applyMapStyle();
  if (k === 'aiProvider') { renderKeyField(); routesGenerated = false; }
  if (k === 'keyClaude' || k === 'keyOpenai' || k === 'routeLen') routesGenerated = false;
  if (k === 'keepAwake' && !S.keepAwake) wakeLock?.release?.();
  if (k === 'keepAwake' && S.keepAwake && rideActive) keepAwake();
  if (k === 'name') { updateGreeting(); renderProfile(); }
  if (k === 'sosHold') $('sos').style.setProperty('--hold', `${S.sosHold}s`);
}

$('clearHistory').addEventListener('click', e => {
  const cell = e.currentTarget, label = cell.querySelector('.cell-main');
  if (!cell.dataset.confirm) {
    cell.dataset.confirm = '1'; label.textContent = 'Napauta uudelleen vahvistaaksesi'; buzz(10);
    setTimeout(() => { delete cell.dataset.confirm; label.textContent = 'Tyhjennä lenkkihistoria'; }, 3000);
    return;
  }
  D.rides = []; persist(); renderProfile();
  delete cell.dataset.confirm; label.textContent = 'Tyhjennä lenkkihistoria';
  toast('Lenkkihistoria tyhjennetty');
});

$('checkUpdate').addEventListener('click', async () => {
  const val = $('version');
  val.textContent = 'Tarkistetaan…';
  try {
    const { version } = await (await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    if (version === VERSION) { toast('Uusin versio on jo käytössä'); val.textContent = VERSION; return; }
    val.textContent = `Päivitetään ${version}…`;
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    await Promise.all((await caches.keys()).map(k => caches.delete(k)));
    await Promise.all(['./', 'index.html', 'app.js', 'app.css', 'cloud.js', 'config.js', 'sw.js', 'manifest.json']
      .map(f => fetch(f, { cache: 'reload' }).catch(() => {})));
    location.reload();
  } catch {
    toast('Tarkistus epäonnistui, onko netti päällä?');
    val.textContent = VERSION;
  }
});

/* =====================================================================
   Account + cloud sync
   ===================================================================== */
let user = null, pushTimer = null;
const setSync = t => { $('syncState').textContent = t; };
function cloudBlob() {
  const { keyClaude, keyOpenai, ...pub } = S;   // API keys never leave the device
  return { routes: D.routes, rides: D.rides, settings: pub, updatedAt: D.updatedAt };
}
function schedulePush() { if (!user) return; clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 1500); }
async function pushNow() {
  if (!user) return;
  setSync('Synkronoidaan…');
  try { await cloud.push(user.id, cloudBlob()); setSync('Ajan tasalla'); }
  catch (e) { console.warn(e); setSync('Virhe'); }
}
function mergeById(local, remote) {
  const m = new Map();
  [...remote, ...local].forEach(x => m.set(x.id, x));
  return [...m.values()];
}
function applyRemoteSettings(rs) {
  if (!rs) return;
  Object.keys(DEFAULTS).forEach(k => { if (!k.startsWith('key') && k in rs) S[k] = rs[k]; });
  store.set('settings', S);
  applyMapStyle(); onSettingChanged('sosHold'); updateGreeting();
}
function refreshAll() { renderProfile(); renderSettings(); renderRide(); if (listMode === 'saved') { renderCards(); if (D.routes.length) selectRoute(0); } }

// first sign-in on this device: combine what's here with what's in the cloud
async function mergeSync() {
  const row = await cloud.pull(user.id);
  if (row) {
    D.routes = mergeById(D.routes, row.routes || []).sort((a, b) => (b.created || 0) - (a.created || 0));
    D.rides = mergeById(D.rides, row.rides || []).sort((a, b) => b.at - a.at);
    if (!S.name && row.settings?.name) S.name = row.settings.name;
  }
  persist();
  await pushNow();
  refreshAll();
}
// app start while signed in: newest copy wins
async function startupSync() {
  try {
    const row = await cloud.pull(user.id);
    if (!row) return pushNow();
    const remoteAt = Date.parse(row.updated_at) || 0;
    if (remoteAt > D.updatedAt) {
      D.routes = row.routes || []; D.rides = row.rides || []; D.updatedAt = remoteAt;
      store.set('routes', D.routes); store.set('rides', D.rides); store.set('updatedAt', D.updatedAt);
      applyRemoteSettings(row.settings);
      refreshAll();
      setSync('Ajan tasalla');
    } else if (D.updatedAt > remoteAt) await pushNow();
    else setSync('Ajan tasalla');
  } catch (e) { console.warn(e); setSync('Offline'); }
}

function renderLogin() {
  $('noCloud').hidden = cloud.enabled;
  $('loginForm').hidden = !cloud.enabled || !!user;
  $('loggedIn').hidden = !cloud.enabled || !user;
  $('loginTitle').textContent = $('loginBarTitle').textContent = user ? 'Tili' : 'Kirjaudu';
  if (user) $('loggedEmail').textContent = user.email;
  $('loginMsg').textContent = '';
}
$('accountCell').addEventListener('click', () => { renderLogin(); openPage('login'); });

const AUTH_ERR = {
  'Invalid login credentials': 'Väärä sähköposti tai salasana.',
  'Email not confirmed': 'Vahvista ensin sähköpostisi linkistä.',
  'User already registered': 'Tällä sähköpostilla on jo tili. Kirjaudu sisään.',
};
const authMsg = e => AUTH_ERR[e.message] || (/password/i.test(e.message) ? 'Salasanan pitää olla vähintään 6 merkkiä.' : e.message);
async function afterLogin(u) {
  user = u;
  renderLogin(); renderSettings(); renderProfile();
  toast('Kirjauduttu sisään');
  try { await mergeSync(); } catch (e) { console.warn(e); setSync('Virhe'); }
}
function busy(on) { ['signIn', 'signUp'].forEach(id => $(id).disabled = on); }
$('signIn').addEventListener('click', async () => {
  const email = $('email').value.trim(), pw = $('password').value;
  if (!email || !pw) return ($('loginMsg').textContent = 'Anna sähköposti ja salasana.');
  busy(true);
  try { await afterLogin(await cloud.signIn(email, pw)); }
  catch (e) { $('loginMsg').textContent = authMsg(e); }
  finally { busy(false); }
});
$('signUp').addEventListener('click', async () => {
  const email = $('email').value.trim(), pw = $('password').value;
  if (!email || pw.length < 6) return ($('loginMsg').textContent = 'Anna sähköposti ja vähintään 6 merkin salasana.');
  busy(true);
  try {
    const res = await cloud.signUp(email, pw);
    if (res.session) await afterLogin(res.user);
    else $('loginMsg').textContent = 'Tili luotu! Vahvista sähköpostisi linkistä ja kirjaudu sitten sisään.';
  } catch (e) { $('loginMsg').textContent = authMsg(e); }
  finally { busy(false); }
});
$('signOut').addEventListener('click', async () => {
  try { await cloud.signOut(); } catch {}
  user = null;
  renderLogin(); renderSettings(); renderProfile();
  toast('Kirjauduttu ulos. Tiedot jäävät tälle laitteelle.');
});
$('syncNow').addEventListener('click', () => startupSync());

/* =====================================================================
   SOS (hold)
   ===================================================================== */
let holdTimer = null, countTimer = null;
function startHold(e) {
  e.preventDefault();
  if (holdTimer) return;
  const secs = S.sosHold || 5;
  $('sos').style.setProperty('--hold', `${secs}s`);
  $('sos').classList.add('holding');
  document.body.classList.add('sos-holding');
  let left = secs;
  showCount(left);
  countTimer = setInterval(() => { if (--left > 0) showCount(left); }, 1000);
  holdTimer = setTimeout(fireSOS, secs * 1000);
}
function endHold() {
  clearTimeout(holdTimer); clearInterval(countTimer);
  holdTimer = countTimer = null;
  $('sos').classList.remove('holding');
  document.body.classList.remove('sos-holding');
  $('countdown').classList.remove('show', 'tick');
  $('sosLabel').textContent = 'SOS';
}
function showCount(n) {
  const c = $('countdown');
  c.textContent = n;
  $('sosLabel').textContent = n;
  c.classList.remove('tick'); void c.offsetWidth; c.classList.add('show', 'tick');
  navigator.vibrate?.(40);   // always, even if haptics are off: this is an emergency action
}
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function sosText() {
  let body = S.sosMessage || DEFAULT_MSG;
  if (S.sosLocation && lastFix) body += `\nSijainti: https://maps.google.com/?q=${lastFix.lat.toFixed(6)},${lastFix.lon.toFixed(6)}`;
  return body;
}

function fireSOS() {
  endHold();
  navigator.vibrate?.([200, 100, 200]);
  const nums = S.sosNumbers;
  if (!nums.length) {
    showTab('profile'); renderSettings(); openPage('settings');
    setTimeout(addNumber, 450);
    toast('Lisää ensin SOS-numerot');
    return;
  }
  if (S.sosAction === 'call') {
    // the phone asks for one tap to confirm the call; web apps can't dial silently
    location.href = `tel:${nums[0]}`;
    return;
  }
  const enc = encodeURIComponent(sosText());
  location.href = isIOS() ? `sms:/open?addresses=${nums.join(',')}&body=${enc}` : `sms:${nums.join(',')}?body=${enc}`;
}
const sos = $('sos');
sos.addEventListener('pointerdown', startHold);
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => sos.addEventListener(ev, endHold));
sos.addEventListener('contextmenu', e => e.preventDefault());

/* =====================================================================
   Start
   ===================================================================== */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
delete S.keyDiscord;   // removed in 2.4
if (S.sosAction !== 'call') S.sosAction = 'sms';   // the Shortcut and 'none' options were removed
store.set('settings', S);
applyMapStyle();
onSettingChanged('sosHold');
updateGreeting();
showTab('home');
renderCards();
renderRide();
renderProfile();
if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
} else onErr({});

cloud.init().then(u => {
  user = u;
  renderProfile();
  if (user) startupSync();
}).catch(e => console.warn('cloud init', e));
