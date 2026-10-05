/* ═══════════════════════════════════════════════════════════════════════
   TRAVEL SAFETY — predefined intercity corridors, route-risk map, modelled
   incident-timing, and departure/route recommendations.
   Loaded after app.js (shares global scope). Timing is a documented MODEL
   (daylight-safe / dusk-and-night elevated), clearly labelled as an estimate
   — swap for real timestamped data later.
   ═══════════════════════════════════════════════════════════════════════ */
let travelInitialized = false, travelMap = null, travelMapGroup = null, tvHourChart = null;
let tvMode = 'Car', tvCurrentCorridor = null, tvHotspotScores = null;

// Keyless Esri Canvas basemaps (same source the dashboard uses).
const TV_DARK_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const TV_LIGHT_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const TV_TILE_OPTS = { attribution: 'Tiles &copy; Esri &mdash; &copy; OpenStreetMap contributors', maxZoom: 16 };

// Relative incident likelihood by hour of day (0–23). Modelled: lowest mid-day,
// rising through late afternoon, peaking at dusk/evening, elevated overnight.
const TV_HOURLY = [42,38,34,33,36,42, 36,30,26,20,17,16, 18,20,24,34,48,66, 82,95,92,80,66,60];
const TV_SEG_WEIGHT = { low: 12, caution: 55, high: 100 };
const TV_SEG_COLOR  = { low: '#35d08a', caution: '#f5a623', high: '#ff5a5f' };
const TV_MODE_FACTOR = { Car: 1.0, Bus: 0.93, Convoy: 0.82 };
const TV_TOWN_STATE = {
  'Kaduna':'Kaduna','Abuja (FCT)':'FCT (Abuja)','Lokoja':'Kogi','Lagos':'Lagos',
  'Ibadan':'Oyo','Jos':'Plateau','Kano':'Kano','Maiduguri':'Borno','Damaturu':'Yobe'
};

const TV_CORRIDORS = [
  { from:'Kaduna', to:'Abuja (FCT)', road:'A2 corridor', distanceKm:188, estMin:160, checkpoints:7,
    waypoints:[[10.5105,7.4165,'low'],[10.20,7.46,'low'],[9.95,7.52,'caution'],[9.78,7.56,'high'],[9.55,7.52,'high'],[9.30,7.45,'caution'],[9.0765,7.3986,'low']],
    stretch:{name:'Rijana–Katari', kmFrom:42, kmTo:58, at:[9.66,7.55]},
    alt:{name:'western bypass', addMin:35, cut:40, waypoints:[[10.5105,7.4165],[10.35,7.05],[9.95,6.85],[9.5,6.9],[9.2,7.15],[9.0765,7.3986]]} },
  { from:'Abuja (FCT)', to:'Lokoja', road:'A2 south', distanceKm:165, estMin:150, checkpoints:5,
    waypoints:[[9.0765,7.3986,'low'],[8.70,7.10,'caution'],[8.30,6.90,'caution'],[7.95,6.80,'high'],[7.80,6.74,'caution']],
    stretch:{name:'Koton-Karfe belt', kmFrom:95, kmTo:120, at:[8.00,6.82]}, alt:null },
  { from:'Lagos', to:'Ibadan', road:'Lagos–Ibadan expressway', distanceKm:128, estMin:120, checkpoints:6,
    waypoints:[[6.5244,3.3792,'low'],[6.75,3.45,'low'],[6.95,3.60,'caution'],[7.15,3.80,'caution'],[7.3775,3.9470,'low']],
    stretch:{name:'Sagamu–Ogere axis', kmFrom:38, kmTo:60, at:[6.95,3.57]}, alt:null },
  { from:'Abuja (FCT)', to:'Jos', road:'Abuja–Jos road', distanceKm:270, estMin:255, checkpoints:8,
    waypoints:[[9.0765,7.3986,'low'],[9.20,7.90,'caution'],[9.40,8.30,'caution'],[9.55,8.60,'high'],[9.75,8.75,'caution'],[9.8965,8.8583,'low']],
    stretch:{name:'Riyom–Barkin Ladi', kmFrom:200, kmTo:235, at:[9.58,8.62]}, alt:null },
  { from:'Kaduna', to:'Kano', road:'Kaduna–Zaria–Kano (A2)', distanceKm:253, estMin:210, checkpoints:9,
    waypoints:[[10.5105,7.4165,'low'],[10.80,7.55,'caution'],[11.07,7.70,'caution'],[11.50,7.90,'high'],[11.80,8.20,'caution'],[12.00,8.52,'low']],
    stretch:{name:'Zaria–Makarfi fringe', kmFrom:95, kmTo:140, at:[11.48,7.92]}, alt:null },
  { from:'Maiduguri', to:'Damaturu', road:'A3 Maiduguri–Damaturu', distanceKm:135, estMin:130, checkpoints:11,
    waypoints:[[11.8333,13.151,'high'],[11.80,12.80,'high'],[11.78,12.40,'high'],[11.76,12.10,'caution'],[11.7466,11.9608,'caution']],
    stretch:{name:'Benisheikh corridor', kmFrom:45, kmTo:85, at:[11.79,12.50]}, alt:null }
];

