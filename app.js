const DATA_URL = 'dashboard_data.json';
const NEWS_CONFIG_URL = 'news_config.json';
const HISTORY_URL = 'acled_history.json';

let acledHistory = null;
let stateData = [];
let awsdData = [];
let chartData = {};
let newsRefreshTimer = null;
let liveArticles = [];
let chartFilterSet = null; // filtered AWSD set driving the charts (null = all)
let mapInstance = null;
let liveReportLayer = null;
let trendChart = null;
let attackDonutChart = null;
let monthBarChart = null;
let locationAliasMap = new Map();
let locationAliasKeys = [];
let newsUpdateInFlight = false;
let liveFeedHeartbeatTimer = null;
let liveFeedLastUpdatedAt = null;
let liveFeedNextRefreshAt = null;
let liveFeedMode = 'connecting';
let lastHighlightedLiveArticleUrl = null;
const LIVE_REFRESH_MS = 30000;
const LIVE_RETRY_MS = 10000;

async function loadDashboardData() {
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`Unable to load ${DATA_URL}: ${response.status}`);
  }
  const data = await response.json();
  // The ACLED history is optional: without it the dashboard falls back to the
  // state totals stored in dashboard_data.json.
  try {
    const history = await fetch(HISTORY_URL);
    if (history.ok) data.history = await history.json();
  } catch (error) {
    console.warn(`Unable to load ${HISTORY_URL}`, error);
  }
  return data;
}

// ── One colour scale for intensity across the page ──────────────────────
// The same ramp as the Seasons grid: cool blue for low, a neutral middle,
// orange to red for high. Maps, bubbles, bars, charts and the hotspot cards
// all read from it so a colour means the same thing everywhere.
const HEAT_STOPS = [[0, '#3b6fb6'], [0.25, '#9db7d6'], [0.5, '#e8e8e8'], [0.75, '#f5b27a'], [1, '#e0533d']];
const HEAT_CLASSES = HEAT_STOPS.map(([, hex]) => hex);   // five classes, low to high
function heatRgb(t) {
  const v = Math.max(0, Math.min(1, Number(t) || 0));
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [x1, c1] = HEAT_STOPS[i - 1], [x2, c2] = HEAT_STOPS[i];
    if (v <= x2) {
      const k = (v - x1) / (x2 - x1), a = rgb(c1), b = rgb(c2);
      return a.map((c, j) => Math.round(c + (b[j] - c) * k));
    }
  }
  return rgb(HEAT_STOPS[HEAT_STOPS.length - 1][1]);
}
function heatColor(t, alpha = 1) {
  const [r, g, b] = heatRgb(t);
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`;
}
// Dark text on the pale middle of the scale, white on the ends.
function heatTextColor(t) {
  const [r, g, b] = heatRgb(t);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#10151c' : '#ffffff';
}

// ── ACLED history (acled_history.json, built by build_acled_history.py) ──
// Per state: events / fatalities / civEvents / civFatalities as [year][month]
// grids, plus yearly totals for each local government area.
const RISK_WINDOW_YEARS = 3;
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function histState(stateName) {
  return acledHistory ? acledHistory.byState.get(stateName) || null : null;
}

// Rows to add up: one state, or every state when no name is given.
function histRows(stateName) {
  if (!acledHistory) return [];
  if (!stateName) return acledHistory.states;
  const row = histState(stateName);
  return row ? [row] : [];
}

// One value per year in acledHistory.years. monthLimit keeps only the first N months.
function histYearly(stateName, series, monthLimit = 12) {
  if (!acledHistory) return [];
  const rows = histRows(stateName);
  return acledHistory.years.map((_, yi) => rows.reduce((sum, row) =>
    sum + row[series][yi].slice(0, monthLimit).reduce((a, b) => a + b, 0), 0));
}

function histTotal(stateName, series, yearFrom, yearTo) {
  if (!acledHistory) return 0;
  return histYearly(stateName, series).reduce((sum, value, yi) => {
    const year = acledHistory.years[yi];
    return year >= yearFrom && year <= yearTo ? sum + value : sum;
  }, 0);
}

// Twelve values, January to December, summed across the years in the window.
function histMonthly(stateName, series, yearFrom, yearTo) {
  const months = new Array(12).fill(0);
  if (!acledHistory) return months;
  histRows(stateName).forEach(row => {
    acledHistory.years.forEach((year, yi) => {
      if (year < yearFrom || year > yearTo) return;
      row[series][yi].forEach((value, m) => { months[m] += value; });
    });
  });
  return months;
}

// Local government areas of a state ranked by a series over the window.
function histTopLgas(stateName, series, yearFrom, yearTo, limit = 5) {
  const row = histState(stateName);
  if (!row) return [];
  return row.lgas
    .map(lga => ({
      name: lga.name,
      value: lga[series].reduce((sum, v, yi) => {
        const year = acledHistory.years[yi];
        return year >= yearFrom && year <= yearTo ? sum + v : sum;
      }, 0)
    }))
    .filter(lga => lga.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

// Year labels with the unfinished final year marked, e.g. "2026*".
function histYearLabels() {
  if (!acledHistory) return [];
  const { lastYear, lastMonth } = acledHistory.meta;
  return acledHistory.years.map(year => (year === lastYear && lastMonth < 12 ? `${year}*` : String(year)));
}

function histCoverageText() {
  if (!acledHistory) return '';
  const { firstYear, lastYear, lastMonth } = acledHistory.meta;
  return lastMonth < 12 ? `${firstYear} – ${MONTH_LABELS[lastMonth - 1]} ${lastYear}` : `${firstYear} – ${lastYear}`;
}

function adoptHistory(history) {
  if (!history || !Array.isArray(history.states) || !history.states.length) return;
  acledHistory = history;
  acledHistory.byState = new Map(history.states.map(row => [row.state, row]));
  const { firstYear, lastYear } = history.meta;
  // The risk index (hotspot.js, and through it Travel Safety) scores states on
  // the last RISK_WINDOW_YEARS years, so it reflects where violence is now and
  // not where it was a decade ago.
  acledHistory.riskFrom = Math.max(firstYear, lastYear - RISK_WINDOW_YEARS + 1);
  stateData.forEach(state => {
    const row = histState(state.state);
    if (!row) return;
    state.zone = row.zone;
    state.deaths = histTotal(state.state, 'fatalities', firstYear, lastYear);
    state.incidents = histTotal(state.state, 'events', firstYear, lastYear);
    state.recentDeaths = histTotal(state.state, 'fatalities', acledHistory.riskFrom, lastYear);
    state.recentIncidents = histTotal(state.state, 'events', acledHistory.riskFrom, lastYear);
  });
}

async function loadNewsConfig() {
  const response = await fetch(NEWS_CONFIG_URL);
  if (!response.ok) {
    throw new Error(`Unable to load ${NEWS_CONFIG_URL}: ${response.status}`);
  }
  return response.json();
}

function formatCompact(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value.toLocaleString();
}

function updateSummary(meta) {
  const totalDeaths = stateData.reduce((sum, item) => sum + item.deaths, 0);
  const totalIncidents = stateData.reduce((sum, item) => sum + item.incidents, 0);
  const totalAffected = awsdData.reduce((sum, item) => sum + item.affected, 0);

  document.getElementById('dashboardTitle').textContent = meta.title;
  document.getElementById('dashboardSubtitle').textContent = `Live intelligence · ${stateData.length} states`;
  document.getElementById('deathBadge').textContent = `${totalDeaths.toLocaleString()} deaths`;
  document.getElementById('incidentBadge').textContent = `${totalIncidents.toLocaleString()} incidents`;
  document.getElementById('awsdBadge').textContent = `${awsdData.length} AWSD records, GPS-mapped`;
  document.getElementById('totalDeathsKpi').textContent = totalDeaths.toLocaleString();
  document.getElementById('totalIncidentsKpi').textContent = totalIncidents.toLocaleString();
  document.getElementById('aidWorkersKpi').textContent = totalAffected.toLocaleString();
  // Aid-incident KPI (reflects the geolocated aid-incident set shown on the map)
  const geo = awsdData.filter(d=>d.year>=2015);
  const matchStates = new Set(geo.map(d=>d.region)).size;
  const mk=document.getElementById('matchKpi'); if(mk) mk.textContent=geo.length.toLocaleString();
  const ms=document.getElementById('matchKpiSub'); if(ms) ms.textContent=`of ${awsdData.length.toLocaleString()} · ${matchStates} states`;
  const hs=document.getElementById('hsCoverage'); if(hs && acledHistory) hs.textContent=histCoverageText();
  renderSparklines();
}

function showLoadError(error) {
  const pill = document.getElementById('infoPill');
  pill.textContent = 'Could not load dashboard_data.json';
  console.error(error);
}

// --- KPI sparklines: one point per year, for the whole country or one state ---
const SPARK_COLORS = {'spark-deaths':'#ff5a5f','spark-incidents':'#f5a623','spark-aid':'#2e8fff'};
function sparkSeries(stateName){
  if (!acledHistory) return {};
  const years = acledHistory.years;
  const region = stateName === 'FCT (Abuja)' ? 'FCT' : stateName;
  return {
    'spark-deaths': histYearly(stateName, 'fatalities'),
    'spark-incidents': histYearly(stateName, 'events'),
    'spark-aid': years.map(year => awsdData
      .filter(d => d.year === year && (!stateName || d.region === region))
      .reduce((sum, d) => sum + d.affected, 0))
  };
}
function renderSparklines(stateName = null){
  const series = sparkSeries(stateName);
  Object.keys(SPARK_COLORS).forEach(id=>{
    const svg=document.getElementById(id); if(!svg) return;
    const data=series[id], color=SPARK_COLORS[id];
    if(!data || data.length<2){ svg.innerHTML=''; return; }
    const W=120,H=34,pad=3;
    const mn=Math.min(...data),mx=Math.max(...data),rng=(mx-mn)||1;
    const pts=data.map((v,i)=>[pad+(i/(data.length-1))*(W-pad*2), H-pad-((v-mn)/rng)*(H-pad*2)]);
    const line=pts.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const area=`${line} L${pts[pts.length-1][0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H} Z`;
    const gid=`g-${id}`;
    svg.innerHTML=`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`+
      `<stop offset="0" stop-color="${color}" stop-opacity="0.35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`+
      `<path d="${area}" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
}


function buildGdeltQuery(config) {
  const keywordQuery = `(${config.keywords.map(term=>`"${term}"`).join(' OR ')})`;
  const sourceCountry = config.sourceCountry ? ` sourcecountry:${config.sourceCountry}` : '';
  const domainQuery = config.restrictToDomains && config.domains?.length
    ? ` (${config.domains.map(domain=>`domainis:${domain}`).join(' OR ')})`
    : '';

  return `${keywordQuery}${sourceCountry}${domainQuery}`;
}

function buildGdeltUrl(config) {
  const params = new URLSearchParams({
    query: buildGdeltQuery(config),
    mode: 'artlist',
    format: 'json',
    sort: config.sort || 'datedesc',
    timespan: config.timespan || '24h',
    maxrecords: String(config.maxRecords || 20)
  });

  return `${config.endpoint}?${params.toString()}`;
}

function formatNewsDate(value) {
  if (!value) return 'recent';
  const normalized = value.includes('T') ? value : value.replace(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,
    '$1-$2-$3T$4:$5:$6Z'
  );
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
}

function formatRelativeSeconds(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function setNavStatus(text, cssState) {
  const wrap = document.getElementById('navStatus');
  const label = document.getElementById('navStatusText');
  if (label) label.textContent = text;
  if (wrap) wrap.classList.remove('is-stale', 'is-error');
  if (wrap && cssState) wrap.classList.add(cssState);
}

function renderLiveFeedIndicator() {
  const indicator = document.getElementById('liveNewsIndicatorText');

  const now = Date.now();
  const lastUpdatedText = liveFeedLastUpdatedAt
    ? formatRelativeSeconds(Math.max(0, Math.floor((now - liveFeedLastUpdatedAt) / 1000)))
    : 'never';
  const nextRefreshText = liveFeedNextRefreshAt
    ? formatRelativeSeconds(Math.max(0, Math.ceil((liveFeedNextRefreshAt - now) / 1000)))
    : '--';

  let text;
  let navShort;
  let navState = null;
  if (liveFeedMode === 'cached') {
    text = `Cached snapshot active. Last live attempt ${lastUpdatedText} ago. Retrying in ${nextRefreshText}.`;
    navShort = `Cached snapshot · retrying in ${nextRefreshText}`;
    navState = 'is-stale';
  } else if (liveFeedMode === 'retrying') {
    text = `Reconnecting to live feeds. Last successful update ${lastUpdatedText} ago. Retrying in ${nextRefreshText}.`;
    navShort = `Reconnecting · retry in ${nextRefreshText}`;
    navState = 'is-error';
  } else if (liveFeedMode === 'connecting') {
    text = 'Connecting to live feeds...';
    navShort = 'Connecting to live feeds…';
    navState = 'is-stale';
  } else {
    text = `Live now. Last updated ${lastUpdatedText} ago. Next refresh in ${nextRefreshText}.`;
    navShort = `Live · updated ${lastUpdatedText} ago`;
  }

  if (indicator) indicator.textContent = text;
  setNavStatus(navShort, navState);
}

function startLiveFeedHeartbeat() {
  if (liveFeedHeartbeatTimer) return;
  renderLiveFeedIndicator();
  liveFeedHeartbeatTimer = setInterval(renderLiveFeedIndicator, 1000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char=>({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

// The server already merges repeated stories (see dedupe_articles in
// dev_server.py). These keys are a second guard for any feed that reaches the
// page another way: same link with different tracking, or the same headline.
function newsUrlKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^(www|m|amp)\./, '')}${u.pathname.replace(/\/(amp\/?)?$/, '')}`.toLowerCase();
  } catch (error) {
    return String(url || '').toLowerCase();
  }
}

