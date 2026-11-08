use super::*;

#[cfg(unix)]
const BODY: &str = "Corrige le verrou.\n\n```rust\nlet lock = acquire(&path)?;\n```";

#[cfg(unix)]
fn output(state: &AgentSessions) -> String {
    terminal(state, "session").unwrap().text()
}

#[cfg(unix)]
fn stopped_state() -> AgentSessions {
    let state = memory_state();
    state.save_project(project()).unwrap();
    // Stays alive after acknowledging: exiting would delete the attachment directory.
    state
        .save_session(AgentSession {
            args: vec![
                "-c".into(),
                "printf ready; read line; printf 'received:%s' \"$line\"; read done".into(),
            ],
            ..session()
        })
        .unwrap();
    state
}

#[cfg(unix)]
fn running_state() -> AgentSessions {
    let state = stopped_state();
    state.start("session", 80, 24, None).unwrap();
    wait_for(|| output(&state).contains("ready"));
    state
}

#[cfg(unix)]
fn statuses(state: &AgentSessions) -> Vec<String> {
    state
        .session_messages("session")
        .unwrap()
        .into_iter()
        .map(|message| message.status)
        .collect()
}

#[cfg(unix)]
#[test]
fn queued_message_is_written_to_a_private_file_and_submitted_as_one_terminal_line() {
    let state = running_state();
    let (message, start_worker) = state.send_message("session", "m1", BODY).unwrap();
    assert!(start_worker);
    assert_eq!(message.status, "queued");
    let (_, second_worker) = state
        .send_message("session", "m2", "Et ajoute un test.")
        .unwrap();
    assert!(!second_worker, "one delivery worker per session");

    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Changed
    );
    wait_for(|| {
        output(&state)
            .rsplit_once("received:")
            .is_some_and(|(_, line)| line.ends_with("act on it."))
    });
    let output = output(&state);
    let line = output.rsplit_once("received:").unwrap().1;
    let path = line
        .strip_prefix("Soreno: new message for you in '")
        .and_then(|rest| rest.split_once("' — read it and act on it."))
        .unwrap_or_else(|| panic!("unexpected nudge: {line:?}"))
        .0;
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        format!("{}\n\n---\n\nEt ajoute un test.", BODY.trim())
    );
    let messages = state.session_messages("session").unwrap();
    assert!(messages
        .iter()
        .all(|message| message.status == "delivered" && message.delivered_at.is_some()));
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Finished { changed: false }
    );
    assert!(
        !lock(&state.store)
            .unwrap()
            .message_workers
            .contains("session"),
        "a finished worker lets the next message start a new one"
    );
    state.shutdown();
}

#[cfg(unix)]
#[test]
fn a_message_to_a_stopped_session_waits_for_its_next_start() {
    let state = stopped_state();
    assert!(state.send_message("session", "m0", " \n").is_err());
    let (message, start_worker) = state.send_message("session", "m1", BODY).unwrap();
    assert!(!start_worker, "nothing can deliver it before a start");
    assert_eq!(message.status, "queued");
    assert!(message.error.is_some(), "the wait is shown");
    // A worker left from the previous run sees the stop without failing it.
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Finished { changed: true }
    );
    assert_eq!(statuses(&state), ["queued"]);

    state.start("session", 80, 24, None).unwrap();
    wait_for(|| output(&state).contains("ready"));
    assert!(state.release_start_messages("session").unwrap());
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Changed
    );
    assert_eq!(statuses(&state), ["delivered"]);
    wait_for(|| output(&state).contains("received:Soreno: new message"));
    state.shutdown();
}

#[cfg(unix)]
#[test]
fn a_message_fails_when_its_run_stops_first() {
    let state = running_state();
    state.send_message("session", "m1", BODY).unwrap();
    state.stop("session").unwrap();
    wait_for(|| terminal(&state, "session").unwrap().status.state != "running");
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Finished { changed: true }
    );
    let messages = state.session_messages("session").unwrap();
    assert_eq!(messages[0].status, "failed");
    assert_eq!(
        messages[0].error.as_deref(),
        Some("Session arrêtée avant la livraison.")
    );

    state.delete_session("session").unwrap();
    let remaining: i64 = lock(&state.store)
        .unwrap()
        .db
        .query_row("SELECT COUNT(*) FROM agent_session_messages", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(remaining, 0);
    state.shutdown();
}

