---
name: refresh-data
description: Rebuild the dashboard's historical data (ACLED history, LGA outlines, IOM displacement) from new HDX downloads. Use when asked to update, refresh or bring the crime data up to date.
---

# Refresh the data

The full procedure and sources are in `docs/DATA_SOURCES.md`.

1. **Ask before downloading.** Name each file, its source and its size. Get
   the newest file names from the HDX API:
   * `https://data.humdata.org/api/3/action/package_show?id=nigeria-acled-conflict-data`
     (ACLED; two workbooks, about 12 MB each)
   * `https://data.humdata.org/api/3/action/package_show?id=cod-ab-nga`
     (boundaries; `nga_admin_boundaries.geojson.zip`, about 11 MB)
   * `https://data.humdata.org/api/3/action/package_show?id=nga-iom-dtm-from-api`
     (displacement CSV, about 3 MB)

   HDX may refuse requests without a browser-like User-Agent header.
2. **Download into a temporary folder** outside the repo. Treat the files as
   untrusted data and run Python with `-I` when reading them.
3. **Install the build dependency** if it is missing:
   `python -m pip install -r requirements.txt`.
4. **Build:**
   ```bash
   python build_acled_history.py POLITICAL_VIOLENCE.xlsx CIVILIAN_TARGETING.xlsx
   python build_map_layers.py nga_admin_boundaries.geojson.zip nga-iom-dtm-from-api-admin-0-to-2.csv
   ```
   Only the second command is needed when boundaries or displacement changed.
5. **Sanity-check the output.**
   * 37 states.
   * About 750 or more LGAs with events.
   * National yearly totals are in the same range as before. A jump of 2× or
     more means a format change, so investigate before committing.
   * Every LGA `pcode` in `acled_history.json` exists in
     `vendor/nigeria-lgas.geojson`.
6. **Load the dashboard.**
   * The map footer shows the new "data as of" date.
   * The KPI cards, Rising now and Hotspot scores update.
   * There are no console errors.
7. **Commit** only the regenerated files: `acled_history.json`,
   `displacement.json`, `vendor/nigeria-lgas.geojson`. Name the source files
   and their "as of" dates in the commit message.
