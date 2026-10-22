// ─────────────────────────────────────────────────────────────
//  INSIGHTS
//
//  Plain-language layers on top of the data app.js loads:
//    • Rising now      — LGAs where incidents in the last three complete
//                        months are well above their usual level
//    • News incidents  — each headline read into a place (state, and LGA
//                        where named), the people reported killed or
//                        abducted, and the kind of incident
//    • Trust levels    — how many outlets carry a story, and whether a
//                        citizen report nearby backs it up
//    • Seasons         — how each month compares with a state's usual month
//    • Briefing        — a short written summary of all of the above
//    • Watchlist       — places a viewer follows, with alerts while the
//                        dashboard is open
//
//  Loaded after app.js; everything here is read when the dashboard starts.
// ─────────────────────────────────────────────────────────────

const LGA_GEO_URL = 'vendor/nigeria-lgas.geojson';
const DISPLACEMENT_URL = 'displacement.json';
const RISING_RECENT = 3;          // months compared…
const RISING_BASELINE = 12;       // …with the usual level over this many months before
const RISING_MIN_EVENTS = 10;     // ignore places with fewer incidents than this
const RISING_MIN_EXCESS = 6;      // …or fewer than this many above usual
const RISING_RATIO = 2.5;         // "Rising": at least this many times usual
const SHARP_RATIO = 4;            // "Sharp rise": at least this many times usual
const CITIZEN_MATCH_KM = 60;
const CITIZEN_MATCH_HOURS = 48;
const WATCH_KEY = 'dashboard-watchlist';
const SEEN_KEY = 'dashboard-seen-news';

let lgaGeo = null;                 // FeatureCollection of LGA outlines
let lgaByPcode = new Map();        // pcode -> { pcode, name, state, lat, lng }
let lgaNameIndex = [];             // [{ key, entries }] longest names first
let displacementData = null;
let citizenReports = [];
let lgaGeoPromise = null;

function loadLgaGeo() {
  if (!lgaGeoPromise) {
    lgaGeoPromise = fetch(LGA_GEO_URL)
      .then(r => { if (!r.ok) throw new Error(`${LGA_GEO_URL}: ${r.status}`); return r.json(); })
      .then(geo => {
        lgaGeo = geo;
        lgaByPcode = new Map(geo.features.map(f => [f.properties.pcode, f.properties]));
        buildLgaNameIndex();
        return geo;
      })
      .catch(error => { console.warn('LGA outlines unavailable', error); lgaGeoPromise = null; return null; });
  }
  return lgaGeoPromise;
}

function loadDisplacement() {
  return fetch(DISPLACEMENT_URL)
    .then(r => (r.ok ? r.json() : null))
    .then(data => { displacementData = data; return data; })
    .catch(() => null);
}

function loadCitizenReports() {
  return fetch('/api/reports', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : { reports: [] }))
    .then(data => { citizenReports = data.reports || []; return citizenReports; })
    .catch(() => citizenReports);
}

function lgaInfo(pcode) { return lgaByPcode.get(pcode) || null; }

