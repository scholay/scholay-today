//! Public-source adapters for the local hot board. No account credentials,
//! browser cookies, third-party hosted aggregation API or remote JavaScript.
//! Adapted in part from MIT NewsNow / DailyHotApi: see THIRD_PARTY_HOTBOARD.md.

use crate::hot_board::{HotItem, HotSource};
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::{Client, RequestBuilder};
use scraper::{Html, Selector};
use serde_json::Value;
use std::{collections::HashSet, time::Duration};

const NEWSNOW: &str = "https://github.com/ourongxing/newsnow";
const DAILYHOT: &str = "https://github.com/imsyy/DailyHotApi";
const MAX_BYTES: usize = 4 * 1024 * 1024;
const AGENT: &str = "Mozilla/5.0 (compatible; PaprHotBoard/1.0; local personal news reader)";

/// A fixed allowlist, not arbitrary URLs supplied by a webpage or IPC caller.
pub fn sources() -> Vec<HotSource> {
    let rows = [
        ("baidu", "百度热搜", "china", "综合", "hot", "https://top.baidu.com/board?tab=realtime", "百度实时搜索榜，排除置顶推广。", "NewsNow", NEWSNOW),
        ("weibo", "微博热搜", "china", "综合", "hot", "https://s.weibo.com/top/summary", "公开热搜接口；不使用登录 Cookie，受限时保留上次缓存。", "DailyHotApi", DAILYHOT),
        ("zhihu", "知乎热榜", "china", "社区", "hot", "https://www.zhihu.com/hot", "知乎公开热门问题与平台热度。", "NewsNow", NEWSNOW),
        ("toutiao", "今日头条热榜", "china", "综合", "hot", "https://www.toutiao.com", "头条热点事件榜。", "NewsNow", NEWSNOW),
        ("tieba", "百度贴吧热议", "china", "社区", "hot", "https://tieba.baidu.com/hottopic/browse/hottopic", "贴吧热门讨论话题。", "NewsNow", NEWSNOW),
        ("bilibili-search", "哔哩哔哩热搜", "china", "生活", "hot", "https://search.bilibili.com", "全站热门搜索词，不等于视频播放榜。", "NewsNow", NEWSNOW),
        ("bilibili-popular", "哔哩哔哩热门视频", "china", "生活", "hot", "https://www.bilibili.com/v/popular/all", "平台热门视频，标注播放与点赞。", "NewsNow", NEWSNOW),
        ("bilibili-ranking", "哔哩哔哩全站排行", "china", "生活", "hot", "https://www.bilibili.com/v/popular/rank/all", "平台综合排行榜，与热门推荐分开。", "NewsNow", NEWSNOW),
        ("thepaper", "澎湃新闻热榜", "china", "综合", "hot", "https://www.thepaper.cn", "澎湃新闻热门阅读。", "NewsNow", NEWSNOW),
        ("qq-news", "腾讯新闻热点", "china", "综合", "hot", "https://news.qq.com", "腾讯新闻热点事件排行。", "DailyHotApi", DAILYHOT),
        ("netease-news", "网易新闻热榜", "china", "综合", "hot", "https://m.163.com/hot", "网易公开热点榜。", "DailyHotApi", DAILYHOT),
        ("wallstreetcn-hot", "华尔街见闻热门", "china", "财经", "hot", "https://wallstreetcn.com", "平台日榜；不构成投资建议。", "NewsNow", NEWSNOW),
        ("wallstreetcn-live", "华尔街见闻快讯", "china", "财经", "latest", "https://wallstreetcn.com/live/global", "全球市场快讯，按时间而非热度排列。", "NewsNow", NEWSNOW),
        ("36kr", "36氪人气榜", "china", "科技", "hot", "https://m.36kr.com/hot-list-m", "创业、科技与商业人气榜。", "DailyHotApi", DAILYHOT),
        ("juejin", "稀土掘金热门", "china", "科技", "hot", "https://juejin.cn/hot/articles", "开发者文章综合热榜。", "NewsNow", NEWSNOW),
        ("v2ex", "V2EX 今日热议", "china", "社区", "hot", "https://www.v2ex.com/?tab=hot", "V2EX 公开 hot API，不读取个人账户。", "DailyHotApi", DAILYHOT),
        ("sspai", "少数派热门", "china", "生活", "hot", "https://sspai.com", "数字生活热门文章标签。", "NewsNow", NEWSNOW),
        ("douban-movie", "豆瓣近期热门电影", "china", "生活", "hot", "https://movie.douban.com/explore", "近期热门电影与评分，不是实时票房榜。", "NewsNow", NEWSNOW),
        ("hupu", "虎扑步行街热帖", "china", "社区", "hot", "https://bbs.hupu.com/all-gambia", "虎扑步行街主干道热门讨论。", "DailyHotApi", DAILYHOT),
        ("acfun", "AcFun 今日视频榜", "china", "生活", "daily", "https://www.acfun.cn/rank/list/", "弹幕视频平台当日综合排行。", "DailyHotApi", DAILYHOT),
        ("smzdm", "什么值得买热门", "china", "生活", "hot", "https://post.smzdm.com/hot_1/", "消费经验文章热门榜，非购买推荐。", "NewsNow", NEWSNOW),
        ("ithome", "IT之家快讯", "china", "科技", "latest", "https://www.ithome.com", "官方公开 RSS，按发布时间排列，不冒充热度排名。", "NewsNow", NEWSNOW),
        ("solidot", "Solidot 科技快讯", "china", "科技", "latest", "https://www.solidot.org", "公开 RSS 科技新闻，按发布时间排列。", "NewsNow", NEWSNOW),
        ("hackernews", "Hacker News", "global", "科技", "hot", "https://news.ycombinator.com", "HN 首页社区排名，分数为平台投票。", "NewsNow", NEWSNOW),
        ("github", "GitHub Trending", "global", "科技", "daily", "https://github.com/trending", "GitHub 今日趋势；展示今日新增 Star 时明确标注。", "NewsNow", NEWSNOW),
        ("lobsters", "Lobsters 热门", "global", "科技", "hot", "https://lobste.rs", "独立技术社区首页热门，保持平台顺序。", "公开接口", "https://github.com/lobsters/lobsters"),
        ("mastodon-links", "Mastodon 热议新闻", "global", "社区", "hot", "https://mastodon.social/explore/links", "mastodon.social 实例分享增长的新闻链接；不代表整个联邦宇宙。", "Mastodon API", "https://docs.joinmastodon.org/methods/trends/"),
        ("mktnews", "MKTNews 全球市场快讯", "global", "财经", "latest", "https://mktnews.net", "全球市场即时快讯，按时间而非热度；不构成投资建议。", "NewsNow", NEWSNOW),
        ("steam", "Steam 在线游戏榜", "global", "生活", "hot", "https://store.steampowered.com/stats/stats/", "按当前在线人数的游戏榜，不是销量榜。", "NewsNow", NEWSNOW),
        ("dev", "DEV 周热门", "global", "科技", "hot", "https://dev.to/top/week", "过去七天开发者热门文章，不是实时全网排名。", "Forem API", "https://developers.forem.com/api/v1"),
        ("stackoverflow", "Stack Overflow 热门", "global", "科技", "hot", "https://stackoverflow.com/questions?tab=hot", "平台 hot 排序，热度与票数是不同指标。", "Stack Exchange API", "https://api.stackexchange.com/docs/questions"),
        ("google-us", "Google 美国趋势", "global", "综合", "hot", "https://trends.google.com/trending?geo=US", "美国近期热门搜索；来源为 Google Trends 公开 RSS。", "Google Trends", "https://trends.google.com/trending"),
        ("google-gb", "Google 英国趋势", "global", "综合", "hot", "https://trends.google.com/trending?geo=GB", "英国近期热门搜索。", "Google Trends", "https://trends.google.com/trending"),
        ("google-jp", "Google 日本趋势", "global", "综合", "hot", "https://trends.google.com/trending?geo=JP", "日本近期热门搜索，保留来源语言。", "Google Trends", "https://trends.google.com/trending"),
        ("google-sg", "Google 新加坡趋势", "global", "综合", "hot", "https://trends.google.com/trending?geo=SG", "新加坡近期热门搜索，保留来源语言。", "Google Trends", "https://trends.google.com/trending"),
        ("wikipedia-en", "英文维基百科阅读榜", "global", "综合", "daily", "https://en.wikipedia.org", "最近可用日的访问量榜，有一天以上延迟；不是实时热搜。", "Wikimedia Pageviews", "https://wikitech.wikimedia.org/wiki/Analytics/AQS/Pageviews"),
        ("wikipedia-zh", "中文维基百科阅读榜", "global", "综合", "daily", "https://zh.wikipedia.org", "最近可用日的中文百科访问量榜；日期以条目标注为准。", "Wikimedia Pageviews", "https://wikitech.wikimedia.org/wiki/Analytics/AQS/Pageviews"),
        ("producthunt", "Product Hunt 新品", "global", "科技", "latest", "https://www.producthunt.com", "公开新品 Feed；没有 API Token 时不声称是投票排行榜。", "NewsNow", NEWSNOW),
        ("producthunt-ranking", "Product Hunt 授权排行", "global", "科技", "hot", "https://www.producthunt.com", "需配置官方 API Token；当日（UTC）新品按平台 RANKING 排序。与无需登录的新品 Feed 分开。", "NewsNow", NEWSNOW),
        ("bbc-world", "BBC 全球快讯", "global", "综合", "latest", "https://www.bbc.com/news/world", "官方世界新闻 RSS，按发布时间排列。", "BBC RSS", "https://feeds.bbci.co.uk/news/world/rss.xml"),
        ("guardian-world", "The Guardian 全球快讯", "global", "综合", "latest", "https://www.theguardian.com/world", "官方世界新闻 RSS，按发布时间排列。", "Guardian RSS", "https://www.theguardian.com/world/rss"),
        ("nytimes-world", "纽约时报全球快讯", "global", "综合", "latest", "https://www.nytimes.com/section/world", "公开 RSS 标题；原文可能需要订阅，不绕过付费墙。", "NYTimes RSS", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
        ("theverge", "The Verge 科技快讯", "global", "科技", "latest", "https://www.theverge.com", "官方科技资讯 Feed，不代表热度排名。", "The Verge RSS", "https://www.theverge.com/rss/index.xml"),
        ("arstechnica", "Ars Technica 快讯", "global", "科技", "latest", "https://arstechnica.com", "官方科技、科学与文化 Feed。", "Ars Technica RSS", "https://feeds.arstechnica.com/arstechnica/index"),
    ];
    rows.into_iter()
        .map(
            |(id, name, region, category, kind, homepage, description, project, project_url)| {
                HotSource {
                    id: id.into(),
                    name: name.into(),
                    region: region.into(),
                    category: category.into(),
                    kind: kind.into(),
                    homepage: homepage.into(),
                    description: description.into(),
                    project: project.into(),
                    project_url: project_url.into(),
                    refresh_secs: if kind == "daily" { 3600 } else { 600 },
                    auth_kind: if id == "producthunt-ranking" {
                        Some("api_token".into())
                    } else {
                        None
                    },
                    auth_url: if id == "producthunt-ranking" {
                        Some("https://www.producthunt.com/v2/oauth/applications".into())
                    } else {
                        None
                    },
                }
            },
        )
        .collect()
}

fn s(v: &Value, key: &str) -> String {
    let value = if key.starts_with('/') {
        v.pointer(key)
    } else {
        v.get(key)
    };
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}
fn rows<'a>(v: &'a Value, path: &str) -> Result<&'a Vec<Value>, String> {
    (if path.is_empty() {
        Some(v)
    } else {
        v.pointer(path)
    })
    .and_then(Value::as_array)
    .ok_or_else(|| "平台响应结构发生变化，或当前需要登录。".into())
}
fn compact(text: &str, limit: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}
fn plain(html: &str) -> String {
    compact(
        &Html::parse_fragment(html)
            .root_element()
            .text()
            .collect::<String>(),
        1500,
    )
}
fn some(text: String) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
fn encode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}
fn item(id: String, title: String, url: String, description: String, heat: String) -> HotItem {
    HotItem {
        id,
        title: compact(&title, 600),
        url,
        description: some(compact(&description, 1500)),
        heat: some(compact(&heat, 120)),
        rank: 0,
        published_at: None,
    }
}
fn http_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "连接超时；可稍后刷新，原缓存不会删除。".into()
    } else {
        "网络连接失败；请检查网络或 scholay today 的代理设置。".into()
    }
}
async fn body(request: RequestBuilder) -> Result<Vec<u8>, String> {
    let mut response = request
        .header(reqwest::header::USER_AGENT, AGENT)
        .timeout(Duration::from_secs(18))
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        return Err(format!(
            "平台返回 HTTP {}，暂时无法更新。",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err("响应超过安全大小限制。".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        if data.len() + chunk.len() > MAX_BYTES {
            return Err("响应超过安全大小限制。".into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
async fn json(request: RequestBuilder) -> Result<Value, String> {
    serde_json::from_slice(&body(request).await?)
        .map_err(|_| "平台未返回公开 JSON 数据，可能需要登录或验证。".into())
}
async fn html(client: &Client, url: &str) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&body(client.get(url)).await?).into_owned())
}

/// Reject local/custom-scheme links even if the upstream response is compromised.
pub fn safe_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost"
        || host == "tauri.localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return false;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast())
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || ip.to_ipv4_mapped().is_some())
        }
        Err(_) => host.contains('.'),
    }
}
fn finish(items: Vec<HotItem>) -> Result<Vec<HotItem>, String> {
    let mut seen = HashSet::new();
    let mut result: Vec<_> = items
        .into_iter()
        .filter(|i| !i.title.is_empty() && safe_url(&i.url) && seen.insert(i.url.clone()))
        .take(50)
        .collect();
    if result.is_empty() {
        return Err("平台没有返回可用榜单；可能受访问限制或页面结构变化影响。".into());
    }
    for (index, value) in result.iter_mut().enumerate() {
        value.rank = index + 1;
        if value.id.is_empty() {
            value.id = value.url.clone();
        }
    }
    Ok(result)
}
fn selector(value: &str) -> Selector {
    Selector::parse(value).expect("static adapter selector")
}
fn links(document: &str, query: &str, base: &str) -> Vec<HotItem> {
    let doc = Html::parse_document(document);
    let origin = url::Url::parse(base).expect("static source URL");
    doc.select(&selector(query))
        .filter_map(|a| {
            let href = origin.join(a.value().attr("href")?).ok()?.to_string();
            Some(item(
                href.clone(),
                a.text().collect(),
                href,
                String::new(),
                String::new(),
            ))
        })
        .collect()
}
fn parse_feed(bytes: &[u8]) -> Result<Vec<HotItem>, String> {
    let feed = feed_rs::parser::parse(bytes)
        .map_err(|_| "无法解析公开 RSS / Atom，平台可能暂时受限。".to_string())?;
    Ok(feed
        .entries
        .into_iter()
        .filter_map(|entry| {
            let url = entry
                .links
                .iter()
                .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
                .or(entry.links.first())?
                .href
                .clone();
            let mut row = item(
                entry.id,
                entry.title.map(|x| x.content).unwrap_or_default(),
                url,
                entry.summary.map(|x| plain(&x.content)).unwrap_or_default(),
                String::new(),
            );
            row.published_at = entry.published.or(entry.updated).map(|x| x.to_rfc3339());
            Some(row)
        })
        .collect())
}

