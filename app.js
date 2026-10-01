import * as cloud from './cloud.js';

const VERSION = '4.0';   // bump here and in version.json on every release
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
  name: '', units: 'km', autoPause: false, keepAwake: true, haptics: true, voice: true,
  mapStyle: 'liberty', routeLen: 'normal',
  sosNumbers: [], sosMessage: DEFAULT_MSG, sosLocation: true, sosHold: 5, sosAction: 'sms',
  aiProvider: 'claude', keyClaude: '', keyOpenai: '', keyGemini: '', keyGroq: ''
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
const isMulti = line => Array.isArray(line?.[0]?.[0]);
const flatLine = line => isMulti(line) ? line.flat() : line;
const simplifyAny = line => isMulti(line) ? line.map(s => simplify(s)).filter(s => s.length > 1) : simplify(line);
const samplePoints = (line, n = 5) => (line = flatLine(line), Array.from({ length: n }, (_, i) => line[Math.round(i * (line.length - 1) / (n - 1))])).map(([lat, lon]) => ({ lat, lon }));

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
  [homeMap, rideMap, sumMap].filter(Boolean).forEach(m => { try { m._gl.getMaplibreMap().setStyle(styleUrl()); } catch {} });
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
  const fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: Date.now(), alt: c.altitude, altAcc: c.altitudeAccuracy };

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
let elapsed = 0, moving = 0, lastTick = Date.now(), distance = 0, maxSpeed = 0, climb = 0, baseAlt = null, lastRidePos = null;
let startedAt = 0, splits = [], nextSplit = 0, lastSplitAt = 0, saveCounter = 0;
let track = null, trackPts = [];
const splitLen = () => isMi() ? 1609.344 : 1000;
const avgKmh = () => moving > 0 ? (distance / 1000) / (moving / 3600000) : 0;

function drawTrack() {
  if (track) track.remove();
  track = L.polyline(trackPts, { color: '#ff3b30', weight: 4, opacity: .85 }).addTo(rideMap);
}
function startRide() {
  rideActive = true;
  elapsed = moving = distance = maxSpeed = climb = 0; baseAlt = null; lastRidePos = null; lastTick = Date.now(); trackPts = [];
  startedAt = Date.now(); splits = []; nextSplit = splitLen(); lastSplitAt = 0;
  drawTrack();
  document.body.classList.add('riding');
  setPaused(false);
  keepAwake();
  speak('Lenkki aloitettu');   // first speech has to happen inside a tap on iPhone
  follow = true;
  if (lastFix) rideMap.setView([lastFix.lat, lastFix.lon], Math.max(rideMap.getZoom(), 16), { animate: true });
  saveRideState();
}
function onRideFix(fix) {
  if (!rideActive || paused || fix.acc > 30) return;
  if (lastRidePos) {
    const d = haversine(lastRidePos, fix), dt = Math.max(1, (fix.t - lastRidePos.t) / 1000);
    if (d <= 2) return;
    // faster than ~90 km/h means a GPS jump: measure again from here instead of adding it
    // (the old rule never moved the anchor, so distance could stop counting for the rest of the ride)
    if (d / dt > 25) { lastRidePos = fix; return; }
    distance += d;
  }
  // climb with a 3 m dead band so GPS altitude noise doesn't add up
  if (fix.alt != null && fix.altAcc != null && fix.altAcc <= 20) {
    if (baseAlt == null) baseAlt = fix.alt;
    else if (fix.alt - baseAlt >= 3) { climb += fix.alt - baseAlt; baseAlt = fix.alt; }
    else if (baseAlt - fix.alt >= 3) baseAlt = fix.alt;
  }
  trackPts.push([+fix.lat.toFixed(6), +fix.lon.toFixed(6)]);
  track.addLatLng([fix.lat, fix.lon]);
  if (peakWin.length === 3) maxSpeed = Math.max(maxSpeed, Math.min(...peakWin));
  lastRidePos = fix;
  checkSplit();
}
function checkSplit() {
  while (distance >= nextSplit) {
    const n = Math.round(nextSplit / splitLen());
    const splitMs = moving - lastSplitAt;
    lastSplitAt = moving; splits.push(splitMs); nextSplit += splitLen();
    toast(`${n} ${dUnit()} · ${fmtTime(splitMs)}`);
    buzz([60, 60, 60]);
    const unit = isMi() ? (n === 1 ? 'maili' : 'mailia') : (n === 1 ? 'kilometri' : 'kilometriä');
    speak(`${n} ${unit}. Aika ${spokenTime(elapsed)}. Viimeisin ${isMi() ? 'maili' : 'kilometri'} ${spokenTime(splitMs)}. Keskinopeus ${Math.round(toSpeed(avgKmh()))}.`);
  }
}
function renderRide() {
  $('speed').textContent = Math.round(toSpeed(speedKmh));
  $('speedUnit').textContent = sUnit().toUpperCase();
  $('time').textContent = fmtTime(elapsed);
  $('dist').textContent = toDist(distance).toFixed(2);
  $('distUnit').textContent = dUnit();
  $('avg').textContent = Math.round(toSpeed(avgKmh()));
  $('avgUnit').textContent = `Keski ${sUnit()}`;
}
setInterval(() => {
  const now = Date.now(), dt = now - lastTick;
  lastTick = now;
  if (rideActive && !paused) {
    elapsed += dt;
    if (speedKmh >= 2 && dt < 5000) moving += dt;   // moving time drives the average, so traffic lights don't drag it down
  }
  if (now - lastFixAt > 5000) speedKmh = 0;

  if (rideActive && S.autoPause) {
    if (!paused && speedKmh === 0) {
      stillSince ||= now;
      if (now - stillSince > 8000) { setPaused(true); autoPaused = true; toast('Automaattinen tauko'); buzz(30); speak('Tauko'); }
    } else if (speedKmh > 0) stillSince = 0;
    if (paused && autoPaused && speedKmh > 4) { setPaused(false); toast('Jatketaan'); buzz(30); speak('Jatketaan'); }
  }
  renderRide();
  if (rideActive && ++saveCounter % 20 === 0) saveRideState();   // every 5 s
}, 250);

