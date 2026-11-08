use super::{
    bool_at, malformed, nodes, str_at, string_at, text, typed, Check, CheckStatus, ChecksState,
    Cli, Commit, ForgeRemote, Label, MergeBlocker, MergeMethod, RequestAction, RequestDetail,
    RequestFilter, RequestState, RequestSummary, ReviewState, Reviewer, ReviewerState, PAGE_SIZE,
};
use crate::project_git::GitError;
use serde_json::Value;

const SETTINGS: &str =
    "mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge";
const SUMMARY: &str = "number title url isDraft state createdAt isCrossRepository headRefName baseRefName reviewDecision mergeable author { login } rollup: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";

pub(super) fn requests(
    cli: &Cli,
    remote: &ForgeRemote,
    filter: RequestFilter,
    search: &str,
) -> Result<Vec<RequestSummary>, GitError> {
    let data = cli.graphql(
        &format!("query($q: String!) {{ search(query: $q, type: ISSUE, first: {PAGE_SIZE}) {{ nodes {{ ... on PullRequest {{ {SUMMARY} }} }} }} }}"),
        vec![text("q", search_query(&remote.path, filter, search))],
    )?;
    Ok(nodes(&data, "/search/nodes")
        .iter()
        .filter(|node| node.get("number").is_some())
        .map(summary)
        .collect())
}

pub(super) fn request(
    cli: &Cli,
    remote: &ForgeRemote,
    number: u64,
) -> Result<RequestDetail, GitError> {
    let (owner, name) = split(remote);
    let data = cli.graphql(
        &format!(
            "query($owner: String!, $name: String!, $number: Int!) {{ repository(owner: $owner, name: $name) {{ {SETTINGS} pullRequest(number: $number) {{ {SUMMARY} body headRefOid baseRefOid mergeStateStatus changedFiles \
reviewRequests(first: 50) {{ nodes {{ requestedReviewer {{ ... on User {{ login }} ... on Bot {{ login }} ... on Mannequin {{ login }} ... on Team {{ name }} ... on EnterpriseTeam {{ name }} }} }} }} \
latestReviews(first: 50) {{ nodes {{ state author {{ login }} }} }} \
labels(first: 50) {{ nodes {{ name color }} }} \
commits(last: 100) {{ nodes {{ commit {{ oid messageHeadline authoredDate author {{ name user {{ login }} }} }} }} }} \
checks: commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{ contexts(first: 100) {{ nodes {{ __typename ... on CheckRun {{ name status conclusion detailsUrl }} ... on StatusContext {{ context state targetUrl }} }} }} }} }} }} }} }} }} }}"
        ),
        vec![text("owner", owner), text("name", name), typed("number", number)],
    )?;
    let repository = data
        .get("repository")
        .filter(|repository| !repository.is_null())
        .ok_or_else(|| malformed("dépôt"))?;
    let pull = repository
        .get("pullRequest")
        .filter(|pull| !pull.is_null())
        .ok_or_else(|| {
            GitError::new(
                "notFound",
                format!("La pull request #{number} est introuvable."),
            )
        })?;
    let (merge_methods, delete_branch_on_merge) = settings(repository);
    let summary = summary(pull);
    let mut reviewers: Vec<Reviewer> = Vec::new();
    for review in nodes(pull, "/latestReviews/nodes") {
        let state = match str_at(review, "/state") {
            "APPROVED" => ReviewerState::Approved,
            "CHANGES_REQUESTED" => ReviewerState::ChangesRequested,
            "COMMENTED" => ReviewerState::Commented,
            _ => continue,
        };
        add_reviewer(&mut reviewers, str_at(review, "/author/login"), state);
    }
    // A pending request supersedes an earlier review: the reviewer was asked again.
    for request in nodes(pull, "/reviewRequests/nodes") {
        let reviewer = &request["requestedReviewer"];
        let name = Some(str_at(reviewer, "/login"))
            .filter(|login| !login.is_empty())
            .unwrap_or_else(|| str_at(reviewer, "/name"));
        add_reviewer(&mut reviewers, name, ReviewerState::Requested);
    }
    let check_runs = nodes(
        pull,
        "/checks/nodes/0/commit/statusCheckRollup/contexts/nodes",
    )
    .iter()
    .map(check)
    .collect();
    Ok(RequestDetail {
        merge_blockers: blockers(
            summary.state,
            summary.draft,
            str_at(pull, "/mergeable"),
            str_at(pull, "/mergeStateStatus"),
            str_at(pull, "/reviewDecision"),
            str_at(pull, "/rollup/nodes/0/commit/statusCheckRollup/state"),
        ),
        delete_source_branch: delete_branch_on_merge && !summary.cross_repository,
        changed_files: pull
            .get("changedFiles")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        repository: remote.repository(),
        merge_methods,
        body: string_at(pull, "/body"),
        head_oid: string_at(pull, "/headRefOid"),
        base_oid: string_at(pull, "/baseRefOid"),
        reviewers,
        labels: nodes(pull, "/labels/nodes")
            .iter()
            .map(|label| Label {
                name: string_at(label, "/name"),
                color: Some(str_at(label, "/color"))
                    .filter(|color| !color.is_empty())
                    .map(|color| format!("#{color}")),
            })
            .collect(),
        check_runs,
        commits: nodes(pull, "/commits/nodes")
            .iter()
            .map(|node| {
                let commit = &node["commit"];
                let login = str_at(commit, "/author/user/login");
                Commit {
                    oid: string_at(commit, "/oid"),
                    title: string_at(commit, "/messageHeadline"),
                    author: if login.is_empty() {
                        string_at(commit, "/author/name")
                    } else {
                        login.to_owned()
                    },
                    date: string_at(commit, "/authoredDate"),
                }
            })
            .collect(),
        summary,
    })
}

