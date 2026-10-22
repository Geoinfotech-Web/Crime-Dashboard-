# GeoSentry NG — Technical Reference

Reference material for developers working on the code. For the big picture,
read [ARCHITECTURE.md](ARCHITECTURE.md) first.

* [1. Repository layout](#1-repository-layout)
* [2. HTTP API](#2-http-api)
* [3. Configuration](#3-configuration)
* [4. Data file formats](#4-data-file-formats)
* [5. Front-end modules](#5-front-end-modules)
* [6. Calculations](#6-calculations)
* [7. Browser storage](#7-browser-storage)
* [8. External dependencies](#8-external-dependencies)

---

## 1. Repository layout

```
nigeria_gis_dashboard.html   The application page (all four views)
styles.css                   All styling (dark theme default, light theme overrides)
app.js                       Data loading, live news, Dashboard view, shared helpers
insights.js                  Rising now, news incidents, trust, seasons, briefing, watchlist
hotspot.js                   Hotspot Analysis view and the composite risk index
travel_safety.js             Travel Safety view
live_report.js               Live Report (citizen report) modal
logo.png                     Brand logo

dev_server.py                HTTP server: static files + /api/*
route_news.py                News for states/towns (Travel Safety, Hotspot state profile)
route_roads.py               Road routing through OSRM

build_acled_history.py       Builds acled_history.json from ACLED (HDX) workbooks
build_map_layers.py          Builds LGA outlines and displacement.json (HDX)

dashboard_data.json          States, AWSD aid-worker records, checkpoints
acled_history.json           ACLED 2015 → history (built)
displacement.json            IOM DTM displaced people per LGA (built)
bus_parks.json               Motor parks (OpenStreetMap)
rss_config.json              Live news feeds and keywords
news_config.json             GDELT fallback query
regional_sources.json        117 regional/national outlets by zone and state
live_rss_news_export.csv     Cached news snapshot (fallback + topbar download)
live_rss_analysis.json       Timestamp of that snapshot

vendor/nigeria-states.geojson   State outlines
vendor/nigeria-lgas.geojson     LGA outlines + centres (built)
vendor/tabler-icons/            Icon font

start_dashboard.bat, dev_server.ps1   Windows launchers
design/                      UI mock-ups (PNG)
docs/                        This documentation
.claude/                     Claude Code project skills and launch config (see CLAUDE.md)
live_report.html             Legacy stand-alone report page, not linked from the app
reports/                     Citizen reports written at run time (git-ignored)
```

---

## 2. HTTP API

All endpoints are served by `dev_server.py`. All responses carry
`Access-Control-Allow-Origin: *` and `Cache-Control: no-store`.

### `GET /api/live-news`

The live news feed used by the Dashboard, Briefing and Hotspot.

Sources are tried in order:

1. **RSS feeds** listed in `rss_config.json`. They are fetched in parallel with
   a 6-second timeout per feed.
2. **GDELT** (`news_config.json`), used only when the RSS step finds nothing.
3. **Cached CSV snapshot**, used when GDELT also fails.

An article is kept only when it:

* matches at least one keyword;
* names Nigeria or a Nigerian place; and
* falls inside `lookbackHours`.

Repeated stories are then merged (see [§6.4](#64-repeated-news)), and the
newest `maxItems` are returned.

```json
{
  "provider": "rss",
  "sourceMode": "rss | gdelt | cached",
  "isCachedSnapshot": false,
  "refreshedAt": "2026-10-22T09:30:00Z",
  "refreshMinutes": 1,
  "lookbackHours": 24,
  "duplicatesRemoved": 3,
  "warnings": ["Feed name: error text"],
  "articles": [{
    "title": "…", "url": "https://…", "domain": "Daily Trust", "source": "Daily Trust",
    "seenDate": "2026-10-22T08:10:00Z",
    "matchedKeywords": ["kidnap"], "matchedLocations": ["Zamfara"],
    "alsoReportedBy": ["Punch"], "duplicateCount": 1
  }]
}
```

### `GET /api/rss-news`

The RSS step alone: the same shape as `/api/live-news` but with no fallback.

### `GET /api/route-news`

News for states and towns, built by `route_news.py` from
`regional_sources.json` and Google News RSS. Results are cached for
`cacheMinutes` (10).

| Query | Meaning |
|---|---|
| `states` | `|`-separated state names (max 14) |
| `places` | `|`-separated towns along the route (max 16; 24 with `local=1`) |
| `hubs` | Towns where the route changes road |
| `label` | Route label (max 80 chars) |
| `days` | Window, 1–14 (default `windowDays` = 7) |
| `local=1` | One state and its towns (Hotspot state profile) |

The response has `events` (one per incident, with outlets folded together),
`counts`, `sources` and a 0–100 live pressure index. The 400 error means no
state was recognised.

### `GET /api/road-route?points=lat,lng;lat,lng;…`

Driving route through 2–14 points via OSRM (`route_roads.py`). Results are
cached for 24 hours, and requests are spaced at least 1.1 seconds apart.

Errors:

| Status | Meaning |
|---|---|
| 400 | Bad points |
| 502 | The routing server is unavailable |

Set the `ROUTING_URL` environment variable to use your own OSRM server.

### `POST /api/submit-report`

A citizen report, sent as `multipart/form-data`.

| Field | Notes |
|---|---|
| `message` | Required |
| `category` | Shooting, Kidnapping, Robbery, Checkpoint, Communal Clash, Protest, Other |
| `severity` | Low, Medium, High, Critical |
| `locationShared`, `lat`, `lon`, `accuracy` | Optional location |
| files | Up to 10 files; the whole request must be under 80 MB |

The report is saved as `reports/{id}/meta.json` plus its media files.

| Response | Meaning |
|---|---|
| `200 {"ok":true,"reportId":"20261022T093000Z-ab12cd34","filesSaved":2}` | Saved |
| 400 | Validation error |
| 429 | Rate limit reached: `DASHBOARD_SUBMIT_RATE_MAX` reports per `DASHBOARD_SUBMIT_RATE_WINDOW` seconds per IP |

### `GET /api/reports`

Every saved report (`meta.json` contents), newest first.

> **Not authenticated**: see [HANDOFF.md](HANDOFF.md#1-must-fix-before-public-launch).

### `GET /api/reports/{id}/media/{filename}`

Streams an attached file. The path is checked so it cannot leave `reports/`.

> **Not authenticated.**

### `PUT /api/reports/{id}` and `DELETE /api/reports/{id}`

Edit (JSON body `{category, severity, message}`) or delete a report.

Who is allowed:

* **`DASHBOARD_ADMIN_TOKEN` is set:** the request needs header
  `X-Admin-Token: <token>`.
* **It is not set:** the request must come from localhost.

Unauthorised requests get a 403.

### Static files

`/` serves `nigeria_gis_dashboard.html`. Every other path is served from the
project folder, except `/reports/…`, which returns 403.

---

## 3. Configuration

### Environment variables

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `HOST` | `0.0.0.0` | dev_server.py | Bind address (`--host` overrides) |
| `PORT` | `8085` | dev_server.py | Port (`--port` overrides) |
| `DASHBOARD_ADMIN_TOKEN` | *(unset)* | dev_server.py | Token needed to edit or delete reports |
| `DASHBOARD_SUBMIT_RATE_MAX` | `20` | dev_server.py | Reports allowed per IP per window |
| `DASHBOARD_SUBMIT_RATE_WINDOW` | `600` | dev_server.py | Window in seconds |
| `ROUTING_URL` | `https://router.project-osrm.org` | route_roads.py | OSRM server |

Command-line options are `--host`, `--port` and `--root` (the folder to serve;
default is the script's own folder).

### Config files

| File | Key settings |
|---|---|
| `rss_config.json` | `feeds[]` (name, url); `keywords[]` (any must match); `locationKeywords[]` (one must match); `lookbackHours` (24); `maxItems` (30) |
| `news_config.json` | GDELT `endpoint`, `keywords`, `sourceCountry`, `timespan`, `maxRecords` |
| `regional_sources.json` | `zones` (state lists); `outlets[]` with `scope` (regional/national), `states`, `via` (feed/google/offline), `domain`, `url`, `medium`; `windowDays`; `cacheMinutes` |

### Front-end constants worth knowing

| Constant | File | Default | Meaning |
|---|---|---|---|
| `LIVE_REFRESH_MS` / `LIVE_RETRY_MS` | app.js | 30 000 / 10 000 | How often to poll the news feed / retry after a failure |
| `HEAT_STOPS` | app.js | blue → grey → red | The one intensity colour scale |
| `RISK_WINDOW_YEARS` | app.js | 3 | Years of ACLED data scored by the risk index |
| `RISING_*`, `SHARP_RATIO` | insights.js | see [§6.2](#62-rising-now) | Rising-now thresholds |
| `CITIZEN_MATCH_KM` / `_HOURS` | insights.js | 60 km / 48 h | Citizen-report corroboration window |
| `HS_WEIGHTS_DB` / `HS_WEIGHTS_LIVE` | hotspot.js | see [§6.1](#61-composite-risk-index-hotspot) | Risk index weights |
| `TV_SCORE_WEIGHTS` | travel_safety.js | segments .45, states .20, time .15, live .20 | Route score weights |

---

## 4. Data file formats

### `acled_history.json`

```jsonc
{
  "meta": {
    "source": "ACLED …", "sourceUrl": "https://data.humdata.org/…", "termsUrl": "…",
    "asOf": "2026-10-09",          // date in the HDX file name
    "firstYear": 2015, "lastYear": 2026,
    "lastMonth": 10,               // last month with data (still being reported)
    "recentMonths": 24,            // length of each LGA's monthly series
    "recentStart": "2024-11",      // first month of that series
    "definitions": { "events": "…", "fatalities": "…", "civEvents": "…", "civFatalities": "…" }
  },
  "years": [2015, …, 2026],
  "zones": { "North East": ["Adamawa", …], … },
  "states": [{
    "state": "Borno", "zone": "North East",
    "events":        [[12 months] × years],   // political violence events
    "fatalities":    [[12 months] × years],
    "civEvents":     [[12 months] × years],   // civilian-targeting events
    "civFatalities": [[12 months] × years],
    "lgas": [{
      "name": "Gwoza", "pcode": "NG008011",
      "events": [per year], "fatalities": [per year],
      "recentEvents": [24 months], "recentFatalities": [24 months]
    }]
  }]
}
```

State names follow `dashboard_data.json`: `"FCT (Abuja)"`, `"Nasarawa"`. LGA
`pcode` values are OCHA codes and match `vendor/nigeria-lgas.geojson`.

### `vendor/nigeria-lgas.geojson`

A FeatureCollection of 774 LGAs. Each feature has `properties.pcode`, `name`,
`state`, `lat` and `lng` (the centre). Geometry is simplified to about 650 m
with 4-decimal coordinates.

### `displacement.json`

```json
{ "meta": { "source": "IOM DTM via HDX", "from": "2024-05", "to": "2025-10", "note": "…" },
  "lgas": { "NG008011": { "idps": 123456, "asOf": "2025-10" } } }
```

### `dashboard_data.json`

| Key | Contents |
|---|---|
| `meta` | Title, subtitle, date range, source note |
| `stateData[]` | `{state, lat, lng, deaths, incidents}`. The totals are only a fallback; `acled_history.json` replaces them at load |
| `awsdData[]` | `{lat, lng, region, city, killed, wounded, kidnapped, affected, attack, actor, motive, context, year, details}` |
| `checkpoints[]` | `{lat, lng, name, state, type: Police/Military/Joint/Customs, road, status}` |
| `charts` | Legacy summary series (not read by the current UI) |

### `reports/{id}/meta.json`

```json
{ "id": "20261022T093000Z-ab12cd34", "receivedAt": "…Z", "message": "…",
  "category": "Kidnapping", "severity": "High",
  "location": { "shared": true, "lat": 9.07, "lon": 7.39, "accuracy": 25 },
  "files": [{ "filename": "clip.webm", "contentType": "video/webm", "size": 123456 }] }
```

---

## 5. Front-end modules

Scripts load in this order and share globals: `app.js` → `insights.js` →
`hotspot.js` → `travel_safety.js` → `live_report.js`.

### app.js

| Area | Main functions / globals |
|---|---|
| Data | `loadDashboardData()`; `adoptHistory()`; `histYearly()`, `histTotal()`, `histMonthly()`, `histTopLgas()`; globals `stateData`, `awsdData`, `acledHistory` |
| Colour | `HEAT_STOPS`, `heatColor(t)`, `heatTextColor(t)` |
| Live news | `loadLiveNews()`, `renderLiveNews()`, `normalizeNewsArticles()`; global `liveArticles` |
| Places in text | `statesForArticle()`, `resolveArticleLocations()`, `classifyLiveAttack()` |
| Dashboard | `initDashboard(data)`. Inside it: bubbles, shading, LGA focus, news pins, rising layer, layers panel, legend, KPI cards (`renderDashKpis`), charts (`renderAcledCharts`), state ranking, filters (`applyFilters`), time slider, `selectDashState()`, `focusLga()`, `setDashMetric()`, `resetDashboard()` |
| Views | `navTo()`, `showView()`, `toggleMapMax()`, `toggleTheme()` / `applyTheme()` |
| Reports viewer | `openReportsViewer()`, `loadReports()`, `openReportDetail()`, edit and delete |

### insights.js

| Area | Functions |
|---|---|
| Loading | `loadLgaGeo()`, `loadDisplacement()`, `loadCitizenReports()`, `startInsights(onReady)` |
| Rising now | `recentMonthInfo()`, `risingNow()`, `risingExplain()`, `RISING_LEVELS` |
| Seasons | `seasonalIndex(stateOrNull)`, `seasonalYears()` |
| News incidents | `extractNewsIncident(article)`, `newsIncidents(incidentsOnly = true)`, `incidentFactsText()`, `findLga()` |
| Trust | `newsTrust(sources, citizenMatch)` |
| Watchlist | `watchlist()`, `toggleWatch()`, `watchState()`, `watchLga()`, `removeWatch()`, `checkWatchAlerts()`, `enableDesktopAlerts()`, `showToast()` |
| Briefing | `renderBriefing()` |

### hotspot.js

| Area | Functions |
|---|---|
| Scoring | `computeHotspots()` → `cachedHotspots`; `hsLevel(score)`; `HS_LEVELS` |
| Rendering | `hsRecalculate()`; panels and tabs (`hsSetPanelTab`); `renderHsSeasons()`; state profile (`hsOpenState`, `hsRenderStatePanel`) |
| Export | `exportHotspotReport()` (CSV) |

### travel_safety.js

| Area | Functions / data |
|---|---|
| Road network | `TV_CORRIDORS`, a hand-built network of inter-city corridors with segment risk |
| Planning | `tvPlanRoutes()` (up to 3 alternatives) |
| Roads | `tvApplyRoad()` (OSRM geometry, via `/api/road-route`) |
| Scoring | `tvRouteRisk()` |
| Timing | `tvHourlyCurve()` |
| Advice | `renderTravelRecs()` |
| News | `/api/route-news` |
| Basemaps | `TV_BASEMAPS` |
| Bus parks | `bus_parks.json` |

---

## 6. Calculations

### 6.1 Composite risk index (Hotspot)

Each state gets five inputs, each scaled 0–1 against the highest state:

* **Deaths** and **Incidents**: ACLED, over the last `RISK_WINDOW_YEARS` (3)
  years, on a **square-root scale**. Borno alone would otherwise flatten every
  other state.
* **Aid incidents** and **Affected workers**: AWSD, all years.
* **Live signals**: current news naming the state, plus citizen reports in it.
  Each article adds 1 (0.5 for "security operations" or "other"). Each citizen
  report adds 0.5, 1, 1.5 or 2 by severity.

**Weights.**

| Input | Without live signals (`HS_WEIGHTS_DB`) | With live signals (`HS_WEIGHTS_LIVE`) |
|---|---|---|
| Deaths | 0.45 | 0.40 |
| Incidents | 0.30 | 0.25 |
| Aid incidents | 0.15 | 0.15 |
| Affected workers | 0.10 | 0.10 |
| Live signals | 0 | 0.10 |

**Score.** The weighted sums are rescaled so the highest state scores 100.

**Levels** (`HS_LEVELS`): Critical ≥ 85, Severe ≥ 75, High ≥ 60, Elevated ≥ 40,
Moderate ≥ 20, Low < 20.

**Travel Safety baseline** (`tvBaselineLevel`): a state scoring 45 or more is
high, 28–44 is caution, and anything lower is low.

### 6.2 Rising now

The input is each LGA's last 24 months of ACLED events (`recentEvents`). The
final month is still being reported, so it is ignored.

| Term | Definition |
|---|---|
| Recent | The last 3 complete months |
| Usual | Average month over the 12 months before that, × 3 |

An LGA is flagged when **recent ≥ 10**, **recent − usual ≥ 6** and
**recent ≥ 2.5 × usual**. It is a **Sharp rise** at 4 × usual or more, and
**Rising** otherwise.

### 6.3 News incidents and trust

**Incident or background?** A headline counts as an incident only if it uses
an event word (killed, abducted, attack, gunmen, rescued, …). Other stories
are labelled *Background*: they stay in the News tab but get no map pin and
are not counted.

**Place.** The state comes from the place-name alias map. The LGA is found by
matching LGA names from the boundary file. Rules:

* Names shorter than 4 letters are skipped.
* Common words are skipped.
* A name shared by several states only counts when the state is also named.

The pin sits at the LGA centre, or at the state centre when no LGA is named.

**Figures.** Regular expressions read "N killed", "kill N", "N abducted" and
similar. Number words up to "hundred" are understood. These figures are
labelled *not verified*.

**Trust.**

| Level | Rule |
|---|---|
| Corroborated | 3 or more outlets, or a citizen report within 60 km and 48 h |
| Two outlets | 2 outlets |
| One source | Otherwise |

### 6.4 Repeated news

`dedupe_articles()` in dev_server.py treats two articles as the same story when
they share any one of these:

* **A link**, ignoring scheme, `www.`, `m.`, `amp`, the trailing slash, and
  tracking parameters such as `utm_*` and `fbclid`.
* **A headline**, ignoring a trailing " - Outlet".
* **Nearly the same significant words**: at least 4 shared words that make up
  75% or more of the shorter headline, published within 48 hours.

The copy kept is the outlet's own link rather than the Google News redirect
and, after that, the earliest. The other outlets are listed in `alsoReportedBy`.

### 6.5 Seasons

A state's monthly ACLED events are summed over complete years
(2015 → the last full year). Each month is then divided by the state's average
month: 1.25 means 25% busier than usual.

### 6.6 KPI change on last year

The change compares the latest year in the selected window with the year
before. For the current, unfinished year it compares only the complete months
(e.g. Jan–Sep 2026 against Jan–Sep 2025).

---

## 7. Browser storage

All entries are in `localStorage`, per viewer. They are optional, and every
read and write is wrapped in try/catch.

| Key | Contents |
|---|---|
| `dashboard-theme` | `dark` or `light` |
| `dashboard-legend-collapsed` | `1` or `0` |
| `dashboard-watchlist` | Watched places: `[{type: 'state'\|'lga', name, state, pcode?}]` |
| `dashboard-seen-news` | URLs already alerted on, so alerts fire only for new stories (last 400) |
| `tv-basemap` | Travel Safety basemap choice |

---

## 8. External dependencies

| Dependency | Where | Notes |
|---|---|---|
| Leaflet 1.9.4, Leaflet.markercluster 1.5.3 | unpkg.com | Map library; clustering is used for checkpoints |
| Chart.js 4.4.1 | cdnjs.cloudflare.com | Charts |
| Esri ArcGIS Online tiles | server.arcgisonline.com | Canvas (dark/light), imagery, topo, labels |
| OpenStreetMap tiles | tile.openstreetmap.org | Travel Safety "Streets" basemap |
| OSRM | router.project-osrm.org | Public demo server; replace for production |
| News RSS feeds | rss_config.json, regional_sources.json | 12 live-feed sources; 117 outlets for route news |
| Google News RSS | news.google.com | Route and state news searches |
| GDELT Doc API | api.gdeltproject.org | Live news fallback |
| openpyxl | pip | Only for `build_acled_history.py` |

The terms and limits for each service are listed in
[DATA_SOURCES.md](DATA_SOURCES.md).
