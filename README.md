# CI360 — Nigeria Crime & Security Dashboard

A web dashboard that brings together historical conflict data, live news from
Nigerian outlets and citizen reports to show where insecurity is, where it is
rising, and how risky a road trip is.

| View | What it does |
|---|---|
| **Dashboard** | National and state picture: deaths and incidents (ACLED, 2015 → today), live news on the map, rising LGAs, a written briefing, watchlist alerts |
| **Hotspot Analysis** | A 0–100 risk score for every state, with seasons, actors, trends and a profile per state |
| **Travel Safety** | Route options between towns, risk by road segment and time of day, advice, and news along the route |
| **Live Report** | Anonymous incident reports from the public, with location and photos or video |

## Quick start

Requires Python 3.10+ (standard library only).

```bash
python dev_server.py --host 127.0.0.1 --port 8085
```

Open <http://127.0.0.1:8085>. On Windows, `start_dashboard.bat` does the same.

## Documentation

| Document | For |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | **Start here.** Status, must-fix items before launch, known issues, roadmap, QA checklist |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the system fits together (diagrams) |
| [docs/TECHNICAL_REFERENCE.md](docs/TECHNICAL_REFERENCE.md) | API, configuration, data formats, front-end modules, calculations |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Running in production, security checklist, operations |
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) | Every data source, its terms, and how to refresh the data |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | A tour of each screen |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow and code conventions |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and when |
| [CLAUDE.md](CLAUDE.md) | Project guide and skills for Claude Code |

## Stack

Plain HTML, CSS and JavaScript with Leaflet and Chart.js. A small Python
standard-library server serves the page and the `/api/*` endpoints (news,
routing, citizen reports). There is no build step and no database.

## Data credits

ACLED (acleddata.com) via HDX · OCHA administrative boundaries · IOM
Displacement Tracking Matrix · Aid Worker Security Database · OpenStreetMap
contributors · Esri basemaps. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)
for terms.
