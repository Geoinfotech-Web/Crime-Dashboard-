/* ═══════════════════════════════════════════════════════════════════════
   TRAVEL SAFETY — intercity corridors, route-risk map, incident timing,
   and departure/route recommendations.

   Each assessment combines four things:
     • the corridor's baseline segment risk,
     • the hotspot index of the states it crosses,
     • the hour of departure,
     • what regional and national outlets have reported along the road in
       the last week (/api/route-news — see route_news.py).

   Loaded after app.js and hotspot.js (shares global scope). The hourly curve
   is a documented MODEL (daylight-safe / dusk-and-night elevated), nudged by
   the times of day that recent reports mention; it is not per-hour data.
   ═══════════════════════════════════════════════════════════════════════ */
let travelInitialized = false, travelMap = null, travelMapGroup = null, tvHourChart = null;
let tvMode = 'Car', tvCurrentCorridor = null;
// The news for the corridor on screen: null until asked, then loading / ready / error.
let tvNews = { status: 'idle', key: '', data: null, error: '' };
let tvNewsFilter = 'all';
let tvNewsTimer = null;

// Keyless Esri Canvas basemaps (same source the dashboard uses).
const TV_DARK_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const TV_LIGHT_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const TV_TILE_OPTS = { attribution: 'Tiles &copy; Esri &mdash; &copy; OpenStreetMap contributors', maxZoom: 16 };

// Relative incident likelihood by hour of day (0–23). Modelled: lowest mid-day,
// rising through late afternoon, peaking at dusk/evening, elevated overnight.
const TV_HOURLY = [42,38,34,33,36,42, 36,30,26,20,17,16, 18,20,24,34,48,66, 82,95,92,80,66,60];
// Hours a report means when it says "at night", "at dawn" and so on.
const TV_DAYPART_HOURS = {
  night: [20,21,22,23,0,1,2,3], evening: [17,18,19,20], dawn: [4,5,6],
  morning: [6,7,8,9,10,11], afternoon: [12,13,14,15,16]
};
const TV_SEG_WEIGHT = { low: 12, caution: 55, high: 100 };
const TV_SEG_COLOR  = { low: '#35d08a', caution: '#f5a623', high: '#ff5a5f' };
const TV_SEG_ORDER  = ['low', 'caution', 'high'];
const TV_MODE_FACTOR = { Car: 1.0, Bus: 0.93, Convoy: 0.82 };
const TV_NEWS_REFRESH_MS = 10 * 60 * 1000;
// How the score is put together, with and without live reports.
const TV_SCORE_WEIGHTS = { segments: 0.45, states: 0.20, time: 0.15, live: 0.20 };
const TV_SCORE_WEIGHTS_OFFLINE = { segments: 0.60, states: 0.25, time: 0.15, live: 0 };

const TV_CATEGORY = {
  kidnapping:     { icon: 'ti-lock',            cls: 'c-red',    advice: 'Do not stop for anyone on open road, keep windows up, and avoid the road entirely after dark.' },
  armed_attack:   { icon: 'ti-crosshair',       cls: 'c-red',    advice: 'Travel in convoy if you can, keep to the main carriageway and do not take unfamiliar shortcuts.' },
  explosion:      { icon: 'ti-flame',           cls: 'c-red',    advice: 'Stay on tarred, well-used road and follow military or police direction at checkpoints.' },
  killing:        { icon: 'ti-alert-octagon',   cls: 'c-red',    advice: 'Avoid the towns named in the reports and do not stop overnight along the way.' },
  robbery:        { icon: 'ti-shield-off',      cls: 'c-orange', advice: 'Keep valuables out of sight and avoid stopping at isolated spots or unofficial checkpoints.' },
  unrest:         { icon: 'ti-speakerphone',    cls: 'c-orange', advice: 'Expect roadblocks and diversions; avoid town centres and turn back rather than drive through a crowd.' },
  road_crash:     { icon: 'ti-car-crash',       cls: 'c-orange', advice: 'Keep your speed down, leave room around tankers and trucks, and expect delays.' },
  road_condition: { icon: 'ti-road-off',        cls: 'c-blue',   advice: 'Check the road is passable before you set off and allow extra time.' }
};