pub(super) fn merge(
    cli: &Cli,
    remote: &ForgeRemote,
    number: u64,
    method: MergeMethod,
    head_oid: &str,
) -> Result<(), GitError> {
    let method = match method {
        MergeMethod::Merge => "merge",
        MergeMethod::Squash => "squash",
        MergeMethod::Rebase => "rebase",
    };
    let response = cli.send(
        "PUT",
        &format!("repos/{}/pulls/{number}/merge", remote.path),
        &[text("merge_method", method), text("sha", head_oid)],
    )?;
    if response.get("merged").and_then(Value::as_bool) == Some(false) {
        return Err(GitError::new(
            "forge",
            Some(str_at(&response, "/message"))
                .filter(|message| !message.is_empty())
                .unwrap_or("La pull request n’a pas été fusionnée."),
        ));
    }
    Ok(())
}

pub(super) fn update(
    cli: &Cli,
    remote: &ForgeRemote,
    number: u64,
    action: RequestAction,
) -> Result<(), GitError> {
    let state = match action {
        RequestAction::Close => "closed",
        RequestAction::Reopen => "open",
        RequestAction::Ready => {
            let (owner, name) = split(remote);
            let data = cli.graphql(
                "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }",
                vec![text("owner", owner), text("name", name), typed("number", number)],
            )?;
            let id = str_at(&data, "/repository/pullRequest/id");
            if id.is_empty() {
                return Err(GitError::new(
                    "notFound",
                    format!("La pull request #{number} est introuvable."),
                ));
            }
            cli.graphql(
                "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
                vec![text("id", id)],
            )?;
            return Ok(());
        }
    };
    cli.send(
        "PATCH",
        &format!("repos/{}/pulls/{number}", remote.path),
        &[text("state", state)],
    )?;
    Ok(())
}

fn split(remote: &ForgeRemote) -> (&str, &str) {
    remote.path.split_once('/').unwrap_or((&remote.path, ""))
}

fn settings(repository: &Value) -> (Vec<MergeMethod>, bool) {
    let allowed = |field: &str| repository.get(field).and_then(Value::as_bool) != Some(false);
    let mut methods = [
        ("mergeCommitAllowed", MergeMethod::Merge),
        ("squashMergeAllowed", MergeMethod::Squash),
        ("rebaseMergeAllowed", MergeMethod::Rebase),
    ]
    .into_iter()
    .filter(|(field, _)| allowed(field))
    .map(|(_, method)| method)
    .collect::<Vec<_>>();
    if methods.is_empty() {
        methods.push(MergeMethod::Merge);
    }
    (methods, bool_at(repository, "/deleteBranchOnMerge"))
}

/// Search qualifiers scoping the results to the repository; the user's own scoping ones are dropped.
pub(super) fn search_query(path: &str, filter: RequestFilter, search: &str) -> String {
    let filter = match filter {
        RequestFilter::Open => "is:open",
        RequestFilter::Mine => "is:open author:@me",
        RequestFilter::Review => "is:open review-requested:@me",
        RequestFilter::Closed => "is:closed",
    };
    let mut query = format!("repo:{path} is:pr {filter} sort:created-desc");
    for word in search.split_whitespace() {
        let lower = word.trim_start_matches('-').to_ascii_lowercase();
        if ["repo:", "org:", "user:", "owner:", "is:", "sort:"]
            .iter()
            .any(|qualifier| lower.starts_with(qualifier))
        {
            continue;
        }
        query.push(' ');
        query.push_str(word);
    }
    query
}