#[cfg(unix)]
#[test]
fn a_batch_bound_to_a_stopped_run_never_reaches_the_restarted_process() {
    let state = running_state();
    state.send_message("session", "m1", BODY).unwrap();
    let stale = lock(&state.store).unwrap().runtimes["session"].clone();
    state.stop("session").unwrap();
    wait_for(|| terminal(&state, "session").unwrap().status.state != "running");
    state.start("session", 80, 24, None).unwrap();
    wait_for(|| terminal(&state, "session").unwrap().status.state == "running");

    let queued = state.session_messages("session").unwrap();
    assert_eq!(
        state
            .deliver_batch("session", &queued, Ok((stale, project().environment)))
            .unwrap(),
        MessageDelivery::Changed
    );
    let messages = state.session_messages("session").unwrap();
    assert_eq!(messages[0].status, "failed");
    assert_eq!(
        messages[0].error.as_deref(),
        Some("Session arrêtée avant la livraison.")
    );
    state.write("session", "ping\r").unwrap();
    wait_for(|| output(&state).contains("received:ping"));
    assert!(!output(&state).contains("Soreno:"));
    state.shutdown();
}

#[cfg(unix)]
#[test]
fn a_message_queued_for_a_stopped_run_is_failed_when_the_session_restarts() {
    let state = running_state();
    state.send_message("session", "m1", BODY).unwrap();
    state.stop("session").unwrap();
    wait_for(|| terminal(&state, "session").unwrap().status.state != "running");
    state.start("session", 80, 24, None).unwrap();
    wait_for(|| terminal(&state, "session").unwrap().status.state == "running");

    let messages = state.session_messages("session").unwrap();
    assert_eq!(messages[0].status, "failed");
    assert_eq!(
        messages[0].error.as_deref(),
        Some("Session arrêtée avant la livraison.")
    );
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Finished { changed: true }
    );
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Finished { changed: false }
    );
    state.write("session", "ping\r").unwrap();
    wait_for(|| output(&state).contains("received:ping"));
    assert!(!output(&state).contains("Soreno:"));
    state.shutdown();
}

#[cfg(unix)]
#[test]
fn a_message_waits_until_the_users_draft_is_submitted() {
    let state = running_state();
    state.write("session", "'src/a.ts' ").unwrap();
    state.send_message("session", "m1", BODY).unwrap();
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Changed
    );
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Waiting
    );
    let messages = state.session_messages("session").unwrap();
    assert_eq!(messages[0].status, "queued");
    assert!(messages[0].error.is_some(), "the hold is shown");
    assert!(!output(&state).contains("Soreno:"));

    state.write("session", "\r").unwrap();
    wait_for(|| output(&state).contains("received:'src/a.ts'"));
    for _ in ["the hold is lifted", "the batch is delivered"] {
        assert_eq!(
            state.deliver_messages("session").unwrap(),
            MessageDelivery::Changed
        );
    }
    let messages = state.session_messages("session").unwrap();
    assert_eq!(messages[0].status, "delivered");
    assert_eq!(messages[0].error, None);
    wait_for(|| output(&state).contains("act on it."));
    assert!(!output(&state).contains("received:'src/a.ts' Soreno"));
    state.shutdown();
}

#[test]
fn only_text_left_in_the_prompt_holds_messages() {
    for (draft, input, expected) in [
        (false, "a", true),
        (true, "\r", false),
        (true, "\x03", false),
        (true, "ok\r", false),
        (false, "\r'src/a.ts' ", true),
        // Arrows (normal and application mode), focus and mouse reports.
        (false, "\x1b[A\x1bOB\x1b[I\x1b[<0;3;4M", false),
        // X10 mouse reports, UTF-8 (1005) coordinates included.
        (false, "\x1b[M\x20\x21\x21", false),
        (false, "\x1b[M\u{20}\u{3e8}\u{21}", false),
        (false, "\x1bv", true),
        (false, "\x16", true),
        (false, "\x1b[200~line\r\x1b[201~", true),
        (false, "\x1b\r", false),
    ] {
        assert_eq!(
            messages::holds_draft(draft, input),
            expected,
            "{draft} {input:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_queue_larger_than_one_attachment_keeps_its_newest_messages_for_the_next_delivery() {
    let state = running_state();
    // Real bodies are capped at 64 KiB; three oversized rows reach the file limit cheaply.
    let body = "x".repeat(AGENT_ATTACHMENT_LIMIT / 3);
    {
        let store = lock(&state.store).unwrap();
        for (index, message_id) in ["m1", "m2", "m3"].into_iter().enumerate() {
            store
                .db
                .execute(
                    "INSERT INTO agent_session_messages(id, session_id, body, status, created_at)
                    VALUES (?1, 'session', ?2, 'queued', ?3)",
                    params![message_id, body, format!("2026-01-01T00:00:0{index}Z")],
                )
                .unwrap();
        }
    }

    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Changed
    );
    assert_eq!(statuses(&state), ["delivered", "delivered", "queued"]);
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Waiting,
        "the remainder waits for the agent to settle"
    );
    assert_eq!(statuses(&state), ["delivered", "delivered", "queued"]);
    state.shutdown();
}

