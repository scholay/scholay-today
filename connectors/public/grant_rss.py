#!/usr/bin/env python3
"""Local RSS bridge for mainland-China research funding calls.

The service polls five official sources, filters for application opportunities,
keeps the last successful result when one source is temporarily unavailable,
and serves a standards-compliant RSS 2.0 feed on loopback only.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import logging
import os
import re
import signal
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from email.utils import format_datetime
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup, Tag


APP_NAME = "Papr 中国大陆基金申报聚合"
FEED_TITLE = "中国大陆·基金申报（官方聚合）"
FEED_DESCRIPTION = (
    "聚合国家自然科学基金委、国家科技管理信息系统、全国哲学社会科学工作办公室、"
    "教育部社会科学司和中国博士后科学基金会的官方申报信息。"
)
SELF_URL = "http://127.0.0.1:8765/funding.xml"
SHANGHAI = ZoneInfo("Asia/Shanghai")
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 PaprGrantRSS/1.0"
)
REQUEST_TIMEOUT = (10, 35)
RETENTION_DAYS = 190
PINNED_DAYS = 370
MAX_ITEMS_PER_SOURCE = 32
MAX_FEED_ITEMS = 110
MAX_CONTENT_CHARS = 48_000

POSTDOC_CATEGORY = "8c892b1c-4ade-4a5f-9a87-5e736cb5e9f9"
POSTDOC_DEPTS = "110,111"
POSTDOC_LIST_API = (
    "https://www.chinapostdoctor.org.cn/prod-api/system/info/"
    "find_passed_by_categoryid_and_deptids_paging"
)
POSTDOC_DETAIL_API = (
    "https://www.chinapostdoctor.org.cn/prod-api/system/info/findone"
)

POSITIVE_WEIGHTS: tuple[tuple[str, int], ...] = (
    ("申报", 7),
    ("项目指南", 7),
    ("申请指南", 7),
    ("资助指南", 7),
    ("申请与结题", 5),
    ("申请", 4),
    ("征集", 4),
    ("招标", 4),
    ("揭榜挂帅", 4),
    ("课题承担单位", 4),
    ("指南", 3),
    ("公开项目", 2),
    ("专项", 1),
    ("青年", 1),
    ("基金", 1),
)

NEGATIVE_WEIGHTS: tuple[tuple[str, int], ...] = (
    ("立项名单", -9),
    ("拟资助", -9),
    ("获资助", -8),
    ("资助名单", -9),
    ("评审结果", -8),
    ("初审结果", -8),
    ("决算", -8),
    ("预算", -6),
    ("中期检查", -5),
    ("经费下拨", -5),
    ("下拨", -5),
    ("学术交流", -6),
    ("研讨会", -6),
    ("培训", -5),
    ("招聘", -6),
    ("成果", -5),
    ("结项", -3),
    ("公示", -4),
    ("立项", -4),
)


@dataclass(frozen=True)
class SourceSpec:
    source_id: str
    name: str
    prefix: str
    homepage: str


SOURCES: dict[str, SourceSpec] = {
    "nsfc": SourceSpec(
        "nsfc",
        "国家自然科学基金委员会",
        "国自然",
        "https://www.nsfc.gov.cn/p1/3381/2824/zntg.html",
    ),
    "most": SourceSpec(
        "most",
        "国家科技管理信息系统",
        "国科管",
        "https://service.most.gov.cn/kjjh_tztg_all/?type=1",
    ),
    "nopss": SourceSpec(
        "nopss",
        "全国哲学社会科学工作办公室",
        "国社科",
        "https://www.nopss.gov.cn/GB/219469/index.html",
    ),
    "moe": SourceSpec(
        "moe",
        "教育部社会科学司",
        "教育部社科",
        "https://www.moe.gov.cn/s78/A13/tongzhi/",
    ),
    "postdoc": SourceSpec(
        "postdoc",
        "中国博士后科学基金会",
        "博士后基金",
        "https://www.chinapostdoctor.org.cn/list?"
        "id=8c892b1c-4ade-4a5f-9a87-5e736cb5e9f9&name=通知公告&yname=8",
    ),
}


@dataclass
class GrantItem:
    source_id: str
    source_name: str
    source_prefix: str
    source_homepage: str
    title: str
    url: str
    published: str
    score: int = 0
    matches: list[str] = field(default_factory=list)
    content_html: str = ""
    external_id: str = ""
    category_id: str = ""

    @property
    def published_dt(self) -> datetime:
        return parse_date(self.published)

    @property
    def display_title(self) -> str:
        return f"[{self.source_prefix}] {self.title}"

    @property
    def guid(self) -> str:
        if self.external_id:
            return f"papr-grant:{self.source_id}:{self.external_id}"
        digest = hashlib.sha256(self.url.encode("utf-8")).hexdigest()[:24]
        return f"papr-grant:{self.source_id}:{digest}"


def collapse_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def normalize_url(value: str, base: str) -> str:
    absolute = urljoin(base, value.strip())
    parts = urlsplit(absolute)
    scheme = "https" if parts.scheme in ("", "http", "https") else parts.scheme
    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, ""))


def parse_date(value: str) -> datetime:
    cleaned = collapse_space(value).strip("[]")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y年%m月%d日"):
        try:
            dt = datetime.strptime(cleaned, fmt)
            if fmt == "%Y-%m-%d":
                dt = dt.replace(hour=12)
            return dt.replace(tzinfo=SHANGHAI)
        except ValueError:
            continue
    raise ValueError(f"unsupported date: {value!r}")


def score_title(title: str) -> tuple[int, list[str]]:
    normalized = collapse_space(title)
    score = 0
    matches: list[str] = []
    for word, weight in POSITIVE_WEIGHTS + NEGATIVE_WEIGHTS:
        if word in normalized:
            score += weight
            matches.append(word)
    return score, matches


def should_keep(item: GrantItem, now: datetime) -> bool:
    try:
        age = now - item.published_dt
    except ValueError:
        return False
    if age < timedelta(days=-30):
        return False
    if age <= timedelta(days=RETENTION_DAYS):
        return item.score >= 4
    pinned = (
        str(now.year) in item.title
        and any(term in item.title for term in ("年度项目指南", "资助指南", "申请与结题"))
    )
    return pinned and age <= timedelta(days=PINNED_DAYS) and item.score >= 4


class Fetcher:
    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
            }
        )

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = self.session.request(
                    method,
                    url,
                    timeout=REQUEST_TIMEOUT,
                    allow_redirects=True,
                    **kwargs,
                )
                response.raise_for_status()
                return response
            except requests.exceptions.SSLError as exc:
                # NSFC currently presents a certificate chain that curl/macOS can
                # validate but Python's bundled CA store cannot on some Macs. Keep
                # TLS verification enabled by falling back to the system curl only
                # for GETs to this exact official hostname.
                if method.upper() == "GET" and urlsplit(url).hostname == "www.nsfc.gov.cn":
                    return self._curl_get(url)
                last_error = exc
                if attempt < 2:
                    time.sleep(1.5 * (2**attempt))
            except (requests.RequestException, OSError) as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(1.5 * (2**attempt))
        assert last_error is not None
        raise last_error

    def _curl_get(self, url: str) -> requests.Response:
        completed = subprocess.run(
            [
                "curl.exe" if sys.platform == "win32" else "/usr/bin/curl",
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--connect-timeout",
                str(REQUEST_TIMEOUT[0]),
                "--max-time",
                str(REQUEST_TIMEOUT[1]),
                "--user-agent",
                USER_AGENT,
                "--header",
                "Accept-Language: zh-CN,zh;q=0.9,en;q=0.5",
                url,
            ],
            check=True,
            capture_output=True,
            creationflags=0x08000000 if sys.platform == "win32" else 0,
            timeout=REQUEST_TIMEOUT[1] + 5,
        )
        response = requests.Response()
        response.status_code = HTTPStatus.OK
        response.url = url
        response._content = completed.stdout
        response.encoding = "utf-8"
        return response

    def soup(self, url: str) -> BeautifulSoup:
        response = self.request("GET", url)
        return BeautifulSoup(response.content, "html.parser")

    def json_post(self, url: str, params: dict[str, str | int]) -> Any:
        response = self.request(
            "POST",
            url,
            params=params,
            headers={"Accept": "application/json", "Content-Type": "application/json;charset=UTF-8"},
        )
        return response.json()


def candidate(
    spec: SourceSpec,
    title: str,
    url: str,
    published: str,
    *,
    external_id: str = "",
    category_id: str = "",
) -> GrantItem:
    title = collapse_space(title)
    score, matches = score_title(title)
    return GrantItem(
        source_id=spec.source_id,
        source_name=spec.name,
        source_prefix=spec.prefix,
        source_homepage=spec.homepage,
        title=title,
        url=normalize_url(url, spec.homepage),
        published=collapse_space(published).strip("[]"),
        score=score,
        matches=matches,
        external_id=external_id,
        category_id=category_id,
    )


def parse_nsfc(fetcher: Fetcher) -> list[GrantItem]:
    spec = SOURCES["nsfc"]
    page_urls = [spec.homepage] + [
        f"https://www.nsfc.gov.cn/p1/3381/2824/zntg_{page}.html"
        for page in range(2, 6)
    ]
    items: list[GrantItem] = []
    for page_url in page_urls:
        soup = fetcher.soup(page_url)
        rows = soup.select("ul.wzy-ul > li.wzy-item")
        if not rows:
            raise RuntimeError(f"NSFC selector returned zero rows: {page_url}")
        for row in rows:
            anchor = row.select_one("a.wzy-box-c[href]")
            if not anchor:
                continue
            date_node = row.select_one(".wzy-item-time > div:last-child")
            date_text = collapse_space(date_node.get_text(" ", strip=True) if date_node else "")
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_text):
                continue
            items.append(
                candidate(
                    spec,
                    anchor.get("title") or anchor.get_text(" ", strip=True),
                    anchor["href"],
                    date_text,
                )
            )
    return dedupe_items(items)


def parse_most(fetcher: Fetcher) -> list[GrantItem]:
    spec = SOURCES["most"]
    list_root = "https://service.most.gov.cn/kjjh_tztg/"
    page_urls = [list_root] + [urljoin(list_root, f"index_{page}.html") for page in range(2, 7)]
    items: list[GrantItem] = []
    open_re = re.compile(r"openW\(\s*['\"]([^'\"]+)['\"]\s*\)")
    for page_url in page_urls:
        soup = fetcher.soup(page_url)
        rows = soup.select('table[name="tabs"] tr')
        if not rows:
            raise RuntimeError(f"MOST selector returned zero rows: {page_url}")
        for row in rows:
            title_node = row.select_one("td.table_gkgs_title > div[onclick]")
            date_node = row.select_one("td.table_gkgs_date")
            if not title_node or not date_node:
                continue
            match = open_re.search(title_node.get("onclick", ""))
            if not match:
                continue
            date_text = collapse_space(date_node.get_text(" ", strip=True))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_text):
                continue
            items.append(
                candidate(
                    spec,
                    title_node.get("title") or title_node.get_text(" ", strip=True),
                    match.group(1),
                    date_text,
                )
            )
    return dedupe_items(items)


def parse_nopss(fetcher: Fetcher) -> list[GrantItem]:
    spec = SOURCES["nopss"]
    soup = fetcher.soup(spec.homepage)
    container = soup.select_one(".list_con_2j")
    if not container:
        raise RuntimeError("NOPSS selector returned no list container")
    items: list[GrantItem] = []
    for row in container.select("ul.clearfix > li"):
        anchor = row.select_one(":scope > a[href]")
        date_node = row.select_one(":scope > em")
        if not anchor or not date_node:
            continue
        date_match = re.search(r"\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?", date_node.get_text(" "))
        if not date_match:
            continue
        items.append(
            candidate(
                spec,
                anchor.get_text(" ", strip=True),
                anchor["href"],
                date_match.group(0),
            )
        )
    if not items:
        raise RuntimeError("NOPSS selector returned zero dated rows")
    return dedupe_items(items)


def parse_moe(fetcher: Fetcher) -> list[GrantItem]:
    spec = SOURCES["moe"]
    soup = fetcher.soup(spec.homepage)
    rows = soup.select("ul#list > li")
    if not rows:
        raise RuntimeError("MOE selector returned zero rows")
    items: list[GrantItem] = []
    for row in rows:
        anchor = row.select_one(":scope > a[href]")
        date_node = row.select_one(":scope > span")
        if not anchor or not date_node:
            continue
        date_text = collapse_space(date_node.get_text(" ", strip=True))
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_text):
            continue
        items.append(
            candidate(
                spec,
                anchor.get("title") or anchor.get_text(" ", strip=True),
                anchor["href"],
                date_text,
            )
        )
    return dedupe_items(items)


def parse_postdoc(fetcher: Fetcher) -> list[GrantItem]:
    spec = SOURCES["postdoc"]
    payload = fetcher.json_post(
        POSTDOC_LIST_API,
        {
            "categoryid": POSTDOC_CATEGORY,
            "deptids": POSTDOC_DEPTS,
            "pageindex": 1,
            "pagesize": 160,
        },
    )
    rows = payload.get("InfoList") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("postdoc API returned no InfoList rows")
    items: list[GrantItem] = []
    for row in rows:
        title = f"{row.get('infotitle', '')}{row.get('jianti', '')}"
        info_id = str(row.get("infoid", ""))
        category_id = str(row.get("categoryid") or POSTDOC_CATEGORY)
        if not info_id or not row.get("addtime"):
            continue
        url = row.get("returnurl") or (
            "https://www.chinapostdoctor.org.cn/article?"
            f"inid={info_id}&catid={category_id}"
        )
        items.append(
            candidate(
                spec,
                title,
                str(url),
                str(row["addtime"]),
                external_id=info_id,
                category_id=category_id,
            )
        )
    return dedupe_items(items)


PARSERS = {
    "nsfc": parse_nsfc,
    "most": parse_most,
    "nopss": parse_nopss,
    "moe": parse_moe,
    "postdoc": parse_postdoc,
}


def dedupe_items(items: Iterable[GrantItem]) -> list[GrantItem]:
    unique: dict[str, GrantItem] = {}
    for item in items:
        unique[item.url] = item
    return list(unique.values())


def absolute_links(fragment: Tag | BeautifulSoup, base_url: str) -> None:
    for tag in fragment.select("a[href]"):
        tag["href"] = normalize_url(str(tag["href"]), base_url)
    for tag in fragment.select("img[src]"):
        tag["src"] = normalize_url(str(tag["src"]), base_url)


def clean_fragment(fragment: Tag | BeautifulSoup, base_url: str) -> str:
    soup = BeautifulSoup(str(fragment), "html.parser")
    for node in soup.select("script, style, iframe, form, button, input, noscript"):
        node.decompose()
    absolute_links(soup, base_url)
    for node in soup.find_all(True):
        allowed: dict[str, Any] = {}
        if node.name == "a" and node.get("href"):
            allowed["href"] = node["href"]
            allowed["target"] = "_blank"
        elif node.name == "img" and node.get("src"):
            allowed["src"] = node["src"]
            if node.get("alt"):
                allowed["alt"] = node["alt"]
        node.attrs = allowed
    rendered = collapse_html_whitespace(str(soup))
    if len(rendered) > MAX_CONTENT_CHARS:
        rendered = rendered[:MAX_CONTENT_CHARS]
        rendered += "<p><em>正文较长，聚合源已截断；请打开官方原文继续阅读。</em></p>"
    return rendered


def collapse_html_whitespace(value: str) -> str:
    value = re.sub(r"[\r\n\t]+", " ", value)
    value = re.sub(r">\s+<", "><", value)
    return value.strip()


def fetch_html_detail(fetcher: Fetcher, item: GrantItem) -> tuple[str, str]:
    soup = fetcher.soup(item.url)
    selectors = {
        "nsfc": (".detail-p", ".detail-title"),
        "most": (".article-body", "h1.article__title"),
        "nopss": (".text_con", ".text_con > h1"),
        "moe": (".TRS_Editor", "meta[name='ArticleTitle']"),
    }
    content_selector, title_selector = selectors[item.source_id]
    content = soup.select_one(content_selector)
    if not content:
        raise RuntimeError(f"detail selector {content_selector!r} returned no content")
    if item.source_id == "nopss":
        for node in content.select("h1, h3, h4, h5, .box_pic, .edit, .zdfy, center"):
            node.decompose()
    title_node = soup.select_one(title_selector)
    title = item.title
    if title_node:
        if title_node.name == "meta":
            title = collapse_space(str(title_node.get("content", ""))) or title
        else:
            title = collapse_space(title_node.get_text(" ", strip=True)) or title
    return title, clean_fragment(content, item.url)


def fetch_postdoc_detail(fetcher: Fetcher, item: GrantItem) -> tuple[str, str]:
    payload = fetcher.json_post(
        POSTDOC_DETAIL_API,
        {
            "infoid": item.external_id,
            "categoryid": item.category_id or POSTDOC_CATEGORY,
        },
    )
    if not isinstance(payload, dict):
        raise RuntimeError("postdoc detail API returned a non-object")
    title = collapse_space(f"{payload.get('infotitle', '')}{payload.get('jianti', '')}") or item.title
    content = payload.get("infocontent") or payload.get("summary") or ""
    return title, clean_fragment(BeautifulSoup(str(content), "html.parser"), item.url)


def fetch_detail(fetcher: Fetcher, item: GrantItem) -> GrantItem:
    if item.source_id == "postdoc":
        title, content = fetch_postdoc_detail(fetcher, item)
    else:
        title, content = fetch_html_detail(fetcher, item)
    item.title = title
    item.content_html = content
    item.score, item.matches = score_title(item.title)
    return item


def load_state(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"version": 1, "sources": {}}


def atomic_write(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    if isinstance(data, bytes):
        temp.write_bytes(data)
    else:
        temp.write_text(data, encoding="utf-8")
    os.replace(temp, path)


def item_from_dict(data: dict[str, Any]) -> GrantItem | None:
    try:
        allowed = set(GrantItem.__dataclass_fields__)
        return GrantItem(**{key: value for key, value in data.items() if key in allowed})
    except (TypeError, ValueError):
        return None


def prepare_item_html(item: GrantItem, fetched_at: str) -> str:
    match_text = "、".join(item.matches) if item.matches else "申报机会"
    metadata = (
        f"<p><strong>官方来源：</strong>{html.escape(item.source_name)}<br>"
        f"<strong>发布日期：</strong>{html.escape(item.published)}<br>"
        f"<strong>筛选命中：</strong>{html.escape(match_text)}<br>"
        f"<strong>聚合抓取：</strong>{html.escape(fetched_at)}<br>"
        f"<a href=\"{html.escape(item.url, quote=True)}\">打开官方原文</a></p><hr>"
    )
    body = item.content_html or "<p>官方页面未提供可安全提取的正文，请打开原文查看。</p>"
    return metadata + body


def build_feed(items: list[GrantItem], fetched_at: datetime, health: dict[str, Any]) -> bytes:
    ET.register_namespace("atom", "http://www.w3.org/2005/Atom")
    ET.register_namespace("content", "http://purl.org/rss/1.0/modules/content/")
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = FEED_TITLE
    ET.SubElement(channel, "link").text = "https://www.nsfc.gov.cn/"
    ET.SubElement(channel, "description").text = FEED_DESCRIPTION
    ET.SubElement(channel, "language").text = "zh-CN"
    ET.SubElement(channel, "lastBuildDate").text = format_datetime(fetched_at)
    ET.SubElement(channel, "generator").text = APP_NAME
    ET.SubElement(channel, "ttl").text = "240"
    ET.SubElement(
        channel,
        "{http://www.w3.org/2005/Atom}link",
        {"href": SELF_URL, "rel": "self", "type": "application/rss+xml"},
    )

    fetched_label = fetched_at.strftime("%Y-%m-%d %H:%M %Z")
    for grant in sorted(items, key=lambda row: row.published_dt, reverse=True)[:MAX_FEED_ITEMS]:
        node = ET.SubElement(channel, "item")
        ET.SubElement(node, "title").text = grant.display_title
        ET.SubElement(node, "link").text = grant.url
        ET.SubElement(node, "guid", {"isPermaLink": "false"}).text = grant.guid
        ET.SubElement(node, "pubDate").text = format_datetime(grant.published_dt)
        ET.SubElement(node, "author").text = grant.source_name
        ET.SubElement(node, "source", {"url": grant.source_homepage}).text = grant.source_name
        ET.SubElement(node, "category").text = grant.source_prefix
        for match in grant.matches[:5]:
            ET.SubElement(node, "category").text = match
        content = prepare_item_html(grant, fetched_label)
        ET.SubElement(node, "description").text = content[:5000]
        ET.SubElement(node, "{http://purl.org/rss/1.0/modules/content/}encoded").text = content

    ET.indent(rss, space="  ")
    return ET.tostring(rss, encoding="utf-8", xml_declaration=True)


class GrantAggregator:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.state_path = data_dir / "state.json"
        self.feed_path = data_dir / "funding.xml"
        self.health_path = data_dir / "health.json"
        self.lock = threading.Lock()

    def refresh(self) -> dict[str, Any]:
        if not self.lock.acquire(blocking=False):
            return {"ok": False, "message": "refresh already running"}
        started = datetime.now(SHANGHAI)
        logging.info("refresh started")
        try:
            previous = load_state(self.state_path)
            previous_sources = previous.get("sources", {}) if isinstance(previous, dict) else {}
            fetched_by_source: dict[str, list[GrantItem]] = {}
            errors: dict[str, str] = {}

            def run_parser(source_id: str) -> tuple[str, list[GrantItem]]:
                fetcher = Fetcher()
                parsed = PARSERS[source_id](fetcher)
                kept = [row for row in parsed if should_keep(row, started)]
                kept.sort(key=lambda row: row.published_dt, reverse=True)
                if not kept:
                    raise RuntimeError("filter returned zero application opportunities")
                return source_id, kept[:MAX_ITEMS_PER_SOURCE]

            with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
                futures = {pool.submit(run_parser, source_id): source_id for source_id in SOURCES}
                for future in as_completed(futures):
                    source_id = futures[future]
                    try:
                        _, rows = future.result()
                        fetched_by_source[source_id] = rows
                        logging.info("%s: %d filtered rows", source_id, len(rows))
                    except Exception as exc:  # noqa: BLE001 - source isolation is intentional
                        errors[source_id] = f"{type(exc).__name__}: {exc}"
                        logging.exception("%s list refresh failed", source_id)

            next_sources: dict[str, Any] = {}
            detail_jobs: list[GrantItem] = []
            previous_content: dict[str, GrantItem] = {}
            for source_data in previous_sources.values():
                for raw in source_data.get("items", []) if isinstance(source_data, dict) else []:
                    old = item_from_dict(raw)
                    if old:
                        previous_content[old.url] = old

            for source_id, spec in SOURCES.items():
                if source_id in fetched_by_source:
                    rows = fetched_by_source[source_id]
                    for row in rows:
                        old = previous_content.get(row.url)
                        if old and old.content_html:
                            row.content_html = old.content_html
                            if "..." in row.title and "..." not in old.title:
                                row.title = old.title
                        else:
                            detail_jobs.append(row)
                    next_sources[source_id] = {
                        "name": spec.name,
                        "last_success": started.isoformat(),
                        "error": None,
                        "items": [asdict(row) for row in rows],
                    }
                else:
                    old_source = previous_sources.get(source_id, {})
                    old_items = old_source.get("items", []) if isinstance(old_source, dict) else []
                    next_sources[source_id] = {
                        "name": spec.name,
                        "last_success": old_source.get("last_success"),
                        "error": errors.get(source_id, "unknown refresh failure"),
                        "items": old_items,
                    }

            def run_detail(row: GrantItem) -> GrantItem:
                return fetch_detail(Fetcher(), row)

            if detail_jobs:
                logging.info("fetching %d new detail pages", len(detail_jobs))
                with ThreadPoolExecutor(max_workers=7) as pool:
                    futures = {pool.submit(run_detail, row): row for row in detail_jobs}
                    for future in as_completed(futures):
                        row = futures[future]
                        try:
                            updated = future.result()
                            source_items = next_sources[updated.source_id]["items"]
                            for index, raw in enumerate(source_items):
                                if raw.get("url") == updated.url:
                                    source_items[index] = asdict(updated)
                                    break
                        except Exception as exc:  # noqa: BLE001
                            logging.warning("detail failed for %s: %s", row.url, exc)

            all_items: list[GrantItem] = []
            for source_data in next_sources.values():
                for raw in source_data.get("items", []):
                    row = item_from_dict(raw)
                    if row and should_keep(row, started):
                        all_items.append(row)
            all_items = dedupe_items(all_items)
            all_items.sort(key=lambda row: row.published_dt, reverse=True)

            health = {
                "ok": not errors,
                "service": APP_NAME,
                "updated_at": started.isoformat(),
                "items": len(all_items),
                "sources_ok": len(SOURCES) - len(errors),
                "sources_total": len(SOURCES),
                "sources": {
                    source_id: {
                        "name": data["name"],
                        "items": len(data.get("items", [])),
                        "last_success": data.get("last_success"),
                        "error": data.get("error"),
                    }
                    for source_id, data in next_sources.items()
                },
            }
            state = {"version": 1, "updated_at": started.isoformat(), "sources": next_sources}
            atomic_write(self.state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
            atomic_write(self.health_path, json.dumps(health, ensure_ascii=False, indent=2) + "\n")
            atomic_write(self.feed_path, build_feed(all_items, started, health))
            logging.info("refresh finished: %d items, %d source errors", len(all_items), len(errors))
            return health
        finally:
            self.lock.release()


class LocalFeedHandler(SimpleHTTPRequestHandler):
    server_version = "PaprGrantRSS/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        logging.info("http %s - %s", self.client_address[0], format_string % args)

    def do_GET(self) -> None:  # noqa: N802 - stdlib API
        if self.path.split("?", 1)[0] == "/health":
            health_path = Path(self.directory) / "health.json"
            try:
                payload = health_path.read_bytes()
            except OSError:
                payload = b'{"ok":false,"message":"health unavailable"}\n'
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.split("?", 1)[0] == "/":
            self.path = "/health.json"
        elif self.path.split("?", 1)[0] == "/funding.xml":
            self.path = "/funding.xml"
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def configure_logging(log_path: Path | None, verbose: bool = False) -> None:
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


def serve(data_dir: Path, host: str, port: int, refresh_hours: float, verbose: bool) -> int:
    data_dir.mkdir(parents=True, exist_ok=True)
    configure_logging(data_dir / "service.log", verbose)
    aggregator = GrantAggregator(data_dir)
    aggregator.refresh()

    stop_event = threading.Event()

    def refresh_loop() -> None:
        while not stop_event.wait(max(300.0, refresh_hours * 3600.0)):
            try:
                aggregator.refresh()
            except Exception:  # noqa: BLE001
                logging.exception("scheduled refresh crashed")

    thread = threading.Thread(target=refresh_loop, name="grant-rss-refresh", daemon=True)
    thread.start()
    handler = partial(LocalFeedHandler, directory=str(data_dir))
    server = ThreadingHTTPServer((host, port), handler)

    def stop_server(signum: int, _frame: Any) -> None:
        logging.info("received signal %s", signum)
        stop_event.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop_server)
    signal.signal(signal.SIGINT, stop_server)
    logging.info("serving %s on http://%s:%d/funding.xml", data_dir, host, port)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop_event.set()
        server.server_close()
    return 0


def once(data_dir: Path, verbose: bool) -> int:
    data_dir.mkdir(parents=True, exist_ok=True)
    configure_logging(None, verbose)
    health = GrantAggregator(data_dir).refresh()
    print(json.dumps(health, ensure_ascii=False, indent=2))
    return 0 if health.get("items", 0) > 0 else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("once", "serve"):
        sub = subparsers.add_parser(name)
        sub.add_argument("--data-dir", type=Path, required=True)
        sub.add_argument("--verbose", action="store_true")
        if name == "serve":
            sub.add_argument("--host", default="127.0.0.1")
            sub.add_argument("--port", type=int, default=8765)
            sub.add_argument("--refresh-hours", type=float, default=4.0)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "once":
        return once(args.data_dir.resolve(), args.verbose)
    return serve(
        args.data_dir.resolve(),
        args.host,
        args.port,
        args.refresh_hours,
        args.verbose,
    )


if __name__ == "__main__":
    raise SystemExit(main())