function kmBetween(a, b) {
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function plural(n, word, many) { return `${n.toLocaleString()} ${n === 1 ? word : (many || `${word}s`)}`; }

// ── Months of the recent LGA series ─────────────────────────

// The recent series ends with the month still being reported, so the last
// complete month is the one before it.
function recentMonthInfo() {
  if (!acledHistory || !acledHistory.meta.recentStart) return null;
  const [y, m] = acledHistory.meta.recentStart.split('-').map(Number);
  const total = acledHistory.meta.recentMonths;
  const label = i => { const d = new Date(y, m - 1 + i, 1); return `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`; };
  const lastComplete = total - 2;
  const recentFrom = lastComplete - RISING_RECENT + 1;
  return {
    total, label, lastComplete, recentFrom,
    baseFrom: recentFrom - RISING_BASELINE,
    recentText: `${label(recentFrom).split(' ')[0]}–${label(lastComplete)}`,
    shortText: `${label(recentFrom).split(' ')[0]}–${label(lastComplete).split(' ')[0]}`
  };
}

// ── Rising now ───────────────────────────────────────────────

// LGAs whose incidents in the last three complete months clearly exceed
// their usual three months (the monthly average over the year before, × 3).
function risingNow() {
  const info = recentMonthInfo();
  if (!info || info.baseFrom < 0) return [];
  const sum = (arr, from, to) => arr.slice(from, to + 1).reduce((a, b) => a + b, 0);
  const out = [];
  acledHistory.states.forEach(row => row.lgas.forEach(lga => {
    if (!lga.recentEvents) return;
    const recent = sum(lga.recentEvents, info.recentFrom, info.lastComplete);
    if (recent < RISING_MIN_EVENTS) return;
    const usual = sum(lga.recentEvents, info.baseFrom, info.recentFrom - 1) / RISING_BASELINE * RISING_RECENT;
    const ratio = usual > 0 ? recent / usual : Infinity;
    if (ratio < RISING_RATIO || recent - usual < RISING_MIN_EXCESS) return;
    const geo = lgaInfo(lga.pcode);
    out.push({
      pcode: lga.pcode, name: lga.name, state: row.state,
      lat: geo?.lat, lng: geo?.lng,
      recent, usual: Math.round(usual * 10) / 10,
      deaths: sum(lga.recentFatalities, info.recentFrom, info.lastComplete),
      ratio,
      level: ratio >= SHARP_RATIO ? 'sharp' : 'rising',
      period: info.recentText
    });
  }));
  return out.sort((a, b) => (b.recent - b.usual) - (a.recent - a.usual));
}

const RISING_LEVELS = {
  sharp:  { label: 'Sharp rise', cls: 'lvl-sharp' },
  rising: { label: 'Rising', cls: 'lvl-rising' }
};

function risingExplain(item) {
  const usual = item.usual < 1 ? 'almost none usually' : `usually about ${Math.max(1, Math.round(item.usual)).toLocaleString()}`;
  return `${plural(item.recent, 'incident')} in ${item.period}, ${usual}${item.deaths ? ` · ${plural(item.deaths, 'death')}` : ''}`;
}

// ── Seasons ──────────────────────────────────────────────────

// For each month, how a state's (or the country's) incidents compare with
// its average month, over the complete years on record. 1.25 = 25% above.
function seasonalIndex(stateName) {
  if (!acledHistory) return null;
  const { firstYear, lastYear, lastMonth } = acledHistory.meta;
  const toYear = lastMonth < 12 ? lastYear - 1 : lastYear;
  const months = histMonthly(stateName, 'events', firstYear, toYear);
  const mean = months.reduce((a, b) => a + b, 0) / 12;
  return mean > 0 ? months.map(v => v / mean) : null;
}

function seasonalYears() {
  if (!acledHistory) return '';
  const { firstYear, lastYear, lastMonth } = acledHistory.meta;
  return `${firstYear}–${lastMonth < 12 ? lastYear - 1 : lastYear}`;
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Reading a headline ───────────────────────────────────────

// LGA names that are also everyday words or famous places elsewhere.
const LGA_NAME_STOP = new Set(['song', 'hong', 'bali', 'lau', 'ibi', 'zing', 'kura', 'ise', 'ado', 'obi', 'ife', 'ika', 'isa', 'ido', 'oru', 'gwer', 'ini', 'esan', 'ogu', 'oji', 'ika', 'udi']);
const LGA_SUFFIX = /\s+(north|south|east|west|central|municipal|north east|north west|south east|south west)$/;

function lgaKey(name) {
  return String(name || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z]+/g, ' ').trim();
}

function buildLgaNameIndex() {
  const index = new Map();
  const stateKeys = new Set(stateData.map(s => lgaKey(s.state === 'FCT (Abuja)' ? 'Abuja' : s.state)));
  const add = (key, props) => {
    if (!key || key.length < 3 || LGA_NAME_STOP.has(key) || stateKeys.has(key)) return;
    if (!index.has(key)) index.set(key, []);
    if (!index.get(key).some(p => p.pcode === props.pcode)) index.get(key).push(props);
  };
  lgaByPcode.forEach(props => {
    const key = lgaKey(props.name);
    if (key.length >= 4) add(key, props);
    // "Mubi North" is reported as "Mubi": the bare town name points at the first of its LGAs.
    const base = key.replace(LGA_SUFFIX, '');
    if (base !== key) add(base, props);
  });
  lgaNameIndex = [...index.entries()]
    .map(([key, entries]) => ({ key, entries, re: new RegExp(`\\b${key.replace(/\s+/g, '\\s+')}\\b`) }))
    .sort((a, b) => b.key.length - a.key.length);
}

function findLga(text, states) {
  const hay = lgaKey(text);
  const stateNames = new Set(states.map(s => s.state));
  for (const item of lgaNameIndex) {
    if (!item.re.test(hay)) continue;
    const inState = item.entries.filter(e => stateNames.has(e.state));
    if (inState.length) return inState[0];
    // A name shared by several states needs the state named too.
    const statesOf = new Set(item.entries.map(e => e.state));
    if (statesOf.size === 1 && !states.length) return item.entries[0];
  }
  return null;
}

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100
};
const NUM = '(\\d{1,3}(?:,\\d{3})?|' + Object.keys(WORD_NUMBERS).join('|') + ')';
const KILL_PATTERNS = [
  new RegExp(`${NUM}\\s+(?:[a-z'-]+\\s+){0,3}?(?:killed|dead|die|died|murdered|slaughtered|massacred|feared dead|lose lives|lost their lives)`, 'g'),
  new RegExp(`(?:kill|kills|killed|killing|murder|murders|slaughter|slaughters|massacre|massacres)\\s+(?:at least\\s+|over\\s+|about\\s+)?${NUM}`, 'g'),
  new RegExp(`death toll (?:rises |climbs |hits |reaches )?(?:to )?${NUM}`, 'g')
];
const ABDUCT_PATTERNS = [
  new RegExp(`${NUM}\\s+(?:[a-z'-]+\\s+){0,3}?(?:abducted|kidnapped|taken hostage|seized)`, 'g'),
  new RegExp(`(?:abduct|abducts|abducted|kidnap|kidnaps|kidnapped)\\s+(?:at least\\s+|over\\s+|about\\s+)?${NUM}`, 'g')
];