function tv12h(h){ const ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return `${hh}:00 ${ap}`; }
function tvShortH(h){ const ap = h >= 12 ? 'p' : 'a'; let hh = h % 12; if (hh === 0) hh = 12; return `${hh}${ap}`; }
function tvHourColor(v){ return v >= 56 ? '#ff5a5f' : v >= 30 ? '#f5a623' : '#35d08a'; }

function tvHotspotScore(townName){
  if (!tvHotspotScores) {
    tvHotspotScores = new Map();
    (computeHotspots() || []).forEach(h => tvHotspotScores.set(h.state, h.composite));
  }
  return tvHotspotScores.get(TV_TOWN_STATE[townName]) || 0;
}

// Find a corridor for from→to in either direction (reversed copy if needed).
function tvFindCorridor(from, to){
  const direct = TV_CORRIDORS.find(c => c.from === from && c.to === to);
  if (direct) return direct;
  const rev = TV_CORRIDORS.find(c => c.from === to && c.to === from);
  if (!rev) return null;
  const c = JSON.parse(JSON.stringify(rev));
  c.from = rev.to; c.to = rev.from;
  c.waypoints = rev.waypoints.slice().reverse();
  if (c.alt) c.alt.waypoints = rev.alt.waypoints.slice().reverse();
  if (c.stretch){ const a = c.distanceKm - rev.stretch.kmTo, b = c.distanceKm - rev.stretch.kmFrom; c.stretch.kmFrom = Math.max(0, a); c.stretch.kmTo = b; }
  return c;
}

function tvRouteRisk(corr, departHour){
  const weights = [];
  for (let i = 0; i < corr.waypoints.length - 1; i++){
    weights.push(Math.max(TV_SEG_WEIGHT[corr.waypoints[i][2]], TV_SEG_WEIGHT[corr.waypoints[i+1][2]]));
  }
  const mean = weights.reduce((a,b)=>a+b,0) / weights.length;
  const segScore = (mean + Math.max(...weights)) / 2;
  const stateScore = (tvHotspotScore(corr.from) + tvHotspotScore(corr.to)) / 2;
  const timeFactor = TV_HOURLY[departHour] / Math.max(...TV_HOURLY);
  let score = 0.6 * segScore + 0.25 * stateScore + 0.15 * timeFactor * 100;
  score *= (TV_MODE_FACTOR[tvMode] || 1);
  score = Math.max(5, Math.min(99, Math.round(score)));
  const highSegs = weights.filter(w => w >= TV_SEG_WEIGHT.high).length;
  return { score, segCount: weights.length, highSegs };
}

function tvRiskBand(score){
  if (score >= 70) return { label:'High Risk', cls:'is-crit' };
  if (score >= 50) return { label:'Elevated',  cls:'is-high' };
  return { label:'Moderate', cls:'is-mod' };
}