pub async fn fetch(client: &Client, source: &HotSource) -> Result<Vec<HotItem>, String> {
    let items = match source.id.as_str() {
        // Credentials are handled by the privileged hot_board command only.
        // Public diagnostics never read the user's Keychain.
        "producthunt-ranking" => {
            return Err("尚未配置 Product Hunt 接口授权；可在登录 / 授权中设置。".into())
        }
        "baidu" => {
            let text = html(client, "https://top.baidu.com/board?tab=realtime").await?;
            let payload = text
                .split_once("<!--s-data:")
                .and_then(|(_, tail)| tail.split_once("-->"))
                .map(|(data, _)| data)
                .ok_or("找不到百度公开榜单数据。")?;
            let data: Value = serde_json::from_str(payload).map_err(|_| "百度榜单格式变化。")?;
            rows(&data, "/data/cards/0/content")?
                .iter()
                .filter(|v| v.get("isTop").and_then(Value::as_bool) != Some(true))
                .map(|v| {
                    item(
                        s(v, "word"),
                        s(v, "word"),
                        s(v, "rawUrl"),
                        s(v, "desc"),
                        format!("{} 搜索指数", s(v, "hotScore")),
                    )
                })
                .collect()
        }
        "weibo" => {
            let data = json(
                client
                    .get("https://weibo.com/ajax/side/hotSearch")
                    .header("Referer", "https://weibo.com/"),
            )
            .await?;
            rows(&data, "/data/realtime")?
                .iter()
                .filter(|v| v.get("is_ad").and_then(Value::as_u64).unwrap_or(0) == 0)
                .map(|v| {
                    let title = s(v, "word");
                    item(
                        title.clone(),
                        title.clone(),
                        format!("https://s.weibo.com/weibo?q={}", encode(&title)),
                        String::new(),
                        some(s(v, "num"))
                            .map(|n| format!("{n} 热度"))
                            .unwrap_or_default(),
                    )
                })
                .collect()
        }
        "zhihu" => {
            let data = json(client.get(
                "https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=50&desktop=true",
            ))
            .await?;
            rows(&data, "/data")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "/target/link/url"),
                        s(v, "/target/title_area/text"),
                        s(v, "/target/link/url"),
                        s(v, "/target/excerpt_area/text"),
                        s(v, "/target/metrics_area/text"),
                    )
                })
                .collect()
        }
        "toutiao" => {
            let data =
                json(client.get("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc"))
                    .await?;
            rows(&data, "/data")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "ClusterIdStr"),
                        s(v, "Title"),
                        format!("https://www.toutiao.com/trending/{}/", s(v, "ClusterIdStr")),
                        String::new(),
                        format!("{} 热度", s(v, "HotValue")),
                    )
                })
                .collect()
        }
        "tieba" => {
            let data =
                json(client.get("https://tieba.baidu.com/hottopic/browse/topicList")).await?;
            rows(&data, "/data/bang_topic/topic_list")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "topic_id"),
                        s(v, "topic_name"),
                        s(v, "topic_url").replace("&amp;", "&"),
                        s(v, "topic_desc"),
                        String::new(),
                    )
                })
                .collect()
        }
        "bilibili-search" => {
            let data =
                json(client.get("https://s.search.bilibili.com/main/hotword?limit=30")).await?;
            rows(&data, "/list")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "keyword"),
                        s(v, "show_name"),
                        format!(
                            "https://search.bilibili.com/all?keyword={}",
                            encode(&s(v, "keyword"))
                        ),
                        String::new(),
                        String::new(),
                    )
                })
                .collect()
        }
        "bilibili-popular" | "bilibili-ranking" => {
            let endpoint = if source.id == "bilibili-ranking" {
                "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all"
            } else {
                "https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1"
            };
            let data = json(
                client
                    .get(endpoint)
                    .header("Referer", "https://www.bilibili.com/"),
            )
            .await?;
            rows(&data, "/data/list")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "bvid"),
                        s(v, "title"),
                        format!("https://www.bilibili.com/video/{}", s(v, "bvid")),
                        s(v, "desc"),
                        format!("{} 播放 · {} 点赞", s(v, "/stat/view"), s(v, "/stat/like")),
                    )
                })
                .collect()
        }
        "thepaper" => {
            let data =
                json(client.get("https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar"))
                    .await?;
            rows(&data, "/data/hotNews")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "contId"),
                        s(v, "name"),
                        format!(
                            "https://www.thepaper.cn/newsDetail_forward_{}",
                            s(v, "contId")
                        ),
                        String::new(),
                        String::new(),
                    )
                })
                .collect()
        }
        "qq-news" => {
            let data =
                json(client.get("https://r.inews.qq.com/gw/event/hot_ranking_list?page_size=50"))
                    .await?;
            rows(&data, "/idlist/0/newslist")?
                .iter()
                .filter(|v| {
                    v.get("hotEvent").is_some_and(Value::is_object)
                        && !s(v, "id").is_empty()
                        && !s(v, "title").is_empty()
                })
                .map(|v| {
                    item(
                        s(v, "id"),
                        s(v, "title"),
                        format!("https://new.qq.com/rain/a/{}", s(v, "id")),
                        s(v, "abstract"),
                        some(s(v, "/hotEvent/hotScore"))
                            .map(|h| format!("{h} 热度"))
                            .unwrap_or_default(),
                    )
                })
                .collect()
        }
        "netease-news" => {
            let data = json(client.get("https://m.163.com/fe/api/hot/news/flow")).await?;
            rows(&data, "/data/list")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "docid"),
                        s(v, "title"),
                        format!("https://www.163.com/dy/article/{}.html", s(v, "docid")),
                        s(v, "source"),
                        String::new(),
                    )
                })
                .collect()
        }
        "wallstreetcn-hot" | "wallstreetcn-live" => {
            let (endpoint, path) = if source.id.ends_with("hot") {
                (
                    "https://api-one.wallstcn.com/apiv1/content/articles/hot?period=all",
                    "/data/day_items",
                )
            } else {
                ("https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30","/data/items")
            };
            let data = json(client.get(endpoint)).await?;
            rows(&data, path)?
                .iter()
                .map(|v| {
                    let title = some(s(v, "title")).unwrap_or_else(|| s(v, "content_text"));
                    let mut result = item(
                        s(v, "id"),
                        title,
                        s(v, "uri"),
                        s(v, "content_short"),
                        String::new(),
                    );
                    result.published_at = v
                        .get("display_time")
                        .and_then(Value::as_i64)
                        .and_then(|n| chrono::DateTime::from_timestamp(n, 0))
                        .map(|n| n.to_rfc3339());
                    result
                })
                .collect()
        }
        "36kr" => {
            let data=json(client.post("https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot").json(&serde_json::json!({"partner_id":"wap","param":{"siteId":1,"platformId":2},"timestamp":Utc::now().timestamp_millis()}))).await?;
            rows(&data, "/data/hotRankList")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "itemId"),
                        s(v, "/templateMaterial/widgetTitle"),
                        format!("https://www.36kr.com/p/{}", s(v, "itemId")),
                        s(v, "/templateMaterial/authorName"),
                        String::new(),
                    )
                })
                .collect()
        }
        "juejin" => {
            let data=json(client.get("https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot&spider=0")).await?;
            rows(&data, "/data")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "/content/content_id"),
                        s(v, "/content/title"),
                        format!("https://juejin.cn/post/{}", s(v, "/content/content_id")),
                        String::new(),
                        String::new(),
                    )
                })
                .collect()
        }
        "v2ex" => {
            let data = json(client.get("https://www.v2ex.com/api/topics/hot.json")).await?;
            rows(&data, "")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "id"),
                        s(v, "title"),
                        s(v, "url"),
                        s(v, "content"),
                        format!("{} 回复", s(v, "replies")),
                    )
                })
                .collect()
        }
        "sspai" => {
            let endpoint=format!("https://sspai.com/api/v1/article/tag/page/get?limit=30&offset=0&created_at={}&tag=%E7%83%AD%E9%97%A8%E6%96%87%E7%AB%A0&released=false",Utc::now().timestamp_millis());
            let data = json(client.get(endpoint)).await?;
            rows(&data, "/data")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "id"),
                        s(v, "title"),
                        format!("https://sspai.com/post/{}", s(v, "id")),
                        s(v, "summary"),
                        String::new(),
                    )
                })
                .collect()
        }
        "douban-movie" => {
            let data = json(
                client
                    .get("https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie")
                    .header("Referer", "https://movie.douban.com/"),
            )
            .await?;
            rows(&data, "/items")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "id"),
                        s(v, "title"),
                        format!("https://movie.douban.com/subject/{}/", s(v, "id")),
                        s(v, "card_subtitle"),
                        some(s(v, "/rating/value"))
                            .map(|h| format!("豆瓣 {h} 分"))
                            .unwrap_or_default(),
                    )
                })
                .collect()
        }
        "hupu" => {
            let data =
                json(client.get("https://m.hupu.com/api/v2/bbs/topicThreads?topicId=1&page=1"))
                    .await?;
            rows(&data, "/data/topicThreads")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "tid"),
                        s(v, "title"),
                        format!("https://bbs.hupu.com/{}.html", s(v, "tid")),
                        String::new(),
                        format!("{} 回复", s(v, "replies")),
                    )
                })
                .collect()
        }
        "acfun" => {
            let data=json(client.get("https://www.acfun.cn/rest/pc-direct/rank/channel?channelId=&rankLimit=30&rankPeriod=DAY").header("Referer","https://www.acfun.cn/rank/list/")).await?;
            rows(&data, "/rankList")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "dougaId"),
                        some(s(v, "contentTitle")).unwrap_or_else(|| s(v, "title")),
                        format!("https://www.acfun.cn/v/ac{}", s(v, "dougaId")),
                        s(v, "contentDesc"),
                        format!("{} 点赞", s(v, "likeCount")),
                    )
                })
                .collect()
        }
        "smzdm" => links(
            &html(client, "https://post.smzdm.com/hot_1/").await?,
            "#feed-main-list .z-feed-title a",
            "https://post.smzdm.com",
        ),
        "hackernews" => parse_hackernews(&html(client, "https://news.ycombinator.com/").await?),
        "github" => parse_github(&html(client, "https://github.com/trending?since=daily").await?),
        "lobsters" => {
            let data = json(client.get("https://lobste.rs/hottest.json")).await?;
            rows(&data, "")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "short_id"),
                        s(v, "title"),
                        s(v, "comments_url"),
                        s(v, "description_plain"),
                        format!("{} 分 · {} 评论", s(v, "score"), s(v, "comment_count")),
                    )
                })
                .collect()
        }
        "mastodon-links" => {
            let data =
                json(client.get("https://mastodon.social/api/v1/trends/links?limit=20")).await?;
            rows(&data, "")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "url"),
                        s(v, "title"),
                        s(v, "url"),
                        s(v, "description"),
                        some(s(v, "/history/0/accounts"))
                            .map(|h| format!("{h} 账户今日分享"))
                            .unwrap_or_default(),
                    )
                })
                .collect()
        }
        "mktnews" => {
            let data = json(
                client
                    .get("https://api.mktnews.net/api/flash?type=0&limit=50")
                    .header("Origin", "https://mktnews.net")
                    .header("Referer", "https://mktnews.net/"),
            )
            .await?;
            rows(&data, "/data")?
                .iter()
                .map(|v| {
                    let mut row = item(
                        s(v, "id"),
                        some(s(v, "/data/title")).unwrap_or_else(|| s(v, "/data/content")),
                        format!("https://mktnews.net/flashDetail.html?id={}", s(v, "id")),
                        s(v, "/data/content"),
                        String::new(),
                    );
                    row.published_at = some(s(v, "time"));
                    row
                })
                .collect()
        }
        "steam" => {
            let text = html(client, "https://store.steampowered.com/stats/stats/").await?;
            let doc = Html::parse_document(&text);
            doc.select(&selector("#detailStats tr.player_count_row"))
                .filter_map(|row| {
                    let a = row.select(&selector("a.gameLink")).next()?;
                    let url = a.value().attr("href")?.to_string();
                    let heat = row
                        .select(&selector("td:first-child .currentServers"))
                        .next()?
                        .text()
                        .collect::<String>();
                    Some(item(
                        url.clone(),
                        a.text().collect(),
                        url,
                        String::new(),
                        format!("{} 人在线", compact(&heat, 60)),
                    ))
                })
                .collect()
        }
        "dev" => {
            let data = json(client.get("https://dev.to/api/articles?top=7&per_page=30")).await?;
            rows(&data, "")?
                .iter()
                .map(|v| {
                    let mut row = item(
                        s(v, "id"),
                        s(v, "title"),
                        s(v, "url"),
                        s(v, "description"),
                        format!(
                            "{} 互动 · {} 评论",
                            s(v, "public_reactions_count"),
                            s(v, "comments_count")
                        ),
                    );
                    row.published_at = some(s(v, "published_at"));
                    row
                })
                .collect()
        }
        "stackoverflow" => {
            let data=json(client.get("https://api.stackexchange.com/2.3/questions?order=desc&sort=hot&site=stackoverflow&pagesize=30")).await?;
            if data.get("backoff").is_some() {
                return Err("Stack Exchange 要求退避，稍后再刷新。".into());
            }
            rows(&data, "/items")?
                .iter()
                .map(|v| {
                    item(
                        s(v, "question_id"),
                        plain(&s(v, "title")),
                        s(v, "link"),
                        String::new(),
                        format!("{} 票 · {} 回答", s(v, "score"), s(v, "answer_count")),
                    )
                })
                .collect()
        }
        "wikipedia-en" | "wikipedia-zh" => {
            wikipedia(
                client,
                if source.id.ends_with("zh") {
                    "zh"
                } else {
                    "en"
                },
            )
            .await?
        }
        "google-us" | "google-gb" | "google-jp" | "google-sg" => {
            let geo = source.id.trim_start_matches("google-").to_ascii_uppercase();
            parse_google(
                &body(client.get(format!("https://trends.google.com/trending/rss?geo={geo}")))
                    .await?,
                &geo,
            )?
        }
        other => {
            let endpoint = match other {
                "ithome" => "https://www.ithome.com/rss/",
                "solidot" => "https://www.solidot.org/index.rss",
                "producthunt" => "https://www.producthunt.com/feed",
                "bbc-world" => "https://feeds.bbci.co.uk/news/world/rss.xml",
                "guardian-world" => "https://www.theguardian.com/world/rss",
                "nytimes-world" => "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
                "theverge" => "https://www.theverge.com/rss/index.xml",
                "arstechnica" => "https://feeds.arstechnica.com/arstechnica/index",
                _ => return Err("未知热榜来源。".into()),
            };
            parse_feed(&body(client.get(endpoint)).await?)?
        }
    };
    finish(items)
}

