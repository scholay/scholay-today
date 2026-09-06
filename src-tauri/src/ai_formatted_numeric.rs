//! Conservative, local numeric-preservation check, not a proof of factual
//! equivalence. Values stay private: callers receive counts and source lines.

use std::collections::{BTreeSet, HashSet};

#[derive(Debug, Default)]
pub(super) struct NumericAudit {
    pub expected: usize,
    pub missing: usize,
    pub missing_identifiers: usize,
    pub ignored_list_markers: usize,
    pub missing_lines: Vec<usize>,
}

#[derive(Clone, Eq, Hash, PartialEq)]
enum Fact {
    Number(String),
    Identifier(String),
}

#[derive(Default)]
struct Extracted {
    facts: Vec<(Fact, usize)>,
    ignored_list_markers: usize,
}

pub(super) fn audit(source: &str, output: &str) -> NumericAudit {
    let source = extract(source);
    let output: HashSet<_> = extract(output)
        .facts
        .into_iter()
        .map(|(fact, _)| fact)
        .collect();
    let expected: HashSet<_> = source.facts.iter().map(|(fact, _)| fact).collect();
    let missing: HashSet<_> = expected
        .into_iter()
        .filter(|fact| !output.contains(*fact))
        .collect();
    NumericAudit {
        expected: source
            .facts
            .iter()
            .map(|(fact, _)| fact)
            .collect::<HashSet<_>>()
            .len(),
        missing: missing.len(),
        missing_identifiers: missing
            .iter()
            .filter(|fact| matches!(fact, Fact::Identifier(_)))
            .count(),
        ignored_list_markers: source.ignored_list_markers,
        missing_lines: source
            .facts
            .iter()
            .filter_map(|(fact, line)| missing.contains(fact).then_some(*line))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .take(8)
            .collect(),
    }
}

fn ascii_width(ch: char) -> char {
    match ch {
        '\u{ff01}'..='\u{ff5e}' => char::from_u32(ch as u32 - 0xfee0).unwrap_or(ch),
        '\u{2212}' => '-',
        _ => ch,
    }
}

// URL destinations are provenance, not quantities. Retain visible link text
// and stop at Chinese prose punctuation *before* full-width normalization.
fn without_urls(line: &str) -> Vec<char> {
    let chars: Vec<_> = line.chars().collect();
    let mut result = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let scheme = ["https://", "http://"].into_iter().find(|prefix| {
            chars.get(i..i + prefix.len()).is_some_and(|candidate| {
                candidate
                    .iter()
                    .copied()
                    .zip(prefix.chars())
                    .all(|(a, b)| a.eq_ignore_ascii_case(&b))
            })
        });
        if let Some(scheme) = scheme {
            i += scheme.len();
            while i < chars.len()
                && !chars[i].is_whitespace()
                && !matches!(
                    chars[i],
                    '<' | '>'
                        | '"'
                        | '\''
                        | '`'
                        | ')'
                        | ']'
                        | '}'
                        | '，'
                        | '。'
                        | '、'
                        | '；'
                        | '：'
                        | '！'
                        | '？'
                        | '）'
                        | '】'
                        | '》'
                        | '」'
                        | '』'
                )
            {
                i += 1;
            }
            result.push(' ');
        } else {
            result.push(ascii_width(chars[i]));
            i += 1;
        }
    }
    result
}

fn list_content_start(chars: &[char]) -> Option<usize> {
    let mut start = 0;
    while chars.get(start).is_some_and(|ch| ch.is_whitespace()) {
        start += 1;
    }
    let mut end = start;
    while chars.get(end).is_some_and(char::is_ascii_digit) {
        end += 1;
    }
    // Long leading-zero strings and years are not assumed to be list labels.
    if !(1..=3).contains(&(end - start)) {
        return None;
    }
    match chars.get(end) {
        Some('.')
            if chars.get(end + 1).is_none_or(|ch| ch.is_whitespace())
                || (end - start == 2
                    && chars[start] == '0'
                    && chars.get(end + 1).is_some_and(|ch| !ch.is_ascii_digit())) =>
        {
            Some(end + 1)
        }
        Some(')' | '、') => Some(end + 1),
        _ => None,
    }
}

fn ascii_word_end(chars: &[char], start: usize) -> usize {
    let mut end = start;
    while let Some(ch) = chars.get(end) {
        if ch.is_ascii_alphanumeric()
            || *ch == '_'
            || (*ch == '-'
                && end > start
                && chars[start].is_ascii_alphabetic()
                && chars.get(end + 1).is_some_and(char::is_ascii_digit))
        {
            end += 1;
        } else {
            break;
        }
    }
    end
}

