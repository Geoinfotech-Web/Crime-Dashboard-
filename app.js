const DATA_URL = 'dashboard_data.json';
const NEWS_CONFIG_URL = 'news_config.json';

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
  return response.json();
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
  document.getElementById('statesKpi').textContent = stateData.length.toLocaleString();
  // Matching-incidents KPI (reflects the geolocated aid-incident set shown on the map)
  const geo = awsdData.filter(d=>d.year>=2015);
  const matchStates = new Set(geo.map(d=>d.region)).size;
  const mk=document.getElementById('matchKpi'); if(mk) mk.textContent=geo.length.toLocaleString();
  const ms=document.getElementById('matchKpiSub'); if(ms) ms.textContent=`of ${awsdData.length.toLocaleString()} · ${matchStates} states`;
  renderSparklines();
}

function showLoadError(error) {
  const pill = document.getElementById('infoPill');
  pill.textContent = 'Could not load dashboard_data.json';
  console.error(error);
}

// --- KPI sparklines (modelled trend shapes; swap for real series when available) ---
const SPARK_SERIES = {
  'spark-deaths':     [8,10,9,13,12,16,18,17,22,26,31],
  'spark-incidents':  [14,13,16,15,18,17,20,22,21,24,26],
  'spark-aid':        [6,8,7,9,11,10,13,12,14,13,11],
  'spark-states':     [30,31,33,34,35,36,36,37,37,37,37]
};
const SPARK_COLORS = {'spark-deaths':'#ff5a5f','spark-incidents':'#f5a623','spark-aid':'#2e8fff','spark-states':'#35d08a'};
function renderSparklines(){
  Object.keys(SPARK_SERIES).forEach(id=>{
    const svg=document.getElementById(id); if(!svg) return;
    const data=SPARK_SERIES[id], color=SPARK_COLORS[id];
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

function normalizeNewsArticles(data) {
  const articles = data.articles || data.items || [];
  const seen = new Set();

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
        matchedLocations: article.matchedLocations || []
      };
    })
    .filter(article=>{
      if (!article.title || !article.url || !article.url.startsWith('http') || seen.has(article.url)) return false;
      seen.add(article.url);
      return true;
    });
}

