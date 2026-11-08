use super::{
    bool_at, nodes, str_at, string_at, text, typed, Check, CheckStatus, ChecksState, Cli, Commit,
    ForgeRemote, Label, MergeBlocker, MergeMethod, RequestAction, RequestDetail, RequestFilter,
    RequestState, RequestSummary, ReviewState, Reviewer, ReviewerState, PAGE_SIZE,
};
use crate::project_git::GitError;
use serde_json::Value;

const SUMMARY: &str = "iid title webUrl draft state createdAt sourceBranch targetBranch conflicts sourceProjectId targetProjectId author { username } headPipeline { status } approved approvalsLeft approvedBy { count } changeRequesters { count }";
const RECHECK_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

fn settings(cli: &Cli, remote: &ForgeRemote) -> Result<(Vec<MergeMethod>, bool), GitError> {
    let project = cli.get(&format!("projects/{}", encode(&remote.path)))?;
    let methods = match str_at(&project, "/squash_option") {
        "never" => vec![MergeMethod::Merge],
        "always" => vec![MergeMethod::Squash],
        _ => vec![MergeMethod::Merge, MergeMethod::Squash],
    };
    Ok((
        methods,
        bool_at(&project, "/remove_source_branch_after_merge"),
    ))
}

pub(super) fn requests(
    cli: &Cli,
    remote: &ForgeRemote,
    filter: RequestFilter,
    search: &str,
) -> Result<Vec<RequestSummary>, GitError> {
    let mut variables = vec![text("path", &remote.path)];
    if !search.is_empty() {
        variables.push(text("search", search));
    }
    let states: &[&str] = match filter {
        RequestFilter::Open => &["opened"],
        RequestFilter::Mine => {
            variables.push(text("author", username(cli)?));
            &["opened"]
        }
        RequestFilter::Review => {
            variables.push(text("reviewer", username(cli)?));
            &["opened"]
        }
        RequestFilter::Closed => &["closed", "merged"],
    };
    let fields: String = states
        .iter()
        .map(|state| format!("{state}: mergeRequests(state: {state}, authorUsername: $author, reviewerUsername: $reviewer, search: $search, sort: CREATED_DESC, first: {PAGE_SIZE}) {{ nodes {{ {SUMMARY} }} }} "))
        .collect();
    let data = cli.graphql(
        &format!("query($path: ID!, $author: String, $reviewer: String, $search: String) {{ currentUser {{ username }} project(fullPath: $path) {{ {fields}}} }}"),
        variables,
    )?;
    // Anonymous requests read public projects: the login is checked with the list.
    if str_at(&data, "/currentUser/username").is_empty() {
        return Err(unauthenticated());
    }
    let project = project(&data)?;
    let mut requests: Vec<RequestSummary> = states
        .iter()
        .flat_map(|state| {
            nodes(project, &format!("/{state}/nodes"))
                .iter()
                .map(summary)
        })
        .collect();
    requests.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    requests.truncate(PAGE_SIZE);
    Ok(requests)
}