function newsTitleKey(title) {
  return String(title || '').toLowerCase()
    .replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, '')   // trailing " - Outlet name"
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeNewsArticles(data) {
  const articles = data.articles || data.items || [];
  const seen = new Set();
  const seenTitles = new Set();

  return articles
    .map(article=>{
      const url = article.url || article.link || '';
      let domain = article.domain || article.source?.name || '';
      if (!domain && url) {
        try { domain = new URL(url).hostname; } catch (error) { domain = 'unknown source'; }
      }
      return {
        title: article.title,
        url,
        domain,
        seenDate: article.seenDate || article.seendate || article.date_published || article.pubDate,
        provider: article.provider || data.provider || 'news',
        matchedKeywords: article.matchedKeywords || [],
        matchedLocations: article.matchedLocations || [],
        alsoReportedBy: article.alsoReportedBy || []
      };
    })
    .filter(article=>{
      if (!article.title || !article.url || !article.url.startsWith('http')) return false;
      const urlKey = newsUrlKey(article.url);
      const titleKey = newsTitleKey(article.title);
      if (seen.has(urlKey) || (titleKey && seenTitles.has(titleKey))) return false;
      seen.add(urlKey);
      if (titleKey) seenTitles.add(titleKey);
      return true;
    });
}

function renderLiveNews(articles, refreshedAt, refreshMinutes, lookbackHours = 24, sourceMode = 'rss', duplicatesRemoved = 0) {
  liveArticles = articles;
  const feed = document.getElementById('liveNewsFeed');
  const status = document.getElementById('liveNewsStatus');
  const badge = document.getElementById('liveNewsBadge');
  const newestArticleUrl = articles[0]?.url || null;
  const shouldHighlightNewest = Boolean(
    newestArticleUrl &&
    lastHighlightedLiveArticleUrl &&
    newestArticleUrl !== lastHighlightedLiveArticleUrl
  );
  const checkedDate = refreshedAt ? new Date(refreshedAt) : new Date();
  const now = Number.isNaN(checkedDate.getTime())
    ? new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
    : checkedDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  const refreshText = ' Auto-refresh is on.';
  const windowText = ` Showing last ${lookbackHours}h.${duplicatesRemoved ? ` ${duplicatesRemoved} repeated ${duplicatesRemoved === 1 ? 'story' : 'stories'} merged.` : ''}`;
  const providerLabel = sourceMode === 'gdelt'
    ? 'GDELT reports'
    : sourceMode === 'cached'
      ? 'cached reports'
      : 'RSS reports';

  feed.innerHTML = '';
  status.textContent = articles.length
    ? `${articles.length} ${providerLabel} found. Last checked ${now}.${windowText}${refreshText}`
    : `No matching live reports found in the last ${lookbackHours}h. Last checked ${now}.${refreshText}`;
  badge.textContent = articles.length
    ? `${sourceMode === 'cached' ? 'RSS: cached' : 'RSS: live'} ${articles.length}`
    : 'RSS: none';
  renderLiveAnalysis(articles, now);

  // Each headline read into a place, figures and a trust level (insights.js).
  articles.forEach(article => { article.incident = extractNewsIncident(article); });
  articles.slice(0, 20).forEach((article,index)=>{
    const highlightClass = shouldHighlightNewest && index === 0 ? ' news-item-fresh' : '';
    const incident = article.incident;
    const facts = incidentFactsText(incident);
    const others = article.alsoReportedBy.length ? ` title="Also reported by ${escapeHtml(article.alsoReportedBy.join(', '))}"` : ` title="${escapeHtml(incident.trust.why)}"`;
    feed.innerHTML += `<a class="inc-item news-item${highlightClass}" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" data-report-index="${index}">
      <div class="news-title">${escapeHtml(article.title)}</div>
      <div class="news-meta"><span class="news-source">${escapeHtml(article.domain)}</span><span class="news-time">${escapeHtml(formatNewsDate(article.seenDate))}</span></div>
      <div class="news-place"><i class="ti ti-map-pin"></i> ${escapeHtml(incident.placeLabel)}${facts ? ` <span class="news-facts">· ${escapeHtml(facts)}</span>` : ''}</div>
      <div class="inc-tags">
        <span class="inc-tag news-type t-${incident.type.key}">${escapeHtml(incident.type.label)}</span>
        ${incident.isIncident ? `<span class="trust trust-${incident.trust.key}"${others}><i class="ti ${incident.trust.key === 'corroborated' ? 'ti-circle-check' : incident.trust.key === 'multiple' ? 'ti-copy' : 'ti-point'}"></i> ${escapeHtml(incident.trust.label)}</span>` : ''}
      </div>
    </a>`;
  });

  feed.querySelectorAll('.news-item').forEach(item=>{
    item.addEventListener('click',event=>{
      event.preventDefault();
      feed.querySelectorAll('.news-item').forEach(node=>node.classList.remove('active'));
      item.classList.add('active');
      const article = liveArticles[Number(item.dataset.reportIndex)];
      showLiveReportOnMap(article);
    });
  });

  if (newestArticleUrl) {
    lastHighlightedLiveArticleUrl = newestArticleUrl;
  }

  updateChartsWithLiveReports(articles);
  // Map pins, the state ranking and the briefing follow the feed too.
  if (typeof window.onDashboardLiveUpdate === 'function') window.onDashboardLiveUpdate();
  renderBriefing();
  checkWatchAlerts();
  // The hotspot index reads the same feed; hotspot.js loads after this file.
  if (typeof onHotspotLiveUpdate === 'function') onHotspotLiveUpdate();
}

function clearNewsTimers() {
  if (newsRefreshTimer) {
    clearTimeout(newsRefreshTimer);
    newsRefreshTimer = null;
  }
}

function scheduleNewsRefresh(delayMs = LIVE_REFRESH_MS) {
  clearNewsTimers();
  liveFeedNextRefreshAt = Date.now() + delayMs;
  renderLiveFeedIndicator();
  newsRefreshTimer = setTimeout(()=>{
    loadLiveNews().catch(showNewsError);
  }, delayMs);
}

function mostFrequent(values) {
  const counts = values.reduce((map, value)=>{
    if (!value) return map;
    map.set(value, (map.get(value) || 0) + 1);
    return map;
  }, new Map());
  return [...counts.entries()].sort((a,b)=>b[1]-a[1])[0] || ['--', 0];
}

function renderLiveAnalysis(articles, checkedAt) {
  const sourceNames = articles.map(article=>article.domain);
  const keywords = articles.flatMap(article=>article.matchedKeywords || []);
  const [topSource] = mostFrequent(sourceNames);
  const [topKeyword] = mostFrequent(keywords);

  document.getElementById('liveReportKpi').textContent = articles.length.toLocaleString();
  document.getElementById('liveSourceKpi').textContent = new Set(sourceNames.filter(Boolean)).size.toLocaleString();
  document.getElementById('topSourceKpi').textContent = topSource;
  document.getElementById('topKeywordKpi').textContent = topKeyword;
  document.getElementById('liveAnalysisNote').textContent = `RSS analysis refreshed at ${checkedAt}. These reports are media leads, not verified incident totals.`;
}