fn extract(text: &str) -> Extracted {
    let mut extracted = Extracted::default();
    for (line_index, line) in text.lines().enumerate() {
        let chars = without_urls(line);
        let mut i = if let Some(start) = list_content_start(&chars) {
            extracted.ignored_list_markers += 1;
            start
        } else {
            0
        };
        while i < chars.len() {
            if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
                let end = ascii_word_end(&chars, i);
                if chars[i..end].iter().any(char::is_ascii_digit) {
                    extracted.facts.push((
                        Fact::Identifier(
                            chars[i..end]
                                .iter()
                                .collect::<String>()
                                .to_ascii_lowercase(),
                        ),
                        line_index + 1,
                    ));
                }
                i = end;
            } else if let Some((end, facts)) = date_at(&chars, i).or_else(|| time_at(&chars, i)) {
                extracted.facts.extend(
                    facts
                        .into_iter()
                        .map(|fact| (Fact::Number(fact), line_index + 1)),
                );
                i = end;
            } else if let Some((end, fact)) = number_at(&chars, i) {
                extracted.facts.push((fact, line_index + 1));
                i = end;
            } else if chinese_char(chars[i]) {
                let start = i;
                while chars.get(i).is_some_and(|ch| chinese_char(*ch)) {
                    i += 1;
                }
                // Names such as 张三/李四 and ordinary prose are not numbers.
                // Only a complete numeral immediately followed by a quantity
                // unit (optionally after whitespace) is considered.
                let mut unit = i;
                while chars.get(unit).is_some_and(|ch| ch.is_whitespace()) {
                    unit += 1;
                }
                if quantity_follows(&chars[unit..]) {
                    if let Some(mut value) = chinese_number(&chars[start..i]) {
                        if start > 0 && matches!(chars[start - 1], '负' | '負' | '-') {
                            value.insert(0, '-');
                        }
                        extracted.facts.push((Fact::Number(value), line_index + 1));
                    }
                }
            } else {
                i += 1;
            }
        }
    }
    extracted
}

fn digits_end(chars: &[char], mut i: usize) -> usize {
    while chars.get(i).is_some_and(char::is_ascii_digit) {
        i += 1;
    }
    i
}

fn digits_value(chars: &[char]) -> Option<u32> {
    chars.iter().collect::<String>().parse().ok()
}

// Explicit YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD only. Do not globally erase
// leading zeros: article identifiers, postal codes, and phone numbers need them.
fn date_at(chars: &[char], start: usize) -> Option<(usize, Vec<String>)> {
    let year_end = digits_end(chars, start);
    if year_end - start != 4 {
        return None;
    }
    let separator = *chars.get(year_end)?;
    if !matches!(separator, '-' | '/' | '.') {
        return None;
    }
    let month_start = year_end + 1;
    let month_end = digits_end(chars, month_start);
    if !(1..=2).contains(&(month_end - month_start)) || chars.get(month_end) != Some(&separator) {
        return None;
    }
    let day_start = month_end + 1;
    let end = digits_end(chars, day_start);
    if !(1..=2).contains(&(end - day_start))
        || chars.get(end).is_some_and(char::is_ascii_alphanumeric)
    {
        return None;
    }
    let month = digits_value(&chars[month_start..month_end])?;
    let day = digits_value(&chars[day_start..end])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((
        end,
        vec![
            chars[start..year_end].iter().collect(),
            month.to_string(),
            day.to_string(),
        ],
    ))
}