// Waypoint: [lat, lng, baseline risk, name, state]. A null risk is derived
// from the state's hotspot index. A name makes the town searchable in the
// news, so a report that mentions it is pinned to that part of the road.
// Corridors without distanceKm/estMin/checkpoints have them worked out from
// the waypoints and the checkpoint layer.
const TV_CORRIDORS = [
  { from:'Kaduna', to:'Abuja (FCT)', road:'A2 corridor', distanceKm:188, estMin:160, checkpoints:7,
    waypoints:[[10.5105,7.4165,'low',null,'Kaduna'],[10.20,7.46,'low',null,'Kaduna'],[9.95,7.52,'caution','Rijana','Kaduna'],[9.78,7.56,'high','Katari','Kaduna'],[9.55,7.52,'high','Jere','Kaduna'],[9.30,7.45,'caution',null,'Niger'],[9.0765,7.3986,'low',null,'FCT (Abuja)']],
    stretch:{name:'Rijana–Katari', kmFrom:42, kmTo:58, at:[9.66,7.55]},
    alt:{name:'western bypass', addMin:35, cut:40, waypoints:[[10.5105,7.4165],[10.35,7.05],[9.95,6.85],[9.5,6.9],[9.2,7.15],[9.0765,7.3986]]} },
  { from:'Abuja (FCT)', to:'Lokoja', road:'A2 south', distanceKm:165, estMin:150, checkpoints:5,
    waypoints:[[9.0765,7.3986,'low',null,'FCT (Abuja)'],[8.70,7.10,'caution','Kwali','FCT (Abuja)'],[8.30,6.90,'caution','Abaji','FCT (Abuja)'],[7.95,6.80,'high','Koton-Karfe','Kogi'],[7.80,6.74,'caution',null,'Kogi']],
    stretch:{name:'Koton-Karfe belt', kmFrom:95, kmTo:120, at:[8.00,6.82]}, alt:null },
  { from:'Lagos', to:'Ibadan', road:'Lagos–Ibadan expressway', distanceKm:128, estMin:120, checkpoints:6,
    waypoints:[[6.5244,3.3792,'low',null,'Lagos'],[6.75,3.45,'low','Mowe','Ogun'],[6.95,3.60,'caution','Sagamu','Ogun'],[7.15,3.80,'caution','Ogere','Ogun'],[7.3775,3.9470,'low',null,'Oyo']],
    stretch:{name:'Sagamu–Ogere axis', kmFrom:38, kmTo:60, at:[6.95,3.57]}, alt:null },
  { from:'Abuja (FCT)', to:'Jos', road:'Abuja–Jos road', distanceKm:270, estMin:255, checkpoints:8,
    waypoints:[[9.0765,7.3986,'low',null,'FCT (Abuja)'],[9.20,7.90,'caution','Keffi','Nasarawa'],[9.40,8.30,'caution','Akwanga','Nasarawa'],[9.55,8.60,'high','Riyom','Plateau'],[9.75,8.75,'caution','Barkin Ladi','Plateau'],[9.8965,8.8583,'low',null,'Plateau']],
    stretch:{name:'Riyom–Barkin Ladi', kmFrom:200, kmTo:235, at:[9.58,8.62]}, alt:null },
  { from:'Kaduna', to:'Kano', road:'Kaduna–Zaria–Kano (A2)', distanceKm:253, estMin:210, checkpoints:9,
    waypoints:[[10.5105,7.4165,'low',null,'Kaduna'],[10.80,7.55,'caution',null,'Kaduna'],[11.07,7.70,'caution','Zaria','Kaduna'],[11.50,7.90,'high','Makarfi','Kaduna'],[11.80,8.20,'caution',null,'Kano'],[12.00,8.52,'low',null,'Kano']],
    stretch:{name:'Zaria–Makarfi fringe', kmFrom:95, kmTo:140, at:[11.48,7.92]}, alt:null },
  { from:'Maiduguri', to:'Damaturu', road:'A3 Maiduguri–Damaturu', distanceKm:135, estMin:130, checkpoints:11,
    waypoints:[[11.8333,13.151,'high',null,'Borno'],[11.80,12.80,'high','Auno','Borno'],[11.78,12.40,'high','Benisheikh','Borno'],[11.76,12.10,'caution','Ngamdu','Borno'],[11.7466,11.9608,'caution',null,'Yobe']],
    stretch:{name:'Benisheikh corridor', kmFrom:45, kmTo:85, at:[11.79,12.50]}, alt:null },

  // South-West / South-South / South-East
  { from:'Lagos', to:'Benin City', road:'Lagos–Ore–Benin expressway',
    waypoints:[[6.5244,3.3792,null,null,'Lagos'],[6.84,3.65,null,'Sagamu','Ogun'],[6.82,3.92,null,'Ijebu-Ode','Ogun'],[6.75,4.88,null,'Ore','Ondo'],[6.72,5.15,null,'Ofosu','Edo'],[6.73,5.38,null,'Okada','Edo'],[6.335,5.6037,null,null,'Edo']] },
  { from:'Benin City', to:'Onitsha', road:'Benin–Asaba expressway',
    waypoints:[[6.335,5.6037,null,null,'Edo'],[6.28,5.95,null,'Abudu','Edo'],[6.25,6.20,null,'Agbor','Delta'],[6.20,6.73,null,'Asaba','Delta'],[6.1498,6.7857,null,null,'Anambra']] },
  { from:'Onitsha', to:'Enugu', road:'Onitsha–Enugu expressway',
    waypoints:[[6.1498,6.7857,null,null,'Anambra'],[6.21,7.07,null,'Awka','Anambra'],[6.27,7.27,null,'Oji River','Enugu'],[6.43,7.40,null,'Ninth Mile','Enugu'],[6.4584,7.5464,null,null,'Enugu']] },
  { from:'Enugu', to:'Port Harcourt', road:'Enugu–Port Harcourt expressway',
    waypoints:[[6.4584,7.5464,null,null,'Enugu'],[6.07,7.47,null,'Awgu','Enugu'],[5.83,7.35,null,'Okigwe','Imo'],[5.5333,7.4833,null,'Umuahia','Abia'],[5.1066,7.3667,null,'Aba','Abia'],[4.8156,7.0498,null,null,'Rivers']] },
  { from:'Port Harcourt', to:'Yenagoa', road:'East–West road',
    waypoints:[[4.8156,7.0498,null,null,'Rivers'],[5.08,6.65,null,'Ahoada','Rivers'],[5.05,6.45,null,'Mbiama','Rivers'],[4.9267,6.2676,null,null,'Bayelsa']] },
  { from:'Uyo', to:'Calabar', road:'Calabar–Itu highway',
    waypoints:[[5.0377,7.9128,null,null,'Akwa Ibom'],[5.20,7.98,null,'Itu','Akwa Ibom'],[5.12,8.33,null,'Odukpani','Cross River'],[4.9757,8.3417,null,null,'Cross River']] },
  { from:'Ibadan', to:'Ilorin', road:'Ibadan–Ilorin expressway',
    waypoints:[[7.3775,3.9470,null,null,'Oyo'],[7.85,3.93,null,null,'Oyo'],[8.13,4.24,null,'Ogbomoso','Oyo'],[8.4966,4.5421,null,null,'Kwara']] },

  // North-Central
  { from:'Abuja (FCT)', to:'Makurdi', road:'Keffi–Lafia–Makurdi road',
    waypoints:[[9.0765,7.3986,null,null,'FCT (Abuja)'],[8.85,7.87,null,'Keffi','Nasarawa'],[8.91,8.41,null,'Akwanga','Nasarawa'],[8.49,8.52,null,'Lafia','Nasarawa'],[7.7337,8.5214,null,null,'Benue']] },
  { from:'Abuja (FCT)', to:'Minna', road:'Suleja–Minna road',
    waypoints:[[9.0765,7.3986,null,null,'FCT (Abuja)'],[9.18,7.18,null,'Suleja','Niger'],[9.28,6.95,null,'Lambata','Niger'],[9.6139,6.5569,null,null,'Niger']] },
  { from:'Lokoja', to:'Benin City', road:'Lokoja–Okene–Auchi–Benin road',
    waypoints:[[7.80,6.74,null,null,'Kogi'],[7.55,6.23,null,'Okene','Kogi'],[7.07,6.27,null,'Auchi','Edo'],[6.74,6.14,null,'Ekpoma','Edo'],[6.335,5.6037,null,null,'Edo']] },

  // North-West / North-East
  { from:'Sokoto', to:'Gusau', road:'Sokoto–Gusau road',
    waypoints:[[13.0622,5.2339,null,null,'Sokoto'],[12.75,5.75,null,null,'Sokoto'],[12.57,6.06,null,'Talata Mafara','Zamfara'],[12.17,6.66,null,null,'Zamfara']] },
  { from:'Gusau', to:'Zaria', road:'Gusau–Funtua–Zaria road',
    waypoints:[[12.17,6.66,null,null,'Zamfara'],[11.96,6.92,null,'Tsafe','Zamfara'],[11.52,7.31,null,'Funtua','Katsina'],[11.07,7.70,null,null,'Kaduna']] },
  { from:'Kano', to:'Katsina', road:'Kano–Katsina road',
    waypoints:[[12.00,8.52,null,null,'Kano'],[12.55,7.83,null,'Kankia','Katsina'],[12.99,7.60,null,null,'Katsina']] },
  { from:'Bauchi', to:'Jos', road:'Bauchi–Jos road',
    waypoints:[[10.31,9.84,null,null,'Bauchi'],[10.06,9.07,null,'Toro','Bauchi'],[9.8965,8.8583,null,null,'Plateau']] },
  { from:'Yola', to:'Gombe', road:'Yola–Numan–Gombe road',
    waypoints:[[9.2035,12.4954,null,null,'Adamawa'],[9.47,12.03,null,'Numan','Adamawa'],[9.81,11.31,null,'Kaltungo','Gombe'],[10.29,11.17,null,null,'Gombe']] }
];

