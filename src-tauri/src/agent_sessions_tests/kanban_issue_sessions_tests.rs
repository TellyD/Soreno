use super::*;
use crate::kanban::{self, KanbanIssueCreateInput};

pub(super) fn state() -> AgentSessions {
    let state = memory_state();
    state.save_project(project()).unwrap();
    state
}
pub(super) fn save_session(state: &AgentSessions, session_id: &str) {
    save_session_in(state, session_id, "project");
}
pub(super) fn save_session_in(state: &AgentSessions, session_id: &str, project_id: &str) {
    state
        .save_session(AgentSession {
            id: session_id.into(),
            project_id: project_id.into(),
            ..session()
        })
        .unwrap();
}
/// Creates Kanban issues `SOR-1`… in order and returns their ids.
pub(super) fn issues(state: &AgentSessions, count: usize) -> Vec<String> {
    (0..count)
        .map(|index| {
            state
                .kanban(|db, _| {
                    kanban::create_issue(
                        db,
                        KanbanIssueCreateInput {
                            team_id: kanban::default_team_id(db)?,
                            title: format!("Issue {}", index + 1),
                            ..KanbanIssueCreateInput::default()
                        },
                    )
                })
                .unwrap()
                .id
        })
        .collect()
}
fn records(state: &AgentSessions) -> Vec<AgentSessionKanbanIssue> {
    state.workspace().unwrap().kanban_issue_sessions
}
fn record(state: &AgentSessions, identifier: &str) -> AgentSessionKanbanIssue {
    records(state)
        .into_iter()
        .find(|record| record.issue_identifier == identifier)
        .unwrap()
}
type Link = (String, Option<String>, Option<String>, Option<String>);
/// (issue identifier, live session, end reason, merged into)
fn links(state: &AgentSessions) -> Vec<Link> {
    records(state)
        .into_iter()
        .map(|record| {
            assert_eq!(record.ended_at.is_some(), record.end_reason.is_some());
            (
                record.issue_identifier,
                record.session_id,
                record.end_reason,
                record.merged_into,
            )
        })
        .collect()
}
fn live(identifier: &str, session_id: &str) -> Link {
    (identifier.into(), Some(session_id.into()), None, None)
}
fn ended(identifier: &str, reason: &str, merged_into: Option<&str>) -> Link {
    (
        identifier.into(),
        None,
        Some(reason.into()),
        merged_into.map(Into::into),
    )
}
fn comment_bodies(state: &AgentSessions, issue_id: &str) -> Vec<String> {
    state
        .kanban(|db, _| kanban::load_issue(db, issue_id))
        .unwrap()
        .comments
        .into_iter()
        .map(|comment| comment.body)
        .collect()
}
fn state_name(state: &AgentSessions, state_id: &str) -> String {
    state
        .kanban(|db, _| kanban::load_board(db))
        .unwrap()
        .states
        .into_iter()
        .find(|state| state.id == state_id)
        .unwrap()
        .name
}

#[test]
fn linked_sessions_are_listed_with_a_snapshot_of_the_session() {
    let state = state();
    let issues = issues(&state, 2);
    save_session(&state, "a");
    save_session(&state, "b");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    state.link_session_kanban_issue("b", &issues[1]).unwrap();

    assert_eq!(
        records(&state)[0],
        AgentSessionKanbanIssue {
            source: kanban::KanbanSource::Local,
            issue_id: issues[0].clone(),
            issue_identifier: "SOR-1".into(),
            issue_title: "Issue 1".into(),
            session_id: Some("a".into()),
            session_name: "Shell".into(),
            executable: "/bin/sh".into(),
            project_name: "Projet".into(),
            started_at: "2026-01-01T00:00:00Z".into(),
            ended_at: None,
            end_reason: None,
            merged_into: None,
        }
    );
    assert_eq!(links(&state), [live("SOR-1", "a"), live("SOR-2", "b")]);
}

