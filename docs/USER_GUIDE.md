# GeoSentry NG — User Guide

A short tour of each screen, for QA, support staff and new users.

## Top bar and navigation

* **GeoSentry NG** stays at the top left on every screen. The line beneath it
  says which view you are in.
* **Search** finds a state or a local government area (LGA) and zooms the map
  to it.
* **Buttons on the right:**
  * the sun/moon button switches between light and dark themes;
  * the clipboard button opens the submitted citizen reports;
  * the download button saves the cached news list as a CSV file.
* **Tabs:** Dashboard, Hotspot Analysis, Travel Safety and Live Report.
* **Reset view** puts the Dashboard back to how it opens: filters, map, layers
  and panels. Use it instead of refreshing the page.
* **Status** on the far right shows when the live news last updated.

## Dashboard

**Cards (top):**

* Aid Worker Incidents
* Total Deaths
* Incidents
* Affected Aid Workers

Each card shows the change against the same period last year (red = up,
blue = down) and a small yearly trend line.

**Left: Live Intelligence**

* **Briefing:** a plain-language summary of the last 24 hours. It has three
  parts:
  * **Rising now:** local government areas where incidents in the last three
    months are well above normal. Click a row to see it on the map.
  * **Watchlist:** follow a state, or star an LGA. While the page is open you
    get an alert when a new report mentions it. You can also allow desktop
    alerts.
  * **Season:** whether this month is usually busier or quieter than average.
* **News:** current reports from Nigerian outlets. Each shows:
  * the place (the LGA when the headline names one);
  * people killed or abducted, when the headline says (not verified);
  * the kind of incident;
  * a **trust level**:

    | Level | Meaning |
    |---|---|
    | One source | Only one outlet reports it so far |
    | Two outlets | Two outlets report it |
    | Corroborated | Three or more outlets, or a citizen report nearby |

  Stories about policy or background are marked *Background* and kept off the map.
* **Aid log:** the aid-worker security records that match the filters.

**Left: Filters & Controls.** Attack type, year range, actor type and severity.
These filter the aid-worker records. The year range also sets the period for
deaths and incidents.

**Centre: the map.**

* **Bubbles:** one per state. Size and colour both show deaths (or incidents,
  using the **Deaths | Incidents** switch above the map). Blue is low, red is high.
* **Click a bubble** to focus that state. Its LGAs are shaded, and the cards
  and charts switch to it. Click again, or remove the "State" chip under
  Filters, to return.
* **Layers** (top right) switches on or off:
  * Rising now
  * State shading
  * News incidents
  * Aid worker incidents
  * Aid incidents by state
  * LGA boundaries
  * Displaced people (IOM)
  * Checkpoints
* **Legend** (bottom left) explains every layer that is on, and folds away.
* **The time slider** below the map limits everything to the years up to the
  one chosen. ▶ plays through the years.

**Right: charts.**

* **Deaths and incidents by year**
* **Incident type mix**
* **Top states** (or the top LGAs of the focused state). Click a state to focus it.
* **Deaths or incidents by month:** blue months are quieter, red months busier.

## Hotspot Analysis

A 0–100 risk score for each state. It is built from:

* deaths and incidents over the last three years;
* aid-worker incidents;
* current news and citizen reports.

The formula is shown at the top.

* **Top 5 cards** and the **risk map.** Click a state for its profile.
* **Tabs:**

  | Tab | Shows |
  |---|---|
  | Risk | Top 10 and the count of states per level |
  | Actors | Who is behind attacks |
  | Trend | Deaths per year for the top 3 states |
  | Seasons | Which months are usually busier for each state |
  | Live signals | The news and reports feeding the score |
  | Ranking | All 37 states |

* **State profile:**
  * what drives the score;
  * trend;
  * most affected LGAs;
  * local news, citizen reports, aid-worker records and checkpoints.
* **Export risk report** downloads the scores as a CSV.

## Travel Safety

Pick a travel mode (Car, Bus, Convoy), the start and destination, the date and
the departure time, then **Find and assess routes**. You get:

* up to three route options, each with a risk score;
* the route drawn on the real road network, coloured by risk;
* when incidents usually happen through the day, and the safest time to leave;
* advice for the trip, including LGAs on the route where incidents are rising
  and whether your travel month is usually busier;
* recent reports along the route;
* in Bus mode, the motor parks at each end.

## Live Report

Anyone can report an incident they witness:

1. Share your location (optional).
2. Choose the type and severity, and describe what is happening.
3. Attach photos or videos, or record a short clip with the camera.
4. Submit.

No personal identity is collected.

**Submitted reports** (clipboard button in the top bar) can be viewed, and
edited or deleted by a moderator.