function tv12h(h){ const ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return `${hh}:00 ${ap}`; }
function tvShortH(h){ const ap = h >= 12 ? 'p' : 'a'; let hh = h % 12; if (hh === 0) hh = 12; return `${hh}${ap}`; }
function tvHourColor(v){ return v >= 56 ? '#ff5a5f' : v >= 30 ? '#f5a623' : '#35d08a'; }
function tvPlural(n, word){ return `${n} ${word}${n === 1 ? '' : 's'}`; }

function tvAgo(hours){
  if (hours == null) return 'undated';
  if (hours < 1) return 'under an hour ago';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return tvPlural(Math.round(hours / 24), 'day') + ' ago';
}

function tvKm(a, b){
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function tvStateScore(stateName){
  const rows = (typeof cachedHotspots !== 'undefined' && cachedHotspots) || computeHotspots() || [];
  return rows.find(row => row.state === stateName)?.composite || 0;
}

function tvBaselineLevel(stateName){
  const score = tvStateScore(stateName);
  return score >= 45 ? 'high' : score >= 28 ? 'caution' : 'low';
}

// Fill in what a corridor leaves out, once, so the rest of the code can rely on it.
function tvPrepareCorridor(c){
  if (c.prepared) return c;
  c.states = [...new Set(c.waypoints.map(w => w[4]).filter(Boolean))];
  c.waypoints.forEach(w => { if (!w[2]) { w[2] = tvBaselineLevel(w[4]); c.derivedRisk = true; } });
  if (!c.distanceKm){
    let km = 0;
    for (let i = 0; i < c.waypoints.length - 1; i++) km += tvKm(c.waypoints[i], c.waypoints[i + 1]);
    c.distanceKm = Math.round(km * 1.22);            // roads wander; straight lines do not
    c.estMin = Math.round(c.distanceKm / 62 * 60 / 5) * 5;
    c.estimated = true;
  }
  if (c.checkpoints == null){
    const known = (typeof checkpointData !== 'undefined' && checkpointData) || [];
    c.checkpoints = known.filter(cp => c.waypoints.some(w => tvKm([cp.lat, cp.lng], w) <= 25)).length;
  }
  c.prepared = true;
  return c;
}

// Find a corridor for from→to in either direction (reversed copy if needed).
function tvFindCorridor(from, to){
  const direct = TV_CORRIDORS.find(c => c.from === from && c.to === to);
  if (direct) return tvPrepareCorridor(direct);
  const rev = TV_CORRIDORS.find(c => c.from === to && c.to === from);
  if (!rev) return null;
  tvPrepareCorridor(rev);
  const c = JSON.parse(JSON.stringify(rev));
  c.from = rev.to; c.to = rev.from;
  c.waypoints = c.waypoints.slice().reverse();
  if (c.alt) c.alt.waypoints = c.alt.waypoints.slice().reverse();
  if (c.stretch){ const a = c.distanceKm - rev.stretch.kmTo, b = c.distanceKm - rev.stretch.kmFrom; c.stretch.kmFrom = Math.max(0, a); c.stretch.kmTo = b; }
  return c;
}

function tvCorridorPlaces(corr){
  return corr.waypoints.slice(1, -1).map(w => w[3]).filter(Boolean);
}

// ── Live reports ─────────────────────────────────────────────

function tvNewsKey(corr){ return [corr.from, corr.to].sort().join('|'); }
// During a refresh the previous answer stays in use, so the score does not flicker.
function tvLiveData(){ return tvNews.status === 'ready' || tvNews.status === 'loading' ? tvNews.data : null; }

async function tvLoadNews(corr, force){
  const key = tvNewsKey(corr);
  if (!force && tvNews.key === key && (tvNews.status === 'ready' || tvNews.status === 'loading')) return;
  tvNews = { status: 'loading', key, data: tvNews.key === key ? tvNews.data : null, error: '' };
  renderTravelNews();

  const params = new URLSearchParams({
    states: corr.states.join('|'),
    places: tvCorridorPlaces(corr).join('|'),
    label: `${corr.from} → ${corr.to}`
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`/api/route-news?${params}`, { cache: 'no-store', signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}`);
    if (tvNews.key !== key) return;               // the traveller has moved on to another route
    tvNews = { status: 'ready', key, data, error: '' };
  } catch (error) {
    if (tvNews.key !== key) return;
    tvNews = { status: 'error', key, data: null,
      error: error.name === 'AbortError' ? 'The news sources took too long to answer.' : error.message };
  } finally {
    clearTimeout(timeout);
  }
  if (tvCurrentCorridor && tvNewsKey(tvCurrentCorridor) === key) tvRenderAssessment();
}

// Segment levels after the news has had its say: a report naming a town on
// the road raises the stretch either side of it by one level.
function tvEffectiveLevels(corr){
  const levels = corr.waypoints.map(w => w[2]);
  const raised = new Set();
  const live = tvLiveData();
  if (live){
    live.events.filter(e => e.onRoute && (e.ageHours ?? 999) <= 96 && e.category !== 'road_condition').forEach(e => {
      e.places.forEach(place => {
        const i = corr.waypoints.findIndex(w => w[3] === place);
        if (i < 0 || raised.has(i)) return;
        levels[i] = TV_SEG_ORDER[Math.min(2, TV_SEG_ORDER.indexOf(levels[i]) + 1)];
        raised.add(i);
      });
    });
  }
  return { levels, raised };
}

function tvHourlyCurve(){
  const curve = TV_HOURLY.slice();
  const mentions = tvLiveData()?.counts.timeOfDay || {};
  let used = 0;
  Object.entries(mentions).forEach(([part, count]) => {
    used += count;
    (TV_DAYPART_HOURS[part] || []).forEach(h => { curve[h] = Math.min(100, curve[h] + Math.min(count, 4) * 6); });
  });
  return { curve, mentions: used };
}

function tvRouteRisk(corr, departHour){
  const { levels } = tvEffectiveLevels(corr);
  const weights = [];
  for (let i = 0; i < levels.length - 1; i++){
    weights.push(Math.max(TV_SEG_WEIGHT[levels[i]], TV_SEG_WEIGHT[levels[i+1]]));
  }
  const mean = weights.reduce((a,b)=>a+b,0) / weights.length;
  const { curve } = tvHourlyCurve();
  const live = tvLiveData();
  const parts = {
    segments: (mean + Math.max(...weights)) / 2,
    states: corr.states.reduce((sum, s) => sum + tvStateScore(s), 0) / corr.states.length,
    time: curve[departHour] / Math.max(...curve) * 100,
    live: live ? live.liveIndex : 0
  };
  const w = live ? TV_SCORE_WEIGHTS : TV_SCORE_WEIGHTS_OFFLINE;
  let score = Object.keys(w).reduce((sum, key) => sum + parts[key] * w[key], 0);
  score *= (TV_MODE_FACTOR[tvMode] || 1);
  score = Math.max(5, Math.min(99, Math.round(score)));
  const highSegs = weights.filter(v => v >= TV_SEG_WEIGHT.high).length;
  return { score, segCount: weights.length, highSegs, parts, weights: w, hasLive: Boolean(live) };
}

function tvRiskBand(score){
  if (score >= 70) return { label:'High Risk', cls:'is-crit' };
  if (score >= 50) return { label:'Elevated',  cls:'is-high' };
  if (score >= 30) return { label:'Moderate',  cls:'is-mod' };
  return { label:'Lower Risk', cls:'is-low' };
}

function tvWindow(curve, predicate){
  const hrs = []; for (let h = 0; h < 24; h++) if (predicate(curve[h])) hrs.push(h);
  if (!hrs.length) return '—';
  // Longest unbroken run, so "safest" reads as one window rather than first-to-last.
  let best = [hrs[0]], run = [hrs[0]];
  for (let i = 1; i < hrs.length; i++){
    run = hrs[i] === hrs[i-1] + 1 ? [...run, hrs[i]] : [hrs[i]];
    if (run.length > best.length) best = run;
  }
  return `${tvShortH(best[0])}–${tvShortH((best[best.length-1] + 1) % 24)}`;
}

function selectTravelMode(btn){
  tvMode = btn.dataset.mode;
  document.querySelectorAll('#tvModes .tv-mode').forEach(b => b.classList.toggle('active', b === btn));
  if (tvCurrentCorridor) tvRenderAssessment();
}

function tvPinIcon(color){
  return L.divIcon({ className:'', iconSize:[22,30], iconAnchor:[11,30], popupAnchor:[0,-28],
    html:`<svg class="tv-route-pin" width="22" height="30" viewBox="0 0 22 30"><path d="M11 0C5 0 0 4.7 0 10.6 0 18.6 11 30 11 30s11-11.4 11-19.4C22 4.7 17 0 11 0z" fill="${color}"/><circle cx="11" cy="10.6" r="4" fill="#fff"/></svg>` });
}

function fitTravelBounds(){
  if (!tvCurrentCorridor || !travelMap) return;
  const pts = tvCurrentCorridor.waypoints.map(w => [w[0], w[1]]);
  if (tvCurrentCorridor.alt) tvCurrentCorridor.alt.waypoints.forEach(w => pts.push([w[0], w[1]]));
  travelMap.fitBounds(L.latLngBounds(pts).pad(0.25));
}

function renderTravelRoute(corr, refit){
  travelMapGroup.clearLayers();
  const { levels, raised } = tvEffectiveLevels(corr);
  for (let i = 0; i < corr.waypoints.length - 1; i++){
    const a = corr.waypoints[i], b = corr.waypoints[i+1];
    const risk = TV_SEG_WEIGHT[levels[i]] >= TV_SEG_WEIGHT[levels[i+1]] ? levels[i] : levels[i+1];
    L.polyline([[a[0],a[1]],[b[0],b[1]]], { color: TV_SEG_COLOR[risk], weight: 6, opacity: 0.95, lineCap:'round' }).addTo(travelMapGroup);
  }
  if (corr.alt){
    L.polyline(corr.alt.waypoints.map(w => [w[0],w[1]]), { color:'#2e8fff', weight:3, opacity:0.8, dashArray:'7 7' }).addTo(travelMapGroup);
  }
  if (corr.stretch){
    L.marker([corr.stretch.at[0], corr.stretch.at[1]], {
      icon: L.divIcon({ className:'', iconSize:[0,0], html:`<div class="tv-stretch-flag"><i class="ti ti-alert-triangle-filled"></i> ${escapeHtml(corr.stretch.name)} · ambush-prone</div>` })
    }).addTo(travelMapGroup);
  }

  // Towns along the road, and what has been reported at each.
  const live = tvLiveData();
  corr.waypoints.slice(1, -1).forEach((w, offset) => {
    if (!w[3]) return;
    const events = live ? live.events.filter(e => e.places.includes(w[3])) : [];
    const marker = L.marker([w[0], w[1]], {
      icon: L.divIcon({ className:'', iconSize:[0,0],
        html:`<div class="tv-town${events.length ? ' has-news' : ''}${raised.has(offset + 1) ? ' is-raised' : ''}"><span class="tv-town-dot"></span>${escapeHtml(w[3])}${events.length ? ` <b>${events.length}</b>` : ''}</div>` })
    }).addTo(travelMapGroup);
    if (events.length){
      marker.bindPopup(`<div class="popup-title">${escapeHtml(w[3])} · ${tvPlural(events.length, 'report')}</div>` +
        events.slice(0, 3).map(e => `<div class="popup-detail"><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a><br><span style="opacity:.7">${escapeHtml(e.source)} · ${tvAgo(e.ageHours)}</span></div>`).join(''));
    }
  });

  const wp = corr.waypoints;
  L.marker([wp[0][0], wp[0][1]], { icon: tvPinIcon('#2e8fff') }).bindPopup(`<div class="popup-title">${escapeHtml(corr.from)} · start</div>`).addTo(travelMapGroup);
  L.marker([wp[wp.length-1][0], wp[wp.length-1][1]], { icon: tvPinIcon('#35d08a') }).bindPopup(`<div class="popup-title">${escapeHtml(corr.to)} · destination</div>`).addTo(travelMapGroup);
  if (refit) fitTravelBounds();
}

function renderTravelRating(corr, risk){
  const band = tvRiskBand(risk.score);
  const live = tvLiveData();
  const stamp = tvNews.status === 'loading' ? 'checking news…'
    : live ? `news checked ${formatNewsDate(live.generatedAt)}`
    : 'baseline only';
  const rows = [
    ['segments', 'Road segments'], ['states', 'State hotspot index'],
    ['time', 'Hour of departure'], ['live', 'Live reports']
  ].map(([key, label]) => {
    const value = Math.round(risk.parts[key]);
    const off = key === 'live' && !risk.hasLive;
    return `<div class="tv-part${off ? ' is-off' : ''}">
      <span class="tv-part-lbl">${label}<em>${Math.round(risk.weights[key] * 100)}%</em></span>
      <span class="tv-part-track"><span class="tv-part-fill" style="width:${off ? 0 : value}%;background:${tvHourColor(value)}"></span></span>
      <span class="tv-part-val">${off ? '—' : value}</span>
    </div>`;
  }).join('');
  const approx = corr.estimated ? '≈ ' : '';

  const card = document.getElementById('tvRatingCard');
  card.className = `panel-card tv-rating-card ${band.cls}`;
  card.innerHTML = `
    <div class="tv-rating-top">
      <span class="tv-risk-badge ${band.cls}">${band.label}</span>
      <span class="tv-rating-live">${escapeHtml(stamp)}</span>
    </div>
    <div class="tv-score">${risk.score}<span class="tv-score-max"> /100</span></div>
    <div class="tv-corridor"><i class="ti ti-route"></i> ${escapeHtml(corr.from)} → ${escapeHtml(corr.to)} · ${escapeHtml(corr.road)}</div>
    <div class="tv-metrics">
      <div class="tv-metric"><div class="tv-metric-lbl">Distance</div><div class="tv-metric-val">${approx}${corr.distanceKm} km</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">Est. time</div><div class="tv-metric-val">${approx}${Math.floor(corr.estMin/60)}h ${corr.estMin%60}m</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">Risk segments</div><div class="tv-metric-val ${risk.highSegs ? 'danger' : ''}">${risk.highSegs} of ${risk.segCount}</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">Reports · 7 days</div><div class="tv-metric-val ${live && live.counts.onRoute ? 'danger' : ''}">${live ? live.counts.events : '—'}</div></div>
    </div>
    <div class="tv-parts"><div class="tv-parts-hd">What the score is made of</div>${rows}</div>
    <div class="tv-states">Crosses ${corr.states.map(escapeHtml).join(' · ')}${corr.derivedRisk ? ' · segment risk taken from each state’s hotspot index' : ''}</div>`;
}

function renderTravelHourChart(){
  const canvas = document.getElementById('tvHourChart');
  if (!canvas) return;
  const { curve, mentions } = tvHourlyCurve();
  const labels = Array.from({length:24}, (_,h) => [0,6,12,18,23].includes(h) ? (h===23?'11p':tvShortH(h)) : '');
  if (tvHourChart) {
    tvHourChart.data.datasets[0].data = curve;
    tvHourChart.data.datasets[0].backgroundColor = curve.map(tvHourColor);
    tvHourChart.update();
  } else {
    tvHourChart = new Chart(canvas, {
      type:'bar',
      data:{ labels, datasets:[{ data: curve, backgroundColor: curve.map(tvHourColor), borderRadius:3, barPercentage:0.85, categoryPercentage:0.9 }] },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title:(it)=>tv12h(it[0].dataIndex), label:(it)=>`Relative risk ${it.raw}` } } },
        scales:{ x:{ grid:{display:false}, ticks:{ color:'#8a94a3', font:{size:9}, autoSkip:false, maxRotation:0 } },
                 y:{ display:false, beginAtZero:true } } }
    });
  }
  document.getElementById('tvSafeWindow').textContent = tvWindow(curve, v => v < 30);
  document.getElementById('tvPeakWindow').textContent = tvWindow(curve, v => v >= 56);
  document.getElementById('tvEstNote').innerHTML = `<i class="ti ti-info-circle"></i> Modelled daylight/dusk pattern${mentions
    ? `, raised for the times of day named in ${tvPlural(mentions, 'recent report')}` : ''} — not live per-hour data.`;
  return curve;
}

function renderTravelDepart(corr, risk, curve){
  let peakStart = -1;
  for (let h = 12; h < 24; h++) if (curve[h] >= 56) { peakStart = h; break; }
  if (peakStart < 0) peakStart = 17;
  const live = tvLiveData();
  const travelH = corr.estMin / 60;
  // A busy week on this road earns an extra hour's margin before dusk.
  const margin = live && live.liveIndex >= 50 ? 2 : 1;
  let leaveBy = Math.floor(peakStart - travelH - margin);
  leaveBy = Math.max(5, Math.min(leaveBy, 20));
  const postpone = risk.score >= 80 && live && live.events.some(e => e.onRoute && (e.ageHours ?? 999) <= 48);

  const box = document.getElementById('tvDepart');
  box.classList.toggle('is-warn', Boolean(postpone));
  box.querySelector('.tv-depart-ico i').className = postpone ? 'ti ti-hand-stop' : 'ti ti-circle-check';
  document.getElementById('tvDepartLbl').textContent = postpone ? 'Recommendation' : 'Recommended departure';
  document.getElementById('tvDepartVal').textContent = postpone ? 'Postpone if you can' : `Leave before ${tv12h(leaveBy)}`;
  return { peakStart, leaveBy, postpone, margin };
}

function tvSourceLine(e){
  const extra = e.sourceCount > 1 ? ` and ${tvPlural(e.sourceCount - 1, 'other outlet')}` : '';
  return `${escapeHtml(e.source)}${extra}, ${tvAgo(e.ageHours)}`;
}

function renderTravelRecs(corr, departHour, dep){
  const recs = [];
  const live = tvLiveData();

  if (dep.postpone){
    recs.push({ c:'r-red', i:'ti-hand-stop', html:`<strong>Postpone non-essential travel on this road.</strong> The route scores in the highest band and incidents have been reported on it in the last two days.` });
  }
  if (live){
    // What has happened on the road itself comes before anything general.
    live.events.filter(e => e.onRoute).slice(0, 2).forEach(e => {
      recs.push({ c: TV_CATEGORY[e.category]?.cls === 'c-blue' ? 'r-blue' : 'r-red', i: TV_CATEGORY[e.category]?.icon || 'ti-alert-triangle',
        html:`<strong>Reported at ${escapeHtml(e.places.join(', '))}:</strong> <a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a> <span class="tv-rec-src">— ${tvSourceLine(e)}</span>` });
    });
  }
  if (corr.stretch){
    recs.push({ c:'r-red', i:'ti-alert-triangle-filled', html:`<strong>Avoid the ${escapeHtml(corr.stretch.name)} stretch (km ${corr.stretch.kmFrom}–${corr.stretch.kmTo})</strong> — highest ambush risk on this corridor, especially after dark.` });
  }
  if (live){
    // The kind of incident being reported most, weighted by how recent and how close.
    const byCategory = new Map();
    live.events.filter(e => (e.ageHours ?? 999) <= 96).forEach(e => {
      const item = byCategory.get(e.category) || { weight: 0, events: [] };
      item.weight += e.weight; item.events.push(e);
      byCategory.set(e.category, item);
    });
    [...byCategory.entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, 2).forEach(([category, item]) => {
      const meta = TV_CATEGORY[category];
      const states = [...new Set(item.events.flatMap(e => e.states))];
      const lead = item.events[0];
      recs.push({ c: meta.cls === 'c-red' ? 'r-red' : meta.cls === 'c-blue' ? 'r-blue' : 'r-orange', i: meta.icon,
        html:`<strong>${tvPlural(item.events.length, `${lead.categoryLabel.toLowerCase()} report`)} in ${escapeHtml(states.join(', '))} in the last four days.</strong> ${meta.advice} <span class="tv-rec-src">Latest: <a href="${escapeHtml(lead.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(lead.title)}</a> — ${tvSourceLine(lead)}</span>` });
    });
    const dark = (live.counts.timeOfDay.night || 0) + (live.counts.timeOfDay.evening || 0) + (live.counts.timeOfDay.dawn || 0);
    if (dark){
      recs.push({ c:'r-orange', i:'ti-moon', html:`<strong>${tvPlural(dark, 'recent report')} describe${dark === 1 ? 's' : ''} incidents after dark or before dawn.</strong> Be off the road by ${tv12h(Math.max(dep.peakStart - 1, 12))}.` });
    }
    if (!live.counts.events){
      recs.push({ c:'r-green', i:'ti-news', html:`<strong>No incident reports found for this route in the last ${live.windowDays} days</strong> across ${tvPlural(live.sources.answered, 'source')}. Quiet coverage is not proof of a safe road — the usual precautions still apply.` });
    }
  }

  const entersPeak = departHour >= dep.peakStart || (departHour + corr.estMin/60) >= dep.peakStart;
  recs.push({ c:'r-green', i:'ti-sun-high', html: entersPeak
    ? `<strong>Travel in daylight.</strong> Your ${tv12h(departHour)} departure enters the peak-risk window — move it earlier to arrive before dusk.`
    : `<strong>Travel in daylight.</strong> Your ${tv12h(departHour)} departure keeps you clear of the dusk peak — keep it that way.` });
  if (corr.alt){
    recs.push({ c:'r-blue', i:'ti-route', html:`<strong>Consider the ${escapeHtml(corr.alt.name)}.</strong> Adds ~${corr.alt.addMin} min but cuts exposure to the high-risk stretch by about ${corr.alt.cut}%.` });
  }
  recs.push({ c:'r-orange', i:'ti-shield', html: tvMode === 'Convoy'
    ? `<strong>Good — you're moving in convoy.</strong> Keep doors locked and fuel topped up; don't stop in the flagged zone.`
    : `<strong>Move in a group or convoy.</strong> Keep doors locked and fuel topped up; avoid stopping in the flagged zone.` });
  recs.push({ c:'r-blue', i:'ti-share', html:`<strong>Share your live trip</strong> with a trusted contact and check in at each major town.` });

  document.getElementById('tvRecs').innerHTML = recs.map(r =>
    `<div class="tv-rec ${r.c}"><i class="ti ${r.i} tv-rec-ico"></i><div class="tv-rec-txt">${r.html}</div></div>`).join('');
}

