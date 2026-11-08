use super::*;

const PROMPT: &str = "Issue SOR-1: it's \"quoted\"\n$HOME `id` \\ end";

fn agent_session(session_id: &str, executable: &str) -> AgentSession {
    AgentSession {
        id: session_id.into(),
        name: session_id.into(),
        executable: executable.into(),
        args: Vec::new(),
        ..session()
    }
}

#[cfg(unix)]
#[test]
fn fresh_agent_launch_ends_with_the_initial_prompt_without_storing_it() {
    use std::os::unix::fs::PermissionsExt;

    let directory = unique_temp_path("soreno-initial-prompt");
    std::fs::create_dir_all(&directory).unwrap();
    let state = memory_state();
    state.save_project(project()).unwrap();
    for provider in ["pi", "omp", "codex", "claude"] {
        let executable = directory.join(provider);
        std::fs::write(
            &executable,
            "#!/bin/sh\n: > \"$0.argv\"\nfor arg do printf '%s\\0' \"$arg\" >> \"$0.argv\"; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        state
            .save_session(agent_session(provider, executable.to_str().unwrap()))
            .unwrap();

        state.start(provider, 80, 24, Some(PROMPT)).unwrap();
        wait_for(|| terminal(&state, provider).unwrap().status.state == "exited");

        let argv = std::fs::read_to_string(directory.join(format!("{provider}.argv"))).unwrap();
        let argv = argv.split_terminator('\0').collect::<Vec<_>>();
        assert_eq!(argv[argv.len() - 2..], ["--", PROMPT], "{provider}");
        assert_eq!(argv.iter().filter(|arg| **arg == PROMPT).count(), 1);
        let workspace = state.workspace().unwrap();
        let stored = workspace
            .sessions
            .iter()
            .find(|session| session.id == provider)
            .unwrap();
        assert!(stored.args.is_empty(), "{provider}");
    }
    assert_eq!(
        state.start("pi", 80, 24, Some(PROMPT)).unwrap_err(),
        conversations::INITIAL_PROMPT_MESSAGE,
        "a later Pi launch no longer starts a new conversation"
    );
    state.shutdown();
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn prompt_attachments_are_written_privately_and_named_after_the_prompt() {
    use std::os::unix::fs::PermissionsExt;

    let directory = unique_temp_path("soreno-prompt-attachments");
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
        .save_session(agent_session("claude", executable.to_str().unwrap()))
        .unwrap();
    let attachments = [
        PromptAttachment {
            filename: "image-1.png".into(),
            bytes: b"one".to_vec(),
        },
        PromptAttachment {
            filename: "image-3.jpg".into(),
            bytes: b"three".to_vec(),
        },
    ];
    assert!(state
        .start_with_attachments("claude", 80, 24, " \n", &attachments)
        .is_err());
    state
        .start_with_attachments("claude", 80, 24, PROMPT, &attachments)
        .unwrap();
    wait_for(|| directory.join("claude.ready").exists());

    let argv = std::fs::read_to_string(directory.join("claude.argv")).unwrap();
    let prompt = argv.split_terminator('\0').last().unwrap();
    let (text, note) = prompt.split_once("\n\nAttached files in ").unwrap();
    assert_eq!(text, PROMPT);
    let (files, names) = note.rsplit_once(": ").unwrap();
    assert_eq!(names, "image-1.png, image-3.jpg");
    let files = std::path::Path::new(files);
    assert_eq!(std::fs::read(files.join("image-1.png")).unwrap(), b"one");
    assert_eq!(std::fs::read(files.join("image-3.jpg")).unwrap(), b"three");
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(files), 0o700);
    assert_eq!(mode(&files.join("image-1.png")), 0o600);

    state.stop("claude").unwrap();
    wait_for(|| !files.exists());
    state.shutdown();
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn failed_launch_removes_prompt_attachments() {
    let directory = unique_temp_path("soreno-failed-attachments");
    std::fs::create_dir_all(&directory).unwrap();
    let state = memory_state();
    let mut saved_project = project();
    saved_project.path = directory.to_string_lossy().into();
    state.save_project(saved_project).unwrap();
    state
        .save_session(agent_session("claude", "claude"))
        .unwrap();
    std::fs::remove_dir(&directory).unwrap();
    let attachments = [PromptAttachment {
        filename: "image-1.png".into(),
        bytes: b"one".to_vec(),
    }];

    assert!(state
        .start_with_attachments("claude", 80, 24, PROMPT, &attachments)
        .unwrap_err()
        .contains("n’existe plus"));
    let staging = {
        let store = lock(&state.store).unwrap();
        attachment_directory(&store.attachment_instance_directory, "claude")
    };
    assert!(!staging.exists());
    state.shutdown();
}

#[cfg(unix)]
#[test]
fn blank_initial_prompt_is_ignored() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    let mut shell = agent_session("shell", "/bin/sh");
    shell.args = vec!["-c".into(), "exit 0".into()];
    state.save_session(shell).unwrap();

    state.start("shell", 80, 24, Some(" \n\t")).unwrap();
    wait_for(|| terminal(&state, "shell").unwrap().status.state == "exited");
    assert_eq!(terminal(&state, "shell").unwrap().status.exit_code, Some(0));
    state.shutdown();
}

#[test]
fn initial_prompt_is_refused_outside_a_new_agent_conversation() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    state
        .save_session(agent_session("shell", "/bin/sh"))
        .unwrap();
    let mut service = agent_session("service", "pi");
    service.kind = "service".into();
    service.service_id = Some("worker".into());
    service.working_directory = Some(project().path);
    state.save_session(service).unwrap();
    state.save_session(agent_session("agent", "pi")).unwrap();
    let remote = ssh_project("initial-prompt");
    insert_project(&state, &remote);
    state
        .save_session(AgentSession {
            project_id: remote.id.clone(),
            ..agent_session("remote", "pi")
        })
        .unwrap();

    for session_id in ["shell", "service"] {
        assert_eq!(
            state.start(session_id, 80, 24, Some(PROMPT)).unwrap_err(),
            conversations::INITIAL_PROMPT_MESSAGE,
            "{session_id}"
        );
    }
    assert_eq!(
        state
            .start_with("remote", 80, 24, Some(PROMPT), |_, _, _| Ok((
                Some(RemoteHost::Live),
                None
            )))
            .unwrap_err(),
        conversations::INITIAL_PROMPT_MESSAGE
    );
    for prompt in ["a\0b".to_string(), "x".repeat(64 * 1024)] {
        assert_eq!(
            state.start("agent", 80, 24, Some(&prompt)).unwrap_err(),
            "Arguments invalides (256 arguments et 64 Kio maximum, sans caractère nul)."
        );
    }
    assert!(state
        .statuses()
        .unwrap()
        .iter()
        .all(|status| status.state != "running"));
}

#[test]
fn windows_launcher_keeps_the_initial_prompt_as_one_argument() {
    let session = AgentSession {
        executable: "codex.exe".into(),
        args: vec!["--".into(), PROMPT.into()],
        ..session()
    };
    let argv = windows_command(&session).unwrap().get_argv().clone();
    let script = STANDARD.decode(argv[3].to_str().unwrap()).unwrap();
    let script = String::from_utf16(
        &script
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let payload = script
        .split_once("FromBase64String('")
        .unwrap()
        .1
        .split_once("')")
        .unwrap()
        .0;
    let payload: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(payload).unwrap()).unwrap();

    assert_eq!(payload["args"], serde_json::json!(["--", PROMPT]));
    assert_eq!(
        payload["nativeArgs"],
        "\"--\" \"Issue SOR-1: it's \\\"quoted\\\"\n$HOME `id` \\ end\""
    );
    // Windows PowerShell 5.1 `.ps1` shims cannot carry a double quote: the launch is refused.
    assert_eq!(payload["ps1ArgsSafe"], false);
}
