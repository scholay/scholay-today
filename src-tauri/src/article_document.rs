//! Deterministic HTML → structured article. No AI/network/filesystem here.
use ego_tree::NodeRef;
use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};

pub const DOCUMENT_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub kind: String,
    pub markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// Markdown container prefixes keep lists/quotes around every child block,
    /// including images. Old captures deserialize with no container metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_prefix: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub original_url: String,
    pub alt: String,
    pub caption: String,
    pub status: String,
    pub path: Option<String>,
    pub sha256: Option<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub schema_version: u32,
    pub capture_id: String,
    pub article_id: i64,
    pub title: String,
    pub source_url: String,
    pub captured_at: String,
    pub source_kind: String,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub truncated: bool,
    pub blocks: Vec<Block>,
    pub assets: Vec<Asset>,
    pub warnings: Vec<String>,
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('*', "\\*")
        .replace('`', "\\`")
}
fn link(raw: &str, base: &str) -> Option<String> {
    let u = url::Url::parse(base).ok()?.join(raw).ok()?;
    if matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none() {
        Some(u.to_string())
    } else {
        None
    }
}
fn push(doc: &mut Document, kind: &str, buffer: &mut String, level: Option<usize>) {
    let value = buffer.trim().to_owned();
    buffer.clear();
    if !value.is_empty() {
        doc.blocks.push(Block {
            id: format!("b{}", doc.blocks.len() + 1),
            kind: kind.into(),
            markdown: value,
            level,
            asset_id: None,
            prefix: None,
            continuation_prefix: None,
        });
    }
}

fn container_prefix(doc: &mut Document, start: usize, first: &str, rest: &str) {
    for (index, block) in doc.blocks[start..].iter_mut().enumerate() {
        block.prefix = Some(format!("{}{}", if index == 0 { first } else { rest }, block.prefix.as_deref().unwrap_or("")));
        block.continuation_prefix = Some(format!("{rest}{}", block.continuation_prefix.as_deref().unwrap_or("")));
    }
}

fn list_marker(node: NodeRef<'_, Node>) -> String {
    let Some(parent) = node.parent().and_then(ElementRef::wrap) else { return "- ".into() };
    if parent.value().name() != "ol" { return "- ".into(); }
    let reversed = parent.value().attr("reversed").is_some();
    let mut number = parent.value().attr("start").and_then(|s| s.parse::<i64>().ok()).unwrap_or_else(|| {
        if reversed { parent.children().filter_map(ElementRef::wrap).filter(|e| e.value().name() == "li").count() as i64 } else { 1 }
    });
    for sibling in parent.children().filter_map(ElementRef::wrap).filter(|e| e.value().name() == "li") {
        if let Some(value) = sibling.value().attr("value").and_then(|s| s.parse::<i64>().ok()) { number = value; }
        if sibling.id() == node.id() { break; }
        number = number.saturating_add(if reversed { -1 } else { 1 });
    }
    format!("{number}. ")
}

