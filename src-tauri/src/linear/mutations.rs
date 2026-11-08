use super::{
    map_issue, map_update, request_failed,
    responses::{
        RawCommentPayload, RawFileUpload, RawIssueCreate, RawIssueDescriptionUpdate,
        RawIssueUpdate, RawLabelCreate, RawSuccess, RawUploadFile,
    },
    ProjectLinks, Result,
};
use crate::kanban::{
    self, images, KanbanComment, KanbanIssue, KanbanIssueCreateInput, KanbanIssueDescriptionUpdate,
    KanbanIssueInput, KanbanIssueUpdate, KanbanLabel,
};
use serde_json::{json, Value};

pub(super) fn issue_update_input(patch: KanbanIssueInput, links: &ProjectLinks) -> Result<Value> {
    if patch
        .added_label_ids
        .iter()
        .any(|id| patch.removed_label_ids.contains(id))
    {
        return Err(kanban::LABEL_CONFLICT_MESSAGE.into());
    }
    let mut input = serde_json::Map::new();
    if let Some(state_id) = patch.state_id {
        input.insert("stateId".into(), json!(state_id));
    }
    if let Some(priority) = patch.priority {
        input.insert(
            "priority".into(),
            json!(kanban::validate_priority(priority)?),
        );
    }
    if let Some(title) = patch.title {
        input.insert("title".into(), json!(kanban::required_title(&title)?));
    }
    if let Some(project_id) = patch.project_id {
        let linear_project_id = project_id
            .map(|id| links.linear_project_id(&id))
            .transpose()?;
        input.insert("projectId".into(), json!(linear_project_id));
    }
    if !patch.added_label_ids.is_empty() {
        input.insert("addedLabelIds".into(), json!(patch.added_label_ids));
    }
    if !patch.removed_label_ids.is_empty() {
        input.insert("removedLabelIds".into(), json!(patch.removed_label_ids));
    }
    if input.is_empty() {
        return Err(kanban::EMPTY_UPDATE_MESSAGE.into());
    }
    Ok(Value::Object(input))
}

pub(super) fn issue_create_input(
    input: KanbanIssueCreateInput,
    links: &ProjectLinks,
) -> Result<Value> {
    let mut fields = serde_json::Map::new();
    fields.insert("teamId".into(), json!(input.team_id));
    fields.insert("title".into(), json!(kanban::required_title(&input.title)?));
    if let Some(description) = kanban::trimmed(input.description.as_deref()) {
        fields.insert("description".into(), json!(description));
    }
    if let Some(state_id) = input.state_id {
        fields.insert("stateId".into(), json!(state_id));
    }
    if let Some(priority) = input.priority {
        fields.insert(
            "priority".into(),
            json!(kanban::validate_priority(priority)?),
        );
    }
    if let Some(project_id) = input.project_id {
        fields.insert(
            "projectId".into(),
            json!(links.linear_project_id(&project_id)?),
        );
    }
    if !input.label_ids.is_empty() {
        fields.insert("labelIds".into(), json!(input.label_ids));
    }
    if let Some(parent_id) = input.parent_id {
        fields.insert("parentId".into(), json!(parent_id));
    }
    Ok(Value::Object(fields))
}

pub(super) fn created_issue(payload: RawIssueCreate, links: &ProjectLinks) -> Result<KanbanIssue> {
    match payload.issue {
        Some(issue) if payload.success => Ok(map_issue(issue, links)),
        _ => Err(request_failed("L’issue n’a pas été créée.")),
    }
}

pub(super) fn applied_issue_update(
    update: RawIssueUpdate,
    links: &ProjectLinks,
) -> Result<KanbanIssueUpdate> {
    match update.issue {
        Some(issue) if update.success => Ok(map_update(issue, links)),
        _ => Err(request_failed(
            "La modification de l’issue n’a pas été appliquée.",
        )),
    }
}

pub(super) fn applied_description_update(
    payload: RawIssueDescriptionUpdate,
) -> Result<KanbanIssueDescriptionUpdate> {
    match payload.issue {
        Some(issue) if payload.success => Ok(issue),
        _ => Err(request_failed(
            "La description de l’issue n’a pas été modifiée.",
        )),
    }
}

pub(super) fn comment_create_input(issue_id: &str, body: &str) -> Result<Value> {
    let body = kanban::trimmed(Some(body)).ok_or(kanban::EMPTY_COMMENT_MESSAGE)?;
    Ok(json!({ "issueId": issue_id, "body": body }))
}

pub(super) fn created_comment(payload: RawCommentPayload) -> Result<KanbanComment> {
    match payload.comment {
        Some(comment) if payload.success => Ok(comment.into()),
        _ => Err(request_failed("Le commentaire n’a pas été créé.")),
    }
}

pub(super) fn updated_comment(payload: RawCommentPayload) -> Result<KanbanComment> {
    match payload.comment {
        Some(comment) if payload.success => Ok(comment.into()),
        _ => Err(request_failed("Le commentaire n’a pas été modifié.")),
    }
}

pub(super) fn confirmed(payload: RawSuccess, refusal: &str) -> Result<()> {
    if payload.success {
        Ok(())
    } else {
        Err(request_failed(refusal))
    }
}

pub(super) fn created_label(payload: RawLabelCreate) -> Result<KanbanLabel> {
    match payload.issue_label {
        Some(label) if payload.success => Ok(label),
        _ => Err(request_failed("Le label n’a pas été créé.")),
    }
}

pub(super) fn validate_image(content_type: &str, size: usize) -> Result<()> {
    if !content_type.starts_with("image/") || size == 0 {
        return Err(images::IMAGE_TYPE_MESSAGE.into());
    }
    if size > images::MAX_IMAGE_BYTES {
        return Err(images::IMAGE_TOO_LARGE_MESSAGE.into());
    }
    Ok(())
}

pub(super) fn upload_target(payload: RawFileUpload) -> Result<RawUploadFile> {
    match payload.upload_file {
        Some(file) if payload.success => Ok(file),
        _ => Err(request_failed("L’envoi de l’image a été refusé.")),
    }
}
