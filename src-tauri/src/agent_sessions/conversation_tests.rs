use super::chunks::CHUNKED_LIMIT;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;

fn chunk(id: &str, index: u64, count: u64, byte_length: usize, data: &[u8]) -> Value {
    json!({
        "type": "rpc_chunk",
        "chunkId": id,
        "index": index,
        "count": count,
        "byteLength": byte_length,
        "data": STANDARD.encode(data),
    })
}

#[test]
fn chunks_in_order_reassemble_one_object() {
    let object = br#"{"type":"response","id":"view-1","success":true}"#;
    let (head, tail) = object.split_at(10);
    let mut pending = None;
    assert_eq!(
        reassemble(&mut pending, &chunk("a", 0, 2, object.len(), head)),
        Ok(None)
    );
    assert_eq!(
        reassemble(&mut pending, &chunk("a", 1, 2, object.len(), tail)),
        Ok(Some(String::from_utf8(object.to_vec()).unwrap()))
    );
    assert!(pending.is_none());
}

#[test]
fn interleaved_oversized_or_mismeasured_chunks_are_refused() {
    let object = br#"{"type":"x"}"#;
    let (head, tail) = object.split_at(4);
    let mut pending = None;
    reassemble(&mut pending, &chunk("a", 0, 2, object.len(), head)).unwrap();
    assert!(reassemble(&mut pending, &chunk("b", 1, 2, object.len(), tail)).is_err());
    assert!(pending.is_none(), "a refused sequence is dropped");

    reassemble(&mut pending, &chunk("a", 0, 2, object.len(), head)).unwrap();
    assert!(reassemble(&mut pending, &chunk("b", 0, 2, object.len(), head)).is_err());

    assert!(reassemble(&mut pending, &chunk("c", 0, 2, CHUNKED_LIMIT + 1, head)).is_err());
    assert!(reassemble(&mut pending, &chunk("d", 0, 1, object.len() - 1, object)).is_err());
    assert!(reassemble(&mut pending, &chunk("e", 0, 1, object.len() + 1, object)).is_err());
    assert!(reassemble(&mut pending, &chunk("f", 1, 2, object.len(), tail)).is_err());
    assert!(reassemble(&mut pending, &chunk("g", 0, 1, 2, b"[]")).is_err());
}

fn handle(state: &mut State, record: Value) -> Handling {
    state.handle(&record, &record.to_string(), false)
}
const FORWARD: Handling = Handling {
    forward: true,
    refresh: false,
    rename: false,
};

#[test]
fn working_follows_runs_until_the_session_settles() {
    let mut state = State::default();
    handle(&mut state, json!({ "type": "agent_start" }));
    assert!(state.working);
    handle(
        &mut state,
        json!({ "type": "prompt_result", "id": "view-1", "sessionSettled": false }),
    );
    assert!(state.working);
    assert_eq!(
        handle(&mut state, json!({ "type": "session_settled" })),
        Handling {
            forward: true,
            refresh: true,
            rename: false,
        }
    );
    assert!(!state.working);
    handle(&mut state, json!({ "type": "agent_start" }));
    handle(
        &mut state,
        json!({ "type": "prompt_result", "id": "view-2", "sessionSettled": true }),
    );
    assert!(!state.working);
    // A host attaching mid-run learns it from the run's state.
    let settled = |settled: bool| {
        json!({ "type": "response", "id": "soreno-host-state-1", "command": "get_state", "success": true,
            "data": { "sessionId": "s", "isSettled": settled } })
    };
    handle(&mut state, settled(false));
    assert!(state.working);
    handle(&mut state, settled(true));
    assert!(!state.working);
}

#[test]
fn a_replay_restores_what_still_holds_and_nothing_else() {
    let dialog = |id: &str| json!({ "type": "extension_ui_request", "id": id, "method": "confirm", "title": "?" });
    let mut state = State::default();
    for record in [
        dialog("answered"),
        json!({ "type": "response", "id": "soreno-host-answered-answered", "command": "get_state", "success": true }),
        json!({ "type": "response", "id": "soreno-host-state-1", "command": "get_state", "success": true,
            "data": { "sessionId": "old", "sessionFile": "/tmp/old.jsonl", "isSettled": true } }),
        json!({ "type": "agent_start" }),
        dialog("pending"),
        json!({ "type": "message_start", "message": { "role": "user", "content": "Ancien" } }),
    ] {
        assert_eq!(
            state.handle(&record, &record.to_string(), true),
            Handling {
                forward: false,
                refresh: false,
                rename: false,
            }
        );
    }
    assert_eq!(
        state
            .dialogs
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        ["pending"]
    );
    assert!(state.working);
    assert!(state.conversation.is_none());
    assert!(state.first_message.is_none());
}

