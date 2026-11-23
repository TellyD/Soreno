use super::{Result, REQUEST_LIMIT};
use crate::kanban;
use regex::Regex;
use serde::Deserialize;
use std::sync::LazyLock;

const MISSING_SUMMARY: &str = "[Kanban/requestSummary] Une modification de description demande summary, une phrase courte sur ce qui a changé : rien n’a été modifié.";
// `![alt](image-N)`, `![alt](image-N.ext)` or `![alt](<image-N>)`, as the agent's prompt names
// the issue's images; the alt text may hold escaped brackets.
static IMAGE_PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(!\[(?:\\.|[^\\\]])*\]\()(?:<image-(\d+)(?:\.\w+)?>|image-(\d+)(?:\.\w+)?)([\s)])")
        .unwrap()
});

#[derive(Deserialize)]
struct RequestFile {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    linear: bool,
    #[serde(default)]
    update: bool,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    summary: Option<String>,
}

pub(super) struct IssueContent {
    pub(super) title: String,
    pub(super) description: Option<String>,
    pub(super) linear: bool,
    /// The group member the issue concerns, as the group prompt names it.
    pub(super) project: Option<String>,
}

/// New title and/or description of the session's linked issue; an empty description clears it.
/// `summary` says what the description change does.
pub(super) struct IssueEdit {
    pub(super) title: Option<String>,
    pub(super) description: Option<String>,
    pub(super) summary: String,
}

pub(super) enum Request {
    Create(IssueContent),
    Update(IssueEdit),
}

pub(super) fn parse_request(bytes: &[u8]) -> Result<Request> {
    if bytes.len() > REQUEST_LIMIT {
        return Err("[Kanban/requestTooLarge] Demande trop volumineuse (64 Kio maximum).".into());
    }
    let file: RequestFile = serde_json::from_slice(bytes)
        .map_err(|error| format!("[Kanban/requestInvalidJson] JSON invalide ({error})."))?;
    let description = file
        .description
        .map(|description| description.trim().to_owned());
    if file.update {
        if file.title.is_none() && description.is_none() {
            return Err(kanban::EMPTY_UPDATE_MESSAGE.into());
        }
        let summary = file.summary.as_deref().map(str::trim).unwrap_or_default();
        if description.is_some() && summary.is_empty() {
            return Err(MISSING_SUMMARY.into());
        }
        return Ok(Request::Update(IssueEdit {
            title: file
                .title
                .as_deref()
                .map(kanban::required_title)
                .transpose()?
                .map(str::to_owned),
            description,
            summary: summary.to_owned(),
        }));
    }
    Ok(Request::Create(IssueContent {
        title: kanban::required_title(file.title.as_deref().unwrap_or_default())?.to_owned(),
        description: description.filter(|description| !description.is_empty()),
        linear: file.linear,
        project: file.project,
    }))
}

/// Puts back the original target of each image placeholder the agent kept from its prompt.
pub(super) fn resolve_image_placeholders(text: &str, targets: &[String]) -> Result<String> {
    let mut resolved = String::with_capacity(text.len());
    let mut copied = 0;
    for found in IMAGE_PLACEHOLDER.captures_iter(text) {
        let number = found.get(2).or_else(|| found.get(3)).unwrap();
        let target = number
            .as_str()
            .parse::<usize>()
            .ok()
            .and_then(|number| targets.get(number.checked_sub(1)?))
            .ok_or_else(|| {
                format!(
                    "[Kanban/requestImagePlaceholder] L’image « image-{} » est inconnue de cette session : rien n’a été modifié.",
                    number.as_str()
                )
            })?;
        let start = found.get(1).unwrap().end();
        resolved.push_str(&text[copied..start]);
        // Always bracketed, as the front writes images: bare targets stop at `'` or `(`.
        resolved.push_str(&format!("<{target}>"));
        // The closing character after the target stays in place.
        copied = found.get(4).unwrap().start();
    }
    resolved.push_str(&text[copied..]);
    Ok(resolved)
}