fn walk(node: NodeRef<'_, Node>, doc: &mut Document, buffer: &mut String, depth: usize) {
    if depth > 80 || doc.blocks.len() > 6000 {
        doc.truncated = true;
        return;
    }
    match node.value() {
        Node::Text(t) => {
            if t.text.starts_with(char::is_whitespace) && !buffer.ends_with(char::is_whitespace) {
                buffer.push(' ');
            }
            buffer.push_str(&escape(
                &t.text.split_whitespace().collect::<Vec<_>>().join(" "),
            ));
            if t.text.ends_with(char::is_whitespace) && !buffer.ends_with(char::is_whitespace) {
                buffer.push(' ');
            }
        }
        Node::Element(el) => {
            let tag = el.name();
            if matches!(
                tag,
                "script"
                    | "style"
                    | "noscript"
                    | "template"
                    | "iframe"
                    | "object"
                    | "embed"
                    | "input"
                    | "textarea"
                    | "select"
                    | "button"
                    | "form"
                    | "nav"
                    | "aside"
                    | "footer"
            ) || el.attr("hidden").is_some()
                || el.attr("aria-hidden") == Some("true")
                || el.attr("role").is_some_and(|role| matches!(role, "navigation" | "banner" | "complementary"))
                || el.attr("style").is_some_and(|style| style.split(';').any(|rule| {
                    rule.split_once(':').is_some_and(|(key, value)| {
                        let value = value.trim().trim_end_matches("!important").trim();
                        (key.trim().eq_ignore_ascii_case("display") && value.eq_ignore_ascii_case("none"))
                            || (key.trim().eq_ignore_ascii_case("visibility") && value.eq_ignore_ascii_case("hidden"))
                    })
                }))
            {
                return;
            }
            if tag == "li" || tag == "blockquote" {
                push(doc, "paragraph", buffer, None);
                let start = doc.blocks.len();
                for child in node.children() { walk(child, doc, buffer, depth + 1); }
                push(doc, "paragraph", buffer, None);
                if tag == "blockquote" {
                    container_prefix(doc, start, "> ", "> ");
                } else {
                    let marker = list_marker(node);
                    container_prefix(doc, start, &marker, &" ".repeat(marker.len()));
                }
                return;
            }
            if tag == "img" {
                push(doc, "paragraph", buffer, None);
                if let Some(url) = el
                    .attr("data-src")
                    .or_else(|| el.attr("data-original"))
                    .or_else(|| el.attr("data-lazy-src"))
                    .or_else(|| el.attr("original"))
                    .or_else(|| el.attr("src"))
                    .and_then(|u| link(u, &doc.source_url))
                {
                    if doc.assets.len() >= 40 {
                        doc.truncated = true;
                        return;
                    }
                    let id = format!("image-{}", doc.assets.len() + 1);
                    let alt = el.attr("alt").unwrap_or("").to_string();
                    let caption = node
                        .ancestors()
                        .filter_map(ElementRef::wrap)
                        .find(|e| e.value().name() == "figure")
                        .and_then(|e| e.select(&Selector::parse("figcaption").unwrap()).next())
                        .map(|e| e.text().collect::<String>())
                        .unwrap_or_default();
                    doc.assets.push(Asset {
                        id: id.clone(),
                        original_url: url,
                        alt: alt.clone(),
                        caption,
                        status: "pending".into(),
                        path: None,
                        sha256: None,
                        error: None,
                    });
                    doc.blocks.push(Block {
                        id: format!("b{}", doc.blocks.len() + 1),
                        kind: "image".into(),
                        markdown: escape(&alt),
                        level: None,
                        asset_id: Some(id),
                        prefix: None,
                        continuation_prefix: None,
                    });
                }
                return;
            }
            if tag == "table" {
                push(doc, "paragraph", buffer, None);
                if let Some(e) = ElementRef::wrap(node) {
                    if e.select(&Selector::parse("[colspan], [rowspan], table").unwrap()).any(|cell| cell.id() != e.id()) {
                        doc.warnings.push("表格含合并单元格或嵌套表格；Markdown 无法完整表达原布局，请对照原文核查。".into());
                    }
                    let mut rows = vec![];
                    for row in e.select(&Selector::parse("tr").unwrap()) {
                        let cells = row
                            .select(&Selector::parse("td,th").unwrap())
                            .map(|c| {
                                escape(
                                    &c.text()
                                        .collect::<String>()
                                        .split_whitespace()
                                        .collect::<Vec<_>>()
                                        .join(" "),
                                )
                                .replace('|', "\\|")
                            })
                            .collect::<Vec<_>>();
                        if !cells.is_empty() {
                            rows.push(cells);
                        }
                    }
                    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
                    for (i, mut row) in rows.into_iter().enumerate() {
                        row.resize(columns, String::new());
                        buffer.push_str(&format!("| {} |\n", row.join(" | ")));
                        if i == 0 {
                            buffer.push_str(&format!("| {} |\n", vec!["---"; columns].join(" | ")));
                        }
                    }
                    push(doc, "table", buffer, None);
                    for image in e.select(&Selector::parse("img").unwrap()) {
                        walk(*image, doc, buffer, depth + 1);
                    }
                }
                return;
            }
            if tag == "pre" {
                push(doc, "paragraph", buffer, None);
                if let Some(e) = ElementRef::wrap(node) {
                    let text = e.text().collect::<String>();
                    let language = e.select(&Selector::parse("code").unwrap()).next()
                        .and_then(|code| code.value().attr("class"))
                        .and_then(|class| class.split_whitespace().find_map(|name| name.strip_prefix("language-")))
                        .filter(|name| name.len() <= 40 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+')))
                        .unwrap_or("");
                    let fence = "`".repeat(
                        text.split(|c| c != '`')
                            .map(str::len)
                            .max()
                            .unwrap_or(0)
                            .max(2)
                            + 1,
                    );
                    buffer.push_str(&format!("{fence}{language}\n{text}\n{fence}"));
                    push(doc, "code", buffer, None);
                }
                return;
            }
            if tag == "br" {
                buffer.push_str("  \n");
                return;
            }
            if tag == "code" {
                if let Some(e) = ElementRef::wrap(node) {
                    let text = e.text().collect::<String>().replace(['\r', '\n'], " ");
                    let fence = "`".repeat(text.split(|c| c != '`').map(str::len).max().unwrap_or(0) + 1);
                    let padding = if text.starts_with('`') || text.ends_with('`') || (text.starts_with(' ') && text.ends_with(' ')) { " " } else { "" };
                    buffer.push_str(&format!("{fence}{padding}{text}{padding}{fence}"));
                }
                return;
            }
            let heading = tag
                .strip_prefix('h')
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|v| (1..=6).contains(v));
            let block = heading.is_some()
                || matches!(
                    tag,
                    "p" | "div"
                        | "section"
                        | "article"
                        | "main"
                        | "li"
                        | "blockquote"
                        | "figure"
                        | "figcaption"
                        | "ul"
                        | "ol"
                );
            if block {
                push(doc, "paragraph", buffer, None);
            }
            let href = if tag == "a" {
                el.attr("href").and_then(|u| link(u, &doc.source_url))
            } else {
                None
            };
            let marker = match tag {
                "strong" | "b" => "**",
                "em" | "i" => "*",
                "del" => "~~",
                "code" => "`",
                _ => "",
            };
            if href.is_some() || !marker.is_empty() {
                // Markdown delimiters cannot enclose leading/trailing spaces.
                // Linked images or block descendants are emitted as blocks,
                // rather than leaving stray '[' and '](url)' paragraphs.
                let has_blocks=ElementRef::wrap(node).is_some_and(|e|e.select(&Selector::parse("img,p,div,section,article,main,ul,ol,li,table,blockquote,pre,figure,h1,h2,h3,h4,h5,h6").unwrap()).next().is_some());
                if has_blocks {
                    for child in node.children() {
                        walk(child, doc, buffer, depth + 1);
                    }
                    return;
                }
                let mut inner = String::new();
                for child in node.children() {
                    walk(child, doc, &mut inner, depth + 1);
                }
                if inner.starts_with(char::is_whitespace) && !buffer.ends_with(char::is_whitespace)
                {
                    buffer.push(' ');
                }
                let content = inner.trim();
                if !content.is_empty() {
                    if href.is_some() {
                        buffer.push('[');
                    }
                    buffer.push_str(marker);
                    buffer.push_str(content);
                    buffer.push_str(marker);
                    if let Some(href) = href {
                        buffer.push_str(&format!(
                            "](<{}>)",
                            href.replace('>', "%3E").replace('<', "%3C")
                        ));
                    }
                }
                if inner.ends_with(char::is_whitespace) && !buffer.ends_with(char::is_whitespace) {
                    buffer.push(' ');
                }
                return;
            }
            for child in node.children() {
                walk(child, doc, buffer, depth + 1);
            }
            if let Some(level) = heading {
                push(doc, "heading", buffer, Some(level));
            } else if block {
                push(
                    doc,
                    match tag {
                        "li" => "list_item",
                        "blockquote" => "quote",
                        "figcaption" => "caption",
                        _ => "paragraph",
                    },
                    buffer,
                    None,
                );
            }
        }
        _ => {
            for child in node.children() {
                walk(child, doc, buffer, depth + 1);
            }
        }
    }
}
pub fn parse(mut doc: Document, html: &str) -> Document {
    doc.schema_version = DOCUMENT_SCHEMA_VERSION;
    let html = Html::parse_fragment(html);
    let mut buffer = String::new();
    walk(html.tree.root(), &mut doc, &mut buffer, 0);
    push(&mut doc, "paragraph", &mut buffer, None);
    doc
}
fn blocks_markdown(doc: &Document, image: impl Fn(&Asset) -> String) -> String {
    let mut out = String::new();
    for b in &doc.blocks {
        let body = match b.kind.as_str() {
            "heading" => format!("{} {}", "#".repeat(b.level.unwrap_or(2)), b.markdown),
            "list_item" if b.prefix.is_none() => format!("- {}", b.markdown),
            "quote" if b.prefix.is_none() => format!("> {}", b.markdown.replace('\n', "\n> ")),
            "image" => doc
                .assets
                .iter()
                .find(|a| Some(&a.id) == b.asset_id.as_ref())
                .map(&image)
                .unwrap_or_default(),
            _ => b.markdown.clone(),
        };
        if let Some(prefix) = &b.prefix {
            for (index, line) in body.lines().enumerate() {
                if index > 0 { out.push('\n'); }
                out.push_str(if index == 0 { prefix } else { b.continuation_prefix.as_deref().unwrap_or(prefix) });
                out.push_str(line);
            }
        } else {
            out.push_str(&body);
        }
        // A blank line inside a quote needs its container marker; otherwise
        // consecutive quoted paragraphs become separate blockquotes.
        if let Some(prefix) = b.continuation_prefix.as_deref().filter(|p| p.contains('>')) {
            out.push_str(&format!("\n{}\n", prefix.trim_end()));
        } else {
            out.push_str("\n\n");
        }
    }
    out
}
fn destination(url: &str) -> String {
    url.replace('>', "%3E").replace('<', "%3C")
}
pub fn markdown(doc: &Document) -> String {
    let scalar = |s: &str| serde_json::to_string(s).unwrap();
    let mut out=format!("---\ntitle: {}\nsource: {}\ncaptured_at: {}\ncapture_id: {}\nsource_kind: {}\ntruncated: {}\ntags: [scholay-today]\n---\n\n# {}\n\n",scalar(&doc.title),scalar(&doc.source_url),scalar(&doc.captured_at),scalar(&doc.capture_id),scalar(&doc.source_kind),doc.truncated,escape(&doc.title));
    for warning in &doc.warnings {
        out.push_str(&format!("> [!warning]\n> {}\n\n", escape(warning)));
    }
    out.push_str(&blocks_markdown(doc, |a| match &a.path {
        Some(path) => format!("![{}]({})", escape(&a.alt), path),
        None => format!(
            "> [!warning] 图片未保存：{}\n> 原图：<{}>",
            escape(&a.alt),
            destination(&a.original_url)
        ),
    }));
    out
}

