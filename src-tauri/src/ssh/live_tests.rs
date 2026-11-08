//! Run with `sh scripts/test-ssh.sh`: actual OpenSSH server, isolated disposable data.
use super::*;
use crate::{
    agent_sessions::{
        tests::terminal as terminal_output, AgentEnvironment, AgentProject, AgentSession,
        AgentSessions,
    },
    project_git as git,
};

fn wait_output(sessions: &AgentSessions, id: &str, expected: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let text = terminal_output(sessions, id).unwrap().text();
        if text.contains(expected) {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "Missing {expected:?}, terminal: {text:?}"
        );
        thread::sleep(Duration::from_millis(50));
    }
}
fn wait_exit(sessions: &AgentSessions, id: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if terminal_output(sessions, id).unwrap().status.state == "exited" {
            return;
        }
        assert!(Instant::now() < deadline, "SSH session did not exit");
        thread::sleep(Duration::from_millis(50));
    }
}
fn wait_remote_missing(connection: &SshConnection, path: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if run(connection, &format!("test ! -e {}", quote(path)), None, 100).is_ok() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Remote temporary path still exists: {path}"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "requires disposable OpenSSH fixture: sh scripts/test-ssh.sh"]
fn remote_project_end_to_end() {
    let connection = SshConnection {
        host: "127.0.0.1".into(),
        user: Some("soreno".into()),
        port: Some(
            std::env::var("SORENO_SSH_TEST_PORT")
                .expect("fixture port")
                .parse()
                .unwrap(),
        ),
        identity_file: Some(std::env::var("SORENO_SSH_TEST_KEY").expect("fixture identity")),
        host_key: Some(std::env::var("SORENO_SSH_TEST_HOST_KEY").expect("fixture host key")),
    };
    let data = std::env::temp_dir().join(format!("soreno-ssh-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    initialize(&data).unwrap();
    let discovery_connection = SshConnection {
        identity_file: Some(
            data.join("unavailable-identity")
                .to_string_lossy()
                .into_owned(),
        ),
        host_key: None,
        ..connection.clone()
    };
    let host_keys = scan(&discovery_connection).unwrap();
    assert!(host_keys
        .iter()
        .any(|key| Some(&key.key) == connection.host_key.as_ref()
            && key.fingerprint.starts_with("SHA256:")));
    let mut wrong_key = parse_key(connection.host_key.as_ref().unwrap()).unwrap();
    *wrong_key.last_mut().unwrap() ^= 1;
    let wrong = SshConnection {
        host_key: Some(format!("ssh-ed25519 {}", STANDARD.encode(wrong_key))),
        ..connection.clone()
    };
    assert!(
        run(&wrong, "printf unsafe", None, 100).is_err(),
        "changed host key must fail closed"
    );
    assert_eq!(
        run(&connection, "printf verified", None, 100).unwrap(),
        b"verified"
    );
    let home = browse(&connection, None).unwrap();
    assert_eq!(home.path, "/home/soreno");
    let path = "/home/soreno/project ' ; $literal";
    run(
        &connection,
        &format!(
            "mkdir -- {} && mkdir -- {} && mkdir -- {} && mkdir -- {}",
            quote(path),
            quote(&format!("{path}/.hidden")),
            quote(&format!("{path}/nested folder")),
            quote("/home/soreno/trailing\n")
        ),
        None,
        100,
    )
    .unwrap();
    let listing = browse(&connection, Some(path)).unwrap();
    assert_eq!(
        listing
            .directories
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        [".hidden", "nested folder"]
    );
    assert_eq!(
        browse(&connection, Some("/home/soreno/trailing\n"))
            .unwrap()
            .path,
        "/home/soreno/trailing\n"
    );
    assert!(browse(&connection, Some("/missing-project")).is_err());
    let project = AgentProject {
        id: "remote-project".into(),
        name: "Remote project".into(),
        path: path.into(),
        environment: AgentEnvironment {
            kind: "ssh".into(),
            distribution: None,
            ssh: Some(connection.clone()),
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };
    let sessions = AgentSessions::open(&data).unwrap();
    sessions.save_project(project.clone()).unwrap();
    assert_eq!(
        sessions.workspace().unwrap().projects[0].environment,
        project.environment
    );
    drop(sessions);
    let sessions = AgentSessions::open(&data).unwrap();
    assert_eq!(sessions.workspace().unwrap().projects[0].path, path);
    let repo = git::repository(&project).unwrap();
    assert_eq!(repo.availability, "notRepository");
    git::init(&sessions, &project.id, &repo.version).unwrap();
    let repo = git::repository(&project).unwrap();
    git::set_identity(
        &sessions,
        &project.id,
        "SSH Test".into(),
        "ssh@example.invalid".into(),
        false,
        &repo.version,
    )
    .unwrap();
    let file = "space ' ; $literal.txt";
    let other = "other.txt";
    let large = "large.bin";
    run(
        &connection,
        &format!(
            "printf 'first\\n' > {}; printf 'other\\n' > {}",
            quote(&format!("{path}/{file}")),
            quote(&format!("{path}/{other}")),
        ),
        None,
        100,
    )
    .unwrap();
    let large_content = vec![b'x'; 128 * 1024];
    run(
        &connection,
        &format!("cat > {}", quote(&format!("{path}/{large}"))),
        Some(&large_content),
        100,
    )
    .unwrap();
    let repo = git::repository(&project).unwrap();
    assert!(repo.files.iter().any(|entry| entry.path == file));
    assert_eq!(repo.identity.as_ref().unwrap().root, path);
    git::reset_test_git_commands();
    let diff = git::preview_comparison(&project, file, git::GitSide::Unstaged, Some(&repo.version))
        .unwrap();
    assert_eq!(git::test_git_commands(), 0);
    assert_eq!(diff.after.text.as_deref(), Some("first\n"));
    git::stage(
        &sessions,
        &project.id,
        vec![file.into(), other.into(), large.into()],
        &repo.version,
    )
    .unwrap();
    let repo = git::repository(&project).unwrap();
    git::reset_test_git_commands();
    super::reset_test_commands();
    let started = Instant::now();
    let staged =
        git::preview_comparison(&project, file, git::GitSide::Staged, Some(&repo.version)).unwrap();
    eprintln!("SSH staged diff preview: {:.0?}", started.elapsed());
    assert_eq!(git::test_git_commands(), 0);
    assert_eq!(super::test_commands(), 0);
    assert_eq!(staged.before.text.as_deref(), Some(""));
    assert_eq!(staged.after.text.as_deref(), Some("first\n"));
    let commit = git::commit(
        &sessions,
        &project.id,
        "Initial remote commit".into(),
        &repo.version,
    )
    .unwrap();
    let commit_oid = commit.oid.unwrap();
    let history = git::history(&project, None, 0, None).unwrap();
    assert_eq!(history.commits[0].subject, "Initial remote commit");
    assert_eq!(
        git::commit_detail(&project, &commit_oid)
            .unwrap()
            .files
            .len(),
        3
    );
    run(
        &connection,
        &format!("printf short > {}", quote(&format!("{path}/{large}"))),
        None,
        100,
    )
    .unwrap();
    let repo = git::repository(&project).unwrap();
    git::restore(&sessions, &project.id, vec![large.into()], &repo.version).unwrap();
    assert_eq!(
        String::from_utf8(
            run(
                &connection,
                &format!("wc -c < {}", quote(&format!("{path}/{large}"))),
                None,
                100,
            )
            .unwrap(),
        )
        .unwrap()
        .trim(),
        large_content.len().to_string()
    );
    assert!(run_output(&connection, "yes bounded", None, 64)
        .unwrap_err()
        .contains("volumineuse"));
    assert_eq!(
        run(&connection, "printf reusable", None, 16).unwrap(),
        b"reusable"
    );
    super::reset_test_commands();
    let historical = git::commit_comparison(&project, &commit_oid, file).unwrap();
    assert_eq!(super::test_commands(), 0);
    assert_eq!(historical.after.text.as_deref(), Some("first\n"));
    super::reset_test_commands();
    let started = Instant::now();
    let other_historical = git::commit_comparison(&project, &commit_oid, other).unwrap();
    eprintln!("SSH history diff: {:.0?}", started.elapsed());
    assert_eq!(super::test_commands(), 0);
    assert_eq!(other_historical.after.text.as_deref(), Some("other\n"));
    assert!(!git::branches(&project).unwrap().is_empty());
    assert_eq!(
        sessions.branches().unwrap()[0].branch.as_deref(),
        Some("main")
    );
    run(
        &connection,
        &format!("printf 'second\\n' > {}", quote(&format!("{path}/{file}"))),
        None,
        100,
    )
    .unwrap();
    super::reset_test_relays();
    super::reset_test_commands();
    git::reset_test_git_version(&project);
    let started = Instant::now();
    let repo = git::repository(&project).unwrap();
    eprintln!("Initial SSH Git status: {:.0?}", started.elapsed());
    let status_commands = super::test_commands();
    eprintln!("Initial SSH Git status commands: {status_commands}");
    assert_eq!(status_commands, 1);
    super::reset_test_commands();
    let started = Instant::now();
    let warm_repo = git::repository(&project).unwrap();
    eprintln!("Warm SSH Git status: {:.0?}", started.elapsed());
    assert_eq!(super::test_commands(), 0);
    assert_eq!(warm_repo.version, repo.version);
    git::reset_test_git_commands();
    super::reset_test_commands();
    let started = Instant::now();
    let diff = git::preview_comparison(&project, file, git::GitSide::Unstaged, Some(&repo.version))
        .unwrap();
    eprintln!("SSH diff preview: {:.0?}", started.elapsed());
    assert_eq!(git::test_git_commands(), 0);
    assert_eq!(super::test_commands(), 0);
    assert_eq!(diff.before.text.as_deref(), Some("first\n"));
    assert_eq!(diff.after.text.as_deref(), Some("second\n"));
    let clone = git::clone(
        &sessions,
        git::GitCloneRequest {
            id: "cloned-remote".into(),
            name: "Clone".into(),
            environment: project.environment.clone(),
            parent_path: home.path,
            folder_name: "clone ' folder".into(),
            url: path.into(),
        },
    )
    .unwrap();
    assert_eq!(
        git::history(&clone, None, 0, None).unwrap().commits[0].subject,
        "Initial remote commit"
    );
    assert!(git::clone(
        &sessions,
        git::GitCloneRequest {
            id: "do-not-overwrite".into(),
            name: "Duplicate".into(),
            environment: project.environment.clone(),
            parent_path: "/home/soreno".into(),
            folder_name: "clone ' folder".into(),
            url: path.into()
        }
    )
    .is_err());
    assert_eq!(
        run(
            &connection,
            &format!("cat -- {}", quote(&format!("{}/{file}", clone.path))),
            None,
            100
        )
        .unwrap(),
        b"first\n"
    );

    let repo = git::repository(&project).unwrap();
    git::restore(&sessions, &project.id, vec![file.into()], &repo.version).unwrap();
    let repo = git::repository(&project).unwrap();
    assert!(repo.files.is_empty());
    git::create_branch(
        &sessions,
        &project.id,
        "remote-feature".into(),
        &repo.version,
    )
    .unwrap();
    let repo = git::repository(&project).unwrap();
    git::switch_branch(
        &sessions,
        &project.id,
        "remote-feature".into(),
        false,
        &repo.version,
    )
    .unwrap();
    assert_eq!(
        git::repository(&project).unwrap().branch.as_deref(),
        Some("remote-feature")
    );
    let repo = git::repository(&project).unwrap();
    git::switch_branch(&sessions, &project.id, "main".into(), false, &repo.version).unwrap();
    run(&connection, &format!("git init --bare --initial-branch=main /home/soreno/upstream.git && git -C {} remote add origin /home/soreno/upstream.git", quote(path)), None, 1024).unwrap();
    let remote = git::remotes(&project).unwrap().remove(0);
    let repo = git::repository(&project).unwrap();
    git::push(
        &sessions,
        &project.id,
        "origin".into(),
        "main".into(),
        remote.url.clone(),
        &repo.version,
    )
    .unwrap();
    let repo = git::repository(&project).unwrap();
    git::fetch(
        &sessions,
        &project.id,
        "origin".into(),
        remote.url.clone(),
        &repo.version,
    )
    .unwrap();
    let repo = git::repository(&project).unwrap();
    git::pull(
        &sessions,
        &project.id,
        "origin".into(),
        remote.url,
        &repo.version,
        false,
    )
    .unwrap();

    // POSIX names may end in newlines: neither shell substitution nor metadata
    // probes may silently read the similarly named file without that newline.
    let newline_project = AgentProject {
        id: "newline-project".into(),
        path: "/home/soreno/trailing\n".into(),
        ..project.clone()
    };
    sessions.save_project(newline_project.clone()).unwrap();
    let repo = git::repository(&newline_project).unwrap();
    git::init(&sessions, &newline_project.id, &repo.version).unwrap();
    let newline_file = format!("{}/line\n", newline_project.path);
    run(
        &connection,
        &format!(
            "printf 'right\\n' > {}; printf 'wrong\\n' > {}",
            quote(&newline_file),
            quote(&format!("{}/line", newline_project.path))
        ),
        None,
        100,
    )
    .unwrap();
    let repo = git::repository(&newline_project).unwrap();
    assert!(repo.files.iter().any(|entry| entry.path == "line\n"));
    let diff = git::comparison(&newline_project, "line\n", git::GitSide::Unstaged).unwrap();
    assert_eq!(diff.after.text.as_deref(), Some("right\n"));
    run(
        &connection,
        &format!("printf 'changed\\n' > {}", quote(&newline_file)),
        None,
        100,
    )
    .unwrap();
    assert_eq!(
        git::stage(
            &sessions,
            &newline_project.id,
            vec!["line\n".into()],
            &repo.version
        )
        .unwrap_err()
        .code,
        "stale"
    );

    let terminal = AgentSession {
        id: "ssh-terminal".into(),
        project_id: project.id.clone(),
        name: "Terminal".into(),
        custom_name: None,
        kind: "terminal".into(),
        service_id: None,
        working_directory: None,
        executable: "".into(),
        args: vec![],
        created_at: "2026-01-01T00:00:00Z".into(),
        favorite: false,
        design: false,
    };
    sessions.save_session(terminal.clone()).unwrap();
    sessions.start(&terminal.id, 100, 30, None).unwrap();
    sessions.resize(&terminal.id, 122, 33).unwrap();
    sessions
        .write(&terminal.id, "printf '\\n'; pwd; stty size\r")
        .unwrap();
    let output = wait_output(&sessions, &terminal.id, "33 122");
    assert!(output.contains(&format!("\r\n{path}\r\n")), "{output}");
    let image = b"\x89PNG\r\n\x1a\nssh clipboard";
    let remote_image = sessions
        .upload_clipboard_image(&terminal.id, "image/png", &STANDARD.encode(image))
        .unwrap();
    let duplicate_remote_image = sessions
        .upload_clipboard_image(&terminal.id, "image/png", &STANDARD.encode(image))
        .unwrap();
    let remote_directory = remote_image.rsplit_once("/image-").unwrap().0;
    assert!(
        remote_directory.starts_with("/home/soreno/.cache/soreno/sessions/")
            && remote_directory.ends_with("/clipboard"),
        "{remote_directory}"
    );
    assert!(remote_image.ends_with("/image.png"));
    assert!(duplicate_remote_image.starts_with(&format!("{remote_directory}/image-")));
    assert_ne!(remote_image, duplicate_remote_image);
    assert_eq!(
        run(
            &connection,
            &format!("cat -- {}", quote(&remote_image)),
            None,
            100
        )
        .unwrap(),
        image
    );
    sessions.stop(&terminal.id).unwrap();
    wait_exit(&sessions, &terminal.id);
    wait_remote_missing(&connection, remote_directory);
    sessions.start(&terminal.id, 100, 30, None).unwrap();
    let naturally_cleaned_image = sessions
        .upload_clipboard_image(&terminal.id, "image/png", &STANDARD.encode(image))
        .unwrap();
    let naturally_cleaned_directory = naturally_cleaned_image.rsplit_once("/image-").unwrap().0;
    sessions.write(&terminal.id, "exit\r").unwrap();
    wait_exit(&sessions, &terminal.id);
    wait_remote_missing(&connection, naturally_cleaned_directory);
    let no_remote_sessions = "test -z \"$(ls -A \"$HOME/.cache/soreno/sessions\" 2>/dev/null)\"";

    sessions.start(&terminal.id, 100, 30, None).unwrap();
    sessions
        .write(&terminal.id, "SORENO_MARK=persisted\r")
        .unwrap();
    sessions
        .write(&terminal.id, "printf 'set:%s\\n' \"$SORENO_MARK\"\r")
        .unwrap();
    wait_output(&sessions, &terminal.id, "set:persisted");
    // Like readline and Node TUIs, this foreground program reacts only to real size changes.
    run(
        &connection,
        "cat > \"$HOME/soreno-winch.sh\"",
        Some(
            br#"last=$(stty size)
trap 's=$(stty size); [ "$s" = "$last" ] || printf "resized:%s\n" "$s"; last=$s' WINCH
printf 'loop:%s\n' ready
while :; do sleep 1 & wait $!; done
"#,
        ),
        100,
    )
    .unwrap();
    sessions
        .write(
            &terminal.id,
            "(sleep 2; printf 'while:%s\\n' detached) & sh \"$HOME/soreno-winch.sh\"\r",
        )
        .unwrap();
    wait_output(&sessions, &terminal.id, "loop:ready");
    sessions.shutdown();
    drop(sessions);
    thread::sleep(Duration::from_secs(3));
    let sessions = AgentSessions::open(&data).unwrap();
    sessions.start(&terminal.id, 100, 30, None).unwrap();
    wait_output(&sessions, &terminal.id, "resized:30 100");
    // The server replays what the previous client saw and what nobody saw.
    let reattached = terminal_output(&sessions, &terminal.id).unwrap();
    let history = String::from_utf8_lossy(&reattached.bytes[..reattached.restored_end as usize]);
    assert!(history.contains("set:persisted"), "{history}");
    assert!(history.contains("while:detached"), "{history}");
    assert!(!history.contains("dtach-history"), "{history}");
    sessions.write(&terminal.id, "\x03").unwrap();
    sessions
        .write(&terminal.id, "printf 'kept:%s\\n' \"$SORENO_MARK\"\r")
        .unwrap();
    wait_output(&sessions, &terminal.id, "kept:persisted");
    sessions.write(&terminal.id, "exit 7\r").unwrap();
    wait_exit(&sessions, &terminal.id);
    let exited = sessions
        .statuses()
        .unwrap()
        .into_iter()
        .find(|status| status.session_id == terminal.id)
        .unwrap();
    assert_eq!(exited.exit_code, Some(7));
    run(&connection, no_remote_sessions, None, 100).unwrap();

    sessions.start(&terminal.id, 100, 30, None).unwrap();
    sessions
        .write(&terminal.id, "SORENO_MARK=second\r")
        .unwrap();
    sessions
        .write(&terminal.id, "printf 'set:%s\\n' \"$SORENO_MARK\"\r")
        .unwrap();
    wait_output(&sessions, &terminal.id, "set:second");
    sessions.shutdown();
    drop(sessions);
    let sessions = AgentSessions::open(&data).unwrap();
    sessions.stop(&terminal.id).unwrap();
    run(&connection, no_remote_sessions, None, 100).unwrap();
    sessions.start(&terminal.id, 100, 30, None).unwrap();
    sessions
        .write(&terminal.id, "printf 'fresh:%s\\n' \"$SORENO_MARK\"\r")
        .unwrap();
    wait_output(&sessions, &terminal.id, "fresh:\r\n");
    sessions.stop(&terminal.id).unwrap();
    wait_exit(&sessions, &terminal.id);

    for provider in ["pi", "omp"] {
        let agent = AgentSession {
            id: format!("ssh-{provider}"),
            executable: provider.into(),
            ..terminal.clone()
        };
        sessions.save_session(agent.clone()).unwrap();
        sessions.start(&agent.id, 100, 30, None).unwrap();
        let output = wait_output(&sessions, &agent.id, "SORENO_AGENT_READY");
        assert!(output.contains(&format!("cwd={path}")), "{output}");
        assert!(
            !output.contains("777;soreno"),
            "private metadata must not reach the terminal"
        );
        wait_exit(&sessions, &agent.id);
        let before = sessions
            .statuses()
            .unwrap()
            .into_iter()
            .find(|status| status.session_id == agent.id)
            .unwrap();
        assert_eq!(before.exit_code, Some(0));
        assert_eq!(before.resume, "linked", "{:?}", before.conversation_error);
        assert_eq!(
            before.conversation.as_ref().unwrap().name.as_deref(),
            Some("SSH fixture conversation")
        );
        sessions.start(&agent.id, 100, 30, None).unwrap();
        wait_output(&sessions, &agent.id, "SORENO_AGENT_READY");
        wait_exit(&sessions, &agent.id);
        let after = sessions
            .statuses()
            .unwrap()
            .into_iter()
            .find(|status| status.session_id == agent.id)
            .unwrap();
        assert_eq!(after.exit_code, Some(0));
        assert_eq!(
            before.conversation.unwrap().session_id,
            after.conversation.unwrap().session_id
        );
    }
    sessions.shutdown();
    drop(sessions);
    std::fs::remove_dir_all(data).unwrap();
}
