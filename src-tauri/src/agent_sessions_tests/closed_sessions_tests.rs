use super::kanban_issue_sessions_tests::{issues, save_session, state};
use super::*;
use crate::{kanban, sqlite::table_column_exists};

fn save_favorite_in(state: &AgentSessions, session_id: &str, project_id: &str, favorite: bool) {
    state
        .save_session(AgentSession {
            id: session_id.into(),
            project_id: project_id.into(),
            favorite,
            ..session()
        })
        .unwrap();
}
fn save_favorite(state: &AgentSessions, session_id: &str, favorite: bool) {
    save_favorite_in(state, session_id, "project", favorite);
}
fn closed_ids(state: &AgentSessions) -> Vec<String> {
    state.workspace().unwrap().closed_session_ids
}

#[test]
fn only_favorite_or_linked_sessions_can_be_closed() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "plain");
    save_favorite(&state, "favorite", true);
    save_session(&state, "linked");
    state
        .link_session_kanban_issue("linked", &issues[0])
        .unwrap();

    assert_eq!(
        state.set_session_closed("plain", true).unwrap_err(),
        "Seule une session favorite ou liée à une issue peut être fermée sans être supprimée."
    );
    state.set_session_closed("favorite", true).unwrap();
    state.set_session_closed("linked", true).unwrap();
    assert_eq!(closed_ids(&state), ["favorite", "linked"]);

    state.set_session_closed("favorite", false).unwrap();
    assert_eq!(closed_ids(&state), ["linked"]);
    assert_eq!(
        state.set_session_closed("missing", true).unwrap_err(),
        "Session introuvable."
    );
}

#[test]
fn a_closed_session_reopens_once_neither_a_favorite_nor_an_issue_keeps_it() {
    let state = state();
    let issues = issues(&state, 2);
    save_favorite(&state, "favorite", true);
    save_favorite(&state, "both", true);
    state.link_session_kanban_issue("both", &issues[0]).unwrap();
    save_session(&state, "linked");
    state
        .link_session_kanban_issue("linked", &issues[1])
        .unwrap();
    for session_id in ["favorite", "both", "linked"] {
        state.set_session_closed(session_id, true).unwrap();
    }

    state.delete_kanban_issue(&issues[0]).unwrap();
    state.delete_kanban_issue(&issues[1]).unwrap();
    assert_eq!(closed_ids(&state), ["favorite", "both"]);

    save_favorite(&state, "both", false);
    assert_eq!(closed_ids(&state), ["favorite"]);
}

#[cfg(unix)]
#[test]
fn a_running_session_cannot_be_closed() {
    let state = state();
    save_favorite(&state, "a", true);
    state.start("a", 80, 24, None).unwrap();

    assert!(state.set_session_closed("a", true).is_err());
    assert!(closed_ids(&state).is_empty());
    state.stop("a").unwrap();
    wait_for(|| state.statuses().unwrap()[0].state != "running");
    state.set_session_closed("a", true).unwrap();
    assert_eq!(closed_ids(&state), ["a"]);
    state.shutdown();
}

#[cfg(unix)]
#[test]
fn a_closed_session_cannot_be_started_until_reopened() {
    let state = state();
    save_favorite(&state, "a", true);
    state.set_session_closed("a", true).unwrap();

    assert_eq!(
        state.start("a", 80, 24, None).unwrap_err(),
        "Rouvrez cette session avant de la démarrer."
    );
    assert_ne!(state.statuses().unwrap()[0].state, "running");

    state.set_session_closed("a", false).unwrap();
    state.start("a", 80, 24, None).unwrap();
    state.shutdown();
}

#[test]
fn closing_a_session_of_a_connected_ssh_project_requires_stopping_it_remotely() {
    let state = memory_state();
    insert_project(&state, &ssh_project("remote"));
    save_favorite_in(&state, "a", "remote", true);

    assert!(state
        .set_session_closed("a", true)
        .unwrap_err()
        .starts_with(REMOTE_STOP_FAILED));
    assert!(closed_ids(&state).is_empty());

    disconnect_project(&state, "remote").unwrap();
    state.set_session_closed("a", true).unwrap();
    assert_eq!(closed_ids(&state), ["a"]);
}

#[test]
fn the_closed_flag_of_a_former_issue_link_moves_to_its_session() {
    let state = state();
    let issues = issues(&state, 1);
    save_session(&state, "a");
    state.link_session_kanban_issue("a", &issues[0]).unwrap();
    {
        let mut store = lock(&state.store).unwrap();
        store
            .db
            .execute_batch(
                "ALTER TABLE agent_kanban_issue_sessions ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
                UPDATE agent_kanban_issue_sessions SET closed=1;",
            )
            .unwrap();
        kanban::initialize(&mut store.db).unwrap();
        assert!(!table_column_exists(&store.db, "agent_kanban_issue_sessions", "closed").unwrap());
    }
    assert_eq!(closed_ids(&state), ["a"]);
}
