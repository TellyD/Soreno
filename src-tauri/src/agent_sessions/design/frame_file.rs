use super::{FrameFile, FRAME_LIMIT, MAX_SIZE, MIN_SIZE, TITLE_LIMIT};
use crate::agent_sessions::Result;
use regex::Regex;
use std::sync::LazyLock;

static TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>").unwrap());
static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<meta\b[^>]*>").unwrap());
static ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).unwrap()
});
static DIMENSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(width|height)\s*=\s*(\d+(?:\.\d+)?)").unwrap());

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn clamp_size(value: f64) -> f64 {
    value.clamp(MIN_SIZE, MAX_SIZE)
}

fn attribute<'a>(tag: &'a str, key: &str) -> Option<&'a str> {
    ATTRIBUTE.captures_iter(tag).find_map(|attribute| {
        attribute[1]
            .eq_ignore_ascii_case(key)
            .then(|| (2..=4).find_map(|group| attribute.get(group)))
            .flatten()
            .map(|value| value.as_str())
    })
}

pub(super) fn meta_size(html: &str) -> Option<(f64, f64)> {
    META.find_iter(html).find_map(|tag| {
        if !attribute(tag.as_str(), "name")?.eq_ignore_ascii_case("soreno-frame") {
            return None;
        }
        let (mut width, mut height) = (None, None);
        for dimension in DIMENSION.captures_iter(attribute(tag.as_str(), "content")?) {
            let value = dimension[2].parse::<f64>().ok();
            if dimension[1].eq_ignore_ascii_case("width") {
                width = value;
            } else {
                height = value;
            }
        }
        Some((clamp_size(width?), clamp_size(height?)))
    })
}

/// Errors go to the agent: they are in English.
pub(in crate::agent_sessions) fn parse_frame(bytes: &[u8]) -> Result<FrameFile> {
    if bytes.len() > FRAME_LIMIT {
        return Err("the file is larger than 512 KiB.".into());
    }
    let html = std::str::from_utf8(bytes).map_err(|_| "the file is not valid UTF-8.")?;
    // Also tells a document still being written: the watcher retries it on the next scans.
    let end = html.trim_end().as_bytes();
    if !(end.len() >= 7 && end[end.len() - 7..].eq_ignore_ascii_case(b"</html>")) {
        return Err("the document must end with </html>.".into());
    }
    if html.contains('\0') {
        return Err("the file contains a NUL character.".into());
    }
    // Attribute names cannot be entity-encoded: refusing the name avoids parsing refresh values.
    if html.to_ascii_lowercase().contains("http-equiv") {
        return Err("meta http-equiv is not allowed.".into());
    }
    let title = TITLE
        .captures(html)
        .map(|captures| {
            decode_entities(&captures[1])
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(TITLE_LIMIT)
                .collect::<String>()
        })
        .filter(|title| !title.is_empty());
    Ok(FrameFile {
        title,
        size: meta_size(html),
        html: html.to_owned(),
    })
}
