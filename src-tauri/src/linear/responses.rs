use super::LinearProjectSummary;
use crate::kanban::{
    KanbanComment, KanbanIssueDescriptionUpdate, KanbanLabel, KanbanLinearProjectRef,
    KanbanSubIssue, KanbanTeam, KanbanUserRef, KanbanWorkflowState,
};
use serde::{de::IgnoredAny, Deserialize};

#[derive(Debug, Deserialize)]
pub(super) struct GraphqlResponse<T> {
    pub(super) data: Option<T>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Connection<T> {
    pub(super) nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Page<T> {
    pub(super) nodes: Vec<T>,
    pub(super) page_info: RawPageInfo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawPageInfo {
    pub(super) has_next_page: bool,
    pub(super) end_cursor: Option<String>,
}

impl RawPageInfo {
    pub(super) fn take_next_cursor(&mut self) -> Option<String> {
        self.end_cursor.take().filter(|_| self.has_next_page)
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct TeamsData {
    pub(super) teams: Connection<KanbanTeam>,
}

#[derive(Debug, Deserialize)]
pub(super) struct OrganizationData {
    pub(super) organization: RawOrganization,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawOrganization {
    pub(super) id: String,
    pub(super) name: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct OwnerData {
    issues: Connection<IgnoredAny>,
    teams: Connection<IgnoredAny>,
    projects: Connection<IgnoredAny>,
    comments: Connection<IgnoredAny>,
}

impl OwnerData {
    pub(super) fn holds(&self) -> bool {
        [&self.issues, &self.teams, &self.projects, &self.comments]
            .iter()
            .any(|connection| !connection.nodes.is_empty())
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectsData {
    pub(super) projects: Page<RawProject>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawProject {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) teams: Connection<KanbanTeam>,
}

impl RawProject {
    pub(super) fn summary(self, workspace: &str) -> LinearProjectSummary {
        LinearProjectSummary {
            id: self.id,
            name: self.name,
            teams: self.teams.nodes.into_iter().map(|team| team.name).collect(),
            workspace: workspace.to_owned(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectIdsData {
    pub(super) projects: Connection<RawIdRef>,
}

#[derive(Debug, Deserialize)]
pub(super) struct TeamBoardData {
    pub(super) team: RawTeamBoard,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawTeamBoard {
    pub(super) states: Connection<KanbanWorkflowState>,
    pub(super) members: Connection<KanbanUserRef>,
    pub(super) issues: Page<RawIssue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawIssue {
    pub(super) id: String,
    pub(super) identifier: String,
    pub(super) title: String,
    pub(super) url: String,
    pub(super) priority: f64,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) state: RawIdRef,
    pub(super) assignee: Option<KanbanUserRef>,
    pub(super) project: Option<KanbanLinearProjectRef>,
    pub(super) label_ids: Vec<String>,
    pub(super) labels: Connection<KanbanLabel>,
    pub(super) attachments: Connection<RawAttachment>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIdRef {
    pub(super) id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawAttachment {
    pub(super) url: String,
    pub(super) source_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct IssuePlacementData {
    pub(super) issue: RawIssuePlacement,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIssuePlacement {
    pub(super) team: RawIdRef,
    pub(super) project: Option<RawIdRef>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectTeamsData {
    pub(super) project: RawProjectTeams,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawProjectTeams {
    pub(super) teams: Connection<RawIdRef>,
}

#[derive(Debug, Deserialize)]
pub(super) struct IssueDetailData {
    pub(super) issue: RawIssueDetail,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawIssueDetail {
    pub(super) id: String,
    pub(super) identifier: String,
    pub(super) title: String,
    pub(super) url: String,
    pub(super) description: Option<String>,
    pub(super) branch_name: String,
    pub(super) priority: f64,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) state: RawIdRef,
    pub(super) team: RawIdRef,
    pub(super) assignee: Option<KanbanUserRef>,
    pub(super) project: Option<KanbanLinearProjectRef>,
    pub(super) label_ids: Vec<String>,
    pub(super) labels: Connection<KanbanLabel>,
    pub(super) children: Page<KanbanSubIssue>,
    pub(super) comments: Page<RawComment>,
    pub(super) attachments: Connection<RawAttachment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawComment {
    pub(super) id: String,
    pub(super) body: String,
    pub(super) created_at: String,
    pub(super) user: Option<KanbanUserRef>,
}

impl From<RawComment> for KanbanComment {
    fn from(comment: RawComment) -> Self {
        Self {
            id: comment.id,
            body: comment.body,
            created_at: comment.created_at,
            user: Some(comment.user),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct IssueConnectionData<T> {
    pub(super) issue: T,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIssueChildren {
    pub(super) children: Page<KanbanSubIssue>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIssueComments {
    pub(super) comments: Page<RawComment>,
}

#[derive(Debug, Deserialize)]
pub(super) struct IssueWorkflowData {
    pub(super) issue: RawIssueWorkflow,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIssueWorkflow {
    pub(super) state: RawWorkflowStateRef,
    pub(super) team: RawTeamStates,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawWorkflowStateRef {
    pub(super) id: String,
    pub(super) r#type: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawTeamStates {
    pub(super) states: Connection<KanbanWorkflowState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueUpdateData {
    pub(super) issue_update: RawIssueUpdate,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIssueUpdate {
    pub(super) success: bool,
    pub(super) issue: Option<RawUpdatedIssue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawUpdatedIssue {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) url: String,
    pub(super) priority: f64,
    pub(super) updated_at: String,
    pub(super) state: RawIdRef,
    pub(super) assignee: Option<KanbanUserRef>,
    pub(super) project: Option<KanbanLinearProjectRef>,
    pub(super) label_ids: Vec<String>,
    pub(super) labels: Connection<KanbanLabel>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueDescriptionUpdateData {
    pub(super) issue_update: RawIssueDescriptionUpdate,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIssueDescriptionUpdate {
    pub(super) success: bool,
    pub(super) issue: Option<KanbanIssueDescriptionUpdate>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueCreateData {
    pub(super) issue_create: RawIssueCreate,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIssueCreate {
    pub(super) success: bool,
    pub(super) issue: Option<RawIssue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommentCreateData {
    pub(super) comment_create: RawCommentPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommentUpdateData {
    pub(super) comment_update: RawCommentPayload,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawCommentPayload {
    pub(super) success: bool,
    pub(super) comment: Option<RawComment>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawCommentBody {
    pub(super) body: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawIssueComment {
    pub(super) comments: Connection<RawCommentBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueDeleteData {
    pub(super) issue_delete: RawSuccess,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommentDeleteData {
    pub(super) comment_delete: RawSuccess,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawSuccess {
    pub(super) success: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileUploadData {
    pub(super) file_upload: RawFileUpload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawFileUpload {
    pub(super) success: bool,
    pub(super) upload_file: Option<RawUploadFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawUploadFile {
    pub(super) upload_url: String,
    pub(super) asset_url: String,
    pub(super) headers: Vec<RawUploadHeader>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RawUploadHeader {
    pub(super) key: String,
    pub(super) value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueLabelsData {
    pub(super) issue_labels: Page<RawLabel>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LabelNodesData {
    pub(super) issue_labels: Connection<KanbanLabel>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawLabel {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) color: String,
    pub(super) is_group: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LabelCreateData {
    pub(super) issue_label_create: RawLabelCreate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawLabelCreate {
    pub(super) success: bool,
    pub(super) issue_label: Option<KanbanLabel>,
}
