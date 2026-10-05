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
  stampTimer: null
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
}

// Theme changes only affect what is drawn on canvas; the rest is CSS.
function refreshHotspotTheme() {
  if (!hotspotInitialized || !cachedHotspots) return;
  renderHsMap(cachedHotspots);
  renderHsTrendChart(cachedHotspots);
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
    return `<button type="button" class="hs-kpi-card hs-lv-${level.key}" onclick="hsFocusState('${escapeHtml(s.state)}')">
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

function hsPopupHtml(s) {
  const level = hsLevel(s.composite);
  const latest = s.liveArticles[0];
  return `
    <div class="popup-title">${escapeHtml(s.state)} &middot; #${s.rank}</div>
    <div class="popup-row"><span>Composite risk</span><span style="color:${level.color};font-size:15px;font-weight:700">${s.composite}/100</span></div>
    <div class="popup-row"><span>Level</span><span style="color:${level.color};font-weight:600">${level.label}</span></div>
    <div class="popup-row"><span>Deaths</span><span class="popup-metric-danger">${s.deaths.toLocaleString()}</span></div>
    <div class="popup-row"><span>Incidents</span><span>${s.incidents.toLocaleString()}</span></div>
    <div class="popup-row"><span>Aid worker incidents</span><span>${s.awsdCount}</span></div>
    <div class="popup-row"><span>Aid workers affected</span><span>${s.awsdAffected}</span></div>
    <div class="popup-row"><span>Live signals</span><span>${s.liveArticles.length} news &middot; ${s.liveReports.length} citizen</span></div>
    ${latest ? `<div class="popup-detail"><a href="${escapeHtml(latest.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(latest.title)}</a></div>` : ''}`;
}

function renderHsMap(hotspots) {
  const firstDraw = !hotspotMapInstance;
  if (firstDraw) {
    hotspotMapInstance = L.map('hotspotMap', {
      zoomControl: true, attributionControl: false,
      zoomSnap: 0.25, minZoom: 5, maxZoom: 9
    }).setView([9.05, 8.7], 6);
  }
  const map = hotspotMapInstance;
  if (hsState.layers) hsState.layers.remove();
  hsState.layers = L.layerGroup().addTo(map);
  hsState.polygons = new Map();

  const byName = new Map(hotspots.map(s => [s.state, s]));
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const outline = isLight ? 'rgba(13,38,71,0.35)' : 'rgba(255,255,255,0.16)';

  // Boundaries, tinted by score. Until they load the glow markers stand alone.
  if (hsState.geo) {
    L.geoJSON(hsState.geo, {
      style: feature => {
        const s = byName.get(hsGeoStateName(feature));
        return {
          color: outline, weight: 0.8,
          fillColor: s ? hsColor(s.composite) : 'transparent',
          fillOpacity: s ? 0.05 + (s.composite / 100) * 0.17 : 0
        };
      },
      onEachFeature: (feature, layer) => {
        const s = byName.get(hsGeoStateName(feature));
        if (!s) return;
        hsState.polygons.set(s.state, layer);
        layer.bindPopup(hsPopupHtml(s));
        layer.on({
          mouseover: e => e.target.setStyle({ weight: 1.8, color: isLight ? '#0d2647' : '#ffffff' }),
          mouseout:  e => e.target.setStyle({ weight: 0.8, color: outline })
        });
      }
    }).addTo(hsState.layers);
  }

  // Glow: radius follows the score, so the eye lands on the worst first.
  hotspots.forEach(s => {
    const color = hsColor(s.composite);
    const radius = 22000 + s.composite * 1150;
    const strength = 0.12 + (s.composite / 100) * 0.4;
    [[1, strength * 0.55], [0.5, strength]].forEach(([scale, opacity]) => {
      L.circle([s.lat, s.lng], {
        radius: radius * scale, stroke: false, fillColor: color, fillOpacity: opacity,
        interactive: false, className: 'hs-blob'
      }).addTo(hsState.layers);
    });
    if (!hsState.geo) {
      L.circleMarker([s.lat, s.lng], { radius: 9, opacity: 0, fillOpacity: 0 })
        .bindPopup(hsPopupHtml(s)).addTo(hsState.layers);
    }
  });

  hotspots.slice(0, 6).forEach(s => {
    L.marker([s.lat, s.lng], {
      interactive: false,
      icon: L.divIcon({
        className: 'hs-map-label-anchor', iconSize: [0, 0],
        html: `<span class="hs-map-label">${escapeHtml(hsShortName(s.state))} &middot; ${s.composite}</span>`
      })
    }).addTo(hsState.layers);
  });

  // The panel has no size until the view is on screen, so frame Nigeria only
  // once it does — and only the first time, so a refresh never moves the map.
  setTimeout(() => {
    map.invalidateSize();
    if (firstDraw) map.fitBounds(HS_NIGERIA_BOUNDS, { padding: [10, 10], animate: false });
  }, 150);
}

function hsFocusState(stateName) {
  const s = (cachedHotspots || []).find(row => row.state === stateName);
  if (!s || !hotspotMapInstance) return;
  document.getElementById('hotspotMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  hotspotMapInstance.flyTo([s.lat, s.lng], 7, { duration: 0.8 });
  const polygon = hsState.polygons?.get(stateName);
  if (polygon) setTimeout(() => polygon.openPopup([s.lat, s.lng]), 850);
}

// ── Right-hand analysis ──────────────────────────────────────

function renderHsCharts(hotspots) {
  // ① Composite risk — top 10
  document.getElementById('hsRiskBars').innerHTML = hotspots.slice(0, 10).map(s => `
    <div class="hs-bar-row" onclick="hsFocusState('${escapeHtml(s.state)}')">
      <span class="hs-bar-name">${escapeHtml(hsShortName(s.state))}</span>
      <span class="hs-bar-track"><span class="hs-bar-fill" style="width:${s.composite}%"></span></span>
      <span class="hs-bar-val">${s.composite}</span>
    </div>`).join('');

  // ② Who is behind it — top 5, from AWSD records and current headlines
  document.getElementById('hsActorBars').innerHTML = hotspots.slice(0, 5).map(s => {
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

// ── Live signals ─────────────────────────────────────────────

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

  // One row per article, however many states it names.
  const seen = new Map();
  hotspots.forEach(s => s.liveArticles.forEach(article => {
    if (!seen.has(article.url)) seen.set(article.url, { article, states: [] });
    seen.get(article.url).states.push(s);
  }));
  const items = [...seen.values()]
    .sort((a, b) => (Date.parse(b.article.seenDate) || 0) - (Date.parse(a.article.seenDate) || 0))
    .slice(0, 12);

  const list = document.getElementById('hsLiveList');
  if (!items.length) {
    list.innerHTML = `<div class="hs-live-empty">${live.articles
      ? 'None of the current reports names a Nigerian state, so the index is running on the database alone.'
      : 'No current reports yet. The index is running on the database alone and will pick up the feed when it responds.'}</div>`;
    return;
  }
  list.innerHTML = items.map(({ article, states }) => `
    <a class="hs-live-item" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">
      <div class="hs-live-tags">
        ${states.map(s => `<span class="hs-live-state hs-lv-${hsLevel(s.composite).key}">${escapeHtml(hsShortName(s.state))} &middot; ${s.composite}</span>`).join('')}
        <span class="hs-live-attack">${escapeHtml(article.attack)}</span>
      </div>
      <div class="hs-live-title">${escapeHtml(article.title)}</div>
      <div class="hs-live-meta">${escapeHtml(article.domain)} &middot; ${escapeHtml(formatNewsDate(article.seenDate))}</div>
    </a>`).join('');
}

// ── Full ranking ─────────────────────────────────────────────

function hsShiftHtml(shift) {
  if (shift > 0) return `<span class="hs-shift is-up" title="Up ${shift} on live signals"><i class="ti ti-arrow-up"></i>${shift}</span>`;
  if (shift < 0) return `<span class="hs-shift is-down" title="Down ${-shift} on live signals"><i class="ti ti-arrow-down"></i>${-shift}</span>`;
  return '<span class="hs-shift">&ndash;</span>';
}

function renderHsTable(hotspots) {
  document.getElementById('hsRankTable').innerHTML = `
    <thead><tr>
      <th>#</th><th>State</th><th style="min-width:180px">Risk score</th><th>Level</th>
      <th>Deaths</th><th>Incidents</th><th>Aid incidents</th><th>Workers affected</th>
      <th>Live signals</th><th title="Change in rank caused by live signals">Shift</th>
    </tr></thead>
    <tbody>
      ${hotspots.map(s => {
        const level = hsLevel(s.composite);
        return `<tr class="hs-lv-${level.key}" onclick="hsFocusState('${escapeHtml(s.state)}')">
          <td class="hs-td-rank">${s.rank}</td>
          <td class="hs-td-state">${escapeHtml(s.state)}</td>
          <td><div class="hs-score-bar">
            <span class="hs-score-val">${s.composite}</span>
            <div class="hs-score-track"><div class="hs-score-fill" style="width:${s.composite}%"></div></div>
          </div></td>
          <td><span class="hs-badge">${level.label}</span></td>
          <td class="hs-td-deaths">${s.deaths.toLocaleString()}</td>
          <td>${s.incidents.toLocaleString()}</td>
          <td>${s.awsdCount}</td>
          <td>${s.awsdAffected}</td>
          <td>${s.liveCount || '<span class="hs-muted">0</span>'}</td>
          <td>${hsShiftHtml(s.rankShift)}</td>
        </tr>`;
      }).join('')}
    </tbody>`;
}

// ── Export ───────────────────────────────────────────────────

function exportHotspotReport() {
  if (!cachedHotspots) return;
  const weights = hsState.weights || HS_WEIGHTS_DB;
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const formula = HS_WEIGHT_LABELS.filter(([key]) => weights[key] > 0)
    .map(([key, label]) => `${label} ${Math.round(weights[key] * 100)}%`).join(' + ');
  const lines = [
    [cell('GeoSentry NG — composite risk report')],
    [cell(`Generated ${new Date().toISOString()}`)],
    [cell(`Risk score = ${formula}; scores are relative to the highest-risk state (100)`)],
    [],
    ['Rank', 'State', 'Risk score', 'Level', 'Database-only score', 'Rank shift from live signals',
     'Deaths', 'Incidents', 'Aid worker incidents', 'Aid workers affected',
     'Live news reports (24h)', 'Citizen reports', 'Latest headline', 'Headline URL'].map(cell),
    ...cachedHotspots.map(s => [
      s.rank, s.state, s.composite, hsLabel(s.composite), s.baseline, s.rankShift,
      s.deaths, s.incidents, s.awsdCount, s.awsdAffected,
      s.liveArticles.length, s.liveReports.length,
      s.liveArticles[0]?.title || '', s.liveArticles[0]?.url || ''
    ].map(cell))
  ];
  const blob = new Blob(['﻿' + lines.map(line => line.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `geosentry-risk-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