#[test]
fn an_issue_or_a_session_can_only_be_linked_once() {
    let state = state();
    let issues = issues(&state, 2);
    save_session(&state, "a");
    save_session(&state, "b");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();

    assert_eq!(
        state
            .link_session_kanban_issue("b", &issues[0])
            .unwrap_err(),
        "[Kanban/issueHasSession] Cette issue a déjà une session d’agent."
    );
    assert_eq!(
        state
            .link_session_kanban_issue("a", &issues[0])
            .unwrap_err(),
        "[Kanban/issueHasSession] Cette issue a déjà une session d’agent."
    );
    assert_eq!(
        state
            .link_session_kanban_issue("a", &issues[1])
            .unwrap_err(),
        "[Kanban/sessionHasIssue] Cette session d’agent est déjà liée à une issue."
    );
    assert_eq!(links(&state), [live("SOR-1", "a")]);
}

#[test]
fn unknown_sessions_issues_and_blank_ids_are_rejected() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");

    assert_eq!(
        state
            .link_session_kanban_issue("missing", &issues[0])
            .unwrap_err(),
        "Session introuvable."
    );
    assert_eq!(
        state.link_session_kanban_issue("a", "missing").unwrap_err(),
        "[Kanban/issueNotFound] Issue introuvable."
    );
    assert!(state.link_session_kanban_issue("", &issues[0]).is_err());
    assert!(state.link_session_kanban_issue("a", " ").is_err());
    assert!(links(&state).is_empty());
}

#[test]
fn deleting_the_session_keeps_an_ended_record_that_a_new_link_replaces() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    assert!(state
        .save_session(AgentSession {
            id: "a".into(),
            custom_name: Some(" ".into()),
            ..session()
        })
        .is_err());
    state
        .save_session(AgentSession {
            id: "a".into(),
            name: "Renamed".into(),
            custom_name: Some("Manual".into()),
            ..session()
        })
        .unwrap();
    state.set_session_closed("a", true).unwrap();

    state.delete_session("a").unwrap();
    assert_eq!(links(&state), [ended("SOR-1", "session", None)]);
    let ended_record = record(&state, "SOR-1");
    assert_eq!(ended_record.session_name, "Manual");

    state
        .save_session(AgentSession {
            id: "b".into(),
            name: "Second".into(),
            created_at: "2026-02-02T00:00:00Z".into(),
            ..session()
        })
        .unwrap();
    state.link_session_kanban_issue("b", &issues[0]).unwrap();
    assert_eq!(links(&state), [live("SOR-1", "b")]);
    let replaced = record(&state, "SOR-1");
    assert_eq!(
        (
            replaced.session_name.as_str(),
            replaced.started_at.as_str(),
            replaced.ended_at
        ),
        ("Second", "2026-02-02T00:00:00Z", None)
    );
}

#[test]
fn deleting_the_project_ends_the_links_of_its_sessions_only() {
    let state = state();
    let issues = issues(&state, 2);
    insert_project(
        &state,
        &AgentProject {
            id: "other".into(),
            ..project()
        },
    );
    save_session(&state, "a");
    save_session_in(&state, "kept", "other");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    state.link_session_kanban_issue("kept", &issues[1]).unwrap();

    state.delete_project("project").unwrap();
    assert_eq!(
        links(&state),
        [ended("SOR-1", "project", None), live("SOR-2", "kept")]
    );
    assert_eq!(record(&state, "SOR-1").project_name, "Projet");
}

#[test]
fn removing_a_worktree_ends_its_links_as_merged_or_removed() {
    let state = state();
    let issues = issues(&state, 3);
    for project_id in ["merged-worktree", "removed-worktree"] {
        insert_project(&state, &local_project(project_id));
    }
    save_session_in(&state, "merged", "merged-worktree");
    save_session_in(&state, "removed", "removed-worktree");
    save_session(&state, "kept");
    state
        .link_session_kanban_issue("merged", &issues[0])
        .unwrap();
    state
        .link_session_kanban_issue("removed", &issues[1])
        .unwrap();
    state.link_session_kanban_issue("kept", &issues[2]).unwrap();

    for (project_id, end) in [
        ("merged-worktree", SessionEnd::Merged("main")),
        ("removed-worktree", SessionEnd::Worktree),
    ] {
        let lease = state.begin_git_operation("project").unwrap();
        let stopped = lease.stop_project_sessions(&[project_id.into()]).unwrap();
        lease.delete_projects(stopped, end).unwrap();
    }
    assert_eq!(
        links(&state),
        [
            ended("SOR-1", "merged", Some("main")),
            ended("SOR-2", "worktree", None),
            live("SOR-3", "kept"),
        ]
    );
    assert_eq!(
        record(&state, "SOR-1").project_name,
        "Projet merged-worktree"
    );
}

