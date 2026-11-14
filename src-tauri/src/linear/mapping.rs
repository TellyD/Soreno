use super::{
    responses::{RawAttachment, RawComment, RawIssue, RawIssueDetail, RawUpdatedIssue},
    ProjectLinks,
};
use crate::kanban::{
    self, KanbanComment, KanbanIssue, KanbanIssueDetail, KanbanIssueUpdate, KanbanLabel,
    KanbanLinearFields, KanbanPullRequest, KanbanSource, KanbanSubIssue,
};

fn attachment_pull_requests(attachments: &[RawAttachment]) -> Vec<KanbanPullRequest> {
    // API-created attachments can point into a PR (e.g. a comment) without being that PR.
    kanban::extract_pull_requests(
        attachments
            .iter()
            .filter(|attachment| {
                matches!(attachment.source_type.as_deref(), Some("github" | "gitlab"))
            })
            .map(|attachment| attachment.url.as_str()),
    )
}

fn sorted_labels(mut labels: Vec<KanbanLabel>) -> Vec<KanbanLabel> {
    labels.sort_by(|left, right| kanban::compare_names(&left.name, &right.name));
    labels
}

pub(super) fn map_issue(raw: RawIssue, links: &ProjectLinks) -> KanbanIssue {
    KanbanIssue {
        source: KanbanSource::Linear,
        pull_requests: attachment_pull_requests(&raw.attachments.nodes),
        project: links.project(raw.project.as_ref()),
        id: raw.id,
        identifier: raw.identifier,
        title: raw.title,
        priority: normalize_priority(raw.priority),
        state_id: raw.state.id,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        labels: sorted_labels(raw.labels.nodes),
        linear: Some(KanbanLinearFields {
            url: raw.url,
            assignee: raw.assignee,
            linear_project: raw.project,
        }),
    }
}

pub(super) fn map_update(raw: RawUpdatedIssue, links: &ProjectLinks) -> KanbanIssueUpdate {
    KanbanIssueUpdate {
        project: links.project(raw.project.as_ref()),
        id: raw.id,
        title: raw.title,
        state_id: raw.state.id,
        priority: normalize_priority(raw.priority),
        labels: sorted_labels(raw.labels.nodes),
        updated_at: raw.updated_at,
        linear: Some(KanbanLinearFields {
            url: raw.url,
            assignee: raw.assignee,
            linear_project: raw.project,
        }),
    }
}

pub(super) fn map_issue_detail(
    raw: RawIssueDetail,
    more_children: Vec<KanbanSubIssue>,
    more_comments: Vec<RawComment>,
    links: &ProjectLinks,
) -> KanbanIssueDetail {
    let mut children = raw.children.nodes;
    children.extend(more_children);
    let mut comments: Vec<KanbanComment> = raw
        .comments
        .nodes
        .into_iter()
        .chain(more_comments)
        .map(KanbanComment::from)
        .collect();
    // Linear returns uniform ISO-8601 UTC timestamps, so string order is chronological.
    comments.sort_by(|left, right| left.created_at.cmp(&right.created_at));

    KanbanIssueDetail {
        source: KanbanSource::Linear,
        pull_requests: attachment_pull_requests(&raw.attachments.nodes),
        team_id: Some(raw.team.id),
        project: links.project(raw.project.as_ref()),
        id: raw.id,
        identifier: raw.identifier,
        title: raw.title,
        description: raw.description,
        branch_name: raw.branch_name,
        priority: normalize_priority(raw.priority),
        state_id: raw.state.id,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        labels: sorted_labels(raw.labels.nodes),
        children,
        comments,
        linear: Some(KanbanLinearFields {
            url: raw.url,
            assignee: raw.assignee,
            linear_project: raw.project,
        }),
    }
}

fn normalize_priority(priority: f64) -> u8 {
    priority.round().clamp(0.0, 4.0) as u8
}
