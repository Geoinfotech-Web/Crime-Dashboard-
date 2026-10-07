// ─────────────────────────────────────────────────────────────
//  HOTSPOT ANALYSIS
//
//  The composite risk index is built from two kinds of input:
//    • the incident database (dashboard_data.json) — ACLED deaths and
//      incidents per state, plus the AWSD aid-worker records;
//    • current signals — the live news feed (/api/live-news) and the
//      citizen reports submitted through Live Report (/api/reports).
//
//  It is recalculated every time the live feed refreshes. Shared state
//  (hotspotMapInstance, hotspotInitialized, cachedHotspots) lives in app.js
//  because showView() and applyTheme() read it.
// ─────────────────────────────────────────────────────────────

// Weights when nothing current can be tied to a state: the database alone.
const HS_WEIGHTS_DB = { deaths: 0.45, incidents: 0.30, aid: 0.15, affected: 0.10, live: 0 };
// Weights when live signals are available: they take a tenth of the score.
const HS_WEIGHTS_LIVE = { deaths: 0.40, incidents: 0.25, aid: 0.15, affected: 0.10, live: 0.10 };
const HS_WEIGHT_LABELS = [
  ['deaths', 'Deaths'], ['incidents', 'Incidents'], ['aid', 'Aid incidents'],
  ['affected', 'Affected workers'], ['live', 'Live signals']
];

const HS_LEVELS = [
  { min: 85, key: 'critical', label: 'Critical', color: '#ff5a5f' },
  { min: 75, key: 'severe',   label: 'Severe',   color: '#ff7a45' },
  { min: 60, key: 'high',     label: 'High',     color: '#f5a623' },
  { min: 40, key: 'elevated', label: 'Elevated', color: '#e3b341' },
  { min: 20, key: 'moderate', label: 'Moderate', color: '#4fb8a8' },
  { min: 0,  key: 'low',      label: 'Low',      color: '#35d08a' }
];

// A headline about an attack says more about risk than one about a policy
// statement, so the two do not count the same.
const HS_ARTICLE_WEIGHT = {
  'Kidnapping': 1, 'Shooting/Killing': 1, 'Armed attack': 1,
  'Security operations': 0.5, 'Other': 0.5
};
const HS_REPORT_WEIGHT = { Low: 0.5, Medium: 1, High: 1.5, Critical: 2 };
const HS_REPORT_WINDOW_DAYS = 30;
const HS_NIGERIA_BOUNDS = [[4.2, 2.7], [13.9, 14.7]];

// The density surface runs green (low) through amber to red (critical), the
// same colours the risk levels use everywhere else on the page.
const HS_RAMP = [
  [0, '#35d08a'], [40, '#e3b341'], [60, '#f5a623'], [75, '#ff7a45'], [90, '#ff5a5f'], [100, '#ff5a5f']
];
// Kernel density surface: every state is a Gaussian bump as tall as its score.
// A point takes the tallest bump over it rather than their sum, so a cluster
// of small moderate states never reads hotter than any one of them scores.
const HS_KERNEL_DEG = 0.75;                       // bandwidth, in degrees of latitude
const HS_DENSITY_BOUNDS = [[3.2, 1.7], [14.9, 15.7]];
const HS_DENSITY_WIDTH = 300;                     // grid cells across; height follows
// The kinds of outlet the state news is gathered from.
const HS_MEDIUM = {
  radio: ['ti-radio', 'Radio'], tv: ['ti-device-tv', 'TV'], newspaper: ['ti-news', 'Newspaper'],
  magazine: ['ti-book-2', 'Magazine'], wire: ['ti-building-broadcast-tower', 'News agency'], online: ['ti-world', 'Online']
};
const HS_PANEL_TABS = [
  ['risk', 'ti-chart-bar', 'Risk'], ['actors', 'ti-users', 'Actors'], ['trend', 'ti-chart-line', 'Trend'],
  ['live', 'ti-broadcast', 'Live signals'], ['ranking', 'ti-list-numbers', 'Ranking']
];

const HS_ZONES = {
  'North-East': ['Adamawa', 'Bauchi', 'Borno', 'Gombe', 'Taraba', 'Yobe'],
  'North-West': ['Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Sokoto', 'Zamfara'],
  'North-Central': ['Benue', 'FCT (Abuja)', 'Kogi', 'Kwara', 'Nasarawa', 'Niger', 'Plateau'],
  'South-West': ['Ekiti', 'Lagos', 'Ogun', 'Ondo', 'Osun', 'Oyo'],
  'South-East': ['Abia', 'Anambra', 'Ebonyi', 'Enugu', 'Imo'],
  'South-South': ['Akwa Ibom', 'Bayelsa', 'Cross River', 'Delta', 'Edo', 'Rivers']
};
const HS_LIVE_PAGE = 5;

const HS_ACTORS = [
  ['nsag', 'Non-state armed'], ['criminal', 'Criminal / bandit'],
  ['state', 'State / other'], ['unknown', 'Unknown']
];

const hsState = {
  geo: null,            // state boundaries, once loaded
  reports: [],          // citizen reports, each resolved to a state where possible
  reportsLoaded: false,
  signature: '',        // fingerprint of the inputs behind the current render
  updatedAt: null,      // when the index was last recalculated
  live: null,           // summary of the live signals used
  layers: null,
  tiles: null,          // basemap + label layers, and the theme they were built for
  stampTimer: null,
  liveSel: null,        // live-signals picker: a state name, 'all' or 'national'
  livePage: 0,
  liveQuery: '',
  rankMode: 'level',    // ranking grouped by 'level' or 'zone'
  rankOpen: null,       // names of the expanded ranking groups
  rankQuery: '',
  panelTab: 'risk',     // tab showing in the panel beside the map
  lastTab: 'risk',      // where to go back to when a state is closed
  stateNews: new Map(), // state → { status, data, error }: local and regional reports
  openState: null,      // state shown in the panel beside the map
  stateTab: 'news'
};

function hsLevel(score) {
  return HS_LEVELS.find(level => score >= level.min) || HS_LEVELS[HS_LEVELS.length - 1];
}
// Kept under their old names: other views colour things by hotspot score.
function hsColor(score) { return hsLevel(score).color; }
function hsLabel(score) { return hsLevel(score).label; }

function hsShortName(stateName) {
  return stateName === 'FCT (Abuja)' ? 'Abuja' : stateName;
}

function hsZoneOf(stateName) {
  return Object.keys(HS_ZONES).find(zone => HS_ZONES[zone].includes(stateName)) || 'Unassigned';
}

function hsRampRgb(score) {
  const value = Math.max(0, Math.min(100, score));
  const channels = hex => [0, 1, 2].map(i => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16));
  const upper = HS_RAMP.findIndex(([stop]) => stop >= value);
  if (upper <= 0) return channels(HS_RAMP[0][1]);
  const [fromStop, fromHex] = HS_RAMP[upper - 1];
  const [toStop, toHex] = HS_RAMP[upper];
  const ratio = (value - fromStop) / (toStop - fromStop);
  const from = channels(fromHex), to = channels(toHex);
  return from.map((channel, i) => Math.round(channel + (to[i] - channel) * ratio));
}

function hsRampColor(score) {
  return `rgb(${hsRampRgb(score).join(',')})`;
}

function hsIsLight() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

// ── Inputs ───────────────────────────────────────────────────

function hsGeoStateName(feature) {
  const name = feature.properties?.shapeName || '';
  if (name === 'Abuja Federal Capital Territory') return 'FCT (Abuja)';
  return stateData.some(s => s.state === name) ? name : null;
}

async function hsLoadGeo() {
  if (hsState.geo) return hsState.geo;
  const response = await fetch('vendor/nigeria-states.geojson');
  if (!response.ok) throw new Error(`State boundaries: ${response.status}`);
  hsState.geo = await response.json();
  return hsState.geo;
}

function hsPointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function hsStateAtPoint(lat, lng) {
  if (!hsState.geo) return null;
  for (const feature of hsState.geo.features) {
    const geometry = feature.geometry;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const hit = polygons.some(rings =>
      hsPointInRing(lng, lat, rings[0]) && !rings.slice(1).some(hole => hsPointInRing(lng, lat, hole)));
    if (hit) return hsGeoStateName(feature);
  }
  return null;
}

