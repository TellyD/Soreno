use super::kanban_issue_sessions_tests::{issues, save_session, state};
use super::*;
use crate::agent_sessions::kanban_issue_sessions::{ClaimedIssueSummary, TransferredComment};
use crate::kanban::{self, KanbanIssueCreateInput, KanbanSource};

fn linear_links(state: &AgentSessions) -> Vec<(String, String, Option<String>)> {
    state
        .workspace()
        .unwrap()
        .kanban_issue_sessions
        .into_iter()
        .filter(|record| record.source == KanbanSource::Linear)
        .map(|record| (record.issue_id, record.issue_identifier, record.session_id))
        .collect()
}

fn live(issue_id: &str, identifier: &str, session_id: &str) -> (String, String, Option<String>) {
    (issue_id.into(), identifier.into(), Some(session_id.into()))
}

#[test]
fn linear_links_are_listed_after_local_ones_with_their_source() {
    let state = state();
    let local = issues(&state, 1);
    save_session(&state, "a");
    save_session(&state, "b");
    state
        .link_session_linear_issue("b", "lin-1", "ENG-1", "Cache assets")
        .unwrap();
    state.link_session_kanban_issue("a", &local[0]).unwrap();

    let json = serde_json::to_value(state.workspace().unwrap()).unwrap();
    let records = json["kanbanIssueSessions"].as_array().unwrap();
    assert_eq!(
        records
            .iter()
            .map(|record| (
                record["source"].as_str(),
                record["issueIdentifier"].as_str(),
                record["issueTitle"].as_str()
            ))
            .collect::<Vec<_>>(),
        [
            (Some("local"), Some("SOR-1"), Some("Issue 1")),
            (Some("linear"), Some("ENG-1"), Some("Cache assets"))
        ]
    );
    assert_eq!(linear_links(&state), [live("lin-1", "ENG-1", "b")]);
}

#[test]
fn a_session_works_on_one_issue_across_both_sources() {
    let state = state();
    let local = issues(&state, 1);
    save_session(&state, "a");
    save_session(&state, "b");
    state.link_session_kanban_issue("a", &local[0]).unwrap();
    state
        .link_session_linear_issue("b", "lin-1", "ENG-1", "Issue")
        .unwrap();

    let session_has_issue =
        "[Kanban/sessionHasIssue] Cette session d’agent est déjà liée à une issue.";
    assert_eq!(
        state
            .link_session_linear_issue("a", "lin-2", "ENG-2", "Issue")
            .unwrap_err(),
        session_has_issue
    );
    assert_eq!(
        state
            .link_session_kanban_issue("b", &issues(&state, 1)[0])
            .unwrap_err(),
        session_has_issue
    );
    save_session(&state, "c");
    assert_eq!(
        state
            .link_session_linear_issue("c", "lin-1", "ENG-1", "Issue")
            .unwrap_err(),
        "[Kanban/issueHasSession] Cette issue a déjà une session d’agent."
    );
    assert_eq!(linear_links(&state), [live("lin-1", "ENG-1", "b")]);
}

