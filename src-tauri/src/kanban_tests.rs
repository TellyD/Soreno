use super::*;
use crate::agent_sessions::tests::unique_temp_path;

pub(super) fn database() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "PRAGMA foreign_keys=ON;
        CREATE TABLE agent_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES agent_projects(id), data TEXT NOT NULL);
        CREATE TABLE agent_schema_migrations (name TEXT PRIMARY KEY);",
    )
    .unwrap();
    initialize(&mut db).unwrap();
    db
}

fn team_id(db: &Connection) -> String {
    default_team_id(db).unwrap()
}

fn state_named(db: &Connection, name: &str) -> String {
    db.query_row(
        "SELECT id FROM kanban_states WHERE name=?1",
        [name],
        |row| row.get(0),
    )
    .unwrap()
}

fn create(db: &Connection, title: &str) -> KanbanIssue {
    create_issue(
        db,
        KanbanIssueCreateInput {
            team_id: team_id(db),
            title: title.into(),
            ..KanbanIssueCreateInput::default()
        },
    )
    .unwrap()
}

fn patch(value: serde_json::Value) -> KanbanIssueInput {
    serde_json::from_value(value).unwrap()
}

fn count(db: &Connection, query: &str) -> i64 {
    db.query_row(query, [], |row| row.get(0)).unwrap()
}

fn other_team(db: &Connection) -> String {
    db.execute(
        "INSERT INTO kanban_teams(id, key, name) VALUES ('t-ops', 'OPS', 'Ops')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO kanban_states(id, team_id, name, type, color, position) VALUES ('s-ops', 't-ops', 'Todo', 'unstarted', '#e2e2e2', 0)",
        [],
    )
    .unwrap();
    "t-ops".into()
}

fn insert_project(db: &Connection, id: &str, name: &str) {
    db.execute(
        "INSERT INTO agent_projects(id, data) VALUES (?1, ?2)",
        [id, &serde_json::json!({ "name": name }).to_string()],
    )
    .unwrap();
}

