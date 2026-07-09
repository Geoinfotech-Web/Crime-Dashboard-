import argparse
import shutil
import csv
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import re
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}
REPORTS_DIR_NAME = "reports"
MAX_REPORT_BYTES = 80 * 1024 * 1024


def sanitize_filename(name: str) -> str:
    name = os.path.basename(name or "").strip()
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
    return name[-100:] if name else ""


def parse_multipart_form(content_type: str, body: bytes):
    boundary = None
    for piece in content_type.split(";"):
        piece = piece.strip()
        if piece.startswith("boundary="):
            boundary = piece[len("boundary="):].strip().strip('"')
    if not boundary:
        raise ValueError("Request is missing a multipart boundary")

    boundary_bytes = ("--" + boundary).encode("utf-8")
    fields = {}
    files = []

    for segment in body.split(boundary_bytes):
        segment = segment.strip(b"\r\n")
        if not segment or segment == b"--":
            continue
        header_blob, separator, content = segment.partition(b"\r\n\r\n")
        if not separator:
            continue
        if content.endswith(b"\r\n"):
            content = content[:-2]

        headers_text = header_blob.decode("utf-8", errors="replace")
        name_match = re.search(r'name="([^"]*)"', headers_text)
        filename_match = re.search(r'filename="([^"]*)"', headers_text)
        type_match = re.search(r"Content-Type:\s*([^\r\n]+)", headers_text, re.IGNORECASE)
        if not name_match:
            continue

        field_name = name_match.group(1)
        if filename_match and filename_match.group(1):
            files.append(
                {
                    "field": field_name,
                    "filename": filename_match.group(1),
                    "content_type": type_match.group(1).strip() if type_match else "application/octet-stream",
                    "data": content,
                }
            )
        else:
            fields.setdefault(field_name, []).append(content.decode("utf-8", errors="replace"))

    return fields, files