function setPaused(v) {
  paused = v; autoPaused = false; stillSince = 0;
  document.body.classList.toggle('paused', v);
  $('pause').setAttribute('aria-label', v ? 'Jatka' : 'Tauko');
  lastRidePos = null;
  if (rideActive) saveRideState();
}
$('pause').addEventListener('click', () => {
  if (!rideActive) return;
  setPaused(!paused); buzz(20);
  speak(paused ? 'Tauko' : 'Jatketaan');
});

/* ---------- keep an unfinished ride if the app is closed or reloaded ---------- */
function saveRideState() {
  if (!rideActive) { try { localStorage.removeItem('rideState'); } catch {} return; }
  store.set('rideState', { elapsed, moving, distance, maxSpeed, climb, paused, startedAt, splits, nextSplit, lastSplitAt, track: trackPts.slice(-4000), savedAt: Date.now() });
}
addEventListener('pagehide', saveRideState);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveRideState(); });
function restoreRide() {
  const st = store.get('rideState', null);
  if (!st) return false;
  if (Date.now() - st.savedAt > 12 * 3600000) { saveRideState(); return false; }
  rideActive = true;
  ({ elapsed, moving, distance, maxSpeed, climb, startedAt, lastSplitAt } = st);
  splits = st.splits || []; nextSplit = st.nextSplit || splitLen(); trackPts = st.track || [];
  // the clock kept running while the app was closed (unless paused); moving time didn't
  if (!st.paused) elapsed += Math.min(Date.now() - st.savedAt, 30 * 60000);
  lastTick = Date.now(); lastRidePos = null; baseAlt = null;
  drawTrack();
  document.body.classList.add('riding');
  setPaused(!!st.paused);
  keepAwake();
  setTimeout(() => toast('Keskeneräinen lenkki palautettu'), 900);
  return true;
}

/* ---------- finishing a ride, ride details ---------- */
let pendingRide = null, detailRide = null, sumMap = null, sumLine = null;
$('main').addEventListener('click', () => {
  if (!rideActive) { startRide(); buzz(40); return; }
  if (!paused) return;
  buzz(40);
  pendingRide = {
    id: uid(), start: startedAt, at: Date.now(), ms: elapsed, moving, m: Math.round(distance),
    avg: +avgKmh().toFixed(1), max: +maxSpeed.toFixed(1), climb: Math.round(climb), splits: [...splits],
    line: simplify(trackPts, 10)
  };
  showRideSheet(pendingRide, 'finish');
});
function showRideSheet(r, mode) {
  $('sumTitle').textContent = mode === 'finish' ? 'Lenkki valmis' : 'Lenkki';
  $('sumDate').textContent = new Date(r.start || r.at).toLocaleString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('sDist').textContent = toDist(r.m).toFixed(2);
  $('sDistUnit').textContent = dUnit();
  $('sTime').textContent = fmtTime(r.moving ?? r.ms);
  $('sAvg').textContent = Math.round(toSpeed(r.avg));
  $('sAvgUnit').textContent = `Keski ${sUnit()}`;
  $('sMax').textContent = Math.round(toSpeed(r.max));
  $('sMaxUnit').textContent = `Huippu ${sUnit()}`;
  $('sClimb').textContent = r.climb == null ? '–' : Math.round(isMi() ? r.climb * 3.28084 : r.climb);
  $('sClimbUnit').textContent = `Nousu ${isMi() ? 'ft' : 'm'}`;
  $('sTotal').textContent = fmtTime(r.ms);
  $('sumFinish').hidden = mode !== 'finish';
  $('sumDetail').hidden = mode !== 'detail';
  for (const id of ['saveRide', 'detailSaveRoute']) {
    const b = $(id);
    b.disabled = !(r.line?.length >= 2);
    b.classList.remove('saved');
    b.querySelector('span').textContent = 'Reitiksi';
  }
  resetConfirm($('discardRide'), 'Hylkää');
  resetConfirm($('deleteRide'), 'Poista');
  const hasLine = r.line?.length >= 2;
  $('sumMap').hidden = !hasLine;
  openSheet('summary');
  if (hasLine) setTimeout(() => drawMini(r.line), 60);
}
function drawMini(line) {
  if (!sumMap) {
    sumMap = L.map('sumMap', { zoomControl: false, attributionControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false });
    sumMap._gl = L.maplibreGL({ style: styleUrl() }).addTo(sumMap);
  }
  const fit = () => { sumMap.invalidateSize(); sumMap.fitBounds(sumLine.getBounds(), { padding: [18, 18], animate: false }); };
  if (sumLine) sumLine.remove();
  sumLine = L.polyline(line, { color: '#ff3b30', weight: 4 }).addTo(sumMap);
  fit();
  setTimeout(fit, 480);   // again once the sheet has finished sliding up
}
// two-tap confirm for destructive buttons
function confirmTap(btn, label, action) {
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm'); btn.querySelector('span').textContent = 'Varmasti?'; buzz(10);
    clearTimeout(btn._t); btn._t = setTimeout(() => resetConfirm(btn, label), 3000);
    return;
  }
  resetConfirm(btn, label);
  action();
}
function resetConfirm(btn, label) { btn.classList.remove('confirm'); btn.querySelector('span').textContent = label; }