function tvWindow(predicate){
  const hrs = []; for (let h = 0; h < 24; h++) if (predicate(TV_HOURLY[h])) hrs.push(h);
  if (!hrs.length) return '—';
  return `${tvShortH(hrs[0])}–${tvShortH(hrs[hrs.length-1])}`;
}

function selectTravelMode(btn){
  tvMode = btn.dataset.mode;
  document.querySelectorAll('#tvModes .tv-mode').forEach(b => b.classList.toggle('active', b === btn));
  if (tvCurrentCorridor) assessRoute();
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

function renderTravelRoute(corr){
  travelMapGroup.clearLayers();
  for (let i = 0; i < corr.waypoints.length - 1; i++){
    const a = corr.waypoints[i], b = corr.waypoints[i+1];
    const risk = TV_SEG_WEIGHT[a[2]] >= TV_SEG_WEIGHT[b[2]] ? a[2] : b[2];
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
  const wp = corr.waypoints;
  L.marker([wp[0][0], wp[0][1]], { icon: tvPinIcon('#2e8fff') }).bindPopup(`<div class="popup-title">${escapeHtml(corr.from)} · start</div>`).addTo(travelMapGroup);
  L.marker([wp[wp.length-1][0], wp[wp.length-1][1]], { icon: tvPinIcon('#35d08a') }).bindPopup(`<div class="popup-title">${escapeHtml(corr.to)} · destination</div>`).addTo(travelMapGroup);
  fitTravelBounds();
}

function renderTravelRating(corr, risk){
  const band = tvRiskBand(risk.score);
  const card = document.getElementById('tvRatingCard');
  card.className = `panel-card tv-rating-card ${band.cls}`;
  card.innerHTML = `
    <div class="tv-rating-top">
      <span class="tv-risk-badge ${band.cls}">${band.label}</span>
      <span class="tv-rating-live">assessed now</span>
    </div>
    <div class="tv-score">${risk.score}<span class="tv-score-max"> /100</span></div>
    <div class="tv-corridor"><i class="ti ti-route"></i> ${escapeHtml(corr.from)} → ${escapeHtml(corr.to)} · ${escapeHtml(corr.road)}</div>
    <div class="tv-metrics">
      <div class="tv-metric"><div class="tv-metric-lbl">Distance</div><div class="tv-metric-val">${corr.distanceKm} km</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">Est. time</div><div class="tv-metric-val">${Math.floor(corr.estMin/60)}h ${corr.estMin%60}m</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">Risk segments</div><div class="tv-metric-val danger">${risk.highSegs} of ${risk.segCount}</div></div>
      <div class="tv-metric"><div class="tv-metric-lbl">Checkpoints</div><div class="tv-metric-val">${corr.checkpoints}</div></div>
    </div>`;
}

function renderTravelHourChart(){
  const canvas = document.getElementById('tvHourChart');
  if (!canvas) return;
  const labels = Array.from({length:24}, (_,h) => [0,6,12,18,23].includes(h) ? (h===23?'11p':tvShortH(h)) : '');
  if (tvHourChart) {
    tvHourChart.data.datasets[0].backgroundColor = TV_HOURLY.map(tvHourColor);
    tvHourChart.update();
  } else {
    tvHourChart = new Chart(canvas, {
      type:'bar',
      data:{ labels, datasets:[{ data: TV_HOURLY, backgroundColor: TV_HOURLY.map(tvHourColor), borderRadius:3, barPercentage:0.85, categoryPercentage:0.9 }] },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title:(it)=>tv12h(it[0].dataIndex), label:(it)=>`Relative risk ${it.raw}` } } },
        scales:{ x:{ grid:{display:false}, ticks:{ color:'#8a94a3', font:{size:9}, autoSkip:false, maxRotation:0 } },
                 y:{ display:false, beginAtZero:true } } }
    });
  }
  document.getElementById('tvSafeWindow').textContent = tvWindow(v => v < 30);
  document.getElementById('tvPeakWindow').textContent = tvWindow(v => v >= 56);
}