// ── News panel ───────────────────────────────────────────────

function setTravelNewsFilter(btn){
  tvNewsFilter = btn.dataset.filter;
  renderTravelNews();
}

function refreshTravelNews(){
  if (tvCurrentCorridor) tvLoadNews(tvCurrentCorridor, true);
}

function tvNewsItemHtml(e){
  const meta = TV_CATEGORY[e.category] || { icon: 'ti-news', cls: 'c-blue' };
  const tags = [];
  if (e.onRoute) tags.push(`<span class="tv-news-tag is-route"><i class="ti ti-map-pin"></i> On this road · ${escapeHtml(e.places.join(', '))}</span>`);
  else if (e.road) tags.push('<span class="tv-news-tag is-road"><i class="ti ti-road"></i> Road-related</span>');
  if (e.response) tags.push('<span class="tv-news-tag">Security response</span>');
  if (e.locatedBy === 'search') tags.push('<span class="tv-news-tag is-soft" title="The headline does not name the state; the article came up in a search for it.">Location from search</span>');
  const more = e.sourceCount > 1
    ? `<span class="tv-news-more" title="${escapeHtml(e.coverage.map(c => c.source).join(', '))}">+${e.sourceCount - 1} more</span>` : '';
  return `<a class="tv-news-item" href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">
    <span class="tv-news-ico ${meta.cls}"><i class="ti ${meta.icon}"></i></span>
    <span class="tv-news-body">
      <span class="tv-news-top"><span class="tv-news-cat ${meta.cls}">${escapeHtml(e.categoryLabel)}</span><span class="tv-news-where">${escapeHtml(e.states.join(' · '))}</span><span class="tv-news-age">${tvAgo(e.ageHours)}</span></span>
      <span class="tv-news-title">${escapeHtml(e.title)}</span>
      <span class="tv-news-meta"><span class="tv-news-src${e.regionalSources.length ? ' is-regional' : ''}">${e.regionalSources.length ? '<i class="ti ti-building-broadcast-tower"></i> ' : ''}${escapeHtml(e.source)}</span>${more}${tags.join('')}</span>
    </span>
  </a>`;
}

