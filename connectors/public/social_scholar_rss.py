#!/usr/bin/env python3
"""Local, credential-free scholarly social-media RSS bridge for Papr."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import logging
import os
import re
import signal
import sys
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from email.utils import format_datetime, parsedate_to_datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup


APP_NAME = "Papr 学术社交公开源"
HOST = "127.0.0.1"
PORT = 8766
BASE_URL = f"http://{HOST}:{PORT}"
USER_AGENT = "PaprScholarSocial/1.0 (local personal RSS reader on macOS)"
REQUEST_TIMEOUT = (10, 35)
BOOTSTRAP_DIR = Path(__file__).resolve().parent / "bootstrap"

FEED_META = {
    "reddit": {
        "title": "学术社交·Reddit 精选",
        "description": "Reddit 学术生活、研究方法与开放科学社区的高质量热门讨论。",
        "filename": "reddit-scholar.xml",
        "max_items": 40,
        "link": "https://www.reddit.com/r/AskAcademia/",
    },
    "bluesky": {
        "title": "学术社交·Bluesky 学术账号",
        "description": "Bluesky 上的学术社区、开放科学、研究方法、科研诚信与科学传播账号。",
        "filename": "bluesky-scholar.xml",
        "max_items": 36,
        "link": "https://bsky.app/",
    },
    "mastodon": {
        "title": "学术社交·Mastodon 学术话题",
        "description": "Mastodon 学术实例上的学术生活、开放科学、综合科学、数学与数字人文公开话题。",
        "filename": "mastodon-scholar.xml",
        "max_items": 36,
        "link": "https://mastodon.social/",
    },
    "community": {
        "title": "学术社交·开放科研社区",
        "description": "Mander、Neurostars 与 Crossref Community 的开放科研讨论。",
        "filename": "community-scholar.xml",
        "max_items": 30,
        "link": "https://mander.xyz/c/science",
    },
}


@dataclass(frozen=True)
class Source:
    source_id: str
    platform: str
    name: str
    url: str
    limit: int


SOURCES = (
    Source(
        "reddit-scholar",
        "reddit",
        "Reddit·学术社区",
        "https://www.reddit.com/r/academia+AskAcademia+GradSchool+PhD+labrats+research+OpenScience+statistics+AskSocialScience+Professors/new/.rss?limit=100",
        40,
    ),
    Source("bluesky-academic-chatter", "bluesky", "Bluesky·Academic Chatter", "https://bsky.app/profile/academic-chatter.bsky.social/rss", 8),
    Source("bluesky-cos", "bluesky", "Bluesky·Center for Open Science", "https://bsky.app/profile/cos.io/rss", 8),
    Source("bluesky-ncrm", "bluesky", "Bluesky·Research Methods", "https://bsky.app/profile/ncrm.ac.uk/rss", 8),
    Source("bluesky-jcom", "bluesky", "Bluesky·Science Communication", "https://bsky.app/profile/jscicom.bsky.social/rss", 8),
    Source("bluesky-aaup", "bluesky", "Bluesky·Academic Life", "https://bsky.app/profile/aaup.org/rss", 8),
    Source("bluesky-retraction-watch", "bluesky", "Bluesky·Research Integrity", "https://bsky.app/profile/retractionwatch.com/rss", 8),
    Source("mastodon-academic-chatter", "mastodon", "Mastodon·#AcademicChatter", "https://mastodon.social/tags/AcademicChatter.rss", 6),
    Source("mastodon-phd-chat", "mastodon", "Mastodon·#PhDChat", "https://mastodon.social/tags/PhDChat.rss", 6),
    Source("mastodon-open-science", "mastodon", "FediScience·#OpenScience", "https://fediscience.org/tags/OpenScience.rss", 6),
    Source("mastodon-science", "mastodon", "mstdn.science·#Science", "https://mstdn.science/tags/science.rss", 6),
    Source("mastodon-math", "mastodon", "Mathstodon·#Math", "https://mathstodon.xyz/tags/math.rss", 6),
    Source("mastodon-digital-humanities", "mastodon", "Humanities Commons·#DigitalHumanities", "https://hcommons.social/tags/DigitalHumanities.rss", 6),
    Source("community-mander-science", "community", "Mander·Science", "https://mander.xyz/feeds/c/science.xml?sort=New", 10),
    Source("community-neurostars", "community", "Neurostars", "https://neurostars.org/latest.rss", 10),
    Source("community-crossref", "community", "Crossref Community", "https://community.crossref.org/latest.rss", 10),
)


@dataclass
class SocialItem:
    source_id: str
    platform: str
    source_name: str
    source_url: str
    title: str
    url: str
    guid: str
    published: str
    author: str = ""
    content_html: str = ""

    @property
    def published_dt(self) -> datetime:
        return datetime.fromisoformat(self.published).astimezone(timezone.utc)

    @property
    def display_title(self) -> str:
        return f"[{self.source_name}] {self.title}"


def collapse_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def parse_date(value: str) -> datetime:
    cleaned = collapse_space(value)
    if not cleaned:
        raise ValueError("empty date")
    try:
        result = parsedate_to_datetime(cleaned)
    except (TypeError, ValueError):
        result = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result.astimezone(timezone.utc)


def normalized_link(value: str, base: str) -> str:
    result = urljoin(base, value.strip())
    parts = urlsplit(result)
    if parts.scheme not in ("http", "https"):
        return ""
    return result


def safe_html(fragment: str, base_url: str) -> str:
    soup = BeautifulSoup(fragment or "", "html.parser")
    for node in soup.select("script, style, iframe, form, input, button, object, embed, noscript"):
        node.decompose()
    for node in soup.find_all(True):
        allowed: dict[str, str] = {}
        if node.name == "a" and node.get("href"):
            href = normalized_link(str(node["href"]), base_url)
            if href:
                allowed = {"href": href, "target": "_blank", "rel": "noopener noreferrer"}
        elif node.name == "img" and node.get("src"):
            src = normalized_link(str(node["src"]), base_url)
            if src:
                allowed = {"src": src}
                if node.get("alt"):
                    allowed["alt"] = collapse_space(str(node["alt"]))
        node.attrs = allowed
    rendered = str(soup)
    rendered = re.sub(r"[\r\n\t]+", " ", rendered)
    return re.sub(r">\s+<", "><", rendered).strip()


URL_RE = re.compile(r"https?://[^\s<>]+")


def linkify_text(value: str) -> str:
    pieces: list[str] = []
    cursor = 0
    for match in URL_RE.finditer(value):
        pieces.append(html.escape(value[cursor : match.start()]))
        raw_url = match.group(0)
        url = raw_url.rstrip(".,;:!?)]}")
        trailing = raw_url[len(url) :]
        escaped_url = html.escape(url, quote=True)
        pieces.append(f'<a href="{escaped_url}" target="_blank">{html.escape(url)}</a>')
        pieces.append(html.escape(trailing))
        cursor = match.end()
    pieces.append(html.escape(value[cursor:]))
    return "".join(pieces)


def plain_text_html(value: str) -> str:
    paragraphs: list[str] = []
    for raw in re.split(r"\n\s*\n", value.strip()):
        escaped = "<br>".join(linkify_text(line) for line in raw.strip().splitlines())
        if escaped:
            paragraphs.append(f"<p>{escaped}</p>")
    return "".join(paragraphs)


def derive_title(content: str, fallback: str = "学术社交动态") -> str:
    soup = BeautifulSoup(content or "", "html.parser")
    lines: list[str] = []
    for node in soup.find_all(["p", "blockquote"]):
        fragment = BeautifulSoup(str(node), "html.parser")
        for anchor in fragment.find_all("a"):
            classes = set(anchor.get("class", []))
            if classes.intersection({"hashtag", "mention"}):
                anchor.unwrap()
            else:
                anchor.decompose()
        candidate = collapse_space(fragment.get_text(" ", strip=True))
        candidate = re.sub(r"([#@])\s+", r"\1", candidate)
        candidate = re.sub(r"\(\s*\)", "", candidate)
        candidate = re.sub(r"\[contains (?:quote post|embedded content)[^\]]*\]", "", candidate, flags=re.I)
        if candidate:
            lines.append(candidate)
    if not lines:
        lines = [collapse_space(soup.get_text(" ", strip=True))]
    generic = re.compile(
        r"^(?:date\s*:|re\s*:|hello(?:\s+[^,.!]{0,20})?[,!]?|greetings(?:\s+fellow humans)?[,!]?)$",
        re.I,
    )
    eligible = [row for row in lines if len(row) >= 18 and not generic.fullmatch(row)]
    line = eligible[0] if eligible else (lines[0] if lines else "")
    if len(line) < 48:
        line = next((row for row in eligible[1:] if len(row) >= 48), line)
    line = URL_RE.sub("", line).strip(" —-:：")
    if not line:
        return fallback
    if len(line) <= 108:
        return line
    cut = line[:108]
    boundary = max(cut.rfind("。"), cut.rfind("！"), cut.rfind("？"), cut.rfind(". "), cut.rfind("; "))
    if boundary >= 38:
        cut = cut[: boundary + 1]
    return cut.rstrip() + "…"


def hash_guid(prefix: str, value: str) -> str:
    return f"papr-social:{prefix}:{hashlib.sha256(value.encode('utf-8')).hexdigest()[:24]}"


class Fetcher:
    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept": "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.2",
                "Accept-Language": "en,zh-CN;q=0.8,zh;q=0.7",
            }
        )

    def get(self, url: str) -> bytes:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = self.session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
                if response.status_code == HTTPStatus.TOO_MANY_REQUESTS:
                    raise requests.HTTPError("429 Too Many Requests", response=response)
                response.raise_for_status()
                return response.content
            except (requests.RequestException, OSError) as exc:
                last_error = exc
                if (
                    isinstance(exc, requests.HTTPError)
                    and exc.response is not None
                    and exc.response.status_code == HTTPStatus.TOO_MANY_REQUESTS
                ):
                    break
                if attempt < 2:
                    time.sleep(2.0 * (attempt + 1))
        assert last_error is not None
        raise last_error


ATOM = "{http://www.w3.org/2005/Atom}"


def parse_reddit(source: Source, payload: bytes) -> list[SocialItem]:
    root = ET.fromstring(payload)
    entries = root.findall(f"{ATOM}entry")
    if not entries:
        raise RuntimeError("Reddit Atom feed returned zero entries")
    items: list[SocialItem] = []
    per_community: dict[str, int] = {}
    for entry in entries:
        title = collapse_space(entry.findtext(f"{ATOM}title") or "")
        link = ""
        for node in entry.findall(f"{ATOM}link"):
            if node.get("rel") in (None, "alternate") and node.get("href"):
                link = normalized_link(node.get("href", ""), source.url)
                if link:
                    break
        if not title or not link:
            continue
        category = entry.find(f"{ATOM}category")
        subreddit = collapse_space(category.get("term", "") if category is not None else "")
        if not subreddit:
            match = re.search(r"/r/([^/]+)/", link, flags=re.I)
            subreddit = match.group(1) if match else "Academic"
        community_key = subreddit.removeprefix("r/").lower()
        if per_community.get(community_key, 0) >= 5:
            continue
        source_name = f"Reddit·r/{subreddit.removeprefix('r/')}"
        author = collapse_space(entry.findtext(f"{ATOM}author/{ATOM}name") or "")
        raw_content = entry.findtext(f"{ATOM}content") or entry.findtext(f"{ATOM}summary") or ""
        published_raw = entry.findtext(f"{ATOM}published") or entry.findtext(f"{ATOM}updated") or ""
        published = parse_date(published_raw).isoformat()
        external_guid = collapse_space(entry.findtext(f"{ATOM}id") or "")
        items.append(
            SocialItem(
                source.source_id,
                source.platform,
                source_name,
                f"https://www.reddit.com/r/{subreddit.removeprefix('r/')}/",
                title,
                link,
                external_guid or hash_guid(source.source_id, link),
                published,
                author,
                safe_html(raw_content, link),
            )
        )
        per_community[community_key] = per_community.get(community_key, 0) + 1
    return dedupe(items)[: source.limit]


def parse_bluesky(source: Source, payload: bytes) -> list[SocialItem]:
    root = ET.fromstring(payload)
    entries = root.findall("./channel/item")
    if not entries:
        raise RuntimeError("Bluesky RSS returned zero items")
    items: list[SocialItem] = []
    for entry in entries:
        link = normalized_link(entry.findtext("link") or "", source.url)
        description = entry.findtext("description") or ""
        if not link or not description.strip():
            continue
        title = collapse_space(entry.findtext("title") or "") or derive_title(description)
        published = parse_date(entry.findtext("pubDate") or "").isoformat()
        guid = collapse_space(entry.findtext("guid") or "") or hash_guid(source.source_id, link)
        handle_match = re.search(r"/profile/([^/]+)/", link)
        author = f"@{handle_match.group(1)}" if handle_match else ""
        items.append(
            SocialItem(
                source.source_id,
                source.platform,
                source.name,
                source.url.removesuffix("/rss"),
                title,
                link,
                guid,
                published,
                author,
                plain_text_html(description),
            )
        )
    return dedupe(items)[: source.limit]


def mastodon_author(link: str) -> str:
    parts = urlsplit(link)
    match = re.search(r"/@([^/]+)", parts.path)
    return f"@{match.group(1)}@{parts.hostname}" if match and parts.hostname else ""


MASTODON_RELEVANCE = {
    "mastodon-open-science": ("open science", "open data", "research", "reproduc", "fair", "dataset", "repository", "academic", "publication", "preprint", "peer review", "metadata"),
    "mastodon-science": ("research", "study", "scientist", "nasa", "biology", "physics", "chemistry", "climate", "telescope", "paper", "journal", "data", "computer science", "evolution", "laboratory", "university"),
    "mastodon-math": ("math", "theorem", "proof", "algebra", "geometry", "calculus", "equation", "number", "topology", "statistics", "mathemat"),
    "mastodon-digital-humanities": ("digital humanities", "humanit", "history", "archive", "library", "corpus", "edition", "manuscript", "museum", "heritage", "text analysis", "research", "conference"),
}


def mastodon_relevant(source: Source, description: str) -> bool:
    terms = MASTODON_RELEVANCE.get(source.source_id)
    if not terms:
        return True
    soup = BeautifulSoup(description, "html.parser")
    for node in soup.find_all("a"):
        node.decompose()
    visible = collapse_space(soup.get_text(" ", strip=True)).lower()
    return any(term in visible for term in terms)


def parse_mastodon(source: Source, payload: bytes) -> list[SocialItem]:
    root = ET.fromstring(payload)
    entries = root.findall("./channel/item")
    if not entries:
        raise RuntimeError("Mastodon RSS returned zero items")
    items: list[SocialItem] = []
    per_author: dict[str, int] = {}
    for entry in entries:
        link = normalized_link(entry.findtext("link") or "", source.url)
        description = entry.findtext("description") or ""
        if (
            not link
            or len(collapse_space(BeautifulSoup(description, "html.parser").get_text(" ", strip=True))) < 24
            or not mastodon_relevant(source, description)
        ):
            continue
        published = parse_date(entry.findtext("pubDate") or "").isoformat()
        guid = collapse_space(entry.findtext("guid") or "") or hash_guid(source.source_id, link)
        author = mastodon_author(link)
        author_key = author.lower() or link.split("/post/", 1)[0].lower()
        if per_author.get(author_key, 0) >= 2:
            continue
        items.append(
            SocialItem(
                source.source_id,
                source.platform,
                source.name,
                source.url.removesuffix(".rss"),
                derive_title(description),
                link,
                guid,
                published,
                author,
                safe_html(description, link),
            )
        )
        per_author[author_key] = per_author.get(author_key, 0) + 1
    return dedupe(items)[: source.limit]


DC_CREATOR = "{http://purl.org/dc/elements/1.1/}creator"


def parse_community(source: Source, payload: bytes) -> list[SocialItem]:
    root = ET.fromstring(payload)
    entries = root.findall("./channel/item")
    if not entries:
        raise RuntimeError("community RSS returned zero items")
    items: list[SocialItem] = []
    for entry in entries:
        title = collapse_space(entry.findtext("title") or "")
        link = normalized_link(entry.findtext("link") or "", source.url)
        description = entry.findtext("description") or ""
        date_raw = entry.findtext("pubDate") or entry.findtext("date") or ""
        if not title or not link or not date_raw:
            continue
        guid = collapse_space(entry.findtext("guid") or "") or hash_guid(source.source_id, link)
        author = collapse_space(entry.findtext(DC_CREATOR) or entry.findtext("author") or "")
        items.append(
            SocialItem(
                source.source_id,
                source.platform,
                source.name,
                source.url,
                title,
                link,
                guid,
                parse_date(date_raw).isoformat(),
                author,
                safe_html(description, link),
            )
        )
    if not items:
        raise RuntimeError("community RSS returned zero usable items")
    return dedupe(items)[: source.limit]


PARSERS = {
    "reddit": parse_reddit,
    "bluesky": parse_bluesky,
    "mastodon": parse_mastodon,
    "community": parse_community,
}


def dedupe(items: Iterable[SocialItem]) -> list[SocialItem]:
    result: dict[str, SocialItem] = {}
    for item in items:
        key = item.url or item.guid
        current = result.get(key)
        if current is None or item.published_dt > current.published_dt:
            result[key] = item
    return sorted(result.values(), key=lambda row: row.published_dt, reverse=True)


def item_from_dict(raw: dict[str, Any]) -> SocialItem | None:
    try:
        keys = set(SocialItem.__dataclass_fields__)
        return SocialItem(**{key: value for key, value in raw.items() if key in keys})
    except (TypeError, ValueError):
        return None


def load_bootstrap_items(source: Source) -> tuple[list[SocialItem], str | None]:
    """Load a bundled, previously verified public response as a first-run cache."""
    path = BOOTSTRAP_DIR / f"{source.source_id}.xml"
    payload = path.read_bytes()
    items = PARSERS[source.platform](source, payload)
    root = ET.fromstring(payload)
    updated = root.findtext(f"{ATOM}updated") if source.platform == "reddit" else None
    snapshot_at = parse_date(updated).isoformat() if updated else None
    return items, snapshot_at


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "sources": {}}


def atomic_write(path: Path, value: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    if isinstance(value, bytes):
        temp.write_bytes(value)
    else:
        temp.write_text(value, encoding="utf-8")
    os.replace(temp, path)


def item_body(item: SocialItem, fetched_at: datetime) -> str:
    author = f"<br><strong>作者：</strong>{html.escape(item.author)}" if item.author else ""
    header = (
        f"<p><strong>平台来源：</strong>{html.escape(item.source_name)}{author}<br>"
        f"<strong>发布时间：</strong>{html.escape(item.published_dt.strftime('%Y-%m-%d %H:%M UTC'))}<br>"
        f"<strong>聚合抓取：</strong>{html.escape(fetched_at.strftime('%Y-%m-%d %H:%M UTC'))}<br>"
        f'<a href="{html.escape(item.url, quote=True)}">打开平台原帖</a></p><hr>'
    )
    return header + (item.content_html or "<p>请打开平台原帖查看。</p>")


def build_feed(platform: str, items: list[SocialItem], fetched_at: datetime) -> bytes:
    meta = FEED_META[platform]
    ET.register_namespace("atom", "http://www.w3.org/2005/Atom")
    ET.register_namespace("content", "http://purl.org/rss/1.0/modules/content/")
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = meta["title"]
    ET.SubElement(channel, "link").text = meta["link"]
    ET.SubElement(channel, "description").text = meta["description"]
    ET.SubElement(channel, "language").text = "zh-CN"
    ET.SubElement(channel, "lastBuildDate").text = format_datetime(fetched_at)
    ET.SubElement(channel, "generator").text = APP_NAME
    ET.SubElement(channel, "ttl").text = "120"
    ET.SubElement(
        channel,
        "{http://www.w3.org/2005/Atom}link",
        {"href": f"{BASE_URL}/{meta['filename']}", "rel": "self", "type": "application/rss+xml"},
    )
    for item in items[: int(meta["max_items"])]:
        node = ET.SubElement(channel, "item")
        ET.SubElement(node, "title").text = item.display_title
        ET.SubElement(node, "link").text = item.url
        ET.SubElement(node, "guid", {"isPermaLink": "false"}).text = item.guid
        ET.SubElement(node, "pubDate").text = format_datetime(item.published_dt)
        if item.author:
            ET.SubElement(node, "author").text = item.author
        ET.SubElement(node, "source", {"url": item.source_url}).text = item.source_name
        ET.SubElement(node, "category").text = item.platform
        body = item_body(item, fetched_at)
        ET.SubElement(node, "description").text = body[:5000]
        ET.SubElement(node, "{http://purl.org/rss/1.0/modules/content/}encoded").text = body
    ET.indent(rss, space="  ")
    return ET.tostring(rss, encoding="utf-8", xml_declaration=True)


class Aggregator:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.state_path = data_dir / "state.json"
        self.health_path = data_dir / "health.json"
        self.lock = threading.Lock()

    def has_fresh_output(self, max_age_seconds: int = 300) -> bool:
        state = load_json(self.state_path)
        try:
            updated = parse_date(str(state["updated_at"]))
        except (KeyError, TypeError, ValueError):
            return False
        expected = [self.health_path] + [self.data_dir / str(meta["filename"]) for meta in FEED_META.values()]
        return (datetime.now(timezone.utc) - updated).total_seconds() <= max_age_seconds and all(path.is_file() for path in expected)

    def refresh(self) -> dict[str, Any]:
        if not self.lock.acquire(blocking=False):
            return {"ok": False, "message": "refresh already running"}
        started = datetime.now(timezone.utc)
        logging.info("refresh started")
        try:
            previous = load_json(self.state_path)
            old_sources = previous.get("sources", {}) if isinstance(previous, dict) else {}
            next_sources: dict[str, Any] = {}
            errors: dict[str, str] = {}
            def fetch_public(source):
                fetcher = Fetcher()
                try:
                    return fetcher.get(source.url)
                except Exception as error:
                    return error
                finally:
                    fetcher.session.close()
            # One slow/blocked overseas site must not serialize all 16 sources.
            # Sessions remain per-worker; no cross-platform cookie sharing.
            with ThreadPoolExecutor(max_workers=4) as pool:
                payloads = list(pool.map(fetch_public, SOURCES))
            for source, payload in zip(SOURCES, payloads):
                try:
                    if isinstance(payload, Exception):
                        raise payload
                    items = PARSERS[source.platform](source, payload)
                    if not items:
                        raise RuntimeError("parser returned zero usable items")
                    next_sources[source.source_id] = {
                        "name": source.name,
                        "platform": source.platform,
                        "url": source.url,
                        "last_success": started.isoformat(),
                        "error": None,
                        "bootstrap": False,
                        "items": [asdict(item) for item in items],
                    }
                    logging.info("%s: %d items", source.source_id, len(items))
                except Exception as exc:  # noqa: BLE001 - each public source is isolated
                    message = f"{type(exc).__name__}: {exc}"
                    errors[source.source_id] = message
                    old = old_sources.get(source.source_id, {}) if isinstance(old_sources, dict) else {}
                    cached_items = old.get("items", [])
                    cached_at = old.get("last_success")
                    bootstrap = bool(old.get("bootstrap", False))
                    if not cached_items:
                        try:
                            bundled_items, bundled_at = load_bootstrap_items(source)
                            cached_items = [asdict(item) for item in bundled_items]
                            cached_at = bundled_at
                            bootstrap = True
                            logging.info("%s: using %d bundled bootstrap items", source.source_id, len(bundled_items))
                        except (OSError, ET.ParseError, RuntimeError, ValueError):
                            pass
                    next_sources[source.source_id] = {
                        "name": source.name,
                        "platform": source.platform,
                        "url": source.url,
                        "last_success": cached_at,
                        "error": message,
                        "bootstrap": bootstrap,
                        "items": cached_items,
                    }
                    logging.warning("%s failed: %s", source.source_id, message)
            grouped: dict[str, list[SocialItem]] = {key: [] for key in FEED_META}
            for source_data in next_sources.values():
                for raw in source_data.get("items", []):
                    item = item_from_dict(raw)
                    if item:
                        grouped[item.platform].append(item)
            for platform in grouped:
                grouped[platform] = dedupe(grouped[platform])[: int(FEED_META[platform]["max_items"])]
                atomic_write(self.data_dir / str(FEED_META[platform]["filename"]), build_feed(platform, grouped[platform], started))

            health = {
                "ok": not errors,
                "service": APP_NAME,
                "updated_at": started.isoformat(),
                "feeds": {platform: len(items) for platform, items in grouped.items()},
                "items": sum(len(items) for items in grouped.values()),
                "sources_ok": len(SOURCES) - len(errors),
                "sources_total": len(SOURCES),
                "sources": {
                    source_id: {
                        "name": data["name"],
                        "platform": data["platform"],
                        "items": len(data.get("items", [])),
                        "last_success": data.get("last_success"),
                        "error": data.get("error"),
                        "bootstrap": bool(data.get("bootstrap", False)),
                    }
                    for source_id, data in next_sources.items()
                },
            }
            state = {"version": 1, "updated_at": started.isoformat(), "sources": next_sources}
            atomic_write(self.state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
            atomic_write(self.health_path, json.dumps(health, ensure_ascii=False, indent=2) + "\n")
            logging.info("refresh finished: %d items, %d source errors", health["items"], len(errors))
            return health
        finally:
            self.lock.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "PaprScholarSocial/1.0"

    def do_GET(self) -> None:  # noqa: N802 - stdlib interface
        path = self.path.split("?", 1)[0]
        mapping = {
            "/reddit-scholar.xml": ("reddit-scholar.xml", "application/rss+xml; charset=utf-8"),
            "/bluesky-scholar.xml": ("bluesky-scholar.xml", "application/rss+xml; charset=utf-8"),
            "/mastodon-scholar.xml": ("mastodon-scholar.xml", "application/rss+xml; charset=utf-8"),
            "/community-scholar.xml": ("community-scholar.xml", "application/rss+xml; charset=utf-8"),
            "/health": ("health.json", "application/json; charset=utf-8"),
            "/health.json": ("health.json", "application/json; charset=utf-8"),
        }
        if path == "/":
            path = "/health"
        target = mapping.get(path)
        if not target:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            payload = (Path(self.server.data_dir) / target[0]).read_bytes()  # type: ignore[attr-defined]
        except OSError:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", target[1])
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format_string: str, *args: Any) -> None:
        logging.info("http %s - %s", self.client_address[0], format_string % args)


def configure_logging(log_path: Path | None, verbose: bool) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_path:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_path, encoding="utf-8"))
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
        force=True,
    )


def run_once(data_dir: Path, verbose: bool) -> int:
    data_dir.mkdir(parents=True, exist_ok=True)
    configure_logging(None, verbose)
    health = Aggregator(data_dir).refresh()
    print(json.dumps(health, ensure_ascii=False, indent=2))
    return 0 if health.get("items", 0) else 1


def serve(data_dir: Path, host: str, port: int, refresh_hours: float, verbose: bool) -> int:
    data_dir.mkdir(parents=True, exist_ok=True)
    configure_logging(data_dir / "service.log", verbose)
    aggregator = Aggregator(data_dir)
    if aggregator.has_fresh_output():
        logging.info("using fresh cached feeds at startup")
    else:
        aggregator.refresh()
    stop = threading.Event()

    def refresh_loop() -> None:
        while not stop.wait(max(300.0, refresh_hours * 3600.0)):
            try:
                aggregator.refresh()
            except Exception:  # noqa: BLE001
                logging.exception("scheduled refresh crashed")

    threading.Thread(target=refresh_loop, name="social-scholar-refresh", daemon=True).start()
    server = ThreadingHTTPServer((host, port), Handler)
    server.data_dir = str(data_dir)  # type: ignore[attr-defined]

    def stop_server(signum: int, _frame: Any) -> None:
        logging.info("received signal %s", signum)
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop_server)
    signal.signal(signal.SIGINT, stop_server)
    logging.info("serving feeds on http://%s:%d", host, port)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop.set()
        server.server_close()
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    for name in ("once", "serve"):
        command = commands.add_parser(name)
        command.add_argument("--data-dir", required=True, type=Path)
        command.add_argument("--verbose", action="store_true")
        if name == "serve":
            command.add_argument("--host", default=HOST)
            command.add_argument("--port", default=PORT, type=int)
            command.add_argument("--refresh-hours", default=2.0, type=float)
    return result


def main() -> int:
    args = parser().parse_args()
    if args.command == "once":
        return run_once(args.data_dir.resolve(), args.verbose)
    return serve(args.data_dir.resolve(), args.host, args.port, args.refresh_hours, args.verbose)


if __name__ == "__main__":
    raise SystemExit(main())