#[test]
fn deleting_the_issue_removes_its_agent_link_but_keeps_the_session() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    state.delete_kanban_issue(&issues[0]).unwrap();

    assert!(links(&state).is_empty());
    assert_eq!(state.workspace().unwrap().sessions.len(), 1);
    assert_eq!(
        state
            .complete_kanban_issue("a", "turn-1", "Done.")
            .unwrap_err(),
        "[Kanban/sessionNotLinked] Cette session d’agent n’est liée à aucune issue."
    );
}

#[test]
fn unlinking_frees_the_session_and_the_issue_and_reopens_a_closed_session() {
    let state = state();
    let issues = issues(&state, 2);
    save_session(&state, "a");
    save_session(&state, "b");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    state
        .link_session_linear_issue("b", "lin-1", "ENG-1", "Issue")
        .unwrap();
    state.set_session_closed("a", true).unwrap();
    assert!(state
        .complete_kanban_issue("a", "turn-1", "Done.")
        .unwrap()
        .is_some());

    state.unlink_session_issue("a").unwrap();
    state.unlink_session_issue("b").unwrap();

    assert!(records(&state).is_empty());
    assert!(state.workspace().unwrap().closed_session_ids.is_empty());
    assert_eq!(
        state.unlink_session_issue("a").unwrap_err(),
        "[Kanban/sessionNotLinked] Cette session d’agent n’est liée à aucune issue."
    );
    assert!(state.complete_kanban_issue("a", "turn-2", "Done.").is_err());
    state.link_session_kanban_issue("a", &issues[1]).unwrap();
    state.link_session_kanban_issue("b", &issues[0]).unwrap();
    assert_eq!(links(&state), [live("SOR-1", "b"), live("SOR-2", "a")]);
    // After a restart the sidecar still ends with turn-1: it was posted on SOR-1, never on SOR-2.
    let pending = kanban_issue_sessions::pending_summary(
        &lock(&state.store).unwrap().db,
        "a",
        conversations::AgentTurn {
            id: "turn-1".into(),
            message: Some("<soreno-summary>Done.</soreno-summary>".into()),
        },
    )
    .unwrap();
    assert_eq!(pending, None);
}

#[test]
fn a_summary_claimed_on_one_source_is_never_offered_after_relinking_to_the_other() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");
    save_session(&state, "b");
    let pending = |session_id: &str, turn_id: &str| {
        kanban_issue_sessions::pending_summary(
            &lock(&state.store).unwrap().db,
            session_id,
            conversations::AgentTurn {
                id: turn_id.into(),
                message: Some("<soreno-summary>Done.</soreno-summary>".into()),
            },
        )
        .unwrap()
    };
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    state.complete_kanban_issue("a", "turn-1", "Done.").unwrap();
    state.unlink_session_issue("a").unwrap();
    state
        .link_session_linear_issue("a", "lin-1", "ENG-1", "Issue")
        .unwrap();
    state
        .link_session_linear_issue("b", "lin-2", "ENG-2", "Issue")
        .unwrap();
    state.claim_linear_issue_summary("b", "turn-3").unwrap();
    state.unlink_session_issue("b").unwrap();
    state.link_session_kanban_issue("b", &issues[0]).unwrap();

    // After a restart both sidecars still end with the summary already posted on the other source.
    assert_eq!(pending("a", "turn-1"), None);
    assert_eq!(pending("b", "turn-3"), None);
    assert!(pending("a", "turn-2").is_some());
    assert!(pending("b", "turn-4").is_some());
}