/// Markdown for the in-app Markdown tab and for agents: no export frontmatter
/// or duplicated title. Images stay ordinary `![alt](url)` references so the
/// Markdown renderer can hydrate them against the stored snapshot.
pub fn reading_markdown(doc: &Document) -> String {
    blocks_markdown(doc, |a| match &a.path {
        Some(path) => format!("![{}]({})", escape(&a.alt), path),
        None => format!("![{}](<{}>)", escape(&a.alt), destination(&a.original_url)),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    pub fn fixture() -> Document {
        Document {
            schema_version: 1,
            capture_id: "fixture".into(),
            article_id: 1,
            title: "研究".into(),
            source_url: "https://example.org/article".into(),
            captured_at: "2026-09-06".into(),
            source_kind: "web".into(),
            author: None,
            published_at: None,
            truncated: false,
            blocks: vec![],
            assets: vec![],
            warnings: vec![],
        }
    }
    #[test]
    fn structure_images_links_tables_and_private_forms() {
        let d=parse(fixture(),"<h2>背景</h2><p>中文 <strong>强调</strong><a href='/paper'>论文</a></p><figure><img data-src='/a.png' alt='图一'><figcaption>实验结果</figcaption></figure><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><form><input value='SECRET'>PRIVATE</form><script>EVIL</script>");
        assert_eq!(d.assets[0].original_url, "https://example.org/a.png");
        assert_eq!(d.assets[0].caption, "实验结果");
        let m = markdown(&d);
        assert!(m.contains("## 背景"));
        assert!(m.contains("| A | B |"));
        assert!(m.contains("https://example.org/paper"));
        assert!(!m.contains("PRIVATE") && !m.contains("EVIL") && !m.contains("SECRET"));
    }
    #[test]
    fn never_export_active_links() {
        let d=parse(fixture(),"<p><a href='javascript:alert(1)'>safe</a></p><img src='file:///etc/passwd'><p>&lt;script&gt;</p>");
        assert!(d.assets.is_empty());
        assert!(!markdown(&d).contains("javascript:"));
        assert!(!markdown(&d).contains("<script>"));
    }
    #[test]
    fn preserves_spaces_around_inline_elements() {
        let d = parse(fixture(), "<p>Hello <strong>world</strong> again.</p>");
        assert!(markdown(&d).contains("Hello **world** again."));
    }
    #[test]
    fn valid_emphasis_and_linked_images() {
        let d = parse(
            fixture(),
            "<p>A<strong> heading </strong>B <a href='/image'><img src='/a.png'></a></p>",
        );
        let m = markdown(&d);
        assert!(m.contains("A **heading** B"));
        assert!(!d
            .blocks
            .iter()
            .any(|b| b.markdown == "[" || b.markdown.starts_with("](")));
        assert_eq!(d.assets.len(), 1);
    }

    #[test]
    fn ordered_nested_lists_and_quotes_keep_every_child_in_its_container() {
        let doc = parse(fixture(), "<ol start='3'><li><p>First step</p><ul><li>Nested item</li></ul><p>Continuation</p></li><li value='7'>Last step</li></ol><blockquote><p>First quote</p><p>Second quote<br>next line</p></blockquote>");
        let md = reading_markdown(&doc);
        assert!(md.contains("3. First step"), "{md}");
        assert!(md.contains("   - Nested item"), "{md}");
        assert!(md.contains("   Continuation"), "{md}");
        assert!(md.contains("7. Last step"), "{md}");
        assert!(md.contains("> First quote\n>\n> Second quote  \n> next line"), "{md}");
    }

    #[test]
    fn container_images_still_use_export_asset_paths() {
        let mut doc = parse(fixture(), "<blockquote><ul><li><p>Figure</p><img src='/a.png' alt='result'></li></ul></blockquote>");
        doc.assets[0].path = Some("assets/image-1.png".into());
        let md = markdown(&doc);
        assert!(md.contains("> - Figure"), "{md}");
        assert!(md.contains(">   ![result](assets/image-1.png)"), "{md}");
    }

    #[test]
    fn code_keeps_literals_language_and_indentation() {
        let doc = parse(fixture(), "<p><code>a_b &lt; x ` y</code></p><pre><code class='language-python'>if x:\n    print(`value`)\n</code></pre>");
        let md = reading_markdown(&doc);
        assert!(md.contains("``a_b < x ` y``"), "{md}");
        assert!(md.contains("```python\nif x:\n    print(`value`)"), "{md}");
    }

    #[test]
    fn hidden_noise_is_removed_but_ambiguous_layouts_get_a_warning() {
        let doc = parse(fixture(), "<div style='display: none !important'>hidden secret</div><div role='navigation'>menu</div><p>Evidence remains</p><table><tr><td colspan='2'>Merged</td></tr><tr><td>A</td><td>B</td></tr></table>");
        let md = reading_markdown(&doc);
        assert!(!md.contains("hidden secret") && !md.contains("menu"));
        assert!(md.contains("Evidence remains") && md.contains("Merged"));
        assert!(doc.warnings.iter().any(|w| w.contains("合并单元格")));
    }

    #[test]
    fn old_blocks_deserialize_and_repeated_prose_is_not_deleted() {
        let old: Block = serde_json::from_str(r#"{"id":"b1","kind":"list_item","markdown":"legacy"}"#).unwrap();
        assert!(old.prefix.is_none());
        let mut doc = fixture(); doc.blocks.push(old);
        assert!(reading_markdown(&doc).contains("- legacy"));
        let doc = parse(fixture(), "<p>Repeat</p><p>Repeat</p>");
        assert_eq!(doc.blocks.len(), 2);
    }
}