fn number_at(chars: &[char], start: usize) -> Option<(usize, Fact)> {
    let mut cursor = start;
    let negative = chars.get(cursor) == Some(&'-');
    if matches!(chars.get(cursor), Some('-' | '+')) {
        // In 30-35 the dash separates two bounds, unlike a unary minus.
        if cursor > 0 && chars[cursor - 1].is_ascii_digit() {
            return None;
        }
        cursor += 1;
    }
    let digits_start = cursor;
    let integer_end = digits_end(chars, cursor);
    if integer_end == cursor
        && !(chars.get(cursor) == Some(&'.')
            && chars.get(cursor + 1).is_some_and(char::is_ascii_digit))
    {
        return None;
    }
    cursor = integer_end;
    let mut integer: String = chars[digits_start..integer_end].iter().collect();
    if !integer.is_empty() && chars.get(cursor) == Some(&',') {
        let mut grouped_end = cursor;
        let mut groups = Vec::new();
        while chars.get(grouped_end) == Some(&',')
            && chars.get(grouped_end + 1).is_some_and(char::is_ascii_digit)
        {
            let group_start = grouped_end + 1;
            grouped_end = digits_end(chars, group_start);
            groups.push(&chars[group_start..grouped_end]);
        }
        if integer.len() <= 3 && !groups.is_empty() && groups.iter().all(|group| group.len() == 3) {
            for group in groups {
                integer.extend(group.iter().copied());
            }
            cursor = grouped_end;
        }
    }
    let mut fraction = String::new();
    let decimal =
        chars.get(cursor) == Some(&'.') && chars.get(cursor + 1).is_some_and(char::is_ascii_digit);
    if decimal {
        let fraction_start = cursor + 1;
        cursor = digits_end(chars, fraction_start);
        fraction = chars[fraction_start..cursor]
            .iter()
            .collect::<String>()
            .trim_end_matches('0')
            .to_string();
    }
    let mut exponent = String::new();
    if matches!(chars.get(cursor), Some('e' | 'E')) {
        let mut exponent_start = cursor + 1;
        let exponent_negative = chars.get(exponent_start) == Some(&'-');
        if matches!(chars.get(exponent_start), Some('-' | '+')) {
            exponent_start += 1;
        }
        let end = digits_end(chars, exponent_start);
        if end > exponent_start {
            let raw: String = chars[exponent_start..end].iter().collect();
            let canonical = raw.trim_start_matches('0');
            exponent = format!(
                "e{}{}",
                if exponent_negative { "-" } else { "" },
                if canonical.is_empty() { "0" } else { canonical }
            );
            cursor = end;
        }
    }
    if chars
        .get(cursor)
        .is_some_and(|ch| ch.is_ascii_alphabetic() || *ch == '_')
    {
        let end = ascii_word_end(chars, cursor);
        let suffix: String = chars[cursor..end]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        if !decimal && exponent.is_empty() && ordinal_suffix(&integer, &suffix) {
            cursor = end;
        } else {
            return Some((
                end,
                Fact::Identifier(
                    chars[start..end]
                        .iter()
                        .collect::<String>()
                        .to_ascii_lowercase(),
                ),
            ));
        }
    }
    if integer.is_empty() {
        integer.push('0');
    }
    // A two-digit month/day/year directly marked as a date is unambiguous;
    // an unlabelled 01 or a longer 00123 is deliberately not normalized.
    if !decimal
        && exponent.is_empty()
        && integer.len() == 2
        && integer.starts_with('0')
        && matches!(
            chars.get(cursor),
            Some('年' | '月' | '日' | '号' | '时' | '時' | '分' | '秒')
        )
    {
        integer.remove(0);
    }
    let value = format!(
        "{}{}{}{}",
        if negative { "-" } else { "" },
        integer,
        if fraction.is_empty() {
            String::new()
        } else {
            format!(".{fraction}")
        },
        exponent
    );
    Some((cursor, Fact::Number(value)))
}

fn ordinal_suffix(integer: &str, suffix: &str) -> bool {
    let last_two = integer.chars().rev().take(2).collect::<Vec<_>>();
    let expected = if last_two.get(1) == Some(&'1') {
        "th"
    } else {
        match last_two.first() {
            Some('1') => "st",
            Some('2') => "nd",
            Some('3') => "rd",
            _ => "th",
        }
    };
    suffix == expected
}

// Clock formatting may omit zero padding, but none of the hour/minute/second
// values may disappear. Do not mistake arbitrary colon-separated IDs for time.
fn time_at(chars: &[char], start: usize) -> Option<(usize, Vec<String>)> {
    let hour_end = digits_end(chars, start);
    if !(1..=2).contains(&(hour_end - start)) || chars.get(hour_end) != Some(&':') {
        return None;
    }
    let minute_start = hour_end + 1;
    let mut end = digits_end(chars, minute_start);
    if end - minute_start != 2 {
        return None;
    }
    let hour = digits_value(&chars[start..hour_end])?;
    let minute = digits_value(&chars[minute_start..end])?;
    if hour > 23 || minute > 59 {
        return None;
    }
    let mut values = vec![hour.to_string(), minute.to_string()];
    if chars.get(end) == Some(&':') {
        let second_start = end + 1;
        end = digits_end(chars, second_start);
        if end - second_start != 2 {
            return None;
        }
        let second = digits_value(&chars[second_start..end])?;
        if second > 59 {
            return None;
        }
        values.push(second.to_string());
    }
    if chars.get(end).is_some_and(char::is_ascii_alphanumeric) {
        return None;
    }
    Some((end, values))
}

