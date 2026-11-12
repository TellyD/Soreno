use super::*;
use crate::kanban;

const DIRECTORY: &str = "/tmp/soreno/session";
const WRITABLE_ROOTS: &str = "sandbox_workspace_write.writable_roots=";

fn instruction_args(
    provider: conversations::Provider,
    args: &[&str],
    windows_local: bool,
) -> Vec<String> {
    let mut args = args.iter().map(|arg| (*arg).to_owned()).collect();
    issue_requests::add_instruction(&mut args, provider, DIRECTORY, false, windows_local).unwrap();
    args
}

fn codex_override(value: &str) -> String {
    value
        .strip_prefix("developer_instructions=")
        .expect("developer_instructions override")
        .to_owned()
}

fn without_writable_roots(mut args: Vec<String>) -> Vec<String> {
    assert_eq!(
        args[..2],
        [
            "-c".to_owned(),
            format!("{WRITABLE_ROOTS}[\"{DIRECTORY}\"]")
        ],
        "{args:?}"
    );
    args.drain(..2);
    args
}

#[test]
fn claude_receives_the_instruction_while_pi_and_omp_launch_flags_stay_untouched() {
    let instruction = issue_requests::instruction(DIRECTORY);
    assert!(instruction.contains(&format!("into {DIRECTORY} ")));
    assert_eq!(
        instruction_args(conversations::Provider::Claude, &["--model", "opus"], false),
        vec![
            "--append-system-prompt".to_owned(),
            instruction,
            "--model".into(),
            "opus".into()
        ]
    );
    for provider in [conversations::Provider::Omp, conversations::Provider::Pi] {
        let args = ["--append-system-prompt", "Groupe", "--model", "opus"];
        assert_eq!(instruction_args(provider, &args, false), args);
    }
}

#[test]
fn the_instruction_joins_the_last_claude_prompt_since_only_it_applies() {
    let instruction = issue_requests::instruction(DIRECTORY);
    let args = instruction_args(
        conversations::Provider::Claude,
        &[
            "--append-system-prompt",
            "Groupe",
            "--append-system-prompt",
            "Utilisateur",
            "--add-dir",
            "/srv/api",
            "--",
            "--append-system-prompt",
        ],
        false,
    );
    assert_eq!(
        args,
        vec![
            "--append-system-prompt".to_owned(),
            "Groupe".into(),
            "--append-system-prompt".into(),
            format!("Utilisateur\n\n{instruction}"),
            "--add-dir".into(),
            "/srv/api".into(),
            "--".into(),
            "--append-system-prompt".into(),
        ]
    );
    assert_eq!(
        instruction_args(
            conversations::Provider::Claude,
            &[
                "--append-system-prompt",
                "Groupe",
                "--append-system-prompt=Utilisateur"
            ],
            false,
        ),
        vec![
            "--append-system-prompt".to_owned(),
            "Groupe".into(),
            format!("--append-system-prompt=Utilisateur\n\n{instruction}"),
        ]
    );
}

#[test]
fn codex_receives_an_escaped_instruction_and_write_access_to_the_directory() {
    let directory = "/tmp/a \"quoted\" \\ dir\nnext";
    let mut args = vec!["resume".to_owned()];
    issue_requests::add_instruction(
        &mut args,
        conversations::Provider::Codex,
        directory,
        false,
        false,
    )
    .unwrap();
    assert_eq!(args[0], "-c");
    // TOML basic strings share JSON's escapes for these characters.
    let roots = args[1]
        .strip_prefix(WRITABLE_ROOTS)
        .expect("writable roots");
    assert_eq!(
        serde_json::from_str::<Vec<String>>(roots).unwrap(),
        [directory]
    );
    assert_eq!(args[2], "-c");
    assert_eq!(
        serde_json::from_str::<String>(&codex_override(&args[3])).unwrap(),
        issue_requests::instruction(directory)
    );
    assert_eq!(args[4..], ["resume"]);
}