async function hsLoadReports() {
  try {
    const response = await fetch('/api/reports', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Reports: ${response.status}`);
    const data = await response.json();
    const cutoff = Date.now() - HS_REPORT_WINDOW_DAYS * 86400000;
    hsState.reports = (data.reports || []).filter(report => {
      const received = Date.parse(report.receivedAt);
      return Number.isNaN(received) || received >= cutoff;
    });
    hsState.reportsLoaded = true;
  } catch (error) {
    // The static file server has no reports endpoint; the index still works.
    hsState.reports = [];
    hsState.reportsLoaded = false;
  }
}

function hsClassifyActor(text) {
  const t = String(text || '').toLowerCase();
  if (/boko haram|iswap|insurgen|terror|jihadist|non-state armed/.test(t)) return 'nsag';
  if (/bandit|kidnap|abduct|gunm[ae]n|robber|cult|criminal/.test(t)) return 'criminal';
  if (/host state|paramilitary|staff/.test(t)) return 'state';
  return 'unknown';
}

// Everything current that can be tied to a state, keyed by state name.
function hsCollectLiveSignals() {
  const byState = new Map();
  const entry = stateName => {
    if (!byState.has(stateName)) {
      byState.set(stateName, { weight: 0, articles: [], reports: [], actors: {} });
    }
    return byState.get(stateName);
  };

  let mappedArticles = 0;
  liveArticles.forEach(article => {
    const states = statesForArticle(article);
    if (!states.length) return;
    mappedArticles++;
    const attack = classifyLiveAttack(article);
    const actor = hsClassifyActor(`${article.title} ${(article.matchedKeywords || []).join(' ')}`);
    states.forEach(state => {
      const item = entry(state.state);
      item.weight += HS_ARTICLE_WEIGHT[attack] ?? 0.5;
      item.articles.push({ ...article, attack });
      item.actors[actor] = (item.actors[actor] || 0) + 1;
    });
  });

  let mappedReports = 0;
  hsState.reports.forEach(report => {
    const { lat, lon } = report.location || {};
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const stateName = hsStateAtPoint(lat, lon);
    if (!stateName) return;
    mappedReports++;
    const item = entry(stateName);
    item.weight += HS_REPORT_WEIGHT[report.severity] ?? 1;
    item.reports.push(report);
  });

  return {
    byState,
    articles: liveArticles.length,
    mappedArticles,
    reports: hsState.reports.length,
    mappedReports
  };
}

// ── The index ────────────────────────────────────────────────

function computeHotspots() {
  const awsdByState = new Map();
  awsdData.forEach(record => {
    const stateName = hsRegionToState(record.region);
    if (!stateName) return;
    if (!awsdByState.has(stateName)) awsdByState.set(stateName, { count: 0, affected: 0, records: [] });
    const item = awsdByState.get(stateName);
    item.count++;
    item.affected += record.affected;
    item.records.push(record);
  });

  const live = hsCollectLiveSignals();
  hsState.live = live;
  const liveWeightOf = s => live.byState.get(s.state)?.weight || 0;

  const max = {
    deaths:    Math.max(...stateData.map(s => s.deaths), 1),
    incidents: Math.max(...stateData.map(s => s.incidents), 1),
    aid:       Math.max(...stateData.map(s => awsdByState.get(s.state)?.count || 0), 1),
    affected:  Math.max(...stateData.map(s => awsdByState.get(s.state)?.affected || 0), 1),
    live:      Math.max(...stateData.map(liveWeightOf), 0)
  };
  const weights = max.live > 0 ? HS_WEIGHTS_LIVE : HS_WEIGHTS_DB;
  hsState.weights = weights;

  const rows = stateData.map(s => {
    const awsd = awsdByState.get(s.state) || { count: 0, affected: 0, records: [] };
    const signals = live.byState.get(s.state) || { weight: 0, articles: [], reports: [], actors: {} };
    const parts = {
      deaths:    s.deaths / max.deaths,
      incidents: s.incidents / max.incidents,
      aid:       awsd.count / max.aid,
      affected:  awsd.affected / max.affected,
      live:      max.live > 0 ? signals.weight / max.live : 0
    };
    const raw = key => Object.keys(key).reduce((sum, k) => sum + parts[k] * key[k], 0);

    const actors = { ...signals.actors };
    awsd.records.forEach(record => {
      const actor = hsClassifyActor(record.actor);
      actors[actor] = (actors[actor] || 0) + 1;
    });

    return {
      ...s,
      awsdCount: awsd.count,
      awsdAffected: awsd.affected,
      awsdRecords: awsd.records,
      liveArticles: signals.articles,
      liveReports: signals.reports,
      liveCount: signals.articles.length + signals.reports.length,
      actors,
      parts,
      rawScore: raw(weights),
      rawBaseline: raw(HS_WEIGHTS_DB)
    };
  });

  // Scores are relative: the highest-risk state is 100.
  const topRaw = Math.max(...rows.map(r => r.rawScore), 1e-9);
  const topBaseline = Math.max(...rows.map(r => r.rawBaseline), 1e-9);
  rows.forEach(row => {
    row.composite = Math.round((row.rawScore / topRaw) * 100);
    row.baseline = Math.round((row.rawBaseline / topBaseline) * 100);
    // Points each input adds to the composite; they sum to the score.
    row.points = Object.fromEntries(Object.keys(weights).map(key =>
      [key, (row.parts[key] * weights[key] / topRaw) * 100]));
    row.zone = hsZoneOf(row.state);
  });

  const baselineOrder = [...rows].sort((a, b) => b.rawBaseline - a.rawBaseline).map(r => r.state);
  rows.sort((a, b) => b.rawScore - a.rawScore);
  rows.forEach((row, index) => {
    row.rank = index + 1;
    // Positive = moved up the ranking because of what is being reported now.
    row.rankShift = (baselineOrder.indexOf(row.state) + 1) - row.rank;
  });
  return rows;
}

function hsInputSignature() {
  return [
    liveArticles.map(article => article.url).join('|'),
    hsState.reports.map(report => report.id).join('|'),
    hsState.geo ? 'geo' : 'nogeo'
  ].join('#');
}

// ── Lifecycle ────────────────────────────────────────────────

function initHotspotView() {
  hsRecalculate(true);
  Promise.allSettled([hsLoadGeo(), hsLoadReports()]).then(() => hsRecalculate(true));
  if (!hsState.stampTimer) hsState.stampTimer = setInterval(hsRenderStamp, 30000);
}

// Called by app.js each time the live feed has been re-read.
function onHotspotLiveUpdate() {
  if (!hotspotInitialized) return;
  hsLoadReports().then(() => hsRecalculate(false));
}

function hsRecalculate(force) {
  const signature = hsInputSignature();
  hsState.updatedAt = Date.now();
  hsRenderStamp();
  // Same inputs give the same index: leave the page, and any open popup, alone.
  if (!force && signature === hsState.signature) return;
  hsState.signature = signature;

  cachedHotspots = computeHotspots();
  renderHsFormula();
  renderHsKPIs(cachedHotspots);
  renderHsMap(cachedHotspots);
  renderHsCharts(cachedHotspots);
  renderHsLive(cachedHotspots);
  renderHsTable(cachedHotspots);
  renderHsPanelTabs();
  if (hsState.openState) hsRenderStatePanel();
}

// Theme changes only affect what is drawn on canvas; the rest is CSS.
function refreshHotspotTheme() {
  if (!hotspotInitialized || !cachedHotspots) return;
  renderHsMap(cachedHotspots);
  renderHsTrendChart(cachedHotspots);
  if (hsState.openState) hsRenderStatePanel();
}

// ── Formula bar ──────────────────────────────────────────────

function hsRenderStamp() {
  const el = document.getElementById('hsUpdated');
  if (!el || !hsState.updatedAt) return;
  const minutes = Math.floor((Date.now() - hsState.updatedAt) / 60000);
  el.textContent = `Risk index updated ${minutes < 1 ? 'just now' : `${minutes} min ago`}`;
}

function renderHsFormula() {
  const weights = hsState.weights || HS_WEIGHTS_DB;
  const chips = HS_WEIGHT_LABELS
    .filter(([key]) => weights[key] > 0)
    .map(([key, label]) =>
      `<span class="hs-chip${key === 'live' ? ' hs-chip-live' : ''}">${label} ${Math.round(weights[key] * 100)}%</span>`)
    .join('<span class="hs-plus">+</span>');
  document.getElementById('hsFormula').innerHTML = chips;

  const live = hsState.live;
  const note = document.getElementById('hsFormulaNote');
  if (weights.live > 0) {
    note.textContent = 'Database + live signals';
    note.className = 'hs-formula-note is-live';
  } else {
    note.textContent = live && live.articles
      ? 'Database only — no current report names a state'
      : 'Database only — live feed has no reports yet';
    note.className = 'hs-formula-note';
  }
}

// ── Top five ─────────────────────────────────────────────────

function hsLiveLine(state) {
  if (!state.liveCount) return '<span class="hs-live-none">No live signals</span>';
  const parts = [];
  if (state.liveArticles.length) parts.push(`${state.liveArticles.length} news`);
  if (state.liveReports.length) parts.push(`${state.liveReports.length} citizen`);
  return `<span class="hs-live-on"><span class="hs-live-dot"></span>${parts.join(' · ')} · live</span>`;
}

function renderHsKPIs(hotspots) {
  document.getElementById('hsTopStates').innerHTML = hotspots.slice(0, 5).map(s => {
    const level = hsLevel(s.composite);
    return `<button type="button" class="hs-kpi-card hs-lv-${level.key}" onclick="hsOpenState('${escapeHtml(s.state)}')">
      <div class="hs-kpi-rank">#${s.rank} &middot; ${level.label}</div>
      <div class="hs-kpi-state">${escapeHtml(s.state)}</div>
      <div class="hs-kpi-score">${s.composite}<span class="hs-kpi-max">/100</span></div>
      <div class="hs-kpi-track"><div class="hs-kpi-fill" style="width:${s.composite}%"></div></div>
      <div class="hs-kpi-detail">
        <span>Deaths <strong>${s.deaths.toLocaleString()}</strong></span>
        <span>Inc <strong>${s.incidents.toLocaleString()}</strong></span>
      </div>
      <div class="hs-kpi-live">${hsLiveLine(s)}</div>
    </button>`;
  }).join('');
}

// ── Map ──────────────────────────────────────────────────────

// States are outlines only: the colour comes from the density surface below.
function hsMapStyle(s, selected) {
  const light = hsIsLight();
  if (!s) return { color: 'transparent', weight: 0, fillOpacity: 0 };
  return {
    color: selected ? (light ? '#0d2647' : '#ffffff') : (light ? 'rgba(13,38,71,0.3)' : 'rgba(255,255,255,0.2)'),
    weight: selected ? 2.5 : 0.8,
    fillColor: light ? '#0d2647' : '#ffffff',
    fillOpacity: selected ? 0.1 : 0
  };
}

// Kernel density surface of risk, drawn once as an image and stretched over
// the map: each cell takes the tallest state bump at that point.
function hsDensityImage(hotspots) {
  const [[south, west], [north, east]] = HS_DENSITY_BOUNDS;
  const width = HS_DENSITY_WIDTH;
  const height = Math.round(width * (north - south) / (east - west));
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  const pixels = surface.getContext('2d').createImageData(width, height);
  const spread = 2 * HS_KERNEL_DEG * HS_KERNEL_DEG;
  for (let y = 0; y < height; y++) {
    const lat = north - (y + 0.5) / height * (north - south);
    const squeeze = Math.cos(lat * Math.PI / 180);
    for (let x = 0; x < width; x++) {
      const lng = west + (x + 0.5) / width * (east - west);
      let density = 0;
      for (const s of hotspots) {
        const dLat = lat - s.lat, dLng = (lng - s.lng) * squeeze;
        density = Math.max(density, s.composite * Math.exp(-(dLat * dLat + dLng * dLng) / spread));
      }
      const [r, g, b] = hsRampRgb(density);
      const at = (y * width + x) * 4;
      pixels.data[at] = r; pixels.data[at + 1] = g; pixels.data[at + 2] = b;
      // Faint where there is little risk, solid where it piles up.
      pixels.data[at + 3] = Math.round(Math.min(1, Math.max(0, (density - 3) / 45)) ** 0.8 * 215);
    }
  }
  surface.getContext('2d').putImageData(pixels, 0, 0);
  if (!hsState.geo) return surface.toDataURL();

  // Keep the surface inside Nigeria.
  const clipped = document.createElement('canvas');
  clipped.width = width;
  clipped.height = height;
  const ctx = clipped.getContext('2d');
  ctx.beginPath();
  hsState.geo.features.forEach(feature => {
    const geometry = feature.geometry;
    (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).forEach(rings => {
      rings[0].forEach(([lng, lat], i) => {
        const x = (lng - west) / (east - west) * width, y = (north - lat) / (north - south) * height;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
    });
  });
  ctx.clip();
  ctx.drawImage(surface, 0, 0);
  return clipped.toDataURL();
}

function hsTooltipHtml(s) {
  const level = hsLevel(s.composite);
  return `<div class="hs-tip-name">${escapeHtml(s.state)}</div>
    <div class="hs-tip-row"><span class="hs-tip-swatch" style="background:${hsRampColor(s.composite)}"></span>${s.composite}/100 &middot; ${level.label} &middot; #${s.rank}</div>
    <div class="hs-tip-hint">Click to load its analysis</div>`;
}

// Same keyless Esri canvas the dashboard and Travel Safety use, with the
// place-name layer drawn above the risk shading so towns stay readable.
function hsSyncBasemap(map) {
  const theme = hsIsLight() ? 'light' : 'dark';
  if (hsState.tiles?.theme === theme) return;
  if (hsState.tiles) { hsState.tiles.base.remove(); hsState.tiles.labels.remove(); }
  const labelsUrl = (theme === 'light' ? LIGHT_TILE : DARK_TILE).replace('_Base/', '_Reference/');
  hsState.tiles = {
    theme,
    base: L.tileLayer(theme === 'light' ? LIGHT_TILE : DARK_TILE, TILE_OPTS).addTo(map),
    labels: L.tileLayer(labelsUrl, { maxZoom: 16, pane: 'hsLabels' }).addTo(map)
  };
}

function renderHsMap(hotspots) {
  const firstDraw = !hotspotMapInstance;
  if (firstDraw) {
    hotspotMapInstance = L.map('hotspotMap', {
      zoomControl: true, attributionControl: true,
      zoomSnap: 0.25, minZoom: 5, maxZoom: 12
    }).setView([9.05, 8.7], 6);
    const labels = hotspotMapInstance.createPane('hsLabels');
    labels.style.zIndex = 450;
    labels.style.pointerEvents = 'none';
    const density = hotspotMapInstance.createPane('hsDensity');
    density.style.zIndex = 350;                   // above the basemap, below the state outlines
    density.style.pointerEvents = 'none';
    document.getElementById('hsLegendBar').style.background =
      `linear-gradient(90deg,${HS_RAMP.map(([stop, hex]) => `${hex} ${stop}%`).join(',')})`;
  }
  const map = hotspotMapInstance;
  hsSyncBasemap(map);
  if (hsState.layers) hsState.layers.remove();
  hsState.layers = L.layerGroup().addTo(map);
  hsState.polygons = new Map();

  const byName = new Map(hotspots.map(s => [s.state, s]));
  const openProfile = s => () => hsOpenState(s.state);

  L.imageOverlay(hsDensityImage(hotspots), HS_DENSITY_BOUNDS, { pane: 'hsDensity', opacity: 0.9, className: 'hs-density' })
    .addTo(hsState.layers);
  hotspots.slice(0, 6).forEach(s => {
    L.marker([s.lat, s.lng], {
      interactive: false, pane: 'hsLabels',
      icon: L.divIcon({
        className: 'hs-map-label-anchor', iconSize: [0, 0],
        html: `<span class="hs-map-label">${escapeHtml(hsShortName(s.state))} &middot; ${s.composite}</span>`
      })
    }).addTo(hsState.layers);
  });

  if (hsState.geo) {
    L.geoJSON(hsState.geo, {
      style: feature => {
        const s = byName.get(hsGeoStateName(feature));
        return hsMapStyle(s, s && s.state === hsState.openState);
      },
      onEachFeature: (feature, layer) => {
        const s = byName.get(hsGeoStateName(feature));
        if (!s) return;
        hsState.polygons.set(s.state, layer);
        layer.bindTooltip(hsTooltipHtml(s), { sticky: true, direction: 'top', offset: [0, -6], className: 'hs-tip' });
        layer.on({
          mouseover: e => {
            if (s.state === hsState.openState) return;
            e.target.setStyle({ weight: 2, color: hsIsLight() ? '#0d2647' : '#ffffff', fillOpacity: 0.07 });
            e.target.bringToFront();
          },
          mouseout: e => e.target.setStyle(hsMapStyle(s, s.state === hsState.openState)),
          click: openProfile(s)
        });
      }
    }).addTo(hsState.layers);
  } else {
    // Boundaries still loading (or unavailable): a marker per state stands in.
    hotspots.forEach(s => {
      L.circleMarker([s.lat, s.lng], {
        radius: 7 + s.composite / 9, color: hsIsLight() ? '#ffffff' : '#0b1420', weight: 1,
        fillColor: hsRampColor(s.composite), fillOpacity: 0.85
      }).bindTooltip(hsTooltipHtml(s), { direction: 'top', className: 'hs-tip' })
        .on('click', openProfile(s)).addTo(hsState.layers);
    });
  }

  // The panel has no size until the view is on screen, so frame Nigeria only
  // once it does — and only the first time, so a refresh never moves the map.
  setTimeout(() => {
    map.invalidateSize();
    if (firstDraw) map.fitBounds(HS_NIGERIA_BOUNDS, { padding: [10, 10], animate: false });
  }, 150);
}

function hsHighlightState(stateName) {
  const previous = hsState.openState;
  hsState.openState = stateName;
  const byName = new Map((cachedHotspots || []).map(s => [s.state, s]));
  [previous, stateName].forEach(name => {
    const polygon = name && hsState.polygons?.get(name);
    if (!polygon) return;
    polygon.setStyle(hsMapStyle(byName.get(name), name === stateName));
    if (name === stateName) polygon.bringToFront();
  });
}

function hsLocateState(stateName) {
  const polygon = hsState.polygons?.get(stateName);
  const s = (cachedHotspots || []).find(row => row.state === stateName);
  if (!s || !hotspotMapInstance) return;
  if (polygon) hotspotMapInstance.flyToBounds(polygon.getBounds(), { padding: [40, 40], duration: 0.8 });
  else hotspotMapInstance.flyTo([s.lat, s.lng], 8, { duration: 0.8 });
}

// ── Right-hand analysis ──────────────────────────────────────

function renderHsCharts(hotspots) {
  // ① Composite risk — top 10
  document.getElementById('hsRiskBars').innerHTML = hotspots.slice(0, 10).map(s => `
    <div class="hs-bar-row" onclick="hsOpenState('${escapeHtml(s.state)}')">
      <span class="hs-bar-name">${escapeHtml(hsShortName(s.state))}</span>
      <span class="hs-bar-track"><span class="hs-bar-fill" style="width:${s.composite}%"></span></span>
      <span class="hs-bar-val">${s.composite}</span>
    </div>`).join('');

  // How the 37 states split across the levels; a chip opens that group in the ranking.
  document.getElementById('hsLevelStrip').innerHTML = HS_LEVELS.map(level => {
    const count = hotspots.filter(s => hsLevel(s.composite) === level).length;
    return `<button type="button" class="hs-level-chip hs-lv-${level.key}" ${count ? '' : 'disabled'} onclick="hsShowRankGroup('${level.label}')">
      <strong>${count}</strong><span>${level.label}</span></button>`;
  }).join('');

  // ② Who is behind it — top 10, from AWSD records and current headlines
  document.getElementById('hsActorBars').innerHTML = hotspots.slice(0, 10).map(s => {
    const total = HS_ACTORS.reduce((sum, [key]) => sum + (s.actors[key] || 0), 0);
    const segments = total
      ? HS_ACTORS.filter(([key]) => s.actors[key]).map(([key, label]) =>
          `<span class="hs-actor-seg hs-actor-${key}" style="flex:${s.actors[key]}" title="${label}: ${s.actors[key]} of ${total}"></span>`).join('')
      : '<span class="hs-actor-empty">No attributed records</span>';
    return `<div class="hs-bar-row hs-actor-row">
      <span class="hs-bar-name">${escapeHtml(hsShortName(s.state))}</span>
      <span class="hs-actor-track">${segments}</span>
      <span class="hs-bar-val">${total || ''}</span>
    </div>`;
  }).join('');
  document.getElementById('hsActorLegend').innerHTML = HS_ACTORS.map(([key, label]) =>
    `<span><i class="hs-actor-${key}"></i>${label}</span>`).join('');

  renderHsTrendChart(hotspots);
}

// ③ Aid-worker incidents by year — top 3
function renderHsTrendChart(hotspots) {
  if (hsState.panelTab !== 'trend') return;       // drawn when its tab is opened
  const { tc, gc } = getChartThemeColors();
  const years = [...new Set(awsdData.map(r => r.year))].sort((a, b) => a - b);
  const palette = ['#ff5a5f', '#f5a623', '#2e8fff'];
  const existing = Chart.getChart('hsTrendChart');
  if (existing) existing.destroy();
  new Chart(document.getElementById('hsTrendChart'), {
    type: 'line',
    data: {
      labels: years,
      datasets: hotspots.slice(0, 3).map((s, i) => {
        const perYear = new Map();
        s.awsdRecords.forEach(r => perYear.set(r.year, (perYear.get(r.year) || 0) + 1));
        return {
          label: hsShortName(s.state),
          data: years.map(y => perYear.get(y) || 0),
          borderColor: palette[i], backgroundColor: palette[i] + '1f',
          borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 4
        };
      })
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { color: tc, font: { size: 10 }, boxWidth: 10, boxHeight: 10, padding: 10 } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: tc, font: { size: 10 }, maxTicksLimit: 7 } },
        y: { beginAtZero: true, grid: { color: gc }, ticks: { color: tc, font: { size: 10 }, precision: 0 } }
      }
    }
  });
}

// ── State, local-government and community news ──────────────
// Gathered per state, on demand, from the outlets in regional_sources.json
// (radio, newspapers, magazines, TV, news agencies) plus searches for the
// state, its local governments and its towns — see route_news.py.

function hsStateNewsEntry(stateName) {
  return hsState.stateNews.get(stateName) || { status: 'idle', data: null, error: '' };
}

async function hsLoadStateNews(stateName, force) {
  const entry = hsStateNewsEntry(stateName);
  if (entry.status === 'loading' || (!force && entry.status === 'ready')) return;
  hsState.stateNews.set(stateName, { status: 'loading', data: entry.data, error: '' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const params = new URLSearchParams({ states: stateName, local: '1' });
    const response = await fetch(`/api/route-news?${params}`, { cache: 'no-store', signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}`);
    hsState.stateNews.set(stateName, { status: 'ready', data, error: '' });
  } catch (error) {
    hsState.stateNews.set(stateName, { status: 'error', data: null,
      error: error.name === 'AbortError' ? 'The news sources took too long to answer.' : error.message });
  } finally {
    clearTimeout(timeout);
  }
  if (hsState.openState === stateName) hsRenderStatePanel();
  if (hsState.panelTab === 'live') renderHsLive(cachedHotspots);
}