fn chinese_digit(ch: char) -> Option<u64> {
    match ch {
        '零' | '〇' => Some(0),
        '一' => Some(1),
        '二' | '两' | '兩' => Some(2),
        '三' => Some(3),
        '四' => Some(4),
        '五' => Some(5),
        '六' => Some(6),
        '七' => Some(7),
        '八' => Some(8),
        '九' => Some(9),
        _ => None,
    }
}

fn chinese_char(ch: char) -> bool {
    chinese_digit(ch).is_some()
        || matches!(
            ch,
            '十' | '百' | '千' | '万' | '萬' | '亿' | '億' | '点' | '點' | '分' | '之'
        )
}

fn quantity_follows(chars: &[char]) -> bool {
    let tail: String = chars.iter().take(4).collect();
    if [
        "名下", "名字", "名称", "名为", "名叫", "名义", "年份", "年度", "月份",
    ]
    .iter()
    .any(|word| tail.starts_with(word))
    {
        return false;
    }
    [
        "名", "个", "個", "位", "项", "項", "份", "封", "年", "月", "天", "日", "周岁", "周歲",
        "周", "小时", "小時", "分钟", "分鐘", "秒", "岁", "歲", "人", "次", "届", "屆", "篇", "本",
        "页", "頁", "元", "度", "例", "组", "組", "条", "條", "套", "所", "家", "件", "倍",
    ]
    .iter()
    .any(|unit| tail.starts_with(unit))
}

fn chinese_number(chars: &[char]) -> Option<String> {
    let decimal = chars.iter().position(|ch| matches!(ch, '点' | '點'));
    let integer_chars = decimal.map_or(chars, |index| &chars[..index]);
    let integer = chinese_integer(integer_chars)?;
    if let Some(index) = decimal {
        if index + 1 == chars.len() {
            return None;
        }
        let fraction = chars[index + 1..]
            .iter()
            .map(|ch| chinese_digit(*ch).map(|n| char::from(b'0' + n as u8)))
            .collect::<Option<String>>()?;
        let fraction = fraction.trim_end_matches('0');
        Some(if fraction.is_empty() {
            integer.to_string()
        } else {
            format!("{integer}.{fraction}")
        })
    } else {
        Some(integer.to_string())
    }
}