#[test]
fn a_linear_link_survives_reinitialization_and_reopening_the_store() {
    let path = unique_temp_path("soreno-linear-link-reopen");
    std::fs::create_dir_all(&path).unwrap();
    let database = path.join("agents.sqlite");
    {
        let state = AgentSessions::from_connection(Connection::open(&database).unwrap()).unwrap();
        state.save_project(project()).unwrap();
        save_session(&state, "a");
        state
            .link_session_linear_issue("a", "lin-1", "ENG-1", "Issue")
            .unwrap();
        state
            .set_project_linear_link_with("project", Some("lin-project"), |_| {
                Ok(AgentProjectWorktreeSnapshot {
                    groups: Vec::new(),
                    complete: true,
                    missing_project_ids: Vec::new(),
                })
            })
            .unwrap();
        let mut store = lock(&state.store).unwrap();
        crate::kanban::initialize(&mut store.db).unwrap();
    }
    let state = AgentSessions::from_connection(Connection::open(&database).unwrap()).unwrap();
    assert_eq!(linear_links(&state), [live("lin-1", "ENG-1", "a")]);
    assert_eq!(state.workspace().unwrap().linear_project_links.len(), 1);
    assert_eq!(
        state.session_linear_issue("a").unwrap().as_deref(),
        Some("lin-1")
    );
    drop(state);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn deleting_the_session_ends_its_linear_link() {
    let state = state();
    save_session(&state, "a");
    state
        .link_session_linear_issue("a", "lin-1", "ENG-1", "Issue")
        .unwrap();
    state.delete_session("a").unwrap();

    let record = state
        .workspace()
        .unwrap()
        .kanban_issue_sessions
        .pop()
        .unwrap();
    assert_eq!(
        (record.session_id, record.end_reason.as_deref()),
        (None, Some("session"))
    );
    assert_eq!(state.session_linear_issue("a").unwrap(), None);
}

#[test]
fn a_linear_link_keeps_its_session_closed_until_the_issue_is_forgotten() {
    let state = state();
    save_session(&state, "a");
    state
        .link_session_linear_issue("a", "lin-1", "ENG-1", "Issue")
        .unwrap();
    state.set_session_closed("a", true).unwrap();
    assert_eq!(state.workspace().unwrap().closed_session_ids, ["a"]);

    state.forget_linear_issue("lin-1").unwrap();
    assert!(linear_links(&state).is_empty());
    assert!(state.workspace().unwrap().closed_session_ids.is_empty());
}

#[test]
fn a_linear_summary_is_claimed_once_and_its_comment_recorded_for_the_live_session() {
    let state = state();
    save_session(&state, "a");
    state
        .link_session_linear_issue("a", "lin-1", "ENG-1", "Issue")
        .unwrap();

    assert_eq!(
        state.claim_linear_issue_summary("a", "turn-1").unwrap(),
        Some(ClaimedIssueSummary {
            issue_id: "lin-1".into(),
            comment_id: None,
        })
    );
    assert_eq!(
        state.claim_linear_issue_summary("a", "turn-1").unwrap(),
        None
    );
    state
        .record_linear_issue_summary_comment("a", "lin-1", "comment-1")
        .unwrap();
    assert_eq!(
        state.claim_linear_issue_summary("a", "turn-2").unwrap(),
        Some(ClaimedIssueSummary {
            issue_id: "lin-1".into(),
            comment_id: Some("comment-1".into()),
        })
    );
    save_session(&state, "b");
    assert_eq!(
        state.claim_linear_issue_summary("b", "turn-3").unwrap_err(),
        "[Kanban/sessionNotLinked] Cette session d’agent n’est liée à aucune issue."
    );
}

#[test]
fn a_transferred_issue_moves_its_session_link_and_claimed_summaries_to_linear() {
    let state = state();
    let local = issues(&state, 2);
    save_session(&state, "a");
    save_session(&state, "b");
    state.link_session_kanban_issue("a", &local[0]).unwrap();
    state.link_session_kanban_issue("b", &local[1]).unwrap();
    state
        .complete_kanban_issue("a", "turn-1", "Fixed it.")
        .unwrap();
    state.delete_session("b").unwrap();
    let before = state.workspace().unwrap().kanban_issue_sessions;

    for (issue_id, linear_id, identifier) in
        [(&local[0], "lin-1", "ENG-1"), (&local[1], "lin-2", "ENG-2")]
    {
        let known = local_comments(&state, issue_id);
        state
            .transfer_kanban_issue_to_linear(issue_id, linear_id, identifier, &known, None)
            .unwrap();
    }

    let moved: Vec<_> = before
        .into_iter()
        .zip([("lin-1", "ENG-1"), ("lin-2", "ENG-2")])
        .map(|(record, (issue_id, identifier))| AgentSessionKanbanIssue {
            source: KanbanSource::Linear,
            issue_id: issue_id.into(),
            issue_identifier: identifier.into(),
            ..record
        })
        .collect();
    assert_eq!(moved[1].end_reason.as_deref(), Some("session"));
    assert_eq!(state.workspace().unwrap().kanban_issue_sessions, moved);
    let pending = |turn_id: &str| {
        kanban_issue_sessions::pending_summary(
            &lock(&state.store).unwrap().db,
            "a",
            conversations::AgentTurn {
                id: turn_id.into(),
                message: Some("<soreno-summary>Fixed it.</soreno-summary>".into()),
            },
        )
        .unwrap()
        .map(|summary| summary.id)
    };
    assert_eq!(pending("turn-1"), None);
    assert_eq!(pending("turn-2").as_deref(), Some("turn-2"));
    let comments: i64 = lock(&state.store)
        .unwrap()
        .db
        .query_row("SELECT COUNT(*) FROM kanban_comments", [], |row| row.get(0))
        .unwrap();
    assert_eq!(comments, 0);
    assert_eq!(
        state
            .kanban(|db, _| kanban::load_issue(db, &local[0]))
            .unwrap_err(),
        kanban::ISSUE_NOT_FOUND
    );
}

fn local_comments(state: &AgentSessions, issue_id: &str) -> Vec<TransferredComment> {
    state.late_kanban_issue_comments(issue_id, &[]).unwrap()
}

#[test]
fn late_comments_are_the_new_or_edited_ones() {
    let state = state();
    let local = issues(&state, 1);
    save_session(&state, "a");
    state.link_session_kanban_issue("a", &local[0]).unwrap();
    state
        .complete_kanban_issue("a", "turn-1", "Fixed it.")
        .unwrap();
    let provided = local_comments(&state, &local[0]);

    assert_eq!(
        state.late_kanban_issue_comments(&local[0], &provided),
        Ok(Vec::new())
    );
    state
        .complete_kanban_issue("a", "turn-2", "Tested it.")
        .unwrap();
    state
        .kanban(|db, _| kanban::create_comment(db, &local[0], "Late"))
        .unwrap();
    let current = local_comments(&state, &local[0]);

    assert_eq!(current.len(), 2);
    assert_eq!(current[0].id, provided[0].id);
    assert_ne!(current[0].body, provided[0].body);
    assert_eq!(
        state.late_kanban_issue_comments(&local[0], &provided),
        Ok(current)
    );
}

#[test]
fn a_transfer_keeps_the_local_issue_while_a_comment_is_missing_on_linear() {
    let state = state();
    let local = issues(&state, 1);
    save_session(&state, "a");
    state.link_session_kanban_issue("a", &local[0]).unwrap();
    state
        .kanban(|db, _| kanban::create_comment(db, &local[0], "Copied"))
        .unwrap();
    let provided = local_comments(&state, &local[0]);
    state
        .kanban(|db, _| kanban::create_comment(db, &local[0], "Posted"))
        .unwrap();
    let posted = state
        .late_kanban_issue_comments(&local[0], &provided)
        .unwrap();
    state
        .kanban(|db, _| kanban::create_comment(db, &local[0], "Later"))
        .unwrap();
    let before = state.workspace().unwrap().kanban_issue_sessions;
    let known = [provided, posted].concat();

    assert_eq!(
        state
            .transfer_kanban_issue_to_linear(&local[0], "lin-1", "ENG-1", &known, None)
            .unwrap_err(),
        "[Kanban/transferIncomplete] ENG-1 : un commentaire a été ajouté pendant l’envoi, l’issue locale est conservée."
    );
    assert_eq!(state.workspace().unwrap().kanban_issue_sessions, before);
    assert_eq!(local_comments(&state, &local[0]).len(), 3);

    let known = local_comments(&state, &local[0]);
    state
        .transfer_kanban_issue_to_linear(&local[0], "lin-1", "ENG-1", &known, None)
        .unwrap();
    assert_eq!(linear_links(&state), [live("lin-1", "ENG-1", "a")]);
    assert_eq!(
        state
            .kanban(|db, _| kanban::load_issue(db, &local[0]))
            .unwrap_err(),
        kanban::ISSUE_NOT_FOUND
    );
}

#[test]
fn a_transfer_keeps_the_local_issue_whose_description_changed_since_it_was_copied() {
    let state = state();
    let local = issues(&state, 1);
    save_session(&state, "a");
    state.link_session_kanban_issue("a", &local[0]).unwrap();
    state
        .kanban(|db, _| kanban::update_description(db, &local[0], "Copied"))
        .unwrap();
    let before = state.workspace().unwrap().kanban_issue_sessions;

    for source in [None, Some("Older")] {
        assert_eq!(
            state
                .transfer_kanban_issue_to_linear(&local[0], "lin-1", "ENG-1", &[], source)
                .unwrap_err(),
            "[Kanban/transferIncomplete] ENG-1 : la description a été modifiée pendant l’envoi, l’issue locale est conservée."
        );
    }
    assert_eq!(state.workspace().unwrap().kanban_issue_sessions, before);
    assert_eq!(
        state
            .kanban(|db, _| kanban::load_issue(db, &local[0]))
            .unwrap()
            .description
            .as_deref(),
        Some("Copied")
    );

    state
        .transfer_kanban_issue_to_linear(&local[0], "lin-1", "ENG-1", &[], Some("Copied"))
        .unwrap();
    assert_eq!(linear_links(&state), [live("lin-1", "ENG-1", "a")]);
}

#[test]
fn only_an_issue_without_parent_or_sub_issue_can_be_transferred() {
    let state = state();
    let local = issues(&state, 2);
    let child = state
        .kanban(|db, _| {
            kanban::create_issue(
                db,
                KanbanIssueCreateInput {
                    team_id: kanban::default_team_id(db)?,
                    title: "Child".into(),
                    parent_id: Some(local[0].clone()),
                    ..KanbanIssueCreateInput::default()
                },
            )
        })
        .unwrap();

    for issue_id in [&local[0], &child.id] {
        assert_eq!(
            state.check_kanban_issue_transfer(issue_id).unwrap_err(),
            kanban::TRANSFER_SUB_ISSUES_MESSAGE
        );
    }
    assert_eq!(state.check_kanban_issue_transfer(&local[1]), Ok(()));
    assert_eq!(
        state.check_kanban_issue_transfer("missing").unwrap_err(),
        kanban::ISSUE_NOT_FOUND
    );
}
