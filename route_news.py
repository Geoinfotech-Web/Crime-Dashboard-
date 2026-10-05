"""Route news for the Travel Safety advisor.

Given the states and towns a road passes through, gather what regional and
national outlets have reported there recently, keep the reports a traveller
would care about, fold several outlets' coverage of one event into a single
event, and turn the result into a 0-100 "live pressure" figure.

Sources come from regional_sources.json. Everything fetched is cached, so
assessing a route twice in ten minutes costs one round of requests, and a
source that fails falls back to its last good copy.
"""
import html
import json
import math
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

SOURCES_FILE = "regional_sources.json"
FETCH_TIMEOUT = 8
MAX_WORKERS = 10
MAX_STATES = 14
MAX_PLACES = 16
# Pressure at which the live index reaches about 63 of 100.
PRESSURE_SCALE = 12
GOOGLE_NEWS = "https://news.google.com/rss/search?q={query}&hl=en-NG&gl=NG&ceid=NG:en"
USER_AGENT = "Mozilla/5.0 (compatible; GeoSentryNG/1.0; route news monitor)"

# What a traveller needs to know about, most serious first: the first
# category whose pattern matches a headline is the one it gets.
CATEGORIES = [
    ("kidnapping",     "Kidnapping",      1.00, r"kidnap|abduct|hostage|ransom|whisk"),
    ("explosion",      "Explosion",       1.00, r"\bbomb|\bied\b|explosi|\bblast"),
    ("armed_attack",   "Armed attack",    1.00, r"bandit|gunm[ae]n|terrorist|boko haram|iswap|ambush|insurgent|herdsmen|militia|attack|\braid|invade"),
    ("killing",        "Killing",         0.90, r"\bkill|shot dead|murder|massacre|behead|slain|lynch|corpse"),
    ("robbery",        "Robbery",         0.70, r"robber|carjack|hijack|snatch|highway thie"),
    ("unrest",         "Unrest",          0.50, r"protest|riot|\bclash|curfew|cultis|\bmob\b|barricad"),
    ("road_crash",     "Road crash",      0.45, r"crash|accident|collision|tanker|\bfrsc\b|somersault|multiple.vehicle"),
    ("road_condition", "Road condition",  0.35, r"flood|washed away|collapse|gridlock|\btraffic\b|blocked|road closure|closed to|diversion|failed portion|pothole|bad road"),
]
CATEGORY_LABEL = {key: label for key, label, _, _ in CATEGORIES}
CATEGORY_WEIGHT = {key: weight for key, _, weight, _ in CATEGORIES}
CATEGORY_PATTERNS = [(key, re.compile(pattern, re.I)) for key, _, _, pattern in CATEGORIES]

# Words that mean something actually happened, as opposed to being discussed.
EVENT_RE = re.compile(
    r"kidnapp?ed|abducted|killed|kills|ambush|attacked|attack on|shot|shoot|explod|crash|collid|"
    r"murder|lynch|robbed|hijack|flood|collapse|blocked|rescue|arrest|nab|burnt|raze|invade|"
    r"gunmen|bandits|protest|clash|accident|stranded", re.I)
# Statements, politics and opinion: a state can be named in these all day
# without anything having happened on its roads.
CONTEXT_RE = re.compile(
    r"\b(commends?|flags? off|pledges?|vows?|urges?|calls? for|promises?|inaugurat\w*|easing|anniversary|"
    r"budget|campaign\w*|election\w*|re-election|2027|guber\w*|senator\w*|opinion|editorial|appoints?|"
    r"swears? in|condoles?|felicitat\w*|congratulat\w*|\bapc\b|\bpdp\b|\badc\b|manifesto|"
    r"rejects?|denies|debunks?|fake news|misinformation|fumes?|accuses?|laments?|decries|slams?|"
    r"condemns?|reacts?|strategy|summit|bill|lawmakers?|jokes?|history|remembers?)\b", re.I)
# A security force getting the upper hand: still a sign of activity, but less
# alarming than the same event without one.
RESPONSE_RE = re.compile(r"rescue|arrest|\bnab|neutrali[sz]|repel|foil|recover|parade|apprehend|bust", re.I)
ROAD_RE = re.compile(
    r"\broad\b|highway|expressway|\bexpress\b|travell?ers?|passengers?|motorists?|commuters?|"
    r"\bbus\b|vehicles?|trucks?|tanker|checkpoint|\bfrsc\b|driver|\bbridge\b|junction", re.I)
