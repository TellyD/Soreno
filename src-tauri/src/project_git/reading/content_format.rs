use super::super::{GitContent, GitError};
use super::LINE_LIMIT;
use crate::project_files::media::image_data_url;

pub(super) fn empty_content() -> GitContent {
    GitContent {
        text: Some(String::new()),
        oid: None,
        size: 0,
        mode: "000000".into(),
        reason: None,
        image_data_url: None,
    }
}

pub(super) fn unreadable_content(
    oid: Option<String>,
    size: u64,
    mode: String,
    reason: &str,
) -> GitContent {
    GitContent {
        text: None,
        oid,
        size,
        mode,
        reason: Some(reason.into()),
        image_data_url: None,
    }
}

pub(super) fn content_from_bytes(
    bytes: Vec<u8>,
    oid: Option<String>,
    mode: String,
) -> Result<GitContent, GitError> {
    let size = bytes.len() as u64;
    let text = if bytes.contains(&0) {
        Err((bytes, "binary"))
    } else {
        String::from_utf8(bytes).map_err(|error| (error.into_bytes(), "nonUtf8"))
    };
    let text = match text {
        Ok(text) => text,
        Err((bytes, reason)) => {
            let Some(url) = image_data_url(&bytes) else {
                return Ok(unreadable_content(oid, size, mode, reason));
            };
            return Ok(GitContent {
                image_data_url: Some(url),
                ..unreadable_content(oid, size, mode, "binary")
            });
        }
    };
    let lines = text.bytes().filter(|byte| *byte == b'\n').count()
        + usize::from(!text.is_empty() && !text.ends_with('\n'));
    if lines > LINE_LIMIT {
        return Ok(unreadable_content(oid, size, mode, "tooLarge"));
    }
    Ok(GitContent {
        text: Some(text),
        oid,
        size,
        mode,
        reason: None,
        image_data_url: None,
    })
}