function renderTravelNews(){
  const list = document.getElementById('tvNewsList');
  const summary = document.getElementById('tvNewsSummary');
  const sourcesEl = document.getElementById('tvNewsSources');
  if (!list) return;
  document.querySelectorAll('#tvNewsFilters .tv-news-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === tvNewsFilter));
  document.getElementById('tvNewsRefresh').classList.toggle('is-busy', tvNews.status === 'loading');

  if (tvNews.status === 'idle' || !tvCurrentCorridor){
    summary.textContent = '';
    sourcesEl.innerHTML = '';
    list.innerHTML = '<div class="tv-empty">Assess a route to see what is being reported along it.</div>';
    return;
  }
  if (tvNews.status === 'loading' && !tvNews.data){
    summary.textContent = 'Checking regional and national sources…';
    sourcesEl.innerHTML = '';
    list.innerHTML = '<div class="tv-news-wait"><i class="ti ti-loader-2 ti-spin"></i> Reading the papers for the states on this route. The first check takes a few seconds.</div>';
    return;
  }
  if (tvNews.status === 'error'){
    summary.textContent = 'News unavailable';
    sourcesEl.innerHTML = '';
    list.innerHTML = `<div class="tv-empty"><strong>Could not load route news.</strong> ${escapeHtml(tvNews.error)} The rating on the left is the baseline without live reports. <button type="button" class="tv-inline-btn" onclick="refreshTravelNews()">Try again</button></div>`;
    return;
  }

  const live = tvNews.data;
  const c = live.counts;
  summary.innerHTML = `${tvPlural(c.events, 'incident')} from ${tvPlural(c.reports, 'report')} · ${c.onRoute} on this road · ${c.roadRelated} road-related · ${c.last24h} in the last 24h`;

  const filters = {
    all: () => true,
    route: e => e.onRoute || e.road,
    regional: e => e.regionalSources.length > 0,
    day: e => (e.ageHours ?? 999) <= 24
  };
  const shown = live.events.filter(filters[tvNewsFilter] || filters.all);
  list.innerHTML = shown.length
    ? shown.map(tvNewsItemHtml).join('')
    : `<div class="tv-empty">${live.events.length ? 'Nothing matches this filter.' : `No incident reports found for the states on this route in the last ${live.windowDays} days.`}</div>`;

  const s = live.sources;
  const regional = s.list.filter(row => row.scope === 'regional');
  const row = r => `<li class="${r.ok ? '' : 'is-down'}"><span>${escapeHtml(r.name)}</span><span>${r.ok ? `${r.matched} of ${r.items} relevant${r.stale ? ' · cached' : ''}` : 'no answer'}</span></li>`;
  sourcesEl.innerHTML = `<details>
    <summary><i class="ti ti-rss"></i> ${s.answered} of ${tvPlural(s.checked, 'source')} answered · ${s.regionalAnswered} regional${s.failed.length ? ` · ${s.failed.length} unreachable` : ''}${s.offline.length ? ` · ${s.offline.length} not online` : ''}</summary>
    <div class="tv-src-grid">
      <div><div class="tv-src-hd">Regional outlets for ${escapeHtml(live.route.zones.join(', '))}</div><ul>${regional.map(row).join('') || '<li><span>None with a feed for these states</span><span></span></li>'}</ul></div>
      <div><div class="tv-src-hd">National outlets and searches</div><ul>${s.list.filter(r => r.scope !== 'regional').map(row).join('')}</ul></div>
    </div>
    ${s.offline.length ? `<div class="tv-src-note">No working website or feed was found for ${s.offline.map(o => escapeHtml(o.name)).join(', ')}. Their states are still covered by the per-state searches.</div>` : ''}
    <div class="tv-src-note">Reports are matched to the route by the places their headlines name. They are media leads, not verified incident counts.</div>
  </details>`;
}

// ── Assessment ───────────────────────────────────────────────

function tvDepartHour(){
  const timeVal = (document.getElementById('tvTime').value || '16:30');
  const hour = parseInt(timeVal.split(':')[0], 10);
  return Number.isNaN(hour) ? 16 : hour;
}

// Draw everything for the corridor on screen from what is known right now.
function tvRenderAssessment(refit){
  const corr = tvCurrentCorridor;
  if (!corr) return;
  const departHour = tvDepartHour();
  const risk = tvRouteRisk(corr, departHour);
  const live = tvLiveData();
  const notes = [];
  if (corr.stretch) notes.push('1 high-risk stretch');
  if (live && live.counts.onRoute) notes.push(`${tvPlural(live.counts.onRoute, 'report')} on this road`);
  document.getElementById('tvStretchNote').innerHTML = notes.length ? `<i class="ti ti-alert-triangle"></i> ${notes.join(' · ')}` : '';

  renderTravelRoute(corr, refit);
  renderTravelRating(corr, risk);
  const curve = renderTravelHourChart();
  const dep = renderTravelDepart(corr, risk, curve);
  renderTravelRecs(corr, departHour, dep);
  renderTravelNews();
}

function tvShowMessage(html){
  tvCurrentCorridor = null;
  tvNews = { status: 'idle', key: '', data: null, error: '' };
  if (travelMapGroup) travelMapGroup.clearLayers();
  document.getElementById('tvStretchNote').textContent = '';
  const card = document.getElementById('tvRatingCard');
  card.className = 'panel-card tv-rating-card';
  card.innerHTML = `<div class="tv-empty">${html}</div>`;
  document.getElementById('tvRecs').innerHTML = '<div class="tv-empty">Pick a route to see recommendations.</div>';
  renderTravelNews();
}

function assessRoute(){
  const from = document.getElementById('tvFrom').value;
  const to   = document.getElementById('tvTo').value;
  const titleEl = document.getElementById('tvRouteTitle');

  if (from === to){
    titleEl.textContent = 'select a route';
    tvShowMessage('Origin and destination are the same — pick two different towns.');
    return;
  }
  const corr = tvFindCorridor(from, to);
  if (!corr){
    titleEl.textContent = `${from} → ${to}`;
    tvShowMessage(`No corridor for <strong>${escapeHtml(from)} → ${escapeHtml(to)}</strong> yet.`);
    return;
  }
  const changed = !tvCurrentCorridor || tvNewsKey(tvCurrentCorridor) !== tvNewsKey(corr);
  tvCurrentCorridor = corr;
  titleEl.textContent = `${corr.from} → ${corr.to}`;
  if (changed) tvNews = { status: 'idle', key: '', data: null, error: '' };
  tvRenderAssessment(true);
  tvLoadNews(corr, false);
}

// Destinations reachable from a town, so the two menus can never disagree.
function tvDestinations(from){
  return [...new Set(TV_CORRIDORS.flatMap(c => c.from === from ? [c.to] : c.to === from ? [c.from] : []))].sort();
}

function tvFillDestinations(){
  const fromSel = document.getElementById('tvFrom'), toSel = document.getElementById('tvTo');
  const options = tvDestinations(fromSel.value);
  const keep = options.includes(toSel.value) ? toSel.value : options[0];
  toSel.innerHTML = options.map(t => `<option value="${t}">${t}</option>`).join('');
  toSel.value = keep;
}

function initTravelView(){
  const towns = [...new Set(TV_CORRIDORS.flatMap(c => [c.from, c.to]))].sort();
  const fromSel = document.getElementById('tvFrom'), toSel = document.getElementById('tvTo');
  fromSel.innerHTML = towns.map(t => `<option value="${t}">${t}</option>`).join('');
  fromSel.value = 'Kaduna';
  tvFillDestinations();
  toSel.value = 'Abuja (FCT)';
  fromSel.addEventListener('change', () => { tvFillDestinations(); assessRoute(); });
  toSel.addEventListener('change', assessRoute);
  document.getElementById('tvTime').addEventListener('change', () => { if (tvCurrentCorridor) tvRenderAssessment(); });
  const d = document.getElementById('tvDate'); if (d && !d.value) d.value = new Date().toISOString().slice(0,10);

  travelMap = L.map('travelMap', { center:[9.6,7.5], zoom:7, zoomControl:true, attributionControl:true });
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  L.tileLayer(isLight ? TV_LIGHT_TILE : TV_DARK_TILE, TV_TILE_OPTS).addTo(travelMap);
  travelMapGroup = L.layerGroup().addTo(travelMap);

  // Keep the reports current for as long as the tab stays open on a route.
  tvNewsTimer = setInterval(() => {
    const visible = document.getElementById('travelView').classList.contains('tv-active');
    if (visible && tvCurrentCorridor && tvNews.status !== 'loading') tvLoadNews(tvCurrentCorridor, true);
  }, TV_NEWS_REFRESH_MS);

  setTimeout(() => { travelMap.invalidateSize(); assessRoute(); }, 120);
}