function renderTravelDepart(corr){
  let peakStart = TV_HOURLY.findIndex(v => v >= 56); if (peakStart < 0) peakStart = 17;
  const travelH = corr.estMin / 60;
  let leaveBy = Math.floor(peakStart - travelH - 1);
  leaveBy = Math.max(5, Math.min(leaveBy, 20));
  document.getElementById('tvDepartVal').textContent = `Leave before ${tv12h(leaveBy)}`;
  return { peakStart, leaveBy };
}

function renderTravelRecs(corr, departHour, dep){
  const recs = [];
  if (corr.stretch){
    recs.push({ c:'r-red', i:'ti-alert-triangle-filled', html:`<strong>Avoid the ${escapeHtml(corr.stretch.name)} stretch (km ${corr.stretch.kmFrom}–${corr.stretch.kmTo})</strong> — highest ambush risk on this corridor, especially after dark.` });
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

function assessRoute(){
  const from = document.getElementById('tvFrom').value;
  const to   = document.getElementById('tvTo').value;
  const titleEl = document.getElementById('tvRouteTitle');
  const noteEl  = document.getElementById('tvStretchNote');

  if (from === to){
    tvCurrentCorridor = null;
    titleEl.textContent = 'select a route';
    const card = document.getElementById('tvRatingCard');
    card.className = 'panel-card tv-rating-card';
    card.innerHTML = '<div class="tv-empty">Origin and destination are the same — pick two different towns.</div>';
    noteEl.textContent = '';
    return;
  }
  const corr = tvFindCorridor(from, to);
  if (!corr){
    tvCurrentCorridor = null;
    if (travelMapGroup) travelMapGroup.clearLayers();
    titleEl.textContent = `${from} → ${to}`;
    noteEl.textContent = '';
    const card = document.getElementById('tvRatingCard');
    card.className = 'panel-card tv-rating-card';
    card.innerHTML = `<div class="tv-empty">No predefined corridor for <strong>${escapeHtml(from)} → ${escapeHtml(to)}</strong> yet. Corridors currently radiate from Kaduna, Abuja, Lagos, Jos, Kano and Maiduguri.</div>`;
    document.getElementById('tvRecs').innerHTML = '<div class="tv-empty">Pick one of the predefined corridors to see recommendations.</div>';
    return;
  }
  tvCurrentCorridor = corr;
  const timeVal = (document.getElementById('tvTime').value || '16:30');
  const departHour = parseInt(timeVal.split(':')[0], 10) || 16;

  const risk = tvRouteRisk(corr, departHour);
  titleEl.textContent = `${corr.from} → ${corr.to}`;
  noteEl.innerHTML = corr.stretch ? `<i class="ti ti-alert-triangle"></i> 1 high-risk stretch on this route` : '';
  renderTravelRoute(corr);
  renderTravelRating(corr, risk);
  renderTravelHourChart();
  const dep = renderTravelDepart(corr);
  renderTravelRecs(corr, departHour, dep);
}

function initTravelView(){
  const towns = [...new Set(TV_CORRIDORS.flatMap(c => [c.from, c.to]))].sort();
  const fromSel = document.getElementById('tvFrom'), toSel = document.getElementById('tvTo');
  fromSel.innerHTML = towns.map(t => `<option value="${t}">${t}</option>`).join('');
  toSel.innerHTML   = towns.map(t => `<option value="${t}">${t}</option>`).join('');
  fromSel.value = 'Kaduna'; toSel.value = 'Abuja (FCT)';
  fromSel.addEventListener('change', assessRoute);
  toSel.addEventListener('change', assessRoute);
  document.getElementById('tvTime').addEventListener('change', assessRoute);
  const d = document.getElementById('tvDate'); if (d && !d.value) d.value = new Date().toISOString().slice(0,10);

  travelMap = L.map('travelMap', { center:[9.6,7.5], zoom:7, zoomControl:true, attributionControl:true });
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  L.tileLayer(isLight ? TV_LIGHT_TILE : TV_DARK_TILE, TV_TILE_OPTS).addTo(travelMap);
  travelMapGroup = L.layerGroup().addTo(travelMap);

  setTimeout(() => { travelMap.invalidateSize(); assessRoute(); }, 120);
}
