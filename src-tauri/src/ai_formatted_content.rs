//! Images belong to the captured evidence, not to the language model.
use crate::article_document::Document;

pub fn body_markdown(doc: &Document) -> String {
    doc.blocks
        .iter()
        .map(|b| match b.kind.as_str() {
            "heading" => format!(
                "{} {}",
                "#".repeat(b.level.unwrap_or(2).clamp(1, 6)),
                b.markdown
            ),
            "list_item" => format!("- {}", b.markdown),
            "quote" => format!("> {}", b.markdown.replace('\n', "\n> ")),
            "image" => doc
                .assets
                .iter()
                .find(|a| Some(&a.id) == b.asset_id.as_ref())
                .and_then(|a| {
                    let url = url::Url::parse(&a.original_url).ok()?;
                    if !matches!(url.scheme(), "https" | "http")
                        || !url.username().is_empty()
                        || url.password().is_some()
                    {
                        return None;
                    }
                    let alt = a
                        .alt
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                        .replace('\\', "\\\\")
                        .replace('[', "\\[")
                        .replace(']', "\\]")
                        .replace(['\r', '\n'], " ");
                    Some(format!(
                        "![{}](<{}>)",
                        alt,
                        url.as_str().replace('<', "%3C").replace('>', "%3E")
                    ))
                })
                .unwrap_or_default(),
            _ => b.markdown.clone(),
        })
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub struct ProtectedSource {
    pub text: String,
    prefix: String,
    images: Vec<(String, String)>,
}
impl ProtectedSource {
    pub fn new(markdown: &str) -> Self {
        // Per-request namespace prevents page text forging an image token.
        let prefix = format!("SCHOLAYIMAGE{}X", uuid::Uuid::new_v4().simple());
        let mut images = Vec::new();
        let text = markdown
            .split_inclusive('\n')
            .map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with("![") && trimmed.ends_with(">)") {
                    let token = format!("{prefix}{}END", images.len());
                    images.push((token.clone(), trimmed.to_string()));
                    format!("{token}{}", if line.ends_with('\n') { "\n" } else { "" })
                } else {
                    line.to_string()
                }
            })
            .collect();
        Self {
            text,
            prefix,
            images,
        }
    }
    pub fn restore(&self, text: &str) -> String {
        self.images
            .iter()
            .fold(text.to_string(), |out, (token, image)| {
                out.replace(token, image)
            })
    }
    pub fn text_for_audit(&self, text: &str) -> String {
        self.images
            .iter()
            .fold(text.to_string(), |out, (token, _)| out.replace(token, ""))
    }
    pub fn validate_images(&self, part: &str, output: &str) -> Result<(), String> {
        let tokens = |text: &str| {
            let mut found = self
                .images
                .iter()
                .flat_map(|(token, _)| {
                    text.match_indices(token)
                        .map(move |(pos, _)| (pos, token.clone()))
                })
                .collect::<Vec<_>>();
            found.sort_by_key(|v| v.0);
            found.into_iter().map(|v| v.1).collect::<Vec<_>>()
        };
        let expected = tokens(part);
        let mut fenced = false;
        let mut misplaced = false;
        for line in output.lines() {
            let line = line.trim();
            if line.starts_with("```") || line.starts_with("~~~") {
                fenced = !fenced;
            }
            if line.contains(&self.prefix)
                && (fenced || !expected.iter().any(|token| token == line))
            {
                misplaced = true;
            }
        }
        if tokens(output) != expected
            || misplaced
            || output.matches(&self.prefix).count() != expected.len()
            || output.contains("![")
            || output.to_ascii_lowercase().contains("<img")
        {
            Err("The AI changed or omitted captured image positions.".into())
        } else {
            Ok(())
        }
    }
}

pub fn fallback_notice(language: &str) -> &'static str {
    match language {
        "en" => "> [!info]\n> Some sections could not be reliably AI-formatted. Those sections retain the captured original wording and images; they are not an AI rewrite or translation.\n\n",
        "ja" => "> [!info]\n> 一部を安全にAI整形できなかったため、その部分は取得原文と画像のまま表示しています。AIによる書き換えや翻訳ではありません。\n\n",
        _ => "> [!info]\n> 部分段落未能可靠地完成 AI 整理，已保留抓取原文及图片。这些段落未做 AI 改写或翻译。\n\n",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_duplicate_reordered_or_invented_images_reject_but_fallback_is_lossless() {
        let original = "## Results\n\n![Fig 1](<https://example.org/1.png>)\n\n20 plots, 185 species.\n\n![Fig 2](<https://example.org/2.png>)";
        let s = ProtectedSource::new(original);
        assert_eq!(s.restore(&s.text), original);
        assert!(!s.text.contains("https://"));
        assert!(s.validate_images(&s.text, &s.text).is_ok());
        assert!(s
            .validate_images(&s.text, &format!("intro\n```\n{}\n```", s.text))
            .is_err());
        assert!(s
            .validate_images(
                &s.text,
                &s.text
                    .replace(&s.images[0].0, &format!("> {}", s.images[0].0))
            )
            .is_err());
        assert!(s
            .validate_images(&s.text, &s.text.replace(&s.images[0].0, ""))
            .is_err());
        assert!(s
            .validate_images(&s.text, &(s.text.clone() + &s.images[0].0))
            .is_err());
        let reordered = format!("{}\n{}", s.images[1].0, s.images[0].0);
        assert!(s.validate_images(&s.text, &reordered).is_err());
        assert!(s
            .validate_images(
                &s.text,
                &(s.text.clone() + "![invented](https://evil.example/x)")
            )
            .is_err());
        assert_eq!(
            s.text_for_audit(&s.text),
            "## Results\n\n\n\n20 plots, 185 species.\n\n"
        );
    }
    #[test]
    fn structured_source_retains_images_captions_links_tables_and_safe_alt_text() {
        let doc = crate::article_document::parse(Document {
            schema_version: 1, capture_id: "fixture".into(), article_id: 1,
            title: "研究".into(), source_url: "https://example.org/article".into(),
            captured_at: "2026-09-06".into(), source_kind: "web".into(), author: None,
            published_at: None, truncated: false, blocks: vec![], assets: vec![], warnings: vec![],
        }, "<h2>结果</h2><p>20 个群落和 185 种植物。</p><figure><img src='/figure(a).png?x=1&amp;y=2' alt='图]2 &lt;test&gt;'><figcaption>图2 阈值 0.8</figcaption></figure><table><tr><th>基金</th></tr><tr><td>32271611</td></tr></table><p><a href='https://doi.org/10.1111/1365-2435.70386'>原文</a></p>");
        let source = body_markdown(&doc);
        assert!(
            source.contains("![图\\]2 &lt;test&gt;](<https://example.org/figure(a).png?x=1&y=2>)")
        );
        assert!(source.find("185").unwrap() < source.find("![").unwrap());
        assert!(source.find("![").unwrap() < source.find("图2 阈值 0.8").unwrap());
        assert!(source.contains("| 32271611 |"));
        assert!(source.contains("https://doi.org/10.1111/1365-2435.70386"));
        let protected = ProtectedSource::new(&source);
        assert_eq!(protected.restore(&protected.text), source);
    }
}
