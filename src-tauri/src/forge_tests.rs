use super::*;
use crate::agent_sessions::tests::unique_temp_path;
use crate::project_git::test_fixtures::local_project;

#[test]
fn parses_github_and_gitlab_remote_urls() {
    for (url, expected) in [
        (
            "https://github.com/owner/repo.git",
            Some(("github.com", "owner/repo")),
        ),
        (
            "https://user:token@github.com/owner/repo/",
            Some(("github.com", "owner/repo")),
        ),
        (
            "git@github.com:owner/repo.git",
            Some(("github.com", "owner/repo")),
        ),
        (
            "ssh://git@ssh.github.com:443/owner/repo.git",
            Some(("github.com", "owner/repo")),
        ),
        (
            "ssh://git@gitlab.com/group/sub/repo.git",
            Some(("gitlab.com", "group/sub/repo")),
        ),
        (
            "https://GitLab.com/group/repo",
            Some(("gitlab.com", "group/repo")),
        ),
        (
            "git@git.example.org:team/repo.git",
            Some(("git.example.org", "team/repo")),
        ),
        (
            "git@github.com:org/.github.git",
            Some(("github.com", "org/.github")),
        ),
        (
            "https://github.com/org/.dotfiles",
            Some(("github.com", "org/.dotfiles")),
        ),
        ("https://github.com/org/..", None),
        ("https://github.com/org/.", None),
        ("https://github.com/owner", None),
        ("https://github.com/owner/../repo", None),
        ("file:///srv/repo.git", None),
        ("/srv/repo.git", None),
        ("../repo", None),
    ] {
        assert_eq!(
            parse_remote_url(url),
            expected.map(|(host, path)| (host.to_owned(), path.to_owned())),
            "{url}"
        );
    }
}