def load_json(path: Path):
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def parse_feed_date(value: str):
    if not value:
        return None

    text = value.strip()
    try:
        dt = parsedate_to_datetime(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (TypeError, ValueError):
        pass

    normalized = text.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def read_text(node, names):
    for name in names:
        element = node.find(name, ATOM_NS) if ":" in name else node.find(name)
        if element is not None and element.text:
            return element.text.strip()
    return ""


def read_link(node):
    for link in node.findall("link", ATOM_NS):
        href = link.attrib.get("href")
        if href:
            return href.strip()

    text = read_text(node, ["link", "guid", "id"])
    return text.strip()


def feed_items(xml_text: str):
    root = ET.fromstring(xml_text)
    tag = root.tag.lower()

    if tag.endswith("rss"):
      channel = root.find("channel")
      return list(channel.findall("item")) if channel is not None else []

    if tag.endswith("feed"):
        return list(root.findall("atom:entry", ATOM_NS)) or list(root.findall("entry"))

    return []


def fetch_feed(url: str):
    request = Request(
        url,
        headers={
            "User-Agent": "NigeriaGISDashboard/1.0 RSS monitor",
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
    )
    with urlopen(request, timeout=6) as response:
        return response.read()


def fetch_json(url: str):
    request = Request(
        url,
        headers={
            "User-Agent": "NigeriaGISDashboard/1.0 live monitor",
            "Accept": "application/json, */*;q=0.8",
        },
    )
    with urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def build_gdelt_query(config):
    keywords = " OR ".join(f'"{term}"' for term in config.get("keywords", []))
    source_country = f' sourcecountry:{config["sourceCountry"]}' if config.get("sourceCountry") else ""
    domain_query = ""
    if config.get("restrictToDomains") and config.get("domains"):
        domain_query = " (" + " OR ".join(
            f"domainis:{domain}" for domain in config.get("domains", [])
        ) + ")"
    return f"({keywords}){source_country}{domain_query}"


def build_gdelt_url(config):
    params = {
        "query": build_gdelt_query(config),
        "mode": "artlist",
        "format": "json",
        "sort": config.get("sort", "datedesc"),
        "timespan": config.get("timespan", "24h"),
        "maxrecords": str(config.get("maxRecords", 20)),
    }
    return f'{config["endpoint"]}?{urlencode(params)}'


def extract_feed_items(feed, keywords, location_keywords, pattern_cache, cutoff):
    xml_bytes = fetch_feed(feed["url"])
    nodes = feed_items(xml_bytes.decode("utf-8", errors="replace"))
    items = []

    for node in nodes:
        title = read_text(node, ["title"])
        description = read_text(node, ["description", "summary", "atom:summary"])
        haystack = f"{title} {description}"

        matched_keywords = [
            keyword for keyword in keywords if pattern_cache[keyword].search(haystack)
        ]
        if not matched_keywords:
            continue

        matched_locations = [
            keyword
            for keyword in location_keywords
            if pattern_cache[keyword].search(haystack)
        ]
        if location_keywords and not matched_locations:
            continue

        link = read_link(node)
        if not link:
            continue

        published = read_text(
            node,
            ["pubDate", "published", "updated", "atom:published", "atom:updated"],
        )
        published_dt = parse_feed_date(published)
        if published_dt and published_dt.timestamp() < cutoff:
            continue

        items.append(
            {
                "title": title,
                "url": link,
                "domain": feed.get("name", "RSS feed"),
                "seenDate": published_dt.isoformat().replace("+00:00", "Z")
                if published_dt
                else published,
                "source": feed.get("name", "RSS feed"),
                "matchedKeywords": matched_keywords,
                "matchedLocations": matched_locations,
            }
        )

    return items


def build_rss_news(root: Path):
    config = load_json(root / "rss_config.json")
    keywords = [str(value) for value in config.get("keywords", [])]
    location_keywords = [str(value) for value in config.get("locationKeywords", [])]
    max_items = int(config.get("maxItems", 30))
    refresh_minutes = int(config.get("refreshMinutes", 2))
    lookback_hours = max(1, int(config.get("lookbackHours", 24)))
    cutoff = datetime.now(timezone.utc).timestamp() - (lookback_hours * 60 * 60)
    pattern_cache = {
        value: re.compile(re.escape(value), re.IGNORECASE) for value in keywords + location_keywords
    }

    items = []
    errors = []

    feeds = config.get("feeds", [])
    with ThreadPoolExecutor(max_workers=min(6, max(1, len(feeds)))) as executor:
        futures = {
            executor.submit(
                extract_feed_items, feed, keywords, location_keywords, pattern_cache, cutoff
            ): feed
            for feed in feeds
        }
        for future in as_completed(futures):
            feed = futures[future]
            try:
                items.extend(future.result())
            except (HTTPError, URLError, TimeoutError, ET.ParseError, OSError) as exc:
                errors.append(f'{feed.get("name", "feed")}: {exc}')
            except Exception as exc:
                errors.append(f'{feed.get("name", "feed")}: {exc}')

    deduped = {}
    for item in items:
        deduped[item["url"]] = item

    sorted_items = sorted(
        deduped.values(),
        key=lambda item: parse_feed_date(item.get("seenDate") or "") or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )[:max_items]

    return {
        "provider": "rss",
        "refreshedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "refreshMinutes": refresh_minutes,
        "lookbackHours": lookback_hours,
        "articles": sorted_items,
        "warnings": errors,
    }


def build_live_news(root: Path):
    rss_payload = build_rss_news(root)
    if rss_payload.get("articles"):
        rss_payload["sourceMode"] = "rss"
        return rss_payload

    config = load_json(root / "news_config.json")
    lookback_hours = max(1, int(str(config.get("timespan", "24h")).rstrip("h")))
    try:
        payload = fetch_json(build_gdelt_url(config))
        payload["provider"] = "gdelt"
        payload["sourceMode"] = "gdelt"
        payload["refreshMinutes"] = int(config.get("refreshMinutes", 15))
        payload["lookbackHours"] = lookback_hours
        payload["refreshedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        payload["warnings"] = rss_payload.get("warnings", [])
        return payload
    except Exception as exc:
        cached_payload = build_cached_live_news(root)
        cached_payload["warnings"] = rss_payload.get("warnings", []) + [
            f"GDELT fallback failed: {exc}"
        ]
        return cached_payload


def build_cached_live_news(root: Path):
    csv_path = root / "live_rss_news_export.csv"
    analysis_path = root / "live_rss_analysis.json"

    articles = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            articles.append(
                {
                    "title": row.get("Title", ""),
                    "url": row.get("Url", ""),
                    "domain": row.get("Source", "") or "cached source",
                    "seenDate": row.get("PublishedUtc", ""),
                    "provider": "cached",
                    "matchedKeywords": [value.strip() for value in row.get("MatchedKeywords", "").split(";") if value.strip()],
                    "matchedLocations": [value.strip() for value in row.get("MatchedLocations", "").split(";") if value.strip()],
                }
            )

    articles = sorted(
        [article for article in articles if article["title"] and article["url"]],
        key=lambda article: parse_feed_date(article.get("seenDate") or "") or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )[:20]

    refreshed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if analysis_path.exists():
        analysis = load_json(analysis_path)
        refreshed_at = analysis.get("refreshedAt", refreshed_at)

    return {
        "provider": "cached",
        "sourceMode": "cached",
        "isCachedSnapshot": True,
        "refreshMinutes": 15,
        "lookbackHours": 24,
        "refreshedAt": refreshed_at,
        "articles": articles,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/live-news":
            self.handle_live_news()
            return
        if parsed.path == "/api/rss-news":
            self.handle_rss_news()
            return
        if parsed.path == "/api/reports":
            self.handle_get_reports()
            return
        parts = parsed.path.split("/")
        if (len(parts) == 6 and parts[1] == "api" and parts[2] == "reports"
                and parts[4] == "media"):
            self.handle_report_media(parts[3], parts[5])
            return
        if parsed.path == f"/{REPORTS_DIR_NAME}" or parsed.path.startswith(f"/{REPORTS_DIR_NAME}/"):
            self.send_response(403)
            self.end_headers()
            return

        if parsed.path in ("", "/"):
            self.path = "/nigeria_gis_dashboard.html"
        else:
            query = parse_qs(parsed.query)
            self.path = parsed.path
            if query:
                # Strip cache-busting query strings before static file lookup.
                self.path = parsed.path

        super().do_GET()

    def handle_rss_news(self):
        try:
            payload = build_rss_news(Path(self.directory))
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:  # pragma: no cover - best-effort endpoint
            message = json.dumps({"error": str(exc)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)

    def handle_live_news(self):
        try:
            payload = build_live_news(Path(self.directory))
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:  # pragma: no cover - best-effort endpoint
            message = json.dumps({"error": str(exc)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)

    def handle_get_reports(self):
        reports = []
        reports_dir = Path(self.directory) / REPORTS_DIR_NAME
        if reports_dir.exists():
            for meta_file in sorted(reports_dir.glob("*/meta.json"), reverse=True):
                try:
                    reports.append(json.loads(meta_file.read_text(encoding="utf-8")))
                except Exception:
                    pass
        body = json.dumps({"reports": reports, "count": len(reports)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_report_media(self, report_id_raw, filename_raw):
        report_id = sanitize_filename(report_id_raw)
        filename  = sanitize_filename(filename_raw)
        if not report_id or not filename:
            self.send_response(400)
            self.end_headers()
            return
        reports_dir = (Path(self.directory) / REPORTS_DIR_NAME).resolve()
        media_path  = (reports_dir / report_id / filename).resolve()
        try:
            media_path.relative_to(reports_dir)
        except ValueError:
            self.send_response(403)
            self.end_headers()
            return
        if not media_path.is_file():
            self.send_response(404)
            self.end_headers()
            return
        MEDIA_TYPES = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".gif": "image/gif",  ".webp": "image/webp",
            ".mp4": "video/mp4",  ".webm": "video/webm", ".mov": "video/quicktime",
        }
        ct   = MEDIA_TYPES.get(media_path.suffix.lower(), "application/octet-stream")
        data = media_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        parsed = urlparse(self.path)
        parts  = parsed.path.split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "reports":
            self.handle_update_report(parts[3])
            return
        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        parts  = parsed.path.split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "reports":
            self.handle_delete_report(parts[3])
            return
        self.send_response(404)
        self.end_headers()

    def handle_update_report(self, report_id_raw):
        report_id = sanitize_filename(report_id_raw)
        if not report_id:
            self.send_response(400); self.end_headers(); return
        meta_path = Path(self.directory) / REPORTS_DIR_NAME / report_id / "meta.json"
        if not meta_path.is_file():
            self.send_response(404); self.end_headers(); return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            for field in ("message", "category", "severity"):
                if field in payload:
                    meta[field] = str(payload[field])[:2000]
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
            body = json.dumps({"ok": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            msg = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def handle_delete_report(self, report_id_raw):
        report_id = sanitize_filename(report_id_raw)
        if not report_id:
            self.send_response(400); self.end_headers(); return
        report_dir = Path(self.directory) / REPORTS_DIR_NAME / report_id
        if not report_dir.is_dir():
            self.send_response(404); self.end_headers(); return
        try:
            shutil.rmtree(report_dir)
            body = json.dumps({"ok": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            msg = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/submit-report":
            self.handle_submit_report()
            return
        self.send_response(404)
        self.end_headers()

    def handle_submit_report(self):
        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                raise ValueError("Expected multipart/form-data")

            content_length = int(self.headers.get("Content-Length", 0))
            if content_length <= 0 or content_length > MAX_REPORT_BYTES:
                raise ValueError("Submission is empty or exceeds the size limit")

            body = self.rfile.read(content_length)
            fields, files = parse_multipart_form(content_type, body)

            def first(name, default=""):
                values = fields.get(name)
                return values[0] if values else default

            message = first("message").strip()
            if not message:
                raise ValueError("A description of the incident is required")

            report_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
            report_dir = Path(self.directory) / REPORTS_DIR_NAME / report_id
            report_dir.mkdir(parents=True, exist_ok=True)

            saved_files = []
            for index, file_entry in enumerate(files):
                safe_name = sanitize_filename(file_entry["filename"]) or f"media-{index}"
                dest = report_dir / safe_name
                dest.write_bytes(file_entry["data"])
                saved_files.append(
                    {
                        "filename": safe_name,
                        "contentType": file_entry["content_type"],
                        "size": len(file_entry["data"]),
                    }
                )

            lat = first("lat")
            lon = first("lon")
            accuracy = first("accuracy")
            meta = {
                "id": report_id,
                "receivedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "message": message,
                "category": first("category", "Other"),
                "severity": first("severity", "Unknown"),
                "location": {
                    "shared": first("locationShared") == "true",
                    "lat": float(lat) if lat else None,
                    "lon": float(lon) if lon else None,
                    "accuracy": float(accuracy) if accuracy else None,
                },
                "files": saved_files,
            }
            (report_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

            body_out = json.dumps(
                {"ok": True, "reportId": report_id, "filesSaved": len(saved_files)}
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body_out)))
            self.end_headers()
            self.wfile.write(body_out)
        except Exception as exc:
            message_out = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(message_out)))
            self.end_headers()
            self.wfile.write(message_out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="Host to bind to (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8085)))
    parser.add_argument("--root", default=os.path.dirname(os.path.abspath(__file__)))
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    handler = lambda *handler_args, **handler_kwargs: DashboardHandler(
        *handler_args, directory=root, **handler_kwargs
    )
    server = ThreadingHTTPServer((args.host, args.port), handler)
    bind_addr = args.host
    display_host = bind_addr if bind_addr != "0.0.0.0" else "0.0.0.0 (all interfaces)"
    print(f"Serving dashboard at http://{display_host}:{args.port}/nigeria_gis_dashboard.html")
    server.serve_forever()


if __name__ == "__main__":
    main()
