# Contributing to GeoSentry NG

## Workflow

1. Branch from `main`: `feature/<short-description>` or `fix/<short-description>`.
2. Keep each pull request to one topic. Describe what changed and how you
   tested it.
3. Run the manual QA checklist in [docs/HANDOFF.md](docs/HANDOFF.md#6-manual-qa-checklist)
   for the views you touched, in both themes and at phone width.
4. Merge after one review. Do not commit to `main` directly.

## Running

```bash
python dev_server.py --host 127.0.0.1 --port 8085
```

There is no build step: edit a file, then reload the browser. Changes to the
Python files need a server restart.

## Code conventions

* **Match the existing style.** Plain JavaScript, 2-space indents, and short
  comments that explain *why*, not *what*.
* **Script order matters.** `app.js` → `insights.js` → `hotspot.js` →
  `travel_safety.js` → `live_report.js` share globals, and a file may only use
  another file's names at run time, not while it is first loading. Keep that
  order in `nigeria_gis_dashboard.html`.
* **Colours:** use `heatColor(t)` and `HEAT_CLASSES` (app.js) for anything that
  shows an amount, so the meaning of a colour is the same everywhere. Theme
  colours live in CSS variables (`--bg`, `--text`, `--blue` …), with
  `[data-theme="light"]` overrides.
* **Text in the UI** should be plain language, with figures labelled by
  source and period. If a number is uncertain, say so ("not verified",
  "latest month incomplete").
* **Escape everything** that comes from feeds or users with `escapeHtml()`
  before putting it in HTML.
* **Browser storage** is only for per-viewer conveniences. Wrap every access in
  try/catch and make the page work without it.
* **Python:** standard library only in the server; extra packages are allowed
  in the build scripts (listed in `requirements.txt`).

## Data changes

Regenerated data files (`acled_history.json`, `displacement.json`,
`vendor/nigeria-lgas.geojson`) are committed. Say which source files and dates
were used in the commit message. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Never commit

* `reports/`: citizen reports are personal data.
* Tokens or keys; use environment variables.
* `.claude/settings.local.json`: machine-specific.