function toNumber(token) {
  if (!token) return 0;
  if (WORD_NUMBERS[token] != null) return WORD_NUMBERS[token];
  const n = Number(token.replace(/,/g, ''));
  return Number.isFinite(n) && n < 5000 ? n : 0;
}

function largestMatch(text, patterns) {
  let best = 0;
  patterns.forEach(re => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) best = Math.max(best, toNumber(m[1]));
  });
  return best;
}

const NEWS_TYPES = {
  'Kidnapping':          { key: 'kidnap',   label: 'Kidnapping' },
  'Shooting/Killing':    { key: 'killing',  label: 'Killing' },
  'Armed attack':        { key: 'attack',   label: 'Armed attack' },
  'Security operations': { key: 'security', label: 'Security operation' },
  'Other':               { key: 'other',    label: 'Other incident' },
  Context:               { key: 'context',  label: 'Background' }
};

// Where the citizen report is: its pin, else nothing.
function citizenReportPoint(report) {
  const { lat, lon } = report.location || {};
  return typeof lat === 'number' && typeof lon === 'number' ? [lat, lon] : null;
}

function newsTrust(sources, citizenMatch) {
  if (citizenMatch || sources >= 3) return { key: 'corroborated', label: 'Corroborated', why: citizenMatch ? 'A citizen report nearby describes it too' : `${sources} outlets report it` };
  if (sources === 2) return { key: 'multiple', label: 'Two outlets', why: 'Two outlets report it' };
  return { key: 'single', label: 'One source', why: 'Only one outlet reports it so far' };
}

// Headlines describing something that happened (an attack, a kidnapping, a
// rescue…) rather than policy, comment or features that mention security.
const INCIDENT_WORDS = /\b(kill(s|ed|ing)?|murder(s|ed)?|attack(s|ed)?|abduct(s|ed|ion)?|kidnap(s|ped|pers|ping)?|gunmen|gunman|shot|shoots?|shooting|bomb(s|ed|ing)?|explosion|blast|ambush(ed)?|clash(es|ed)?|raid(s|ed)?|massacre[ds]?|invade[ds]?|burn(s|ed|t)|landmine|ied|siege|hostage|behead(s|ed)?|slaughter(s|ed)?|torture[ds]?|rescue[ds]?|dead|died|casualt(y|ies)|wounded|injured|robbery|robbers)\b/;