#[test]
fn lists_upstream_before_origin_and_rejects_other_forges() {
    let root = unique_temp_path("soreno-forge-remote");
    std::fs::create_dir_all(&root).unwrap();
    let project = local_project("project", "Project", &root);
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .env("HOME", &root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    assert_eq!(remote(&project).unwrap_err().code, "noRemote");

    git(&["remote", "add", "origin", "git@github.com:me/fork.git"]);
    assert_eq!(remote(&project).unwrap().path, "me/fork");
    git(&[
        "remote",
        "add",
        "upstream",
        "https://gitlab.com/group/sub/repo.git",
    ]);
    assert_eq!(
        remote(&project).unwrap(),
        ForgeRemote {
            kind: ForgeKind::Gitlab,
            host: "gitlab.com".into(),
            path: "group/sub/repo".into(),
            remote: "upstream".into(),
            web_url: "https://gitlab.com/group/sub/repo".into(),
        }
    );
    git(&[
        "remote",
        "set-url",
        "upstream",
        "https://git.example.org/group/repo.git",
    ]);
    assert_eq!(remote(&project).unwrap_err().code, "unsupportedForge");
    git(&[
        "remote",
        "set-url",
        "upstream",
        "https://github.com/a/b/c.git",
    ]);
    assert_eq!(remote(&project).unwrap_err().code, "unrecognizedRemote");
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn classifies_cli_failures() {
    for (kind, status, stdout, stderr, code) in [
        (
            ForgeKind::Github,
            Some(4),
            "",
            "gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.",
            "unauthenticated",
        ),
        (
            ForgeKind::Gitlab,
            Some(1),
            "",
            "glab: 401 Unauthorized (HTTP 401)",
            "unauthenticated",
        ),
        // GitHub answers a primary rate limit with a 403: the limit wins over the access error.
        (
            ForgeKind::Github,
            Some(1),
            r#"{"message":"API rate limit exceeded"}"#,
            "gh: API rate limit exceeded for user (HTTP 403)",
            "rateLimited",
        ),
        (
            ForgeKind::Gitlab,
            Some(1),
            "",
            "glab: 429 Too Many Requests",
            "rateLimited",
        ),
        (
            ForgeKind::Github,
            Some(1),
            "",
            "gh: Could not resolve to a Repository with the name 'a/b'.",
            "forbidden",
        ),
        (
            ForgeKind::Gitlab,
            Some(1),
            "",
            "glab: 404 Project Not Found (HTTP 404)",
            "forbidden",
        ),
        (
            ForgeKind::Github,
            Some(1),
            "",
            "error connecting to api.github.com",
            "network",
        ),
        (
            ForgeKind::Gitlab,
            Some(1),
            "",
            "dial tcp: lookup gitlab.com: no such host",
            "network",
        ),
    ] {
        assert_eq!(
            cli_error(kind, status, stdout, stderr).code,
            code,
            "{stderr}"
        );
    }
    let refused = cli_error(
        ForgeKind::Github,
        Some(1),
        r#"{"message":"Pull Request is not mergeable"}"#,
        "gh: Pull Request is not mergeable (HTTP 405)\n",
    );
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        ("forge", "Pull Request is not mergeable (HTTP 405)")
    );
    let behind_shell_diagnostics = cli_error(
        ForgeKind::Github,
        Some(1),
        "",
        &format!("bash: cannot set terminal process group (1): Inappropriate ioctl for device\nbash: no job control in this shell\n{OUTPUT_MARKER}\ngh: Pull Request is not mergeable (HTTP 405)\n"),
    );
    assert_eq!(
        behind_shell_diagnostics.message,
        "Pull Request is not mergeable (HTTP 405)"
    );
    assert_eq!(
        cli_error(
            ForgeKind::Gitlab,
            Some(1),
            r#"{"message":"SHA does not match HEAD of source branch"}"#,
            ""
        )
        .message,
        "SHA does not match HEAD of source branch"
    );
    assert_eq!(
        graphql_error(&[
            serde_json::json!({ "type": "RATE_LIMITED", "message": "API rate limit exceeded" })
        ])
        .code,
        "rateLimited"
    );
}

#[test]
fn reads_json_after_a_login_shell_banner() {
    assert_eq!(
        parse_json("Welcome back!\n{\"data\": {\"ok\": true}}\n"),
        Some(serde_json::json!({ "data": { "ok": true } }))
    );
    assert_eq!(
        parse_json(&format!(
            "[INFO] nvm loaded\n\u{1b}[32mready\u{1b}[0m\n{OUTPUT_MARKER}\n{{\"ok\": true}}\n"
        )),
        Some(serde_json::json!({ "ok": true }))
    );
    assert_eq!(parse_json("[1, 2]"), Some(serde_json::json!([1, 2])));
    assert_eq!(parse_json("no json"), None);
}

#[test]
fn github_search_stays_in_the_repository() {
    assert_eq!(
        github::search_query(
            "me/repo",
            RequestFilter::Review,
            "fix: crash repo:other/repo -org:x is:closed"
        ),
        "repo:me/repo is:pr is:open review-requested:@me sort:created-desc fix: crash"
    );
}

#[test]
fn github_merge_blockers() {
    use MergeBlocker::*;
    for (draft, mergeable, merge_state, review, checks, expected) in [
        (false, "MERGEABLE", "CLEAN", "APPROVED", "SUCCESS", vec![]),
        // Non-required failing checks leave a pull request mergeable.
        (false, "MERGEABLE", "UNSTABLE", "", "FAILURE", vec![]),
        (true, "MERGEABLE", "DRAFT", "", "", vec![Draft]),
        (false, "CONFLICTING", "DIRTY", "", "", vec![Conflicts]),
        (
            false,
            "MERGEABLE",
            "BLOCKED",
            "REVIEW_REQUIRED",
            "PENDING",
            vec![Approvals, Checks],
        ),
        (
            false,
            "MERGEABLE",
            "BLOCKED",
            "APPROVED",
            "SUCCESS",
            vec![Blocked],
        ),
        (
            false,
            "MERGEABLE",
            "BEHIND",
            "APPROVED",
            "SUCCESS",
            vec![Behind],
        ),
        (false, "UNKNOWN", "UNKNOWN", "", "", vec![Unknown]),
    ] {
        assert_eq!(
            github::blockers(
                RequestState::Open,
                draft,
                mergeable,
                merge_state,
                review,
                checks
            ),
            expected,
            "{merge_state}"
        );
    }
    assert!(
        github::blockers(RequestState::Merged, true, "CONFLICTING", "DIRTY", "", "").is_empty()
    );
}

#[test]
fn gitlab_merge_blockers() {
    use MergeBlocker::*;
    for (draft, conflicts, status, pipeline, approvals, expected) in [
        (false, false, "MERGEABLE", false, false, vec![]),
        (true, false, "DRAFT_STATUS", false, false, vec![Draft]),
        (false, true, "CONFLICT", false, false, vec![Conflicts]),
        (
            true,
            true,
            "NOT_APPROVED",
            false,
            false,
            vec![Approvals, Draft, Conflicts],
        ),
        (false, false, "CI_STILL_RUNNING", false, false, vec![Checks]),
        (false, false, "NEED_REBASE", false, false, vec![Behind]),
        (false, false, "CHECKING", false, false, vec![Unknown]),
        (false, true, "CHECKING", false, false, vec![Conflicts]),
        // An idle merge request is never rechecked: its failed pipeline is the real reason.
        (false, false, "UNCHECKED", true, false, vec![Checks]),
        (
            false,
            false,
            "UNCHECKED",
            true,
            true,
            vec![Checks, Approvals],
        ),
        (
            false,
            false,
            "DISCUSSIONS_NOT_RESOLVED",
            false,
            false,
            vec![Blocked],
        ),
    ] {
        assert_eq!(
            gitlab::blockers(
                RequestState::Open,
                draft,
                conflicts,
                status,
                pipeline,
                approvals
            ),
            expected,
            "{status}"
        );
    }
}

#[test]
fn gitlab_cross_project_requires_matching_project_ids() {
    use serde_json::json;
    for (request, expected) in [
        (
            json!({ "sourceProjectId": null, "targetProjectId": 1 }),
            true,
        ),
        (json!({ "targetProjectId": 1 }), true),
        (json!({ "sourceProjectId": 2, "targetProjectId": 1 }), true),
        (json!({ "sourceProjectId": 1, "targetProjectId": 1 }), false),
    ] {
        assert_eq!(gitlab::cross_project(&request), expected, "{request}");
    }
}