function endRide() {
  rideActive = false; pendingRide = null;
  setPaused(false);
  elapsed = moving = distance = maxSpeed = climb = 0; trackPts = []; splits = [];
  if (track) { track.remove(); track = null; }
  document.body.classList.remove('riding');
  wakeLock?.release?.();
  closeSheet('summary');
  saveRideState();
  renderRide(); renderProfile();
}
$('saveRideBtn').addEventListener('click', () => {
  if (!pendingRide) return;
  D.rides.unshift(pendingRide);
  D.rides = D.rides.slice(0, 300);
  persist();
  buzz(30); toast('Lenkki tallennettu');
  endRide();
});
$('discardRide').addEventListener('click', e => confirmTap(e.currentTarget, 'Hylkää', () => { endRide(); toast('Lenkki hylätty'); }));
$('resumeRide').addEventListener('click', () => { closeSheet('summary'); setPaused(false); buzz(20); speak('Jatketaan'); });
$('backdrop').addEventListener('click', () => {
  if ($('summary').classList.contains('open') && !$('nameSheet').classList.contains('open')) closeSheet('summary');
});
async function saveRideAsRoute(r, btn) {
  if (!r || !(r.line?.length >= 2)) return;
  const name = await askName(`Lenkki ${fmtDate(r.start || r.at)}`);
  if (!name) return;
  saveRoute({ name, kind: 'ride', desc: 'Oma ajettu lenkki', line: r.line, distance: r.m, duration: (r.moving ?? r.ms) / 1000, points: samplePoints(r.line), steps: [] });
  btn.classList.add('saved'); btn.disabled = true; btn.querySelector('span').textContent = 'Tallennettu';
}
$('saveRide').addEventListener('click', e => saveRideAsRoute(pendingRide, e.currentTarget));
$('detailSaveRoute').addEventListener('click', e => saveRideAsRoute(detailRide, e.currentTarget));
$('deleteRide').addEventListener('click', e => confirmTap(e.currentTarget, 'Poista', () => {
  D.rides = D.rides.filter(r => r.id !== detailRide?.id);
  persist(); closeSheet('summary'); renderProfile(); toast('Lenkki poistettu');
}));
$('closeDetail').addEventListener('click', () => closeSheet('summary'));
function openRideDetail(id) {
  detailRide = D.rides.find(r => r.id === id);
  if (detailRide) showRideSheet(detailRide, 'detail');
}

/* ---------- spoken announcements (Finnish) ---------- */
let fiVoice = null;
function pickVoice() { try { fiVoice = speechSynthesis.getVoices().find(v => /^fi/i.test(v.lang)) || null; } catch {} }
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!S.voice || !text || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fi-FI'; u.rate = 1.03;
    if (fiVoice) u.voice = fiVoice;
    speechSynthesis.speak(u);
  } catch {}
}
function spokenTime(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  const part = (n, one, many) => n ? `${n} ${n === 1 ? one : many}` : '';
  return [part(h, 'tunti', 'tuntia'), part(m, 'minuutti', 'minuuttia'), h ? '' : part(ss, 'sekunti', 'sekuntia')].filter(Boolean).join(' ') || '0 sekuntia';
}

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
// navigation state lives apart from the route object so it never ends up in saved data
let nav = null;
function setActiveRoute(r, keepView = false) {
  clearRoute(keepView);
  active = r; stepIdx = 0;
  const flat = flatLine(r.line), cum = [0];
  for (let i = 1; i < flat.length; i++) cum.push(cum[i - 1] + haversine({ lat: flat[i - 1][0], lon: flat[i - 1][1] }, { lat: flat[i][0], lon: flat[i][1] }));
  nav = { flat, cum, total: cum[cum.length - 1] || r.distance || 0, idx: 0, remaining: null, offCount: 0, off: false, offD: 0, said: new Set(), arrived: false, rerouteAt: keepView ? Date.now() : 0 };
  activeLine = L.polyline(r.line, { color: '#0a84ff', weight: 6, opacity: .95 }).addTo(rideMap);
  track?.bringToFront();
  rideMap.invalidateSize();
  if (!keepView) {
    rideMap.fitBounds(activeLine.getBounds(), { paddingTopLeft: [30, 140], paddingBottomRight: [30, 60], animate: true });
    follow = false;
  }
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
  if (lastFix) onNavFix(lastFix); else updateNav();
}
function clearRoute(keepView = false) {
  if (activeLine) activeLine.remove();
  active = activeLine = nav = null;
  $('nav').classList.remove('show', 'off');
  $('ext').classList.remove('show');
  $('clearRoute').hidden = $('saveActive').hidden = true;
  if (!keepView) $('search').value = '';
}
$('clearRoute').addEventListener('click', () => { clearRoute(); follow = true; });
function refreshSaveActive() { $('saveActive').classList.toggle('saved', !!active && isSaved(active)); }
$('saveActive').addEventListener('click', () => toggleSave(active).then(refreshSaveActive));