fn parse_hackernews(text: &str) -> Vec<HotItem> {
    let doc = Html::parse_document(text);
    doc.select(&selector("tr.athing"))
        .filter_map(|row| {
            let id = row.value().attr("id")?;
            let title = row
                .select(&selector(".titleline > a"))
                .next()?
                .text()
                .collect();
            let heat = doc
                .select(&selector(&format!("#score_{id}")))
                .next()
                .map(|n| n.text().collect())
                .unwrap_or_default();
            Some(item(
                id.into(),
                title,
                format!("https://news.ycombinator.com/item?id={id}"),
                String::new(),
                heat,
            ))
        })
        .collect()
}
fn parse_google(bytes: &[u8], geo: &str) -> Result<Vec<HotItem>, String> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut items = Vec::new();
    let mut current: Option<HotItem> = None;
    let mut field = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                field = String::from_utf8_lossy(tag.name().as_ref()).into_owned();
                if field == "item" {
                    current = Some(item(
                        String::new(),
                        String::new(),
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                }
            }
            Ok(Event::Text(value)) => {
                let value = value
                    .unescape()
                    .map_err(|_| "Google 趋势文本解析失败。")?
                    .into_owned();
                if let Some(row) = current.as_mut() {
                    match field.as_str() {
                        "title" => row.title = compact(&value, 600),
                        "ht:approx_traffic" => row.heat = Some(format!("{value} 搜索量")),
                        "ht:news_item_url" if row.url.is_empty() => row.url = value,
                        "ht:news_item_title" if row.description.is_none() => {
                            row.description = Some(format!("相关报道：{}", compact(&value, 1200)))
                        }
                        "pubDate" => {
                            row.published_at = chrono::DateTime::parse_from_rfc2822(&value)
                                .ok()
                                .map(|d| d.to_rfc3339())
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(tag)) => {
                if tag.name().as_ref() == b"item" {
                    if let Some(mut row) = current.take() {
                        row.id = format!("{geo}:{}", row.title);
                        // A trend with no linked article still has a distinct
                        // public search, rather than the identical RSS URL.
                        if !safe_url(&row.url) {
                            row.url =
                                format!("https://www.google.com/search?q={}", encode(&row.title));
                        }
                        items.push(row);
                    }
                }
                field.clear();
            }
            Ok(Event::DocType(_)) => return Err("不接受带文档实体的趋势 Feed。".into()),
            Ok(Event::Eof) => break,
            Err(_) => return Err("Google 趋势 RSS 结构变化。".into()),
            _ => {}
        }
    }
    Ok(items)
}
fn parse_github(text: &str) -> Vec<HotItem> {
    let doc = Html::parse_document(text);
    doc.select(&selector("article.Box-row"))
        .filter_map(|row| {
            let a = row.select(&selector("h2 a")).next()?;
            let path = a.value().attr("href")?;
            let description = row
                .select(&selector("p"))
                .next()
                .map(|n| n.text().collect())
                .unwrap_or_default();
            let heat = row
                .select(&selector("span.d-inline-block.float-sm-right"))
                .next()
                .map(|n| n.text().collect())
                .unwrap_or_default();
            Some(item(
                path.into(),
                a.text().collect(),
                format!("https://github.com{path}"),
                description,
                heat,
            ))
        })
        .collect()
}
async fn wikipedia(client: &Client, language: &str) -> Result<Vec<HotItem>, String> {
    let mut last_error = "维基百科还没有可用的每日榜单。".to_string();
    // AQS publishes yesterday asynchronously. At most one older-day fallback;
    // every item records the actual statistical day, not the fetch time.
    for days in [1, 2] {
        let date = Utc::now().date_naive() - ChronoDuration::days(days);
        let endpoint=format!("https://wikimedia.org/api/rest_v1/metrics/pageviews/top/{language}.wikipedia.org/all-access/{}",date.format("%Y/%m/%d"));
        match json(client.get(endpoint)).await {
            Ok(data) => {
                let result = rows(&data, "/items/0/articles")?
                    .iter()
                    .filter(|v| {
                        let title = s(v, "article");
                        !title.contains(':')
                            && !matches!(title.as_str(), "Main_Page" | "首页" | "Wikipedia")
                    })
                    .take(30)
                    .map(|v| {
                        let title = s(v, "article");
                        let mut row = item(
                            title.clone(),
                            title.replace('_', " "),
                            format!("https://{language}.wikipedia.org/wiki/{}", encode(&title)),
                            format!("统计日期：{date}（UTC）；每日榜，有发布延迟。"),
                            format!("{} 次访问", s(v, "views")),
                        );
                        row.published_at = Some(format!("{date}T00:00:00Z"));
                        row
                    })
                    .collect();
                return Ok(result);
            }
            Err(error) => {
                if !error.contains("404") {
                    return Err(error);
                }
                last_error = error;
            }
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_is_unique_public_and_honest() {
        let all = sources();
        let mut ids = HashSet::new();
        assert!(all.len() >= 35);
        assert!(all.iter().filter(|s| s.region == "china").count() >= 20);
        assert!(all.iter().filter(|s| s.region == "global").count() >= 15);
        for s in all {
            assert!(ids.insert(s.id));
            assert!(safe_url(&s.homepage));
            assert!(!s.description.is_empty());
            assert!(matches!(s.kind.as_str(), "hot" | "latest" | "daily"));
            assert!(s.refresh_secs >= 600);
        }
    }
    #[test]
    fn rejects_private_or_executable_links() {
        for url in [
            "javascript:alert(1)",
            "file:///tmp/x",
            "https://u:p@example.com",
            "http://localhost:9999",
            "http://127.0.0.1",
            "http://10.0.0.1",
            "http://[::1]",
            "http://[::ffff:127.0.0.1]",
            "http://[fc00::1]",
            "http://192.168.2.1",
            "https://tauri.localhost/",
        ] {
            assert!(!safe_url(url), "{url}");
        }
        assert!(safe_url("https://www.zhihu.com/question/123"));
    }
    #[test]
    fn normalizes_deduplicates_and_does_not_claim_empty_success() {
        let a = item(
            "1".into(),
            "hello".into(),
            "https://example.com/1".into(),
            String::new(),
            String::new(),
        );
        let result = finish(vec![a.clone(), a]).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].rank, 1);
        assert!(finish(vec![]).is_err());
    }
    #[test]
    fn github_and_hn_use_platform_order_and_metrics() {
        let gh = parse_github(
            r#"<article class="Box-row"><h2><a href="/owner/repo">owner / repo</a></h2><p>A test</p><span class="d-inline-block float-sm-right">100 stars today</span></article>"#,
        );
        assert_eq!(gh[0].url, "https://github.com/owner/repo");
        assert_eq!(gh[0].heat.as_deref(), Some("100 stars today"));
        let hn = parse_hackernews(
            r#"<table><tr class="athing" id="12"><td><span class="titleline"><a href="https://external.test">A &amp; B</a></span></td></tr><tr><td><span id="score_12">42 points</span></td></tr></table>"#,
        );
        assert_eq!(hn[0].title, "A & B");
        assert_eq!(hn[0].url, "https://news.ycombinator.com/item?id=12");
    }
    #[test]
    fn feed_preserves_time_and_plaintext_without_scripts() {
        let xml=br#"<rss version="2.0"><channel><title>Test</title><link>https://example.com</link><description>Test</description><item><title>A</title><link>https://example.com/a</link><pubDate>Mon, 31 Aug 2026 00:00:00 GMT</pubDate><description>&lt;b&gt;Body&lt;/b&gt;</description></item></channel></rss>"#;
        let result = parse_feed(xml).unwrap();
        assert_eq!(result[0].description.as_deref(), Some("Body"));
        assert!(result[0]
            .published_at
            .as_ref()
            .unwrap()
            .starts_with("2026-08-31"));
    }
    #[test]
    fn google_trends_uses_distinct_related_news_not_identical_feed_links() {
        let xml=br#"<rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item><title>First &amp; One</title><link>https://trends.google.com/trending/rss?geo=US</link><ht:approx_traffic>1000+</ht:approx_traffic><ht:news_item><ht:news_item_title>A report</ht:news_item_title><ht:news_item_url>https://example.com/a</ht:news_item_url></ht:news_item></item><item><title>Second</title><link>https://trends.google.com/trending/rss?geo=US</link></item></channel></rss>"#;
        let items = finish(parse_google(xml, "US").unwrap()).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "First & One");
        assert_eq!(items[0].url, "https://example.com/a");
        assert!(items[1].url.contains("q=Second"));
    }
    /// Explicitly opt-in diagnostic. Only public fixed endpoints; no Papr DB,
    /// credentials or user browser state. Run with --ignored --nocapture.
    #[tokio::test]
    #[ignore]
    async fn live_public_sources() {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(7))
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        for batch in sources().chunks(4) {
            let mut tasks = tokio::task::JoinSet::new();
            for source in batch {
                let client = client.clone();
                let source = source.clone();
                tasks.spawn(async move {
                    let start=std::time::Instant::now();
                    let result=fetch(&client,&source).await;
                    println!("PAPR_HOTBOARD {}",serde_json::json!({"id":source.id,"region":source.region,"kind":source.kind,"checked_at":Utc::now().to_rfc3339(),"seconds":start.elapsed().as_secs_f64(),"count":result.as_ref().map(|x|x.len()).unwrap_or(0),"error":result.as_ref().err(),"first_url":result.as_ref().ok().and_then(|x|x.first()).map(|x|&x.url)}));
                });
            }
            while let Some(result) = tasks.join_next().await {
                result.unwrap();
            }
        }
    }
}
