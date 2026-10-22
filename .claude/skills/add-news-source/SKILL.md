---
name: add-news-source
description: Add, fix or remove a news feed for the GeoSentry NG live news (rss_config.json) or the regional outlets used for route and state news (regional_sources.json). Use when a feed is failing or a new Nigerian outlet should be monitored.
---

# Add or fix a news source

## Which file

| Purpose | File | Entry |
|---|---|---|
| National live feed (Dashboard, Briefing, Hotspot live signals) | `rss_config.json` → `feeds[]` | `{"name": "Outlet", "url": "https://…/feed/"}` |
| State and route news (Travel Safety, Hotspot state profile) | `regional_sources.json` → `outlets[]` | `{"name", "scope": "regional" or "national", "states": [...], "via": "feed" or "google" or "offline", "domain", "url", "medium"}` |

Use `"via": "google"` when the outlet has no working RSS feed; its stories are
then found through a Google News search of its domain. `"offline"` entries
are kept for the record only.

## Steps

1. **Check the feed answers and is RSS or Atom:**
   ```bash
   curl -sSL -m 15 -A "Mozilla/5.0" "FEED_URL" | head -c 600
   ```
2. **Edit the JSON** and keep it valid:
   ```bash
   python -c "import json;json.load(open('rss_config.json',encoding='utf-8-sig'));json.load(open('regional_sources.json',encoding='utf-8-sig'))"
   ```
   State names must match the `zones` lists exactly, e.g. `"FCT (Abuja)"`.
3. **Restart the server**; the news caches are in memory.
4. **Confirm** `GET /api/live-news` no longer lists the feed under `warnings`,
   and that its stories appear. Duplicates of stories already carried by other
   outlets are merged, and show as "Two outlets" or "Corroborated" in the News
   tab.
5. **Only add Nigerian outlets that cover security news.** Keyword filtering
   lets some policy stories through; these show as *Background* and stay off
   the map.
