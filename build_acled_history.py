"""Build acled_history.json from ACLED's public Nigeria aggregates on HDX.

Source dataset (updated weekly by ACLED):
    https://data.humdata.org/dataset/nigeria-acled-conflict-data

Download these two workbooks from that page, then run:

    python build_acled_history.py POLITICAL_VIOLENCE.xlsx CIVILIAN_TARGETING.xlsx

  * nigeria_hrp_political_violence_events_and_fatalities_by_month-year_as-of-*.xlsx
  * nigeria_hrp_civilian_targeting_events_and_fatalities_by_month-year_as-of-*.xlsx

Each workbook has one row per local government area per month. This script
keeps 2015 onwards and writes state totals by month, plus yearly totals for
every local government area, to acled_history.json next to this file.

Requires openpyxl (pip install openpyxl).
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

import openpyxl

FIRST_YEAR = 2015
RECENT_MONTHS = 24   # months of monthly detail kept per local government area
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
MONTH_INDEX = {name: i for i, name in enumerate(MONTHS)}

# ACLED's spelling -> the name used in dashboard_data.json
STATE_NAMES = {
    "Federal Capital Territory": "FCT (Abuja)",
    "Abuja Federal Capital Territory": "FCT (Abuja)",
    "FCT": "FCT (Abuja)",
    "Nassarawa": "Nasarawa",
}

ZONES = {
    "North Central": ["Benue", "FCT (Abuja)", "Kogi", "Kwara", "Nasarawa", "Niger", "Plateau"],
    "North East": ["Adamawa", "Bauchi", "Borno", "Gombe", "Taraba", "Yobe"],
    "North West": ["Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Sokoto", "Zamfara"],
    "South East": ["Abia", "Anambra", "Ebonyi", "Enugu", "Imo"],
    "South South": ["Akwa Ibom", "Bayelsa", "Cross River", "Delta", "Edo", "Rivers"],
    "South West": ["Ekiti", "Lagos", "Ogun", "Ondo", "Osun", "Oyo"],
}
ZONE_OF = {state: zone for zone, states in ZONES.items() for state in states}


def read_rows(path):
    """Yield (state, lga, pcode, year, month_index, events, fatalities) from 2015 on."""
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = workbook["Data"]
    rows = sheet.iter_rows(values_only=True)
    header = [str(cell or "").strip() for cell in next(rows)]
    col = {name: header.index(name) for name in
           ("Admin1", "Admin2", "Admin2 Pcode", "Month", "Year", "Events", "Fatalities")}
    for row in rows:
        try:
            year = int(row[col["Year"]])
        except (TypeError, ValueError):
            continue
        if year < FIRST_YEAR:
            continue
        month = MONTH_INDEX.get(str(row[col["Month"]] or "").strip())
        state = str(row[col["Admin1"]] or "").strip()
        if month is None or not state:
            continue
        state = STATE_NAMES.get(state, state)
        lga = str(row[col["Admin2"]] or "").strip()
        pcode = str(row[col["Admin2 Pcode"]] or "").strip()
        yield state, lga, pcode, year, month, int(row[col["Events"]] or 0), int(row[col["Fatalities"]] or 0)


def as_of_date(path):
    """The 'as-of-09oct2026' stamp HDX puts in the file name, as ISO text."""
    match = re.search(r"as-of-(\d{2})([a-z]{3})(\d{4})", Path(path).name.lower())
    if not match:
        return date.today().isoformat()
    day, mon, year = match.groups()
    month = [m[:3].lower() for m in MONTHS].index(mon) + 1
    return date(int(year), month, int(day)).isoformat()


def main(political_path, civilian_path, as_of=None):
    political = list(read_rows(political_path))
    civilian = list(read_rows(civilian_path))
    last_year = max(row[3] for row in political)
    years = list(range(FIRST_YEAR, last_year + 1))
    year_index = {year: i for i, year in enumerate(years)}

    def grid():
        return [[0] * 12 for _ in years]

    states = {}

    def state_entry(name):
        if name not in states:
            states[name] = {
                "state": name, "zone": ZONE_OF.get(name, "Unknown"),
                "events": grid(), "fatalities": grid(),
                "civEvents": grid(), "civFatalities": grid(), "_lgas": {},
            }
        return states[name]

    # Last month of the final year that has any reported event.
    last_month = max((month + 1 for _s, _l, _p, year, month, events, _f in political
                      if year == last_year and events), default=12)
    # Month index counted from January of FIRST_YEAR; the recent window ends
    # with the last reported month.
    last_index = (last_year - FIRST_YEAR) * 12 + last_month - 1
    recent_start = last_index - RECENT_MONTHS + 1

    for state, lga, pcode, year, month, events, fatalities in political:
        entry = state_entry(state)
        yi = year_index[year]
        entry["events"][yi][month] += events
        entry["fatalities"][yi][month] += fatalities
        if lga:
            item = entry["_lgas"].setdefault(lga, {
                "name": lga, "pcode": pcode,
                "events": [0] * len(years), "fatalities": [0] * len(years),
                "recentEvents": [0] * RECENT_MONTHS, "recentFatalities": [0] * RECENT_MONTHS})
            item["events"][yi] += events
            item["fatalities"][yi] += fatalities
            ri = (year - FIRST_YEAR) * 12 + month - recent_start
            if 0 <= ri < RECENT_MONTHS:
                item["recentEvents"][ri] += events
                item["recentFatalities"][ri] += fatalities

    for state, _lga, _pcode, year, month, events, fatalities in civilian:
        entry = state_entry(state)
        yi = year_index[year]
        entry["civEvents"][yi][month] += events
        entry["civFatalities"][yi][month] += fatalities

    unknown = sorted(name for name in states if name not in ZONE_OF)
    if unknown:
        print("Warning: states without a zone:", ", ".join(unknown), file=sys.stderr)

    out_states = []
    for name in sorted(states):
        entry = states[name]
        lgas = sorted(entry.pop("_lgas").values(), key=lambda item: -sum(item["fatalities"]))
        entry["lgas"] = [item for item in lgas if sum(item["events"])]
        out_states.append(entry)

    payload = {
        "meta": {
            "source": "ACLED (Armed Conflict Location & Event Data), acleddata.com",
            "sourceUrl": "https://data.humdata.org/dataset/nigeria-acled-conflict-data",
            "termsUrl": "https://acleddata.com/terms-of-use/",
            "asOf": as_of or as_of_date(political_path),
            "firstYear": FIRST_YEAR,
            "lastYear": last_year,
            "lastMonth": last_month,
            "recentMonths": RECENT_MONTHS,
            "recentStart": f"{FIRST_YEAR + recent_start // 12}-{recent_start % 12 + 1:02d}",
            "definitions": {
                "events": "Political violence events: battles, explosions/remote violence, violence against civilians, plus mob violence and excessive force against protesters.",
                "fatalities": "Reported fatalities from those events (ACLED's conservative estimate).",
                "civEvents": "Civilian targeting events: violence against civilians plus explosions/remote violence and mob violence in which civilians were targeted.",
                "civFatalities": "Reported fatalities from civilian targeting events.",
                "recentEvents": "Per local government area: events in each of the last recentMonths months, starting at recentStart (the final month is still being reported).",
            },
        },
        "years": years,
        "zones": ZONES,
        "states": out_states,
    }

    out_path = Path(__file__).resolve().parent / "acled_history.json"
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    total_events = sum(sum(map(sum, s["events"])) for s in out_states)
    total_deaths = sum(sum(map(sum, s["fatalities"])) for s in out_states)
    print(f"Wrote {out_path.name}: {len(out_states)} states, "
          f"{sum(len(s['lgas']) for s in out_states)} LGAs, {years[0]}-{years[-1]} "
          f"(to month {last_month}), {total_events:,} events, {total_deaths:,} fatalities")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