// closest point on the route line (metres), looking ahead of where we were so a loop's finish isn't mistaken for its start
function nearestOnRoute(p) {
  const f = nav.flat;
  if (f.length < 2) return { d: 0, i: 0, t: 0 };
  const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
  const scan = (from, to) => {
    let best = { d: Infinity, i: 0, t: 0 };
    for (let i = Math.max(0, from); i < Math.min(f.length - 1, to); i++) {
      const ax = (f[i][1] - p.lon) * kx, ay = (f[i][0] - p.lat) * ky;
      const dx = (f[i + 1][1] - f[i][1]) * kx, dy = (f[i + 1][0] - f[i][0]) * ky, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.d) best = { d, i, t };
    }
    return best;
  };
  let best = scan(nav.idx - 30, nav.idx + 600);
  if (best.d > 60) { const all = scan(0, f.length); if (all.d < best.d - 20) best = all; }
  return best;
}
const spokenStep = s => { const t = describe(s)[0].replace(' · ', ', '); return t[0].toLowerCase() + t.slice(1); };
const spokenDist = d => isMi() ? `${Math.max(100, Math.round(d * 3.28084 / 100) * 100)} jalan` : `${Math.max(50, Math.round(d / 50) * 50)} metrin`;

function onNavFix(fix) {
  if (!active || !nav) return;
  const near = nearestOnRoute(fix);
  nav.idx = near.i;
  const seg = (nav.cum[near.i + 1] ?? nav.cum[near.i]) - nav.cum[near.i];
  nav.remaining = Math.max(0, nav.total - nav.cum[near.i] - near.t * seg);
  nav.offD = near.d;
  if (fix.acc <= 30) nav.offCount = near.d > 45 ? nav.offCount + 1 : 0;
  const wasOff = nav.off;
  nav.off = nav.offCount >= 3;
  if (rideActive && nav.off && !wasOff) { speak(active.kind === 'dest' ? 'Poistuit reitiltä. Lasketaan uusi reitti.' : 'Poistuit reitiltä'); buzz([80, 60, 80]); }
  if (rideActive && !nav.off && wasOff) speak('Takaisin reitillä');
  if (nav.off && active.kind === 'dest' && Date.now() - nav.rerouteAt > 20000) reroute();

  const steps = active.steps || [];
  if (steps.length) {
    for (let i = stepIdx; i < Math.min(stepIdx + 4, steps.length); i++)
      if (haversine(fix, steps[i]) < 25 && steps[i].type !== 'arrive') stepIdx = i + 1;
    const s = steps[stepIdx];
    if (s && rideActive && !nav.off) {
      const d = haversine(fix, s);
      if (d < 230 && d > 90 && !nav.said.has(`f${stepIdx}`)) { nav.said.add(`f${stepIdx}`); speak(`${spokenDist(d)} päästä ${spokenStep(s)}`); }
      if (d < 45 && !nav.said.has(`n${stepIdx}`)) {
        nav.said.add(`n${stepIdx}`);
        if (s.type === 'arrive') nav.said.add('arr');
        speak(s.type === 'arrive' ? 'Olet perillä' : `Nyt ${spokenStep(s)}`);
      }
    }
  }
  if (active.kind === 'dest' && !nav.arrived && nav.remaining < 30) {
    nav.arrived = true;
    toast('Olet perillä');
    if (rideActive) { buzz([100, 60, 100]); if (!nav.said.has('arr')) speak('Olet perillä'); }
  }
  updateNav();
}
async function reroute() {
  nav.rerouteAt = Date.now();
  const dest = (active.points || []).at(-1);
  if (!dest || !lastFix) return;
  nav.rerouting = true; updateNav();
  try {
    const r = await route([lastFix, dest]);
    setActiveRoute({ ...r, name: active.name, kind: 'dest', desc: active.desc, key: active.key }, true);
    toast('Reitti laskettu uudelleen');
    if (rideActive) speak('Uusi reitti laskettu');
  } catch { if (nav) nav.rerouting = false; updateNav(); }
}
function updateNav() {
  if (!active || !nav) return;
  const steps = active.steps || [];
  $('nav').classList.toggle('show', !!steps.length || nav.off);
  $('nav').classList.toggle('off', nav.off);
  if (nav.off) {
    $('navDist').textContent = `${fmtShort(nav.offD)} reitiltä`;
    $('navStreet').textContent = nav.rerouting ? 'Lasketaan uutta reittiä…' : active.kind === 'dest' ? 'Poistuit reitiltä' : 'Palaa sinisellä merkitylle reitille';
  } else if (steps.length) {
    const s = steps[stepIdx] || steps[steps.length - 1];
    const [txt, deg] = describe(s);
    $('navArrow').style.transform = `rotate(${deg}deg)`;
    $('navStreet').textContent = txt;
    $('navDist').textContent = lastFix ? fmtShort(haversine(lastFix, s)) : '';
  }
  $('navLeft').innerHTML = `<b>${fmtShort(nav.remaining ?? nav.total)}</b><small>jäljellä</small>`;
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
    line: simplifyAny(r.line), points: (r.points || []).map(p => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })), steps: r.steps || []
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
let routesGenerated = false, generating = false, aiError = '', suggested = [], homeLines = [], selected = 0, listMode = 'suggested';
const currentList = () => listMode === 'saved' ? D.routes : suggested;

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

  if (provider === 'gemini') return geminiIdeas(prompt, apiKey);
  if (provider === 'groq') return groqIdeas(prompt, apiKey);
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