#[test]
fn dialogs_await_until_answered_cancelled_or_settled() {
    let dialog = |id: &str, method: &str| json!({ "type": "extension_ui_request", "id": id, "method": method, "title": "?" });
    let mut state = State::default();
    for (id, method) in [("1", "select"), ("2", "ask"), ("3", "confirm")] {
        assert_eq!(handle(&mut state, dialog(id, method)), FORWARD);
    }
    handle(&mut state, dialog("4", "notify"));
    assert_eq!(state.dialogs.len(), 3);
    handle(
        &mut state,
        json!({ "type": "extension_ui_request", "id": "c", "method": "cancel", "targetId": "2" }),
    );
    let ids: Vec<&str> = state.dialogs.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, ["1", "3"]);
    handle(&mut state, json!({ "type": "session_settled" }));
    assert!(state.dialogs.is_empty());
}

#[test]
fn a_yielded_agent_end_gives_the_last_assistant_text() {
    let mut state = State::default();
    let reply = json!({
        "role": "assistant",
        "content": [{ "type": "thinking", "thinking": "hmm" }, { "type": "text", "text": "Fait." }],
    });
    handle(
        &mut state,
        json!({ "type": "agent_end", "yielded": false, "messages": [reply] }),
    );
    assert_eq!(state.last_message, None);
    for intermediate in [
        json!({ "isTerminal": false }),
        json!({ "willContinue": true }),
    ] {
        let mut end = json!({ "type": "agent_end", "messages": [reply] });
        end.as_object_mut()
            .unwrap()
            .extend(intermediate.as_object().unwrap().clone());
        handle(&mut state, end);
        assert_eq!(state.turn, None);
        assert_eq!(state.last_message, None);
    }
    handle(
        &mut state,
        json!({ "type": "agent_end", "messages": [{ "role": "user", "content": "x" }, reply] }),
    );
    assert_eq!(state.last_message.as_deref(), Some("Fait."));
    // An oversized end drops messages already streamed.
    handle(
        &mut state,
        json!({ "type": "message_end", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Streamé" }] } }),
    );
    handle(
        &mut state,
        json!({ "type": "agent_end", "yielded": true, "messages": [] }),
    );
    assert_eq!(state.last_message.as_deref(), Some("Streamé"));
}

#[test]
fn a_turn_keeps_its_id_when_a_new_client_replays_it() {
    let end = |timestamp: u64| {
        json!({ "type": "agent_end", "messages": [{
            "role": "assistant",
            "timestamp": timestamp,
            "content": [{ "type": "text", "text": "Fait.\n<soreno-summary>Ajouté.</soreno-summary>" }],
        }] })
    };
    let mut first = State::default();
    handle(&mut first, end(1));
    let turn = first.turn.clone().unwrap();
    assert_eq!(
        turn.message.as_deref(),
        Some("Fait.\n<soreno-summary>Ajouté.</soreno-summary>")
    );
    // A reattached dtach run replays the records the previous client already saw.
    let mut reattached = State::default();
    reattached.handle(&end(1), &end(1).to_string(), true);
    assert_eq!(reattached.turn, Some(turn.clone()));
    // The same words in a later reply are another summary.
    handle(&mut first, end(2));
    assert_ne!(first.turn.unwrap().id, turn.id);
}

#[test]
fn the_first_user_message_names_the_conversation_until_omp_does() {
    let mut state = State::default();
    let user = |text: &str| json!({ "type": "message_start", "message": { "role": "user", "content": text } });
    handle(&mut state, user("  Corrige\u{7} le bug\nDétails"));
    handle(&mut state, user("Second"));
    let get_state = |session_id: &str, name: Option<&str>| {
        json!({
            "type": "response",
            "id": "soreno-host-state-1",
            "command": "get_state",
            "success": true,
            "data": { "sessionId": session_id, "sessionFile": "/tmp/s.jsonl", "sessionName": name },
        })
    };
    assert_eq!(
        handle(&mut state, get_state("one", None)),
        Handling {
            forward: false,
            refresh: false,
            rename: false,
        }
    );
    let conversation = state.conversation.clone().unwrap();
    assert_eq!(conversation.name.as_deref(), Some("Corrige le bug"));
    assert_eq!(conversation.session_file.as_deref(), Some("/tmp/s.jsonl"));

    handle(&mut state, get_state("one", Some("Nommée")));
    assert_eq!(
        state.conversation.as_ref().unwrap().name.as_deref(),
        Some("Nommée")
    );
    handle(&mut state, get_state("two", None));
    assert_eq!(state.conversation.as_ref().unwrap().name, None);
    handle(&mut state, user("Nouvelle"));
    assert_eq!(
        state.conversation.as_ref().unwrap().name.as_deref(),
        Some("Nouvelle")
    );

    // A listed history OMP resumes unnamed keeps its title, once.
    state
        .titles
        .insert("/tmp/a.jsonl".into(), "Corrige X".into());
    state.resume("/tmp/a.jsonl");
    let resumed = |session_id: &str| {
        json!({
            "type": "response",
            "id": "soreno-host-state-2",
            "command": "get_state",
            "success": true,
            "data": { "sessionId": session_id, "sessionFile": "/tmp/a.jsonl" },
        })
    };
    handle(&mut state, resumed("three"));
    handle(&mut state, user("Continue"));
    assert_eq!(
        state.conversation.as_ref().unwrap().name.as_deref(),
        Some("Corrige X")
    );
    handle(&mut state, resumed("four"));
    assert_eq!(state.conversation.as_ref().unwrap().name, None);
}

#[test]
fn soreno_titles_an_untitled_conversation_as_the_omp_tui_does() {
    let get_state = |session_id: &str, name: Option<&str>| {
        json!({
            "type": "response", "id": "soreno-host-state-1", "command": "get_state", "success": true,
            "data": { "sessionId": session_id, "sessionFile": "/tmp/s.jsonl", "sessionName": name },
        })
    };
    let user = json!({ "type": "message_start", "message": { "role": "user", "content": "Corrige le bug" } });
    let reply =
        json!({ "type": "message_start", "message": { "role": "assistant", "content": [] } });
    let todo = |op: &str| {
        json!({ "type": "tool_execution_end", "toolName": "todo", "isError": false,
            "result": { "details": { "op": op, "phases": [] } } })
    };
    let renamed =
        json!({ "type": "session_info_update", "title": "Bug corrigé", "sessionId": "one" });
    let output = json!({ "type": "command_output", "text": "Session renamed to Bug corrigé." });
    let accepted = json!({ "type": "response", "id": "soreno-host-title-2", "command": "prompt",
        "success": true, "data": { "agentInvoked": false } });

    let mut state = State::default();
    // A resumed conversation, persisted with a name OMP no longer reports.
    state.conversation = Some(Conversation {
        session_id: "one".into(),
        session_file: Some("/tmp/s.jsonl".into()),
        name: Some("Ancien".into()),
    });
    handle(&mut state, get_state("one", None));
    assert!(!handle(&mut state, user.clone()).rename);
    assert!(
        handle(&mut state, reply.clone()).rename,
        "titled once the reply starts"
    );
    assert!(
        !handle(&mut state, reply.clone()).rename,
        "once per user message"
    );
    assert!(!handle(&mut state, accepted.clone()).forward);
    state.sent("prompt", Some("/compact"));
    assert!(handle(&mut state, renamed.clone()).refresh);
    assert!(
        !handle(&mut state, output.clone()).forward,
        "Soreno's rename stays silent"
    );
    assert_eq!(
        handle(&mut state, output.clone()),
        FORWARD,
        "the user's output shows"
    );
    handle(&mut state, get_state("one", Some("Bug corrigé")));

    assert!(!handle(&mut state, todo("done")).rename);
    assert!(
        handle(&mut state, todo("init")).rename,
        "a replan refreshes the title"
    );
    assert!(
        !handle(&mut state, todo("init")).rename,
        "one rename at a time"
    );
    handle(&mut state, renamed.clone());
    handle(&mut state, output.clone());

    state.sent("prompt", Some("  /rename Mon titre"));
    assert!(
        !handle(&mut state, todo("init")).rename,
        "a name the user gives stays"
    );

    // Another conversation starts untitled; one OMP already named is left alone.
    handle(&mut state, get_state("two", None));
    handle(&mut state, user.clone());
    assert!(handle(&mut state, reply.clone()).rename);
    // An OMP without a built-in `/rename` gave it to the agent.
    let invoked = json!({ "type": "response", "id": "soreno-host-title-3", "command": "prompt",
        "success": true, "data": { "agentInvoked": true } });
    handle(&mut state, invoked);
    handle(&mut state, user.clone());
    assert!(!handle(&mut state, reply.clone()).rename);
    assert_eq!(handle(&mut state, output.clone()), FORWARD);

    handle(&mut state, get_state("three", Some("Nommée")));
    handle(&mut state, user);
    assert!(!handle(&mut state, reply).rename);
    assert!(!handle(&mut state, todo("init")).rename);
}

#[test]
fn an_active_goal_titles_the_conversation_like_a_user_message() {
    let get_state = |session_id: &str| {
        json!({
            "type": "response", "id": "soreno-host-state-1", "command": "get_state", "success": true,
            "data": { "sessionId": session_id, "sessionFile": "/tmp/s.jsonl", "sessionName": null },
        })
    };
    let goal = |goal: Value| json!({ "type": "response", "command": "goal", "success": true, "data": { "goal": goal } });
    let reply =
        json!({ "type": "message_start", "message": { "role": "assistant", "content": [] } });

    let mut state = State::default();
    handle(&mut state, get_state("one"));
    handle(
        &mut state,
        goal(json!({ "objective": "Fix the failing test", "status": "paused" })),
    );
    handle(&mut state, goal(Value::Null));
    assert!(!handle(&mut state, reply.clone()).rename, "no turn started");
    assert_eq!(state.conversation.as_ref().unwrap().name, None);

    handle(
        &mut state,
        goal(json!({ "objective": "Fix the failing test", "status": "active" })),
    );
    assert_eq!(
        state.conversation.as_ref().unwrap().name.as_deref(),
        Some("Fix the failing test")
    );
    assert!(handle(&mut state, reply).rename);
}

#[test]
fn host_records_stay_with_the_host() {
    let mut state = State::default();
    let dropped = Handling {
        forward: false,
        refresh: false,
        rename: false,
    };
    for record in [
        json!({ "type": "ready", "protocolVersion": 1 }),
        json!({ "type": "response", "id": "soreno-host-ask", "success": true }),
        json!({ "type": "extension_ui_request", "id": "s", "method": "setStatus" }),
        json!({ "type": "extension_ui_request", "id": "w", "method": "setWidget" }),
        json!({ "type": "extension_ui_request", "id": "t", "method": "setTitle" }),
        json!({ "type": "extension_ui_request", "id": "e", "method": "set_editor_text" }),
    ] {
        assert_eq!(handle(&mut state, record), dropped);
    }
    assert_eq!(
        handle(
            &mut state,
            json!({ "type": "response", "id": "view-1", "command": "get_state", "success": true })
        ),
        FORWARD
    );
    assert_eq!(
        handle(
            &mut state,
            json!({ "type": "response", "id": "view-2", "command": "new_session", "success": true })
        ),
        Handling {
            forward: true,
            refresh: true,
            rename: false,
        }
    );
}

#[test]
fn history_entries_take_the_title_slot_else_the_first_user_message() {
    let file = |head: &str| HistoryFile {
        path: "/s/a.jsonl".into(),
        modified: 7,
        head: head.as_bytes().to_vec(),
    };
    let session = r#"{"type":"session","version":3,"id":"a","cwd":"/p"}"#;
    let user = r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Fix the\nbug"}]}}"#;
    let titled = format!(
        "{}\n{session}\n{user}\n",
        r#"{"type":"title","v":1,"title":"Named","source":"auto","updatedAt":"x","pad":"  "}"#
    );
    assert_eq!(
        history_entry(file(&titled), Some("/s/a.jsonl")),
        Some(ConversationHistoryEntry {
            path: "/s/a.jsonl".into(),
            title: Some("Named".into()),
            modified: 7,
            current: true,
        })
    );
    let untitled =
        history_entry(file(&format!("{session}\n{user}\n{{\"type\":\"mess")), None).unwrap();
    assert_eq!(untitled.title.as_deref(), Some("Fix the"));
    assert!(!untitled.current);
    assert_eq!(history_entry(file(session), None).unwrap().title, None);
    assert_eq!(history_entry(file(user), None), None);
}

#[test]
fn switching_is_limited_to_the_project_histories() {
    let switch = |path: Value| json!({ "type": "switch_session", "sessionPath": path });
    let current = Some("/home/u/.omp/agent/sessions/-p/1.jsonl");
    assert!(validate_switch(
        &switch(json!("/home/u/.omp/agent/sessions/-p/2.jsonl")),
        current
    )
    .is_ok());
    for refused in [
        json!("/home/u/.omp/agent/sessions/-q/2.jsonl"),
        json!("/home/u/.omp/agent/sessions/-p/../-q/2.jsonl"),
        json!("/home/u/.omp/agent/sessions/-p/sub/2.jsonl"),
        json!("/home/u/.omp/agent/sessions/-p/2.txt"),
        json!("/etc/passwd"),
        json!("2.jsonl"),
        json!(null),
    ] {
        assert!(validate_switch(&switch(refused), current).is_err());
    }
    assert!(validate_switch(&switch(json!("/s/2.jsonl")), None).is_err());
    let mut state = State::default();
    assert!(
        handle(
            &mut state,
            json!({ "type": "response", "id": "view-3", "command": "switch_session", "success": true })
        )
        .refresh
    );
}

#[test]
fn conversation_sessions_take_no_launch_options() {
    let session = |kind: &str, executable: &str| super::super::AgentSession {
        id: "session".into(),
        project_id: "project".into(),
        name: "OMP".into(),
        custom_name: None,
        kind: kind.into(),
        service_id: None,
        working_directory: None,
        executable: executable.into(),
        args: Vec::new(),
        created_at: "2026-01-01T00:00:00Z".into(),
        favorite: false,
        design: false,
    };
    let validate = super::super::validate_session;
    assert!(validate(&session(KIND, EXECUTABLE)).is_ok());
    assert!(validate(&session(KIND, "omp")).is_err());
    assert!(validate(&session("terminal", EXECUTABLE)).is_err());
    let mut with_args = session(KIND, EXECUTABLE);
    with_args.args = vec!["--model".into()];
    assert!(validate(&with_args).is_err());
    let mut with_directory = session(KIND, EXECUTABLE);
    with_directory.working_directory = Some("/tmp".into());
    assert!(validate(&with_directory).is_err());
}

#[cfg(unix)]
mod processes {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tauri::ipc::InvokeResponseBody;

    fn temporary(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "soreno-omp-{name}-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn script(source: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", source]);
        command
    }

    fn subscribe(process: &ConversationProcess) -> Arc<Mutex<Vec<Value>>> {
        let records = Arc::new(Mutex::new(Vec::new()));
        let sent = Arc::clone(&records);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let line: String = serde_json::from_str(&json).unwrap();
                sent.lock()
                    .unwrap()
                    .push(serde_json::from_str(&line).unwrap());
            }
            Ok(())
        });
        process.subscribe(channel).unwrap();
        records
    }

    #[test]
    fn the_launch_script_quotes_paths_and_resumes() {
        let root = temporary("launch");
        let bin = root.join("bin");
        let directory = root.join("it's a \"dir\"");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        let omp = bin.join("omp");
        std::fs::write(
            &omp,
            "#!/bin/sh\npwd\nfor arg; do printf '<%s>\\n' \"$arg\"; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&omp, std::fs::Permissions::from_mode(0o755)).unwrap();
        let directory_text = directory.to_str().unwrap();
        let mut group = Vec::new();
        crate::agent_sessions::groups::add_launch_args(
            &mut group,
            crate::agent_sessions::conversations::Provider::Omp,
            "J'ai",
            &[("api".into(), "/srv/l'api".into())],
            false,
        );
        let history = root.join("a 'b'.jsonl");
        std::fs::write(&history, "").unwrap();
        let history_text = history.to_str().unwrap();
        let run = |shell: &str, resume: &str| {
            let output = script(&launch_script(directory_text, Some(resume), &group))
                .env("SHELL", shell)
                .env("HOME", &root)
                .env_remove("ENV")
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .stdin(Stdio::null())
                .output()
                .unwrap();
            String::from_utf8(output.stdout).unwrap()
        };
        let start = format!(
            "{directory_text}\n<--mode>\n<rpc-ui>\n<--append-system-prompt>\n<{}>\n<--add-dir>\n</srv/l'api>\n",
            group[1]
        );
        // Users' login shells: those installed here, fish having no positional parameters.
        let shells = ["/bin/sh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/fish"];
        for shell in shells
            .into_iter()
            .filter(|shell| std::path::Path::new(shell).exists())
        {
            assert_eq!(
                run(shell, history_text),
                format!("{start}<--resume>\n<{history_text}>\n"),
                "{shell}"
            );
            // A conversation OMP never wrote starts afresh rather than failing.
            assert_eq!(
                run(
                    shell,
                    &root.join("never written.jsonl").display().to_string()
                ),
                start,
                "{shell}"
            );
        }
        assert!(group[1].contains("- api: /srv/l'api"));
        let missing = script(&launch_script(directory_text, None, &[]))
            .env("SHELL", "/bin/sh")
            .env("HOME", &root)
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .status()
            .unwrap();
        assert_eq!(missing.code(), Some(MISSING_EXECUTABLE_EXIT_CODE as i32));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_detachable_run_keeps_its_config_overlay_in_the_session_directory() {
        let root = temporary("detachable");
        let bin = root.join("bin");
        let session = root.join("it's a \"session\"");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(session.join("clipboard")).unwrap();
        let omp = bin.join("omp");
        std::fs::write(
            &omp,
            "#!/bin/sh\nwhile [ $# -gt 0 ]; do [ \"$1\" = --config ] && printf '%s\\n' \"$2\" && cat -- \"$2\"; shift; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&omp, std::fs::Permissions::from_mode(0o755)).unwrap();
        let session_text = session.to_str().unwrap();
        let inner = detachable_script(Some(session_text), root.to_str().unwrap(), None, &[]);
        let shells = ["/bin/sh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/fish"];
        for shell in shells
            .into_iter()
            .filter(|shell| std::path::Path::new(shell).exists())
        {
            let output = Command::new(shell)
                .args(["-c", &inner])
                .env("HOME", &root)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .stdin(Stdio::null())
                .output()
                .unwrap();
            // A prompt directory dies with Soreno's connection; the session one with the run.
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{session_text}/{CONFIG_FILENAME}\n{CONFIG}"),
                "{shell}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_linked_instruction_configures_the_bridge_to_publish_metadata() {
        let root = temporary("link");
        let local = AgentEnvironment {
            kind: "local".into(),
            distribution: None,
            ssh: None,
        };
        let config = |link| {
            let (args, _) =
                with_instruction(&local, &[], Some(&root), None, false, link, None, &[]).unwrap();
            assert_eq!(args[0], "-e");
            let extension = std::fs::read_to_string(&args[1]).unwrap();
            let line = extension.lines().next().unwrap();
            let json = line
                .strip_prefix("const soreno = ")
                .and_then(|line| line.strip_suffix(';'))
                .unwrap();
            serde_json::from_str::<Value>(json).unwrap()
        };
        let linked = config(Some((
            "run-token",
            "/home/u/.cache/soreno/conversations/k/metadata.json",
        )));
        let instruction = linked["systemAppend"].clone();
        assert!(instruction.as_str().is_some_and(|text| !text.is_empty()));
        assert_eq!(
            linked,
            json!({
                "version": 1,
                "provider": "omp",
                "runId": "run-token",
                "metadataPath": "/home/u/.cache/soreno/conversations/k/metadata.json",
                "mode": "rpc",
                "systemAppend": instruction,
            })
        );
        assert_eq!(config(None), json!({ "systemAppend": instruction }));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launch_attachments_sit_beside_the_instruction_and_the_prompt_names_them() {
        let root = temporary("attach");
        let local = AgentEnvironment {
            kind: "local".into(),
            distribution: None,
            ssh: None,
        };
        let issue = [PromptAttachment {
            filename: "issue.md".into(),
            bytes: b"# Issue".to_vec(),
        }];
        let (args, prompt) = with_instruction(
            &local,
            &[],
            Some(&root),
            None,
            false,
            None,
            Some("Do it"),
            &issue,
        )
        .unwrap();
        let directory = args[1]
            .strip_suffix(&format!("/{INSTRUCTION_FILENAME}"))
            .unwrap();
        assert_eq!(
            prompt.as_deref(),
            Some(format!("Do it\n\nAttached files in {directory}: issue.md").as_str())
        );
        assert_eq!(
            std::fs::read(format!("{directory}/issue.md")).unwrap(),
            b"# Issue"
        );
        // The prompt would name files that never reached the agent.
        assert!(
            with_instruction(&local, &[], None, None, false, None, Some("Do it"), &issue).is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_run_forwards_its_records_then_its_exit() {
        let process = ConversationProcess::spawn(
            script(
                r#"printf 'debug1: Authentications that can continue\nsoreno-omp-group=other:99\nsoreno-omp-group=n0nce: 4242\n' >&2
printf '{"type":"ready"}\nbanner\n'
read line
printf '%s\n' '{"type":"response","id":"soreno-host-x","success":true}' '{"type":"response","id":"view-1","command":"get_state","success":true}'
echo oops >&2
printf 'soreno-omp-group=n0nce:1234\n' >&2
exit 3"#,
            ),
            format!("soreno-omp-test-{}", std::process::id()),
            (),
            Some((
                crate::ssh::SshConnection {
                    host: "example.invalid".into(),
                    user: None,
                    port: None,
                    identity_file: None,
                    host_key: None,
                },
                "n0nce".into(),
            )),
        )
        .unwrap();
        let records = subscribe(&process);
        assert!(process
            .send(&json!({ "type": "bash", "command": "ls" }))
            .is_err());
        assert!(process
            .send(&json!({ "type": "get_state", "id": "soreno-host-1" }))
            .is_err());
        process
            .send(&json!({ "type": "get_state", "id": "view-1" }))
            .unwrap();
        assert!(process.wait_exit(Duration::from_secs(10)));
        let records = records.lock().unwrap().clone();
        assert_eq!(
            records,
            [
                json!({ "type": "response", "id": "view-1", "command": "get_state", "success": true }),
                json!({ "type": "soreno_exited", "exitCode": 3, "stderr": "debug1: Authentications that can continue\nsoreno-omp-group=other:99\noops\nsoreno-omp-group=n0nce:1234\n" }),
            ]
        );
        assert_eq!(process.run_status("s").unwrap().state, "exited");
        assert_eq!(process.state.lock().unwrap().remote_group, Some(4242));
        assert!(process.send(&json!({ "type": "abort" })).is_err());
        // A late view still learns the exit.
        assert_eq!(
            subscribe(&process).lock().unwrap().as_slice(),
            [records[1].clone()]
        );
    }

    #[test]
    fn a_command_the_ending_run_cannot_take_is_left_to_its_exit() {
        let process = ConversationProcess::spawn(
            script(
                r#"read line
exec 0<&-
printf '%s\n' '{"type":"response","id":"view-1","command":"get_state","success":true}'
exec sleep 30"#,
            ),
            format!("soreno-omp-ending-{}", std::process::id()),
            (),
            None,
        )
        .unwrap();
        let (sender, receiver) = mpsc::channel();
        process
            .subscribe(Channel::new(move |_| {
                let _ = sender.send(());
                Ok(())
            }))
            .unwrap();
        process
            .send(&json!({ "type": "get_state", "id": "view-1" }))
            .unwrap();
        receiver.recv_timeout(Duration::from_secs(10)).unwrap();
        process
            .send(&json!({ "type": "get_state", "id": "view-2" }))
            .unwrap();
        if let Some((child, _)) = &mut *process.process.lock().unwrap() {
            child.kill().unwrap();
        }
        assert!(process.wait_exit(Duration::from_secs(10)));
        assert!(process.send(&json!({ "type": "abort" })).is_err());
    }

    #[test]
    fn a_delivery_waits_for_its_acknowledgement() {
        let process = ConversationProcess::spawn(
            script(
                r#"read line
id=$(printf '%s' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/')
printf '{"type":"response","id":"%s","command":"prompt","success":true}\n' "$id"
read line"#,
            ),
            format!("soreno-omp-deliver-{}", std::process::id()),
            (),
            None,
        )
        .unwrap();
        let records = subscribe(&process);
        process.deliver("Bonjour").unwrap();
        process.stop().unwrap();
        assert!(process.deliver("Encore").is_err());
        let records = records.lock().unwrap();
        assert_eq!(
            records.len(),
            1,
            "only the exit reaches the view: {records:?}"
        );
    }

    #[test]
    fn a_reattached_run_takes_input_once_replayed_and_keeps_its_text_as_stderr() {
        let dialog = json!({ "type": "extension_ui_request", "id": "d1", "method": "confirm", "title": "?" });
        let text = dialog.to_string();
        let (start, rest) = text.split_at(20);
        let process = ConversationProcess::launch(
            script(&format!(
                r#"printf '\033[H\033[J\033]5379;dtach-history-begin\007'
printf '%s\n%s\033]5379;dtach-history-end\007' '{{"type":"agent_start"}}' '{start}'
read line
printf '%s\n' '{rest}'
read line
case "$line" in *negotiate_protocol*) first=true;; *) first=false;; esac
read line; read line; read line
printf '{{"type":"notice","first":%s}}\n' "$first"
read line
printf '\033[31mboom\033[0m\r\n\033[999H\r\n[EOF - dtach terminating]\r\n'
exit 3"#
            )),
            format!("soreno-omp-dtach-{}", std::process::id()),
            (),
            Transport::Dtach { live: true },
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let wait = |done: &dyn Fn() -> bool| {
            while !done() {
                assert!(Instant::now() < deadline);
                thread::sleep(POLL);
            }
        };
        // The dialog's first half came with the end of the replay: it would miss the subscription.
        wait(&|| process.run_status("s").unwrap().working == Some(true));
        assert_eq!(process.state.lock().unwrap().gate, Gate::Replay);
        process.write_raw("go").unwrap();
        wait(&|| process.state.lock().unwrap().gate == Gate::Opening);
        let records = subscribe(&process);
        let opener = Arc::clone(&process);
        thread::spawn(move || opener.open(&HANDSHAKE.map(String::from)));
        assert!(process.wait_open(Duration::from_secs(10)));
        wait(&|| records.lock().unwrap().len() == 2);
        let status = process.run_status("s").unwrap();
        assert_eq!((status.working, status.awaiting), (Some(true), true));

        process.send(&json!({ "type": "abort" })).unwrap();
        assert!(process.wait_exit(Duration::from_secs(10)));
        assert_eq!(
            *records.lock().unwrap(),
            [
                dialog,
                json!({ "type": "notice", "first": true }),
                json!({ "type": "soreno_exited", "exitCode": 3, "stderr": "boom\n" }),
            ]
        );
    }

    #[test]
    fn a_new_run_opens_once_ready_even_behind_the_shell_title() {
        let process = ConversationProcess::launch(
            script(
                r#"printf '\033]5379;dtach-history-begin\007\033]5379;dtach-history-end\007'
printf '\033]0;x\007{"type":"ready"}\n'
read line"#,
            ),
            format!("soreno-omp-ready-{}", std::process::id()),
            (),
            Transport::Dtach { live: false },
        )
        .unwrap();
        let opener = Arc::clone(&process);
        thread::spawn(move || opener.open(&[]));
        assert!(process.wait_open(Duration::from_secs(10)));
        assert_eq!(process.state.lock().unwrap().gate, Gate::Open);
        process.stop().unwrap();
    }

    #[test]
    fn attached_files_last_until_the_run_exits() {
        let directory = temporary("files");
        let process = ConversationProcess::spawn(
            script("read line"),
            format!("soreno-omp-files-{}", std::process::id()),
            (),
            None,
        )
        .unwrap();
        *process.local_files.lock().unwrap() = Some(directory.clone());
        let local = AgentEnvironment {
            kind: "local".into(),
            distribution: None,
            ssh: None,
        };
        let path = process.attach_file(&local, "screen.mov", b"movie").unwrap();
        assert_eq!(std::fs::read(path.trim_matches('\'')).unwrap(), b"movie");
        process.stop().unwrap();
        assert!(!directory.exists());
        assert!(process.attach_file(&local, "late.mov", b"x").is_err());
    }

    #[test]
    fn a_forced_remote_stop_kills_the_whole_group_once() {
        use std::os::unix::process::CommandExt;
        let mut leader = script("sleep 300 & sleep 300; wait");
        leader.process_group(0).stdin(Stdio::null());
        let mut leader = leader.spawn().unwrap();
        let group = leader.id();
        thread::sleep(Duration::from_millis(200));
        // Debian's `sh` is dash, which rejects `kill --`: run the script with it when present.
        let shell = ["/bin/dash", "/usr/bin/dash"]
            .into_iter()
            .find(|path| std::path::Path::new(path).exists())
            .unwrap_or("/bin/sh");
        let stop = || {
            Command::new(shell)
                .args(["-c", &stop_group_script(group)])
                .status()
                .unwrap()
                .success()
        };
        assert!(stop());
        let group_alive = || {
            let groups = Command::new("ps").args(["-eo", "pgid="]).output().unwrap();
            String::from_utf8_lossy(&groups.stdout)
                .lines()
                .any(|line| line.trim() == group.to_string())
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while (leader.try_wait().unwrap().is_none() || group_alive())
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(50));
        }
        let survived = leader.try_wait().unwrap().is_none() || group_alive();
        if survived {
            let _ = Command::new("kill")
                .args(["-KILL", &format!("-{group}")])
                .status();
            let _ = leader.wait();
        }
        assert!(!survived, "the stop script left group {group} running");
        // Gone, the group is not signalled again.
        assert!(stop());
        let mut scan = GroupScan::new("n0nce");
        assert_eq!(
            scan.scan(b"debug1: x\nsoreno-omp-gr"),
            (b"debug1: x\n".to_vec(), None)
        );
        assert_eq!(
            scan.scan(b"oup=n0nce: 77\nrest"),
            (b"rest".to_vec(), Some(Some(77)))
        );
        assert_eq!(
            GroupScan::new("n0nce").scan(b"soreno-omp-group=n0nce:1\nrest"),
            (b"soreno-omp-group=n0nce:1\nrest".to_vec(), Some(None))
        );
        assert_eq!(
            GroupScan::new("n0nce").scan(b"soreno-omp-group=forged:77\n"),
            (b"soreno-omp-group=forged:77\n".to_vec(), None)
        );
        let mut scan = GroupScan::new("n0nce");
        let long = [b'x'; 129];
        assert_eq!(scan.scan(&long), (long.to_vec(), None));
        assert_eq!(
            scan.scan(b"soreno-omp-group=n0nce:77\n"),
            (b"soreno-omp-group=n0nce:77\n".to_vec(), None)
        );
    }
}
