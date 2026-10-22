# GeoSentry NG — guide for Claude Code

Nigeria crime and security dashboard. Plain HTML/CSS/JS front end, Python
standard-library server, no build step, no database. Read
`docs/ARCHITECTURE.md` for the structure and `docs/HANDOFF.md` for the status
and known issues.

## Run

```bash
python dev_server.py --host 127.0.0.1 --port 8085
```

The `.claude/launch.json` config `crime-webapp` starts the same thing for the
preview browser.

## Where things are

* `nigeria_gis_dashboard.html` is the one page.
* Scripts load in this order and share globals:
  * `app.js`: data, live news, Dashboard view, shared helpers
  * `insights.js`: rising now, news incidents, trust, seasons, briefing,
    watchlist
  * `hotspot.js`: Hotspot view and the risk index
  * `travel_safety.js`: Travel Safety view
  * `live_report.js`: Live Report modal
* `dev_server.py` serves the API. `route_news.py` and `route_roads.py` hold
  the route news and OSRM routing.
* Data is built by `build_acled_history.py` and `build_map_layers.py` from
  HDX downloads.

## Rules for changes

* Keep the script order. A file may use another file's globals only at run
  time, not during its first load.
* Most Dashboard map code is inside `initDashboard()` in `app.js`. Anything an
  inline `onclick` needs must be added to the `Object.assign(window, {...})`
  list there.
* Use `heatColor()` / `HEAT_CLASSES` for any colour that shows an amount.
  Light-theme styles go under `[data-theme="light"]`.
* Escape feed and user text with `escapeHtml()`.
* Keep UI wording plain. Label uncertain figures ("not verified", "latest
  month incomplete").
* The server stays standard-library only; extra packages are only for the
  build scripts (`requirements.txt`).
* Never commit `reports/`. It holds citizen reports, which are personal data.

## Checks before finishing a change

```bash
node --check app.js && node --check insights.js && node --check hotspot.js && node --check travel_safety.js && node --check live_report.js
python -m py_compile dev_server.py route_news.py route_roads.py build_acled_history.py build_map_layers.py
```

Then load the page and check the browser console for errors. For larger
changes, use the QA checklist in `docs/HANDOFF.md` (skill: `release-check`).

## Project skills

| Skill | Use it to |
|---|---|
| `run-dashboard` | Start the server and confirm it works |
| `refresh-data` | Rebuild the ACLED, LGA and displacement files from new HDX downloads |
| `release-check` | Run the syntax checks, the security review and the manual QA list before a release |
| `add-news-source` | Add or fix a live feed or regional outlet |