// Gemini and Groq retire models often, so ask which ones this key can use and take the best match
const pickModel = (ids, prefs) => prefs.map(re => ids.find(id => re.test(id))).find(Boolean) || ids[0];
const apiErr = async (r, name) => { let m = ''; try { const j = await r.json(); m = j.error?.message || ''; } catch {} return new Error(m || `${name} ${r.status}`); };

async function geminiIdeas(prompt, key) {
  const base = 'https://generativelanguage.googleapis.com/v1beta/';
  const H = { 'x-goog-api-key': key };
  const lr = await fetch(`${base}models?pageSize=200`, { headers: H });
  if (!lr.ok) throw await apiErr(lr, 'Gemini');
  const ids = (await lr.json()).models
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name.replace('models/', ''));
  const version = id => parseFloat(id.split('-')[1]) || 0;
  const flash = ids.filter(id => /^gemini-[\d.]+-flash$/.test(id)).sort((a, b) => version(b) - version(a));
  const model = flash[0] || pickModel(ids, [/gemini.*flash/, /gemini/]);
  const call = cfg => fetch(`${base}models/${model}:generateContent`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: cfg })
  });
  let r = await call({ responseMimeType: 'application/json', responseJsonSchema: ROUTE_SCHEMA });
  // older models don't take a JSON schema; fall back to plain JSON mode with the schema in the prompt
  if (r.status === 400) {
    prompt += `\n\nVastaa pelkällä JSONilla tämän skeeman mukaan: ${JSON.stringify(ROUTE_SCHEMA)}`;
    r = await call({ responseMimeType: 'application/json' });
  }
  if (!r.ok) throw await apiErr(r, 'Gemini');
  const text = (await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini ei palauttanut vastausta');
  return JSON.parse(text).routes;
}

async function groqIdeas(prompt, key) {
  const base = 'https://api.groq.com/openai/v1/';
  const H = { Authorization: `Bearer ${key}` };
  const lr = await fetch(`${base}models`, { headers: H });
  if (!lr.ok) throw await apiErr(lr, 'Groq');
  const ids = (await lr.json()).data
    .filter(m => m.active !== false)
    .map(m => m.id)
    .filter(id => !/whisper|tts|guard|playai|orpheus|distil|compound/i.test(id));
  const model = pickModel(ids, [/gpt-oss-120b/, /llama-4-maverick/, /llama-3\.3-70b/, /kimi/, /qwen/, /llama/]);
  const r = await fetch(`${base}chat/completions`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `Vastaa pelkällä JSONilla tämän skeeman mukaan: ${JSON.stringify(ROUTE_SCHEMA)}` },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    })
  });
  if (!r.ok) throw await apiErr(r, 'Groq');
  return JSON.parse((await r.json()).choices[0].message.content).routes;
}

const hasAiKey = () => !!S[providerKey()];