function normalizeLocationName(value) {
  return String(value || '').toLowerCase().replace(/\s+state\b/g, '').replace(/[^a-z\s]/g, '').trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addLocationAlias(alias, stateName, label) {
  const normalizedAlias = normalizeLocationName(alias);
  if (!normalizedAlias) return;
  locationAliasMap.set(normalizedAlias, {
    alias: normalizedAlias,
    stateName,
    label
  });
}

function initializeLocationAliasMap() {
  locationAliasMap = new Map();

  stateData.forEach(state=>{
    const shortName = state.state === 'FCT (Abuja)' ? 'Abuja' : state.state;
    const stateLabel = state.state === 'FCT (Abuja)' ? 'Abuja, FCT' : `${shortName}, ${state.state}`;
    addLocationAlias(shortName, state.state, stateLabel);
    addLocationAlias(state.state, state.state, stateLabel);
  });

  [
    ['fct', 'FCT (Abuja)', 'Abuja, FCT'],
    ['federal capital territory', 'FCT (Abuja)', 'Abuja, FCT'],
    ['abuja', 'FCT (Abuja)', 'Abuja, FCT'],
    ['oriire', 'Oyo', 'Oriire, Oyo State'],
    ['ogbomoso', 'Oyo', 'Ogbomoso, Oyo State'],
    ['ogbomoso north', 'Oyo', 'Ogbomoso North, Oyo State'],
    ['ogbomoso south', 'Oyo', 'Ogbomoso South, Oyo State'],
    ['ibadan', 'Oyo', 'Ibadan, Oyo State'],
    ['damaturu', 'Yobe', 'Damaturu, Yobe State'],
    ['potiskum', 'Yobe', 'Potiskum, Yobe State'],
    ['geidam', 'Yobe', 'Geidam, Yobe State'],
    ['buni yadi', 'Yobe', 'Buni Yadi, Yobe State'],
    ['gashua', 'Yobe', 'Gashua, Yobe State'],
    ['maiduguri', 'Borno', 'Maiduguri, Borno State'],
    ['monguno', 'Borno', 'Monguno, Borno State'],
    ['gwoza', 'Borno', 'Gwoza, Borno State'],
    ['damboa', 'Borno', 'Damboa, Borno State'],
    ['ngala', 'Borno', 'Ngala, Borno State'],
    ['rann', 'Borno', 'Rann, Borno State'],
    ['damasak', 'Borno', 'Damasak, Borno State'],
    ['jos', 'Plateau', 'Jos, Plateau State'],
    ['makurdi', 'Benue', 'Makurdi, Benue State'],
    ['anka', 'Zamfara', 'Anka, Zamfara State'],
    ['gwadabawa', 'Sokoto', 'Gwadabawa, Sokoto State'],
    ['batagarawa', 'Katsina', 'Batagarawa, Katsina State'],
    ['akure', 'Ondo', 'Akure, Ondo State'],
    ['abakpa nike', 'Enugu', 'Abakpa Nike, Enugu State'],
    ['mbiakong', 'Akwa Ibom', 'Mbiakong, Akwa Ibom State'],
    ['tomanyi', 'Benue', 'Tomanyi, Benue State'],
    ['kajuru', 'Kaduna', 'Kajuru, Kaduna State'],
    ['keffi', 'Nasarawa', 'Keffi, Nasarawa State']
  ].forEach(([alias, stateName, label])=>addLocationAlias(alias, stateName, label));

  locationAliasKeys = [...locationAliasMap.keys()].sort((a,b)=>b.length-a.length);
}

function locationMatchesText(alias, text) {
  return new RegExp(`\\b${escapeRegex(alias).replace(/\s+/g, '\\s+')}\\b`, 'i').test(text);
}

function resolveArticleLocations(article) {
  const title = normalizeLocationName(article.title);
  const matchedLocations = (article.matchedLocations || []).map(normalizeLocationName);
  const resolved = [];
  const seenStates = new Set();

  const pushLocation = entry => {
    if (!entry || seenStates.has(entry.stateName)) return;
    resolved.push(entry);
    seenStates.add(entry.stateName);
  };

  locationAliasKeys.forEach(alias=>{
    if (locationMatchesText(alias, title)) {
      pushLocation(locationAliasMap.get(alias));
    }
  });

  matchedLocations.forEach(location=>{
    if (location === 'nigeria' || location === 'nigerian') return;
    pushLocation(locationAliasMap.get(location));
  });

  return resolved;
}

function stateObjectByName(stateName) {
  return stateData.find(state=>state.state === stateName) || null;
}

function statesForArticle(article) {
  return resolveArticleLocations(article)
    .map(location=>stateObjectByName(location.stateName))
    .filter(Boolean);
}

function primaryLocationForArticle(article) {
  return resolveArticleLocations(article)[0] || null;
}

function primaryStateForArticle(article) {
  const location = primaryLocationForArticle(article);
  return location ? stateObjectByName(location.stateName) : null;
}

function focusStateOnMap(state, popupTitle, popupBody) {
  if (!state || !mapInstance || !liveReportLayer) return;

  liveReportLayer.clearLayers();
  const marker = L.circleMarker([state.lat, state.lng], {
    radius:20,
    fillColor:'#3fb950',
    fillOpacity:0.34,
    color:'#9ff5b4',
    weight:3,
    opacity:1
  }).bindPopup(`
    <div class="popup-title">${escapeHtml(popupTitle)}</div>
    ${popupBody}
  `).addTo(liveReportLayer);

  mapInstance.flyTo([state.lat, state.lng], 8, {duration:1.25});
  setTimeout(()=>marker.openPopup(), 350);
}

function showLiveReportOnMap(article) {
  if (!article || !mapInstance || !liveReportLayer) return;
  if (typeof window.openNewsPin === 'function' && window.openNewsPin(article)) return;

  const matchedLocation = primaryLocationForArticle(article);
  const matchedState = primaryStateForArticle(article);
  const pill = document.getElementById('infoPill');
  const mapPanel = document.querySelector('.map-center');

  if (!matchedState || !matchedLocation) {
    pill.textContent = 'No Nigerian state could be matched reliably to this report.';
    setTimeout(()=>{pill.textContent='Click any marker for incident details. Scroll to zoom.';},4000);
    return;
  }

  mapPanel?.scrollIntoView({behavior:'smooth', block:'center'});
  focusStateOnMap(
    matchedState,
    `Live RSS Report - ${matchedLocation.label}`,
    `
      <div class="popup-row"><span>State</span><span>${escapeHtml(matchedState.state)}</span></div>
      <div class="popup-row"><span>Source</span><span>${escapeHtml(article.domain)}</span></div>
      <div class="popup-row"><span>Published</span><span>${escapeHtml(formatNewsDate(article.seenDate))}</span></div>
      <div class="popup-detail">${escapeHtml(article.title)}</div>
      <div class="popup-detail"><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">Open source report</a></div>
    `
  );
  pill.textContent = `Live report mapped to ${matchedLocation.label}.`;
  setTimeout(()=>{pill.textContent='Click any marker for incident details. Scroll to zoom.';},5000);
}

function classifyLiveAttack(article) {
  const text = normalizeLocationName(`${article.title} ${(article.matchedKeywords || []).join(' ')}`);
  if (text.includes('kidnap') || text.includes('abduct')) return 'Kidnapping';
  if (text.includes('kill') || text.includes('shoot') || text.includes('behead')) return 'Shooting/Killing';
  if (text.includes('iswap') || text.includes('boko haram') || text.includes('bandit') || text.includes('attack')) return 'Armed attack';
  if (text.includes('security') || text.includes('police') || text.includes('forces')) return 'Security operations';
  return 'Other';
}

function classifyHistoricalAttack(record) {
  const text = normalizeLocationName(record.attack || '');
  if (text.includes('kidnap')) return 'Kidnapping';
  if (text.includes('shoot') || text.includes('kill') || text.includes('ied') || text.includes('aerial')) return 'Shooting/Killing';
  if (text.includes('complex') || text.includes('raid') || text.includes('ambush')) return 'Armed attack';
  if (text.includes('assault')) return 'Assault';
  return 'Other';
}

function countBy(items, getKey) {
  const counts = new Map();
  items.forEach(item=>{
    const key = getKey(item);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

function topKeysFromCounts(countMaps, limit = 6) {
  const merged = new Map();
  countMaps.forEach(map=>{
    map.forEach((value, key)=>{
      merged.set(key, (merged.get(key) || 0) + value);
    });
  });
  return [...merged.entries()]
    .sort((a,b)=>b[1]-a[1])
    .slice(0, limit)
    .map(([key])=>key);
}

function updateChartsWithLiveReports(articles) {
  if (!attackDonutChart) return;

  // "Historical" side reflects the active filter when one is applied.
  const hist = chartFilterSet || awsdData;
  const attackLabels = ['Kidnapping','Shooting/Killing','Armed attack','Assault','Security operations','Other'];
  const ATTACK_COLORS = {
    'Kidnapping':'#bc8cff','Shooting/Killing':'#f85149','Armed attack':'#d29922',
    'Assault':'#58a6ff','Security operations':'#3fb950','Other':'#8b949e'
  };
  const historicalAttackCounts = countBy(hist, classifyHistoricalAttack);
  const currentAttackCounts = countBy(articles, classifyLiveAttack);
  // Incident-type mix: one bar per type, coloured by type (historical + live combined).
  attackDonutChart.data.labels = attackLabels;
  attackDonutChart.data.datasets = [{
    label:'Incidents',
    data:attackLabels.map(label=>(historicalAttackCounts.get(label) || 0) + (currentAttackCounts.get(label) || 0)),
    backgroundColor:attackLabels.map(label=>ATTACK_COLORS[label] || '#8b949e'),
    borderRadius:4
  }];
  attackDonutChart.update();
}

async function loadLiveNews() {
  if (newsUpdateInFlight) return;
  newsUpdateInFlight = true;
  liveFeedMode = liveFeedMode === 'cached' ? 'cached' : 'connecting';
  renderLiveFeedIndicator();
  const status = document.getElementById('liveNewsStatus');
  const badge = document.getElementById('liveNewsBadge');
  status.textContent = 'Checking live sources...';

  let lookbackHours = 24;
  const liveEndpoints = [
    '/api/live-news',
    'http://127.0.0.1:8085/api/live-news',
    'http://localhost:8085/api/live-news',
    'http://127.0.0.1:8081/api/live-news',
    'http://localhost:8081/api/live-news',
    'http://localhost:8084/api/live-news',
    'http://localhost:8083/api/live-news',
    'http://localhost:8082/api/live-news'
  ];

  try {
    for (const endpoint of liveEndpoints) {
      try {
        const liveUrl = `${endpoint}${endpoint.includes('?') ? '&' : '?'}t=${Date.now()}`;
        const liveResponse = await fetch(liveUrl, {cache:'no-store'});
        if (!liveResponse.ok) continue;

        const liveData = await liveResponse.json();
        lookbackHours = Math.max(1, Number(liveData.lookbackHours) || lookbackHours);
        const liveArticles = normalizeNewsArticles(liveData);
        liveArticles.forEach(article=>{ article.provider = liveData.provider || article.provider; });
        renderLiveNews(
          liveArticles,
          liveData.refreshedAt,
          Math.round(LIVE_REFRESH_MS / 60000),
          lookbackHours,
          liveData.sourceMode || liveData.provider || 'rss',
          Number(liveData.duplicatesRemoved) || 0
        );
        liveFeedLastUpdatedAt = Date.now();
        if (liveData.isCachedSnapshot) {
          liveFeedMode = 'cached';
          status.textContent = `Showing the latest cached snapshot from ${formatNewsDate(liveData.refreshedAt)} while live feeds reconnect.`;
          badge.textContent = `RSS: cached ${liveArticles.length}`;
          document.getElementById('liveAnalysisNote').textContent = 'Cached source leads are temporarily shown while the dashboard retries live feeds in the background.';
          scheduleNewsRefresh(LIVE_RETRY_MS);
        } else {
          liveFeedMode = 'live';
          document.getElementById('liveAnalysisNote').textContent = `RSS analysis refreshed at ${formatNewsDate(liveData.refreshedAt)}. These reports are media leads, not verified incident totals.`;
          scheduleNewsRefresh(LIVE_REFRESH_MS);
        }
        renderLiveFeedIndicator();
        return;
      } catch (error) {
        console.warn(`Live endpoint unavailable: ${endpoint}`, error);
      }
    }
    throw new Error('No live news endpoint responded');
  } finally {
    newsUpdateInFlight = false;
  }
}

function showNewsError(error) {
  const status = document.getElementById('liveNewsStatus');
  const badge = document.getElementById('liveNewsBadge');
  liveFeedMode = 'retrying';
  status.textContent = 'Live news is temporarily unavailable. Retrying automatically...';
  badge.textContent = 'RSS: reconnecting';
  scheduleNewsRefresh(LIVE_RETRY_MS);
  renderLiveFeedIndicator();
  console.error(error);
}

function setupLiveFeedListeners() {
  window.addEventListener('focus', ()=>{ loadLiveNews().catch(showNewsError); });
  window.addEventListener('online', ()=>{ loadLiveNews().catch(showNewsError); });
  document.addEventListener('visibilitychange', ()=>{
    if (!document.hidden) {
      loadLiveNews().catch(showNewsError);
    }
  });
}
function initDashboard(data) {
  stateData = data.stateData;
  awsdData = data.awsdData;
  chartData = data.charts;
  adoptHistory(data.history);
  // These helpers are declared inside this function's scope but are invoked from
  // inline handlers / top-level updateSummary, so expose them on the global object.
  Object.assign(window, {
    renderSparklines, toggleLayersPanel, updateLayerCount, setRange, toggleSevPill,
    resetFilters, switchReportTab, handleGlobalSearch, onTimeSlider, toggleTimePlay,
    applyTimeFilter, applyFilters, setDashMetric, selectDashState, toggleLegendPanel, shortStateName, focusLga
  });
  initializeLocationAliasMap();
  updateSummary(data.meta);
  startLiveFeedHeartbeat();
  setupLiveFeedListeners();
  loadLiveNews().catch(showNewsError);

// MAP
const map=L.map('map',{zoomControl:true});
// Fit the frame to Nigeria's full extent by default.
const NIGERIA_BOUNDS = L.latLngBounds([[4.1, 2.6], [13.95, 14.7]]);
map.fitBounds(NIGERIA_BOUNDS, {padding:[8,8]});
mapInstance = map;
liveReportLayer = L.layerGroup().addTo(map);
const initTile = document.documentElement.getAttribute('data-theme') === 'light' ? LIGHT_TILE : DARK_TILE;
mainTileLayer = L.tileLayer(initTile, TILE_OPTS).addTo(map);

const maxDeaths=Math.max(...stateData.map(d=>d.deaths));
function dColor(d){return d>2000?'#f85149':d>800?'#d29922':'#58a6ff';}
function dRadius(d){return Math.max(8,Math.sqrt(d/maxDeaths)*56);}

// AID-INCIDENT CHOROPLETH — states shaded by the number of (filtered) aid-worker
// incidents. Opt-in layer; recoloured live by applyFilters() via a relative scale
// so shading stays readable whatever the active filter.
// Normalise state names so dashboard_data.json / AWSD regions match the GeoJSON
// shapeName (only FCT differs: "FCT (Abuja)" vs "Abuja Federal Capital Territory").
function normState(n){
  n = String(n||'').toLowerCase().replace(/[().]/g,' ').replace(/\s+/g,' ').trim();
  if (n.includes('abuja') || n.includes('federal capital') || n === 'fct') return 'fct';
  return n;
}
const stateMetaByNorm = new Map(); // ACLED context per state (deaths, incidents)
stateData.forEach(s => stateMetaByNorm.set(normState(s.state), s));
let choroCounts = new Map();        // normState -> filtered aid-incident count
let choroMax = 1;
function choroColor(c){
  if (!c) return '#2a3344';
  const r = c / (choroMax || 1);
  return r > 0.75 ? HEAT_CLASSES[4] :
         r > 0.5  ? HEAT_CLASSES[3] :
         r > 0.25 ? HEAT_CLASSES[2] : HEAT_CLASSES[1];
}
function choroStyle(f){
  const c = choroCounts.get(normState(f.properties.shapeName)) || 0;
  return { fillColor: choroColor(c), fillOpacity: c ? 0.8 : 0.3, color: '#0b1420', weight: 1, opacity: 0.55 };
}
function choroPopup(f){
  const norm = normState(f.properties.shapeName);
  const meta = stateMetaByNorm.get(norm);
  const name = meta ? meta.state : f.properties.shapeName;
  const cnt = choroCounts.get(norm) || 0;
  return `
    <div class="popup-title">&#x1F4CD; ${escapeHtml(name)} State</div>
    <div class="popup-row"><span>Aid incidents (filtered)</span><span class="popup-metric-danger">${cnt}</span></div>
    ${meta ? `<div class="popup-row"><span>Total deaths (ACLED)</span><span>${meta.deaths.toLocaleString()}</span></div>
    <div class="popup-row"><span>ACLED incidents</span><span>${meta.incidents.toLocaleString()}</span></div>` : ''}`;
}
let bubbleLayer = L.geoJSON(null, {
  style: choroStyle,
  onEachFeature: (f, layer) => {
    layer.bindPopup(choroPopup(f));
    layer.on({
      mouseover: e => e.target.setStyle({ weight: 2, color: '#ffffff' }),
      mouseout:  e => bubbleLayer.resetStyle(e.target)
    });
  }
});
function refreshChoropleth(){
  if (!bubbleLayer) return;
  bubbleLayer.setStyle(choroStyle);
  bubbleLayer.eachLayer(l => { if (l.feature) l.setPopupContent(choroPopup(l.feature)); });
}
// ── ACLED deaths / incidents: the metric, year window and state in focus ──
// The Total Deaths and Incidents cards pick the metric, the year filter and
// time slider pick the window, and a click on a bubble picks the state. The
// bubbles, state shading, cards, sparklines and the ACLED charts all follow.
const DASH_METRICS = {
  deaths:    { series: 'fatalities', title: 'Deaths',    card: 'Total Deaths', color: '#ff5a5f' },
  incidents: { series: 'events',     title: 'Incidents', card: 'Incidents',    color: '#f5a623' }
};
const dash = { metric: 'deaths', state: null };
const HIST_FIRST = acledHistory ? acledHistory.meta.firstYear : 2015;
const HIST_LAST = acledHistory ? acledHistory.meta.lastYear : 2026;

// Year range picked in the "Year range" select, e.g. "2019-2021" or "2022+".
function yearSelectRange(){
  const m = /^(\d{4})(?:-(\d{4})|\+)$/.exec(document.getElementById('yearFilter').value);
  return m ? { from: +m[1], to: m[2] ? +m[2] : HIST_LAST } : { from: HIST_FIRST, to: HIST_LAST };
}
function dashWindow(){
  const range = yearSelectRange();
  return { from: range.from, to: Math.min(range.to, timeYearMax) };
}
function windowText(win){
  return win.to < win.from ? 'no years selected' : win.from === win.to ? String(win.from) : `${win.from}–${win.to}`;
}
function dashValue(stateName, metric, win){
  if (acledHistory) return histTotal(stateName, DASH_METRICS[metric].series, win.from, win.to);
  // No history file: only the all-time totals in dashboard_data.json are known.
  return stateName
    ? (stateObjectByName(stateName)?.[metric] || 0)
    : stateData.reduce((sum, s) => sum + s[metric], 0);
}
function shortStateName(name){ return name === 'FCT (Abuja)' ? 'FCT' : name; }
function niceNumber(value){
  if (value <= 10) return Math.max(1, Math.round(value));
  const step = Math.pow(10, Math.floor(Math.log10(value)) - 1);
  return Math.round(value / step) * step;
}

// Bubbles: one proportional circle per state.
const BUBBLE_MIN = 4, BUBBLE_SPAN = 26;
function bubbleRadius(value, max){ return value > 0 ? BUBBLE_MIN + Math.sqrt(value / (max || 1)) * BUBBLE_SPAN : 3; }
function acledPopup(s){
  const win = dashWindow();
  const row = histState(s.state);
  const deaths = dashValue(s.state, 'deaths', win), incidents = dashValue(s.state, 'incidents', win);
  const lgas = histTopLgas(s.state, DASH_METRICS[dash.metric].series, win.from, win.to);
  return `
    <div class="popup-title">&#x1F4CD; ${escapeHtml(s.state)}${row ? ` &middot; ${escapeHtml(row.zone)}` : ''}</div>
    <div class="popup-row"><span>Period</span><span>${windowText(win)}</span></div>
    <div class="popup-row"><span>Deaths</span><span class="popup-metric-danger">${deaths.toLocaleString()}</span></div>
    <div class="popup-row"><span>Incidents</span><span>${incidents.toLocaleString()}</span></div>
    ${row ? `<div class="popup-row"><span>Civilians killed</span><span>${histTotal(s.state, 'civFatalities', win.from, win.to).toLocaleString()}</span></div>` : ''}
    ${lgas.length ? `<div class="popup-lgas"><div class="popup-lgas-hd">Most affected LGAs &middot; ${DASH_METRICS[dash.metric].title.toLowerCase()}</div>
      ${lgas.map(lga => `<div class="popup-row"><span>${escapeHtml(lga.name)}</span><span>${lga.value.toLocaleString()}</span></div>`).join('')}</div>` : ''}`;
}
const acledLayer = L.layerGroup();
const acledMarkers = new Map();
stateData.forEach(s => {
  const marker = L.circleMarker([s.lat, s.lng], { radius: 6, weight: 1.2 })
    .bindPopup(() => acledPopup(s))
    .bindTooltip('', { direction: 'top', sticky: true });
  marker.on('click', () => selectDashState(s.state));
  marker.addTo(acledLayer);
  acledMarkers.set(s.state, marker);
});
function refreshBubbles(win){
  const def = DASH_METRICS[dash.metric];
  const values = new Map(stateData.map(s => [s.state, dashValue(s.state, dash.metric, win)]));
  const max = Math.max(1, ...values.values());
  acledMarkers.forEach((marker, name) => {
    const value = values.get(name), picked = dash.state === name;
    marker.setRadius(bubbleRadius(value, max));
    const t = Math.sqrt(value / max);
    marker.setStyle({
      fillColor: heatColor(t), color: picked ? '#ffffff' : '#0b1420', weight: picked ? 3 : 1,
      opacity: picked ? 1 : 0.55, fillOpacity: dash.state && !picked ? 0.18 : 0.78
    });
    marker.setTooltipContent(`<strong>${escapeHtml(name)}</strong><br>${value.toLocaleString()} ${def.title.toLowerCase()} &middot; ${windowText(win)}`);
  });
  // Smallest circles on top so every state stays clickable.
  if (map.hasLayer(acledLayer)) {
    [...values.entries()].sort((a, b) => b[1] - a[1]).forEach(([name]) => acledMarkers.get(name).bringToFront());
  }
  const scale = document.getElementById('legAcledScale');
  const steps = [...new Set([max, max / 4, max / 20].map(niceNumber))].filter(v => v > 0);
  scale.innerHTML = steps.map(v => {
    const d = Math.round(bubbleRadius(Math.min(v, max), max) * 2);
    return `<span class="leg-bubble" style="--bub:${heatColor(Math.sqrt(Math.min(v, max) / max))}"><i style="width:${d}px;height:${d}px"></i>${formatCompact(v)}</span>`;
  }).join('');
  document.getElementById('legAcledTitle').textContent = `${def.title} by state · ${windowText(win)}`;
  return values;
}

// State shading: the same metric as five classes, split so each holds a
// similar number of states whatever the window.
const SHADE_COLORS = HEAT_CLASSES;
let shadeValues = new Map(), shadeBreaks = [];
function shadeColor(value){
  if (!value) return '#2a3344';
  let i = 0;
  while (i < shadeBreaks.length && value > shadeBreaks[i]) i++;
  return SHADE_COLORS[i];
}
function deathsChoroStyle(f){
  const meta = stateMetaByNorm.get(normState(f.properties.shapeName));
  const value = meta ? shadeValues.get(meta.state) || 0 : 0;
  return { fillColor: shadeColor(value), fillOpacity: value ? 0.72 : 0.3, color: '#0b1420', weight: 1, opacity: 0.55 };
}
let deathsLayer = L.geoJSON(null, {
  style: deathsChoroStyle,
  onEachFeature: (f, layer) => {
    const meta = stateMetaByNorm.get(normState(f.properties.shapeName));
    if (meta) {
      layer.bindPopup(() => acledPopup(meta));
      layer.on('click', () => selectDashState(meta.state));
    }
    layer.on({
      mouseover: e => e.target.setStyle({ weight: 2, color: '#ffffff' }),
      mouseout:  e => deathsLayer.resetStyle(e.target)
    });
  }
});
function refreshShading(values, win){
  shadeValues = values;
  const sorted = [...values.values()].filter(v => v > 0).sort((a, b) => a - b);
  shadeBreaks = [...new Set([0.2, 0.4, 0.6, 0.8]
    .map(q => niceNumber(sorted[Math.floor(q * (sorted.length - 1))] || 0)))].filter(v => v > 0);
  deathsLayer.setStyle(deathsChoroStyle);
  const def = DASH_METRICS[dash.metric];
  document.getElementById('legShadeTitle').textContent = `${def.title} by state · ${windowText(win)}`;
  const rows = [];
  for (let i = shadeBreaks.length; i >= 0; i--) {
    const label = i === shadeBreaks.length ? `&gt; ${shadeBreaks[i - 1].toLocaleString()}`
      : i === 0 ? `&le; ${shadeBreaks[0].toLocaleString()}`
      : `${shadeBreaks[i - 1].toLocaleString()} – ${shadeBreaks[i].toLocaleString()}`;
    rows.push(`<div class="leg-row"><span class="leg-swatch" style="background:${SHADE_COLORS[i]}"></span>${shadeBreaks.length ? label : 'Any'}</div>`);
  }
  rows.push('<div class="leg-row"><span class="leg-swatch" style="background:#2a3344"></span>None recorded</div>');
  document.getElementById('legShadeRows').innerHTML = rows.join('');
}

// Live news: one pin per report, at the LGA it names (else its state), coloured
// by the kind of incident and ringed by how well it is corroborated.
const liveLayer = L.layerGroup();
const newsPins = new Map();   // article url -> marker
function liveArticlesByState(){
  const byState = new Map();
  liveArticles.forEach(article => statesForArticle(article).forEach(state => {
    if (!byState.has(state.state)) byState.set(state.state, []);
    byState.get(state.state).push(article);
  }));
  return byState;
}
function newsPinPopup(incident){
  const a = incident.article;
  const facts = incidentFactsText(incident);
  return `
    <div class="popup-title">${escapeHtml(incident.type.label)} &middot; ${escapeHtml(incident.placeLabel)}</div>
    <a class="popup-news" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title)}<small>${escapeHtml(a.domain)} &middot; ${escapeHtml(formatNewsDate(a.seenDate))}</small></a>
    ${facts ? `<div class="popup-row"><span>Reported in headline</span><span>${escapeHtml(facts)}</span></div>` : ''}
    <div class="popup-row"><span>Trust</span><span class="trust trust-${incident.trust.key}">${escapeHtml(incident.trust.label)}</span></div>
    <div class="popup-detail">${escapeHtml(incident.trust.why)}${a.alsoReportedBy.length ? ` (also ${escapeHtml(a.alsoReportedBy.join(', '))})` : ''}.${incident.precise ? '' : ' Placed at the state centre: no local government area is named.'}</div>`;
}
function refreshLiveLayer(){
  liveLayer.clearLayers();
  newsPins.clear();
  const stacked = new Map();   // spread pins that share a spot
  newsIncidents().forEach(incident => {
    if (!incident.point) return;
    const key = incident.point.join(',');
    const n = stacked.get(key) || 0;
    stacked.set(key, n + 1);
    const angle = n * 2.4, r = n ? 0.07 + n * 0.012 : 0;
    const at = [incident.point[0] + Math.sin(angle) * r, incident.point[1] + Math.cos(angle) * r];
    const marker = L.marker(at, {
      icon: L.divIcon({ html: `<span class="news-pin t-${incident.type.key} trust-ring-${incident.trust.key}"></span>`, className: '', iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 700, title: incident.article.title, keyboard: true
    }).bindPopup(() => newsPinPopup(incident), { maxWidth: 280 }).addTo(liveLayer);
    newsPins.set(incident.article.url, marker);
  });
}
window.openNewsPin = article => {
  const marker = newsPins.get(article.url);
  if (!marker) return false;
  if (!layerState.live) toggleLayer(document.querySelector('.toggle-btn[data-layer="live"]'));
  document.querySelector('.map-center')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), article.incident?.precise ? 9 : 7), { duration: 0.9 });
  setTimeout(() => marker.openPopup(), 950);
  return true;
};

// Rising now: a pulsing ring on each LGA whose incidents are well above usual.
const risingLayer = L.layerGroup();
function refreshRisingLayer(){
  risingLayer.clearLayers();
  risingNow().forEach(item => {
    if (item.lat == null) return;
    const lvl = RISING_LEVELS[item.level];
    L.marker([item.lat, item.lng], {
      icon: L.divIcon({ html: `<span class="rise-pin ${lvl.cls}"><i class="ti ti-trending-up"></i></span>`, className: '', iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 650, title: `${item.name}: ${lvl.label.toLowerCase()}`
    }).bindPopup(() => `
      <div class="popup-title"><span class="lvl ${lvl.cls}">${lvl.label}</span> ${escapeHtml(item.name)}, ${escapeHtml(item.state)}</div>
      <div class="popup-row"><span>Incidents, ${escapeHtml(item.period)}</span><span class="popup-metric-danger">${item.recent.toLocaleString()}</span></div>
      <div class="popup-row"><span>Usual for three months</span><span>${item.usual.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></div>
      <div class="popup-row"><span>Deaths, ${escapeHtml(item.period)}</span><span>${item.deaths.toLocaleString()}</span></div>
      <div class="popup-detail">"Usual" is the monthly average over the previous twelve months, times three (ACLED).
        <button type="button" class="popup-btn" onclick="watchLga('${escapeHtml(item.pcode)}')"><i class="ti ti-star"></i> ${isWatched({ type: 'lga', pcode: item.pcode }) ? 'Watching' : 'Watch this LGA'}</button></div>`)
      .addTo(risingLayer);
  });
}

// LGA detail: the local government areas of the state in focus, shaded by
// the active metric over the year window.
const LGA_COLORS = HEAT_CLASSES;
const lgaFocusLayer = L.geoJSON(null, {
  style: () => ({ color: '#ffffff', weight: 0.8, opacity: 0.7, fillOpacity: 0.6, fillColor: '#2a3344' }),
  onEachFeature: (f, layer) => layer.bindPopup(() => lgaPopup(f.properties))
});
let lgaFocusValues = new Map(), lgaFocusBreaks = [];
function lgaValue(pcode, series, win){
  const lga = lgaByPcode.get(pcode);
  const row = lga && histState(lga.state);
  const item = row && row.lgas.find(l => l.pcode === pcode);
  if (!item) return 0;
  return item[series].reduce((sum, v, yi) => {
    const year = acledHistory.years[yi];
    return year >= win.from && year <= win.to ? sum + v : sum;
  }, 0);
}
function lgaPopup(props){
  const win = dashWindow();
  const idp = displacementData?.lgas[props.pcode];
  const rise = risingNow().find(item => item.pcode === props.pcode);
  return `
    <div class="popup-title">&#x1F4CD; ${escapeHtml(props.name)} LGA &middot; ${escapeHtml(props.state)}</div>
    <div class="popup-row"><span>Period</span><span>${windowText(win)}</span></div>
    <div class="popup-row"><span>Deaths</span><span class="popup-metric-danger">${lgaValue(props.pcode, 'fatalities', win).toLocaleString()}</span></div>
    <div class="popup-row"><span>Incidents</span><span>${lgaValue(props.pcode, 'events', win).toLocaleString()}</span></div>
    ${idp ? `<div class="popup-row"><span>Displaced people (IOM)</span><span>${idp.idps.toLocaleString()}</span></div>` : ''}
    ${rise ? `<div class="popup-detail"><span class="lvl ${RISING_LEVELS[rise.level].cls}">${RISING_LEVELS[rise.level].label}</span> ${escapeHtml(risingExplain(rise))}</div>` : ''}
    <div class="popup-detail"><button type="button" class="popup-btn" onclick="watchLga('${escapeHtml(props.pcode)}')"><i class="ti ti-star"></i> ${isWatched({ type: 'lga', pcode: props.pcode }) ? 'Watching' : 'Watch this LGA'}</button></div>`;
}
function lgaFocusColor(value){
  if (!value) return '#2a3344';
  let i = 0;
  while (i < lgaFocusBreaks.length && value > lgaFocusBreaks[i]) i++;
  return LGA_COLORS[i];
}
function refreshLgaFocus(win){
  lgaFocusLayer.clearLayers();
  const legend = document.getElementById('legLgaRows');
  const show = Boolean(dash.state && lgaGeo && layerState.acled);
  document.querySelector('[data-legend="lgaFocus"]').dataset.on = show ? '1' : '';
  if (show) {
    const def = DASH_METRICS[dash.metric];
    const features = lgaGeo.features.filter(f => f.properties.state === dash.state);
    lgaFocusValues = new Map(features.map(f => [f.properties.pcode, lgaValue(f.properties.pcode, def.series, win)]));
    const sorted = [...lgaFocusValues.values()].filter(v => v > 0).sort((a, b) => a - b);
    lgaFocusBreaks = [...new Set([0.2, 0.4, 0.6, 0.8].map(q => niceNumber(sorted[Math.floor(q * (sorted.length - 1))] || 0)))].filter(v => v > 0);
    lgaFocusLayer.addData({ type: 'FeatureCollection', features });
    lgaFocusLayer.setStyle(f => {
      const v = lgaFocusValues.get(f.properties.pcode) || 0;
      return { color: '#ffffff', weight: 0.8, opacity: 0.75, fillColor: lgaFocusColor(v), fillOpacity: v ? 0.72 : 0.25 };
    });
    lgaFocusLayer.bringToBack();
    document.getElementById('legLgaTitle').textContent = `${def.title} by LGA · ${shortStateName(dash.state)} · ${windowText(win)}`;
    const rows = [];
    for (let i = lgaFocusBreaks.length; i >= 0; i--) {
      const label = !lgaFocusBreaks.length ? 'Any' : i === lgaFocusBreaks.length ? `&gt; ${lgaFocusBreaks[i - 1].toLocaleString()}`
        : i === 0 ? `&le; ${lgaFocusBreaks[0].toLocaleString()}` : `${lgaFocusBreaks[i - 1].toLocaleString()} – ${lgaFocusBreaks[i].toLocaleString()}`;
      rows.push(`<div class="leg-row"><span class="leg-swatch" style="background:${LGA_COLORS[i]}"></span>${label}</div>`);
    }
    rows.push('<div class="leg-row"><span class="leg-swatch" style="background:#2a3344"></span>None recorded</div>');
    legend.innerHTML = rows.join('');
  }
  syncLegend();
}

// Reference layers: every LGA outline, and people displaced by LGA (IOM DTM).
const lgaLinesLayer = L.geoJSON(null, {
  style: { color: '#9fb3c8', weight: 0.6, opacity: 0.55, fill: false },
  interactive: false
});
const IDP_COLORS = ['#e9dcff', '#c9a8ff', '#a477f5', '#7c4dd6', '#4f2a99'];
const IDP_BREAKS = [5000, 20000, 50000, 100000];
function idpColor(n){ let i = 0; while (i < IDP_BREAKS.length && n > IDP_BREAKS[i]) i++; return IDP_COLORS[i]; }
const displacedLayer = L.geoJSON(null, {
  filter: f => Boolean(displacementData?.lgas[f.properties.pcode]),
  style: f => ({ color: '#4f2a99', weight: 0.6, opacity: 0.6, fillColor: idpColor(displacementData.lgas[f.properties.pcode].idps), fillOpacity: 0.7 }),
  onEachFeature: (f, layer) => layer.bindPopup(() => {
    const d = displacementData.lgas[f.properties.pcode];
    const [y, m] = d.asOf.split('-').map(Number);
    return `<div class="popup-title">${escapeHtml(f.properties.name)} LGA &middot; ${escapeHtml(f.properties.state)}</div>
      <div class="popup-row"><span>Displaced people</span><span>${d.idps.toLocaleString()}</span></div>
      <div class="popup-row"><span>Counted</span><span>${MONTH_LABELS[m - 1]} ${y}</span></div>
      <div class="popup-detail">IOM Displacement Tracking Matrix, latest round covering this LGA.</div>`;
  })
});
// Fill the outline layers once the boundaries have loaded.
function fillLgaLayers(){
  if (!lgaGeo) return;
  if (!lgaLinesLayer.getLayers().length) lgaLinesLayer.addData(lgaGeo);
  if (displacementData && !displacedLayer.getLayers().length) displacedLayer.addData(lgaGeo);
}

// Change against the year before. An unfinished final year is compared over
// its complete months only (the latest month is still being reported).
function dashDelta(stateName, series, win){
  if (!acledHistory || win.to < win.from) return null;
  const { firstYear, lastYear, lastMonth } = acledHistory.meta;
  const year = win.to;
  if (year - 1 < firstYear) return null;
  const months = year === lastYear && lastMonth < 12 ? lastMonth - 1 : 12;
  if (months < 1) return null;
  const yearly = histYearly(stateName, series, months);
  const yi = acledHistory.years.indexOf(year);
  const current = yearly[yi], previous = yearly[yi - 1];
  if (!previous) return null;
  const pct = ((current - previous) / previous) * 100;
  const span = months < 12 ? `${months === 1 ? 'Jan' : `Jan–${MONTH_LABELS[months - 1]}`} ${year - 1}` : String(year - 1);
  return { pct, text: `${pct > 0 ? '↑' : pct < 0 ? '↓' : '→'} ${Math.abs(pct).toFixed(1)}% vs ${span}` };
}
function renderDashKpis(win){
  const scope = dash.state ? ` · ${shortStateName(dash.state)}` : '';
  [['deaths', 'totalDeathsKpi', 'deathsKpiLabel', 'deathsKpiDelta'],
   ['incidents', 'totalIncidentsKpi', 'incidentsKpiLabel', 'incidentsKpiDelta']
  ].forEach(([metric, valueId, labelId, deltaId]) => {
    const def = DASH_METRICS[metric];
    document.getElementById(valueId).textContent = dashValue(dash.state, metric, win).toLocaleString();
    document.getElementById(labelId).textContent = `${def.card}${scope}`;
    const delta = dashDelta(dash.state, def.series, win);
    const el = document.getElementById(deltaId);
    el.textContent = delta ? delta.text : windowText(win);
    el.className = `gkpi-delta ${delta ? (delta.pct > 0 ? 'up' : delta.pct < 0 ? 'down' : 'flat') : 'flat'}`;
  });
  document.querySelectorAll('#mapMetric .seg-btn').forEach(btn => {
    const on = btn.dataset.metric === dash.metric;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  renderSparklines(dash.state);
}

function renderAcledCharts(win){
  const def = DASH_METRICS[dash.metric];
  const scope = dash.state ? ` — ${dash.state}` : '';
  document.getElementById('trendTitle').textContent = `Deaths and incidents by year${scope}`;
  document.getElementById('monthTitle').textContent = `${def.title} by month${scope} · ${windowText(win)}`;
  if (!acledHistory || !trendChart || !monthBarChart) return;
  const inWindow = acledHistory.years.map(year => year >= win.from && year <= win.to);
  trendChart.data.labels = histYearLabels();
  trendChart.data.datasets = [
    {
      type:'bar', label:'Incidents', yAxisID:'y', order:2, borderRadius:4,
      data:histYearly(dash.state, 'events'),
      backgroundColor:(() => {
        const events = histYearly(dash.state, 'events');
        const top = Math.max(1, ...events);
        return events.map((v, i) => heatColor(v / top, inWindow[i] ? 0.9 : 0.25));
      })()
    },
    {
      type:'line', label:'Deaths', yAxisID:'y1', order:1, tension:0.3, fill:false,
      data:histYearly(dash.state, 'fatalities'),
      borderColor:'#c0392b', backgroundColor:'#c0392b', pointRadius:3, pointBackgroundColor:'#c0392b'
    }
  ];
  trendChart.update();
  // Coloured from the quietest month (blue) to the busiest (red).
  const monthValues = histMonthly(dash.state, def.series, win.from, win.to);
  const monthTop = Math.max(...monthValues), monthLow = Math.min(...monthValues);
  monthBarChart.data.labels = MONTH_LABELS;
  monthBarChart.data.datasets = [{
    label:`${def.title}, ${windowText(win)}`,
    data:monthValues,
    backgroundColor:monthValues.map(v => heatColor(monthTop > monthLow ? (v - monthLow) / (monthTop - monthLow) : 0.5)),
    borderRadius:4
  }];
  monthBarChart.update();
}

function refreshAcledViews(){
  const win = dashWindow();
  const values = refreshBubbles(win);
  refreshShading(values, win);
  refreshLgaFocus(win);
  renderDashKpis(win);
  renderAcledCharts(win);
  renderStateBars(win, values);
  const def = DASH_METRICS[dash.metric];
  const note = document.getElementById('mapCountNote');
  if (note) note.textContent = `${def.title} · ${dash.state || 'all states'} · ${windowText(win)}`;
}

function setDashMetric(metric){
  if (!DASH_METRICS[metric]) return;
  dash.metric = metric;
  if (!layerState.acled && !layerState.deaths) toggleLayer(document.querySelector('.toggle-btn[data-layer="acled"]'));
  refreshAcledViews();
}

// Focus one state (click it again, or pass null, to return to all states).
function selectDashState(stateName, keepSelected = false){
  const next = stateName && (keepSelected || dash.state !== stateName) ? stateName : null;
  dash.state = next;
  refreshAcledViews();
  renderFilterChips();
  const s = next && stateObjectByName(next);
  if (s) map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 7), { duration: 0.8 });
  else map.closePopup();
}

// Focus an LGA: its state's LGAs are drawn, then the map opens this one.
function focusLga(pcode){
  const lga = lgaByPcode.get(pcode);
  if (!lga) return;
  if (!layerState.acled) toggleLayer(document.querySelector('.toggle-btn[data-layer="acled"]'));
  selectDashState(lga.state, true);
  document.querySelector('.map-center')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    map.flyTo([lga.lat, lga.lng], 9, { duration: 0.8 });
    const layer = lgaFocusLayer.getLayers().find(l => l.feature.properties.pcode === pcode);
    if (layer) setTimeout(() => layer.openPopup([lga.lat, lga.lng]), 850);
  }, 850);
}

// Opt-in layers (off by default); load boundaries once and feed both choropleths.
fetch('vendor/nigeria-states.geojson')
  .then(r => r.json())
  .then(geo => { bubbleLayer.addData(geo); deathsLayer.addData(geo); refreshChoropleth(); deathsLayer.setStyle(deathsChoroStyle); })
  .catch(err => console.error('Choropleth boundaries failed to load', err));

function attackColor(a){
  if(a.toLowerCase().includes('kidnap'))return'#bc8cff';
  if(a.toLowerCase().includes('shoot')||a.toLowerCase().includes('kill')||a.toLowerCase().includes('ied')||a.toLowerCase().includes('aerial'))return'#f85149';
  return'#d29922';
}
function attackClass(a){
  if(a.toLowerCase().includes('kidnap'))return'attack-kidnap';
  if(a.toLowerCase().includes('shoot')||a.toLowerCase().includes('kill')||a.toLowerCase().includes('ied')||a.toLowerCase().includes('aerial'))return'attack-shooting';
  return'attack-other';
}
function markerClass(a){
  if(a.toLowerCase().includes('kidnap'))return'aid-marker-kidnap';
  if(a.toLowerCase().includes('shoot')||a.toLowerCase().includes('kill')||a.toLowerCase().includes('ied')||a.toLowerCase().includes('aerial'))return'aid-marker-shooting';
  return'aid-marker-other';
}

// Aid incidents render as individual markers (no clustering).
let pointLayer=L.layerGroup();
function buildPoints(data){
  pointLayer.clearLayers();
  data.forEach(d=>{
    L.marker([d.lat,d.lng],{
      icon:L.divIcon({
        html:`<div class="aid-marker ${markerClass(d.attack)}"></div>`,
        iconSize:[15,15],iconAnchor:[7,7],className:''
      })
    }).bindPopup(`
      <div class="popup-title">&#x26A0; Aid Worker Incident - ${d.year}</div>
      <div class="popup-row"><span>Region</span><span>${d.region}</span></div>
      ${d.city?`<div class="popup-row"><span>Location</span><span>${d.city}</span></div>`:''}
      <div class="popup-row"><span>Attack Type</span><span class="${attackClass(d.attack)}">${d.attack}</span></div>
      <div class="popup-row"><span>Actor</span><span>${d.actor.replace('Non-state armed group: ','NSA: ')}</span></div>
      <div class="popup-row"><span>Motive</span><span>${d.motive}</span></div>
      <div class="popup-row"><span>Killed / Wounded / Kidnapped</span><span>${d.killed} / ${d.wounded} / ${d.kidnapped}</span></div>
      ${d.details?`<div class="popup-detail">${d.details}</div>`:''}
    `).addTo(pointLayer);
  });
}
const awsd2015 = awsdData.filter(d => d.year >= 2015);
buildPoints(awsd2015);
pointLayer.addTo(map);

const checkpointData = data.checkpoints || [];
checkpointRecords = checkpointData;
let checkpointLayer = L.markerClusterGroup({
  maxClusterRadius: 55,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  zoomToBoundsOnClick: true,
  iconCreateFunction: function(cluster) {
    const count = cluster.getChildCount();
    return L.divIcon({
      html: `<div class="cp-cluster">${count}</div>`,
      className: '',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }
});
function checkpointColor(type) {
  if (type === 'Military') return '#4ade80';
  if (type === 'Customs')  return '#c084fc';
  if (type === 'Joint')    return '#fb923c';
  return '#60a5fa'; // Police
}
checkpointData.forEach(cp => {
  const color = checkpointColor(cp.type);
  L.marker([cp.lat, cp.lng], {
    icon: L.divIcon({
      html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 20" width="14" height="20">
        <path d="M7 0C3.69 0 1 2.69 1 6c0 4.5 6 14 6 14s6-9.5 6-14c0-3.31-2.69-6-6-6z" fill="${color}" stroke="rgba(255,255,255,0.8)" stroke-width="1"/>
        <circle cx="7" cy="6" r="2.2" fill="rgba(255,255,255,0.85)"/>
      </svg>`,
      iconSize: [14, 20], iconAnchor: [7, 20], popupAnchor: [0, -20], className: ''
    })
  }).bindPopup(`
    <div class="popup-title">&#x1F6E1; ${escapeHtml(cp.name)}</div>
    <div class="popup-row"><span>Type</span><span style="color:${color};font-weight:700">${escapeHtml(cp.type)}</span></div>
    <div class="popup-row"><span>State</span><span>${escapeHtml(cp.state)}</span></div>
    <div class="popup-row"><span>Road / Location</span><span>${escapeHtml(cp.road)}</span></div>
    <div class="popup-row"><span>Status</span><span class="risk-elevated">${escapeHtml(cp.status)}</span></div>
  `).addTo(checkpointLayer);
});

const layers={acled:acledLayer,rising:risingLayer,live:liveLayer,deaths:deathsLayer,bubbles:bubbleLayer,points:pointLayer,lgaLines:lgaLinesLayer,displaced:displacedLayer,checkpoints:checkpointLayer};
const layerState={acled:true,rising:true,live:true,deaths:false,bubbles:false,points:false,lgaLines:false,displaced:false,checkpoints:false};
lgaFocusLayer.addTo(map);
acledLayer.addTo(map);
risingLayer.addTo(map);
liveLayer.addTo(map);
map.removeLayer(pointLayer);
function toggleLayer(btn){
  const k=btn.dataset.layer;
  layerState[k]=!layerState[k];
  btn.classList.toggle('active',layerState[k]);
  layerState[k]?layers[k].addTo(map):map.removeLayer(layers[k]);
  // Shading sits under the bubbles whichever was switched on last.
  if(layerState[k] && (k==='deaths'||k==='bubbles'||k==='displaced')) layers[k].bringToBack();
  if(k==='acled') refreshLgaFocus(dashWindow());
  updateLayerCount();
  syncLegend();
}

// Show only the legend sections whose layer is currently on, and divide
// stacked sections.
function syncLegend(){
  const legend=document.getElementById('mapLegend');
  if(!legend) return;
  let anyOn=false, firstShown=true;
  legend.querySelectorAll('.leg-section').forEach(sec=>{
    const on = sec.dataset.legend==='lgaFocus' ? sec.dataset.on==='1' : !!layerState[sec.dataset.legend];
    sec.style.display = on ? '' : 'none';
    sec.classList.remove('leg-divided');
    if(on){ anyOn=true; if(!firstShown) sec.classList.add('leg-divided'); firstShown=false; }
  });
  document.getElementById('legEmpty').hidden = anyOn;
}

// The legend sits on the map and folds down to its title bar; the choice is
// remembered for the next visit.
const LEGEND_PREF = 'dashboard-legend-collapsed';
function setLegendCollapsed(collapsed){
  document.getElementById('mapLegendPanel').classList.toggle('collapsed', collapsed);
  document.getElementById('mlgToggle').setAttribute('aria-expanded', String(!collapsed));
}
function toggleLegendPanel(){
  const collapsed = !document.getElementById('mapLegendPanel').classList.contains('collapsed');
  setLegendCollapsed(collapsed);
  try { localStorage.setItem(LEGEND_PREF, collapsed ? '1' : '0'); } catch (error) { /* private mode */ }
}
// With no saved choice it starts open, unless the map is too short to spare the room.
(function(){
  let saved = null;
  try { saved = localStorage.getItem(LEGEND_PREF); } catch (error) { /* private mode */ }
  if (saved !== null) { setLegendCollapsed(saved === '1'); return; }
  // Measured once the page has settled; the map is still being laid out here.
  setTimeout(() => {
    const mapHeight = document.querySelector('.map-wrap').offsetHeight;
    setLegendCollapsed(mapHeight > 0 && mapHeight < 320);
  }, 400);
})();

document.querySelectorAll('.toggle-btn').forEach(btn=>{
  btn.addEventListener('click',()=>toggleLayer(btn));
});
updateLayerCount();
syncLegend();

function toggleLayersPanel(){
  document.getElementById('mapLayersPanel')?.classList.toggle('collapsed');
}

function updateLayerCount(){
  const on = document.querySelectorAll('.mlp-row.active').length;
  const el = document.getElementById('mlpCount');
  if (el) el.textContent = `${on} on`;
}

// Segmented time-range control (visual range selector for the live window).
function setRange(btn){
  document.querySelectorAll('#rangeControl .seg-btn').forEach(b=>b.classList.toggle('active', b===btn));
}

// AWSD records have no severity field, so derive it from casualties:
//   Critical = 3+ killed · High = 1–2 killed or 3+ kidnapped · Mod = the rest.
function deriveSeverity(d){
  const killed = d.killed || 0, kidnapped = d.kidnapped || 0;
  if (killed >= 3) return 'Critical';
  if (killed >= 1 || kidnapped >= 3) return 'High';
  return 'Mod';
}
function activeSeverities(){
  return new Set([...document.querySelectorAll('.sev-pill.active')].map(p => p.dataset.sev));
}
function toggleSevPill(btn){
  btn.classList.toggle('active');
  applyFilters();
}

function resetFilters(){
  ['attackFilter','yearFilter','actorFilter'].forEach(id=>{
    const s=document.getElementById(id); if(s) s.value=FILTER_DEFAULTS[id];
  });
  document.querySelectorAll('.sev-pill').forEach(p=>p.classList.add('active'));
  applyFilters();
}

function switchReportTab(name){
  document.querySelectorAll('.lr-tab').forEach(t=>{
    const on = t.dataset.lrtab===name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  [['brief','lrPaneBrief'],['news','lrPaneNews'],['log','lrPaneLog']].forEach(([key,id])=>{
    const pane=document.getElementById(id);
    if(pane) pane.style.display = name===key ? 'flex' : 'none';
  });
}

// Global search — focuses the map on a matching state, or on the state of a
// matching local government area.
function handleGlobalSearch(value){
  const q=(value||'').trim().toLowerCase();
  if(q.length<3) return;
  let match=stateData.find(s=>s.state.toLowerCase().includes(q));
  let lga=null;
  if(!match && acledHistory){
    for(const row of acledHistory.states){
      lga=row.lgas.find(item=>item.name.toLowerCase().includes(q));
      if(lga){ match=stateObjectByName(row.state); break; }
    }
  }
  if(!match) return;
  selectDashState(match.state, true);
  if(layerState.acled) setTimeout(()=>acledMarkers.get(match.state)?.openPopup(), 900);
  if(lga){
    const win=dashWindow(), yi=y=>acledHistory.years[y]>=win.from&&acledHistory.years[y]<=win.to;
    const sum=series=>lga[series].reduce((t,v,i)=>yi(i)?t+v:t,0);
    const pill=document.getElementById('infoPill');
    pill.textContent=`${lga.name} LGA, ${match.state}: ${sum('fatalities').toLocaleString()} deaths in ${sum('events').toLocaleString()} incidents, ${windowText(win)}`;
    setTimeout(()=>{pill.textContent='Click any marker for incident details · scroll to zoom';},8000);
  }
}

// --- Time slider: filter the aid-incident layer by year ceiling ---
let timePlayTimer=null;
function onTimeSlider(value){
  const yr=parseInt(value,10);
  const lbl=document.getElementById('tsCurrent');
  if(lbl) lbl.textContent = yr>=HIST_LAST ? 'All years' : yr<=HIST_FIRST ? String(yr) : `${HIST_FIRST}–${yr}`;
  if(typeof applyTimeFilter==='function') applyTimeFilter(yr);
}
const TS_PLAY_PATH='M8 5v14l11-7z';
const TS_PAUSE_PATH='M7 5h3v14H7zM14 5h3v14h-3z';
function setPlayIcon(path){
  const svg=document.querySelector('#tsPlay .ts-play-ico path');
  if(svg) svg.setAttribute('d', path);
}
function toggleTimePlay(){
  const slider=document.getElementById('timeSlider');
  if(timePlayTimer){
    clearInterval(timePlayTimer); timePlayTimer=null;
    setPlayIcon(TS_PLAY_PATH);
    return;
  }
  setPlayIcon(TS_PAUSE_PATH);
  let yr=HIST_FIRST;
  slider.value=yr; onTimeSlider(yr);
  timePlayTimer=setInterval(()=>{
    yr++;
    if(yr>HIST_LAST){ clearInterval(timePlayTimer); timePlayTimer=null; setPlayIcon(TS_PLAY_PATH); return; }
    slider.value=yr; onTimeSlider(yr);
  }, 700);
}
(function(){
  const slider=document.getElementById('timeSlider');
  slider.min=HIST_FIRST; slider.max=HIST_LAST; slider.value=HIST_LAST;
  document.getElementById('tsMin').textContent=HIST_FIRST;
  document.getElementById('tsMax').textContent=HIST_LAST;
})();

// Default Leaflet layers control removed — the custom floating "Layers" panel
// (top-right of the map) is the single layer control.


document.querySelectorAll('.filter-select').forEach(select=>{
  select.addEventListener('change',applyFilters);
});

// Active-filter chips: show only non-default selections, each removable.
const FILTER_DEFAULTS = { attackFilter: 'all', yearFilter: '2015+', actorFilter: 'all' };
function renderFilterChips(){
  const wrap = document.getElementById('activeFilterChips');
  if (!wrap) return;
  wrap.innerHTML = '';
  Object.keys(FILTER_DEFAULTS).forEach(id => {
    const sel = document.getElementById(id);
    if (!sel || sel.value === FILTER_DEFAULTS[id]) return;
    const label = sel.options[sel.selectedIndex]?.text || sel.value;
    const chip = document.createElement('span');
    chip.className = 'fchip';
    chip.innerHTML = `${escapeHtml(label)} <button type="button" title="Remove" aria-label="Remove ${escapeHtml(label)}">&times;</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      sel.value = FILTER_DEFAULTS[id];
      applyFilters();
    });
    wrap.appendChild(chip);
  });
  if (dash.state) {
    const chip = document.createElement('span');
    chip.className = 'fchip';
    chip.innerHTML = `State: ${escapeHtml(dash.state)} <button type="button" title="Show all states" aria-label="Show all states">&times;</button>`;
    chip.querySelector('button').addEventListener('click', () => selectDashState(null));
    wrap.appendChild(chip);
  }
  // Severity chip (shown only when a subset of severities is active)
  const allSev = document.querySelectorAll('.sev-pill');
  const onSev = [...allSev].filter(p => p.classList.contains('active'));
  if (allSev.length && onSev.length < allSev.length) {
    const chip = document.createElement('span');
    chip.className = 'fchip';
    const label = onSev.length ? onSev.map(p => escapeHtml(p.dataset.sev)).join(', ') : 'none';
    chip.innerHTML = `Severity: ${label} <button type="button" title="Reset severity" aria-label="Reset severity">&times;</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      allSev.forEach(p => p.classList.add('active'));
      applyFilters();
    });
    wrap.appendChild(chip);
  }
}

let timeYearMax = HIST_LAST;
function applyTimeFilter(yr){ timeYearMax = yr; applyFilters(); }

function applyFilters(){
  const atk=document.getElementById('attackFilter').value;
  const years=yearSelectRange();
  const act=document.getElementById('actorFilter').value;
  const sevs=activeSeverities();
  const f=awsdData.filter(d=>{
    let ok=true;
    if(d.year>timeYearMax)ok=false;
    if(!sevs.has(deriveSeverity(d)))ok=false;
    if(atk!=='all'&&d.attack!==atk)ok=false;
    if(d.year<years.from||d.year>years.to)ok=false;
    if(act==='Non-state'&&!d.actor.includes('Non-state'))ok=false;
    if(act==='Criminal'&&!d.actor.includes('Criminal'))ok=false;
    if(act==='Unknown'&&!d.actor.includes('Unknown'))ok=false;
    if(act==='State'&&!d.actor.includes('Host')&&!d.actor.includes('Police')&&!d.actor.includes('paramilitary'))ok=false;
    return ok;
  });
  buildPoints(f);
  if(layerState.points)pointLayer.addTo(map);
  const pill=document.getElementById('infoPill');
  pill.textContent=`Showing ${f.length} aid worker incidents`;
  setTimeout(()=>{pill.textContent='Click any marker for incident details · scroll to zoom';},3000);
  buildFeed([...f].reverse());
  renderFilterChips();

  // Recolour the choropleth by filtered aid-incident count per state
  choroCounts = new Map();
  f.forEach(d => { const n = normState(d.region); choroCounts.set(n, (choroCounts.get(n) || 0) + 1); });
  choroMax = Math.max(1, ...choroCounts.values());
  refreshChoropleth();

  // Charts reflect the filtered set
  chartFilterSet = f;
  updateChartsWithLiveReports(liveArticles);

  // KPI + map header counters
  const states=new Set(f.map(d=>d.region)).size;
  const mk=document.getElementById('matchKpi'); if(mk) mk.textContent=f.length.toLocaleString();
  const ms=document.getElementById('matchKpiSub'); if(ms) ms.textContent=`of ${awsdData.length.toLocaleString()} · ${states} states`;
  refreshAcledViews();
}
renderFilterChips();

// STATE BARS — top states by the active ACLED metric, or the most affected
// local government areas once a state is in focus.
const sbEl=document.getElementById('stateRankBars');
function barClass(i){return i<2?'bar-critical':i<5?'bar-high':'bar-elevated';}
function renderStateBars(win, values){
  const def=DASH_METRICS[dash.metric];
  const title=document.getElementById('stateBarsTitle');
  const live=liveArticlesByState();
  let entries;
  if(dash.state && acledHistory){
    title.textContent=`Top LGAs in ${dash.state} — ${def.title.toLowerCase()}`;
    entries=histTopLgas(dash.state, def.series, win.from, win.to, 10).map(lga=>({name:lga.name,count:lga.value}));
  }else{
    title.textContent=`Top states — ${def.title.toLowerCase()}`;
    entries=[...values.entries()].filter(([,count])=>count>0)
      .map(([name,count])=>({name,count,state:name,live:(live.get(name)||[]).length}))
      .sort((a,b)=>b.count-a.count).slice(0,10);
  }
  if(!entries.length){ sbEl.innerHTML=`<div class="h-bar-empty">No ${def.title.toLowerCase()} recorded for ${windowText(win)}.</div>`; return; }
  const maxC=entries[0].count;
  sbEl.innerHTML='';
  entries.forEach((d,i)=>{
    const pct=Math.max(8,Math.round((d.count/maxC)*100));
    const liveChip=d.live?`<span class="h-bar-live" title="${d.live} live news report${d.live===1?'':'s'} naming ${escapeHtml(d.name)}">+${d.live} live</span>`:'';
    sbEl.insertAdjacentHTML('beforeend',`<div class="h-bar-row${d.state?' is-click':''}"${d.state?` data-state="${escapeHtml(d.state)}" title="Focus ${escapeHtml(d.name)} on the map"`:''}><span class="h-bar-lbl">${escapeHtml(shortStateName(d.name))}</span><div class="h-bar-track"><div class="h-bar-fill" style="width:${pct}%;background:${heatColor(Math.sqrt(d.count/maxC))}"><span class="h-bar-val" style="color:${heatTextColor(Math.sqrt(d.count/maxC))}">${d.count.toLocaleString()}</span></div></div>${liveChip}</div>`);
  });
  sbEl.querySelectorAll('.h-bar-row.is-click').forEach(row=>{
    row.addEventListener('click',()=>selectDashState(row.dataset.state, true));
  });
}

// FEED
function tagClass(a){
  if(a.toLowerCase().includes('kidnap'))return'tag-kidnap';
  if(a.toLowerCase().includes('shoot')||a.toLowerCase().includes('kill'))return'tag-shooting';
  return'tag-other';
}
function buildFeed(data){
  const feed=document.getElementById('incidentFeed');
  feed.innerHTML='';
  data.slice(0,25).forEach(d=>{
    feed.innerHTML+=`<div class="inc-item">
      <div class="inc-top"><span class="inc-region">${d.region}${d.city?', '+d.city:''}</span><span class="inc-year">${d.year}</span></div>
      <div class="inc-detail">${d.details}</div>
      <div class="inc-tags">
        <span class="inc-tag ${tagClass(d.attack)}">${d.attack}</span>
        ${d.killed>0?'<span class="inc-tag tag-killed">'+d.killed+' killed</span>':''}
        ${d.kidnapped>0?'<span class="inc-tag tag-kidnap">'+d.kidnapped+' kidnapped</span>':''}
      </div>
    </div>`;
  });
}
buildFeed([...awsd2015].reverse());

// CHARTS
const gc='rgba(255,255,255,0.06)',tc='#8b949e';
Chart.defaults.font.family='Segoe UI, sans-serif';

trendChart = new Chart(document.getElementById('trendChart'),{
  type:'bar',
  data:{labels:[],datasets:[]},
  options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:true,labels:{color:tc,boxWidth:10,font:{size:10}}}},scales:{x:{grid:{display:false},ticks:{color:tc,font:{size:10},maxRotation:0,autoSkip:true}},y:{beginAtZero:true,position:'left',grid:{color:gc},ticks:{color:tc,font:{size:10},precision:0}},y1:{beginAtZero:true,position:'right',grid:{display:false},ticks:{color:'#ff5a5f',font:{size:10},precision:0}}}}
});

attackDonutChart = new Chart(document.getElementById('attackDonut'),{
  type:'bar',
  data:{labels:[],datasets:[]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:tc,font:{size:9}}},y:{beginAtZero:true,grid:{color:gc},ticks:{color:tc,font:{size:9},precision:0}}}}
});

monthBarChart = new Chart(document.getElementById('monthBar'),{
  type:'bar',
  data:{labels:[],datasets:[]},
  options:{
    responsive:true,
    maintainAspectRatio:false,
    plugins:{legend:{display:true,labels:{color:tc,boxWidth:10,font:{size:9}}}},
    scales:{x:{grid:{display:false},ticks:{color:tc,font:{size:9}}},y:{beginAtZero:true,grid:{color:gc},ticks:{color:tc,font:{size:9},precision:0}}}
  }
});

// Reset view: everything back to how the page opens, without reloading it
// (the live feed, briefing and watchlist are kept).
const LAYER_DEFAULTS = { ...layerState };
function resetDashboard(){
  if (timePlayTimer) toggleTimePlay();
  document.querySelector('.map-max')?.querySelector('.map-max-btn')?.click();
  showView('dashboard');
  // Filters, year window and time slider
  ['attackFilter','yearFilter','actorFilter'].forEach(id => { document.getElementById(id).value = FILTER_DEFAULTS[id]; });
  document.querySelectorAll('.sev-pill').forEach(p => p.classList.add('active'));
  const slider = document.getElementById('timeSlider');
  slider.value = HIST_LAST;
  document.getElementById('tsCurrent').textContent = 'All years';
  timeYearMax = HIST_LAST;
  // Metric, state in focus, layers
  dash.metric = 'deaths';
  dash.state = null;
  document.querySelectorAll('.toggle-btn[data-layer]').forEach(btn => {
    if (layerState[btn.dataset.layer] !== LAYER_DEFAULTS[btn.dataset.layer]) toggleLayer(btn);
  });
  document.getElementById('mapLayersPanel')?.classList.remove('collapsed');
  setLegendCollapsed(false);
  try { localStorage.removeItem(LEGEND_PREF); } catch (error) { /* private mode */ }
  // Map, panels and search
  liveReportLayer.clearLayers();
  if (userReportLayer) userReportLayer.clearLayers();
  map.closePopup();
  map.flyToBounds(NIGERIA_BOUNDS, { padding: [8, 8], duration: 0.8 });
  document.getElementById('globalSearch').value = '';
  document.querySelectorAll('#liveNewsFeed .news-item.active').forEach(n => n.classList.remove('active'));
  switchReportTab('brief');
  applyFilters();
  showToast('View reset to the defaults.', 'info');
}
Object.assign(window, { resetDashboard });

// Live news badges and the "+n live" marks in the state ranking follow each
// refresh of the feed (called from renderLiveNews).
window.onDashboardLiveUpdate = () => { refreshLiveLayer(); refreshAcledViews(); };
Object.assign(window, { focusLga });

// LGA names, outlines, displacement and citizen reports load in the
// background (insights.js); everything that uses them redraws once they arrive.
startInsights(() => {
  fillLgaLayers();
  refreshRisingLayer();
  liveArticles.forEach(article => { article.incident = extractNewsIncident(article); });
  refreshLiveLayer();
  refreshAcledViews();
});

// Credit line under the map.
(function(){
  const el=document.getElementById('mapSource');
  if(!el) return;
  const aid='Aid worker records: Aid Worker Security Database.';
  if(!acledHistory){ el.textContent=`ACLED history file not loaded; showing stored state totals. ${aid}`; return; }
  const m=acledHistory.meta;
  const asOf=new Date(`${m.asOf}T00:00:00`).toLocaleDateString([], {day:'numeric',month:'short',year:'numeric'});
  el.innerHTML=`Deaths and incidents: <a href="${escapeHtml(m.sourceUrl)}" target="_blank" rel="noopener noreferrer">ACLED via HDX</a>, political violence, ${histCoverageText()} (data as of ${escapeHtml(asOf)}; latest month incomplete). LGA boundaries: OCHA. Displacement: IOM DTM. ${aid}`;
})();

// Unify the initial render: points, feed, bubbles, shading, state bars, charts
// and KPIs all reflect the default filter from the start.
refreshLiveLayer();
applyFilters();

}

loadDashboardData()
  .then(initDashboard)
  .catch(showLoadError);

// Sync theme button state with persisted preference (maps/charts not yet ready here)
(function() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const btn = document.getElementById('themeToggleBtn');
  if (btn) {
    const label = document.getElementById('themeModeLabel');
    if (label) label.textContent = isLight ? 'Light' : 'Dark';
    btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  }
})();

// ─────────────────────────────────────────────────────────────
//  HOTSPOT ANALYSIS
// ─────────────────────────────────────────────────────────────

let hotspotMapInstance = null;
let hotspotInitialized = false;
let cachedHotspots = null;
let checkpointRecords = [];   // read by the hotspot state profile
let mainTileLayer = null;
// Esri Canvas basemaps — keyless, free for use, ideal grey canvas for data viz.
// (Carto's basemaps.cartocdn.com now require a registered API key.)
const DARK_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const LIGHT_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const TILE_OPTS = { attribution: 'Tiles &copy; Esri &mdash; &copy; OpenStreetMap contributors', maxZoom: 16 };

function hsRegionToState(region) {
  if (!region || region === 'Unknown') return null;
  if (region === 'FCT') return 'FCT (Abuja)';
  const exact = stateData.find(s => s.state === region);
  if (exact) return exact.state;
  const partial = stateData.find(s => s.state.startsWith(region) || region.startsWith(s.state));
  return partial ? partial.state : null;
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('dashboard-theme', next);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggleBtn');
  const isLight = theme === 'light';
  if (btn) {
    const label = document.getElementById('themeModeLabel');
    if (label) label.textContent = isLight ? 'Light' : 'Dark';
    btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  }

  if (mapInstance && mainTileLayer) {
    mapInstance.removeLayer(mainTileLayer);
    mainTileLayer = L.tileLayer(isLight ? LIGHT_TILE : DARK_TILE, TILE_OPTS).addTo(mapInstance);
  }

  refreshHotspotTheme();
  if (typeof refreshTravelTheme === 'function') refreshTravelTheme();

  applyThemeToCharts();
}

function applyThemeToCharts() {
  const { tc, gc } = getChartThemeColors();
  [trendChart, attackDonutChart, monthBarChart].forEach(chart => {
    if (!chart) return;
    const xs = chart.options.scales?.x;
    const ys = chart.options.scales?.y;
    if (xs) { if (xs.grid) xs.grid.color = gc; if (xs.ticks) xs.ticks.color = tc; }
    if (ys) { if (ys.grid) ys.grid.color = gc; if (ys.ticks) ys.ticks.color = tc; }
    if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = tc;
    chart.update('none');
  });
}

function toggleHamburgerMenu() {
  const dropdown = document.getElementById('hamburgerDropdown');
  const btn = document.getElementById('hamburgerBtn');
  const isOpen = dropdown.classList.contains('open');
  dropdown.classList.toggle('open', !isOpen);
  btn.classList.toggle('active', !isOpen);
}

function closeHamburgerMenu() {
  document.getElementById('hamburgerDropdown').classList.remove('open');
  document.getElementById('hamburgerBtn').classList.remove('active');
}

document.addEventListener('click', function(e) {
  const menu = document.getElementById('hamburgerMenu');
  if (menu && !menu.contains(e.target)) closeHamburgerMenu();
});

function setActiveNavTab(view) {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
}

// Primary nav dispatcher. 'report' opens the modal overlay without changing
// the underlying active tab (dashboard/hotspot/travel stay selected beneath it).
function navTo(view) {
  if (view === 'report') {
    if (typeof openLiveReport === 'function') openLiveReport();
    return;
  }
  showView(view); // 'dashboard' | 'hotspot' | 'travel'
}

function showView(view) {
  const dash = view === 'dashboard';
  document.querySelector('.layout').style.display = dash ? (window.innerWidth <= 768 ? 'flex' : 'grid') : 'none';
  document.querySelector('.kpi-row').style.display = dash ? '' : 'none';
  document.getElementById('hotspotView').style.display = view === 'hotspot' ? 'flex' : 'none';
  document.getElementById('travelView').classList.toggle('tv-active', view === 'travel');
  document.getElementById('topbarDashboardInfo').style.display = dash ? '' : 'none';
  document.getElementById('topbarHotspotInfo').style.display = view === 'hotspot' ? '' : 'none';
  document.getElementById('topbarTravelInfo').style.display = view === 'travel' ? '' : 'none';
  setActiveNavTab(view);

  if (view === 'hotspot') {
    if (!hotspotInitialized) { initHotspotView(); hotspotInitialized = true; }
    else if (hotspotMapInstance) { setTimeout(() => hotspotMapInstance.invalidateSize(), 120); }
  } else if (view === 'travel') {
    if (!travelInitialized) { initTravelView(); travelInitialized = true; }
    else if (travelMap) { setTimeout(() => { travelMap.invalidateSize(); if (tvCurrentCorridor) fitTravelBounds(); }, 120); }
  }
}

function openHotspotView() { showView('hotspot'); }
function closeHotspotView() { showView('dashboard'); }
function openTravelView() { showView('travel'); }

// Maximize / restore the map panel a button sits in (dashboard, travel, hotspot).
function toggleMapMax(btn) {
  const panel = btn.closest('.map-center, .tv-map-card, .hs-map-panel');
  if (!panel) return;
  const on = panel.classList.toggle('map-max');
  document.body.classList.toggle('has-map-max', on);
  const icon = btn.querySelector('i');
  if (icon) icon.className = on ? 'ti ti-minimize' : 'ti ti-maximize';
  btn.title = on ? 'Restore map' : 'Maximize map';
  setTimeout(() => {
    [typeof mapInstance !== 'undefined' ? mapInstance : null,
     typeof travelMap !== 'undefined' ? travelMap : null,
     typeof hotspotMapInstance !== 'undefined' ? hotspotMapInstance : null]
      .forEach(m => { try { if (m) m.invalidateSize(); } catch (e) {} });
    if (on && panel.classList.contains('tv-map-card') && typeof fitTravelBounds === 'function') fitTravelBounds();
  }, 240);
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const maxed = document.querySelector('.map-max');
    if (maxed) { const b = maxed.querySelector('.map-max-btn'); if (b) toggleMapMax(b); }
  }
});

function getChartThemeColors() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return {
    tc: isLight ? '#4a5568' : '#8b949e',
    gc: isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)'
  };
}

// ════════════════════════════════════════════════════════════════
//  REPORTS VIEWER
// ════════════════════════════════════════════════════════════════

let reportsViewerData = [];
let rvDetailMap = null;
let userReportLayer = null;
let currentDetailReport = null;

function openReportsViewer() {
  const modal = document.getElementById('reportsViewerModal');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  loadReports();
}

function closeReportsViewer() {
  const modal = document.getElementById('reportsViewerModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

function rvHandleBackdrop(event) {
  if (event.target === document.getElementById('reportsViewerModal')) closeReportsViewer();
}

async function loadReports() {
  const list = document.getElementById('rvList');
  const countEl = document.getElementById('rvCount');
  list.innerHTML = '<div class="rv-state-msg"><i class="ti ti-loader-2 ti-spin"></i><span>Loading reports&hellip;</span></div>';
  if (countEl) countEl.textContent = '';
  closeReportDetail();
  try {
    const res = await fetch('/api/reports');
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const data = await res.json();
    reportsViewerData = data.reports || [];
    const n = reportsViewerData.length;
    if (countEl) countEl.textContent = n + ' report' + (n !== 1 ? 's' : '');
    const badge = document.getElementById('rvMenuBadge');
    if (badge) { badge.textContent = n; badge.style.display = n ? 'inline-flex' : 'none'; }
    renderReportsList(reportsViewerData);
  } catch (err) {
    if (countEl) countEl.textContent = 'Error loading';
    list.innerHTML = '<div class="rv-state-msg rv-error-msg"><i class="ti ti-alert-triangle"></i><span>Could not load reports: ' + escapeHtml(err.message) + '</span></div>';
  }
}

const RV_CAT_ICON = {
  Shooting: 'ti-crosshair', Kidnapping: 'ti-lock', Robbery: 'ti-shield-off',
  Checkpoint: 'ti-road', 'Communal Clash': 'ti-users', Protest: 'ti-speakerphone', Other: 'ti-help'
};
const RV_SEV_CLASS = { Low: 'rv-sev-low', Medium: 'rv-sev-med', High: 'rv-sev-high', Critical: 'rv-sev-crit' };

function renderReportsList(reports) {
  const list = document.getElementById('rvList');
  if (!reports.length) {
    list.innerHTML = '<div class="rv-state-msg"><i class="ti ti-inbox"></i><span>No reports submitted yet.</span></div>';
    return;
  }
  list.innerHTML = reports.map((r, i) => renderReportCard(r, i)).join('');
  list.querySelectorAll('.rv-card').forEach(card => {
    card.addEventListener('click', () => openReportDetail(reportsViewerData[Number(card.dataset.index)]));
  });
}

function renderReportCard(r, index) {
  const d = new Date(r.receivedAt);
  const dateStr = isNaN(d) ? r.receivedAt : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const sevCls  = RV_SEV_CLASS[r.severity] || 'rv-sev-med';
  const catIco  = RV_CAT_ICON[r.category]  || 'ti-help';
  const hasLoc  = r.location && r.location.shared && r.location.lat != null;
  const files   = r.files || [];
  const imgs    = files.filter(f => (f.contentType || '').startsWith('image/')).length;
  const vids    = files.filter(f => (f.contentType || '').startsWith('video/')).length;
  const fp      = [imgs ? imgs + ' photo' + (imgs > 1 ? 's' : '') : '', vids ? vids + ' video' + (vids > 1 ? 's' : '') : ''].filter(Boolean).join(', ');
  return `<div class="rv-card" data-index="${index}">
    <div class="rv-card-head">
      <div class="rv-card-badges">
        <span class="rv-cat-badge"><i class="ti ${catIco}"></i> ${escapeHtml(r.category || 'Unknown')}</span>
        <span class="rv-sev-badge ${sevCls}">${escapeHtml(r.severity || '')}</span>
      </div>
      <span class="rv-date">${escapeHtml(dateStr)}</span>
    </div>
    <div class="rv-message">${escapeHtml(r.message || '')}</div>
    <div class="rv-meta-row">
      <span class="rv-meta-item${hasLoc ? ' rv-has-loc' : ''}">
        <i class="ti ${hasLoc ? 'ti-map-pin' : 'ti-map-pin-off'}"></i>
        ${hasLoc ? r.location.lat.toFixed(4) + '&deg;N, ' + r.location.lon.toFixed(4) + '&deg;E' : 'No location'}
      </span>
      ${fp ? `<span class="rv-meta-item rv-has-files"><i class="ti ti-paperclip"></i> ${fp}</span>` : ''}
    </div>
  </div>`;
}

function openReportDetail(r) {
  currentDetailReport = r;
  document.getElementById('rvListView').style.display = 'none';
  const detailView = document.getElementById('rvDetailView');
  detailView.style.display = 'block';
  const d = new Date(r.receivedAt);
  const dateStr = isNaN(d) ? r.receivedAt : d.toLocaleString();
  const catIco  = RV_CAT_ICON[r.category]  || 'ti-help';
  const sevCls  = RV_SEV_CLASS[r.severity] || 'rv-sev-med';
  const hasLoc  = r.location && r.location.shared && r.location.lat != null;
  const files   = r.files || [];

  const mapHtml = hasLoc ? `
    <div class="rv-detail-section">
      <div class="rv-detail-label">Incident Location</div>
      <div id="rvDetailMapEl" class="rv-detail-mini-map"></div>
      <button class="lr-btn lr-btn-primary rv-show-map-btn"
        onclick="showReportOnDashboard(${r.location.lat},${r.location.lon},'${escapeHtml(r.category || '')}','${escapeHtml(r.id || '')}')">
        <i class="ti ti-map-pin"></i> Show on Dashboard Map
      </button>
    </div>` : '';

  const mediaHtml = files.length ? `
    <div class="rv-detail-section">
      <div class="rv-detail-label">Attached Media (${files.length})</div>
      <div class="rv-media-grid">
        ${files.map(f => {
          const url = '/api/reports/' + encodeURIComponent(r.id) + '/media/' + encodeURIComponent(f.filename);
          const isVid = (f.contentType || '').startsWith('video/');
          return `<div class="rv-media-thumb">
            ${isVid
              ? `<video src="${escapeHtml(url)}" controls muted></video>`
              : `<img src="${escapeHtml(url)}" alt="${escapeHtml(f.filename)}" loading="lazy">`}
            <span class="rv-media-type">${isVid ? 'VIDEO' : 'PHOTO'}</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  document.getElementById('rvDetailBody').innerHTML = `
    <div class="rv-detail-section">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <span class="rv-cat-badge"><i class="ti ${catIco}"></i> ${escapeHtml(r.category || 'Unknown')}</span>
        <span class="rv-sev-badge ${sevCls}">${escapeHtml(r.severity || '')}</span>
        <span style="font-size:10px;color:var(--text3);margin-left:auto">${escapeHtml(dateStr)}</span>
      </div>
    </div>
    <div class="rv-detail-section">
      <div class="rv-detail-label">Incident Description</div>
      <div class="rv-detail-msg">${escapeHtml(r.message || '(no description)')}</div>
    </div>
    ${mapHtml}
    ${mediaHtml}
    <div class="rv-detail-section">
      <div class="rv-detail-label">Report ID</div>
      <div style="font-size:10px;color:var(--text3);font-family:monospace">${escapeHtml(r.id || '')}</div>
    </div>
    <div class="rv-detail-section rv-actions-section">
      <div class="rv-detail-label">Actions</div>
      <div class="rv-actions-row">
        <button class="rv-action-btn rv-edit-btn" onclick="startEditReport()">
          <i class="ti ti-pencil"></i> Edit Report
        </button>
        <button class="rv-action-btn rv-delete-btn" onclick="confirmDeleteReport('${escapeHtml(r.id || '')}')">
          <i class="ti ti-trash"></i> Delete Report
        </button>
      </div>
    </div>`;

  if (hasLoc) {
    setTimeout(() => initRvDetailMap(r.location.lat, r.location.lon), 120);
  }
  detailView.scrollTop = 0;
}

function startEditReport() {
  const r = currentDetailReport;
  if (!r) return;
  if (rvDetailMap) { rvDetailMap.remove(); rvDetailMap = null; }
  const cats = ['Shooting','Kidnapping','Robbery','Checkpoint','Communal Clash','Protest','Other'];
  const sevs = ['Low','Medium','High','Critical'];
  document.getElementById('rvDetailBody').innerHTML = `
    <div class="rv-edit-form">
      <div class="rv-detail-section">
        <div class="rv-detail-label">Category</div>
        <select id="editCategory" class="rv-edit-select">
          ${cats.map(c => `<option value="${c}"${r.category === c ? ' selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="rv-detail-section">
        <div class="rv-detail-label">Severity</div>
        <select id="editSeverity" class="rv-edit-select">
          ${sevs.map(s => `<option value="${s}"${r.severity === s ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="rv-detail-section">
        <div class="rv-detail-label">Description <span style="color:var(--red)">*</span></div>
        <textarea id="editMessage" class="rv-edit-textarea" rows="6" maxlength="1000">${escapeHtml(r.message || '')}</textarea>
      </div>
      <div class="rv-edit-actions">
        <button id="rvSaveBtn" class="rv-action-btn rv-save-btn" onclick="saveReportEdit('${escapeHtml(r.id || '')}')">
          <i class="ti ti-device-floppy"></i> Save Changes
        </button>
        <button class="rv-action-btn rv-cancel-btn" onclick="openReportDetail(currentDetailReport)">
          <i class="ti ti-x"></i> Cancel
        </button>
      </div>
    </div>`;
}

async function saveReportEdit(id) {
  const category = document.getElementById('editCategory').value;
  const severity = document.getElementById('editSeverity').value;
  const message  = (document.getElementById('editMessage').value || '').trim();
  if (!message) { alert('Description is required.'); return; }
  const btn = document.getElementById('rvSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> Saving&hellip;';
  try {
    const res = await fetch('/api/reports/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, severity, message })
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const idx = reportsViewerData.findIndex(r => r.id === id);
    if (idx !== -1) {
      reportsViewerData[idx].category = category;
      reportsViewerData[idx].severity = severity;
      reportsViewerData[idx].message  = message;
      currentDetailReport = reportsViewerData[idx];
    }
    openReportDetail(currentDetailReport);
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-device-floppy"></i> Save Changes';
    alert('Save failed: ' + err.message);
  }
}

async function confirmDeleteReport(id) {
  if (!confirm('Delete this report permanently? This cannot be undone.')) return;
  const btn = document.querySelector('.rv-delete-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> Deleting&hellip;'; }
  try {
    const res = await fetch('/api/reports/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    reportsViewerData = reportsViewerData.filter(r => r.id !== id);
    currentDetailReport = null;
    const n = reportsViewerData.length;
    const countEl = document.getElementById('rvCount');
    if (countEl) countEl.textContent = n + ' report' + (n !== 1 ? 's' : '');
    const badge = document.getElementById('rvMenuBadge');
    if (badge) { badge.textContent = n; badge.style.display = n ? 'inline-flex' : 'none'; }
    closeReportDetail();
    renderReportsList(reportsViewerData);
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

function initRvDetailMap(lat, lon) {
  if (rvDetailMap) { rvDetailMap.remove(); rvDetailMap = null; }
  const el = document.getElementById('rvDetailMapEl');
  if (!el) return;
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const tile = dark ? DARK_TILE : LIGHT_TILE;
  rvDetailMap = L.map('rvDetailMapEl', { zoomControl: false, attributionControl: false }).setView([lat, lon], 13);
  L.tileLayer(tile, { maxZoom: 16 }).addTo(rvDetailMap);
  const icon = L.divIcon({
    className: '',
    html: '<div style="width:16px;height:16px;background:#f85149;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 3px rgba(248,81,73,.4)"></div>',
    iconSize: [16, 16], iconAnchor: [8, 8]
  });
  L.marker([lat, lon], { icon }).addTo(rvDetailMap);
}

function closeReportDetail() {
  const lv = document.getElementById('rvListView');
  const dv = document.getElementById('rvDetailView');
  if (lv) lv.style.display = 'block';
  if (dv) dv.style.display = 'none';
  if (rvDetailMap) { rvDetailMap.remove(); rvDetailMap = null; }
}

function showReportOnDashboard(lat, lon, category, reportId) {
  closeReportsViewer();
  if (!mapInstance) return;
  if (!userReportLayer) {
    userReportLayer = L.layerGroup().addTo(mapInstance);
  }
  userReportLayer.clearLayers();
  const icon = L.divIcon({
    className: '',
    html: '<div style="width:22px;height:22px;background:#3fb950;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 5px rgba(63,185,80,.35)"></div>',
    iconSize: [22, 22], iconAnchor: [11, 11]
  });
  const marker = L.marker([lat, lon], { icon })
    .bindPopup(`<div class="popup-title">&#128205; User Report &mdash; ${escapeHtml(category)}</div>
      <div class="popup-row"><span>Coordinates</span><span>${lat.toFixed(5)}&deg;N, ${lon.toFixed(5)}&deg;E</span></div>
      <div class="popup-row"><span>Report&nbsp;ID</span><span style="font-size:9px;font-family:monospace">${escapeHtml(reportId)}</span></div>`)
    .addTo(userReportLayer);
  mapInstance.flyTo([lat, lon], 12, { duration: 1.4 });
  setTimeout(() => marker.openPopup(), 500);
  const pill = document.getElementById('infoPill');
  if (pill) {
    pill.textContent = 'User report pinned at ' + lat.toFixed(4) + '°N, ' + lon.toFixed(4) + '°E';
    setTimeout(() => { pill.textContent = 'Click any marker for incident details. Scroll to zoom.'; }, 6000);
  }
}

// On resize: keep layout display value in sync with the active breakpoint
window.addEventListener('resize', () => {
  const layout = document.querySelector('.layout');
  if (!layout || layout.style.display === 'none') return;
  layout.style.display = window.innerWidth <= 768 ? 'flex' : 'grid';
  if (mapInstance) mapInstance.invalidateSize();
});