TIME_OF_DAY = [
    ("night",     re.compile(r"\bnight|midnight|overnight|late hours|\bdark\b", re.I)),
    ("evening",   re.compile(r"evening|\bdusk\b|sunset", re.I)),
    ("dawn",      re.compile(r"\bdawn\b|early hours|wee hours|daybreak", re.I)),
    ("morning",   re.compile(r"\bmorning", re.I)),
    ("afternoon", re.compile(r"afternoon|broad daylight|\bnoon\b", re.I)),
]

# Names that are also ordinary words, or shared with somewhere else, only
# count when written as a state.
AMBIGUOUS_STATES = {"Niger", "Plateau", "Rivers", "Delta"}
# Enough towns to place a headline that names a town rather than its state.
TOWNS = {
    "Abia": ["Umuahia", "Aba"], "Adamawa": ["Yola", "Mubi", "Numan"],
    "Akwa Ibom": ["Uyo", "Eket", "Ikot Ekpene"], "Anambra": ["Awka", "Onitsha", "Nnewi"],
    "Bauchi": ["Azare"], "Bayelsa": ["Yenagoa"], "Benue": ["Makurdi", "Gboko", "Otukpo"],
    "Borno": ["Maiduguri", "Monguno", "Gwoza", "Damboa", "Benisheikh"],
    "Cross River": ["Calabar", "Ikom", "Ogoja", "Odukpani"], "Delta": ["Asaba", "Warri", "Agbor", "Ughelli"],
    "Ebonyi": ["Abakaliki"], "Edo": ["Benin City", "Auchi", "Ekpoma"], "Ekiti": ["Ado-Ekiti", "Ado Ekiti"],
    "Enugu": ["Nsukka"], "FCT (Abuja)": ["Abuja", "FCT", "Kubwa", "Bwari", "Gwagwalada"],
    "Gombe": [], "Imo": ["Owerri", "Okigwe", "Orlu"], "Jigawa": ["Dutse", "Hadejia"],
    "Kaduna": ["Zaria", "Kafanchan", "Birnin Gwari", "Rijana", "Katari", "Kagarko", "Kachia"],
    "Kano": [], "Katsina": ["Funtua", "Kankara", "Daura", "Jibia", "Malumfashi"],
    "Kebbi": ["Birnin Kebbi", "Zuru", "Yauri"], "Kogi": ["Lokoja", "Okene", "Kabba", "Koton-Karfe", "Koton Karfe"],
    "Kwara": ["Ilorin", "Offa"], "Lagos": ["Ikeja", "Ikorodu", "Badagry", "Lekki", "Epe"],
    "Nasarawa": ["Lafia", "Keffi", "Akwanga"], "Niger": ["Minna", "Suleja", "Bida", "Kontagora", "Shiroro", "Lambata"],
    "Ogun": ["Abeokuta", "Sagamu", "Ijebu-Ode", "Ijebu Ode", "Ogere", "Sango-Ota"],
    "Ondo": ["Akure", "Owo", "Ore"], "Osun": ["Osogbo", "Ile-Ife", "Ilesa"],
    "Oyo": ["Ibadan", "Ogbomoso", "Iseyin"], "Plateau": ["Jos", "Riyom", "Barkin Ladi", "Bokkos", "Mangu"],
    "Rivers": ["Port Harcourt", "Ahoada", "Bonny", "Eleme"], "Sokoto": ["Tambuwal", "Isa", "Sabon Birni"],
    "Taraba": ["Jalingo", "Wukari", "Takum"], "Yobe": ["Damaturu", "Potiskum", "Geidam", "Buni Yadi"],
    "Zamfara": ["Gusau", "Tsafe", "Talata Mafara", "Anka", "Maru", "Shinkafi"],
}
# Town names that are also everyday words or people's names ("okada riders",
# "Isa Pantami", "iron ore"). They only count when the sentence treats them
# as a place: "in Ore", "Benin-Ore road", "Okada junction".
AMBIGUOUS_PLACES = {"Ore", "Okada", "Aba", "Isa", "Toro", "Bori", "Jere", "Owo", "Itu", "Auno",
                    "Mowe", "Ifon", "Kura", "Maru", "Anka", "Offa", "Epe", "Bida"}
PLACE_BEFORE = r"(?:\b(?:in|at|near|around|along|from|to|of|outside)\s+|-)"
PLACE_AFTER = r"(?:-|,|\s+(?i:road|town|junction|axis|community|area|expressway|highway|bridge|lga|council|forest))"

