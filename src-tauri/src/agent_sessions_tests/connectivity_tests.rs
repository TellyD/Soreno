use super::*;

#[derive(Debug)]
struct TestKiller;
impl ChildKiller for TestKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self)
    }
}

fn exited_ssh_runtime(connection: SshConnection, run_token: &str) -> Arc<Runtime> {
    #[cfg(windows)]
    let _ = run_token;
    Arc::new(Runtime {
        output: Mutex::new(Output {
            exited: true,
            exit_code: Some(0),
            ..Output::default()
        }),
        grid: Mutex::new(None),
        writer: Mutex::new(None),
        size: Mutex::new(size(80, 24).unwrap()),
        master: Mutex::new(None),
        killer: Mutex::new(Box::new(TestKiller)),
        remote_clipboard: Some(RemoteClipboard::new(connection, None)),
        local_attachment_directory: Mutex::new(None),
        remote_sidecar_generation: None,
        #[cfg(windows)]
        wsl: None,
        #[cfg(windows)]
        process_handle: 0,
        #[cfg(unix)]
        run_token: run_token.into(),
    })
}
#[test]
fn accepts_only_supported_clipboard_image_signatures() {
    assert_eq!(
        clipboard_image_extension("image/png", b"\x89PNG\r\n\x1a\nrest").unwrap(),
        "png"
    );
    assert_eq!(
        clipboard_image_extension("image/jpeg", b"\xff\xd8\xffrest").unwrap(),
        "jpg"
    );
    assert_eq!(
        clipboard_image_extension("image/gif", b"GIF89arest").unwrap(),
        "gif"
    );
    assert_eq!(
        clipboard_image_extension("image/webp", b"RIFFxxxxWEBPrest").unwrap(),
        "webp"
    );
    assert!(clipboard_image_extension("image/png", b"not-png").is_err());
    assert!(clipboard_image_extension("text/plain", b"\x89PNG\r\n\x1a\n").is_err());
}
#[test]
fn remote_clipboard_directory_must_be_a_soreno_runtime_directory() {
    let directory = "/tmp/soreno-agent-AbCd123456";
    assert_eq!(
        remote_clipboard_directory(directory.as_bytes().to_vec()).unwrap(),
        directory
    );
    assert!(remote_clipboard_directory(b"/tmp/other-AbCd123456".to_vec()).is_err());
}
#[test]
fn dropped_files_are_staged_privately_and_remote_paths_are_validated() {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
    let root = std::env::temp_dir().join(format!(
        "soreno-attachment-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let filename = "rapport 'été'.pdf";
    attachment_filename(filename).unwrap();
    for invalid in ["", ".", "..", "a/b", "a\\b", "bad\nname"] {
        assert!(attachment_filename(invalid).is_err(), "{invalid:?}");
    }
    assert_eq!(
        powershell_literal(r"C:\temp\$(Write-Output INJECTED)'s.txt"),
        r"'C:\temp\$(Write-Output INJECTED)''s.txt'"
    );
    assert_eq!(
        powershell_literal(r"C:\temp\notes’; Write-Output INJECTED; ‘.txt"),
        r"'C:\temp\notes’’; Write-Output INJECTED; ‘‘.txt'"
    );
    assert_eq!(
        powershell_literal(r"C:\temp\notes‚; Write-Output INJECTED; ‛.txt"),
        r"'C:\temp\notes‚‚; Write-Output INJECTED; ‛‛.txt'"
    );
    let directory = attachment_directory(&root, "session");
    std::fs::create_dir_all(&directory).unwrap();
    let path = write_local_attachment(&directory, filename, b"pdf").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"pdf");
    assert!(Path::new(&path).starts_with(&directory));
    assert_eq!(
        terminal_attachment_path(&project().environment, &path),
        if cfg!(windows) {
            format!("'{}'", path.replace('\'', "''"))
        } else {
            crate::ssh::quote(&path)
        }
    );
    let target = root.join("symlink-target");
    std::fs::write(&target, b"original").unwrap();
    #[cfg(unix)]
    {
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
    }
    let redeposited = write_local_attachment(&directory, filename, b"pdf").unwrap();
    assert_ne!(Path::new(&path).parent(), Path::new(&redeposited).parent());
    assert_eq!(std::fs::read(&target).unwrap(), b"original");
    cleanup_attachment_directory(&directory).unwrap();
    assert!(!directory.exists());

    let remote_directory = "/tmp/soreno-agent-AbCd123456";
    let script = attachment_upload_script(remote_directory, filename);
    assert!(script.contains("file_dir=$(mktemp -d \"$dir/file-XXXXXXXXXX\")"));
    assert!(script.contains(&crate::ssh::quote(filename)));
    let remote = format!("{remote_directory}/file-ZyXw987654/{filename}");
    assert_eq!(
        uploaded_attachment_path(remote.as_bytes().to_vec(), remote_directory, filename).unwrap(),
        remote
    );
    assert!(uploaded_attachment_path(
        format!("{remote_directory}/file-unsafe/{filename}").into_bytes(),
        remote_directory,
        filename,
    )
    .is_err());
    let _ = std::fs::remove_dir_all(root);
}
#[test]
fn windows_attachment_filenames_reject_drive_and_stream_syntax() {
    for invalid in ["C:rapport.txt", "rapport.txt:stream"] {
        attachment_filename(invalid).unwrap();
        assert!(windows_attachment_filename(invalid).is_err(), "{invalid:?}");
    }
}
#[test]
fn opening_another_instance_preserves_the_first_instance_staging() {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
    let app_data = std::env::temp_dir().join(format!(
        "soreno-attachment-instances-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let first = AgentSessions::open(&app_data).unwrap();
    let first_directory = lock(&first.store)
        .unwrap()
        .attachment_instance_directory
        .clone();
    let marker = first_directory.join("active");
    std::fs::write(&marker, b"active").unwrap();

    let second = AgentSessions::open(&app_data).unwrap();
    let second_directory = lock(&second.store)
        .unwrap()
        .attachment_instance_directory
        .clone();
    assert_ne!(first_directory, second_directory);
    assert_eq!(std::fs::read(&marker).unwrap(), b"active");

    drop(second);
    assert!(!second_directory.exists());
    assert!(marker.exists());
    drop(first);
    assert!(!first_directory.exists());
    let _ = std::fs::remove_dir_all(app_data);
}
#[test]
fn remote_clipboard_never_retries_cleanup_after_failure() {
    let clipboard = RemoteClipboard::new(ssh_project("remote").environment.ssh.unwrap(), None);
    lock(&clipboard.state).unwrap().directory = Some("/tmp/soreno-agent-AbCd123456".into());
    let attempts = std::cell::Cell::new(0);

    assert!(clipboard
        .close_with(|_, _| {
            attempts.set(attempts.get() + 1);
            Err("échec simulé".into())
        })
        .is_err());
    assert!(clipboard
        .close_with(|_, _| panic!("nouvelle connexion SSH"))
        .is_ok());
    drop(clipboard);

    assert_eq!(attempts.get(), 1);
}
#[test]
fn persistent_remote_clipboard_closes_without_remote_cleanup() {
    let clipboard = RemoteClipboard::new(
        ssh_project("remote").environment.ssh.unwrap(),
        Some((remote_host::TERMINALS, "s".into())),
    );
    lock(&clipboard.state).unwrap().directory =
        Some("/home/u/.cache/soreno/sessions/key/clipboard".into());
    assert!(clipboard.close().is_ok());

    assert!(lock(&clipboard.state).unwrap().closed);
}
#[test]
fn remote_clipboard_close_removes_prompt_files_but_not_the_persistent_directory() {
    let clipboard = RemoteClipboard::new(
        ssh_project("remote").environment.ssh.unwrap(),
        Some((remote_host::TERMINALS, "s".into())),
    );
    {
        let mut state = lock(&clipboard.state).unwrap();
        state.directory = Some("/home/u/.cache/soreno/sessions/key/clipboard".into());
        state.prompt_directory = Some("/tmp/soreno-agent-AbCd123456".into());
    }
    let removed = std::cell::RefCell::new(Vec::new());

    assert!(clipboard
        .close_with(|_, directory| {
            removed.borrow_mut().push(directory.to_owned());
            Ok(())
        })
        .is_ok());
    assert_eq!(removed.into_inner(), ["/tmp/soreno-agent-AbCd123456"]);
}
#[test]
fn a_launched_dtach_run_owns_its_prompt_directory() {
    let clipboard = RemoteClipboard::new(
        ssh_project("remote").environment.ssh.unwrap(),
        Some((remote_host::CONVERSATIONS, "s".into())),
    );
    lock(&clipboard.state).unwrap().prompt_directory = Some("/tmp/soreno-agent-AbCd123456".into());
    assert_eq!(
        clipboard.prompt_directory().unwrap().as_deref(),
        Some("/tmp/soreno-agent-AbCd123456")
    );
    clipboard.hand_over_prompt_directory();

    assert!(clipboard
        .close_with(|_, directory| panic!("{directory} removed while its run may live"))
        .is_ok());
}
#[test]
fn ssh_command_attaches_or_creates_with_the_deployed_dtach() {
    let project = ssh_project("remote");
    let terminal = session();
    let dtach = "/home/user/.cache/Soreno dtach";
    let script = |terminal, remote_host| {
        local_command_with_environment(
            &project,
            terminal,
            &[],
            Some(remote_host),
            Some(dtach),
            None,
            None,
        )
        .unwrap()
        .get_argv()
        .last()
        .unwrap()
        .to_string_lossy()
        .into_owned()
    };

    let mut default_terminal = terminal.clone();
    default_terminal.executable.clear();
    let default_attach = script(&default_terminal, RemoteHost::Live);
    assert!(!default_attach.contains("stty rows"), "{default_attach}");
    assert!(default_attach.contains("-r ctrl_l"), "{default_attach}");
    let attach = script(&terminal, RemoteHost::Live);
    assert!(
        attach.contains("/home/user/.cache/Soreno dtach"),
        "{attach}"
    );
    assert!(attach.contains(" -a "), "{attach}");
    assert!(attach.contains("stty rows"), "{attach}");
    assert!(attach.contains("-r winch"), "{attach}");
    assert!(!attach.contains("cd --"), "{attach}");
    let create = script(&terminal, RemoteHost::Absent);
    assert!(
        create.contains("/home/user/.cache/Soreno dtach"),
        "{create}"
    );
    assert!(create.contains(" -c "), "{create}");
    assert!(create.contains("/.cache/soreno/sessions/"), "{create}");
    assert!(local_command_with_environment(
        &project,
        &terminal,
        &[],
        None,
        Some(dtach),
        None,
        None
    )
    .is_err());
    assert!(local_command_with_environment(
        &project,
        &terminal,
        &[],
        Some(RemoteHost::Absent),
        None,
        None,
        None,
    )
    .is_err());
}
#[test]
fn disconnected_group_migration_runs_once_and_reconnects_the_group() {
    let root = unique_temp_path("soreno-disconnected-projects");
    std::fs::create_dir_all(&root).unwrap();
    let db = Connection::open(root.join("agents.sqlite")).unwrap();
    db.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE agent_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES agent_projects(id), data TEXT NOT NULL);
             CREATE TABLE agent_disconnected_projects (project_id TEXT PRIMARY KEY REFERENCES agent_projects(id) ON DELETE CASCADE);",
        )
        .unwrap();
    let mut remote = ssh_project("remote");
    remote.environment.ssh.as_mut().unwrap().host = format!(
        "restart-{}.invalid",
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    );
    let mut shared = remote.clone();
    shared.id = "shared".into();
    for project in [&remote, &shared] {
        db.execute(
            "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
            params![project.id, serde_json::to_string(project).unwrap()],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO agent_disconnected_projects(project_id) VALUES (?1)",
        [&remote.id],
    )
    .unwrap();
    drop(db);

    let connection = remote.environment.ssh.as_ref().unwrap();
    {
        let state = AgentSessions::open(&root).unwrap();
        assert!(crate::ssh::is_blocked(connection));
        assert_eq!(
            state
                .workspace()
                .unwrap()
                .disconnected_project_ids
                .into_iter()
                .collect::<HashSet<_>>(),
            HashSet::from(["remote".into(), "shared".into()])
        );
        state
            .set_project_connected_with("remote", true, |_, _| Ok(None))
            .unwrap();
        assert!(state
            .workspace()
            .unwrap()
            .disconnected_project_ids
            .is_empty());
        assert!(!crate::ssh::is_blocked(connection));
    }
    {
        let state = AgentSessions::open(&root).unwrap();
        let workspace = state.workspace().unwrap();
        assert_eq!(
            workspace.dormant_project_ids,
            workspace.disconnected_project_ids
        );
        assert_eq!(
            workspace
                .dormant_project_ids
                .into_iter()
                .collect::<HashSet<_>>(),
            HashSet::from(["remote".into(), "shared".into()])
        );
        assert!(!crate::ssh::is_blocked(connection));
        let migrations: i64 = lock(&state.store)
            .unwrap()
            .db
            .query_row(
                "SELECT count(*) FROM agent_schema_migrations WHERE name=?1",
                [NORMALIZE_DISCONNECTED_SSH_GROUPS_MIGRATION],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migrations, 1);
        state.delete_project("remote").unwrap();
        assert!(!crate::ssh::is_blocked(connection));
        state.delete_project("shared").unwrap();
        assert!(!crate::ssh::is_blocked(connection));
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reopened_ssh_projects_stay_dormant_until_a_start_or_a_connection() {
    let root = unique_temp_path("soreno-dormant-projects");
    std::fs::create_dir_all(&root).unwrap();
    let remote = ssh_project("remote");
    let other = ssh_project("other");
    {
        let state = AgentSessions::open(&root).unwrap();
        insert_project(&state, &remote);
        insert_project(&state, &other);
        let mut saved = session();
        saved.project_id = remote.id.clone();
        state.save_session(saved).unwrap();
        assert!(state.workspace().unwrap().dormant_project_ids.is_empty());
    }
    let state = AgentSessions::open(&root).unwrap();
    let workspace = state.workspace().unwrap();
    assert_eq!(
        workspace
            .dormant_project_ids
            .into_iter()
            .collect::<HashSet<_>>(),
        HashSet::from(["remote".into(), "other".into()])
    );
    assert_eq!(workspace.disconnected_project_ids.len(), 2);
    assert!(state
        .project("remote")
        .unwrap_err()
        .contains("pas encore connecté"));
    assert!(state.usage_environments().unwrap().is_empty());
    assert!(state
        .branches_with(|_| panic!("SSH lu"))
        .unwrap()
        .iter()
        .all(|branch| branch.branch.is_none()));

    // Launching reaches the server, even when that attempt then fails.
    assert!(state
        .start_with("session", 80, 24, None, |_, _, _| Err("injoignable".into()))
        .unwrap_err()
        .contains("injoignable"));
    assert_eq!(state.workspace().unwrap().dormant_project_ids, ["other"]);
    assert!(state.project("remote").is_ok());

    assert!(state
        .set_project_connected_with("other", true, |_, _| Err("probe refusée".into()))
        .is_err());
    assert_eq!(state.workspace().unwrap().dormant_project_ids, ["other"]);
    state
        .set_project_connected_with("other", true, |_, _| Ok(None))
        .unwrap();
    let workspace = state.workspace().unwrap();
    assert!(workspace.dormant_project_ids.is_empty());
    assert!(workspace.disconnected_project_ids.is_empty());
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn worktree_refresh_never_probes_a_dormant_snapshot_removed_mid_refresh() {
    let root = unique_temp_path("soreno-dormant-stale-snapshot");
    std::fs::create_dir_all(&root).unwrap();
    let local = local_project("local");
    let removed = ssh_project("removed");
    let retargeted = ssh_project("retargeted");
    {
        let state = AgentSessions::open(&root).unwrap();
        insert_project(&state, &local);
        insert_project(&state, &removed);
        insert_project(&state, &retargeted);
    }
    let state = AgentSessions::open(&root).unwrap();
    let snapshot = state
        .worktree_groups_with(
            |project| {
                assert_eq!(project.id, "local", "SSH en sommeil sondé");
                state.delete_project("removed").unwrap();
                let moved_local = AgentProject {
                    environment: local.environment.clone(),
                    ..retargeted.clone()
                };
                lock(&state.store)
                    .unwrap()
                    .db
                    .execute(
                        "UPDATE agent_projects SET data=?2 WHERE id=?1",
                        params![moved_local.id, serde_json::to_string(&moved_local).unwrap()],
                    )
                    .unwrap();
                Ok(None)
            },
            |_| panic!("aucun groupe attendu"),
        )
        .unwrap();
    assert!(snapshot.groups.is_empty());
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn credential_only_edit_keeps_a_reopened_ssh_project_dormant() {
    let root = unique_temp_path("soreno-dormant-credentials");
    std::fs::create_dir_all(&root).unwrap();
    let remote = ssh_project("remote");
    {
        let state = AgentSessions::open(&root).unwrap();
        insert_project(&state, &remote);
    }
    let state = AgentSessions::open(&root).unwrap();
    assert_eq!(state.workspace().unwrap().dormant_project_ids, ["remote"]);

    let mut rotated = remote.clone();
    rotated.environment.ssh.as_mut().unwrap().identity_file = Some(
        std::env::temp_dir()
            .join("soreno-dormant-rotated-key")
            .to_string_lossy()
            .into(),
    );
    assert!(same_project_target(&remote, &rotated));
    state.save_project(rotated).unwrap();

    assert_eq!(state.workspace().unwrap().dormant_project_ids, ["remote"]);
    assert!(state
        .project("remote")
        .unwrap_err()
        .contains("pas encore connecté"));
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn credential_only_edit_onto_a_connected_shared_connection_keeps_it_connected() {
    let root = unique_temp_path("soreno-dormant-shared-credentials");
    std::fs::create_dir_all(&root).unwrap();
    let first = ssh_project("first");
    let mut second = first.clone();
    second.id = "second".into();
    second.environment.ssh.as_mut().unwrap().identity_file = Some(
        std::env::temp_dir()
            .join("soreno-dormant-shared-key")
            .to_string_lossy()
            .into(),
    );
    assert_ne!(first.environment.ssh, second.environment.ssh);
    {
        let state = AgentSessions::open(&root).unwrap();
        insert_project(&state, &first);
        insert_project(&state, &second);
    }
    let state = AgentSessions::open(&root).unwrap();
    state
        .set_project_connected_with("second", true, |_, _| Ok(None))
        .unwrap();
    assert_eq!(state.workspace().unwrap().dormant_project_ids, ["first"]);

    let mut rotated = first.clone();
    rotated.environment.ssh = second.environment.ssh.clone();
    assert!(same_project_target(&first, &rotated));
    state.save_project(rotated).unwrap();

    assert!(!state
        .workspace()
        .unwrap()
        .dormant_project_ids
        .contains(&"second".to_string()));
    assert!(state.project("second").is_ok());
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn credential_only_edit_onto_a_disconnected_connection_keeps_it_dormant() {
    let root = unique_temp_path("soreno-dormant-disconnected-credentials");
    std::fs::create_dir_all(&root).unwrap();
    let first = ssh_project("first");
    let mut offline = first.clone();
    offline.id = "offline".into();
    offline.environment.ssh.as_mut().unwrap().identity_file = Some(
        std::env::temp_dir()
            .join("soreno-dormant-offline-key")
            .to_string_lossy()
            .into(),
    );
    assert_ne!(first.environment.ssh, offline.environment.ssh);
    {
        let state = AgentSessions::open(&root).unwrap();
        insert_project(&state, &first);
        insert_project(&state, &offline);
        disconnect_project(&state, "offline").unwrap();
    }
    let state = AgentSessions::open(&root).unwrap();
    assert_eq!(state.workspace().unwrap().dormant_project_ids, ["first"]);

    let mut rotated = first.clone();
    rotated.environment.ssh = offline.environment.ssh.clone();
    assert!(same_project_target(&first, &rotated));
    state.save_project(rotated).unwrap();

    assert!(state
        .workspace()
        .unwrap()
        .dormant_project_ids
        .contains(&"first".to_string()));
    assert!(state
        .project("first")
        .unwrap_err()
        .contains("pas encore connecté"));
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn new_database_records_disconnected_group_migration() {
    let state = memory_state();
    let migrations: i64 = lock(&state.store)
        .unwrap()
        .db
        .query_row(
            "SELECT count(*) FROM agent_schema_migrations WHERE name=?1",
            [NORMALIZE_DISCONNECTED_SSH_GROUPS_MIGRATION],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(migrations, 1);
}

#[test]
fn disconnected_project_guards_remote_access_but_remains_editable() {
    let state = memory_state();
    let remote = ssh_project("remote");
    insert_project(&state, &remote);
    let mut local = project();
    local.id = "local".into();
    state.save_project(local.clone()).unwrap();
    let mut remote_session = session();
    remote_session.project_id = remote.id.clone();
    state.save_session(remote_session).unwrap();

    disconnect_project(&state, &remote.id).unwrap();
    let original_connection = remote.environment.ssh.clone().unwrap();
    assert!(crate::ssh::is_blocked(&original_connection));
    assert_eq!(
        state.workspace().unwrap().disconnected_project_ids,
        ["remote"]
    );
    assert!(state
        .project(&remote.id)
        .unwrap_err()
        .contains("déconnecté"));
    assert!(state
        .begin_git_operation(&remote.id)
        .err()
        .unwrap()
        .contains("déconnecté"));
    assert!(state
        .start("session", 80, 24, None)
        .unwrap_err()
        .contains("déconnecté"));
    assert_eq!(state.project(&local.id).unwrap().id, local.id);
    drop(state.begin_git_operation(&local.id).unwrap());

    let probed = std::sync::Mutex::new(Vec::new());
    let branches = state
        .branches_with(|project| {
            probed.lock().unwrap().push(project.id.clone());
            Some(project.id.clone())
        })
        .unwrap();
    assert_eq!(&*probed.lock().unwrap(), &["local"]);
    assert_eq!(branches[0].branch, None);
    assert_eq!(branches[1].branch.as_deref(), Some("local"));

    let mut changed = remote;
    changed.name = "Projet SSH renommé".into();
    state.save_project(changed.clone()).unwrap();
    assert_eq!(
        state.workspace().unwrap().disconnected_project_ids,
        ["remote"]
    );
    assert_eq!(
        state
            .workspace()
            .unwrap()
            .projects
            .into_iter()
            .find(|project| project.id == "remote")
            .unwrap()
            .name,
        changed.name
    );

    let mut retargeted = changed;
    retargeted.path = "/srv/moved".into();
    retargeted.environment.ssh.as_mut().unwrap().host = "moved.invalid".into();
    assert!(state
        .save_project(retargeted.clone())
        .unwrap_err()
        .contains("sessions"));
    assert_eq!(
        state
            .workspace()
            .unwrap()
            .projects
            .into_iter()
            .find(|project| project.id == "remote")
            .unwrap()
            .path,
        "/srv/project"
    );

    state.delete_session("session").unwrap();
    state.save_project(retargeted.clone()).unwrap();
    let moved_connection = retargeted.environment.ssh.clone().unwrap();
    assert!(!crate::ssh::is_blocked(&original_connection));
    assert!(crate::ssh::is_blocked(&moved_connection));
    retargeted.path = std::env::temp_dir().to_string_lossy().into();
    retargeted.environment = project().environment;
    state.save_project(retargeted).unwrap();
    assert!(!crate::ssh::is_blocked(&moved_connection));
    assert!(state
        .workspace()
        .unwrap()
        .disconnected_project_ids
        .is_empty());
    assert_eq!(state.project("remote").unwrap().environment.kind, "local");
}

#[test]
fn branch_result_is_ignored_when_project_disconnects_during_probe() {
    let state = memory_state();
    let remote = ssh_project("remote");
    insert_project(&state, &remote);

    let branches = state
        .branches_with(|project| {
            disconnect_project(&state, &project.id).unwrap();
            Some("main".into())
        })
        .unwrap();

    assert_eq!(branches[0].branch, None);
    assert_eq!(
        state.workspace().unwrap().disconnected_project_ids,
        ["remote"]
    );
}

#[test]
fn branch_probes_of_distinct_environments_do_not_wait_for_each_other() {
    let state = memory_state();
    let remote = ssh_project("remote");
    let mut local = project();
    local.id = "local".into();
    insert_project(&state, &remote);
    insert_project(&state, &local);
    let started = std::sync::Mutex::new(0);
    let all_started = std::sync::Condvar::new();

    let branches = state
        .branches_with(|project| {
            let mut count = started.lock().unwrap();
            *count += 1;
            all_started.notify_all();
            let (count, timeout) = all_started
                .wait_timeout_while(count, Duration::from_secs(2), |count| *count < 2)
                .unwrap();
            drop(count);
            (!timeout.timed_out()).then(|| project.id.clone())
        })
        .unwrap();

    let branches: Vec<_> = branches
        .iter()
        .map(|entry| (entry.project_id.as_str(), entry.branch.as_deref()))
        .collect();
    assert_eq!(
        branches,
        [("remote", Some("remote")), ("local", Some("local"))]
    );
}

#[test]
fn disconnected_ssh_workspace_and_shutdown_skip_reconciliation() {
    let root = unique_temp_path("soreno-disconnected-workspace");
    std::fs::create_dir_all(&root).unwrap();
    let state = AgentSessions::open(&root).unwrap();
    let remote = ssh_project("remote");
    insert_project(&state, &remote);
    let mut remote_session = session();
    remote_session.project_id = remote.id.clone();
    remote_session.executable = "pi".into();
    remote_session.args.clear();
    state.save_session(remote_session.clone()).unwrap();
    let metadata = root.join("invalid-remote-metadata.json");
    std::fs::write(&metadata, b"{").unwrap();
    let store = lock(&state.store).unwrap();
    let mut record: serde_json::Value =
        serde_json::from_str(&stored_conversation_json(&store.db, &remote_session.id)).unwrap();
    record["runId"] = serde_json::json!("test-run");
    record["metadataPath"] = serde_json::json!(metadata);
    record["conversationError"] = serde_json::json!("statut local conservé");
    store
        .db
        .execute(
            "UPDATE agent_conversations SET data=?1 WHERE session_id=?2",
            params![record.to_string(), remote_session.id],
        )
        .unwrap();
    drop(store);

    disconnect_project(&state, &remote.id).unwrap();
    let workspace = state.workspace().unwrap();

    assert_eq!(workspace.disconnected_project_ids, ["remote"]);
    assert_eq!(workspace.statuses[0].state, "idle");
    assert_eq!(workspace.statuses[0].working, None);
    assert_eq!(
        workspace.statuses[0].conversation_error.as_deref(),
        Some("statut local conservé")
    );
    let before_shutdown =
        stored_conversation_json(&lock(&state.store).unwrap().db, &remote_session.id);
    state.shutdown();
    assert_eq!(
        stored_conversation_json(&lock(&state.store).unwrap().db, &remote_session.id),
        before_shutdown
    );
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn disconnect_marks_shared_connection_projects_and_stops_runtimes() {
    let state = memory_state();
    let remote = ssh_project("remote");
    let mut shared = remote.clone();
    shared.id = "shared".into();
    let mut other = ssh_project("other");
    other.environment.ssh.as_mut().unwrap().host = "other.invalid".into();
    for project in [&remote, &shared, &other] {
        insert_project(&state, project);
    }
    let mut first_session = session();
    first_session.id = "first".into();
    first_session.project_id = remote.id.clone();
    state.save_session(first_session.clone()).unwrap();
    let mut second_session = session();
    second_session.id = "second".into();
    second_session.project_id = shared.id.clone();
    state.save_session(second_session.clone()).unwrap();
    let connection = remote.environment.ssh.clone().unwrap();
    let first_runtime = exited_ssh_runtime(connection.clone(), "disconnect-first");
    let second_runtime = exited_ssh_runtime(connection.clone(), "disconnect-second");
    {
        let mut store = lock(&state.store).unwrap();
        store
            .runtimes
            .insert(first_session.id, Arc::clone(&first_runtime));
        store
            .runtimes
            .insert(second_session.id, Arc::clone(&second_runtime));
    }
    state
        .set_project_connected_with(&remote.id, false, |_, _| panic!("validation inattendue"))
        .unwrap();
    assert_eq!(
        state
            .workspace()
            .unwrap()
            .disconnected_project_ids
            .into_iter()
            .collect::<HashSet<_>>(),
        HashSet::from(["remote".into(), "shared".into()])
    );
    assert!(
        lock(&first_runtime.remote_clipboard.as_ref().unwrap().state)
            .unwrap()
            .closed
    );
    assert!(
        lock(&second_runtime.remote_clipboard.as_ref().unwrap().state)
            .unwrap()
            .closed
    );
    state
        .set_project_connected_with(&remote.id, false, |_, _| panic!("validation inattendue"))
        .unwrap();
    state
        .set_project_connected_with(&remote.id, true, |_, _| Ok(None))
        .unwrap();
    let store = lock(&state.store).unwrap();
    assert!(!project_disconnected(&store.db, &remote.id).unwrap());
    assert!(!project_disconnected(&store.db, &shared.id).unwrap());
    assert!(!blocked_ssh_connections(&store.db)
        .unwrap()
        .contains(&connection));
    assert!(!crate::ssh::is_blocked(&connection));
    // Deleting sessions of a connected SSH project contacts the server.
    store.db.execute("DELETE FROM agent_sessions", []).unwrap();
    drop(store);

    state.delete_project(&remote.id).unwrap();
    assert!(!crate::ssh::is_blocked(&connection));
    state.delete_project(&shared.id).unwrap();
    assert!(!crate::ssh::is_blocked(&connection));
}

#[test]
fn project_forwarding_serializes_last_project_deletion() {
    let state = Arc::new(memory_state());
    let remote = ssh_project("forwarded");
    let connection = remote.environment.ssh.clone().unwrap();
    insert_project(&state, &remote);

    let (forward_entered_sender, forward_entered_receiver) = std::sync::mpsc::sync_channel(0);
    let (release_forward_sender, release_forward_receiver) = std::sync::mpsc::sync_channel(0);
    let forwarding_state = Arc::clone(&state);
    let forwarding = thread::spawn(move || {
        forwarding_state.with_project_ssh_connection("forwarded", |resolved| {
            assert_eq!(resolved, &connection);
            forward_entered_sender.send(()).unwrap();
            release_forward_receiver.recv().unwrap();
            Ok(())
        })
    });
    forward_entered_receiver.recv().unwrap();

    let (deletion_started_sender, deletion_started_receiver) = std::sync::mpsc::sync_channel(0);
    let (deletion_done_sender, deletion_done_receiver) = std::sync::mpsc::sync_channel(1);
    let deleting_state = Arc::clone(&state);
    let deletion = thread::spawn(move || {
        deletion_started_sender.send(()).unwrap();
        deletion_done_sender
            .send(deleting_state.delete_project("forwarded"))
            .unwrap();
    });
    deletion_started_receiver.recv().unwrap();
    let deleted_early =
        match deletion_done_receiver.recv_timeout(std::time::Duration::from_millis(250)) {
            Ok(result) => {
                result.unwrap();
                true
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => false,
            Err(error) => panic!("canal de suppression fermé : {error}"),
        };

    release_forward_sender.send(()).unwrap();
    forwarding.join().unwrap().unwrap();
    if !deleted_early {
        deletion_done_receiver.recv().unwrap().unwrap();
    }
    deletion.join().unwrap();

    assert!(!deleted_early, "la suppression a devancé le forwarding");
    assert!(state.project("forwarded").is_err());
}

#[test]
fn deleting_shared_projects_only_orphans_the_last_ssh_reference() {
    let state = memory_state();
    let remote = ssh_project("remote");
    let mut shared = remote.clone();
    shared.id = "shared".into();
    insert_project(&state, &remote);
    insert_project(&state, &shared);

    let mut store = lock(&state.store).unwrap();
    let (_, _, orphaned) =
        delete_projects_locked(&mut store, &[remote.id], SessionEnd::Project).unwrap();
    assert!(orphaned.is_empty());
    let (_, _, orphaned) =
        delete_projects_locked(&mut store, &[shared.id], SessionEnd::Project).unwrap();
    assert_eq!(orphaned, [remote.environment.ssh.unwrap()]);
}

#[test]
fn disconnect_stops_every_remote_session_of_the_connection_group() {
    let state = memory_state();
    let remote = ssh_project("remote");
    let mut shared = remote.clone();
    shared.id = "shared".into();
    let other = ssh_project("other");
    for project in [&remote, &shared, &other] {
        insert_project(&state, project);
    }
    for (session_id, project_id) in [
        ("first", "remote"),
        ("detached", "shared"),
        ("elsewhere", "other"),
    ] {
        let mut saved = session();
        saved.id = session_id.into();
        saved.project_id = project_id.into();
        state.save_session(saved).unwrap();
    }
    let connection = remote.environment.ssh.clone().unwrap();
    let runtime = exited_ssh_runtime(connection.clone(), "disconnect-remote-stop");
    lock(&state.store)
        .unwrap()
        .runtimes
        .insert("first".into(), Arc::clone(&runtime));
    let stopped = std::cell::RefCell::new(Vec::new());

    let error = state
        .set_project_connected_using(
            &remote.id,
            false,
            |_, _| panic!("validation inattendue"),
            |target, session_ids| {
                assert_eq!(target, &connection);
                stopped
                    .borrow_mut()
                    .extend(session_ids.iter().map(|id| id.to_string()));
                Err("serveur injoignable".into())
            },
        )
        .unwrap_err();

    assert!(
        error.contains("sessions distantes : serveur injoignable"),
        "{error}"
    );
    assert_eq!(*stopped.borrow(), ["first", "detached"]);
    assert!(
        lock(&runtime.remote_clipboard.as_ref().unwrap().state)
            .unwrap()
            .closed
    );
    let store = lock(&state.store).unwrap();
    assert!(project_disconnected(&store.db, &shared.id).unwrap());
    drop(store);
    state
        .set_project_connected_using(
            &remote.id,
            false,
            |_, _| panic!("validation inattendue"),
            |_, _| panic!("relais bloqué"),
        )
        .unwrap();
}

#[cfg(unix)]
#[test]
fn disconnect_stops_the_conversations_holding_the_connection() {
    let state = memory_state();
    let remote = ssh_project("remote");
    insert_project(&state, &remote);
    let mut saved = session();
    saved.project_id = remote.id.clone();
    state.save_session(saved.clone()).unwrap();
    let connection = remote.environment.ssh.clone().unwrap();
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", "cat >/dev/null"]);
    let omp = conversation::ConversationProcess::spawn(
        command,
        format!("soreno-disconnect-omp-{}", std::process::id()),
        crate::ssh::begin_access(&connection).unwrap(),
        None,
    )
    .unwrap();
    lock(&state.store)
        .unwrap()
        .omp_conversations
        .insert(saved.id.clone(), Arc::clone(&omp));

    state
        .set_project_connected_using(
            &remote.id,
            false,
            |_, _| panic!("validation inattendue"),
            |_, _| Ok(()),
        )
        .unwrap();

    assert!(omp.exited());
    assert!(crate::ssh::is_blocked(&connection));
}

#[test]
fn local_stop_failures_are_reported_after_disconnect() {
    let state = memory_state();
    let remote = ssh_project("remote");
    let mut shared = remote.clone();
    shared.id = "shared".into();
    insert_project(&state, &remote);
    insert_project(&state, &shared);
    let mut remote_session = session();
    remote_session.project_id = remote.id.clone();
    state.save_session(remote_session.clone()).unwrap();
    let runtime = exited_ssh_runtime(
        remote.environment.ssh.clone().unwrap(),
        "disconnect-poisoned",
    );
    let poisoned = Arc::clone(&runtime);
    assert!(thread::spawn(move || {
        let _guard = poisoned.killer.lock().unwrap();
        panic!("empoisonnement simulé");
    })
    .join()
    .is_err());
    lock(&state.store)
        .unwrap()
        .runtimes
        .insert(remote_session.id, runtime);
    let error = state
        .set_project_connected_with(&remote.id, false, |_, _| panic!("validation inattendue"))
        .unwrap_err();

    assert!(error.contains("Projet déconnecté"), "{error}");
    assert!(error.contains("session session"), "{error}");
    let retry = state
        .set_project_connected_with(&remote.id, false, |_, _| panic!("validation inattendue"))
        .unwrap_err();
    assert!(retry.contains("session session"), "{retry}");
}

#[test]
fn reconnect_stabilizes_ssh_before_validating_directory() {
    let remote = ssh_project("remote");
    let steps = std::cell::RefCell::new(Vec::new());

    validate_reconnected_project_directory(
        &remote.environment,
        &remote.path,
        |_| {
            steps.borrow_mut().push("ready");
            Ok(())
        },
        |_, _| {
            steps.borrow_mut().push("validate");
            Ok(None)
        },
    )
    .unwrap();
    assert_eq!(*steps.borrow(), ["ready", "validate"]);

    let validated = std::cell::Cell::new(false);
    assert!(validate_reconnected_project_directory(
        &remote.environment,
        &remote.path,
        |_| Err("relais indisponible".into()),
        |_, _| {
            validated.set(true);
            Ok(None)
        },
    )
    .is_err());
    assert!(!validated.get());
}

#[test]
fn reconnect_validation_and_git_busy_preserve_the_marker() {
    let state = memory_state();
    let remote = ssh_project("remote");
    insert_project(&state, &remote);
    lock(&state.store).unwrap().git_busy = true;
    assert!(disconnect_project(&state, "remote")
        .unwrap_err()
        .contains("Git"));
    lock(&state.store).unwrap().git_busy = false;
    assert!(state
        .workspace()
        .unwrap()
        .disconnected_project_ids
        .is_empty());

    disconnect_project(&state, "remote").unwrap();
    let connection = remote.environment.ssh.as_ref().unwrap();
    assert!(crate::ssh::is_blocked(connection));
    assert!(state
        .set_project_connected_with("remote", true, |_, _| {
            assert!(!crate::ssh::is_blocked(connection));
            Err("probe refusée".into())
        })
        .unwrap_err()
        .contains("probe refusée"));
    assert_eq!(
        state.workspace().unwrap().disconnected_project_ids,
        ["remote"]
    );
    assert!(crate::ssh::is_blocked(connection));
    state
        .set_project_connected_with("remote", true, |environment, path| {
            assert!(!crate::ssh::is_blocked(connection));
            assert_eq!(environment.kind, "ssh");
            assert_eq!(path, "/srv/project");
            Ok(None)
        })
        .unwrap();
    assert!(state
        .workspace()
        .unwrap()
        .disconnected_project_ids
        .is_empty());
    assert!(!crate::ssh::is_blocked(connection));
}

#[test]
fn blocked_remote_start_allows_other_reads_and_serializes_same_session_stop() {
    let state = memory_state();
    let remote = ssh_project("serialized-start");
    insert_project(&state, &remote);
    state.save_project(project()).unwrap();
    let mut saved = session();
    saved.project_id = remote.id.clone();
    state.save_session(saved).unwrap();
    let mut other = session();
    other.id = "other".into();
    state.save_session(other).unwrap();

    let (prepare_entered, prepare_started) = std::sync::mpsc::sync_channel(0);
    let (release_prepare, prepare_released) = std::sync::mpsc::sync_channel(0);
    let (start_result_sender, start_result_receiver) = std::sync::mpsc::sync_channel(0);
    let (stop_entered, stop_started) = std::sync::mpsc::sync_channel(0);
    thread::scope(|scope| {
        let state_for_start = &state;
        let expected_connection = remote.environment.ssh.clone();
        scope.spawn(move || {
            let result = state_for_start.start_with(
                "session",
                80,
                24,
                None,
                |kind, connection, session_id| {
                    assert_eq!(kind, "ssh");
                    assert_eq!(connection, expected_connection.as_ref());
                    assert_eq!(session_id, "session");
                    prepare_entered.send(()).unwrap();
                    prepare_released.recv().unwrap();
                    Err("sonde interrompue".into())
                },
            );
            start_result_sender.send(result).unwrap();
        });
        prepare_started.recv().unwrap();

        let (read_sender, read_receiver) = std::sync::mpsc::sync_channel(0);
        let state_for_read = &state;
        scope.spawn(move || read_sender.send(terminal(state_for_read, "other")).unwrap());
        let read_completed = read_receiver
            .recv_timeout(Duration::from_secs(1))
            .is_ok_and(|result| result.is_ok());

        let state_for_stop = &state;
        scope.spawn(move || {
            state_for_stop
                .stop_with("session", |_, _| {
                    stop_entered.send(()).unwrap();
                    Ok(())
                })
                .unwrap();
        });
        let stop_waited = matches!(
            stop_started.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        );
        release_prepare.send(()).unwrap();
        assert_eq!(
            start_result_receiver.recv().unwrap().unwrap_err(),
            "sonde interrompue"
        );
        stop_started.recv_timeout(Duration::from_secs(1)).unwrap();

        assert!(read_completed, "the SSH probe held the session store");
        assert!(stop_waited, "stop raced a start for the same session");
    });
}

#[test]
fn blocked_remote_stop_allows_other_session_reads() {
    let state = memory_state();
    let remote = ssh_project("serialized-stop");
    insert_project(&state, &remote);
    state.save_project(project()).unwrap();
    let mut saved = session();
    saved.project_id = remote.id.clone();
    state.save_session(saved).unwrap();
    let mut other = session();
    other.id = "other".into();
    state.save_session(other).unwrap();

    let (stop_entered, stop_started) = std::sync::mpsc::sync_channel(0);
    let (release_stop, stop_released) = std::sync::mpsc::sync_channel(0);
    thread::scope(|scope| {
        let state_for_stop = &state;
        let expected_connection = remote.environment.ssh.clone().unwrap();
        scope.spawn(move || {
            state_for_stop
                .stop_with("session", |connection, session_ids| {
                    assert_eq!(connection, &expected_connection);
                    assert_eq!(session_ids, ["session"]);
                    stop_entered.send(()).unwrap();
                    stop_released.recv().unwrap();
                    Ok(())
                })
                .unwrap();
        });
        stop_started.recv().unwrap();

        let (read_sender, read_receiver) = std::sync::mpsc::sync_channel(0);
        let state_for_read = &state;
        scope.spawn(move || read_sender.send(terminal(state_for_read, "other")).unwrap());
        let read_completed = read_receiver
            .recv_timeout(Duration::from_secs(1))
            .is_ok_and(|result| result.is_ok());
        release_stop.send(()).unwrap();

        assert!(read_completed, "the remote stop held the session store");
    });
}

#[test]
fn inaccessible_remote_probe_blocks_session_launch_changes() {
    let state = memory_state();
    let remote = ssh_project("remote-probe");
    insert_project(&state, &remote);
    let mut saved = session();
    saved.project_id = remote.id.clone();
    state.save_session(saved.clone()).unwrap();
    let connection = remote.environment.ssh.as_ref().unwrap();
    crate::ssh::block(connection);

    saved.args.push("--changed".into());
    assert!(state.save_session(saved).is_err());

    crate::ssh::unblock(connection);
}

#[test]
fn workspace_keeps_uncertain_remote_metadata_without_ssh_io() {
    let state = memory_state();
    let remote = ssh_project("remote-metadata");
    insert_project(&state, &remote);
    let mut saved = session();
    saved.project_id = remote.id.clone();
    saved.executable = "pi".into();
    saved.args.clear();
    state.save_session(saved.clone()).unwrap();
    let metadata_path = std::env::temp_dir().join(format!(
        "soreno-workspace-sidecar-{}-{}.json",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    std::fs::write(
        &metadata_path,
        serde_json::json!({
            "version": 1,
            "runId": "active-run",
            "provider": "pi",
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sessionFile": "/home/alice/session.jsonl",
            "working": true
        })
        .to_string(),
    )
    .unwrap();
    {
        let store = lock(&state.store).unwrap();
        let mut record: serde_json::Value =
            serde_json::from_str(&stored_conversation_json(&store.db, &saved.id)).unwrap();
        record["runId"] = serde_json::json!("active-run");
        record["metadataPath"] = serde_json::json!(metadata_path);
        store
            .db
            .execute(
                "UPDATE agent_conversations SET data=?1 WHERE session_id=?2",
                params![record.to_string(), saved.id],
            )
            .unwrap();
    }
    let connection = remote.environment.ssh.as_ref().unwrap();
    crate::ssh::block(connection);

    let workspace = state.workspace().unwrap();
    assert!(workspace.statuses[0].conversation_error.is_none());
    let record: serde_json::Value = serde_json::from_str(&stored_conversation_json(
        &lock(&state.store).unwrap().db,
        &saved.id,
    ))
    .unwrap();
    assert_eq!(record["runId"], "active-run");
    assert_eq!(record["conversationError"], serde_json::Value::Null);

    crate::ssh::unblock(connection);
    std::fs::remove_file(metadata_path).unwrap();
}

#[cfg(unix)]
#[test]
fn disconnect_stops_active_runtime_and_preserves_launcher_and_output() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    let mut running = session();
    running.args = vec!["-c".into(), "printf ready; trap '' HUP; sleep 60".into()];
    state.save_session(running).unwrap();
    state.start("session", 80, 24, None).unwrap();
    wait_for(|| {
        terminal(&state, "session")
            .unwrap()
            .text()
            .contains("ready")
    });
    let remote = ssh_project("project");
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "UPDATE agent_projects SET data=?1 WHERE id=?2",
            params![serde_json::to_string(&remote).unwrap(), remote.id],
        )
        .unwrap();

    disconnect_project(&state, "project").unwrap();
    let terminal = terminal(&state, "session").unwrap();
    assert_eq!(terminal.status.state, "exited");
    assert!(terminal.text().contains("ready"));
    let workspace = state.workspace().unwrap();
    assert_eq!(workspace.sessions.len(), 1);
    assert_eq!(workspace.disconnected_project_ids, ["project"]);
    assert!(state.start("session", 80, 24, None).is_err());
}

#[test]
fn ssh_auth_rotation_preserves_target_sessions_and_conversation_metadata() {
    let state = memory_state();
    let mut remote = project();
    remote.path = "/srv/project".into();
    remote.environment = AgentEnvironment {
        kind: "ssh".into(),
        distribution: None,
        ssh: Some(SshConnection {
            host: "example.invalid".into(),
            user: Some("alice".into()),
            port: Some(2222),
            identity_file: Some("/revoked/ssh-key".into()),
            host_key: None,
        }),
    };
    {
        let store = lock(&state.store).unwrap();
        store
            .db
            .execute(
                "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
                params![remote.id, serde_json::to_string(&remote).unwrap()],
            )
            .unwrap();
    }
    let mut agent = session();
    agent.executable = "pi".into();
    agent.args.clear();
    state.save_session(agent.clone()).unwrap();
    let before = stored_conversation_json(&lock(&state.store).unwrap().db, &agent.id);

    let mut differently_spelled = remote.clone();
    differently_spelled.environment.ssh.as_mut().unwrap().host = "EXAMPLE.INVALID.".into();
    assert!(!same_project_target(&remote, &differently_spelled));
    let mut implicit_port = remote.clone();
    implicit_port.environment.ssh.as_mut().unwrap().port = None;
    assert!(!same_project_target(&remote, &implicit_port));

    let mut rotated = remote.clone();
    rotated.name = "Renamed".into();
    let connection = rotated.environment.ssh.as_mut().unwrap();
    connection.identity_file = Some(
        std::env::temp_dir()
            .join("soreno-rotated-key")
            .to_string_lossy()
            .into(),
    );
    let key_type = b"ssh-ed25519";
    let mut key = (key_type.len() as u32).to_be_bytes().to_vec();
    key.extend_from_slice(key_type);
    key.push(0);
    connection.host_key = Some(format!("ssh-ed25519 {}", STANDARD.encode(key)));
    let rotated_connection = connection.clone();
    assert!(same_project_target(&remote, &rotated));

    let remote_clipboard = RemoteClipboard::new(remote.environment.ssh.clone().unwrap(), None);
    lock(&remote_clipboard.state).unwrap().directory = Some("/tmp/soreno-agent-AbCd123456".into());
    let runtime = Arc::new(Runtime {
        output: Mutex::new(Output::default()),
        grid: Mutex::new(None),
        writer: Mutex::new(None),
        size: Mutex::new(size(80, 24).unwrap()),
        master: Mutex::new(None),
        killer: Mutex::new(Box::new(TestKiller)),
        remote_clipboard: Some(remote_clipboard),
        local_attachment_directory: Mutex::new(None),
        remote_sidecar_generation: None,
        #[cfg(windows)]
        wsl: None,
        #[cfg(windows)]
        process_handle: 0,
        #[cfg(unix)]
        run_token: "ssh-auth-rotation-test-no-process".into(),
    });
    lock(&state.store)
        .unwrap()
        .runtimes
        .insert(agent.id.clone(), Arc::clone(&runtime));
    assert!(state
        .save_project(rotated.clone())
        .unwrap_err()
        .contains("Arrêtez"));
    let clipboard = runtime.remote_clipboard.as_ref().unwrap();
    assert_eq!(
        lock(&clipboard.state).unwrap().connection,
        *remote.environment.ssh.as_ref().unwrap()
    );
    lock(&runtime.output).unwrap().exited = true;
    runtime
        .replace_remote_clipboard_connection(rotated_connection.clone())
        .unwrap();
    let mut clipboard_state = lock(&clipboard.state).unwrap();
    assert_eq!(clipboard_state.connection, rotated_connection);
    assert_eq!(
        clipboard_state.directory.as_deref(),
        Some("/tmp/soreno-agent-AbCd123456")
    );
    clipboard_state.directory = None;
    clipboard_state.connection = remote.environment.ssh.clone().unwrap();
    drop(clipboard_state);
    state.save_project(rotated.clone()).unwrap();
    assert_eq!(
        lock(&clipboard.state).unwrap().connection,
        rotated_connection
    );
    assert_eq!(state.project(&remote.id).unwrap().name, "Renamed");
    assert_eq!(
        stored_conversation_json(&lock(&state.store).unwrap().db, &agent.id),
        before
    );

    let mut moved = rotated.clone();
    moved.path = "/srv/other".into();
    assert!(!same_project_target(&rotated, &moved));
    assert!(state.save_project(moved).is_err());
    let mut retargeted = rotated;
    retargeted.environment.ssh.as_mut().unwrap().host = "other.invalid".into();
    assert!(!same_project_target(&remote, &retargeted));
    assert!(state.save_project(retargeted).is_err());
}

#[test]
fn default_shell_session_persists_and_can_be_renamed() {
    let root = unique_temp_path("soreno-terminal-persistence");
    let project_dir = root.join("project");
    std::fs::create_dir_all(&project_dir).unwrap();
    let mut saved_project = project();
    saved_project.path = project_dir.to_string_lossy().into();
    let mut terminal = session();
    terminal.executable.clear();
    terminal.args.clear();
    {
        let state = AgentSessions::open(&root).unwrap();
        state.save_project(saved_project).unwrap();
        state.save_session(terminal.clone()).unwrap();
    }
    {
        let state = AgentSessions::open(&root).unwrap();
        assert_eq!(state.workspace().unwrap().sessions[0].executable, "");
        terminal.name = "Terminal renamed".into();
        state.save_session(terminal.clone()).unwrap();
    }
    assert_eq!(
        AgentSessions::open(&root)
            .unwrap()
            .workspace()
            .unwrap()
            .sessions[0]
            .name,
        terminal.name
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn new_project_reservation_waits_for_disconnect_and_rejects_its_ssh_source() {
    let state = Arc::new(memory_state());
    let remote = ssh_project("remote");
    insert_project(&state, &remote);
    let mut remote_session = session();
    remote_session.project_id = remote.id.clone();
    state.save_session(remote_session.clone()).unwrap();
    let runtime = exited_ssh_runtime(remote.environment.ssh.clone().unwrap(), "reservation");
    lock(&state.store)
        .unwrap()
        .runtimes
        .insert(remote_session.id, Arc::clone(&runtime));

    let (stop_entered_sender, stop_entered_receiver) = std::sync::mpsc::channel();
    let (release_stop_sender, release_stop_receiver) = std::sync::mpsc::channel();
    let blocking_runtime = Arc::clone(&runtime);
    let stop_blocker = thread::spawn(move || {
        let _killer = blocking_runtime.killer.lock().unwrap();
        stop_entered_sender.send(()).unwrap();
        release_stop_receiver.recv().unwrap();
    });
    stop_entered_receiver.recv().unwrap();

    let disconnecting = Arc::clone(&state);
    let disconnect = thread::spawn(move || {
        disconnecting
            .set_project_connected_with("remote", false, |_, _| panic!("validation inattendue"))
    });
    wait_for(|| state.workspace().unwrap().disconnected_project_ids == ["remote"]);

    let (reservation_started_sender, reservation_started_receiver) = std::sync::mpsc::channel();
    let (reservation_done_sender, reservation_done_receiver) = std::sync::mpsc::channel();
    let reserving = Arc::clone(&state);
    let reservation = thread::spawn(move || {
        reservation_started_sender.send(()).unwrap();
        let result = reserving
            .begin_git_operation_for_new_project_from("new", "remote")
            .map(|_| ());
        reservation_done_sender.send(result).unwrap();
    });
    reservation_started_receiver.recv().unwrap();
    let early_result =
        reservation_done_receiver.recv_timeout(std::time::Duration::from_millis(250));

    release_stop_sender.send(()).unwrap();
    stop_blocker.join().unwrap();
    disconnect.join().unwrap().unwrap();
    let (completed_early, reservation_result) = match early_result {
        Ok(result) => (true, result),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            (false, reservation_done_receiver.recv().unwrap())
        }
        Err(error) => panic!("canal de réservation fermé : {error}"),
    };
    reservation.join().unwrap();

    assert!(!completed_early, "la réservation a devancé la déconnexion");
    let error = reservation_result.unwrap_err();
    assert!(error.contains("déconnecté"), "{error}");
    let workspace = state.workspace().unwrap();
    assert_eq!(workspace.disconnected_project_ids, ["remote"]);
    assert!(workspace.projects.iter().all(|project| project.id != "new"));
    state
        .set_project_connected_with("remote", true, |_, _| Ok(None))
        .unwrap();
}

#[test]
fn connection_changes_serialize_disconnect_then_reconnect() {
    let state = Arc::new(memory_state());
    let remote = ssh_project("remote");
    insert_project(&state, &remote);
    let mut remote_session = session();
    remote_session.project_id = remote.id.clone();
    state.save_session(remote_session.clone()).unwrap();
    let runtime = exited_ssh_runtime(remote.environment.ssh.clone().unwrap(), "serialized");
    lock(&state.store)
        .unwrap()
        .runtimes
        .insert(remote_session.id, Arc::clone(&runtime));

    let (stop_entered_sender, stop_entered_receiver) = std::sync::mpsc::channel();
    let (release_stop_sender, release_stop_receiver) = std::sync::mpsc::channel();
    let blocking_runtime = Arc::clone(&runtime);
    let stop_blocker = thread::spawn(move || {
        let _killer = blocking_runtime.killer.lock().unwrap();
        stop_entered_sender.send(()).unwrap();
        release_stop_receiver.recv().unwrap();
    });
    stop_entered_receiver.recv().unwrap();

    let disconnecting = Arc::clone(&state);
    let disconnect = thread::spawn(move || {
        disconnecting
            .set_project_connected_with("remote", false, |_, _| panic!("validation inattendue"))
    });
    wait_for(|| state.workspace().unwrap().disconnected_project_ids == ["remote"]);

    let (reconnect_started_sender, reconnect_started_receiver) = std::sync::mpsc::channel();
    let (validation_sender, validation_receiver) = std::sync::mpsc::channel();
    let reconnecting = Arc::clone(&state);
    let reconnect = thread::spawn(move || {
        reconnect_started_sender.send(()).unwrap();
        reconnecting.set_project_connected_with("remote", true, |_, _| {
            validation_sender.send(()).unwrap();
            Ok(None)
        })
    });
    reconnect_started_receiver.recv().unwrap();
    assert!(validation_receiver
        .recv_timeout(std::time::Duration::from_millis(100))
        .is_err());

    release_stop_sender.send(()).unwrap();
    stop_blocker.join().unwrap();
    disconnect.join().unwrap().unwrap();
    validation_receiver.recv().unwrap();
    reconnect.join().unwrap().unwrap();

    assert!(state
        .workspace()
        .unwrap()
        .disconnected_project_ids
        .is_empty());
    assert!(!crate::ssh::is_blocked(
        remote.environment.ssh.as_ref().unwrap()
    ));
}

#[test]
fn new_project_git_lease_inserts_once_without_releasing_the_guard_early() {
    let root = unique_temp_path("soreno-new-project-lease");
    std::fs::create_dir_all(&root).unwrap();
    let state = memory_state();
    let mut reserved = project();
    reserved.id = "reserved".into();
    reserved.path = root.to_string_lossy().into();
    let lease = state
        .begin_git_operation_for_new_project(&reserved.id)
        .unwrap();
    let mut other = project();
    other.id = "other".into();
    other.path = root.to_string_lossy().into();
    assert!(state.save_project(other).unwrap_err().contains("Git"));

    let mut collision = reserved.clone();
    collision.name = "Collision".into();
    {
        let store = lock(&state.store).unwrap();
        store
            .db
            .execute(
                "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
                params![collision.id, serde_json::to_string(&collision).unwrap()],
            )
            .unwrap();
    }
    assert!(lease.insert_project(reserved).is_err());
    assert_eq!(state.project("reserved").unwrap().name, "Collision");
    drop(state.begin_git_operation_for_new_project("next").unwrap());
    std::fs::remove_dir_all(root).unwrap();
}