function renderLiveNews(articles, refreshedAt, refreshMinutes, lookbackHours = 24, sourceMode = 'rss') {
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
  const windowText = ` Showing last ${lookbackHours}h.`;
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

  articles.slice(0, 20).forEach((article,index)=>{
    const highlightClass = shouldHighlightNewest && index === 0 ? ' news-item-fresh' : '';
    feed.innerHTML += `<a class="inc-item news-item${highlightClass}" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" data-report-index="${index}">
      <div class="news-title">${escapeHtml(article.title)}</div>
      <div class="news-meta"><span class="news-source">${escapeHtml(article.domain)}</span><span class="news-time">${escapeHtml(formatNewsDate(article.seenDate))}</span></div>
      <div class="inc-tags">
        <span class="inc-tag tag-live">Live report</span>
        <span class="inc-tag tag-report">Media source</span>
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
  if (!trendChart || !attackDonutChart || !monthBarChart) return;

  // "Historical" side reflects the active filter when one is applied.
  const hist = chartFilterSet || awsdData;
  const historicalYearCounts = countBy(hist, item=>String(item.year));
  const currentYearCounts = countBy(
    articles.filter(article=>!Number.isNaN(new Date(article.seenDate).getTime())),
    article=>String(new Date(article.seenDate).getFullYear())
  );
  const yearLabels = [...new Set([
    ...[...historicalYearCounts.keys()].sort(),
    ...[...currentYearCounts.keys()].sort()
  ])];

  trendChart.data.labels = yearLabels;
  trendChart.data.datasets = [
    {
      type:'bar',
      label:'Historical aid worker incidents',
      data:yearLabels.map(label=>historicalYearCounts.get(label) || 0),
      backgroundColor:'rgba(88,166,255,0.65)',
      borderRadius:4,
      order:2
    },
    {
      type:'line',
      label:'Current live reports',
      data:yearLabels.map(label=>currentYearCounts.get(label) || 0),
      borderColor:'#3fb950',
      backgroundColor:'rgba(63,185,80,0.18)',
      fill:false,
      tension:0.3,
      pointRadius:4,
      pointBackgroundColor:'#3fb950',
      pointBorderColor:'#3fb950',
      order:1
    }
  ];
  trendChart.options.plugins.legend.display = true;
  trendChart.update();

  const attackLabels = ['Kidnapping','Shooting/Killing','Armed attack','Assault','Security operations','Other'];
  const historicalAttackCounts = countBy(hist, classifyHistoricalAttack);
  const currentAttackCounts = countBy(articles, classifyLiveAttack);
  attackDonutChart.data.labels = attackLabels;
  attackDonutChart.data.datasets = [
    {
      label:'Historical incidents',
      data:attackLabels.map(label=>historicalAttackCounts.get(label) || 0),
      backgroundColor:'#58a6ff',
      borderRadius:4
    },
    {
      label:'Current live reports',
      data:attackLabels.map(label=>currentAttackCounts.get(label) || 0),
      backgroundColor:'#3fb950',
      borderRadius:4
    }
  ];
  attackDonutChart.update();

  const historicalStateCounts = countBy(hist, item=>item.region === 'FCT' ? 'Abuja' : item.region);
  const currentStateCounts = countBy(
    articles
      .map(article=>primaryStateForArticle(article))
      .filter(Boolean)
      .map(state=>state.state === 'FCT (Abuja)' ? 'Abuja' : state.state),
    value=>value
  );
  const stateLabels = topKeysFromCounts([historicalStateCounts, currentStateCounts], 6);
  monthBarChart.data.labels = stateLabels;
  monthBarChart.data.datasets = [
    {
      label:'Historical incidents',
      data:stateLabels.map(label=>historicalStateCounts.get(label) || 0),
      backgroundColor:'#d29922',
      borderRadius:4
    },
    {
      label:'Current live reports',
      data:stateLabels.map(label=>currentStateCounts.get(label) || 0),
      backgroundColor:'#3fb950',
      borderRadius:4
    }
  ];
  monthBarChart.update();
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
          liveData.sourceMode || liveData.provider || 'rss'
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
  // These helpers are declared inside this function's scope but are invoked from
  // inline handlers / top-level updateSummary, so expose them on the global object.
  Object.assign(window, {
    renderSparklines, toggleLayersPanel, updateLayerCount, setRange, toggleSevPill,
    resetFilters, switchReportTab, handleGlobalSearch, onTimeSlider, toggleTimePlay,
    applyTimeFilter, applyFilters
  });
  initializeLocationAliasMap();
  updateSummary(data.meta);
  startLiveFeedHeartbeat();
  setupLiveFeedListeners();
  loadLiveNews().catch(showNewsError);

// MAP
const map=L.map('map',{center:[9.0,8.0],zoom:6,zoomControl:true});
mapInstance = map;
liveReportLayer = L.layerGroup().addTo(map);
const initTile = document.documentElement.getAttribute('data-theme') === 'light' ? LIGHT_TILE : DARK_TILE;
mainTileLayer = L.tileLayer(initTile, TILE_OPTS).addTo(map);

const maxDeaths=Math.max(...stateData.map(d=>d.deaths));
function dColor(d){return d>2000?'#f85149':d>800?'#d29922':'#58a6ff';}
function dRadius(d){return Math.max(8,Math.sqrt(d/maxDeaths)*56);}
function riskClass(deaths){return deaths>2000?'risk-critical':deaths>800?'risk-high':'risk-elevated';}
function riskLabel(deaths){return deaths>2000?'CRITICAL':deaths>800?'HIGH':'ELEVATED';}

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
  return r > 0.75 ? '#7a0a0e' :
         r > 0.5  ? '#b11419' :
         r > 0.25 ? '#e23b36' : '#ff5a5f';
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
// Opt-in layer (off by default); load boundaries up front so the first toggle is instant.
fetch('vendor/nigeria-states.geojson')
  .then(r => r.json())
  .then(geo => { bubbleLayer.addData(geo); refreshChoropleth(); })
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

let pointLayer=L.markerClusterGroup({
  maxClusterRadius: 50,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  zoomToBoundsOnClick: true,
  iconCreateFunction: function(cluster){
    const count = cluster.getChildCount();
    const size = count < 10 ? 32 : count < 50 ? 38 : 44;
    return L.divIcon({
      html: `<div class="aid-cluster">${count}</div>`,
      className: '',
      iconSize: [size, size],
      iconAnchor: [size/2, size/2]
    });
  }
});
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

let heatLayer=L.layerGroup();
stateData.forEach(d=>{
  for(let i=0;i<Math.min(Math.ceil(d.deaths/250),18);i++){
    const jlat=d.lat+(Math.random()-.5)*1.8;
    const jlng=d.lng+(Math.random()-.5)*1.8;
    L.circleMarker([jlat,jlng],{radius:3+Math.random()*5,fillColor:'#f85149',fillOpacity:.05+Math.random()*.13,color:'transparent',weight:0}).addTo(heatLayer);
  }
});

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

const layers={bubbles:bubbleLayer,points:pointLayer,heat:heatLayer,checkpoints:checkpointLayer};
const layerState={bubbles:false,points:true,heat:false,checkpoints:false};
function toggleLayer(btn){
  const k=btn.dataset.layer;
  layerState[k]=!layerState[k];
  btn.classList.toggle('active',layerState[k]);
  layerState[k]?layers[k].addTo(map):map.removeLayer(layers[k]);
  updateLayerCount();
  syncLegend();
}

// Show only the legend sections whose layer is currently on; hide the whole
// legend when nothing is active, and divide stacked sections.
function syncLegend(){
  const legend=document.getElementById('mapLegend');
  if(!legend) return;
  let anyOn=false, firstShown=true;
  legend.querySelectorAll('.leg-section').forEach(sec=>{
    const on=!!layerState[sec.dataset.legend];
    sec.style.display = on ? '' : 'none';
    sec.classList.remove('leg-divided');
    if(on){ anyOn=true; if(!firstShown) sec.classList.add('leg-divided'); firstShown=false; }
  });
  legend.style.display = anyOn ? '' : 'none';
}

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

// Severity pills — visual filter toggles (AWSD records carry no severity field,
// so these refine the display set rather than the historical data).
function toggleSevPill(btn){
  btn.classList.toggle('active');
  renderFilterChips();
}

function resetFilters(){
  ['attackFilter','yearFilter','actorFilter'].forEach(id=>{
    const s=document.getElementById(id); if(s) s.value=FILTER_DEFAULTS[id];
  });
  document.querySelectorAll('.sev-pill').forEach(p=>p.classList.add('active'));
  applyFilters();
}

function switchReportTab(name){
  document.querySelectorAll('.lr-tab').forEach(t=>t.classList.toggle('active', t.dataset.lrtab===name));
  const news=document.getElementById('lrPaneNews'), log=document.getElementById('lrPaneLog');
  if(news) news.style.display = name==='news' ? 'flex' : 'none';
  if(log) log.style.display = name==='log' ? 'flex' : 'none';
}

// Global search — focuses the map on a matching state.
function handleGlobalSearch(value){
  const q=(value||'').trim().toLowerCase();
  if(q.length<3) return;
  const match=stateData.find(s=>s.state.toLowerCase().includes(q));
  if(match && typeof focusStateOnMap==='function'){
    focusStateOnMap(match, match.state, `<div class="popup-row"><span>Deaths</span><span>${match.deaths.toLocaleString()}</span></div><div class="popup-row"><span>Incidents</span><span>${match.incidents}</span></div>`);
  }
}

// --- Time slider: filter the aid-incident layer by year ceiling ---
let timePlayTimer=null;
function onTimeSlider(value){
  const yr=parseInt(value,10);
  const lbl=document.getElementById('tsCurrent');
  if(lbl) lbl.textContent = yr>=2026 ? 'All years' : `≤ ${yr}`;
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
  let yr=2004;
  slider.value=2004; onTimeSlider(2004);
  timePlayTimer=setInterval(()=>{
    yr++;
    if(yr>2026){ clearInterval(timePlayTimer); timePlayTimer=null; setPlayIcon(TS_PLAY_PATH); return; }
    slider.value=yr; onTimeSlider(yr);
  }, 420);
}

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
}

let timeYearMax = 2026;
function applyTimeFilter(yr){ timeYearMax = yr; applyFilters(); }

function applyFilters(){
  const atk=document.getElementById('attackFilter').value;
  const yr=document.getElementById('yearFilter').value;
  const act=document.getElementById('actorFilter').value;
  const f=awsdData.filter(d=>{
    let ok=true;
    if(d.year>timeYearMax)ok=false;
    if(atk!=='all'&&d.attack!==atk)ok=false;
    if(yr==='2015+'&&d.year<2015)ok=false;
    if(yr==='2022+'&&d.year<2022)ok=false;
    if(yr==='2019-2021'&&(d.year<2019||d.year>2021))ok=false;
    if(yr==='2015-2018'&&(d.year<2015||d.year>2018))ok=false;
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
  buildStateBars(choroCounts);

  // Charts reflect the filtered set
  chartFilterSet = f;
  updateChartsWithLiveReports(liveArticles);

  // KPI + map header counters
  const states=new Set(f.map(d=>d.region)).size;
  const mk=document.getElementById('matchKpi'); if(mk) mk.textContent=f.length.toLocaleString();
  const ms=document.getElementById('matchKpiSub'); if(ms) ms.textContent=`of ${awsdData.length.toLocaleString()} · ${states} states`;
  const mc=document.getElementById('mapCountNote'); if(mc) mc.textContent=`Showing ${f.length.toLocaleString()} geolocated incidents`;
}
renderFilterChips();

// STATE BARS
// STATE BARS — top states by filtered aid-incident count (pairs with the choropleth)
const sbEl=document.getElementById('stateRankBars');
function barClass(i){return i<2?'bar-critical':i<5?'bar-high':'bar-elevated';}
function buildStateBars(countsMap){
  const entries=[...countsMap.entries()]
    .filter(([norm,count])=>count>0 && stateMetaByNorm.has(norm))
    .map(([norm,count])=>({name:stateMetaByNorm.get(norm).state, count}))
    .sort((a,b)=>b.count-a.count)
    .slice(0,10);
  if(!entries.length){ sbEl.innerHTML='<div class="h-bar-empty">No incidents match the current filter.</div>'; return; }
  const maxC=entries[0].count;
  sbEl.innerHTML='';
  entries.forEach((d,i)=>{
    const pct=Math.round((d.count/maxC)*100);
    sbEl.innerHTML+=`<div class="h-bar-row"><span class="h-bar-lbl">${escapeHtml(d.name)}</span><div class="h-bar-track"><div class="h-bar-fill ${barClass(i)}"><span class="h-bar-val">${d.count}</span></div></div></div>`;
    sbEl.lastElementChild.querySelector('.h-bar-fill').style.width=`${pct}%`;
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
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,labels:{color:tc,font:{size:10}}}},scales:{x:{grid:{color:gc},ticks:{color:tc,font:{size:10}}},y:{beginAtZero:true,grid:{color:gc},ticks:{color:tc,font:{size:10},precision:0}}}}
});

attackDonutChart = new Chart(document.getElementById('attackDonut'),{
  type:'bar',
  data:{labels:[],datasets:[]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{color:tc,boxWidth:10,font:{size:9},padding:8}}},scales:{x:{grid:{display:false},ticks:{color:tc,font:{size:9}}},y:{beginAtZero:true,grid:{color:gc},ticks:{color:tc,font:{size:9},precision:0}}}}
});

monthBarChart = new Chart(document.getElementById('monthBar'),{
  type:'bar',
  data:{labels:[],datasets:[]},
  options:{
    responsive:true,
    maintainAspectRatio:false,
    onClick: (_, elements, chart)=>{
      if (!elements.length) return;
      const clickedLabel = chart.data.labels[elements[0].index];
      const stateName = clickedLabel === 'Abuja' ? 'FCT (Abuja)' : clickedLabel;
      const state = stateObjectByName(stateName);
      const pill = document.getElementById('infoPill');
      const mapPanel = document.querySelector('.map-center');
      if (!state) return;
      mapPanel?.scrollIntoView({behavior:'smooth', block:'center'});
      focusStateOnMap(
        state,
        `Geographic Comparison - ${clickedLabel}`,
        `
          <div class="popup-row"><span>State</span><span>${escapeHtml(clickedLabel)}</span></div>
          <div class="popup-detail">This state is currently highlighted from the Geographic Comparison chart.</div>
        `
      );
      pill.textContent = `Geographic Comparison focused on ${clickedLabel}.`;
      setTimeout(()=>{pill.textContent='Click any marker for incident details. Scroll to zoom.';},5000);
    },
    plugins:{legend:{display:true,labels:{color:tc,boxWidth:10,font:{size:9}}}},
    scales:{x:{grid:{display:false},ticks:{color:tc,font:{size:9}}},y:{beginAtZero:true,grid:{color:gc},ticks:{color:tc,font:{size:9},precision:0}}}
  }
});

// Unify the initial render: points, feed, choropleth counts, state bars, charts
// and KPIs all reflect the default filter from the start.
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
  document.querySelector('.charts-row').style.display = dash ? '' : 'none';
  document.getElementById('hotspotView').style.display = view === 'hotspot' ? 'block' : 'none';
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