// Read one news article into an incident: where, what, how many, how sure.
function extractNewsIncident(article) {
  const text = String(article.title || '').toLowerCase();
  const isIncident = INCIDENT_WORDS.test(text);
  const states = typeof statesForArticle === 'function' ? statesForArticle(article) : [];
  const lga = lgaNameIndex.length ? findLga(article.title, states) : null;
  const state = lga ? stateObjectByName(lga.state) : states[0] || null;
  const type = isIncident ? NEWS_TYPES[classifyLiveAttack(article)] || NEWS_TYPES.Other : NEWS_TYPES.Context;
  let point = lga && lga.lat != null ? [lga.lat, lga.lng] : state ? [state.lat, state.lng] : null;

  const published = new Date(article.seenDate);
  let citizenMatch = null;
  if (point) {
    citizenMatch = citizenReports.find(report => {
      const at = citizenReportPoint(report);
      const when = new Date(report.receivedAt);
      if (!at || Number.isNaN(when.getTime()) || Number.isNaN(published.getTime())) return false;
      return kmBetween(at, point) <= CITIZEN_MATCH_KM && Math.abs(when - published) <= CITIZEN_MATCH_HOURS * 3600e3;
    }) || null;
  }
  const sources = 1 + (article.alsoReportedBy || []).length;
  return {
    article,
    isIncident,
    states,
    state: state ? state.state : null,
    lga,
    point,
    placeLabel: lga ? `${lga.name}, ${lga.state}` : state ? state.state : 'Nigeria (place not named)',
    precise: Boolean(lga),
    killed: largestMatch(text, KILL_PATTERNS),
    abducted: largestMatch(text, ABDUCT_PATTERNS),
    type,
    sources,
    citizenMatch,
    trust: newsTrust(sources, citizenMatch)
  };
}

// Every article read; pass true to keep only those describing an incident.
function newsIncidents(incidentsOnly = true) {
  const all = liveArticles.map(article => article.incident || (article.incident = extractNewsIncident(article)));
  return incidentsOnly ? all.filter(i => i.isIncident) : all;
}

// Recompute after the LGA names or citizen reports arrive.
function refreshNewsIncidents() {
  liveArticles.forEach(article => { article.incident = extractNewsIncident(article); });
}

function incidentFactsText(incident) {
  const facts = [];
  if (incident.killed) facts.push(`${incident.killed.toLocaleString()} killed`);
  if (incident.abducted) facts.push(`${incident.abducted.toLocaleString()} abducted`);
  return facts.join(' · ');
}

// ── Watchlist and alerts ─────────────────────────────────────

function readJson(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (error) { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* private mode */ }
}

function watchlist() { return readJson(WATCH_KEY, []); }
function watchId(item) { return item.type === 'lga' ? `lga:${item.pcode}` : `state:${item.state}`; }
function isWatched(item) { return watchlist().some(w => watchId(w) === watchId(item)); }

function toggleWatch(item) {
  const list = watchlist();
  const id = watchId(item);
  const next = list.some(w => watchId(w) === id) ? list.filter(w => watchId(w) !== id) : [...list, item];
  writeJson(WATCH_KEY, next);
  renderBriefing();
}
function removeWatch(id) {
  writeJson(WATCH_KEY, watchlist().filter(w => watchId(w) !== id));
  renderBriefing();
}
function watchState(stateName) { if (stateName) toggleWatch({ type: 'state', state: stateName, name: stateName }); }
function watchLga(pcode) {
  const lga = lgaInfo(pcode);
  if (lga) toggleWatch({ type: 'lga', pcode, name: lga.name, state: lga.state });
}

function incidentMatchesWatch(incident, item) {
  if (item.type === 'lga') return incident.lga?.pcode === item.pcode;
  return incident.states.some(s => s.state === item.state) || incident.state === item.state;
}

async function enableDesktopAlerts() {
  if (!('Notification' in window)) { showToast('This browser cannot show desktop alerts.', 'info'); return; }
  const result = await Notification.requestPermission();
  showToast(result === 'granted' ? 'Desktop alerts are on for your watchlist.' : 'Desktop alerts were not allowed. In-page alerts still work.', 'info');
  renderBriefing();
}

// New stories about watched places since the last check. The first visit
// only remembers what is already there, so it does not alert on old news.
function checkWatchAlerts() {
  const incidents = newsIncidents();
  const urls = incidents.map(i => i.article.url);
  const seen = readJson(SEEN_KEY, null);
  writeJson(SEEN_KEY, [...new Set([...(seen || []), ...urls])].slice(-400));
  if (!seen) return;
  const seenSet = new Set(seen);
  const list = watchlist();
  if (!list.length) return;
  incidents.filter(i => !seenSet.has(i.article.url)).forEach(incident => {
    const item = list.find(w => incidentMatchesWatch(incident, w));
    if (!item) return;
    const title = `New report · ${item.name}`;
    showToast(`<strong>${escapeHtml(title)}</strong><br>${escapeHtml(incident.article.title)}`, 'alert', incident.article.url);
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const note = new Notification(title, { body: incident.article.title, tag: incident.article.url });
        note.onclick = () => { window.focus(); window.open(incident.article.url, '_blank', 'noopener'); };
      } catch (error) { /* some browsers only allow notifications from a service worker */ }
    }
  });
}

