pub(super) const VIEWER_QUERY: &str = "query LinearViewer { viewer { id } }";
pub(super) const TEAMS_QUERY: &str = r#"
query LinearTeams {
  teams(first: 250) { nodes { id key name } }
}
"#;
// `concat!` only accepts literals, so the shared issue selection is a macro rather than a const.
macro_rules! board_issue_fragment {
    () => {
        r#"
fragment LinearBoardIssue on Issue {
  id identifier title url priority createdAt updatedAt
  state { id }
  assignee { name }
  project { id name color }
  labelIds
  labels(first: 20) { nodes { id name color } }
  attachments(first: 10) { nodes { url sourceType } }
}
"#
    };
}
pub(super) const TEAM_BOARD_QUERY: &str = concat!(
    r#"
query LinearTeamBoard($id: String!, $after: String) {
  team(id: $id) {
    states(first: 250) { nodes { id name type color position } }
    issues(first: 100, after: $after, orderBy: updatedAt) {
      nodes { ...LinearBoardIssue }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#,
    board_issue_fragment!()
);
pub(super) const CREATE_ISSUE_MUTATION: &str = concat!(
    r#"
mutation LinearCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { ...LinearBoardIssue }
  }
}
"#,
    board_issue_fragment!()
);
pub(super) const ISSUE_PLACEMENT_QUERY: &str = r#"
query LinearIssuePlacement($id: String!) {
  issue(id: $id) { team { id } project { id } }
}
"#;
pub(super) const PROJECT_TEAMS_QUERY: &str = r#"
query LinearProjectTeams($id: String!) {
  project(id: $id) { teams(first: 1) { nodes { id } } }
}
"#;
// shortcut: only a project's first 10 teams are listed, without paging; page them if projects shared by more teams appear.
pub(super) const PROJECTS_QUERY: &str = r#"
query LinearProjects($after: String) {
  projects(first: 250, after: $after) {
    nodes { id name teams(first: 10) { nodes { id key name } } }
    pageInfo { hasNextPage endCursor }
  }
}
"#;
pub(super) const UPDATE_ISSUE_MUTATION: &str = r#"
mutation LinearUpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id title url priority updatedAt
      state { id }
      assignee { name }
      project { id name color }
      labelIds
      labels(first: 50) { nodes { id name color } }
    }
  }
}
"#;
pub(super) const UPDATE_ISSUE_DESCRIPTION_MUTATION: &str = r#"
mutation LinearUpdateIssueDescription($id: String!, $description: String!) {
  issueUpdate(id: $id, input: { description: $description }) {
    success
    issue { id description updatedAt }
  }
}
"#;
pub(super) const CREATE_COMMENT_MUTATION: &str = r#"
mutation LinearCreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body createdAt user { name } }
  }
}
"#;
pub(super) const DELETE_COMMENT_MUTATION: &str = r#"
mutation LinearDeleteComment($id: String!) {
  commentDelete(id: $id) { success }
}
"#;
pub(super) const ISSUE_COMMENT_QUERY: &str = r#"
query LinearIssueComment($id: String!, $commentId: ID!) {
  issue(id: $id) {
    comments(first: 1, filter: { id: { eq: $commentId } }) { nodes { body } }
  }
}
"#;
pub(super) const UPDATE_COMMENT_MUTATION: &str = r#"
mutation LinearUpdateComment($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) {
    success
    comment { id body createdAt user { name } }
  }
}
"#;
pub(super) const ISSUE_WORKFLOW_QUERY: &str = r#"
query LinearIssueWorkflow($id: String!) {
  issue(id: $id) {
    state { id type }
    team { states(first: 250) { nodes { id name type color position } } }
  }
}
"#;
pub(super) const DELETE_ISSUE_MUTATION: &str = r#"
mutation LinearDeleteIssue($id: String!) {
  issueDelete(id: $id) { success }
}
"#;
pub(super) const FILE_UPLOAD_MUTATION: &str = r#"
mutation LinearFileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}
"#;
pub(super) const TEAM_LABELS_QUERY: &str = r#"
query LinearTeamLabels($teamId: ID!, $after: String) {
  issueLabels(
    first: 250
    after: $after
    filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }
  ) {
    nodes { id name color isGroup }
    pageInfo { hasNextPage endCursor }
  }
}
"#;
pub(super) const CREATE_LABEL_MUTATION: &str = r#"
mutation LinearCreateLabel($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel { id name color }
  }
}
"#;
pub(super) const LABELS_BY_ID_QUERY: &str = r#"
query LinearLabelsById($ids: [ID!]!, $first: Int!) {
  issueLabels(first: $first, includeArchived: true, filter: { id: { in: $ids } }) {
    nodes { id name color }
  }
}
"#;
pub(super) const ISSUE_DETAIL_QUERY: &str = r#"
query LinearIssueDetail($id: String!) {
  issue(id: $id) {
    id identifier title url description branchName priority createdAt updatedAt
    state { id }
    team { id }
    assignee { name }
    project { id name color }
    labelIds
    labels(first: 50) { nodes { id name color } }
    children(first: 100) {
      nodes { id identifier title state { id name type color } }
      pageInfo { hasNextPage endCursor }
    }
    comments(first: 100) {
      nodes { id body createdAt user { name } }
      pageInfo { hasNextPage endCursor }
    }
    attachments(first: 10) { nodes { url sourceType } }
  }
}
"#;
pub(super) const ISSUE_CHILDREN_QUERY: &str = r#"
query LinearIssueChildren($id: String!, $after: String!) {
  issue(id: $id) {
    children(first: 100, after: $after) {
      nodes { id identifier title state { id name type color } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;
pub(super) const ISSUE_COMMENTS_QUERY: &str = r#"
query LinearIssueComments($id: String!, $after: String!) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes { id body createdAt user { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;