fn summary(pull: &Value) -> RequestSummary {
    RequestSummary {
        number: pull.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: string_at(pull, "/title"),
        author: Some(str_at(pull, "/author/login"))
            .filter(|login| !login.is_empty())
            .unwrap_or("ghost")
            .to_owned(),
        source_branch: string_at(pull, "/headRefName"),
        target_branch: string_at(pull, "/baseRefName"),
        cross_repository: bool_at(pull, "/isCrossRepository"),
        draft: bool_at(pull, "/isDraft"),
        state: match str_at(pull, "/state") {
            "MERGED" => RequestState::Merged,
            "CLOSED" => RequestState::Closed,
            _ => RequestState::Open,
        },
        checks: match str_at(pull, "/rollup/nodes/0/commit/statusCheckRollup/state") {
            "SUCCESS" => Some(ChecksState::Success),
            "FAILURE" | "ERROR" => Some(ChecksState::Failure),
            "PENDING" | "EXPECTED" => Some(ChecksState::Pending),
            _ => None,
        },
        review: match str_at(pull, "/reviewDecision") {
            "APPROVED" => Some(ReviewState::Approved),
            "CHANGES_REQUESTED" => Some(ReviewState::ChangesRequested),
            "REVIEW_REQUIRED" => Some(ReviewState::ReviewRequired),
            _ => None,
        },
        conflicts: str_at(pull, "/mergeable") == "CONFLICTING",
        created_at: string_at(pull, "/createdAt"),
        url: string_at(pull, "/url"),
    }
}

fn check(context: &Value) -> Check {
    if str_at(context, "/__typename") == "StatusContext" {
        return Check {
            name: string_at(context, "/context"),
            status: match str_at(context, "/state") {
                "SUCCESS" => CheckStatus::Success,
                "FAILURE" | "ERROR" => CheckStatus::Failure,
                _ => CheckStatus::Pending,
            },
            url: Some(string_at(context, "/targetUrl")).filter(|url| !url.is_empty()),
        };
    }
    Check {
        name: string_at(context, "/name"),
        status: if str_at(context, "/status") != "COMPLETED" {
            CheckStatus::Pending
        } else {
            match str_at(context, "/conclusion") {
                "SUCCESS" => CheckStatus::Success,
                "SKIPPED" => CheckStatus::Skipped,
                "NEUTRAL" | "STALE" => CheckStatus::Neutral,
                _ => CheckStatus::Failure,
            }
        },
        url: Some(string_at(context, "/detailsUrl")).filter(|url| !url.is_empty()),
    }
}

fn add_reviewer(reviewers: &mut Vec<Reviewer>, name: &str, state: ReviewerState) {
    if name.is_empty() {
        return;
    }
    match reviewers.iter_mut().find(|reviewer| reviewer.name == name) {
        Some(reviewer) => reviewer.state = state,
        None => reviewers.push(Reviewer {
            name: name.into(),
            state,
        }),
    }
}

/// Why GitHub would refuse the merge now, from its mergeability fields.
pub(super) fn blockers(
    state: RequestState,
    draft: bool,
    mergeable: &str,
    merge_state: &str,
    review: &str,
    checks: &str,
) -> Vec<MergeBlocker> {
    if state != RequestState::Open {
        return Vec::new();
    }
    let mut blockers = Vec::new();
    if draft || merge_state == "DRAFT" {
        blockers.push(MergeBlocker::Draft);
    }
    if mergeable == "CONFLICTING" || merge_state == "DIRTY" {
        blockers.push(MergeBlocker::Conflicts);
    }
    match merge_state {
        "BLOCKED" => {
            let approvals = matches!(review, "REVIEW_REQUIRED" | "CHANGES_REQUESTED");
            let failing = matches!(checks, "FAILURE" | "ERROR" | "PENDING" | "EXPECTED");
            if approvals {
                blockers.push(MergeBlocker::Approvals);
            }
            if failing {
                blockers.push(MergeBlocker::Checks);
            }
            if !approvals && !failing && blockers.is_empty() {
                blockers.push(MergeBlocker::Blocked);
            }
        }
        "BEHIND" => blockers.push(MergeBlocker::Behind),
        _ => {}
    }
    if blockers.is_empty() && (merge_state == "UNKNOWN" || mergeable == "UNKNOWN") {
        blockers.push(MergeBlocker::Unknown);
    }
    blockers
}
