import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from conference_rss import Cache, ccf_asset, cssn_endpoint, event, parse_ccf, parse_chemsoc, parse_cssn, parse_sciencenet, rss_bytes, safe_url


class ConferenceTests(unittest.TestCase):
    def test_sciencenet_cards_deduplicate_and_keep_image(self):
        page = '''<dl><dt><a href="https://example.org/cfp">测试会议</a></dt>
          <dd>2026-10-01~2026-10-03<br>北京</dd><img src="/logo.jpg"></dl>
          <dl><dt><a href="https://example.org/cfp">测试...</a></dt><dd>2026-10-01~2026-10-03</dd></dl>
          <dl><dt><a href="/ad">软件培训</a></dt><dd>2026-10-01~2026-10-03</dd></dl>'''
        items = parse_sciencenet(page)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["location"], "北京")
        self.assertEqual(items[0]["image"], "https://meeting.sciencenet.cn/logo.jpg")

    def test_chemsoc_preserves_dates_and_resolves_relative_path(self):
        card = '''<li><a class="metting-title" href="./m667">分析化学年会</a>
          <span class="meeting-time">2026年9月18日-21日</span><span class="metting-address">长沙</span></li>'''
        items = parse_chemsoc(card * 2)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["url"], "https://www.chemsoc.org.cn/meeting/home/m667")
        self.assertEqual(items[0]["meeting_date"], "2026年9月18日-21日")

    def test_cssn_publication_date_not_conference_date(self):
        rows = {"datas": [{"name": "研讨会举行", "pubUrl": "http://www.cssn.cn/a/t20260622_123.shtml",
                           "start_date": {"fullDate": "2026年6月18日"}, "end_date": {"fullDate": "2026年6月18日"},
                           "imgUrl": "http://www.cssn.cn/a.jpg", "city": "北京"}]}
        item = parse_cssn(rows)[0]
        self.assertEqual(item["published"], "2026-06-22T00:00:00+00:00")
        self.assertEqual(item["meeting_date"], "2026年6月18日")
        self.assertEqual(parse_cssn({"datas": [{"name": "Missing URL"}]}), [])

    def test_endpoint_uses_active_public_config_and_restricts_host(self):
        page = '// var getUrl = "http://test.invalid/";\n var getUrl = "/was5/web/search?token=public&channelid=1";'
        self.assertTrue(cssn_endpoint(page).startswith("https://www.cssn.cn/was5/web/search?"))
        self.assertIn("pageSize=40", cssn_endpoint(page))
        with self.assertRaises(ValueError):
            cssn_endpoint('var getUrl = "https://evil.test/was5/web/search";')

    def test_ccf_pairs_observed_routes_with_exact_titles(self):
        page = '<article class="article"><div class="title">第四十六期 物理人工智能</div><span class="author">2026年8月15日至8月17日</span></article>'
        script = '["/posts/calendar/46.html",{loader:()=>b(()=>import("./46.js"),[]),meta:{_blog:{title:"第四十六期 物理人工智能",cover:"/undefined"}}]'
        self.assertEqual(parse_ccf(page, script)[0]["url"], "https://bls.ccf.org.cn/posts/calendar/46.html")
        self.assertEqual(parse_ccf(page, ""), [])
        self.assertEqual(ccf_asset('<link rel="modulepreload" href="/assets/app-123.js">'), "https://bls.ccf.org.cn/assets/app-123.js")
        with self.assertRaises(ValueError):
            ccf_asset('<link rel="modulepreload" href="https://evil.test/assets/app-123.js">')

    def test_urls(self):
        for invalid in ["", "javascript:alert(1)", "data:image/svg+xml,abc", "https://user:pass@example.org"]:
            self.assertEqual(safe_url(invalid, "https://example.org/"), "")

    def test_cache_keeps_last_good_data_and_stable_first_seen_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            item = event("安全 & <标题>", "https://example.org/cfp", "https://example.org", image="https://example.org/a.jpg", meeting_date="2028-01-01")
            cache.update("ccf", lambda _: [dict(item)])
            first_seen = cache.records["ccf"]["items"][0]["first_seen"]
            xml = rss_bytes("ccf", cache.records["ccf"])
            parsed = ET.fromstring(xml)
            self.assertEqual(parsed.findtext("channel/item/title"), "安全 & <标题>")
            self.assertIn('<img src="https://example.org/a.jpg"', parsed.findtext("channel/item/description"))
            self.assertNotIn("2028", parsed.findtext("channel/item/pubDate"))
            cache.update("ccf", lambda _: [])
            self.assertEqual(cache.health()["ccf"]["count"], 1)
            self.assertIsNotNone(cache.health()["ccf"]["error"])
            self.assertEqual(rss_bytes("ccf", cache.records["ccf"]), xml)
            cache.update("ccf", lambda _: [dict(item)])
            self.assertEqual(cache.records["ccf"]["items"][0]["first_seen"], first_seen)
            self.assertIsNone(cache.health()["ccf"]["error"])
            self.assertEqual(Cache(directory).health()["ccf"]["count"], 1)

    def test_initial_failure_does_not_create_fake_empty_success(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            cache.update("ccf", lambda _: [])
            self.assertIsNone(cache.health()["ccf"]["success_at"])
            self.assertEqual(cache.health()["ccf"]["count"], 0)
            self.assertTrue(Path(directory, "cache.json").exists())


if __name__ == "__main__":
    unittest.main()