#[test]
fn codex_write_access_keeps_the_sandbox_mode_chosen_by_the_user() {
    let instruction = |args: &[&str]| instruction_args(conversations::Provider::Codex, args, false);
    // `--sandbox` would override the user's config, and `--add-dir` stops a read-only Codex.
    for chosen in [&[][..], &["--yolo"], &["-s", "read-only"]] {
        let args = without_writable_roots(instruction(chosen));
        assert_eq!(args[0], "-c");
        assert_eq!(args[2..], *chosen);
    }

    // Codex keeps only the last override: Soreno's directory joins it.
    let args = instruction(&[
        "-c",
        "sandbox_workspace_write.writable_roots=['/old']",
        "--config",
        "sandbox_workspace_write.writable_roots = [ '/srv/api' , \"/srv/web\", ]",
        "--",
        "-c",
        "sandbox_workspace_write.writable_roots=['/prompt']",
    ]);
    assert_eq!(args[0], "-c");
    assert_eq!(
        args[2..],
        [
            "-c",
            "sandbox_workspace_write.writable_roots=['/old']",
            "--config",
            "sandbox_workspace_write.writable_roots =[\"/srv/api\",\"/srv/web\",\"/tmp/soreno/session\"]",
            "--",
            "-c",
            "sandbox_workspace_write.writable_roots=['/prompt']",
        ]
    );

    let listed = [
        "-csandbox_workspace_write.writable_roots=[\"/tmp/soreno/session\"]",
        "resume",
    ];
    assert_eq!(instruction(&listed)[2..], listed);

    // The user's override stays as written: the agent asks before writing the request.
    let undecodable = [
        "-c",
        "sandbox_workspace_write.writable_roots=[\"/a\" \"/b\"]",
    ];
    let args = instruction(&undecodable);
    assert!(args[1].starts_with("developer_instructions="), "{args:?}");
    assert_eq!(args[2..], undecodable);

    // Codex replaces the whole table with a later override: Soreno's roots follow it.
    let roots = "sandbox_workspace_write.writable_roots=[\"/tmp/soreno/session\"]";
    let table = "sandbox_workspace_write={network_access=true}";
    let args = instruction(&["-s", "workspace-write", "-c", table]);
    assert_eq!(
        args[2..],
        ["-s", "workspace-write", "-c", table, "-c", roots]
    );

    let child = "sandbox_workspace_write.writable_roots=['/x']";
    let args = instruction(&["-c", child, "-c", table]);
    assert_eq!(args[2..], ["-c", child, "-c", table, "-c", roots]);

    let args = instruction(&["-c", table, "-c", child]);
    assert_eq!(
        args[2..],
        [
            "-c",
            table,
            "-c",
            "sandbox_workspace_write.writable_roots=[\"/x\",\"/tmp/soreno/session\"]",
        ]
    );

    // Soreno cannot merge into an inline table that already lists roots.
    let inline = ["-c", "sandbox_workspace_write={writable_roots=['/x']}"];
    assert_eq!(instruction(&inline)[2..], inline);
}

#[test]
fn windows_local_codex_gets_a_literal_string_or_no_instruction() {
    let args = instruction_args(conversations::Provider::Codex, &[], true);
    assert_eq!(
        args,
        vec![
            "-c".to_owned(),
            format!("{WRITABLE_ROOTS}['{DIRECTORY}']"),
            "-c".into(),
            format!(
                "developer_instructions='{}'",
                issue_requests::instruction(DIRECTORY)
            ),
        ]
    );
    assert!(args.iter().all(|arg| !arg.contains('"')));

    let quoted = |design| {
        let mut args = Vec::new();
        let result = issue_requests::add_instruction(
            &mut args,
            conversations::Provider::Codex,
            r"C:\Users\O'Brien\session",
            design,
            true,
        );
        (result.is_ok(), args)
    };
    assert_eq!(quoted(false), (true, Vec::new()));
    // A design agent without its protocol would only ignore the board: the launch is refused.
    assert_eq!(quoted(true), (false, Vec::new()));
}

#[test]
fn the_instruction_joins_the_last_codex_developer_instructions_override() {
    let instruction = issue_requests::instruction(DIRECTORY);
    let args = without_writable_roots(instruction_args(
        conversations::Provider::Codex,
        &[
            "-c",
            "developer_instructions='ignored'",
            "--config=model=\"o3\"",
            "-c",
            r#"developer_instructions = "Réponds en \"français\"\n\u00e9tape""#,
            "--",
            "-c",
            "developer_instructions='prompt'",
        ],
        false,
    ));
    assert_eq!(
        args[..3],
        [
            "-c",
            "developer_instructions='ignored'",
            "--config=model=\"o3\""
        ]
    );
    assert_eq!(args[3], "-c");
    let value = args[4]
        .strip_prefix("developer_instructions =")
        .expect("the user's key is kept");
    assert_eq!(
        serde_json::from_str::<String>(value).unwrap(),
        format!("Réponds en \"français\"\nétape\n\n{instruction}")
    );
    assert_eq!(args[5..], ["--", "-c", "developer_instructions='prompt'"]);
    assert_eq!(args.len(), 8);

    for inline in [
        "-cdeveloper_instructions='Sois bref'",
        "--config=developer_instructions='Sois bref'",
    ] {
        let args = without_writable_roots(instruction_args(
            conversations::Provider::Codex,
            &[inline],
            false,
        ));
        let prefix = inline.strip_suffix("'Sois bref'").unwrap();
        let value = args[0].strip_prefix(prefix).expect("same override form");
        assert_eq!(
            serde_json::from_str::<String>(value).unwrap(),
            format!("Sois bref\n\n{instruction}")
        );
    }

    assert_eq!(
        instruction_args(
            conversations::Provider::Codex,
            &["-c=developer_instructions='Sois bref'"],
            true
        ),
        vec![
            "-c".to_owned(),
            format!("{WRITABLE_ROOTS}['{DIRECTORY}']"),
            format!("-c=developer_instructions='Sois bref {instruction}'"),
        ]
    );
}

