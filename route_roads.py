"""Road-network routing for the Travel Safety advisor.

A trip is sent to an OSRM routing server, which answers with the road it
would actually be driven on: the line of the road, its length and driving
time, and the sequence of roads followed. The public OSRM demo server (built
on OpenStreetMap) is used by default; point ROUTING_URL at another OSRM
server to use your own.

Answers are cached, and requests are spaced out, because the demo server
asks for no more than about one request a second.
"""

import json
import os
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROUTING_URL = os.environ.get("ROUTING_URL", "https://router.project-osrm.org").rstrip("/")
CACHE_SECONDS = 24 * 60 * 60
MIN_SPACING_SECONDS = 1.1
MAX_POINTS = 14

_cache = {}
_cache_lock = threading.Lock()
_request_lock = threading.Lock()
_last_request = [0.0]


def parse_points(raw):
    """'lat,lng;lat,lng;…' -> [(lat, lng), …], rejecting anything malformed."""
    points = []
    for part in (raw or "").split(";"):
        if not part.strip():
            continue
        try:
            lat, lng = (float(value) for value in part.split(","))
        except ValueError:
            raise ValueError("Each point must be 'lat,lng'")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError("Point out of range")
        points.append((round(lat, 5), round(lng, 5)))
    if not 2 <= len(points) <= MAX_POINTS:
        raise ValueError(f"Between 2 and {MAX_POINTS} points are needed")
    return points


def _fetch(points):
    coords = ";".join(f"{lng},{lat}" for lat, lng in points)
    url = (f"{ROUTING_URL}/route/v1/driving/{coords}"
           "?overview=full&geometries=polyline&steps=true&continue_straight=false")
    request = Request(url, headers={
        "User-Agent": "NigeriaGISDashboard/1.0 travel safety",
        "Accept": "application/json",
    })
    for attempt in range(3):
        with _request_lock:
            wait = MIN_SPACING_SECONDS - (time.time() - _last_request[0])
            if wait > 0:
                time.sleep(wait)
            try:
                with urlopen(request, timeout=25) as response:
                    return json.loads(response.read().decode("utf-8", errors="replace"))
            except HTTPError as exc:
                if exc.code != 429 or attempt == 2:
                    raise
            finally:
                _last_request[0] = time.time()
        time.sleep(2 + attempt * 2)     # told to slow down: back off, then retry


def _trim(data):
    if data.get("code") != "Ok" or not data.get("routes"):
        raise ValueError(data.get("message") or "No road route was found between these places")
    route = data["routes"][0]
    return {
        "provider": "OSRM · OpenStreetMap",
        "distanceKm": round(route["distance"] / 1000, 1),
        "durationMin": round(route["duration"] / 60),
        "geometry": route["geometry"],          # encoded polyline, precision 5
        "legs": [{
            "distanceKm": round(leg["distance"] / 1000, 1),
            "durationMin": round(leg["duration"] / 60),
            "steps": [{
                "name": step.get("name") or "",
                "ref": step.get("ref") or "",
                "km": round(step["distance"] / 1000, 2),
                "min": round(step["duration"] / 60, 1),
            } for step in leg.get("steps", []) if step.get("distance")],
        } for leg in route["legs"]],
    }


def build_road_route(raw_points):
    points = parse_points(raw_points)
    key = tuple(points)
    with _cache_lock:
        cached = _cache.get(key)
        if cached and time.time() - cached[0] < CACHE_SECONDS:
            return cached[1]
    payload = _trim(_fetch(points))
    with _cache_lock:
        _cache[key] = (time.time(), payload)
    return payload
