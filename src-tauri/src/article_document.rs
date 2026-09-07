//! Deterministic HTML → structured article. No AI/network/filesystem here.
use ego_tree::NodeRef;
use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};

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
        });
    }
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
            {
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
                    });
                }
                return;
            }
            if tag == "table" {
                push(doc, "paragraph", buffer, None);
                if let Some(e) = ElementRef::wrap(node) {
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
                    let fence = "`".repeat(
                        text.split(|c| c != '`')
                            .map(str::len)
                            .max()
                            .unwrap_or(0)
                            .max(2)
                            + 1,
                    );
                    buffer.push_str(&format!("{fence}\n{text}\n{fence}"));
                    push(doc, "code", buffer, None);
                }
                return;
            }
            if tag == "br" {
                buffer.push_str("  \n");
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
    let html = Html::parse_fragment(html);
    let mut buffer = String::new();
    walk(html.tree.root(), &mut doc, &mut buffer, 0);
    push(&mut doc, "paragraph", &mut buffer, None);
    doc
}
pub fn markdown(doc: &Document) -> String {
    let scalar = |s: &str| serde_json::to_string(s).unwrap();
    let mut out=format!("---\ntitle: {}\nsource: {}\ncaptured_at: {}\ncapture_id: {}\nsource_kind: {}\ntruncated: {}\ntags: [scholay-today]\n---\n\n# {}\n\n",scalar(&doc.title),scalar(&doc.source_url),scalar(&doc.captured_at),scalar(&doc.capture_id),scalar(&doc.source_kind),doc.truncated,escape(&doc.title));
    for warning in &doc.warnings {
        out.push_str(&format!("> [!warning]\n> {}\n\n", escape(warning)));
    }
    for b in &doc.blocks {
        let body = match b.kind.as_str() {
            "heading" => format!("{} {}", "#".repeat(b.level.unwrap_or(2)), b.markdown),
            "list_item" => format!("- {}", b.markdown),
            "quote" => format!("> {}", b.markdown),
            "image" => doc
                .assets
                .iter()
                .find(|a| Some(&a.id) == b.asset_id.as_ref())
                .map(|a| match &a.path {
                    Some(path) => format!("![{}]({})", escape(&a.alt), path),
                    None => format!(
                        "> [!warning] 图片未保存：{}\n> 原图：<{}>",
                        escape(&a.alt),
                        a.original_url.replace('>', "%3E")
                    ),
                })
                .unwrap_or_default(),
            _ => b.markdown.clone(),
        };
        out.push_str(&body);
        out.push_str("\n\n");
    }
    out
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
}