STOPWORDS = set(
    "the a an and or of in on at to for from by with as is are was were be been after before over into "
    "amid says say said new news nigeria nigerian state govt government police army troops officials "
    "his her their its this that how why what who more than not but has have had will".split())

_cache = {}          # url -> (fetched_at, items)
_cache_lock = threading.Lock()
_results = {}        # route key -> (built_at, payload)


def _load_sources(root: Path):
    with (root / SOURCES_FILE).open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _word_pattern(term: str):
    return re.compile(r"(?<![A-Za-z])" + re.escape(term).replace(r"\ ", r"[\s-]+") + r"(?![A-Za-z])", re.I)


def _place_pattern(name: str):
    if name not in AMBIGUOUS_PLACES:
        return _word_pattern(name)
    core = re.escape(name)
    return re.compile(f"{PLACE_BEFORE}{core}(?![A-Za-z])|(?<![A-Za-z]){core}{PLACE_AFTER}")


def _state_patterns(state: str):
    """Patterns that place a headline in a state: its name, then its towns."""
    name = "Abuja" if state == "FCT (Abuja)" else state
    if state in AMBIGUOUS_STATES:
        # Capitalised and standing alone: "in Rivers", "Niger:" - but not the
        # Niger Delta, Niger Republic, or a plateau.
        patterns = [re.compile(r"(?<![A-Za-z])(?<!Niger )" + name + r"(?![A-Za-z])(?! (?:Delta|Republic|River))")]
    else:
        patterns = [_word_pattern(name)]
    patterns.extend(_place_pattern(town) for town in TOWNS.get(state, []))
    return patterns


def _strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text or ""))).strip()


def _parse_date(value: str):
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value.strip())
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _domain(url: str) -> str:
    host = urlparse(url or "").netloc.lower()
    return host[4:] if host.startswith("www.") else host


def _parse_feed(xml_bytes: bytes):
    """RSS or Atom into plain dicts. Google News carries the real publisher in
    <source>, which is how an aggregated item is credited to the paper."""
    text = xml_bytes.decode("utf-8", errors="replace").lstrip("﻿ \r\n\t")
    root = ET.fromstring(text)
    atom = "{http://www.w3.org/2005/Atom}"
    if root.tag.lower().endswith("rss"):
        channel = root.find("channel")
        nodes = channel.findall("item") if channel is not None else []
    else:
        nodes = root.findall(f"{atom}entry")

    items = []
    for node in nodes:
        title = _strip_html(node.findtext("title") or node.findtext(f"{atom}title") or "")
        link = (node.findtext("link") or "").strip()
        if not link:
            link_node = node.find(f"{atom}link")
            link = link_node.attrib.get("href", "") if link_node is not None else ""
        source = node.find("source")
        items.append({
            "title": title,
            "url": link,
            "summary": _strip_html(node.findtext("description") or node.findtext(f"{atom}summary") or "")[:400],
            "published": _parse_date(node.findtext("pubDate") or node.findtext(f"{atom}updated")
                                     or node.findtext(f"{atom}published") or ""),
            "publisher": (source.text or "").strip() if source is not None else "",
            "publisherDomain": _domain(source.attrib.get("url", "")) if source is not None else "",
        })
    return items


def _fetch(url: str, ttl: float):
    """Returns (items, error, stale). A failure serves the last good copy."""
    now = time.time()
    with _cache_lock:
        cached = _cache.get(url)
    if cached and now - cached[0] < ttl:
        return cached[1], None, False
    try:
        request = Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        })
        with urlopen(request, timeout=FETCH_TIMEOUT) as response:
            items = _parse_feed(response.read())
        with _cache_lock:
            _cache[url] = (now, items)
        return items, None, False
    except Exception as exc:  # network, HTTP status, malformed XML
        message = f"{type(exc).__name__}: {str(exc)[:80]}"
        if cached:
            return cached[1], message, True
        return [], message, False


def _google_url(query: str) -> str:
    return GOOGLE_NEWS.format(query=quote(query))