function showToast(html, kind = 'info', url = null) {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.innerHTML = `<i class="ti ${kind === 'alert' ? 'ti-bell-ringing' : 'ti-info-circle'}"></i><div class="toast-txt">${html}${url ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}</div><button type="button" aria-label="Dismiss">&times;</button>`;
  toast.querySelector('button').addEventListener('click', () => toast.remove());
  host.appendChild(toast);
  setTimeout(() => toast.remove(), kind === 'alert' ? 15000 : 6000);
}

// ── Briefing ─────────────────────────────────────────────────

function topCounts(values, limit) {
  const counts = new Map();
  values.forEach(v => { if (v) counts.set(v, (counts.get(v) || 0) + 1); });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function listText(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function renderBriefing() {
  const body = document.getElementById('briefBody');
  if (!body) return;
  const incidents = newsIncidents();
  const background = newsIncidents(false).length - incidents.length;
  const now = new Date();
  const located = incidents.filter(i => i.state);
  const states = topCounts(located.map(i => i.state), 3);
  const types = topCounts(incidents.map(i => i.type.label), 1);
  const killed = incidents.reduce((sum, i) => sum + i.killed, 0);
  const abducted = incidents.reduce((sum, i) => sum + i.abducted, 0);
  const corroborated = incidents.filter(i => i.trust.key === 'corroborated').length;
  const stateCount = new Set(located.map(i => i.state)).size;

  const sentences = [];
  if (incidents.length) {
    sentences.push(`${plural(incidents.length, 'security incident')} reported in the last 24 hours${stateCount ? `, across ${plural(stateCount, 'state')}` : ''}.`);
    if (states.length) sentences.push(`Most reported: ${listText(states.map(([s, n]) => `${escapeHtml(shortStateName(s))} (${n})`))}.`);
    if (types.length && types[0][1] > 1) sentences.push(`The most common kind of report is ${escapeHtml(types[0][0].toLowerCase())} (${types[0][1]}).`);
    if (killed || abducted) sentences.push(`Headlines mention at least ${[killed ? `${killed.toLocaleString()} people killed` : '', abducted ? `${abducted.toLocaleString()} abducted` : ''].filter(Boolean).join(' and ')}; these figures are not yet verified.`);
  } else {
    sentences.push('No security incidents have been reported by the monitored outlets in the last 24 hours.');
  }
  if (background) sentences.push(`${plural(background, 'other story', 'other stories')} discuss${background === 1 ? 'es' : ''} security policy or background (in the News tab).`);

  const rising = risingNow();
  const info = recentMonthInfo();
  const season = seasonalIndex(null);
  const month = now.getMonth();
  const seasonPct = season ? Math.round((season[month] - 1) * 100) : 0;
  const watched = watchlist();

  const risingRows = rising.slice(0, 6).map(item => {
    const lvl = RISING_LEVELS[item.level];
    const watchedNow = isWatched({ type: 'lga', pcode: item.pcode });
    return `<li class="brief-row">
      <button type="button" class="brief-row-main" onclick="focusLga('${escapeHtml(item.pcode)}')" title="Show on the map">
        <span class="lvl ${lvl.cls}">${lvl.label}</span>
        <span class="brief-row-name"><strong>${escapeHtml(item.name)}</strong>, ${escapeHtml(shortStateName(item.state))}</span>
        <span class="brief-row-sub">${escapeHtml(risingExplain(item))}</span>
      </button>
      <button type="button" class="brief-star${watchedNow ? ' is-on' : ''}" onclick="watchLga('${escapeHtml(item.pcode)}')" title="${watchedNow ? 'Stop watching' : 'Watch this LGA'}" aria-pressed="${watchedNow}"><i class="ti ${watchedNow ? 'ti-star-filled' : 'ti-star'}"></i></button>
    </li>`;
  }).join('');

  const watchRows = watched.map(item => {
    const hits = incidents.filter(i => incidentMatchesWatch(i, item)).length;
    const click = item.type === 'lga' ? `focusLga('${escapeHtml(item.pcode)}')` : `selectDashState('${escapeHtml(item.state)}', true)`;
    return `<li class="brief-row">
      <button type="button" class="brief-row-main" onclick="${click}">
        <span class="watch-count${hits ? ' has' : ''}">${hits}</span>
        <span class="brief-row-name"><strong>${escapeHtml(item.name)}</strong>${item.type === 'lga' ? `, ${escapeHtml(shortStateName(item.state))}` : ''}</span>
        <span class="brief-row-sub">${hits ? `${plural(hits, 'report')} in the last 24 hours` : 'Nothing reported in the last 24 hours'}</span>
      </button>
      <button type="button" class="brief-star is-on" onclick="removeWatch('${escapeHtml(watchId(item))}')" title="Stop watching" aria-label="Stop watching ${escapeHtml(item.name)}"><i class="ti ti-x"></i></button>
    </li>`;
  }).join('');

  const options = stateData.map(s => s.state).sort()
    .filter(name => !watched.some(w => w.type === 'state' && w.state === name))
    .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  const alertsOn = 'Notification' in window && Notification.permission === 'granted';

  body.innerHTML = `
    <div class="brief-head">
      <div class="brief-date">${now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <div class="brief-sub">Situation summary · last 24 hours · updates automatically</div>
    </div>
    <p class="brief-summary">${sentences.join(' ')}</p>
    <div class="brief-stats">
      <div><b>${incidents.length}</b><span>Incidents</span></div>
      <div><b>${stateCount}</b><span>States</span></div>
      <div><b>${corroborated}</b><span>Corroborated</span></div>
    </div>

    <div class="brief-sec"><span><i class="ti ti-trending-up"></i> Rising now</span><span class="brief-sec-note">${info ? escapeHtml(info.recentText) : ''}</span></div>
    ${rising.length
      ? `<p class="brief-help">Local government areas where incidents in the last three full months are at least ${RISING_RATIO} times their usual level.</p><ul class="brief-list">${risingRows}</ul>${rising.length > 6 ? `<div class="brief-more">+ ${rising.length - 6} more on the map</div>` : ''}`
      : '<p class="brief-help">No local government area shows a clear rise over its usual level.</p>'}

    <div class="brief-sec"><span><i class="ti ti-star"></i> Watchlist</span>${watched.length ? `<span class="brief-sec-note">${alertsOn ? 'Desktop alerts on' : 'In-page alerts on'}</span>` : ''}</div>
    ${watched.length ? `<ul class="brief-list">${watchRows}</ul>` : '<p class="brief-help">Follow a state, or star an LGA above, to be alerted when new reports mention it while this page is open.</p>'}
    <div class="brief-watch-add">
      <select id="briefWatchSelect" class="filter-select" aria-label="State to watch"><option value="">Watch a state…</option>${options}</select>
      <button type="button" class="brief-btn" onclick="watchState(document.getElementById('briefWatchSelect').value)">Add</button>
      ${watched.length && !alertsOn && 'Notification' in window ? '<button type="button" class="brief-btn brief-btn-ghost" onclick="enableDesktopAlerts()" title="Also alert me outside this tab"><i class="ti ti-bell"></i></button>' : ''}
    </div>

    ${season ? `<div class="brief-sec"><span><i class="ti ti-calendar-stats"></i> Season</span><span class="brief-sec-note">${escapeHtml(seasonalYears())}</span></div>
    <p class="brief-help">${escapeHtml(MONTH_NAMES[month])} is usually <strong>${seasonPct === 0 ? 'an average month' : `${Math.abs(seasonPct)}% ${seasonPct > 0 ? 'busier' : 'quieter'} than average`}</strong> for incidents nationally. See each state's pattern under Hotspot Analysis → Seasons.</p>` : ''}

    <div class="brief-foot">Built from monitored news outlets, citizen reports and ACLED records. Headline figures are leads, not verified totals.</div>`;
}

// ── Start-up ─────────────────────────────────────────────────

// Called by app.js once the dashboard map is ready.
function startInsights(onReady) {
  Promise.allSettled([loadLgaGeo(), loadDisplacement(), loadCitizenReports()]).then(() => {
    refreshNewsIncidents();
    renderBriefing();
    if (typeof onReady === 'function') onReady();
  });
  // Citizen reports change slowly; a check every two minutes is plenty.
  setInterval(() => loadCitizenReports().then(() => {
    refreshNewsIncidents();
    renderBriefing();
    if (typeof window.onDashboardLiveUpdate === 'function') window.onDashboardLiveUpdate();
  }), 120000);
  // Keep the date line current.
  setInterval(renderBriefing, 600000);
}
