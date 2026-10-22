---
name: release-check
description: Pre-release checks for the GeoSentry NG dashboard — syntax checks, the security must-fix list, and the manual QA checklist in the browser. Use before merging a pull request or deploying.
---

# Release check

## 1. Syntax

```bash
node --check app.js && node --check insights.js && node --check hotspot.js && node --check travel_safety.js && node --check live_report.js
python -m py_compile dev_server.py route_news.py route_roads.py build_acled_history.py build_map_layers.py
```

Any output other than success is a blocker.

## 2. Security (when deploying beyond one machine)

Go through `docs/HANDOFF.md` §1 and report each item as fixed or still open,
quoting the code that shows it. These two block any public deployment:

* `GET /api/reports` and the media route are readable without
  authentication.
* `DASHBOARD_ADMIN_TOKEN` is not set behind a reverse proxy.

Also confirm:

* `reports/` is not committed (`git ls-files reports` prints nothing).
* No tokens or keys are committed.

## 3. Browser QA

Start the server (skill `run-dashboard`). Then follow the QA checklist in
`docs/HANDOFF.md` §6:

* in dark and light themes;
* at 1440×900 and at phone width (375 px).

Read the console after each view. If you submit a test report, delete its
folder from `reports/` afterwards.

## 4. Report

List what passed, what failed (with the error text or a screenshot), and what
was not checked. Do not describe a release as ready while a §2 blocker is
open for a public deployment.