def _plan(sources, states, places, label, days):
    """Which feeds to read for this route. Each job: (source meta, url)."""
    wanted = set(states)
    incident_terms = "(kidnap OR abducted OR bandits OR gunmen OR attack OR killed OR ambush OR robbers OR crash OR flood)"
    jobs = []

    for outlet in sources.get("outlets", []):
        regional = outlet.get("scope") == "regional"
        if regional and not wanted.intersection(outlet.get("states", [])):
            continue
        meta = {"name": outlet["name"], "scope": outlet.get("scope", "national"),
                "states": outlet.get("states", []), "via": outlet.get("via"),
                "domain": outlet.get("domain", "")}
        if outlet.get("via") == "feed" and outlet.get("url"):
            jobs.append((meta, outlet["url"]))
        elif outlet.get("via") == "google" and outlet.get("domain"):
            jobs.append((meta, _google_url(f"site:{outlet['domain']} {incident_terms} when:{days}d")))

    for state in states:
        name = "Abuja" if state == "FCT (Abuja)" else state
        phrase = f'"{name} State"' if state in AMBIGUOUS_STATES else f'"{name}"'
        jobs.append(({"name": f"Google News · {name}", "scope": "search", "states": [state],
                      "via": "search", "domain": "", "stateHint": state},
                     _google_url(f"{phrase} {incident_terms} when:{days}d")))

    # A search can only hold so many names, so a long route asks twice.
    for start in range(0, len(places), 8):
        quoted = " OR ".join(f'"{place}"' for place in places[start:start + 8])
        jobs.append(({"name": "Google News · towns on route" + (f" ({start // 8 + 1})" if len(places) > 8 else ""),
                      "scope": "search", "states": [], "via": "search", "domain": ""},
                     _google_url(f"({quoted}) {incident_terms} when:{days}d")))
    if label:
        ends = [part.strip() for part in re.split(r"→|->|-|–", label) if part.strip()]
        if len(ends) == 2:
            a, b = (re.sub(r"\s*\(.*?\)", "", end) for end in ends)
            jobs.append(({"name": f"Google News · {a}–{b} road", "scope": "search", "states": [],
                          "via": "search", "domain": "", "roadQuery": True},
                         _google_url(f'("{a}-{b}" OR "{b}-{a}") (road OR highway OR expressway) when:{days * 2}d')))
    return jobs


def _classify(text: str):
    for key, pattern in CATEGORY_PATTERNS:
        if pattern.search(text):
            return key
    return None


def _tokens(title: str):
    """Significant words, cut to five letters so 'kidnapped', 'kidnappers' and
    'kidnap' count as the same word when comparing two headlines."""
    return {word[:5] for word in re.findall(r"[a-z]{3,}", title.lower()) if word not in STOPWORDS}


def _same_event(a, b):
    shared = len(a["_tokens"] & b["_tokens"])
    smaller = min(len(a["_tokens"]), len(b["_tokens"]))
    if shared < 3 or not smaller or shared / smaller < 0.5:
        return False
    if not set(a["states"]) & set(b["states"]):
        return False
    if a["_published"] and b["_published"]:
        return abs((a["_published"] - b["_published"]).total_seconds()) <= 72 * 3600
    return True


def _recency(age_hours: float) -> float:
    if age_hours <= 24:
        return 1.0
    if age_hours <= 72:
        return 0.7
    if age_hours <= 168:
        return 0.4
    return 0.2