pub(super) fn request(
    cli: &Cli,
    remote: &ForgeRemote,
    number: u64,
) -> Result<RequestDetail, GitError> {
    let (data, settings) = std::thread::scope(|scope| {
        let settings = scope.spawn(|| settings(cli, remote));
        let data = cli.graphql(
            &format!(
                "query($path: ID!, $iid: String!) {{ project(fullPath: $path) {{ onlyAllowMergeIfPipelineSucceeds mergeRequest(iid: $iid) {{ {SUMMARY} description detailedMergeStatus forceRemoveSourceBranch squashOnMerge diffStatsSummary {{ fileCount }} \
diffRefs {{ baseSha headSha }} \
reviewers {{ nodes {{ username mergeRequestInteraction {{ reviewState }} }} }} \
approvedBy {{ nodes {{ username }} }} \
labels {{ nodes {{ title color }} }} \
commits(first: 100) {{ nodes {{ sha title authorName authoredDate }} }} \
headPipeline {{ jobs(first: 100) {{ nodes {{ name status webPath }} }} }} }} }} }}"
            ),
            vec![text("path", &remote.path), text("iid", number)],
        );
        (data, settings.join())
    });
    let data = data?;
    let request = merge_request(&data, number)?;
    let (mut merge_methods, _) =
        settings.unwrap_or_else(|panic| std::panic::resume_unwind(panic))?;
    // The merge request's own squash choice, as GitLab's merge widget preselects it.
    if bool_at(request, "/squashOnMerge") {
        merge_methods.sort_by_key(|method| *method != MergeMethod::Squash);
    }
    let summary = summary(request);
    let mut reviewers: Vec<Reviewer> = nodes(request, "/reviewers/nodes")
        .iter()
        .map(|reviewer| Reviewer {
            name: string_at(reviewer, "/username"),
            state: match str_at(reviewer, "/mergeRequestInteraction/reviewState") {
                "APPROVED" => ReviewerState::Approved,
                "REQUESTED_CHANGES" => ReviewerState::ChangesRequested,
                "REVIEWED" => ReviewerState::Commented,
                _ => ReviewerState::Requested,
            },
        })
        .collect();
    for approver in nodes(request, "/approvedBy/nodes") {
        let name = str_at(approver, "/username");
        match reviewers.iter_mut().find(|reviewer| reviewer.name == name) {
            Some(reviewer) => reviewer.state = ReviewerState::Approved,
            None if !name.is_empty() => reviewers.push(Reviewer {
                name: name.into(),
                state: ReviewerState::Approved,
            }),
            None => {}
        }
    }
    let host = format!("https://{}", remote.host);
    let mut commits: Vec<Commit> = nodes(request, "/commits/nodes")
        .iter()
        .map(|commit| Commit {
            oid: string_at(commit, "/sha"),
            title: string_at(commit, "/title"),
            author: string_at(commit, "/authorName"),
            date: string_at(commit, "/authoredDate"),
        })
        .collect();
    // GitLab lists the newest commit first.
    commits.reverse();
    Ok(RequestDetail {
        merge_blockers: blockers(
            summary.state,
            summary.draft,
            summary.conflicts,
            &merge_status(cli, remote, number, request),
            bool_at(&data, "/project/onlyAllowMergeIfPipelineSucceeds")
                && matches!(
                    summary.checks,
                    Some(ChecksState::Failure | ChecksState::Pending)
                ),
            summary.review == Some(ReviewState::ReviewRequired),
        ),
        merge_methods,
        delete_source_branch: bool_at(request, "/forceRemoveSourceBranch"),
        changed_files: request
            .pointer("/diffStatsSummary/fileCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        repository: remote.repository(),
        body: string_at(request, "/description"),
        head_oid: string_at(request, "/diffRefs/headSha"),
        base_oid: string_at(request, "/diffRefs/baseSha"),
        reviewers,
        labels: nodes(request, "/labels/nodes")
            .iter()
            .map(|label| Label {
                name: string_at(label, "/title"),
                color: Some(string_at(label, "/color")).filter(|color| color.starts_with('#')),
            })
            .collect(),
        check_runs: nodes(request, "/headPipeline/jobs/nodes")
            .iter()
            .map(|job| Check {
                name: string_at(job, "/name"),
                status: match str_at(job, "/status") {
                    "SUCCESS" => CheckStatus::Success,
                    "FAILED" => CheckStatus::Failure,
                    "SKIPPED" => CheckStatus::Skipped,
                    "CANCELED" | "CANCELING" | "MANUAL" => CheckStatus::Neutral,
                    _ => CheckStatus::Pending,
                },
                url: Some(str_at(job, "/webPath"))
                    .filter(|path| path.starts_with('/'))
                    .map(|path| format!("{host}{path}")),
            })
            .collect(),
        commits,
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
    let request = format!("projects/{}/merge_requests/{number}", encode(&remote.path));
    // GitLab 401s when the user may not merge (protected branch); the reads proved the login.
    let refused = |error: GitError| {
        if error.code == "unauthenticated" {
            GitError::new(
                "forge",
                "GitLab a refusé la fusion : ce compte n’a pas le droit de fusionner cette merge request.",
            )
        } else {
            error
        }
    };
    // The merge endpoint ignores `squash=false`, so a squash flag set on the MR would still apply.
    let unsquashed = method == MergeMethod::Merge
        && cli.get(&request)?.get("squash").and_then(Value::as_bool) == Some(true);
    if unsquashed {
        // shortcut: if this update applies but its response is lost (timeout), squash stays off without a restore; restore on uncertain failures if users report it.
        cli.send("PUT", &request, &[typed("squash", false)])
            .map_err(refused)?;
    }
    // The source branch removal follows the merge request's own setting, which defaults to the project's.
    let merged = cli.send(
        "PUT",
        &format!("{request}/merge"),
        &[
            text("sha", head_oid),
            typed("squash", method == MergeMethod::Squash),
        ],
    );
    if let Err(mut error) = merged.map_err(refused) {
        // shortcut: when the restore fails with a rate-limit/forbidden code, the UI shows that state and drops this note; the MR keeps squash off. Surface it if users report it.
        // After a network error the merge may have happened, so the flag is left as is.
        if unsquashed
            && error.code != "network"
            && cli.send("PUT", &request, &[typed("squash", true)]).is_err()
        {
            error
                .message
                .push_str(" Le réglage de squash de la merge request n’a pas pu être restauré.");
        }
        return Err(error);
    }
    Ok(())
}

pub(super) fn update(
    cli: &Cli,
    remote: &ForgeRemote,
    number: u64,
    action: RequestAction,
) -> Result<(), GitError> {
    let event = match action {
        RequestAction::Close => "close",
        RequestAction::Reopen => "reopen",
        RequestAction::Ready => {
            let data = cli.graphql(
                "mutation($path: ID!, $iid: String!) { mergeRequestSetDraft(input: { projectPath: $path, iid: $iid, draft: false }) { errors } }",
                vec![text("path", &remote.path), text("iid", number)],
            )?;
            let errors = nodes(&data, "/mergeRequestSetDraft/errors")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            if !errors.is_empty() {
                return Err(GitError::new("forge", errors.join(" ")));
            }
            return Ok(());
        }
    };
    cli.send(
        "PUT",
        &format!("projects/{}/merge_requests/{number}", encode(&remote.path)),
        &[text("state_event", event)],
    )?;
    Ok(())
}

/// GitLab only computes an idle merge request's status when asked, as its web page does on open:
/// request the recheck, then read the result once it had a moment to run unless it is already known.
fn merge_status(cli: &Cli, remote: &ForgeRemote, number: u64, request: &Value) -> String {
    let pending = |status: &str| matches!(status, "" | "UNCHECKED" | "CHECKING");
    let status = str_at(request, "/detailedMergeStatus");
    if !pending(status) {
        return status.into();
    }
    let endpoint = format!("projects/{}/merge_requests/{number}", encode(&remote.path));
    let read = |endpoint: &str| {
        cli.get(endpoint)
            .ok()
            .map(|request| str_at(&request, "/detailed_merge_status").to_ascii_uppercase())
    };
    match read(&format!("{endpoint}?with_merge_status_recheck=true")) {
        None => return status.into(),
        Some(rechecked) if !pending(&rechecked) => return rechecked,
        Some(_) => {}
    }
    std::thread::sleep(RECHECK_DELAY);
    read(&endpoint).unwrap_or_else(|| status.into())
}

fn username(cli: &Cli) -> Result<String, GitError> {
    let user = cli.get("user")?;
    Some(string_at(&user, "/username"))
        .filter(|name| !name.is_empty())
        .ok_or_else(unauthenticated)
}

fn unauthenticated() -> GitError {
    GitError::new(
        "unauthenticated",
        "La CLI de la forge n’est pas connectée à ce compte.",
    )
}

fn project(data: &Value) -> Result<&Value, GitError> {
    data.get("project")
        .filter(|project| !project.is_null())
        .ok_or_else(|| {
            GitError::new(
                "forbidden",
                "Dépôt introuvable ou accès refusé pour le compte connecté.",
            )
        })
}

fn merge_request(data: &Value, number: u64) -> Result<&Value, GitError> {
    project(data)?
        .get("mergeRequest")
        .filter(|request| !request.is_null())
        .ok_or_else(|| {
            GitError::new(
                "notFound",
                format!("La merge request !{number} est introuvable."),
            )
        })
}

/// Percent-encodes a project path as one URL path segment (`group/sub/repo` → `group%2Fsub%2Frepo`).
fn encode(path: &str) -> String {
    path.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// A deleted fork leaves `sourceProjectId` null: only matching ids prove the head is ours.
pub(super) fn cross_project(request: &Value) -> bool {
    let source = request.get("sourceProjectId").and_then(Value::as_u64);
    source.is_none() || source != request.get("targetProjectId").and_then(Value::as_u64)
}

fn summary(request: &Value) -> RequestSummary {
    RequestSummary {
        number: str_at(request, "/iid").parse().unwrap_or(0),
        title: string_at(request, "/title"),
        author: string_at(request, "/author/username"),
        source_branch: string_at(request, "/sourceBranch"),
        target_branch: string_at(request, "/targetBranch"),
        cross_repository: cross_project(request),
        draft: bool_at(request, "/draft"),
        state: match str_at(request, "/state") {
            "merged" => RequestState::Merged,
            "opened" => RequestState::Open,
            _ => RequestState::Closed,
        },
        checks: match str_at(request, "/headPipeline/status") {
            "SUCCESS" => Some(ChecksState::Success),
            "FAILED" | "CANCELED" => Some(ChecksState::Failure),
            "" | "SKIPPED" | "MANUAL" => None,
            _ => Some(ChecksState::Pending),
        },
        review: if request
            .pointer("/changeRequesters/count")
            .and_then(Value::as_u64)
            .is_some_and(|count| count > 0)
        {
            Some(ReviewState::ChangesRequested)
        } else if bool_at(request, "/approved")
            && request
                .pointer("/approvedBy/count")
                .and_then(Value::as_u64)
                .is_some_and(|count| count > 0)
        {
            // `approved` alone also holds when approval is optional and nobody approved.
            Some(ReviewState::Approved)
        } else if request
            .get("approvalsLeft")
            .and_then(Value::as_u64)
            .is_some_and(|left| left > 0)
        {
            Some(ReviewState::ReviewRequired)
        } else {
            None
        },
        conflicts: bool_at(request, "/conflicts"),
        created_at: string_at(request, "/createdAt"),
        url: string_at(request, "/webUrl"),
    }
}

/// Why GitLab would refuse the merge now. GitLab only rechecks an idle merge request's status when
/// someone views it, so a stale status ("not checked yet") still shows the pipeline and approvals.
pub(super) fn blockers(
    state: RequestState,
    draft: bool,
    conflicts: bool,
    status: &str,
    pipeline_blocks: bool,
    approvals_missing: bool,
) -> Vec<MergeBlocker> {
    if state != RequestState::Open || status == "MERGEABLE" {
        return Vec::new();
    }
    let mut blockers = match status {
        "DRAFT_STATUS" => vec![MergeBlocker::Draft],
        "CONFLICT" | "BROKEN_STATUS" => vec![MergeBlocker::Conflicts],
        "CI_MUST_PASS" | "CI_STILL_RUNNING" => vec![MergeBlocker::Checks],
        "NOT_APPROVED" | "REQUESTED_CHANGES" => vec![MergeBlocker::Approvals],
        "NEED_REBASE" => vec![MergeBlocker::Behind],
        "" | "CHECKING" | "UNCHECKED" | "PREPARING" | "APPROVALS_SYNCING" => {
            vec![MergeBlocker::Unknown]
        }
        _ => vec![MergeBlocker::Blocked],
    };
    for (applies, blocker) in [
        (draft, MergeBlocker::Draft),
        (conflicts, MergeBlocker::Conflicts),
        (pipeline_blocks, MergeBlocker::Checks),
        (approvals_missing, MergeBlocker::Approvals),
    ] {
        if applies && !blockers.contains(&blocker) {
            blockers.push(blocker);
        }
    }
    if blockers.len() > 1 {
        blockers.retain(|blocker| *blocker != MergeBlocker::Unknown);
    }
    blockers
}