#[test]
fn an_undecodable_codex_override_is_left_alone_without_the_instruction() {
    for value in [
        "developer_instructions=Sois bref",
        "developer_instructions=\"\"\"multi\"\"\"",
        "developer_instructions=\"bad \\q escape\"",
        "developer_instructions='it's'",
    ] {
        let args = ["--model", "o3", "-c", value];
        assert_eq!(
            instruction_args(conversations::Provider::Codex, &args, false),
            args,
            "{value}"
        );
    }
    // A literal string cannot carry the user's quote on Windows.
    let args = ["-c", r#"developer_instructions="Dis \"oui\"""#];
    assert_eq!(
        instruction_args(conversations::Provider::Codex, &args, true),
        args
    );
}

#[cfg(unix)]
struct FakeAgent {
    directory: PathBuf,
    executable: &'static str,
    state: AgentSessions,
}

#[cfg(unix)]
impl FakeAgent {
    fn start(name: &str) -> Self {
        Self::start_as("claude", name)
    }

    fn start_as(executable: &'static str, name: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;

        let directory = unique_temp_path(&format!("soreno-issue-requests-{name}"));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(executable);
        std::fs::write(
            &path,
            "#!/bin/sh\n: > \"$0.argv\"\nfor arg do printf '%s\\0' \"$arg\" >> \"$0.argv\"; done\n: > \"$0.ready\"\nexec sleep 30\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let state = memory_state();
        state.save_project(project()).unwrap();
        state
            .save_session(AgentSession {
                executable: path.to_str().unwrap().into(),
                args: Vec::new(),
                custom_name: Some("Agent login".into()),
                ..session()
            })
            .unwrap();
        state.start("session", 80, 24, None).unwrap();
        wait_for(|| directory.join(format!("{executable}.ready")).exists());
        Self {
            directory,
            executable,
            state,
        }
    }

    fn argv(&self) -> Vec<String> {
        std::fs::read_to_string(self.directory.join(format!("{}.argv", self.executable)))
            .unwrap()
            .split_terminator('\0')
            .map(str::to_owned)
            .collect()
    }

    fn private_directory(&self) -> PathBuf {
        let runtime = self.state.runtime("session").unwrap().unwrap();
        let directory = lock(&runtime.local_attachment_directory).unwrap().clone();
        directory.unwrap()
    }

    fn messages(&self) -> Vec<String> {
        self.state
            .session_messages("session")
            .unwrap()
            .into_iter()
            .map(|message| message.body)
            .collect()
    }

    fn watcher(&self) -> IssueRequestWatcher {
        self.state
            .issue_request_watcher("session")
            .unwrap()
            .unwrap()
    }

    /// Scans until the request is found, then handles it without a Linear key.
    fn handle(&self, watcher: &mut IssueRequestWatcher) -> issue_requests::IssueRequestOutcome {
        self.handle_with(watcher, Ok(None))
    }

    fn handle_with(
        &self,
        watcher: &mut IssueRequestWatcher,
        create_linear: Result<Option<issue_requests::LinearIssueCreator<'_>>>,
    ) -> issue_requests::IssueRequestOutcome {
        let IssueRequestScan::Request(found) = self.state.scan_issue_request(watcher).unwrap()
        else {
            panic!("request expected");
        };
        self.state
            .handle_issue_request(watcher, found, create_linear)
            .unwrap()
            .unwrap()
    }

    fn board_issues(&self) -> Vec<kanban::KanbanIssue> {
        self.state
            .kanban(|db, _| kanban::load_board(db))
            .unwrap()
            .issues
    }
}

#[cfg(unix)]
impl Drop for FakeAgent {
    fn drop(&mut self) {
        let _ = self.state.stop("session");
        self.state.shutdown();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[cfg(unix)]
#[test]
fn an_agent_is_told_to_write_requests_into_its_own_private_directory() {
    let agent = FakeAgent::start("launch");
    let argv = agent.argv();
    let value_of = |flag: &str| {
        argv.windows(2)
            .find(|pair| pair[0] == flag)
            .map(|pair| pair[1].clone())
            .unwrap_or_else(|| panic!("{flag} in {argv:?}"))
    };
    let granted = value_of("--add-dir");
    assert_eq!(granted, agent.private_directory().to_str().unwrap());
    assert_eq!(
        value_of("--append-system-prompt"),
        issue_requests::instruction(&granted)
    );
}

#[cfg(unix)]
#[test]
fn a_request_file_creates_the_issue_once_and_the_agent_is_told_its_identifier() {
    let agent = FakeAgent::start("success");
    let request = agent.private_directory().join("kanban-issue-login.json");
    std::fs::write(
        &request,
        r#"{"title": "  Fix login redirect ", "description": "\nSteps to reproduce\n"}"#,
    )
    .unwrap();
    let mut watcher = agent.watcher();
    let outcome = agent.handle(&mut watcher);

    let issues = agent.board_issues();
    assert_eq!(issues.len(), 1);
    let issue = &issues[0];
    assert_eq!(
        (issue.identifier.as_str(), issue.title.as_str()),
        ("SOR-1", "Fix login redirect")
    );
    assert_eq!(
        issue.project.as_ref().map(|project| project.id.as_str()),
        Some("project")
    );
    let detail = agent
        .state
        .kanban(|db, _| kanban::load_issue(db, &issue.id))
        .unwrap();
    assert_eq!(detail.description.as_deref(), Some("Steps to reproduce"));
    assert!(!request.exists());
    assert_eq!(
        outcome.event,
        issue_requests::KanbanIssueRequestEvent {
            session_id: "session".into(),
            session_name: "Agent login".into(),
            title: "Fix login redirect".into(),
            updated: false,
            issue: Some(issue_requests::CreatedIssue {
                id: issue.id.clone(),
                identifier: "SOR-1".into(),
                source: kanban::KanbanSource::Local,
            }),
            error: None,
        }
    );
    assert!(outcome.queued && outcome.start_worker);
    assert_eq!(
        agent.messages(),
        ["Soreno: Kanban issue SOR-1 \"Fix login redirect\" created."]
    );
    assert!(matches!(
        agent.state.scan_issue_request(&mut watcher).unwrap(),
        IssueRequestScan::Idle
    ));
}

#[cfg(unix)]
#[test]
fn an_omp_conversation_gets_the_issue_it_requests() {
    let directory = unique_temp_path("soreno-issue-requests-conversation");
    std::fs::create_dir_all(&directory).unwrap();
    let state = memory_state();
    state.save_project(project()).unwrap();
    state
        .save_session(AgentSession {
            kind: conversation::KIND.into(),
            executable: conversation::EXECUTABLE.into(),
            args: Vec::new(),
            ..session()
        })
        .unwrap();
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", "cat >/dev/null"]);
    let omp = conversation::ConversationProcess::spawn(
        command,
        format!("soreno-issue-request-omp-{}", std::process::id()),
        (),
        None,
    )
    .unwrap();
    *lock(&omp.local_files).unwrap() = Some(directory.clone());
    lock(&state.store)
        .unwrap()
        .omp_conversations
        .insert("session".into(), Arc::clone(&omp));
    std::fs::write(
        directory.join("kanban-issue-test.json"),
        r#"{"title": "Test"}"#,
    )
    .unwrap();

    let mut watcher = state.issue_request_watcher("session").unwrap().unwrap();
    let IssueRequestScan::Request(found) = state.scan_issue_request(&mut watcher).unwrap() else {
        panic!("request expected");
    };
    let outcome = state
        .handle_issue_request(&mut watcher, found, Ok(None))
        .unwrap()
        .unwrap();
    assert_eq!(
        outcome.event.issue.map(|issue| issue.identifier),
        Some("SOR-1".into())
    );
    assert!(outcome.queued);
    omp.stop().unwrap();
    assert!(matches!(
        state.scan_issue_request(&mut watcher).unwrap(),
        IssueRequestScan::Stopped
    ));
    state.shutdown();
}

#[cfg(unix)]
#[test]
fn an_unparsable_request_is_retried_then_reported_as_failed() {
    let agent = FakeAgent::start("invalid");
    let request = agent.private_directory().join("kanban-issue-broken.json");
    std::fs::write(&request, r#"{"title": "#).unwrap();
    let mut watcher = agent.watcher();
    for _ in 0..2 {
        assert!(matches!(
            agent.state.scan_issue_request(&mut watcher).unwrap(),
            IssueRequestScan::Idle
        ));
        assert!(request.exists());
    }
    let outcome = agent.handle(&mut watcher);

    assert!(!request.exists());
    assert_eq!(outcome.event.title, "kanban-issue-broken.json");
    assert_eq!(outcome.event.issue, None);
    let error = outcome.event.error.expect("error");
    let text = error
        .strip_prefix("[Kanban/requestInvalidJson] ")
        .expect("coded error");
    assert!(text.starts_with("JSON invalide"), "{error}");
    assert_eq!(
        agent.messages(),
        vec![format!(
            "Soreno: the Kanban issue \"kanban-issue-broken.json\" could not be created: {text}"
        )]
    );
    assert!(agent.board_issues().is_empty());
}

#[cfg(unix)]
#[test]
fn a_stale_scan_creates_the_request_now_under_its_name_instead_of_a_duplicate() {
    let agent = FakeAgent::start("shared");
    let directory = agent.private_directory();
    let request = directory.join("kanban-issue-shared.json");
    std::fs::write(&request, r#"{"title": "Once"}"#).unwrap();
    let mut watchers = [(); 2].map(|_| agent.watcher());
    let found = watchers.each_mut().map(|watcher| {
        let IssueRequestScan::Request(found) = agent.state.scan_issue_request(watcher).unwrap()
        else {
            panic!("both watchers see the request");
        };
        found
    });
    let [first_found, second_found] = found;
    let [first, second] = &mut watchers;
    assert!(agent
        .state
        .handle_issue_request(first, first_found, Ok(None))
        .unwrap()
        .is_some());
    // The agent reuses the freed name before the second watcher handles its stale scan.
    std::fs::write(&request, r#"{"title": "Next"}"#).unwrap();
    assert!(agent
        .state
        .handle_issue_request(second, second_found, Ok(None))
        .unwrap()
        .is_some());
    assert!(matches!(
        agent.state.scan_issue_request(first).unwrap(),
        IssueRequestScan::Idle
    ));
    let mut titles = agent
        .board_issues()
        .into_iter()
        .map(|issue| issue.title)
        .collect::<Vec<_>>();
    titles.sort();
    assert_eq!(titles, ["Next", "Once"]);
    assert_eq!(agent.messages().len(), 2);
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn a_request_already_claimed_by_another_watcher_is_left_to_it() {
    let agent = FakeAgent::start("claimed");
    let directory = agent.private_directory();
    std::fs::write(
        directory.join("kanban-issue-shared.json"),
        r#"{"title": "Once"}"#,
    )
    .unwrap();
    let mut watchers = [(); 2].map(|_| agent.watcher());
    let found = watchers.each_mut().map(|watcher| {
        let IssueRequestScan::Request(found) = agent.state.scan_issue_request(watcher).unwrap()
        else {
            panic!("both watchers see the request");
        };
        found
    });
    let [first_found, second_found] = found;
    let [first, second] = &mut watchers;
    assert!(agent
        .state
        .handle_issue_request(first, first_found, Ok(None))
        .unwrap()
        .is_some());
    assert!(agent
        .state
        .handle_issue_request(second, second_found, Ok(None))
        .unwrap()
        .is_none());
    assert_eq!(agent.board_issues().len(), 1);
    assert_eq!(agent.messages().len(), 1);
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn issues_requested_by_a_session_linked_to_an_issue_go_to_its_project() {
    let agent = FakeAgent::start("linked");
    insert_project(&agent.state, &local_project("web"));
    let linked = agent
        .state
        .kanban(|db, _| {
            kanban::create_issue(
                db,
                kanban::KanbanIssueCreateInput {
                    team_id: kanban::default_team_id(db)?,
                    title: "Linked".into(),
                    project_id: Some("web".into()),
                    ..kanban::KanbanIssueCreateInput::default()
                },
            )
        })
        .unwrap();
    agent
        .state
        .link_session_kanban_issue("session", &linked.id)
        .unwrap();
    std::fs::write(
        agent.private_directory().join("kanban-issue-web.json"),
        r#"{"title": "Cache assets"}"#,
    )
    .unwrap();
    let outcome = agent.handle(&mut agent.watcher());

    let created = outcome.event.issue.expect("created");
    assert_eq!(created.identifier, "SOR-2");
    let issue = agent
        .board_issues()
        .into_iter()
        .find(|issue| issue.id == created.id)
        .unwrap();
    assert_eq!(
        issue.project.map(|project| project.id).as_deref(),
        Some("web")
    );
    assert_eq!(
        agent.messages(),
        ["Soreno: Kanban issue SOR-2 \"Cache assets\" created."]
    );
}

#[cfg(unix)]
#[test]
fn an_update_request_edits_the_linked_issue_and_never_creates_one() {
    let agent = FakeAgent::start("update");
    let request = agent.private_directory().join("kanban-issue-edit.json");
    let write = || {
        std::fs::write(
            &request,
            r#"{"update": true, "title": " Renamed ", "description": " New steps ", "summary": " Rewrote the steps. "}"#,
        )
        .unwrap()
    };
    write();
    let shot = "http://asset.localhost/O'Connor/shot.png";
    let mut watcher = agent.watcher().with_image_targets(vec![shot.into()]);
    let unlinked = agent.handle(&mut watcher);
    assert_eq!(
        unlinked.event.error.as_deref(),
        Some(crate::agent_sessions::kanban_issue_sessions::NOT_LINKED_MESSAGE)
    );
    assert!(unlinked.event.updated);
    assert!(agent.board_issues().is_empty());

    let linked = agent
        .state
        .kanban(|db, _| {
            kanban::create_issue(
                db,
                kanban::KanbanIssueCreateInput {
                    team_id: kanban::default_team_id(db)?,
                    title: "Original".into(),
                    description: Some("Old steps".into()),
                    ..kanban::KanbanIssueCreateInput::default()
                },
            )
        })
        .unwrap();
    agent
        .state
        .link_session_kanban_issue("session", &linked.id)
        .unwrap();
    write();
    let outcome = agent.handle(&mut watcher);

    assert_eq!(
        outcome.event.issue,
        Some(issue_requests::CreatedIssue {
            id: linked.id.clone(),
            identifier: "SOR-1".into(),
            source: kanban::KanbanSource::Local,
        })
    );
    let detail = agent
        .state
        .kanban(|db, _| kanban::load_issue(db, &linked.id))
        .unwrap();
    assert_eq!(
        (detail.title.as_str(), detail.description.as_deref()),
        ("Renamed", Some("New steps"))
    );
    // A local issue has no history: the agent's signed summary says what changed.
    assert_eq!(detail.comments.len(), 1);
    assert_eq!(
        detail.comments[0].body,
        "Rewrote the steps.\n\n— claude via Soreno"
    );
    assert_eq!(agent.board_issues().len(), 1);
    assert_eq!(
        agent.messages(),
        [
            "Soreno: the linked Kanban issue could not be updated: Cette session d’agent n’est liée à aucune issue.",
            "Soreno: Kanban issue SOR-1 updated.",
        ]
    );

    // A description change without its summary is refused whole.
    std::fs::write(
        &request,
        r#"{"update": true, "title": "Lost", "description": "Other steps"}"#,
    )
    .unwrap();
    // Refused at parsing, so only reported once the agent had time to finish the file.
    for _ in 0..2 {
        agent.state.scan_issue_request(&mut watcher).unwrap();
    }
    let missing = agent.handle(&mut watcher).event.error.unwrap();
    assert!(missing.starts_with("[Kanban/requestSummary] "), "{missing}");
    let unchanged = agent
        .state
        .kanban(|db, _| kanban::load_issue(db, &linked.id))
        .unwrap();
    assert_eq!(
        (unchanged.title.as_str(), unchanged.description.as_deref()),
        ("Renamed", Some("New steps"))
    );

    // The agent's `image-N` placeholders get their original images back.
    let load_description = || {
        agent
            .state
            .kanban(|db, _| kanban::load_issue(db, &linked.id))
            .unwrap()
            .description
    };
    std::fs::write(
        &request,
        r#"{"update": true, "summary": "Linked the shot.", "description": "See ![x](image-1) and ![x](<image-1.png> \"t\") ![x](image-1\u00a0\"t\")"}"#,
    )
    .unwrap();
    assert!(agent.handle(&mut watcher).event.error.is_none());
    let resolved = format!("See ![x](<{shot}>) and ![x](<{shot}> \"t\") ![x](<{shot}>\u{a0}\"t\")");
    assert_eq!(load_description().as_deref(), Some(resolved.as_str()));
    std::fs::write(
        &request,
        r#"{"update": true, "title": "Lost", "summary": "Lost.", "description": "![y](image-2)"}"#,
    )
    .unwrap();
    let unknown = agent.handle(&mut watcher).event.error.unwrap();
    assert!(
        unknown.starts_with("[Kanban/requestImagePlaceholder] "),
        "{unknown}"
    );
    assert_eq!(load_description().as_deref(), Some(resolved.as_str()));
    assert_eq!(agent.board_issues()[0].title, "Renamed");
}

#[cfg(unix)]
fn linear_agent(name: &str) -> FakeAgent {
    let agent = FakeAgent::start(name);
    agent
        .state
        .link_session_linear_issue("session", "lin-7", "ENG-7")
        .unwrap();
    std::fs::write(
        agent.private_directory().join("kanban-issue-linear.json"),
        r#"{"title": "Cache assets", "description": " Steps "}"#,
    )
    .unwrap();
    agent
}

#[cfg(unix)]
#[test]
fn a_session_linked_to_a_linear_issue_creates_its_requests_next_to_that_issue() {
    let agent = linear_agent("linear");
    let requests = std::cell::RefCell::new(Vec::new());
    let create = |request: issue_requests::LinearIssueRequest| {
        requests.borrow_mut().push(request);
        Ok(issue_requests::CreatedIssue {
            id: "lin-8".into(),
            identifier: "ENG-8".into(),
            source: kanban::KanbanSource::Linear,
        })
    };
    let outcome = agent.handle_with(&mut agent.watcher(), Ok(Some(&create)));

    assert_eq!(
        requests.into_inner(),
        [issue_requests::LinearIssueRequest::Create {
            linked_issue_id: Some("lin-7".into()),
            linear_project_id: None,
            title: "Cache assets".into(),
            description: Some("Steps".into()),
        }]
    );
    assert_eq!(
        outcome.event.issue,
        Some(issue_requests::CreatedIssue {
            id: "lin-8".into(),
            identifier: "ENG-8".into(),
            source: kanban::KanbanSource::Linear,
        })
    );
    assert!(agent.board_issues().is_empty());
    assert_eq!(
        agent.messages(),
        ["Soreno: Kanban issue ENG-8 \"Cache assets\" created."]
    );
}

#[cfg(unix)]
#[test]
fn without_a_linear_key_a_linear_linked_session_gets_a_local_issue() {
    let agent = linear_agent("linear-no-key");
    let outcome = agent.handle(&mut agent.watcher());

    let created = outcome.event.issue.expect("created");
    assert_eq!(created.source, kanban::KanbanSource::Local);
    assert_eq!(agent.board_issues().len(), 1);
}

#[cfg(unix)]
#[test]
fn an_unlinked_session_gets_a_local_issue_even_with_a_linear_key() {
    let agent = FakeAgent::start("linear-unlinked");
    std::fs::write(
        agent.private_directory().join("kanban-issue-local.json"),
        r#"{"title": "Local"}"#,
    )
    .unwrap();
    let create = |_: issue_requests::LinearIssueRequest| -> Result<issue_requests::CreatedIssue> {
        panic!("no Linear issue expected")
    };
    let outcome = agent.handle_with(&mut agent.watcher(), Ok(Some(&create)));

    assert_eq!(
        outcome.event.issue.map(|issue| issue.source),
        Some(kanban::KanbanSource::Local)
    );
    assert_eq!(agent.board_issues().len(), 1);
}

#[cfg(unix)]
#[test]
fn an_unlinked_session_asking_for_linear_creates_it_in_its_projects_linear_project() {
    let agent = FakeAgent::start("linear-asked");
    agent
        .state
        .kanban(|db, _| {
            db.execute(
                "INSERT INTO agent_project_linear_links VALUES ('project', 'lin-project')",
                [],
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    let request = agent.private_directory().join("kanban-issue-asked.json");
    let write = || std::fs::write(&request, r#"{"title": "Asked", "linear": true}"#).unwrap();
    write();
    let requests = std::cell::RefCell::new(Vec::new());
    let create = |request: issue_requests::LinearIssueRequest| {
        requests.borrow_mut().push(request);
        Ok(issue_requests::CreatedIssue {
            id: "lin-9".into(),
            identifier: "ENG-9".into(),
            source: kanban::KanbanSource::Linear,
        })
    };
    let mut watcher = agent.watcher();
    agent.handle_with(&mut watcher, Ok(Some(&create)));
    assert_eq!(
        requests.into_inner(),
        [issue_requests::LinearIssueRequest::Create {
            linked_issue_id: None,
            linear_project_id: Some("lin-project".into()),
            title: "Asked".into(),
            description: None,
        }]
    );

    write();
    let outcome = agent.handle(&mut watcher);
    assert_eq!(
        outcome.event.error.as_deref(),
        Some(crate::linear::MISSING_API_KEY_MESSAGE)
    );
    assert!(agent.board_issues().is_empty());
}

#[cfg(unix)]
#[test]
fn a_linear_failure_is_told_to_the_agent_without_its_tag_and_creates_nothing_locally() {
    let agent = linear_agent("linear-failure");
    let create = |_: issue_requests::LinearIssueRequest| -> Result<issue_requests::CreatedIssue> {
        Err("[Kanban/linearRateLimit] Limite atteinte.".into())
    };
    let outcome = agent.handle_with(&mut agent.watcher(), Ok(Some(&create)));

    assert_eq!(outcome.event.issue, None);
    assert_eq!(
        outcome.event.error.as_deref(),
        Some("[Kanban/linearRateLimit] Limite atteinte.")
    );
    assert!(agent.board_issues().is_empty());
    assert_eq!(
        agent.messages(),
        ["Soreno: the Kanban issue \"Cache assets\" could not be created: Limite atteinte."]
    );
}

#[cfg(unix)]
#[test]
fn a_linear_key_read_error_is_told_to_a_linear_linked_session_instead_of_a_local_issue() {
    let agent = linear_agent("linear-key-error");
    let outcome = agent.handle_with(
        &mut agent.watcher(),
        Err("[Kanban/linearRequest] Trousseau verrouillé.".into()),
    );

    assert_eq!(outcome.event.issue, None);
    assert_eq!(
        outcome.event.error.as_deref(),
        Some("[Kanban/linearRequest] Trousseau verrouillé.")
    );
    assert!(agent.board_issues().is_empty());
    assert_eq!(
        agent.messages(),
        ["Soreno: the Kanban issue \"Cache assets\" could not be created: Trousseau verrouillé."]
    );
}

#[cfg(unix)]
#[test]
fn an_update_of_a_linked_linear_issue_goes_to_linear_and_fails_without_a_key() {
    let agent = linear_agent("linear-update");
    let request = agent.private_directory().join("kanban-issue-linear.json");
    let write = || {
        std::fs::write(
            &request,
            r#"{"update": true, "description": "", "summary": "Cleared it."}"#,
        )
        .unwrap()
    };
    write();
    let requests = std::cell::RefCell::new(Vec::new());
    let update = |request: issue_requests::LinearIssueRequest| {
        requests.borrow_mut().push(request);
        Ok(issue_requests::CreatedIssue {
            id: "lin-7".into(),
            identifier: "ENG-7".into(),
            source: kanban::KanbanSource::Linear,
        })
    };
    let mut watcher = agent.watcher();
    let outcome = agent.handle_with(&mut watcher, Ok(Some(&update)));
    let linked = issue_requests::CreatedIssue {
        id: "lin-7".into(),
        identifier: "ENG-7".into(),
        source: kanban::KanbanSource::Linear,
    };
    assert_eq!(
        requests.into_inner(),
        [issue_requests::LinearIssueRequest::Update {
            issue: linked.clone(),
            title: None,
            description: Some(String::new()),
        }]
    );
    assert_eq!(outcome.event.issue, Some(linked));

    write();
    let outcome = agent.handle(&mut watcher);
    assert_eq!(
        outcome.event.error.as_deref(),
        Some(crate::linear::MISSING_API_KEY_MESSAGE)
    );
    assert!(agent.board_issues().is_empty());
}

#[test]
fn group_session_requests_go_to_the_member_the_agent_names() {
    let state = memory_state();
    insert_project(&state, &local_project("a"));
    insert_project(&state, &local_project("b"));
    state
        .save_group(AgentProjectGroupInput {
            id: "g1".into(),
            name: "Jinka".into(),
            project_ids: vec!["a".into(), "b".into()],
        })
        .unwrap();
    let root = unique_temp_path("soreno-issue-request-group");
    let group_project = state
        .prepare_group_project_with("g1", |_, id| {
            let path = root.join(id);
            std::fs::create_dir_all(&path).unwrap();
            Ok(path.to_string_lossy().into_owned())
        })
        .unwrap();
    let store = lock(&state.store).unwrap();
    let db = &store.db;
    let group = group_project.id.as_str();
    let project = |named| issue_requests::request_project(db, "session", group, named);
    let linear = |named| issue_requests::request_linear_project(db, "session", group, named);
    let link = |project: &str, linear: &str| {
        db.execute(
            "INSERT INTO agent_project_linear_links VALUES (?1, ?2)",
            [project, linear],
        )
        .unwrap();
    };

    assert_eq!(project(None).unwrap(), None);
    assert_eq!(project(Some(" projet B ")).unwrap(), Some("b".into()));
    assert_eq!(
        project(Some("c")).unwrap_err(),
        "[Kanban/requestProject] project: Projet a, Projet b"
    );
    // A session outside a group keeps its own project, whatever it names.
    assert_eq!(
        issue_requests::request_project(db, "session", "a", Some("Projet b")).unwrap(),
        Some("a".into())
    );

    assert_eq!(linear(None).unwrap(), None);
    link("b", "lin-b");
    assert_eq!(linear(None).unwrap(), Some("lin-b".into()));
    assert_eq!(linear(Some("Projet a")).unwrap(), None);
    link("a", "lin-a");
    assert_eq!(
        linear(None).unwrap_err(),
        "[Kanban/requestProject] project: Projet a, Projet b"
    );
    assert_eq!(linear(Some("Projet a")).unwrap(), Some("lin-a".into()));
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn every_agent_provider_is_told_about_issue_requests() {
    for executable in ["pi", "omp"] {
        let agent = FakeAgent::start_as(executable, &format!("bridge-{executable}"));
        let argv = agent.argv();
        assert!(
            !argv
                .iter()
                .any(|arg| arg.starts_with("--append-system-prompt")),
            "{argv:?}"
        );
        let bridge = argv
            .windows(2)
            .find(|pair| pair[0] == "-e")
            .map(|pair| std::fs::read_to_string(&pair[1]).unwrap())
            .unwrap_or_else(|| panic!("bridge in {argv:?}"));
        let config = bridge
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("const soreno = "))
            .and_then(|line| line.strip_suffix(';'))
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(config).unwrap();
        assert_eq!(
            config["systemAppend"],
            issue_requests::instruction(agent.private_directory().to_str().unwrap())
        );
    }
    let agent = FakeAgent::start_as("codex", "codex");
    let instruction = issue_requests::instruction(agent.private_directory().to_str().unwrap());
    let argv = agent.argv();
    assert!(
        argv.iter().any(|arg| arg
            .strip_prefix("developer_instructions=")
            .and_then(codex_overrides::decode_toml_string)
            .is_some_and(|value| value == instruction)),
        "{argv:?}"
    );
}

#[cfg(unix)]
#[test]
fn remote_scripts_skip_invalid_names_and_claim_a_request_once() {
    let directory = unique_temp_path("soreno-issue-scripts");
    std::fs::create_dir_all(&directory).unwrap();
    for (name, content) in [
        ("kanban-issue-.json", "{}"),
        ("kanban-issue-b.json", "{}"),
        ("design-frame-a b.html", "<p>"),
        ("design-frame-a.html", "<p>"),
    ] {
        std::fs::write(directory.join(name), content).unwrap();
    }
    let run = |script: String| {
        let output = std::process::Command::new("sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        (
            output.status.success(),
            String::from_utf8(output.stdout).unwrap(),
        )
    };
    let path = directory.to_str().unwrap();
    let scan = |requests| {
        run(issue_requests::remote_request_script(
            path,
            requests,
            &HashSet::new(),
        ))
    };
    assert_eq!(
        scan(issue_requests::Requests::Kanban),
        (true, "kanban-issue-b.json\n{}".to_owned())
    );
    assert_eq!(
        scan(issue_requests::Requests::DesignFrames),
        (true, "design-frame-a.html\n<p>".to_owned())
    );
    let claim = |requests, name: &str, content: &str| {
        let script =
            issue_requests::remote_claim_script(path, requests, name, &format!("{name}.1.claimed"));
        assert_eq!(run(script.clone()), (true, format!("claimed\n{content}")));
        assert_eq!(run(script), (true, String::new()));
    };
    claim(
        issue_requests::Requests::Kanban,
        "kanban-issue-b.json",
        "{}",
    );
    claim(
        issue_requests::Requests::DesignFrames,
        "design-frame-a.html",
        "<p>",
    );
    let mut left = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    left.sort();
    assert_eq!(left, ["design-frame-a b.html", "kanban-issue-.json"]);
    std::fs::remove_dir_all(&directory).unwrap();
}