def build_route_news(root: Path, states, places=None, label="", days=None, hubs=None):
    sources = _load_sources(root)
    known_states = {state for zone in sources["zones"].values() for state in zone}
    states = [state for state in dict.fromkeys(states) if state in known_states][:MAX_STATES]
    places = [place for place in dict.fromkeys(places or []) if place][:MAX_PLACES]
    days = max(1, min(int(days or sources.get("windowDays", 7)), 14))
    ttl = float(sources.get("cacheMinutes", 10)) * 60
    if not states:
        raise ValueError("No recognised states on this route")

    # Towns where the route changes road. A city is in the news every day, so
    # a report only counts as "on the road" there when it is about the road.
    hubs = set(hubs or [])
    route_key = json.dumps([states, places, label, days, sorted(hubs)])
    cached = _results.get(route_key)
    if cached and time.time() - cached[0] < ttl:
        return cached[1]

    zone_of = {state: zone for zone, members in sources["zones"].items() for state in members}
    regional_domains = {outlet["domain"]: outlet for outlet in sources["outlets"]
                        if outlet.get("scope") == "regional" and outlet.get("domain")}
    state_patterns = {state: _state_patterns(state) for state in states}
    # Every other state, to recognise a headline that is plainly about
    # somewhere this road does not go.
    elsewhere = [pattern for state in known_states - set(states) for pattern in _state_patterns(state)]
    place_patterns = {place: _place_pattern(place) for place in places}
    known_domains = {outlet["domain"] for outlet in sources["outlets"] if outlet.get("domain")}
    nigeria = re.compile(r"\bNigeria", re.I)

    jobs = _plan(sources, states, places, label, days)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        fetched = list(executor.map(lambda job: _fetch(job[1], ttl), jobs))

    now = datetime.now(timezone.utc)
    cutoff_hours = days * 24
    seen_urls = set()
    reports = []
    source_rows = []

    for (meta, _url), (items, error, stale) in zip(jobs, fetched):
        matched = 0
        for item in items:
            title = item["title"]
            if not title or not item["url"] or item["url"] in seen_urls:
                continue
            publisher = item["publisher"] or meta["name"]
            if item["publisher"] and title.endswith(f" - {item['publisher']}"):
                title = title[: -len(item["publisher"]) - 3].strip()
            # A direct feed's summary is the article's own opening; Google's is
            # only a link back to the headline, so there is nothing to add.
            text = title if meta["via"] in ("search", "google") else f"{title}. {item['summary']}"

            published = item["published"]
            age_hours = (now - published).total_seconds() / 3600 if published else None
            if age_hours is not None and (age_hours > cutoff_hours or age_hours < -6):
                continue

            # Where it happened comes from the headline. Feed summaries often
            # trail off into other stories, so they only get a say when the
            # headline names nowhere at all.
            def locate(sample):
                return ([place for place, pattern in place_patterns.items() if pattern.search(sample)],
                        [state for state, patterns in state_patterns.items()
                         if any(pattern.search(sample) for pattern in patterns)])

            hit_places, hit_states = locate(title)
            road = bool(ROAD_RE.search(title))
            if not road:
                hit_places = [place for place in hit_places if place not in hubs]
            located_by = "headline"
            if not hit_states and not hit_places:
                if any(pattern.search(title) for pattern in elsewhere):
                    continue
                hit_places, hit_states = locate(text[:len(title) + 220])
                hit_places = [place for place in hit_places if place not in hubs]
                if not hit_states and not hit_places:
                    # A search aimed at one state returns articles about that
                    # state even when the headline does not name it. Trust it less.
                    if not meta.get("stateHint"):
                        continue
                    hit_states, located_by = [meta["stateHint"]], "search"

            # A town name on its own could be anywhere in the world. Without a
            # state in the headline, only take it from a paper we know.
            domain = item["publisherDomain"] or meta["domain"] or _domain(item["url"])
            if (hit_places and not hit_states and meta["via"] == "search"
                    and domain not in known_domains and not nigeria.search(title)):
                continue

            category = _classify(title) or _classify(text)
            road = road or bool(ROAD_RE.search(text))
            # "Crash" and "accident" are only road news when a road is involved.
            if category == "road_crash" and not road:
                category = None
            if not category:
                continue
            is_event = bool(EVENT_RE.search(title)) and not (CONTEXT_RE.search(title) and not road)

            outlet = regional_domains.get(domain)
            seen_urls.add(item["url"])
            matched += 1
            reports.append({
                "title": title, "url": item["url"], "source": outlet["name"] if outlet else publisher,
                "sourceDomain": domain, "regional": bool(outlet),
                "seenDate": published.isoformat().replace("+00:00", "Z") if published else None,
                "ageHours": round(age_hours, 1) if age_hours is not None else None,
                "category": category, "categoryLabel": CATEGORY_LABEL[category],
                "states": hit_states, "places": hit_places, "onRoute": bool(hit_places),
                "road": road, "response": bool(RESPONSE_RE.search(title)), "isEvent": is_event,
                "locatedBy": located_by,
                "timeOfDay": next((key for key, pattern in TIME_OF_DAY if pattern.search(text)), None),
                "_tokens": _tokens(title), "_published": published,
            })
        source_rows.append({
            "name": meta["name"], "scope": meta["scope"], "via": meta["via"],
            "states": meta.get("states", []), "ok": error is None or stale, "stale": stale,
            "items": len(items), "matched": matched, "error": error,
        })

    # One event, many headlines: fold reports that share most of their words,
    # a state, and a three-day window.
    events = []
    reports.sort(key=lambda r: r["_published"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    for report in reports:
        if not report["isEvent"]:
            continue
        home = next((event for event in events
                     if any(_same_event(report, member) for member in event["reports"])), None)
        if home:
            home["reports"].append(report)
        else:
            events.append({"_head": report, "reports": [report]})

    def public(report):
        return {key: value for key, value in report.items() if not key.startswith("_")}

    event_rows = []
    pressure = 0.0
    by_state = {state: 0.0 for state in states}
    for index, event in enumerate(events):
        members = event["reports"]
        # Lead with a regional paper's version where there is one: it is the
        # outlet closest to the road.
        head = next((r for r in members if r["regional"]), event["_head"])
        publishers = list(dict.fromkeys(r["source"] for r in members))
        row = public(head)
        row["states"] = sorted({s for r in members for s in r["states"]})
        row["places"] = sorted({p for r in members for p in r["places"]})
        row["onRoute"] = bool(row["places"])
        row["road"] = any(r["road"] for r in members)
        row["timeOfDay"] = next((r["timeOfDay"] for r in members if r["timeOfDay"]), None)
        row["locatedBy"] = "headline" if any(r["locatedBy"] == "headline" for r in members) else "search"
        newest = min((r["ageHours"] for r in members if r["ageHours"] is not None), default=cutoff_hours)

        weight = CATEGORY_WEIGHT[row["category"]] * _recency(newest)
        # How close to the traveller: a named town on the road, then anything
        # on a road in a state the route crosses, then elsewhere in that state.
        weight *= 1.5 if row["onRoute"] else 1.0 if row["road"] else 0.55
        weight *= 0.7 if row["response"] else 1.0
        weight *= 1.0 if row["locatedBy"] == "headline" else 0.6
        weight *= 1 + 0.15 * min(len(publishers) - 1, 3)
        row.update(id=f"e{index}", weight=round(weight, 2), sourceCount=len(publishers),
                   regionalSources=sorted({r["source"] for r in members if r["regional"]}),
                   coverage=[{"source": r["source"], "url": r["url"], "regional": r["regional"]} for r in members[:6]])
        pressure += weight
        for state in row["states"]:
            by_state[state] = by_state.get(state, 0.0) + weight
        event_rows.append(row)

    event_rows.sort(key=lambda row: (not row["onRoute"], -row["weight"]))
    context_rows = [public(r) for r in reports if not r["isEvent"]][:8]

    def tally(key):
        counts = {}
        for row in event_rows:
            value = row.get(key)
            if value:
                counts[value] = counts.get(value, 0) + 1
        return counts

    offline = [{"name": outlet["name"], "states": outlet.get("states", [])}
               for outlet in sources["outlets"]
               if outlet.get("via") == "offline" and set(outlet.get("states", [])) & set(states)]
    answered = [row for row in source_rows if row["ok"]]

    # A route through eight states collects more headlines than one through
    # two without being that much worse per kilometre, so the bar rises with
    # the number of states - but slower than in proportion.
    scale = PRESSURE_SCALE * max(1.0, len(states) / 3) ** 0.5

    payload = {
        "route": {"states": states, "places": places, "label": label,
                  "zones": sorted({zone_of[state] for state in states})},
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "windowDays": days,
        "cacheMinutes": ttl / 60,
        # Saturating, so the tenth report of a bad week moves the needle less
        # than the first.
        "liveIndex": round(100 * (1 - math.exp(-pressure / scale))),
        "pressure": round(pressure, 2),
        "counts": {
            "reports": len(reports), "events": len(event_rows),
            "onRoute": sum(1 for row in event_rows if row["onRoute"]),
            "roadRelated": sum(1 for row in event_rows if row["road"]),
            "last24h": sum(1 for row in event_rows if (row["ageHours"] or 999) <= 24),
            "regionalEvents": sum(1 for row in event_rows if row["regionalSources"]),
            "byCategory": tally("category"), "timeOfDay": tally("timeOfDay"),
            "byState": {state: round(value, 2) for state, value in by_state.items()},
        },
        "events": event_rows[:40],
        "context": context_rows,
        "sources": {
            "checked": len(source_rows), "answered": len(answered),
            "regionalAnswered": sum(1 for row in answered if row["scope"] == "regional"),
            "failed": [row for row in source_rows if not row["ok"]],
            "list": source_rows, "offline": offline,
        },
    }
    # Nothing answered at all: do not cache a blank, try again next time.
    if answered:
        _results[route_key] = (time.time(), payload)
    return payload
