# GeoSentry NG — Handoff to the Web Team

This is the starting point for the team taking over the Crime Dashboard. It
covers what exists, what state it is in, what must be fixed before a public
launch, and where to go next.

| | |
|---|---|
| Repository | `Geoinfotech-Web/Crime-Dashboard-` on GitHub |
| Main branch | `main` |
| Latest work | Pull request #4, branch `feature/acled-history-insights-layout`: ACLED history, insights, new layout. Review and merge it first |
| Contributors so far | GitHub `JohnEdet12` (project owner), `eben-gtech` |
| Stack | Plain HTML/CSS/JS front end; Python 3 standard-library server; no database, no build step |
| Documents | [ARCHITECTURE](ARCHITECTURE.md) · [TECHNICAL_REFERENCE](TECHNICAL_REFERENCE.md) · [DEPLOYMENT](DEPLOYMENT.md) · [DATA_SOURCES](DATA_SOURCES.md) · [USER_GUIDE](USER_GUIDE.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [CHANGELOG](../CHANGELOG.md) |

---

## Day-one checklist

1. Clone the repo and check out `feature/acled-history-insights-layout` (or
   `main` after PR #4 is merged).
2. Run `python dev_server.py --host 127.0.0.1 --port 8085` and open
   <http://127.0.0.1:8085>.
3. Walk through the four views with [USER_GUIDE.md](USER_GUIDE.md) beside you.
4. Read §1 below before exposing the server to anyone else.
5. Read ARCHITECTURE.md. Most changes touch `app.js` (Dashboard),
   `hotspot.js`, `travel_safety.js` or `insights.js`.

---

## 1. Must fix before public launch

These are real gaps in the current code, ordered by risk. None of them matter
while the dashboard runs on one PC for one person; all of them matter once it
is on the internet.

| # | Issue | Where | Why it matters | Suggested fix |
|---|---|---|---|---|
| 1 | **Citizen reports can be read by anyone.** `GET /api/reports` returns every report (message, exact location, file list), and `/api/reports/{id}/media/{file}` serves the photos and videos. Neither needs a login | `dev_server.py`: `handle_get_reports`, `handle_report_media` | Reporters' locations and media would be public, which is a safety and privacy risk for people reporting incidents | Require an authenticated session or the admin token for these routes. Serve the public views a redacted feed: category, severity, a location rounded to about 10 km, and time |
| 2 | **Edit and delete are open behind a proxy.** Without `DASHBOARD_ADMIN_TOKEN`, PUT and DELETE are allowed for "localhost". Behind nginx or another proxy, every request comes from localhost | `mutation_authorized()` | Anyone could alter or delete reports | Always set the token in production, or make an unset token mean "deny" |
| 3 | **The Reports viewer never sends the admin token.** Once the token is set, Edit and Delete in the UI return 403 | `app.js`: `saveReportEdit`, `confirmDeleteReport` | Moderators can't moderate | Add a moderator sign-in that keeps the token in memory and sends `X-Admin-Token` |
| 4 | **The rate limit is per proxy, not per visitor.** The client IP is taken from the socket and `X-Forwarded-For` is ignored | `client_ip()`, `submission_allowed()` | Behind a proxy, 20 reports in 10 minutes from all users combined blocks everyone, while abuse from one visitor isn't isolated | Trust `X-Forwarded-For` only from the known proxy address |
| 5 | **CORS allows every origin** (`*`) on every response | `end_headers()` | Any website can read the API from a visitor's browser | Restrict to the dashboard's own origin |
| 6 | **Public demo services are used in production paths.** These are the OSRM demo router, the tile.openstreetmap.org tiles and the Esri basemaps | `route_roads.py`, `travel_safety.js`, `app.js` | Fair-use limits and terms (see DATA_SOURCES.md) | Self-host OSRM (`ROUTING_URL`) and use a tile provider with a production licence |
| 7 | **No HTTPS in the server.** | `dev_server.py` | The camera and location in Live Report need HTTPS in browsers | Terminate TLS at a reverse proxy (DEPLOYMENT.md §2) |

---

## 2. Known issues and limitations

* **News quality depends on the feeds.** Keyword filtering lets some policy
  stories through. These are labelled *Background* and kept off the map.
  Place-name matching can miss towns that are not in the alias list
  (`initializeLocationAliasMap` in app.js) or the LGA names.
* **Headline casualty figures** come from regular expressions on the headline,
  and are labelled *not verified*.
* **AWSD aid-worker data** is a static sample of 33 records and was not
  refreshed in this release.
* **The time-range control** (24h / 7d / 30d / All) in the navigation bar only
  highlights the chosen button; it does not filter anything yet
  (`setRange` in app.js).
* **Caches are in memory**: route news (10 min) and routes (24 h). They reset
  on restart and are not shared between server processes.
* **`Cache-Control: no-store` is set on every response**, including large
  static files such as `acled_history.json` and the GeoJSON. The browser
  re-downloads them on every visit.
* **`live_report.html`** is a legacy stand-alone page that is no longer linked.
  It can be deleted once nobody uses its URL.
* **Watchlist alerts** only fire while the page is open in a browser tab. There
  is no server-side alerting.

---

## 3. Technical debt and suggested refactoring

| Area | Today | Suggestion |
|---|---|---|
| `app.js` (~2,300 lines) | One large `initDashboard()` closure holds the Dashboard map, layers, KPIs, charts and filters | Split into modules: data, map layers, KPI cards, charts, filters. Move to ES modules |
| Shared globals | Five classic scripts share globals; load order matters (app → insights → hotspot → travel → live_report) | ES modules with explicit imports, or a small bundler (Vite) |
| Inline `onclick` handlers | Functions are exposed on `window` for HTML handlers | `addEventListener` in code |
| Styling | One 1,700-line `styles.css`, with light-theme overrides scattered through it | Split per view; colour tokens are partly in `:root` |
| Tests | None | Start with Python unit tests for `dedupe_articles`, `parse_points` and the build scripts, and JS tests for `risingNow`, `extractNewsIncident` and `computeHotspots` |
| Server | Standard-library `http.server` | Fine for internal use. For growth, move the API to FastAPI or Flask behind gunicorn and keep the same routes |
| Data refresh | Manual download + script | Schedule a weekly job: download from HDX → build → commit or deploy |

---

## 4. Not built yet (proposed roadmap)

These were proposed during development and left out. They need an outside
account, a decision, or native-speaker review.

| Feature | What it needs |
|---|---|
| Telegram / WhatsApp alerts for watchlists | A bot or business account, server-side subscriptions, a scheduler |
| SMS / USSD reporting for low-connectivity areas | An Africa's Talking (or similar) account; an inbound webhook mapped to `/api/submit-report` |
| Hausa, Yoruba, Igbo and Pidgin versions | Translations reviewed by native speakers; a string table |
| AI-written daily briefing | An AI API key. The current briefing is rule-based on purpose (no cost, never invents facts) |
| Mining and food-insecurity layers | A reliable open source for mining sites; Cadre Harmonisé data from HDX |
| AWSD refresh | A download from the Aid Worker Security Database and an update of `awsdData` |
| Real time-range filter | Wire the 24h/7d/30d control to the live news and briefing windows |

---

## 5. Accounts and credentials

**None are needed to run the current version.** Every data source is public.

| Account | Needed for |
|---|---|
| Hosting / server access | Production deployment |
| `DASHBOARD_ADMIN_TOKEN` (generated by you) | Moderating reports |
| Tile provider (Esri, Mapbox, MapTiler …) | Production basemaps |
| Own OSRM server, or a routing API | Production routing |
| ACLED account (optional) | Event-level data or API access beyond the HDX aggregates |

---

## 6. Manual QA checklist

There are no automated tests yet. Run this before each release, in dark and
light themes, at desktop width (1440×900) and phone width (375 px).

**Dashboard**
- [ ] Opens with no console errors; the map is fitted to Nigeria; the four KPI
      cards show values.
- [ ] Deaths | Incidents switch: bubble sizes and colours, legend and charts
      change.
- [ ] Click a state bubble: KPIs show that state, its LGAs are shaded, and the
      ranking switches to LGAs. Click again, or use the chip ×, to return.
- [ ] Year range and time slider change the KPIs, bubbles and charts; Play
      runs through the years.
- [ ] Layers: each switch shows or hides its layer and legend section.
- [ ] Legend collapses and expands, and remembers the choice.
- [ ] Briefing shows a summary, Rising now (clicking a row zooms to the LGA),
      and the watchlist (add a state, star an LGA).
- [ ] News tab: items show place, type and trust; clicking one zooms to its pin.
- [ ] Search a state and an LGA name (e.g. "Gwoza").
- [ ] Reset view restores everything without reloading.

**Hotspot Analysis**
- [ ] Top-5 cards, map, Risk, Actors, Trend, Seasons, Live signals and Ranking
      tabs all render.
- [ ] Click a state: the profile shows the trend chart and the most affected
      LGAs.
- [ ] Export risk report downloads a CSV.

**Travel Safety**
- [ ] Assess a route (e.g. Kaduna → Jos): options, rating, directions and the
      hourly chart appear. The advice includes rising LGAs and busier months
      when they apply.
- [ ] Switch to Bus mode: motor parks appear.

**Live Report**
- [ ] The form fills the screen and scrolls inside it; submit a test report
      with a photo; the report appears in the reports viewer. Then delete the
      test folder from `reports/`.