#[test]
fn a_summary_ending_the_turn_is_offered_until_its_first_claim() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");
    save_session(&state, "unlinked");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    let pending = |session_id: &str, message: &str| {
        kanban_issue_sessions::pending_summary(
            &lock(&state.store).unwrap().db,
            session_id,
            conversations::AgentTurn {
                id: "turn-1".into(),
                message: Some(message.into()),
            },
        )
        .unwrap()
    };
    let message = "<soreno-summary>draft</soreno-summary> Then:\n<soreno-summary>\n  Fixed it.\n</soreno-summary>\n";
    assert_eq!(
        pending("a", message),
        Some(AgentIssueSummary {
            id: "turn-1".into(),
            text: "Fixed it.".into(),
        })
    );
    for ignored in [
        "I will end with <soreno-summary>…</soreno-summary> once done. Which file?",
        "<soreno-summary> </soreno-summary>",
        "</soreno-summary>",
    ] {
        assert_eq!(pending("a", ignored), None, "{ignored}");
    }
    assert_eq!(pending("unlinked", message), None);

    assert!(state
        .complete_kanban_issue("a", "turn-1", "Fixed it.")
        .unwrap()
        .is_some());
    assert_eq!(
        state
            .complete_kanban_issue("a", "turn-1", "Fixed it.")
            .unwrap(),
        None
    );
    assert_eq!(pending("a", message), None);
    assert_eq!(comment_bodies(&state, &issues[0]), ["Fixed it."]);
    assert_eq!(
        state
            .complete_kanban_issue("unlinked", "turn-2", "Fixed it.")
            .unwrap_err(),
        "[Kanban/sessionNotLinked] Cette session d’agent n’est liée à aucune issue."
    );
}

#[test]
fn a_failed_post_leaves_the_summary_unclaimed() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();

    assert!(state.complete_kanban_issue("a", "turn-1", " \n").is_err());
    assert!(state
        .complete_kanban_issue("a", "turn-1", "Fixed it.")
        .unwrap()
        .is_some());
}

#[test]
fn the_first_summary_moves_to_review_and_later_ones_extend_its_comment() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");
    save_session(&state, "b");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();

    let first = state
        .complete_kanban_issue("a", "turn-1", "Fixed it.\n\n— Codex via Soreno")
        .unwrap()
        .unwrap();
    let update = first.update.expect("moved to review");
    assert_eq!(state_name(&state, &update.state_id), "In Review");
    let second = state
        .complete_kanban_issue("a", "turn-2", "Reviewed it.\n\n— Codex via Soreno")
        .unwrap()
        .unwrap();
    assert_eq!(second.update, None);
    assert_eq!(second.comment.id, first.comment.id);
    assert_eq!(
        comment_bodies(&state, &issues[0]),
        ["Fixed it.\n\n---\n\nReviewed it.\n\n— Codex via Soreno"]
    );

    // A new session on the issue starts its own comment.
    state.delete_session("a").unwrap();
    state.link_session_kanban_issue("b", &issues[0]).unwrap();
    let third = state
        .complete_kanban_issue("b", "turn-3", "Again.")
        .unwrap()
        .unwrap();
    assert_ne!(third.comment.id, first.comment.id);
    assert_eq!(third.update, None, "already in review");
    assert_eq!(comment_bodies(&state, &issues[0]).len(), 2);
}

#[test]
fn a_deleted_summary_comment_is_replaced_by_a_new_one() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    let first = state
        .complete_kanban_issue("a", "turn-1", "Fixed it.")
        .unwrap()
        .unwrap();
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "DELETE FROM kanban_comments WHERE id=?1",
            [&first.comment.id],
        )
        .unwrap();

    let second = state
        .complete_kanban_issue("a", "turn-2", "Again.")
        .unwrap()
        .unwrap();
    assert_ne!(second.comment.id, first.comment.id);
    assert_eq!(comment_bodies(&state, &issues[0]), ["Again."]);
}
