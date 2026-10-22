# Changelog

Dates are commit dates. Pull requests are in `Geoinfotech-Web/Crime-Dashboard-`.

## Unreleased — PR #4 (`feature/acled-history-insights-layout`)

**Data**
- **ACLED history.** State totals, KPI cards, charts and the risk index now
  use ACLED political-violence data for Jan 2015 – Oct 2026 (by state, LGA and
  month). Built by `build_acled_history.py` from HDX.
- **LGA layers.** LGA outlines (OCHA) and displaced people by LGA (IOM DTM) are
  built by `build_map_layers.py`.
- **News de-duplication.** The live news feed merges repeated stories: the
  same link, the same headline, or a near-identical headline within 48 hours.

**Dashboard**
- **Bubbles.** One bubble per state for deaths or incidents (Deaths |
  Incidents switch), driven by the year filter and time slider. Click a state
  to see its LGAs.
- **Insights.** A written Briefing, *Rising now* LGAs, news incidents pinned at
  LGA level with trust levels, and a watchlist with in-page and desktop alerts.
- **Map panels.** A collapsible legend on the map, and a grouped layers panel
  with new layers.
- **Layout.** Live Intelligence and Filters on the left, a full-height map in
  the centre, charts in a full-height right column. Reset view button. The
  States Monitored card was removed.
- **Colour.** One blue-to-red intensity scale everywhere.

**Hotspot Analysis**
- **Risk index.** Scores the last three years of ACLED data on a square-root
  scale.
- **New panels.** A Seasons tab, ACLED trends in each state profile, and the
  most affected LGAs.

**Travel Safety**
- **Route advice** flags rising LGAs and busier months.

**Across the views**
- Hotspot, Travel Safety and Live Report fill the screen height; the Live
  Report form is two columns on wide screens.
- The GeoSentry NG name stays in the top bar on every view.

**Documentation**
- Architecture, technical reference, deployment, data sources, handoff and
  user guide, plus Claude Code project skills.

## 2026-10-09 (direct to `main`)
- Aid incidents shown as individual markers instead of clusters.
- The map opens fitted to Nigeria's full extent; the incident type mix is
  coloured by type.

## 2026-10-08 — PR #3 (`feature/travel-basemaps-park-cards`)
- Travel Safety: map layer button, motor-park lists, route graphics,
  clickable timing chart.
- Dashboard: map maximise button, compact KPI cards, ACLED deaths
  choropleth, working severity filter.

## 2026-10-07 — PR #2 (`feature/density-map-local-news-bus-parks`)
- Hotspot density map and tabs, road-network routes, local news, bus parks.

## 2026-10-05 — PR #1 (`feature/hotspot-revamp-route-news`)
- Hotspot Analysis revamp; route news in Travel Safety; trips between any two
  towns with alternative routes.
- GeoSentry NG dashboard initial commit and Travel Safety route-risk advisor.

## 2026-07-09
- First upload of the dashboard files.