#[test]
fn the_migration_keeps_linear_links_drops_the_legacy_table_and_seeds_the_default_team_once() {
    let root = unique_temp_path("soreno-kanban-migration");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("agents.sqlite");
    let db = Connection::open(&path).unwrap();
    // The tables as a version older than the local board left them.
    db.execute_batch(
        "CREATE TABLE agent_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES agent_projects(id), data TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE agent_schema_migrations (name TEXT PRIMARY KEY);
        CREATE TABLE agent_project_linear_links (project_id TEXT PRIMARY KEY REFERENCES agent_projects(id) ON DELETE CASCADE, linear_project_id TEXT NOT NULL UNIQUE);
        CREATE TABLE agent_linear_issue_sessions (linear_issue_id TEXT PRIMARY KEY, linear_issue_identifier TEXT NOT NULL, session_id TEXT UNIQUE REFERENCES agent_sessions(id) ON DELETE SET NULL, session_name TEXT NOT NULL, executable TEXT NOT NULL, project_name TEXT NOT NULL, started_at TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, ended_at TEXT, end_reason TEXT CHECK (end_reason IN ('session','project','worktree','merged')), merged_into TEXT);
        CREATE TABLE agent_linear_issue_summaries (summary_id TEXT PRIMARY KEY, linear_issue_id TEXT NOT NULL REFERENCES agent_linear_issue_sessions(linear_issue_id) ON DELETE CASCADE);
        CREATE TABLE agent_session_linear_issues (session_id TEXT PRIMARY KEY);
        INSERT INTO agent_projects VALUES ('p-web', '{}');
        INSERT INTO agent_sessions VALUES ('s', 'p-web', '{}', 0);
        INSERT INTO agent_project_linear_links VALUES ('p-web', 'lin-project');
        INSERT INTO agent_linear_issue_sessions(linear_issue_id, linear_issue_identifier, session_id, session_name, executable, project_name, started_at, closed)
            VALUES ('lin-1', 'ENG-1', 's', 'Agent', 'codex', 'web', '2026-01-01', 1);
        INSERT INTO agent_linear_issue_summaries VALUES ('s-1', 'lin-1');",
    )
    .unwrap();
    drop(db);
    for launch in 0..2 {
        let mut db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        initialize(&mut db).unwrap();
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_session_linear_issues'"
            ),
            0
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM agent_project_linear_links"),
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM agent_linear_issue_summaries"),
            1
        );
        // Closing moved from the link to the session.
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM agent_sessions WHERE closed=1"),
            1
        );
        assert!(!table_column_exists(&db, "agent_linear_issue_sessions", "closed").unwrap());
        assert!(
            table_column_exists(&db, "agent_linear_issue_sessions", "summary_comment_id").unwrap()
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM agent_linear_issue_sessions WHERE session_id='s'"
            ),
            1
        );
        let board = load_board(&db).unwrap();
        assert_eq!(
            (board.team.key.as_str(), board.team.name.as_str()),
            ("SOR", "Soreno")
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM kanban_teams"), 1);
        let states = board
            .states
            .iter()
            .map(|state| (state.name.as_str(), state.r#type.as_str()))
            .collect::<Vec<_>>();
        let seeded = [
            ("Backlog", "backlog"),
            ("Todo", "unstarted"),
            ("In Progress", "started"),
            ("In Review", "started"),
            ("Done", "completed"),
            ("Canceled", "canceled"),
        ];
        if launch == 0 {
            assert_eq!(states, seeded);
            // A state the user removed is not seeded again on the next launch.
            db.execute("DELETE FROM kanban_states WHERE name='Canceled'", [])
                .unwrap();
        } else {
            assert_eq!(states, seeded[..5]);
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn linear_tables_are_created_empty_without_seeding_again() {
    let mut db = database();
    initialize(&mut db).unwrap();
    for table in [
        "agent_linear_issue_sessions",
        "agent_linear_issue_summaries",
        "agent_project_linear_links",
    ] {
        assert_eq!(count(&db, &format!("SELECT COUNT(*) FROM {table}")), 0);
    }
    assert_eq!(count(&db, "SELECT COUNT(*) FROM kanban_teams"), 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM kanban_states"), 6);
}

#[test]
fn identifiers_count_per_team_and_are_never_reused_after_a_deletion() {
    let db = database();
    assert_eq!(create(&db, "One").identifier, "SOR-1");
    let second = create(&db, "Two");
    assert_eq!(second.identifier, "SOR-2");
    delete_issue(&db, &second.id).unwrap();
    assert_eq!(create(&db, "Three").identifier, "SOR-3");

    let ops = other_team(&db);
    let ops_issue = create_issue(
        &db,
        KanbanIssueCreateInput {
            team_id: ops,
            title: "Ops".into(),
            ..KanbanIssueCreateInput::default()
        },
    )
    .unwrap();
    assert_eq!(ops_issue.identifier, "OPS-1");
}

#[test]
fn branch_names_fold_the_title_into_an_ascii_slug() {
    assert_eq!(
        branch_name("SOR", 66, "Lancer un agent via l’ajout d’une issue"),
        "sor-66-lancer-un-agent-via-lajout-dune-issue"
    );
    assert_eq!(
        branch_name("SOR", 3, "  Œuvre « Ça marche » : déjà-vu, cœur & ÆTHER!  "),
        "sor-3-oeuvre-ca-marche-deja-vu-coeur-aether"
    );
    assert_eq!(branch_name("SOR", 4, "« ! »"), "sor-4");
    let long = "word ".repeat(20);
    let slug = branch_name("SOR", 5, &long);
    assert_eq!(slug, format!("sor-5-{}", ["word"; 12].join("-")));
    assert_eq!(
        branch_name("SOR", 6, &"a".repeat(70)),
        format!("sor-6-{}", "a".repeat(60))
    );
}

#[test]
fn creation_applies_defaults_and_rejects_references_outside_the_team() {
    let db = database();
    let issue = create_issue(
        &db,
        KanbanIssueCreateInput {
            team_id: team_id(&db),
            title: "  Fix login  ".into(),
            description: Some("  \n ".into()),
            ..KanbanIssueCreateInput::default()
        },
    )
    .unwrap();
    assert_eq!(issue.title, "Fix login");
    assert_eq!(issue.state_id, state_named(&db, "Todo"));
    assert_eq!(issue.priority, 0);
    assert_eq!(load_issue(&db, &issue.id).unwrap().description, None);

    let ops = other_team(&db);
    let ops_label = create_label(&db, &ops, "Infra").unwrap();
    let ops_issue = create_issue(
        &db,
        KanbanIssueCreateInput {
            team_id: ops.clone(),
            title: "Ops".into(),
            ..KanbanIssueCreateInput::default()
        },
    )
    .unwrap();
    let invalid = |input: KanbanIssueCreateInput| {
        create_issue(
            &db,
            KanbanIssueCreateInput {
                team_id: team_id(&db),
                title: "Child".into(),
                ..input
            },
        )
        .unwrap_err()
    };
    assert_eq!(
        invalid(KanbanIssueCreateInput {
            state_id: Some("s-ops".into()),
            ..KanbanIssueCreateInput::default()
        }),
        STATE_NOT_FOUND
    );
    assert_eq!(
        invalid(KanbanIssueCreateInput {
            label_ids: vec![ops_label.id],
            ..KanbanIssueCreateInput::default()
        }),
        LABEL_NOT_FOUND
    );
    assert_eq!(
        invalid(KanbanIssueCreateInput {
            parent_id: Some(ops_issue.id),
            ..KanbanIssueCreateInput::default()
        }),
        PARENT_NOT_FOUND
    );
    assert_eq!(
        invalid(KanbanIssueCreateInput {
            project_id: Some("missing".into()),
            ..KanbanIssueCreateInput::default()
        }),
        PROJECT_NOT_FOUND
    );
    assert_eq!(
        invalid(KanbanIssueCreateInput {
            priority: Some(5),
            ..KanbanIssueCreateInput::default()
        }),
        PRIORITY_MESSAGE
    );
    assert_eq!(
        create_issue(
            &db,
            KanbanIssueCreateInput {
                team_id: team_id(&db),
                title: "x".repeat(256),
                ..KanbanIssueCreateInput::default()
            },
        )
        .unwrap_err(),
        TITLE_MESSAGE
    );
    // Failed creations consume no number.
    assert_eq!(create(&db, "Next").identifier, "SOR-2");
}

#[test]
fn labels_are_added_and_removed_within_the_issue_team_only() {
    let db = database();
    let team = team_id(&db);
    let bug = create_label(&db, &team, "Bug").unwrap();
    let ux = create_label(&db, &team, "ux").unwrap();
    assert_eq!(create_label(&db, &team, " BUG ").unwrap(), bug);
    let issue = create(&db, "Issue");

    let update = update_issue(
        &db,
        &issue.id,
        patch(serde_json::json!({ "addedLabelIds": [ux.id, bug.id] })),
    )
    .unwrap();
    assert_eq!(
        update
            .labels
            .iter()
            .map(|label| label.name.as_str())
            .collect::<Vec<_>>(),
        ["Bug", "ux"]
    );
    let update = update_issue(
        &db,
        &issue.id,
        patch(serde_json::json!({ "removedLabelIds": [bug.id] })),
    )
    .unwrap();
    assert_eq!(update.labels, [ux.clone()]);

    assert_eq!(
        update_issue(
            &db,
            &issue.id,
            patch(serde_json::json!({ "addedLabelIds": [bug.id], "removedLabelIds": [bug.id] })),
        )
        .unwrap_err(),
        LABEL_CONFLICT_MESSAGE
    );
    let ops_label = create_label(&db, &other_team(&db), "Bug").unwrap();
    assert_ne!(ops_label.id, bug.id);
    for key in ["addedLabelIds", "removedLabelIds"] {
        assert_eq!(
            update_issue(
                &db,
                &issue.id,
                patch(serde_json::json!({ key: [ops_label.id] }))
            )
            .unwrap_err(),
            LABEL_NOT_FOUND
        );
    }
    assert_eq!(load_issue(&db, &issue.id).unwrap().labels, [ux]);
}

#[test]
fn updates_validate_every_field_before_applying_any() {
    let db = database();
    insert_project(&db, "p-web", "Web");
    let issue = create(&db, "Issue");
    for (value, error) in [
        (serde_json::json!({}), EMPTY_UPDATE_MESSAGE),
        (
            serde_json::json!({ "addedLabelIds": [] }),
            EMPTY_UPDATE_MESSAGE,
        ),
        (serde_json::json!({ "title": " " }), TITLE_MESSAGE),
        (
            serde_json::json!({ "title": "Kept", "priority": 5 }),
            PRIORITY_MESSAGE,
        ),
        (
            serde_json::json!({ "title": "Kept", "projectId": "missing" }),
            PROJECT_NOT_FOUND,
        ),
        (
            serde_json::json!({ "title": "Kept", "stateId": "missing" }),
            STATE_NOT_FOUND,
        ),
        (
            serde_json::json!({ "title": "Kept", "assigneeId": null }),
            ASSIGNEE_MESSAGE,
        ),
    ] {
        assert_eq!(
            update_issue(&db, &issue.id, patch(value)).unwrap_err(),
            error
        );
    }
    assert_eq!(load_issue(&db, &issue.id).unwrap().title, "Issue");

    let done = state_named(&db, "Done");
    let update = update_issue(
        &db,
        &issue.id,
        patch(serde_json::json!({ "stateId": done, "priority": 2, "title": " Renamed ", "projectId": "p-web" })),
    )
    .unwrap();
    assert_eq!(
        (
            update.state_id.as_str(),
            update.priority,
            update.title.as_str()
        ),
        (done.as_str(), 2, "Renamed")
    );
    assert_eq!(
        update.project,
        Some(KanbanProjectRef {
            id: "p-web".into(),
            name: "Web".into()
        })
    );
    let cleared = update_issue(
        &db,
        &issue.id,
        patch(serde_json::json!({ "projectId": null })),
    )
    .unwrap();
    assert_eq!(cleared.project, None);
    assert_eq!(cleared.title, "Renamed");
}

#[test]
fn deleting_the_agent_project_unsets_the_issue_project() {
    let db = database();
    insert_project(&db, "p-web", "Web");
    let issue = create_issue(
        &db,
        KanbanIssueCreateInput {
            team_id: team_id(&db),
            title: "Issue".into(),
            project_id: Some("p-web".into()),
            ..KanbanIssueCreateInput::default()
        },
    )
    .unwrap();
    assert_eq!(
        issue.project.map(|project| project.name),
        Some("Web".into())
    );
    db.execute("DELETE FROM agent_projects WHERE id='p-web'", [])
        .unwrap();
    assert_eq!(load_issue(&db, &issue.id).unwrap().project, None);
}

#[test]
fn pull_requests_come_from_the_description_then_the_comments_once() {
    let db = database();
    let issue = create_issue(
        &db,
        KanbanIssueCreateInput {
            team_id: team_id(&db),
            title: "Issue".into(),
            description: Some("Follows https://github.com/acme/app/pull/4".into()),
            ..KanbanIssueCreateInput::default()
        },
    )
    .unwrap();
    create_comment(&db, &issue.id, "Opened https://github.com/acme/app/pull/9").unwrap();
    create_comment(
        &db,
        &issue.id,
        "Rebased https://github.com/acme/app/pull/4/files",
    )
    .unwrap();
    let expected = [
        (4, "https://github.com/acme/app/pull/4"),
        (9, "https://github.com/acme/app/pull/9"),
    ];
    let numbers = |pull_requests: &[KanbanPullRequest]| {
        pull_requests
            .iter()
            .map(|pull_request| (pull_request.number, pull_request.url.clone()))
            .collect::<Vec<_>>()
    };
    let expected = expected
        .map(|(number, url)| (number, url.to_owned()))
        .to_vec();
    assert_eq!(
        numbers(&load_board(&db).unwrap().issues[0].pull_requests),
        expected
    );
    let detail = load_issue(&db, &issue.id).unwrap();
    assert_eq!(numbers(&detail.pull_requests), expected);
    assert_eq!(
        detail
            .comments
            .iter()
            .map(|comment| comment.body.as_str())
            .collect::<Vec<_>>(),
        [
            "Opened https://github.com/acme/app/pull/9",
            "Rebased https://github.com/acme/app/pull/4/files"
        ]
    );
}

#[test]
fn a_summary_extends_its_comment_while_it_exists_else_starts_a_new_one() {
    let db = database();
    let issue = create(&db, "Issue");
    let (first, created) =
        post_summary(&db, &issue.id, None, "Fixed it.\n\n— Codex via Soreno").unwrap();
    assert!(created);
    let (second, created) = post_summary(
        &db,
        &issue.id,
        Some(&first.id),
        "Reviewed it.\n\n— Codex via Soreno\n",
    )
    .unwrap();
    assert!(!created);
    assert_eq!(second.id, first.id);
    assert_eq!(
        second.body,
        "Fixed it.\n\n---\n\nReviewed it.\n\n— Codex via Soreno"
    );
    // A comment edited without its signature keeps all its text.
    assert_eq!(
        appended_summary("Fixed it.\nSee — the log", "Again.\n\n— Pi via Soreno"),
        "Fixed it.\nSee — the log\n\n---\n\nAgain.\n\n— Pi via Soreno"
    );

    let other = create(&db, "Other");
    let (moved, created) = post_summary(&db, &other.id, Some(&first.id), "Elsewhere").unwrap();
    assert!(created);
    assert_ne!(moved.id, first.id);
    delete_comment(&db, &issue.id, &first.id).unwrap();
    let (recreated, created) = post_summary(&db, &issue.id, Some(&first.id), "Again").unwrap();
    assert!(created);
    assert_eq!(recreated.body, "Again");
}

#[test]
fn deleting_a_comment_removes_only_it_from_its_own_issue() {
    let db = database();
    let issue = create(&db, "Issue");
    let other = create(&db, "Other");
    let linked = create_comment(&db, &issue.id, "See https://github.com/acme/app/pull/7").unwrap();
    create_comment(&db, &issue.id, "Kept").unwrap();
    let foreign = create_comment(&db, &other.id, "Foreign").unwrap();

    delete_comment(&db, &other.id, &linked.id).unwrap();
    delete_comment(&db, &issue.id, &foreign.id).unwrap();
    assert_eq!(load_issue(&db, &issue.id).unwrap().comments.len(), 2);
    assert_eq!(load_issue(&db, &other.id).unwrap().comments.len(), 1);

    delete_comment(&db, &issue.id, &linked.id).unwrap();
    let detail = load_issue(&db, &issue.id).unwrap();
    assert_eq!(
        detail
            .comments
            .iter()
            .map(|comment| comment.body.as_str())
            .collect::<Vec<_>>(),
        ["Kept"]
    );
    assert!(detail.pull_requests.is_empty());
    delete_comment(&db, &issue.id, &linked.id).unwrap();
    assert_eq!(
        delete_comment(&db, "missing", &linked.id).unwrap_err(),
        ISSUE_NOT_FOUND
    );
}

#[test]
fn completion_moves_to_the_first_review_state_unless_the_issue_is_settled() {
    let db = database();
    let review = state_named(&db, "In Review");
    let issue = create(&db, "Issue");
    let update = move_issue_to_review(&db, &issue.id).unwrap().unwrap();
    assert_eq!(update.state_id, review);
    assert_eq!(move_issue_to_review(&db, &issue.id).unwrap(), None);

    for settled in ["Done", "Canceled"] {
        let issue = create(&db, settled);
        let state = state_named(&db, settled);
        update_issue(
            &db,
            &issue.id,
            patch(serde_json::json!({ "stateId": state })),
        )
        .unwrap();
        assert_eq!(move_issue_to_review(&db, &issue.id).unwrap(), None);
    }
    db.execute(
        "UPDATE kanban_states SET name='Revue de code', position=-1 WHERE id=?1",
        [&review],
    )
    .unwrap();
    db.execute(
        "INSERT INTO kanban_states(id, team_id, name, type, color, position) VALUES ('s-late', ?1, 'Late review', 'started', '#000000', 9)",
        [team_id(&db)],
    )
    .unwrap();
    let issue = create(&db, "French");
    assert_eq!(
        move_issue_to_review(&db, &issue.id)
            .unwrap()
            .unwrap()
            .state_id,
        review
    );
    db.execute(
        "UPDATE kanban_states SET name='Checks' WHERE type='started' AND (name LIKE '%review%' OR id=?1)",
        [&review],
    )
    .unwrap();
    let issue = create(&db, "No review");
    assert_eq!(move_issue_to_review(&db, &issue.id).unwrap(), None);
}

#[test]
fn deleting_an_issue_removes_what_it_owns_and_unparents_its_children() {
    let db = database();
    let parent = create(&db, "Parent");
    let child = create_issue(
        &db,
        KanbanIssueCreateInput {
            team_id: team_id(&db),
            title: "Child".into(),
            parent_id: Some(parent.id.clone()),
            ..KanbanIssueCreateInput::default()
        },
    )
    .unwrap();
    assert_eq!(
        load_issue(&db, &parent.id)
            .unwrap()
            .children
            .into_iter()
            .map(|child| child.identifier)
            .collect::<Vec<_>>(),
        ["SOR-2"]
    );
    let label = create_label(&db, &team_id(&db), "Bug").unwrap();
    update_issue(
        &db,
        &parent.id,
        patch(serde_json::json!({ "addedLabelIds": [label.id] })),
    )
    .unwrap();
    let comment = create_comment(&db, &parent.id, "Note").unwrap();
    db.execute_batch(
        "INSERT INTO kanban_images VALUES ('i-1', NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', 'image/png', 1, '2026-01-01T00:00:00Z');
        INSERT INTO kanban_images VALUES ('i-2', NULL, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.gif', 'image/gif', 1, '2026-01-01T00:00:00Z');",
    )
    .unwrap();
    update_description(
        &db,
        &parent.id,
        "![a](asset://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)",
    )
    .unwrap();
    create_comment(&db, &child.id, "![b](bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.gif)").unwrap();
    db.execute(
        "INSERT INTO agent_kanban_issue_sessions(issue_id, session_name, executable, project_name, started_at, summary_comment_id)
        VALUES (?1, 'Agent', 'codex', 'Projet', '2026-01-01T00:00:00Z', ?2)",
        [&parent.id, &comment.id],
    )
    .unwrap();
    db.execute(
        "INSERT INTO agent_kanban_issue_summaries VALUES ('turn-1', ?1)",
        [&parent.id],
    )
    .unwrap();

    assert_eq!(
        delete_issue(&db, &parent.id).unwrap(),
        ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"]
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM kanban_comments"),
        1,
        "the child keeps its comment"
    );
    for table in [
        "kanban_issue_labels",
        "agent_kanban_issue_sessions",
        "agent_kanban_issue_summaries",
    ] {
        assert_eq!(
            count(&db, &format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table}"
        );
    }
    assert_eq!(count(&db, "SELECT COUNT(*) FROM kanban_labels"), 1);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM kanban_images WHERE issue_id IS NOT NULL"
        ),
        1
    );
    let parent_id: Option<String> = db
        .query_row(
            "SELECT parent_id FROM kanban_issues WHERE id=?1",
            [&child.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(parent_id, None);
    assert_eq!(delete_issue(&db, &parent.id).unwrap_err(), ISSUE_NOT_FOUND);
}

#[test]
fn every_issue_mutation_moves_its_update_time() {
    let db = database();
    let issue = create(&db, "Issue");
    let stale = "2000-01-01T00:00:00.000Z";
    let reset = || {
        db.execute("UPDATE kanban_issues SET updated_at=?1", [stale])
            .unwrap();
    };
    let updated_at = || load_issue(&db, &issue.id).unwrap().updated_at;
    reset();
    update_description(&db, &issue.id, "Text").unwrap();
    assert_ne!(updated_at(), stale);
    reset();
    let comment = create_comment(&db, &issue.id, "Note").unwrap();
    assert_ne!(updated_at(), stale);
    reset();
    delete_comment(&db, &issue.id, &comment.id).unwrap();
    assert_ne!(updated_at(), stale);
    reset();
    update_issue(&db, &issue.id, patch(serde_json::json!({ "priority": 1 }))).unwrap();
    assert_ne!(updated_at(), stale);
    assert_eq!(
        create_comment(&db, &issue.id, " \n").unwrap_err(),
        EMPTY_COMMENT_MESSAGE
    );
}

#[test]
fn issue_update_time_strictly_grows_even_ahead_of_the_clock() {
    let db = database();
    let issue = create(&db, "Issue");
    let updated_at = || load_issue(&db, &issue.id).unwrap().updated_at;
    let first = update_issue(&db, &issue.id, patch(serde_json::json!({ "priority": 1 })))
        .unwrap()
        .updated_at;
    let second = update_description(&db, &issue.id, "Text")
        .unwrap()
        .updated_at;
    assert!(second > first, "{second} > {first}");

    let future = "2999-12-31T23:59:59.999Z";
    db.execute("UPDATE kanban_issues SET updated_at=?1", [future])
        .unwrap();
    update_issue(&db, &issue.id, patch(serde_json::json!({ "priority": 2 }))).unwrap();
    let after_future = updated_at();
    assert_eq!(after_future, "3000-01-01T00:00:00.000Z");
    create_comment(&db, &issue.id, "Note").unwrap();
    assert_eq!(updated_at(), "3000-01-01T00:00:00.001Z");
}
