"""Read-only, loopback RSS bridge for four public conference calendars.

No browser login, AI calls or reader database access. Run `refresh` to preflight,
then `serve` for cached RSS. State belongs outside the source checkout.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import format_datetime
import hashlib
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
from pathlib import Path
import re
import threading
import time
from urllib.parse import urlencode, urljoin, urlsplit
import xml.etree.ElementTree as ET

from bs4 import BeautifulSoup
import requests

UTC = timezone.utc
SOURCES = {
    "sciencenet": {
        "title": "科学网·会议预告（含商业征稿）",
        "url": "https://meeting.sciencenet.cn/",
        "description": "科学网会议列表的本地 RSS 转换，含商业征稿；收录不代表质量背书，请核对主办方官网。",
    },
    "chemsoc": {
        "title": "中国化学会·会议日历",
        "url": "https://www.chemsoc.org.cn/meeting/home/calendar.html",
        "description": "中国化学会官网会议日历。会议时间不等于通知发布时间。",
    },
    "cssn": {
        "title": "中国社会科学网·会议动态（含往届）",
        "url": "https://www.cssn.cn/skwxsdt/hyrl/",
        "description": "中国社会科学网会议日历，含会后报道与往届资料；不是纯粹的未来会议预告。",
    },
    "ccf": {
        "title": "CCF 秀湖·会议日历（含往届）",
        "url": "https://bls.ccf.org.cn/calendar/",
        "description": "CCF 秀湖官网会议日历，保留近期与往届日程；并非 CCF 全部会议。",
    },
}
MAX_BYTES = 8 * 1024 * 1024


def text(value):
    # Only XML 1.0 characters; keep Unicode source titles and scientific symbols.
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", "", str(value or "")).strip()


def safe_url(value, base):
    if not text(value):
        return ""
    value = urljoin(base, text(value))
    parts = urlsplit(value)
    return value if parts.scheme in ("http", "https") and parts.hostname and not parts.username else ""


def event(title, link, base, **details):
    link = safe_url(link, base)
    if not text(title) or not link:
        return None
    return {"title": text(title), "url": link, **{k: text(v) for k, v in details.items() if v}}


def dedupe(items, limit=60):
    result = {}
    for item in items:
        if not item:
            continue
        previous = result.get(item["url"])
        if previous is None or ("..." in previous["title"] and "..." not in item["title"]):
            result[item["url"]] = item
    return list(result.values())[:limit]


def parse_sciencenet(page):
    soup = BeautifulSoup(page, "html.parser")
    base = SOURCES["sciencenet"]["url"]
    items = []
    for card in soup.select("dl"):
        anchor = card.select_one("dt a[href]")
        details = [d.get_text(" ", strip=True) for d in card.select("dd")]
        match = re.search(r"\d{4}-\d{2}-\d{2}\s*[~～至-]\s*\d{4}-\d{2}-\d{2}", " ".join(details))
        if not anchor or not match:
            continue
        title = anchor.get_text(" ", strip=True)
        if not re.search("会议|研讨|论坛|大会", title):
            continue
        img = card.select_one("img[src]")
        items.append(event(title, anchor["href"], base, meeting_date=match[0],
                           location=text(" ".join(details).replace(match[0], "")),
                           image=safe_url(img["src"], base) if img else ""))
    return dedupe(items)


def parse_chemsoc(page):
    soup = BeautifulSoup(page, "html.parser")
    base = SOURCES["chemsoc"]["url"]
    items = []
    for anchor in soup.select("a.metting-title[href]"):
        card = anchor.find_parent("li")
        if card is None:
            continue
        when, where = card.select_one(".meeting-time"), card.select_one(".metting-address")
        items.append(event(anchor.get_text(" ", strip=True), anchor["href"], base,
                           meeting_date=when.get_text(" ", strip=True) if when else "",
                           location=where.get_text(" ", strip=True) if where else ""))
    return dedupe(items)


def cssn_endpoint(page):
    # This is a public endpoint embedded in the site's own page, not an account token.
    match = re.search(r'^\s*var getUrl\s*=\s*[\'"]([^\'"]+)', page, re.M)
    if not match:
        raise ValueError("CSSN public calendar endpoint not found")
    url = urljoin(SOURCES["cssn"]["url"], match[1])
    parts = urlsplit(url)
    if parts.netloc != "www.cssn.cn" or parts.path != "/was5/web/search":
        raise ValueError("CSSN endpoint changed; review required")
    return url + "&" + urlencode({"startPage": 1, "pageSize": 40, "order": "start_date"})


def parse_cssn(payload):
    base = SOURCES["cssn"]["url"]
    items = []
    for row in payload.get("datas", []):
        start = row.get("start_date", {}).get("fullDate", "")
        end = row.get("end_date", {}).get("fullDate", "")
        url = safe_url(row.get("pubUrl", ""), base)
        match = re.search(r"/t(\d{8})_", url)
        published = ""
        if match:
            published = datetime.strptime(match[1], "%Y%m%d").replace(tzinfo=UTC).isoformat()
        items.append(event(row.get("name"), url, base, meeting_date=start + (" — " + end if end and end != start else ""),
                           location=row.get("city"), organizer=row.get("sponsor"), category=row.get("subject"),
                           image=safe_url(row["imgUrl"], base) if row.get("imgUrl") else "", published=published))
    return dedupe(items, 40)


def ccf_asset(page):
    soup = BeautifulSoup(page, "html.parser")
    for tag in soup.select('link[rel="modulepreload"][href]'):
        url = safe_url(tag["href"], SOURCES["ccf"]["url"])
        parts = urlsplit(url)
        if parts.netloc == "bls.ccf.org.cn" and re.fullmatch(r"/assets/app-[\w-]+\.js", parts.path):
            return url
    raise ValueError("CCF calendar metadata asset not found")


def parse_ccf(page, script):
    # Read the public route catalogue as text, NEVER execute downloaded JavaScript.
    # Match exact source titles to observed paths, never invent article URLs.
    string = r'"(?:[^"\\]|\\.)*"'
    pattern = r'\["(/posts/calendar/[^"\s]+\.html)",\{loader:.{0,300}?meta:\{_blog:\{title:(' + string + ')'
    routes = {json.loads(title): path for path, title in re.findall(pattern, script)}
    soup = BeautifulSoup(page, "html.parser")
    items = []
    for card in soup.select("article.article"):
        title, when = card.select_one(".title"), card.select_one(".author")
        if title and title.get_text(" ", strip=True) in routes:
            name = title.get_text(" ", strip=True)
            items.append(event(name, routes[name], SOURCES["ccf"]["url"],
                               meeting_date=when.get_text(" ", strip=True) if when else ""))
    return dedupe(items, 24)


def fetch(url):
    with requests.get(url, timeout=(10, 35), stream=True,
                      headers={"User-Agent": "ScholayToday-ConferenceRSS/1.0 (local public-calendar reader)",
                               "Accept": "text/html,application/json;q=0.9,*/*;q=0.5"}) as response:
        response.raise_for_status()
        chunks, size = [], 0
        deadline = time.monotonic() + 55
        for chunk in response.iter_content(65536):
            size += len(chunk)
            if size > MAX_BYTES or time.monotonic() > deadline:
                raise ValueError("Upstream response exceeds size or time limit")
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8-sig", errors="replace")


def collect(key):
    page = fetch(SOURCES[key]["url"])
    if key == "sciencenet":
        return parse_sciencenet(page)
    if key == "chemsoc":
        return parse_chemsoc(page)
    if key == "cssn":
        return parse_cssn(json.loads(fetch(cssn_endpoint(page))))
    if key == "ccf":
        return parse_ccf(page, fetch(ccf_asset(page)))
    raise ValueError("Unknown source")


def stamp():
    return datetime.now(UTC).isoformat()


def rss_bytes(key, record):
    root = ET.Element("rss", version="2.0")
    channel = ET.SubElement(root, "channel")
    meta = SOURCES[key]
    for name, value in [("title", meta["title"]), ("link", meta["url"]), ("description", meta["description"]),
                        ("language", "zh-cn"), ("ttl", "360"),
                        ("lastBuildDate", format_datetime(datetime.fromisoformat(record["success_at"])) )]:
        ET.SubElement(channel, name).text = value
    for data in record["items"]:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = text(data["title"])
        ET.SubElement(item, "link").text = data["url"]
        ET.SubElement(item, "guid", isPermaLink="false").text = "scholay-conference:" + key + ":" + hashlib.sha256(data["url"].encode()).hexdigest()
        ET.SubElement(item, "pubDate").text = format_datetime(datetime.fromisoformat(data.get("published") or data["first_seen"]))
        if data.get("category"):
            ET.SubElement(item, "category").text = data["category"]
        lines = []
        if data.get("image"):
            lines.append('<p><img src="' + html.escape(data["image"], quote=True) + '" alt="会议配图" /></p>')
        for field, label in [("meeting_date", "会议时间（非发布时间）"), ("location", "地点"), ("organizer", "主办单位")]:
            if data.get(field):
                lines.append("<p><strong>" + label + "：</strong>" + html.escape(data[field]) + "</p>")
        lines.append("<p>" + html.escape(meta["description"]) + "</p>")
        if not data.get("published"):
            lines.append("<p>原列表未提供发布时间；RSS 排序日期为首次采集时间。请以会议时间判断是否已结束。</p>")
        lines.append('<p><a href="' + html.escape(data["url"], quote=True) + '">查看原始通知／日程</a></p>')
        ET.SubElement(item, "description").text = text("".join(lines))
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


class Cache:
    def __init__(self, directory):
        self.path = Path(directory) / "cache.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.records = json.loads(self.path.read_text()) if self.path.exists() else {}

    def update(self, key, collector=collect):
        checked = stamp()
        try:
            items = collector(key)
            if not items:
                raise ValueError("No calendar entries parsed; keeping last successful cache")
            with self.lock:
                old = self.records.get(key, {})
                seen = dict(old.get("seen", {}))
                for item in items:
                    item["first_seen"] = seen.setdefault(item["url"], checked)
                record = {"items": items, "seen": seen, "checked_at": checked, "success_at": checked, "error": None}
                # Validate the generated XML before replacing the previous successful record.
                ET.fromstring(rss_bytes(key, record))
                self.records[key] = record
        except Exception as error:
            with self.lock:
                self.records.setdefault(key, {}).update(checked_at=checked, error=f"{type(error).__name__}: {str(error)[:240]}")
            logging.warning("%s refresh failed (%s)", key, type(error).__name__)
        with self.lock:
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.records, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(self.path)

    def refresh(self):
        # Separate hosts in parallel; each source is fetched at most once per cycle.
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(self.update, SOURCES))

    def health(self):
        with self.lock:
            return {key: {"title": meta["title"], "count": len(self.records.get(key, {}).get("items", [])),
                          **{field: self.records.get(key, {}).get(field) for field in ("checked_at", "success_at", "error")}}
                    for key, meta in SOURCES.items()}


def serve(cache, port, interval):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/health":
                health = cache.health()
                self.reply(200 if all(s["count"] for s in health.values()) else 503,
                           "application/json; charset=utf-8", json.dumps(health, ensure_ascii=False).encode())
                return
            key = path.removeprefix("/").removesuffix(".xml")
            if path != f"/{key}.xml" or key not in SOURCES:
                self.reply(404, "text/plain", b"Not found")
                return
            with cache.lock:
                record = cache.records.get(key, {})
                body = rss_bytes(key, record) if record.get("items") else None
            self.reply(200 if body else 503, "application/rss+xml; charset=utf-8", body or b"Cache not ready; retry later")

        def reply(self, status, content_type, body):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

    def refresh_loop():
        while True:
            timestamps = [r.get("checked_at") for r in cache.records.values() if r.get("checked_at")]
            elapsed = (datetime.now(UTC) - min(map(datetime.fromisoformat, timestamps))).total_seconds() if len(timestamps) == len(SOURCES) else interval
            if elapsed < interval:
                time.sleep(min(interval - elapsed, 60))
                continue
            cache.refresh()

    threading.Thread(target=refresh_loop, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("refresh", "serve"))
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--refresh-hours", type=float, default=6)
    args = parser.parse_args()
    if args.refresh_hours < 1:
        parser.error("Public calendars must not be refreshed more often than hourly")
    cache = Cache(args.data_dir)
    if args.command == "refresh":
        cache.refresh()
        print(json.dumps(cache.health(), ensure_ascii=False, indent=2))
        return 0 if all(r["count"] and not r["error"] for r in cache.health().values()) else 1
    serve(cache, args.port, args.refresh_hours * 3600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