async function generateRoutes() {
  if (generating) return;
  if (!hasAiKey()) { suggested = []; aiError = ''; routesGenerated = true; if (listMode === 'suggested') renderCards(); return; }
  if (!lastFix) return;
  generating = true; routesGenerated = true; aiError = '';
  const start = { lat: lastFix.lat, lon: lastFix.lon };
  $('regen').classList.add('spin');
  $('homeStatus').textContent = 'AI suunnittelee reittejä…';
  suggested = [];
  if (listMode === 'suggested') renderCards();

  const results = [];
  try {
    const ideas = await aiIdeas(start, S.aiProvider, S[providerKey()]);
    for (const idea of (ideas || []).slice(0, 3)) {
      const maxAway = Math.max(idea.target_km, 5) * 1000 * 0.6;
      const wps = (idea.waypoints || []).filter(w => haversine(start, w) < maxAway);
      if (!wps.length) continue;
      try {
        const r = await route([start, ...wps, start]);
        if (r.distance < 1000) continue;
        results.push({ ...r, name: idea.name, desc: idea.description, ai: true, kind: 'loop', key: `ai:${idea.name}:${Math.round(r.distance / 100)}` });
      } catch {}
    }
    if (!results.length) aiError = 'AI ei löytänyt sopivia reittejä. Kokeile uudelleen.';
  } catch (e) {
    console.warn(e);
    aiError = e.message || 'Tuntematon virhe';
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
    let icon = 'i-route', title, text, action = null;
    if (listMode === 'saved') [title, text] = ['Ei vielä omia reittejä', 'Tallenna reitti kirjanmerkki-napista tai lenkin jälkeen, niin se löytyy täältä.'];
    else if (!hasAiKey()) { icon = 'i-sparkle'; [title, text] = ['Reittiehdotukset AI:lta', 'Lisää API-avain, niin AI suunnittelee lenkkejä lähellesi. Geminin ja Groqin avaimet ovat ilmaisia.']; action = ['Lisää API-avain', openAiSettings]; }
    else if (generating) { icon = 'i-sparkle'; [title, text] = ['AI suunnittelee reittejä…', 'Tämä kestää yleensä 10–30 sekuntia.']; }
    else if (aiError) { [title, text] = ['Reittiehdotukset epäonnistuivat', aiError]; action = ['Yritä uudelleen', () => { routesGenerated = false; generateRoutes(); }]; }
    else [title, text] = ['Odotetaan sijaintia…', 'Reittiehdotukset tulevat, kun GPS löytää sinut.'];
    box.innerHTML = `<div class="glass empty-card${generating ? ' busy' : ''}"><svg><use href="#${icon}"/></svg><b>${esc(title)}</b><p>${esc(text)}</p>${action ? `<button class="empty-btn">${action[0]}</button>` : ''}</div>`;
    if (action) box.querySelector('.empty-btn').addEventListener('click', () => { buzz(10); action[1](); });
    return;
  }
  list.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'glass card';
    el.style.setProperty('--i', i);
    const saved = listMode === 'saved';
    const meta = `${toDist(r.distance).toFixed(1)} ${dUnit()}${r.duration ? ` · ~${Math.round(r.duration / 60)} min` : ''}${saved ? ` · ${fmtDate(r.created)}` : ''}`;
    el.innerHTML = `
      <div class="t"><span class="name">${esc(r.name)}</span>${r.ai ? '<span class="badge">AI</span>' : r.kind === 'osm' ? '<span class="badge osm">OSM</span>' : ''}</div>
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
  if (!hasAiKey()) { toast('Lisää ensin API-avain'); return openAiSettings(); }
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
  if (!generating) $('homeStatus').textContent = hasAiKey() ? 'Reitit lähelläsi' : 'Omat reitit ja haku';
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
    ? rides.slice(0, 20).map(r => `
      <button class="item" data-id="${esc(r.id)}"><div class="ic"><svg><use href="#i-route"/></svg></div>
        <div class="mid"><b>${toDist(r.m).toFixed(1)} ${dUnit()}</b>
        <small>${fmtDate(r.at)} · ${fmtTime(r.moving ?? r.ms)} · ${Math.round(toSpeed(r.avg))} ${sUnit()}</small></div>
        <svg class="chev"><use href="#i-chevron"/></svg></button>`).join('')
    : '<div class="empty">Ei vielä lenkkejä. Aloita Ajo-välilehdeltä.</div>';
  $('history').querySelectorAll('.item').forEach(b => b.addEventListener('click', () => { buzz(8); openRideDetail(b.dataset.id); }));
}
$('openSettings').addEventListener('click', () => { renderSettings(); openPage('settings'); });

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
const PROVIDERS = {
  claude: { key: 'keyClaude', label: 'Claude API -avain', ph: 'sk-ant-…', note: 'Avaimen saa osoitteesta console.anthropic.com (maksullinen).' },
  openai: { key: 'keyOpenai', label: 'OpenAI API -avain', ph: 'sk-…', note: 'Avaimen saa osoitteesta platform.openai.com (maksullinen).' },
  gemini: { key: 'keyGemini', label: 'Gemini API -avain', ph: 'AIza…', note: 'Ilmaisen avaimen saa osoitteesta aistudio.google.com.' },
  groq:   { key: 'keyGroq',   label: 'Groq API -avain',   ph: 'gsk_…', note: 'Ilmaisen avaimen saa osoitteesta console.groq.com.' },
};
const providerKey = () => (PROVIDERS[S.aiProvider] || PROVIDERS.claude).key;
function renderKeyField() {
  const p = PROVIDERS[S.aiProvider] || PROVIDERS.claude;
  $('keyLabel').textContent = p.label;
  $('setKey').placeholder = `${p.ph} (valinnainen)`;
  $('setKey').value = S[p.key] || '';
  $('keyFoot').textContent = `${p.note} Avaimet pysyvät vain tällä laitteella.`;
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
$('setKey').addEventListener('input', debounce(e => setSetting(providerKey(), e.target.value.trim())));

function onSettingChanged(k) {
  if (k === 'units') { renderRide(); renderProfile(); if (listMode) renderCards(); updateNav(); }
  if (k === 'mapStyle') applyMapStyle();
  if (k === 'aiProvider') { renderKeyField(); routesGenerated = false; }
  if (k.startsWith('key') || k === 'routeLen' || k === 'aiProvider') { routesGenerated = false; aiError = ''; updateGreeting(); if (listMode === 'suggested') renderCards(); }
  if (k === 'keepAwake' && !S.keepAwake) wakeLock?.release?.();
  if (k === 'keepAwake' && S.keepAwake && rideActive) keepAwake();
  if (k === 'name') { updateGreeting(); renderProfile(); }
  if (k === 'voice' && !S.voice) { try { speechSynthesis.cancel(); } catch {} }
  if (k === 'voice' && S.voice) speak('Ääniopastus päällä');
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
  const pub = Object.fromEntries(Object.entries(S).filter(([k]) => !k.startsWith('key')));   // API keys never leave the device
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
  applyMapStyle(); updateGreeting();
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

/* ---------- SOS countdown sound + vibration ---------- */
let audio = null;
function unlockAudio() {
  // must happen inside the touch itself, or iOS keeps the sound muted
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';   // play even with the iPhone on silent
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {}
}
function tone(freq, start, dur, vol = .55) {
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + .01);
  g.gain.setValueAtTime(vol, start + dur - .03);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(audio.destination);
  o.start(start); o.stop(start + dur + .02);
}
// recorded countdown sounds (cut from the full Pixel-style sample): chime for 5/4, siren for 3/2, siren with tail for 1
const SOS_SOUNDS = { chime: 'sounds/sos-chime.mp3', siren: 'sounds/sos-siren.mp3', last: 'sounds/sos-siren-last.mp3' };
const sosBuffers = {};
let sosSoundsLoaded = null;
function loadSosSounds() {
  if (sosSoundsLoaded) return sosSoundsLoaded;
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { return Promise.resolve(); }
  sosSoundsLoaded = Promise.all(Object.entries(SOS_SOUNDS).map(async ([name, url]) => {
    try {
      const data = await (await fetch(url)).arrayBuffer();
      sosBuffers[name] = await new Promise((ok, fail) => audio.decodeAudioData(data, ok, fail));
    } catch (e) { console.warn('SOS sound', name, e); }
  }));
  return sosSoundsLoaded;
}
// plays a recorded sample; falls back to the synthesised sound if it hasn't loaded
function playSos(name, fallback) {
  const buf = sosBuffers[name];
  if (!audio || !buf) return fallback();
  const src = audio.createBufferSource(), g = audio.createGain();
  src.buffer = buf;
  g.gain.value = 1.3;
  src.connect(g).connect(audio.destination);
  src.start();
}

function bell(freq, start, dur, vol) {
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + .008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(audio.destination);
  o.start(start); o.stop(start + dur + .02);
}
function chime() {            // counts 5 and 4
  if (!audio) return;
  const t = audio.currentTime + .01;
  bell(523, t, .9, .22); bell(880, t, .8, .2); bell(220, t, .9, .06);
  [0, .1, .18, .33].forEach((d, i) => bell(1568, t + d, i === 3 ? .7 : .14, .26));
  bell(3136, t, .5, .05);
  bell(784, t + .33, .6, .16);
}
function siren() {            // counts 3, 2 and 1
  if (!audio) return;
  const t = audio.currentTime + .01;
  const lp = audio.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 4200;
  lp.connect(audio.destination);
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(420, t);
  o.frequency.linearRampToValueAtTime(1568, t + .35);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(.28, t + .02);
  g.gain.setValueAtTime(.28, t + .34);
  g.gain.exponentialRampToValueAtTime(0.0001, t + .37);
  o.connect(g).connect(lp);
  o.start(t); o.stop(t + .4);
  const b = audio.createOscillator(), bg = audio.createGain();   // G5 blip right after the sweep
  b.type = 'sawtooth';
  b.frequency.setValueAtTime(784, t + .38);
  bg.gain.setValueAtTime(0.0001, t + .38);
  bg.gain.exponentialRampToValueAtTime(.24, t + .39);
  bg.gain.setValueAtTime(.24, t + .5);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + .54);
  b.connect(bg).connect(lp);
  b.start(t + .38); b.stop(t + .56);
}
function alarmFinal() {
  if (!audio || sosBuffers.last) return;   // the recorded last siren already rings out
  const t = audio.currentTime + .01;
  tone(1568, t, .5, .5);
}
// real vibration where the browser has it (Android); on iPhone a hidden switch toggle gives a haptic tick
function strongBuzz(pattern) {
  if (navigator.vibrate) { navigator.vibrate(pattern); return; }
  const sw = $('hapticSwitch');
  const ticks = Array.isArray(pattern) ? Math.ceil(pattern.length / 2) : 1;
  for (let i = 0; i < ticks; i++) setTimeout(() => sw.parentElement.click(), i * 120);
}

const RING = 552.9;   // circumference of the countdown ring (r = 88)
let sosLeft = 0, ringTimer = null;
const SOS_ICON = { sms: 'i-chat', call: 'i-phone', loc: 'i-pin', warn: 'i-alert' };

function openSOS() {
  if (holdTimer) return;
  unlockAudio();
  const secs = S.sosHold || 5, nums = S.sosNumbers;
  const items = [];
  if (!nums.length) items.push(['warn', 'Ei SOS-numeroita: avaa asetukset']);
  else if (S.sosAction === 'call') items.push(['call', `Soittaa numeroon ${nums[0]}`]);
  else {
    items.push(['sms', `Lähettää tekstiviestin ${nums.length === 1 ? 'yhdelle kontaktille' : `${nums.length} kontaktille`}`]);
    if (S.sosLocation) items.push(['loc', lastFix ? 'Jakaa sijaintisi kontakteille' : 'Jakaa sijaintisi (odotetaan GPS:ää)']);
  }
  $('sosList').innerHTML = items.map(([k, t]) => `<li class="${k === 'warn' ? 'warn' : ''}"><svg><use href="#${SOS_ICON[k]}"/></svg>${esc(t)}</li>`).join('');

  const scr = $('sosScreen'), prog = $('sosProg');
  resetKnob(false);
  scr.hidden = false;
  void scr.offsetWidth;
  scr.classList.add('show');
  // drain the ring from a timer rather than a CSS transition so it stays in sync with the count
  const t0 = Date.now();
  prog.style.strokeDashoffset = '0';
  ringTimer = setInterval(() => { prog.style.strokeDashoffset = String(RING * Math.min(1, (Date.now() - t0) / (secs * 1000))); }, 40);
  sosLeft = secs;
  sosTick();
  countTimer = setInterval(() => { if (--sosLeft > 0) sosTick(); }, 1000);
  holdTimer = setTimeout(() => { closeSOSScreen(); fireSOS(); }, secs * 1000);
}
function sosTick() {
  const n = $('sosNum');
  n.textContent = sosLeft;
  n.classList.remove('pop'); void n.offsetWidth; n.classList.add('pop');
  // sound and vibration are always on here, even with haptics off: this is an emergency action
  if (sosLeft <= 3) { playSos(sosLeft === 1 ? 'last' : 'siren', siren); strongBuzz([220, 80, 220]); }
  else { playSos('chime', chime); strongBuzz(60); }
}
function closeSOSScreen() {
  clearTimeout(holdTimer); clearInterval(countTimer); clearInterval(ringTimer);
  holdTimer = countTimer = ringTimer = null;
  const scr = $('sosScreen');
  scr.classList.remove('show');
  setTimeout(() => { if (!holdTimer) scr.hidden = true; }, 300);
}
function cancelSOS() {
  closeSOSScreen();
  navigator.vibrate?.(30);
  toast('SOS peruttu');
}

/* slide-to-cancel */
function resetKnob(animate = true) {
  const k = $('sosKnob');
  k.classList.toggle('snap', animate);
  k.style.transform = 'translateX(0)';
  $('sosSlider').querySelectorAll('.sos-slider-text, .sos-slider-hint').forEach(el => el.style.opacity = '');
}
(() => {
  const knob = $('sosKnob'), slider = $('sosSlider');
  let startX = 0, x = 0, max = 0, dragging = false;
  knob.addEventListener('pointerdown', e => {
    dragging = true; startX = e.clientX - x;
    max = slider.clientWidth - knob.offsetWidth - 12;
    knob.classList.remove('snap');
    knob.setPointerCapture(e.pointerId);
  });
  knob.addEventListener('pointermove', e => {
    if (!dragging) return;
    x = Math.max(0, Math.min(max, e.clientX - startX));
    knob.style.transform = `translateX(${x}px)`;
    slider.querySelectorAll('.sos-slider-text, .sos-slider-hint').forEach(el => el.style.opacity = String(1 - x / max * 1.6));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (x > max * .75) { knob.style.transform = `translateX(${max}px)`; cancelSOS(); }
    else resetKnob(true);
    x = 0;
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
})();

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function sosText() {
  let body = S.sosMessage || DEFAULT_MSG;
  if (S.sosLocation && lastFix) body += `\nSijainti: https://maps.google.com/?q=${lastFix.lat.toFixed(6)},${lastFix.lon.toFixed(6)}`;
  return body;
}