#[test]
fn messages_still_queued_when_soreno_closes_are_marked_undelivered_on_reopen() {
    let dir = unique_temp_path("soreno-messages-reopen");
    {
        let state = AgentSessions::open(&dir).unwrap();
        state.save_project(project()).unwrap();
        state.save_session(session()).unwrap();
        lock(&state.store)
            .unwrap()
            .db
            .execute(
                "INSERT INTO agent_session_messages(id, session_id, body, status, created_at)
                VALUES ('m1', 'session', 'Pendant la fermeture', 'queued', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        // Sent to the stopped session: still waits for its next start after a reopen.
        state.send_message("session", "m2", "Lier SOR-1").unwrap();
    }
    let state = AgentSessions::open(&dir).unwrap();
    let messages = state.session_messages("session").unwrap();
    assert_eq!(messages[0].status, "failed");
    assert_eq!(
        messages[0].error.as_deref(),
        Some("Soreno a été fermé avant la livraison.")
    );
    assert_eq!(messages[1].status, "queued");
    state.shutdown();
    drop(state);
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn claude_may_read_the_directory_that_receives_its_messages() {
    use std::os::unix::fs::PermissionsExt;

    let directory = unique_temp_path("soreno-message-add-dir");
    std::fs::create_dir_all(&directory).unwrap();
    let executable = directory.join("claude");
    std::fs::write(
        &executable,
        "#!/bin/sh\n: > \"$0.argv\"\nfor arg do printf '%s\\0' \"$arg\" >> \"$0.argv\"; done\n: > \"$0.ready\"\nexec sleep 30\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let state = memory_state();
    state.save_project(project()).unwrap();
    state
        .save_session(AgentSession {
            executable: executable.to_str().unwrap().into(),
            args: Vec::new(),
            ..session()
        })
        .unwrap();
    state.start("session", 80, 24, None).unwrap();
    wait_for(|| directory.join("claude.ready").exists());

    let argv = std::fs::read_to_string(directory.join("claude.argv")).unwrap();
    let argv = argv.split_terminator('\0').collect::<Vec<_>>();
    let granted = argv
        .windows(2)
        .find(|pair| pair[0] == "--add-dir")
        .map(|pair| pair[1].to_owned())
        .expect("--add-dir argument");
    let message = state
        .attach_file("session", "soreno-message.md", b"x")
        .unwrap();
    assert!(
        message
            .trim_matches('\'')
            .starts_with(&format!("{granted}/")),
        "{message} is outside {granted}"
    );
    state.stop("session").unwrap();
    state.shutdown();
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn claude_gets_no_message_before_reporting_its_first_state() {
    use std::os::unix::fs::PermissionsExt;

    let directory = unique_temp_path("soreno-message-trust");
    std::fs::create_dir_all(&directory).unwrap();
    let executable = directory.join("claude");
    // Like Claude Code's folder trust screen: Enter answers it before any state is reported.
    std::fs::write(
        &executable,
        "#!/bin/sh\nprintf 'Trust this folder?'\nread answer\nprintf '\\033]7501;state=idle:app=claude-code\\007trusted:%s' \"$answer\"\nread line\nprintf 'received:%s' \"$line\"\nexec sleep 30\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let state = memory_state();
    state.save_project(project()).unwrap();
    state
        .save_session(AgentSession {
            executable: executable.to_str().unwrap().into(),
            args: Vec::new(),
            ..session()
        })
        .unwrap();
    state.start("session", 80, 24, None).unwrap();
    wait_for(|| output(&state).contains("Trust this folder?"));
    state.send_message("session", "m1", BODY).unwrap();
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Waiting
    );

    state.write("session", "\r").unwrap();
    wait_for(|| output(&state).contains("trusted:"));
    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Changed
    );
    wait_for(|| output(&state).contains("received:Soreno: new message"));
    state.stop("session").unwrap();
    state.shutdown();
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn a_disconnected_project_fails_its_omp_batch_without_writing_to_omp() {
    let state = memory_state();
    let remote = ssh_project("remote");
    insert_project(&state, &remote);
    state
        .save_session(AgentSession {
            project_id: remote.id.clone(),
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
        format!("soreno-message-omp-{}", std::process::id()),
        (),
        None,
    )
    .unwrap();
    {
        let mut store = lock(&state.store).unwrap();
        store
            .omp_conversations
            .insert("session".into(), Arc::clone(&omp));
        // Disconnect marks the project before it stops the conversation.
        store
            .db
            .execute_batch(
                "INSERT INTO agent_disconnected_projects(project_id) VALUES ('remote');
                INSERT INTO agent_session_messages(id, session_id, body, status, created_at)
                VALUES ('m1', 'session', 'Commentaire', 'queued', '2026-01-01T00:00:00Z');",
            )
            .unwrap();
    }

    assert_eq!(
        state.deliver_messages("session").unwrap(),
        MessageDelivery::Changed
    );
    let messages = state.session_messages("session").unwrap();
    assert_eq!(messages[0].status, "failed");
    assert_eq!(
        messages[0].error.as_deref(),
        Some("Ce projet SSH est déconnecté. Reconnectez-le avant cette opération.")
    );
    assert!(!omp.exited());
    state.shutdown();
}
