---
name: run-dashboard
description: Start the GeoSentry NG dashboard server locally and confirm the page and API respond. Use when asked to run, start, restart or "make live" the crime dashboard.
---

# Run the dashboard

1. Start the server. In the Claude desktop app, use the preview tools with
   the `crime-webapp` configuration from `.claude/launch.json`. Otherwise run,
   in the background:
   ```bash
   python dev_server.py --host 127.0.0.1 --port 8085
   ```
   Port 8085 already in use usually means an earlier copy is still running.
   Reuse it rather than starting a second one.
2. Confirm it works:
   * `GET http://127.0.0.1:8085/` returns the dashboard page.
   * `GET http://127.0.0.1:8085/api/live-news` returns JSON with `articles`.
     An empty list with `warnings` means the news feeds failed, not the server.
   * The page loads with no browser console errors, and the Total Deaths card
     shows a number.
3. Report the URL. Say that it is reachable from this machine only, unless it
   was started with `--host 0.0.0.0`.

Do not bind to `0.0.0.0` or expose the server publicly without asking first.
`docs/HANDOFF.md` §1 lists what must be fixed before that is safe; the main
problem is that citizen reports can be read without a login.