function fireSOS() {
  alarmFinal();
  strongBuzz([500]);
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
sos.addEventListener('click', () => openSOS());
sos.addEventListener('contextmenu', e => e.preventDefault());

/* =====================================================================
   First-run onboarding: add to home screen, then optional API key
   ===================================================================== */
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('obInstall').hidden = false; });

function openAiSettings() {
  showTab('profile'); renderSettings(); openPage('settings');
  setTimeout(() => {
    $('setKey').closest('.group').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => $('setKey').focus({ preventScroll: true }), 450);
  }, 480);
}

let obSteps = [], obIdx = 0;
function startOnboarding() {
  if (store.get('onboarded', false)) return;
  obSteps = [];
  if (!isStandalone()) obSteps.push('obInstallStep');
  if (!['keyClaude', 'keyOpenai', 'keyGemini', 'keyGroq'].some(k => S[k])) obSteps.push('obAiStep');
  if (!obSteps.length) { store.set('onboarded', true); return; }

  const how = isIOS()
    ? [`Napauta <span class="kbd"><svg><use href="#i-share"/></svg></span> Jaa-painiketta selaimen palkissa`, 'Valitse <b>Lisää Koti-valikkoon</b>', 'Avaa Ride kotinäytöltä']
    : /Android/i.test(navigator.userAgent)
      ? ['Napauta <span class="kbd">⋮</span> selaimen oikeassa yläkulmassa', 'Valitse <b>Lisää aloitusnäytölle</b> tai <b>Asenna sovellus</b>', 'Avaa Ride aloitusnäytöltä']
      : ['Avaa tämä sivu puhelimesi selaimella', 'Lisää se kotinäytölle selaimen valikosta', 'Avaa Ride kotinäytöltä'];
  $('obHow').innerHTML = how.map(t => `<li>${t}</li>`).join('');
  ['obInstallStep', 'obAiStep'].forEach(id => $(id).hidden = !obSteps.includes(id));
  $('obDots').innerHTML = obSteps.length > 1 ? obSteps.map(() => '<i></i>').join('') : '';
  $('onboard').hidden = false;
  obIdx = 0; showObStep();
  requestAnimationFrame(() => $('onboard').classList.add('show'));
}
function showObStep() {
  $('obTrack').style.transform = `translateX(${-obIdx * 100}%)`;
  $('obViewport').style.height = `${$(obSteps[obIdx]).offsetHeight}px`;   // card shrinks/grows to fit each step
  [...$('obDots').children].forEach((d, i) => d.classList.toggle('on', i === obIdx));
}
function obNext() { if (obIdx < obSteps.length - 1) { obIdx++; showObStep(); buzz(8); } else obDone(); }
function obDone() {
  store.set('onboarded', true);
  $('onboard').classList.remove('show');
  setTimeout(() => $('onboard').hidden = true, 400);
}
document.querySelectorAll('[data-ob=next]').forEach(b => b.addEventListener('click', obNext));
document.querySelectorAll('[data-ob=done]').forEach(b => b.addEventListener('click', obDone));
$('obKey').addEventListener('click', () => { obDone(); setTimeout(openAiSettings, 250); });
$('obInstall').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null; $('obInstall').hidden = true;
  if (outcome === 'accepted') obNext();
});

/* =====================================================================
   Start
   ===================================================================== */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
delete S.keyDiscord;   // removed in 2.4
if (S.sosAction !== 'call') S.sosAction = 'sms';   // the Shortcut and 'none' options were removed
store.set('settings', S);
applyMapStyle();
updateGreeting();
showTab(restoreRide() ? 'record' : 'home');
renderCards();
renderRide();
renderProfile();
setTimeout(startOnboarding, 700);
loadSosSounds();
if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
} else onErr({});

cloud.init().then(u => {
  user = u;
  renderProfile();
  if (user) startupSync();
}).catch(e => console.warn('cloud init', e));
