# GeoSentry NG — Data Sources, Terms and Refresh

Every number on the dashboard comes from one of the sources below. Keep the
attributions visible (the Dashboard map footer already credits ACLED, OCHA,
IOM DTM and AWSD). **Review each provider's terms before any commercial use or
public launch**; the notes here summarise what was known during development
and are not legal advice.

## Historical and reference data (files in the repo)

| Data | Provider | Coverage | File | Terms to respect |
|---|---|---|---|---|
| Political violence and civilian-targeting events and fatalities, by state, LGA and month | **ACLED**, via HDX ([dataset](https://data.humdata.org/dataset/nigeria-acled-conflict-data)) | Jan 2015 – Oct 2026 (as of 9 Oct 2026; the last month is incomplete) | `acled_history.json` | [ACLED Terms of Use and Attribution Policy](https://acleddata.com/terms-of-use/). Attribution is required; check the restrictions on redistribution and commercial use |
| LGA boundaries (774) | **OCHA** Common Operational Dataset ([cod-ab-nga](https://data.humdata.org/dataset/cod-ab-nga)) | 2019 boundaries | `vendor/nigeria-lgas.geojson` | CC BY-IGO: attribution |
| Displaced people (IDPs) by LGA | **IOM DTM**, via HDX ([dataset](https://data.humdata.org/dataset/nga-iom-dtm-from-api)) | Rounds May 2024 – Oct 2025, 303 LGAs in the North East, North Central and North West | `displacement.json` | IOM DTM terms on HDX: attribution |
| Aid-worker security incidents | **Aid Worker Security Database (AWSD)** | 33 Nigeria records, 2004–2026 (not refreshed in this release) | `dashboard_data.json` → `awsdData` | AWSD terms: attribution |
| State outlines | Pre-existing in the repo | 37 states | `vendor/nigeria-states.geojson` | Confirm the original source before redistribution |
| Checkpoints | Compiled for this project | 109 locations | `dashboard_data.json` → `checkpoints` | Treat as indicative, not authoritative |
| Bus parks | **OpenStreetMap** contributors, retrieved 2026-10-06 | 28 towns | `bus_parks.json` | ODbL: attribution and share-alike |

## Live sources (fetched by the server at run time)

| Source | Used for | Notes |
|---|---|---|
| RSS feeds of 12 Nigerian outlets and searches (`rss_config.json`) | Live news feed, Briefing, map pins | A failing feed is listed in `warnings` |
| 117 outlets in `regional_sources.json` (76 RSS, 25 via Google News search, 16 offline/print only) | Travel Safety route news, Hotspot state news | Cached 10 minutes |
| Google News RSS search | Route and state news | Unofficial endpoint: it may throttle or change without notice |
| GDELT Doc API | Fallback when RSS finds nothing | Free, best effort |
| OSRM public demo server | Road geometry for Travel Safety | Fair-use limit (about 1 request/second, no heavy use). Run your own OSRM server for production (`ROUTING_URL`) |
| Esri ArcGIS Online basemaps | Map backgrounds | Attribution is required; Esri's terms may require an account for production or commercial use |
| OpenStreetMap tile server | Travel Safety "Streets" basemap | OSM tile usage policy forbids heavy use. Use a commercial tile provider for production |

## Refreshing the data

ACLED publishes new weekly aggregates on HDX. The refresh is manual and takes
about five minutes.

### 1. ACLED history (`acled_history.json`)

1. On the [HDX ACLED Nigeria page](https://data.humdata.org/dataset/nigeria-acled-conflict-data),
   download the two newest workbooks (about 12 MB each):
   * `nigeria_hrp_political_violence_events_and_fatalities_by_month-year_as-of-DDmonYYYY.xlsx`
   * `nigeria_hrp_civilian_targeting_events_and_fatalities_by_month-year_as-of-DDmonYYYY.xlsx`
2. Run:
   ```bash
   python -m pip install -r requirements.txt
   python build_acled_history.py PATH/TO/political_violence.xlsx PATH/TO/civilian_targeting.xlsx
   ```
   The script prints a summary such as
   `Wrote acled_history.json: 37 states, 757 LGAs, 2015-2026 (to month 10), 36,861 events, 110,233 fatalities`.
   The "as of" date is read from the file name; pass a third argument
   (`2026-10-09`) if the name has been changed.
3. Reload the dashboard. The KPI cards, bubbles, charts, Rising now, Seasons and
   the Hotspot risk index all update from this one file.
4. Commit `acled_history.json`.

### 2. LGA outlines and displacement

1. Download `nga_admin_boundaries.geojson.zip` from
   [cod-ab-nga](https://data.humdata.org/dataset/cod-ab-nga) (about 11 MB), and
   `nga-iom-dtm-from-api-admin-0-to-2.csv` from
   [nga-iom-dtm-from-api](https://data.humdata.org/dataset/nga-iom-dtm-from-api) (about 3 MB).
2. Run:
   ```bash
   python build_map_layers.py PATH/TO/nga_admin_boundaries.geojson.zip PATH/TO/nga-iom-dtm-from-api-admin-0-to-2.csv
   ```
3. Commit `vendor/nigeria-lgas.geojson` and `displacement.json`.

Displacement counts change every few months; boundaries rarely change.

### 3. News sources

* To add, remove or fix a live feed, edit `rss_config.json`.
* To add, remove or fix a regional outlet, edit `regional_sources.json`.

No code change is needed. Restart the server to clear the caches.

## Known data caveats

* **Headline figures are leads, not counts.** People killed or abducted are
  read from headline wording; the UI marks them "not verified".
* **ACLED's latest month is incomplete.** The KPI change and Rising now compare
  only complete months.
* **Displacement coverage is northern only.** DTM does not assess the South,
  so blank LGAs there mean "not assessed", not "no displacement".
* **AWSD records are a small static sample** (33). They should be refreshed
  from AWSD, or replaced, before relying on aid-worker figures.