fn chinese_integer(chars: &[char]) -> Option<u64> {
    if chars.is_empty() {
        return None;
    }
    if chars.iter().all(|ch| chinese_digit(*ch).is_some()) {
        return chars.iter().try_fold(0u64, |value, ch| {
            value.checked_mul(10)?.checked_add(chinese_digit(*ch)?)
        });
    }
    let (mut total, mut section, mut digit) = (0u64, 0u64, None);
    let mut previous_unit = 10_000;
    for ch in chars {
        if let Some(value) = chinese_digit(*ch) {
            if digit.is_some_and(|previous| previous != 0) {
                return None;
            }
            digit = Some(value);
            continue;
        }
        let unit = match ch {
            '十' => 10,
            '百' => 100,
            '千' => 1000,
            '万' | '萬' => 10_000,
            '亿' | '億' => 100_000_000,
            _ => return None,
        };
        if unit < 10_000 {
            if unit >= previous_unit {
                return None;
            }
            section = section.checked_add(digit.take().unwrap_or(1).checked_mul(unit)?)?;
            previous_unit = unit;
        } else {
            section = section.checked_add(digit.take().unwrap_or(0))?;
            if section == 0 {
                return None;
            }
            total = total.checked_add(section.checked_mul(unit)?)?;
            section = 0;
            previous_unit = 10_000;
        }
    }
    total.checked_add(section)?.checked_add(digit.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_clock_padding_is_formatting_but_its_values_are_required() {
        let source = "地点:北京 发布时间:2025-08-26 09:44:23";
        assert_eq!(
            audit(source, "地点：北京 发布时间：2025年8月26日9:44:23").missing,
            0
        );
        assert_eq!(audit(source, "2025年8月26日9时44分23秒，北京").missing, 0);
        assert!(audit(source, "2025年8月26日9时44分，北京").missing > 0);
        assert!(audit(source, "2025年8月26日8:44:23，北京").missing > 0);
        assert_eq!(
            audit("01.招聘条件\n招聘3名，年龄35岁。", "招聘三名，年龄35岁。").missing,
            0
        );
    }

    #[test]
    fn accepts_normalized_quantities_dates_and_casefold_identifiers() {
        let source = "01. 项目\n２０２６年０８月０３日，年龄35周岁，招聘3名。\n02. 经费1,000元，33rd SBUR，NIH U54/R01，CRISPR/Cas13。";
        let output = "2026年8月3日，年龄三十五岁，招聘三名。\n经费1000元，第33届 SBUR，nih u54/r01，crispr/cas13。";
        let result = audit(source, output);
        assert_eq!(result.missing, 0);
        assert_eq!(result.ignored_list_markers, 2);
        assert!(result.missing_lines.is_empty());
        assert_eq!(audit("2026-08-03", "2026年8月3日").missing, 0);
        assert_eq!(audit("2026/08/03", "2026.8.3").missing, 0);
    }

    #[test]
    fn compares_complete_signed_decimal_tokens_not_substrings() {
        for wrong in ["135岁", "35.5岁", "-35岁", "−35岁", "负三十五岁"] {
            assert_eq!(audit("35岁", wrong).missing, 1);
        }
        for wrong in ["13名", "0.3名", ".3名", "三点三名", "3e5名", "1,003名"] {
            assert_eq!(audit("3名", wrong).missing, 1);
        }
        assert_eq!(audit("35.50元，-3.0度", "35.5元，-3度").missing, 0);
        assert_eq!(audit("3名", "三名").missing, 0);
        assert_eq!(audit("3名", "三十五名").missing, 1);
        assert_eq!(audit("30至35岁", "30-35岁").missing, 0);
    }

    #[test]
    fn leading_zero_identifiers_and_scientific_names_remain_complete() {
        let result = audit(
            "编号00123，U54/R01，Cas13，CRISPRCas13",
            "编号123，U54，Cas12，CRISPRCas12",
        );
        assert_eq!(result.expected, 5);
        assert_eq!(result.missing, 4);
        assert_eq!(result.missing_identifiers, 3);
        assert_eq!(audit("00123", "123").missing, 1);
        assert_eq!(audit("R01", "R1").missing_identifiers, 1);
        assert_eq!(audit("U54/R01/Cas13", "u54/r01/cAS13").missing, 0);
        assert_eq!(audit("IL-6", "IL-7").missing_identifiers, 1);
    }

    #[test]
    fn ignores_only_explicit_short_line_start_list_markers() {
        let source = "01. 标题\n02. 标题\n1) 条件\n1、材料\n  ３）说明";
        let result = audit(source, "标题 条件 材料 说明");
        assert_eq!(result.expected, 0);
        assert_eq!(result.ignored_list_markers, 5);
        for fact in [
            "35周岁",
            "3名",
            "3.5万元",
            "2026.08.30",
            "00123. 编号",
            "正文第1、2项",
        ] {
            assert!(audit(fact, "无数字").missing > 0);
        }
    }

    #[test]
    fn strips_urls_symmetrically_without_swallowing_adjacent_chinese_facts() {
        let source =
            "https://example.com/a/24749，年龄35周岁，招3名。[U54](https://example.com/id/2026)";
        let result = audit(
            source,
            "年龄35岁，招三名。U54 https://example.com/other/999",
        );
        assert_eq!(result.expected, 3);
        assert_eq!(result.missing, 0);
        assert_eq!(audit("35岁", "https://example.com/35").missing, 1);
        assert_eq!(audit("[3名](https://example.com/135)", "3名").missing, 0);
        assert_eq!(audit("HTTPS://example.com/00123。R01", "r01").missing, 0);
    }

    #[test]
    fn does_not_erase_footer_copyright_clock_or_people_names() {
        let result = audit(
            "Copyright 2026\n更新时间08:30\n张三、李四、王五、三峡大学、张三名下",
            "",
        );
        assert_eq!(result.expected, 3);
        assert_eq!(result.missing_lines, vec![1, 2]);
        assert_eq!(
            audit("张三、李四、王五、三峡大学、张三名下", "").expected,
            0
        );
    }

    #[test]
    fn reports_distinct_counts_and_at_most_eight_sorted_source_lines() {
        let source = (1..=12).map(|n| format!("编号A{n}\n")).collect::<String>();
        let result = audit(&source, "");
        assert_eq!(result.expected, 12);
        assert_eq!(result.missing, 12);
        assert_eq!(result.missing_identifiers, 12);
        assert_eq!(result.missing_lines, (1..=8).collect::<Vec<_>>());
        let repeated = audit("35岁\n35岁\n3名", "35岁");
        assert_eq!(repeated.expected, 2);
        assert_eq!(repeated.missing, 1);
        assert_eq!(repeated.missing_lines, vec![3]);
    }

    #[test]
    fn grouping_must_be_valid_and_unlabelled_zeroes_are_not_discarded() {
        assert_eq!(audit("1,234,567.50元", "1234567.5元").missing, 0);
        assert!(audit("1,00元", "100元").missing > 0);
        assert_eq!(audit("编号08", "编号8").missing, 1);
        assert_eq!(audit("３５周岁、３名", "35周岁、3名").missing, 0);
    }
}
