use super::*;

#[test]
fn pull_request_numbers_come_from_github_and_gitlab_urls() {
    let pull_requests = extract_pull_requests([
        "https://github.com/acme/app/pull/5",
        "https://gitlab.com/acme/group/app/-/merge_requests/12?tab=diffs",
        "https://github.com/acme/app/pull/7/files#diff",
    ]);

    assert_eq!(
        pull_requests,
        vec![
            KanbanPullRequest {
                number: 5,
                url: "https://github.com/acme/app/pull/5".into(),
            },
            KanbanPullRequest {
                number: 12,
                url: "https://gitlab.com/acme/group/app/-/merge_requests/12?tab=diffs".into(),
            },
            KanbanPullRequest {
                number: 7,
                url: "https://github.com/acme/app/pull/7/files#diff".into(),
            },
        ]
    );
}

#[test]
fn non_pull_request_attachments_are_ignored() {
    let pull_requests = extract_pull_requests([
        "https://github.com/acme/app/issues/5",
        "https://github.com/acme/app/pulls",
        "https://github.com/acme/app/pull/new-branch",
        "https://acme.slack.com/archives/C1/p123",
        "https://sentry.io/issues/4242/",
        "not a url /pull/3",
        "https://example.com/docs/pull/5",
        "https://github.com/acme/app/tree/pull/5",
        "https://gitlab.com/acme/app/merge_requests/5",
        "https://gitlab.com/app/-/merge_requests/5",
    ]);

    assert!(pull_requests.is_empty());
}

#[test]
fn pull_request_hosts_dedupe_case_insensitively() {
    let pull_requests = extract_pull_requests([
        "https://github.com/acme/app/pull/9",
        "https://GITHUB.COM/acme/app/pull/9",
        "https://github.com/ACME/app/pull/9",
    ]);

    assert_eq!(
        pull_requests
            .iter()
            .map(|pull_request| pull_request.url.as_str())
            .collect::<Vec<_>>(),
        vec![
            "https://github.com/acme/app/pull/9",
            "https://github.com/ACME/app/pull/9",
        ]
    );
}

#[test]
fn same_number_in_different_repositories_or_hosts_are_distinct() {
    let pull_requests = extract_pull_requests([
        "https://github.com/acme/frontend/pull/9",
        "https://github.com/acme/backend/pull/9",
        "https://gitlab.com/acme/frontend/-/merge_requests/9",
        "https://github.com/acme/frontend/pull/9/files",
        "https://github.com/acme/frontend/pull/9?tab=checks",
    ]);

    assert_eq!(
        pull_requests
            .iter()
            .map(|pull_request| pull_request.url.as_str())
            .collect::<Vec<_>>(),
        vec![
            "https://github.com/acme/frontend/pull/9",
            "https://github.com/acme/backend/pull/9",
            "https://gitlab.com/acme/frontend/-/merge_requests/9",
        ]
    );
}

#[test]
fn gitlab_merge_request_number_ignores_namespace_segments_named_pull() {
    let pull_requests = extract_pull_requests([
        "https://gitlab.com/acme/pull/5/-/merge_requests/27",
        "https://gitlab.com/acme/tools/pull/5/-/merge_requests/31/diffs",
    ]);

    assert_eq!(
        pull_requests
            .iter()
            .map(|pull_request| pull_request.number)
            .collect::<Vec<_>>(),
        vec![27, 31]
    );
}

#[test]
fn pull_requests_are_found_in_markdown_text_in_order_and_once() {
    let pull_requests = text_pull_requests([
        "Fix in [the PR](https://github.com/acme/app/pull/5), see https://github.com/acme/app/pull/6.",
        "Merged: <https://gitlab.com/acme/app/-/merge_requests/12> and https://github.com/acme/app/pull/5/files",
        "httpsnot a url https://github.com/acme/app/issues/7",
    ]);

    assert_eq!(
        pull_requests
            .iter()
            .map(|pull_request| (pull_request.number, pull_request.url.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (5, "https://github.com/acme/app/pull/5"),
            (6, "https://github.com/acme/app/pull/6"),
            (12, "https://gitlab.com/acme/app/-/merge_requests/12"),
        ]
    );
}