function hsAgo(hours) {
  if (hours == null) return 'undated';
  if (hours < 1) return 'under an hour ago';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function hsMediaIcons(media) {
  return (media || []).filter(key => HS_MEDIUM[key]).map(key =>
    `<i class="ti ${HS_MEDIUM[key][0]}" title="${HS_MEDIUM[key][1]}"></i>`).join('');
}

function hsLocalItemHtml(event) {
  const places = event.places.map(place => `<span class="hs-live-attack hs-live-place"><i class="ti ti-map-pin"></i> ${escapeHtml(place)}</span>`).join('');
  const more = event.sourceCount > 1 ? ` &middot; +${event.sourceCount - 1} more outlet${event.sourceCount === 2 ? '' : 's'}` : '';
  return `<a class="hs-live-item" href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer">
    <div class="hs-live-tags"><span class="hs-live-attack hs-cat-${escapeHtml(event.category)}">${escapeHtml(event.categoryLabel)}</span>${places}
      ${event.regionalSources.length ? '<span class="hs-live-attack hs-live-regional">Local outlet</span>' : ''}</div>
    <div class="hs-live-title">${escapeHtml(event.title)}</div>
    <div class="hs-live-meta"><span class="hs-media">${hsMediaIcons(event.media)}</span> ${escapeHtml(event.source)}${more} &middot; ${hsAgo(event.ageHours)} <i class="ti ti-external-link"></i></div>
  </a>`;
}

// One line saying where a state's news came from, or that it is on its way.
function hsStateNewsNote(stateName) {
  const entry = hsStateNewsEntry(stateName);
  if (entry.data) {
    const sources = entry.data.sources;
    const kinds = Object.entries(sources.byMedium || {}).sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${count} ${(HS_MEDIUM[key]?.[1] || key).toLowerCase()}`).join(' · ');
    return `<div class="hs-news-note"><i class="ti ti-rss"></i> Last ${entry.data.windowDays} days · ${sources.answered} of ${sources.checked} sources answered${kinds ? ` (${kinds})` : ''} · ${sources.regionalAnswered} local to ${escapeHtml(stateName)}
      <button type="button" class="tv-inline-btn" onclick="hsLoadStateNews('${escapeHtml(stateName)}', true)">Refresh</button></div>`;
  }
  if (entry.status === 'error') {
    return `<div class="hs-news-note is-warn"><i class="ti ti-alert-triangle"></i> Local sources could not be read: ${escapeHtml(entry.error)} Showing the last 24 hours from the national feed.
      <button type="button" class="tv-inline-btn" onclick="hsLoadStateNews('${escapeHtml(stateName)}', true)">Try again</button></div>`;
  }
  return '<div class="hs-news-note"><i class="ti ti-loader-2 tv-spin"></i> Reading state, local-government and community sources… showing the last 24 hours meanwhile.</div>';
}

// ── Live signals ─────────────────────────────────────────────

// Reports for one row of the picker, newest first. Citizen reports and news
// share a shape so one list can show both.
function hsLiveItems(hotspots, selection) {
  const byUrl = new Map();
  hotspots.forEach(s => s.liveArticles.forEach(article => {
    if (!byUrl.has(article.url)) byUrl.set(article.url, { kind: 'news', article, states: [] });
    byUrl.get(article.url).states.push(s);
  }));
  const citizen = hotspots.flatMap(s => s.liveReports.map(report => ({ kind: 'citizen', report, states: [s] })));

  let items;
  if (selection === 'national') {
    items = liveArticles.filter(article => !byUrl.has(article.url))
      .map(article => ({ kind: 'news', article: { ...article, attack: classifyLiveAttack(article) }, states: [] }));
  } else {
    items = [...byUrl.values(), ...citizen];
    if (selection !== 'all') items = items.filter(item => item.states.some(s => s.state === selection));
  }
  const when = item => Date.parse(item.kind === 'news' ? item.article.seenDate : item.report.receivedAt) || 0;
  return items.sort((a, b) => when(b) - when(a));
}

function hsLiveItemHtml(item, showStates) {
  const tags = showStates ? item.states.map(s =>
    `<span class="hs-live-state hs-lv-${hsLevel(s.composite).key}">${escapeHtml(hsShortName(s.state))} &middot; ${s.composite}</span>`).join('') : '';
  if (item.kind === 'local') return hsLocalItemHtml(item.event);
  if (item.kind === 'citizen') {
    const report = item.report;
    return `<div class="hs-live-item">
      <div class="hs-live-tags">${tags}<span class="hs-live-attack hs-live-citizen"><i class="ti ti-user-exclamation"></i> Citizen report</span>
        <span class="hs-live-attack">${escapeHtml(report.category || 'Other')} &middot; ${escapeHtml(report.severity || 'Unknown')}</span></div>
      <div class="hs-live-title">${escapeHtml(report.message || 'No description given')}</div>
      <div class="hs-live-meta">Submitted through Live Report &middot; ${escapeHtml(formatNewsDate(report.receivedAt))}</div>
    </div>`;
  }
  const article = item.article;
  return `<a class="hs-live-item" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">
    <div class="hs-live-tags">${tags}<span class="hs-live-attack">${escapeHtml(article.attack)}</span></div>
    <div class="hs-live-title">${escapeHtml(article.title)}</div>
    <div class="hs-live-meta">${escapeHtml(article.domain)} &middot; ${escapeHtml(formatNewsDate(article.seenDate))} <i class="ti ti-external-link"></i></div>
  </a>`;
}

function hsPagerHtml(page, pages, total, handler) {
  if (pages <= 1) return total ? `<span class="hs-pager-info">${total} report${total === 1 ? '' : 's'}</span>` : '';
  return `<span class="hs-pager-info">Page ${page + 1} of ${pages} &middot; ${total} reports</span>
    <span class="hs-pager-btns">
      <button type="button" class="hs-tool-btn" ${page === 0 ? 'disabled' : ''} onclick="${handler}(${page - 1})"><i class="ti ti-chevron-left"></i> Newer</button>
      <button type="button" class="hs-tool-btn" ${page >= pages - 1 ? 'disabled' : ''} onclick="${handler}(${page + 1})">Older <i class="ti ti-chevron-right"></i></button>
    </span>`;
}

function renderHsLive(hotspots) {
  const live = hsState.live;
  const mode = typeof liveFeedMode === 'string' ? liveFeedMode : 'connecting';
  const modeLabel = { live: 'Live', cached: 'Cached snapshot', connecting: 'Connecting' }[mode] || 'Offline';
  const reportsText = hsState.reportsLoaded
    ? `${live.reports} citizen report${live.reports === 1 ? '' : 's'} in ${HS_REPORT_WINDOW_DAYS} days (${live.mappedReports} located)`
    : 'citizen reports unavailable';
  document.getElementById('hsLiveSummary').innerHTML =
    `<span class="hs-live-mode is-${mode}"><span class="hs-live-dot"></span>${modeLabel}</span>
     ${live.articles} news report${live.articles === 1 ? '' : 's'} in the last 24h &middot; ${live.mappedArticles} tied to a state &middot; ${reportsText}`;

  const withSignals = hotspots.filter(s => s.liveCount).sort((a, b) => b.liveCount - a.liveCount || a.rank - b.rank);
  const valid = ['all', 'national', ...hotspots.map(s => s.state)];
  // Until a row is picked, follow the state with the most current reports.
  const selection = valid.includes(hsState.liveSel) ? hsState.liveSel : (withSignals[0]?.state || 'all');

  // Picker: states with something current first, then the rest by rank.
  const query = hsState.liveQuery.trim().toLowerCase();
  const states = [...withSignals, ...hotspots.filter(s => !s.liveCount)]
    .filter(s => !query || s.state.toLowerCase().includes(query));
  const unlocated = live.articles - live.mappedArticles;
  const pickRow = (key, name, sub, news, citizen, levelKey) => `
    <tr class="${levelKey ? `hs-lv-${levelKey}` : ''}${selection === key ? ' is-selected' : ''}${news + citizen ? '' : ' is-quiet'}"
        onclick="hsSelectLive('${escapeHtml(key)}')">
      <td><span class="hs-pick-name">${name}</span>${sub}</td>
      <td class="hs-num">${news || '<span class="hs-muted">0</span>'}</td>
      <td class="hs-num">${citizen || '<span class="hs-muted">0</span>'}</td>
    </tr>`;
  document.getElementById('hsLivePicker').innerHTML = `
    <thead><tr><th>State</th><th class="hs-num">News</th><th class="hs-num">Citizen</th></tr></thead>
    <tbody>
      ${query ? '' : pickRow('all', 'All states', '<span class="hs-pick-sub">Everything tied to a state</span>', live.mappedArticles, live.mappedReports, '')}
      ${states.map(s => pickRow(s.state, escapeHtml(s.state),
        `<span class="hs-badge">${s.composite} &middot; ${hsLevel(s.composite).label}</span>`,
        s.liveArticles.length, s.liveReports.length, hsLevel(s.composite).key)).join('')}
      ${query ? '' : pickRow('national', 'Not tied to a state', '<span class="hs-pick-sub">Nationwide or unlocated</span>', unlocated, 0, '')}
      ${states.length || !query ? '' : '<tr class="hs-pick-none"><td colspan="3">No state matches.</td></tr>'}
    </tbody>`;

  // Reports for the chosen row.
  const selected = hotspots.find(s => s.state === selection);
  let items = hsLiveItems(hotspots, selection);
  // A state on its own gets its local and regional reports for the week,
  // fetched the first time it is looked at.
  let newsNote = '';
  if (selected && hsState.panelTab === 'live') {
    if (hsStateNewsEntry(selected.state).status === 'idle') hsLoadStateNews(selected.state);
    const local = hsStateNewsEntry(selected.state).data;
    if (local) items = local.events.map(event => ({ kind: 'local', event, states: [selected] }));
    newsNote = hsStateNewsNote(selected.state);
  }
  const pages = Math.max(1, Math.ceil(items.length / HS_LIVE_PAGE));
  hsState.livePage = Math.min(Math.max(hsState.livePage, 0), pages - 1);
  const pageItems = items.slice(hsState.livePage * HS_LIVE_PAGE, (hsState.livePage + 1) * HS_LIVE_PAGE);

  const title = selected ? escapeHtml(selected.state)
    : selection === 'national' ? 'Not tied to a state' : 'All states';
  const sub = selected
    ? `<span class="hs-badge hs-lv-${hsLevel(selected.composite).key}">${selected.composite}/100 &middot; ${hsLevel(selected.composite).label}</span>
       <span class="hs-muted">Rank #${selected.rank} &middot; ${escapeHtml(selected.zone)}</span>`
    : `<span class="hs-muted">${selection === 'national'
        ? 'Reports that name no Nigerian state; they do not move any state score'
        : 'Every current report that names a state'}</span>`;
  document.getElementById('hsLiveDetailHead').innerHTML = `
    <div class="hs-live-detail-title"><strong>${title}</strong>${sub}</div>
    ${selected ? `<button type="button" class="hs-tool-btn" onclick="hsOpenState('${escapeHtml(selected.state)}')"><i class="ti ti-layout-sidebar-right-expand"></i> State profile</button>` : ''}`;

  let empty = 'No current reports yet. The index is running on the database alone and will pick up the feed when it responds.';
  if (selected) empty = hsStateNewsEntry(selected.state).data
    ? `No incident reports were found for ${escapeHtml(selected.state)} in the last ${hsStateNewsEntry(selected.state).data.windowDays} days.`
    : `No current news or citizen reports name ${escapeHtml(selected.state)}. Its score rests on the incident database.`;
  else if (selection === 'national') empty = 'Every current report names a state.';
  else if (live.articles) empty = 'None of the current reports names a Nigerian state, so the index is running on the database alone.';
  document.getElementById('hsLiveList').innerHTML = newsNote + (pageItems.length
    ? pageItems.map(item => hsLiveItemHtml(item, !selected)).join('')
    : `<div class="hs-live-empty">${empty}</div>`);
  document.getElementById('hsLivePager').innerHTML = hsPagerHtml(hsState.livePage, pages, items.length, 'hsSetLivePage');
}

function hsSelectLive(key) {
  hsState.liveSel = key;
  hsState.livePage = 0;
  renderHsLive(cachedHotspots);
}
function hsSetLivePage(page) {
  hsState.livePage = page;
  renderHsLive(cachedHotspots);
}
function hsSetLiveQuery(value) {
  hsState.liveQuery = value;
  renderHsLive(cachedHotspots);
}

// ── Full ranking ─────────────────────────────────────────────

function hsShiftHtml(shift) {
  if (shift > 0) return `<span class="hs-shift is-up" title="Up ${shift} on live signals"><i class="ti ti-arrow-up"></i>${shift}</span>`;
  if (shift < 0) return `<span class="hs-shift is-down" title="Down ${-shift} on live signals"><i class="ti ti-arrow-down"></i>${-shift}</span>`;
  return '<span class="hs-shift">&ndash;</span>';
}

// The 37 states split into a handful of groups, each of which opens on click.
function hsRankGroups(hotspots) {
  if (hsState.rankMode === 'zone') {
    return Object.keys(HS_ZONES)
      .map(zone => ({ name: zone, rows: hotspots.filter(s => s.zone === zone) }))
      .filter(group => group.rows.length)
      .map(group => ({ ...group, note: `Highest: ${hsShortName(group.rows[0].state)} ${group.rows[0].composite}` }))
      .sort((a, b) => b.rows[0].composite - a.rows[0].composite);
  }
  return HS_LEVELS.map((level, index) => ({
    name: level.label,
    levelKey: level.key,
    note: `Score ${level.min}–${index ? HS_LEVELS[index - 1].min - 1 : 100}`,
    rows: hotspots.filter(s => hsLevel(s.composite) === level)
  })).filter(group => group.rows.length);
}

function renderHsTable(hotspots) {
  const query = hsState.rankQuery.trim().toLowerCase();
  const allGroups = hsRankGroups(hotspots);
  if (!hsState.rankOpen) hsState.rankOpen = new Set(allGroups.slice(0, 1).map(group => group.name));
  const groups = allGroups
    .map(group => ({ ...group, shown: query ? group.rows.filter(s => s.state.toLowerCase().includes(query)) : group.rows }))
    .filter(group => group.shown.length);
  const sum = (rows, pick) => rows.reduce((total, s) => total + pick(s), 0);

  document.querySelectorAll('[data-rank-mode]').forEach(button =>
    button.classList.toggle('is-active', button.dataset.rankMode === hsState.rankMode));
  const allOpen = allGroups.every(group => hsState.rankOpen.has(group.name));
  document.getElementById('hsRankToggleAll').innerHTML = allOpen
    ? '<i class="ti ti-fold"></i> Collapse all' : '<i class="ti ti-unfold"></i> Expand all';

  const stateRow = s => {
    const level = hsLevel(s.composite);
    return `<tr class="hs-row hs-lv-${level.key}" onclick="hsOpenState('${escapeHtml(s.state)}')">
      <td class="hs-td-rank">${s.rank}</td>
      <td class="hs-td-state">${escapeHtml(s.state)}</td>
      <td><div class="hs-score-bar" title="${level.label}">
        <span class="hs-score-val">${s.composite}</span>
        <div class="hs-score-track"><div class="hs-score-fill" style="width:${s.composite}%"></div></div>
      </div></td>
      <td class="hs-td-deaths">${s.deaths.toLocaleString()}</td>
      <td>${s.incidents.toLocaleString()}</td>
      <td>${s.awsdCount}</td>
      <td>${s.liveCount || '<span class="hs-muted">0</span>'}</td>
      <td>${hsShiftHtml(s.rankShift)}</td>
    </tr>`;
  };

  const groupBody = group => {
    const open = query ? true : hsState.rankOpen.has(group.name);
    const rows = group.shown;
    const average = Math.round(sum(rows, s => s.composite) / rows.length);
    const levelKey = group.levelKey || hsLevel(average).key;
    return `<tbody class="hs-grp hs-lv-${levelKey}${open ? ' is-open' : ''}">
      <tr class="hs-grp-row" onclick="hsToggleRankGroup('${escapeHtml(group.name)}')" aria-expanded="${open}">
        <td><i class="ti ti-chevron-right hs-grp-chev"></i></td>
        <td><span class="hs-grp-name"><span class="hs-grp-dot"></span>${escapeHtml(group.name)}</span>
            <span class="hs-grp-note">${rows.length} state${rows.length === 1 ? '' : 's'} &middot; ${escapeHtml(group.note)}</span></td>
        <td><div class="hs-score-bar">
          <span class="hs-score-val" title="Average score">${average}</span>
          <div class="hs-score-track"><div class="hs-score-fill" style="width:${average}%"></div></div>
        </div></td>
        <td class="hs-td-deaths">${sum(rows, s => s.deaths).toLocaleString()}</td>
        <td>${sum(rows, s => s.incidents).toLocaleString()}</td>
        <td>${sum(rows, s => s.awsdCount)}</td>
        <td>${sum(rows, s => s.liveCount) || '<span class="hs-muted">0</span>'}</td>
        <td></td>
      </tr>
      ${open ? rows.map(stateRow).join('') : ''}
    </tbody>`;
  };

  document.getElementById('hsRankTable').innerHTML = `
    <thead><tr>
      <th>#</th><th>${hsState.rankMode === 'zone' ? 'Zone / state' : 'Risk level / state'}</th>
      <th style="min-width:104px">Risk score</th>
      <th>Deaths</th><th>Incidents</th><th title="Aid worker incidents">Aid</th>
      <th title="Live news and citizen reports">Live</th><th title="Change in rank caused by live signals">Shift</th>
    </tr></thead>
    ${groups.map(groupBody).join('') || '<tbody><tr><td colspan="8" class="hs-rank-none">No state matches.</td></tr></tbody>'}`;
}

function hsSetRankMode(mode) {
  if (mode === hsState.rankMode) return;
  hsState.rankMode = mode;
  hsState.rankOpen = null;
  renderHsTable(cachedHotspots);
}
function hsSetRankQuery(value) {
  hsState.rankQuery = value;
  renderHsTable(cachedHotspots);
}
function hsToggleRankGroup(name) {
  if (hsState.rankQuery.trim()) return;   // a search shows every match
  if (!hsState.rankOpen.delete(name)) hsState.rankOpen.add(name);
  renderHsTable(cachedHotspots);
}
function hsShowRankGroup(name) {
  hsState.rankMode = 'level';
  hsState.rankQuery = '';
  document.getElementById('hsRankSearch').value = '';
  hsState.rankOpen = new Set([name]);
  renderHsTable(cachedHotspots);
  hsSetPanelTab('ranking');
}
function hsToggleAllRankGroups() {
  const names = hsRankGroups(cachedHotspots).map(group => group.name);
  const allOpen = names.every(name => hsState.rankOpen.has(name));
  hsState.rankOpen = new Set(allOpen ? [] : names);
  renderHsTable(cachedHotspots);
}

// ── State profile ────────────────────────────────────────────

// The panel beside the map is tabbed so the page does not have to scroll.
// Clicking a state adds a tab for it and brings that tab forward.
function renderHsPanelTabs() {
  const signals = hsState.live ? hsState.live.mappedArticles + hsState.live.mappedReports : 0;
  const tab = (key, icon, label, extra = '') => `<button type="button" role="tab" class="hs-tab hs-ptab${hsState.panelTab === key ? ' is-active' : ''}"
    aria-selected="${hsState.panelTab === key}" onclick="hsSetPanelTab('${key}')"><i class="ti ${icon}"></i>${label}${extra}</button>`;
  document.getElementById('hsPanelTabs').innerHTML =
    HS_PANEL_TABS.map(([key, icon, label]) =>
      tab(key, icon, label, key === 'live' && signals ? `<span class="hs-tab-count">${signals}</span>` : '')).join('') +
    (hsState.openState ? tab('state', 'ti-map-pin', escapeHtml(hsShortName(hsState.openState))) : '');
  document.querySelectorAll('#hsSidePanel .hs-pane').forEach(pane =>
    pane.classList.toggle('is-active', pane.dataset.pane === hsState.panelTab));
}

function hsSetPanelTab(tab) {
  hsState.panelTab = tab;
  renderHsPanelTabs();
  // A chart drawn while its tab was hidden has no size; draw it now.
  if (tab === 'trend') renderHsTrendChart(cachedHotspots);
  if (tab === 'live') renderHsLive(cachedHotspots);
  if (tab === 'state') hsRenderStatePanel();
}

function hsOpenState(stateName) {
  if (!(cachedHotspots || []).some(s => s.state === stateName)) return;
  hsHighlightState(stateName);
  hsState.stateTab = 'news';
  if (hsState.panelTab !== 'state') hsState.lastTab = hsState.panelTab;
  hsSetPanelTab('state');
  hsLoadStateNews(stateName);
  document.getElementById('hsStateBody').scrollTop = 0;
  document.querySelector('.hs-main-grid').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.addEventListener('keydown', hsStateKeydown);
}

function hsCloseState() {
  document.removeEventListener('keydown', hsStateKeydown);
  Chart.getChart('hsStateTrend')?.destroy();
  hsHighlightState(null);
  hsSetPanelTab(hsState.panelTab === 'state' ? hsState.lastTab : hsState.panelTab);
}

function hsStateKeydown(event) {
  if (event.key === 'Escape' && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) hsCloseState();
}

function hsSetStateTab(tab) {
  hsState.stateTab = tab;
  hsRenderStatePanel();
}

function hsStateTabHtml(s, tab, checkpoints) {
  const none = text => `<div class="hs-live-empty">${text}</div>`;
  if (tab === 'news') {
    const local = hsStateNewsEntry(s.state).data;
    if (local) {
      return hsStateNewsNote(s.state) + (local.events.length
        ? local.events.map(hsLocalItemHtml).join('')
        : none(`No incident reports were found for ${escapeHtml(s.state)} in the last ${local.windowDays} days.`));
    }
    return hsStateNewsNote(s.state) + (s.liveArticles.length
      ? s.liveArticles.map(article => hsLiveItemHtml({ kind: 'news', article, states: [s] }, false)).join('')
      : none(`No news report from the last 24 hours names ${escapeHtml(s.state)}.`));
  }
  if (tab === 'citizen') {
    return s.liveReports.length
      ? s.liveReports.map(report => hsLiveItemHtml({ kind: 'citizen', report, states: [s] }, false)).join('')
      : none(hsState.reportsLoaded
          ? `No located citizen report in the last ${HS_REPORT_WINDOW_DAYS} days falls inside ${escapeHtml(s.state)}.`
          : 'Citizen reports are unavailable from this server.');
  }
  if (tab === 'aid') {
    if (!s.awsdRecords.length) return none(`The aid worker security database holds no record for ${escapeHtml(s.state)}.`);
    const records = [...s.awsdRecords].sort((a, b) => b.year - a.year);
    return `<div class="hs-table-wrap"><table class="hs-table hs-mini-table">
      <thead><tr><th>Year</th><th>Place</th><th>Attack</th><th>Actor</th><th title="Killed / wounded / kidnapped">K / W / Kd</th><th>What happened</th></tr></thead>
      <tbody>${records.map(r => `<tr>
        <td>${r.year}</td><td>${escapeHtml(r.city || '—')}</td><td>${escapeHtml(r.attack || '—')}</td>
        <td>${escapeHtml(r.actor || '—')}</td><td>${r.killed} / ${r.wounded} / ${r.kidnapped}</td>
        <td class="hs-mini-detail">${escapeHtml(r.details || '—')}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }
  if (!checkpoints.length) return none(`No checkpoint is on record for ${escapeHtml(s.state)}.`);
  return `<div class="hs-table-wrap"><table class="hs-table hs-mini-table">
    <thead><tr><th>Checkpoint</th><th>Road</th><th>Type</th><th>Status</th></tr></thead>
    <tbody>${checkpoints.map(cp => `<tr>
      <td>${escapeHtml(cp.name)}</td><td>${escapeHtml(cp.road || '—')}</td>
      <td>${escapeHtml(cp.type || '—')}</td><td>${escapeHtml(cp.status || '—')}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function hsRenderStatePanel() {
  const s = (cachedHotspots || []).find(row => row.state === hsState.openState);
  if (!s || hsState.panelTab !== 'state') return;
  const level = hsLevel(s.composite);
  const weights = hsState.weights || HS_WEIGHTS_DB;
  const total = cachedHotspots.length;
  const checkpoints = checkpointRecords.filter(cp => hsRegionToState(cp.state) === s.state);

  document.getElementById('hsStateTop').innerHTML = `
    <div class="hs-sp-id hs-lv-${level.key}">
      <span class="hs-sp-swatch" style="background:${hsRampColor(s.composite)}"></span>
      <div>
        <div class="hs-sp-title">${escapeHtml(s.state)}</div>
        <div class="hs-sp-sub">${escapeHtml(s.zone)} &middot; Rank #${s.rank} of ${total} &middot; <span class="hs-badge">${level.label}</span></div>
      </div>
    </div>
    <div class="hs-sp-actions">
      <button type="button" class="hs-tool-btn" onclick="hsCloseState()" title="Close this state and go back to the national tabs"><i class="ti ti-x"></i> Close</button>
      <button type="button" class="hs-tool-btn" onclick="hsLocateState('${escapeHtml(s.state)}')" title="Zoom the map to this state"><i class="ti ti-map-pin"></i> Zoom</button>
      <button type="button" class="hs-tool-btn hs-tool-primary" onclick="exportStateReport('${escapeHtml(s.state)}')" title="Download this state's analysis"><i class="ti ti-download"></i> Export</button>
    </div>`;

  const shiftText = s.rankShift > 0 ? `Up ${s.rankShift} on live signals`
    : s.rankShift < 0 ? `Down ${-s.rankShift} on live signals` : 'Unchanged by live signals';
  const tile = (label, value, note, cls = '') => `
    <div class="hs-stat ${cls}"><div class="hs-stat-label">${label}</div>
      <div class="hs-stat-value">${value}</div><div class="hs-stat-note">${note}</div></div>`;
  const share = (value, key) => {
    const whole = cachedHotspots.reduce((sum, row) => sum + row[key], 0);
    return whole ? `${((value / whole) * 100).toFixed(1)}% of national total` : 'No national total';
  };

  const drivers = HS_WEIGHT_LABELS.filter(([key]) => weights[key] > 0).map(([key, label]) => `
    <div class="hs-driver">
      <span class="hs-driver-name">${label}<em>weight ${Math.round(weights[key] * 100)}%</em></span>
      <span class="hs-bar-track"><span class="hs-bar-fill" style="width:${Math.round(s.parts[key] * 100)}%"></span></span>
      <span class="hs-driver-val" title="Share of the highest state on this input">${Math.round(s.parts[key] * 100)}%</span>
      <span class="hs-driver-pts" title="Points this input adds to the score">+${s.points[key].toFixed(1)}</span>
    </div>`).join('');

  const actorTotal = HS_ACTORS.reduce((sum, [key]) => sum + (s.actors[key] || 0), 0);
  const actors = actorTotal
    ? HS_ACTORS.map(([key, label]) => {
        const count = s.actors[key] || 0;
        return `<div class="hs-driver hs-driver-actor">
          <span class="hs-driver-name">${label}</span>
          <span class="hs-bar-track"><span class="hs-actor-seg hs-actor-${key}" style="display:block;height:100%;width:${(count / actorTotal) * 100}%"></span></span>
          <span class="hs-driver-val">${count}</span>
        </div>`;
      }).join('')
    : '<div class="hs-live-empty">No aid worker record or current headline attributes an attack here.</div>';

  const tabs = [
    ['news', 'Local news', hsStateNewsEntry(s.state).data ? hsStateNewsEntry(s.state).data.events.length : s.liveArticles.length],
    ['citizen', 'Citizen reports', s.liveReports.length],
    ['aid', 'Aid worker records', s.awsdRecords.length],
    ['checkpoints', 'Checkpoints', checkpoints.length]
  ];

  document.getElementById('hsStateBody').innerHTML = `
    <div class="hs-stat-row hs-lv-${level.key}">
      ${tile('Composite risk', `${s.composite}<small>/100</small>`, `Database only: ${s.baseline}`, 'is-score')}
      ${tile('National rank', `#${s.rank}<small>of ${total}</small>`, shiftText)}
      ${tile('Deaths', s.deaths.toLocaleString(), share(s.deaths, 'deaths'), 'is-danger')}
      ${tile('Incidents', s.incidents.toLocaleString(), share(s.incidents, 'incidents'))}
      ${tile('Aid incidents', s.awsdCount, `${s.awsdAffected} worker${s.awsdAffected === 1 ? '' : 's'} affected`)}
      ${tile('Live signals', s.liveCount, `${s.liveArticles.length} news &middot; ${s.liveReports.length} citizen`)}
    </div>

      <div class="hs-chart-block">
        <div class="hs-block-head"><i class="ti ti-chart-bar"></i> What drives the score</div>
        <div class="hs-drivers">${drivers}</div>
        <div class="hs-sp-foot">Bars show ${escapeHtml(hsShortName(s.state))} against the highest state on each input. The points add up to the score of ${s.composite}.</div>
      </div>
      <div class="hs-chart-block">
        <div class="hs-block-head"><i class="ti ti-users"></i> Who is behind the attacks</div>
        <div class="hs-drivers">${actors}</div>
        ${actorTotal ? `<div class="hs-sp-foot">From ${s.awsdRecords.length} aid worker record${s.awsdRecords.length === 1 ? '' : 's'} and ${s.liveArticles.length} current headline${s.liveArticles.length === 1 ? '' : 's'}.</div>` : ''}
      </div>

    <div class="hs-chart-block">
      <div class="hs-block-head"><i class="ti ti-chart-line"></i> Aid worker incidents by year</div>
      ${s.awsdRecords.length
        ? '<div class="hs-chart-frame"><canvas id="hsStateTrend"></canvas></div>'
        : `<div class="hs-live-empty">No aid worker incident is recorded for ${escapeHtml(s.state)}.</div>`}
    </div>

    <div class="hs-chart-block">
      <div class="hs-tabs" role="tablist">
        ${tabs.map(([key, label, count]) => `<button type="button" role="tab" class="hs-tab${hsState.stateTab === key ? ' is-active' : ''}"
          aria-selected="${hsState.stateTab === key}" onclick="hsSetStateTab('${key}')">${label}<span class="hs-tab-count">${count}</span></button>`).join('')}
      </div>
      <div class="hs-tab-panel${hsState.stateTab === 'news' || hsState.stateTab === 'citizen' ? ' hs-live-list' : ''}">${hsStateTabHtml(s, hsState.stateTab, checkpoints)}</div>
    </div>`;

  hsRenderStateTrend(s);
}

function hsRenderStateTrend(s) {
  const canvas = document.getElementById('hsStateTrend');
  if (!canvas) return;
  const { tc, gc } = getChartThemeColors();
  const years = [...new Set(awsdData.map(r => r.year))].sort((a, b) => a - b);
  const count = pick => years.map(year => s.awsdRecords.filter(r => r.year === year).reduce((sum, r) => sum + pick(r), 0));
  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: 'Incidents', data: count(() => 1), backgroundColor: '#2e8fff', borderRadius: 3, maxBarThickness: 18 },
        { label: 'Workers affected', data: count(r => r.affected), backgroundColor: '#f5a623', borderRadius: 3, maxBarThickness: 18 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { color: tc, font: { size: 10 }, boxWidth: 10, boxHeight: 10, padding: 10 } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: tc, font: { size: 10 }, maxTicksLimit: 12 } },
        y: { beginAtZero: true, grid: { color: gc }, ticks: { color: tc, font: { size: 10 }, precision: 0 } }
      }
    }
  });
}

// ── Export ───────────────────────────────────────────────────

function hsCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function hsDownloadCsv(rows, filename) {
  const text = rows.map(row => row.map(hsCsvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function hsFormulaText() {
  const weights = hsState.weights || HS_WEIGHTS_DB;
  return HS_WEIGHT_LABELS.filter(([key]) => weights[key] > 0)
    .map(([key, label]) => `${label} ${Math.round(weights[key] * 100)}%`).join(' + ');
}

function exportHotspotReport() {
  if (!cachedHotspots) return;
  hsDownloadCsv([
    ['GeoSentry NG — composite risk report'],
    [`Generated ${new Date().toISOString()}`],
    [`Risk score = ${hsFormulaText()}; scores are relative to the highest-risk state (100)`],
    [],
    ['Rank', 'State', 'Risk score', 'Level', 'Database-only score', 'Rank shift from live signals',
     'Deaths', 'Incidents', 'Aid worker incidents', 'Aid workers affected',
     'Live news reports (24h)', 'Citizen reports', 'Latest headline', 'Headline URL'],
    ...cachedHotspots.map(s => [
      s.rank, s.state, s.composite, hsLabel(s.composite), s.baseline, s.rankShift,
      s.deaths, s.incidents, s.awsdCount, s.awsdAffected,
      s.liveArticles.length, s.liveReports.length,
      s.liveArticles[0]?.title || '', s.liveArticles[0]?.url || ''
    ])
  ], `geosentry-risk-report-${new Date().toISOString().slice(0, 10)}.csv`);
}

// Everything the state panel shows, as one sectioned CSV.
function exportStateReport(stateName) {
  const s = (cachedHotspots || []).find(row => row.state === stateName);
  if (!s) return;
  const weights = hsState.weights || HS_WEIGHTS_DB;
  const checkpoints = checkpointRecords.filter(cp => hsRegionToState(cp.state) === s.state);
  const national = key => cachedHotspots.reduce((sum, row) => sum + row[key], 0);
  const share = key => (national(key) ? `${((s[key] / national(key)) * 100).toFixed(1)}%` : '');
  const years = [...new Set(s.awsdRecords.map(r => r.year))].sort((a, b) => a - b);
  const section = (title, header, rows, emptyText) =>
    [[], [title], ...(rows.length ? [header, ...rows] : [[emptyText]])];

  hsDownloadCsv([
    [`GeoSentry NG — state risk profile: ${s.state}`],
    [`Generated ${new Date().toISOString()}`],
    [`Risk score = ${hsFormulaText()}; scores are relative to the highest-risk state (100)`],
    [],
    ['SUMMARY'],
    ['Measure', 'Value', 'Note'],
    ['State', s.state, s.zone],
    ['Composite risk score', s.composite, 'out of 100'],
    ['Risk level', hsLabel(s.composite), ''],
    ['National rank', s.rank, `of ${cachedHotspots.length}`],
    ['Rank shift from live signals', s.rankShift, 'positive = moved up the ranking'],
    ['Database-only score', s.baseline, 'score without live signals'],
    ['Deaths', s.deaths, `${share('deaths')} of national total`],
    ['Incidents', s.incidents, `${share('incidents')} of national total`],
    ['Aid worker incidents', s.awsdCount, ''],
    ['Aid workers affected', s.awsdAffected, ''],
    ['Live news reports (24h)', s.liveArticles.length, ''],
    ['Citizen reports', s.liveReports.length, `last ${HS_REPORT_WINDOW_DAYS} days`],
    ['Checkpoints on record', checkpoints.length, ''],
    ...section('SCORE DRIVERS',
      ['Input', 'Weight', 'Share of highest state', 'Points added to score'],
      HS_WEIGHT_LABELS.filter(([key]) => weights[key] > 0).map(([key, label]) =>
        [label, `${Math.round(weights[key] * 100)}%`, `${Math.round(s.parts[key] * 100)}%`, s.points[key].toFixed(1)]), ''),
    ...section('ATTACK ACTORS', ['Actor', 'Attributed records'],
      HS_ACTORS.filter(([key]) => s.actors[key]).map(([key, label]) => [label, s.actors[key]]),
      'No attributed records'),
    ...section('AID WORKER INCIDENTS BY YEAR', ['Year', 'Incidents', 'Workers affected'],
      years.map(year => {
        const records = s.awsdRecords.filter(r => r.year === year);
        return [year, records.length, records.reduce((sum, r) => sum + r.affected, 0)];
      }), 'No aid worker incidents recorded'),
    ...section('NEWS REPORTS (LAST 24H)', ['Published', 'Type', 'Headline', 'Source', 'URL'],
      s.liveArticles.map(a => [a.seenDate, a.attack, a.title, a.domain, a.url]),
      'No current news report names this state'),
    ...section(`LOCAL AND REGIONAL REPORTS (LAST ${hsStateNewsEntry(s.state).data?.windowDays || 7} DAYS)`,
      ['Published', 'Type', 'Headline', 'Towns named', 'Source', 'Outlets carrying it', 'Media', 'URL'],
      (hsStateNewsEntry(s.state).data?.events || []).map(e =>
        [e.seenDate, e.categoryLabel, e.title, e.places.join('; '), e.source, e.sourceCount, (e.media || []).join('; '), e.url]),
      hsStateNewsEntry(s.state).data ? 'No incident reports found' : 'Local sources had not been read when this was exported'),
    ...section('CITIZEN REPORTS', ['Received', 'Category', 'Severity', 'Description'],
      s.liveReports.map(r => [r.receivedAt, r.category, r.severity, r.message]),
      'No located citizen report'),
    ...section('AID WORKER SECURITY RECORDS',
      ['Year', 'Place', 'Attack', 'Actor', 'Killed', 'Wounded', 'Kidnapped', 'Affected', 'Details'],
      [...s.awsdRecords].sort((a, b) => b.year - a.year).map(r =>
        [r.year, r.city, r.attack, r.actor, r.killed, r.wounded, r.kidnapped, r.affected, r.details]),
      'No aid worker security records'),
    ...section('CHECKPOINTS', ['Checkpoint', 'Road', 'Type', 'Status'],
      checkpoints.map(cp => [cp.name, cp.road, cp.type, cp.status]), 'No checkpoints on record')
  ], `geosentry-${s.state.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-profile-${new Date().toISOString().slice(0, 10)}.csv`);
}
