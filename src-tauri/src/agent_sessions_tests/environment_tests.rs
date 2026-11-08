use super::*;

#[test]
fn conversation_workspace_reopens_and_reconciles_without_launching() {
    let root = unique_temp_path("soreno-conversation-workspace");
    std::fs::create_dir_all(&root).unwrap();
    let mut saved_project = project();
    saved_project.path = root.to_string_lossy().into();
    let mut saved_session = session();
    saved_session.executable = "pi".into();
    saved_session.args.clear();
    let conversation_id = "55555555-5555-4555-8555-555555555555";
    let history = root.join("pi.jsonl");
    std::fs::write(
        &history,
        format!(
            "{}\n",
            serde_json::json!({"type": "session", "id": conversation_id})
        ),
    )
    .unwrap();
    {
        let state = AgentSessions::open(&root).unwrap();
        state.save_project(saved_project.clone()).unwrap();
        state.save_session(saved_session.clone()).unwrap();
        let status = &state.workspace().unwrap().statuses[0];
        assert_eq!(status.resume, "new");
        assert!(status.conversation.is_none());
        assert!(state.runtime(&saved_session.id).unwrap().is_none());

        let store = lock(&state.store).unwrap();
        conversations::prepare_launch(
            &store.db,
            &store.links_dir,
            &saved_session,
            &saved_project,
            None,
        )
        .unwrap();
        let data = stored_conversation_json(&store.db, &saved_session.id);
        let record: serde_json::Value = serde_json::from_str(&data).unwrap();
        std::fs::write(
            record["metadataPath"].as_str().unwrap(),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "runId": record["runId"],
                "provider": "pi",
                "sessionId": conversation_id,
                "sessionFile": history,
                "name": "Conversation durable",
                "error": null,
            }))
            .unwrap(),
        )
        .unwrap();
    }
    {
        let state = AgentSessions::open(&root).unwrap();
        let status = &state.workspace().unwrap().statuses[0];
        assert_eq!(status.state, "idle");
        assert_eq!(status.resume, "linked");
        assert_eq!(
            status.conversation.as_ref().unwrap().name.as_deref(),
            Some("Conversation durable")
        );
        assert!(status.conversation_error.is_none());
        assert!(state.runtime(&saved_session.id).unwrap().is_none());

        let run_directory = {
            let store = lock(&state.store).unwrap();
            let data = stored_conversation_json(&store.db, &saved_session.id);
            let record: serde_json::Value = serde_json::from_str(&data).unwrap();
            PathBuf::from(record["metadataPath"].as_str().unwrap())
                .parent()
                .unwrap()
                .to_owned()
        };
        assert!(run_directory.is_dir());
        state.delete_session(&saved_session.id).unwrap();
        assert!(!run_directory.exists());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn migrates_legacy_local_wsl_unc_projects_without_touching_sessions() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE agent_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES agent_projects(id), data TEXT NOT NULL);",
        )
        .unwrap();
    let mut legacy = project();
    legacy.name = "Example".into();
    legacy.path = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\Projects\\Example".into();
    let saved_session = session();
    db.execute(
        "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
        params![legacy.id, serde_json::to_string(&legacy).unwrap()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO agent_sessions(id,project_id,data) VALUES (?1,?2,?3)",
        params![
            saved_session.id,
            saved_session.project_id,
            serde_json::to_string(&saved_session).unwrap()
        ],
    )
    .unwrap();

    migrate_local_wsl_unc_projects(&mut db).unwrap();
    let after_first: String = db
        .query_row(
            "SELECT data FROM agent_projects WHERE id='project'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    migrate_local_wsl_unc_projects(&mut db).unwrap();
    let after_second: String = db
        .query_row(
            "SELECT data FROM agent_projects WHERE id='project'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after_second, after_first);

    let state = AgentSessions::from_connection(db).unwrap();
    let workspace = state.workspace().unwrap();
    assert_eq!(workspace.projects[0].id, "project");
    assert_eq!(workspace.projects[0].path, "/home/user/Projects/Example");
    assert_eq!(
        workspace.projects[0].environment,
        AgentEnvironment {
            kind: "wsl".into(),
            distribution: Some("Ubuntu-24.04".into()),
            ssh: None,
        }
    );
    assert_eq!(workspace.sessions.len(), 1);
    assert_eq!(workspace.sessions[0].project_id, saved_session.project_id);
    assert_eq!(workspace.sessions[0].args, saved_session.args);
}
#[test]
fn local_directories_are_checked_before_database_writes() {
    let root = unique_temp_path("soreno-agent-folders");
    let directory = root.join("Projet exact");
    let other = root.join("Autre");
    let file = root.join("fichier");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::create_dir(&other).unwrap();
    std::fs::write(&file, "x").unwrap();
    assert_eq!(
        validate_local_directory(directory.to_str().unwrap()).unwrap(),
        Some("Projet exact".into())
    );
    #[cfg(unix)]
    {
        let link = root.join("lien");
        std::os::unix::fs::symlink(&directory, &link).unwrap();
        assert_eq!(
            validate_local_directory(link.to_str().unwrap()).unwrap(),
            Some("lien".into())
        );
    }

    let state = memory_state();
    for invalid in [&file, &root.join("absent")] {
        let mut candidate = project();
        candidate.path = invalid.to_str().unwrap().into();
        assert!(state.save_project(candidate).is_err());
        assert!(state.workspace().unwrap().projects.is_empty());
    }
    let mut saved = project();
    saved.path = directory.to_str().unwrap().into();
    state.save_project(saved.clone()).unwrap();
    std::fs::remove_dir(&directory).unwrap();
    saved.name = "Renommé après disparition".into();
    state.save_project(saved.clone()).unwrap();
    assert_eq!(state.workspace().unwrap().projects[0].name, saved.name);

    state.save_session(session()).unwrap();
    assert!(state
        .start("session", 80, 24, None)
        .unwrap_err()
        .contains("n’existe plus"));
    saved.path = other.to_str().unwrap().into();
    assert!(state.save_project(saved).unwrap_err().contains("sessions"));
    assert_eq!(
        state.workspace().unwrap().projects[0].path,
        directory.to_str().unwrap()
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn failed_pre_spawn_restores_linked_conversation_for_a_repaired_folder() {
    let root = unique_temp_path("soreno-agent-launch-rollback");
    let directory = root.join("project");
    let links = root.join("links");
    std::fs::create_dir_all(&directory).unwrap();
    let state = AgentSessions::from_connection_at(
        Connection::open_in_memory().unwrap(),
        links,
        root.join("kanban-images"),
    )
    .unwrap();
    let mut saved_project = project();
    saved_project.path = directory.to_string_lossy().into();
    state.save_project(saved_project.clone()).unwrap();
    let mut saved_session = session();
    saved_session.executable = "pi".into();
    saved_session.args = vec!["--version".into()];
    state.save_session(saved_session.clone()).unwrap();

    let conversation_id = "66666666-6666-4666-8666-666666666666";
    let history = root.join("history.jsonl");
    std::fs::write(
        &history,
        format!(
            "{}\n",
            serde_json::json!({"type": "session", "id": conversation_id})
        ),
    )
    .unwrap();
    {
        let store = lock(&state.store).unwrap();
        conversations::prepare_launch(
            &store.db,
            &store.links_dir,
            &saved_session,
            &saved_project,
            None,
        )
        .unwrap();
        let data = stored_conversation_json(&store.db, &saved_session.id);
        let record: serde_json::Value = serde_json::from_str(&data).unwrap();
        std::fs::write(
            record["metadataPath"].as_str().unwrap(),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "runId": record["runId"],
                "provider": "pi",
                "sessionId": conversation_id,
                "sessionFile": history,
                "name": "Still linked",
                "error": null,
            }))
            .unwrap(),
        )
        .unwrap();
        conversations::reconcile(&store.db, &saved_session, &saved_project, false).unwrap();
    }
    std::fs::remove_dir(&directory).unwrap();
    let before = stored_conversation_json(&lock(&state.store).unwrap().db, &saved_session.id);
    assert!(state
        .start(&saved_session.id, 80, 24, None)
        .unwrap_err()
        .contains("n’existe plus"));
    let after = stored_conversation_json(&lock(&state.store).unwrap().db, &saved_session.id);
    assert_eq!(after, before);
    std::fs::create_dir(&directory).unwrap();

    let staging = {
        let store = lock(&state.store).unwrap();
        attachment_directory(&store.attachment_instance_directory, &saved_session.id)
    };
    std::fs::write(&staging, b"not a directory").unwrap();
    let before = stored_conversation_json(&lock(&state.store).unwrap().db, &saved_session.id);
    assert!(state
        .start(&saved_session.id, 80, 24, None)
        .unwrap_err()
        .contains("Impossible de supprimer les pièces jointes"));
    let after = stored_conversation_json(&lock(&state.store).unwrap().db, &saved_session.id);
    assert_eq!(after, before);
    std::fs::remove_file(staging).unwrap();
    let store = lock(&state.store).unwrap();
    let retry = conversations::prepare_launch(
        &store.db,
        &store.links_dir,
        &saved_session,
        &saved_project,
        None,
    )
    .unwrap();
    assert_eq!(retry.args[..2], ["--session", history.to_str().unwrap()]);
    retry
        .rollback::<()>(&store.db, "retry fixture".into())
        .unwrap_err();
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn picker_defaults_validate_environment_and_use_only_absolute_local_paths() {
    let local = AgentEnvironment {
        kind: "local".into(),
        distribution: None,
        ssh: None,
    };
    assert_eq!(
        project_filesystem_directory(&local, Some("relative")).unwrap(),
        None
    );
    assert_eq!(
        picker_default_directory(&local, Some(std::env::temp_dir().to_str().unwrap())).unwrap(),
        Some(std::env::temp_dir())
    );
    assert!(project_filesystem_directory(&local, Some("bad\0path")).is_err());
    assert!(picker_default_directory(&local, Some("bad\0path")).is_err());
    assert!(resolve_picked_project_directory(&local, PathBuf::from("bad\0path")).is_err());
    assert!(resolve_picked_project_directory(&local, PathBuf::from("x".repeat(4097))).is_err());
    assert!(validate_environment(&AgentEnvironment {
        kind: "local".into(),
        distribution: Some("Ubuntu".into()),
        ssh: None,
    })
    .is_err());
}
#[test]
fn ssh_paths_are_never_mapped_to_the_local_filesystem_or_wsl() {
    let connection = SshConnection {
        host: "example.com".into(),
        user: None,
        port: None,
        identity_file: None,
        host_key: None,
    };
    let environment = AgentEnvironment {
        kind: "ssh".into(),
        distribution: None,
        ssh: Some(connection.clone()),
    };
    validate_environment(&environment).unwrap();
    let path = r"\\wsl.localhost\Ubuntu\home\me";
    assert_eq!(
        normalize_wsl_unc_environment(&environment, path).unwrap(),
        (environment.clone(), path.into())
    );
    assert!(project_filesystem_directory(&environment, Some("/home/me")).is_err());
    assert!(picker_default_directory(&environment, Some("/home/me")).is_err());
    assert!(resolve_picked_project_directory(&environment, PathBuf::from("/home/me")).is_err());

    let invalid_local = AgentEnvironment {
        kind: "local".into(),
        distribution: None,
        ssh: Some(connection),
    };
    assert!(validate_environment(&invalid_local).is_err());
    assert!(normalize_wsl_unc_environment(&invalid_local, path).is_err());
    assert!(validate_environment(&AgentEnvironment {
        kind: "ssh".into(),
        distribution: Some("Ubuntu".into()),
        ssh: environment.ssh,
    })
    .is_err());
}

#[cfg(windows)]
#[test]
fn project_filesystem_mapping_does_not_probe_wsl_but_picker_does() {
    let environment = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some("Soreno-Definitely-Missing".into()),
        ssh: None,
    };
    assert_eq!(
        project_filesystem_directory(&environment, Some("/home/me")).unwrap(),
        Some(PathBuf::from(
            "\\\\wsl.localhost\\Soreno-Definitely-Missing\\home\\me"
        ))
    );
    assert!(picker_default_directory(&environment, Some("/home/me")).is_err());
}
#[test]
fn wsl_picker_defaults_to_distribution_root() {
    let root = PathBuf::from("\\\\wsl.localhost\\Ubuntu-24.04\\");
    for current in [None, Some(""), Some("relative")] {
        assert_eq!(wsl_picker_directory("Ubuntu-24.04", current), root);
    }
    assert_eq!(
        wsl_picker_directory("Ubuntu-24.04", Some("/home/Moi")),
        PathBuf::from("\\\\wsl.localhost\\Ubuntu-24.04\\home\\Moi")
    );
}
#[test]
fn wsl_unc_normalization_handles_windows_variants_literally() {
    let local = AgentEnvironment {
        kind: "local".into(),
        distribution: None,
        ssh: None,
    };
    for (selected, distribution, path) in [
        (
            "\\\\WSL.LOCALHOST\\ubuntu-24.04\\home\\Moi\\a b\\été's",
            "ubuntu-24.04",
            "/home/Moi/a b/été's",
        ),
        ("\\\\wsl$\\Ubuntu-24.04\\tmp\\a", "Ubuntu-24.04", "/tmp/a"),
        ("//Wsl.LocalHost/Ubuntu/home/me", "Ubuntu", "/home/me"),
        (
            "\\\\?\\uNc\\WsL$\\Ubuntu-24.04\\home\\a b",
            "Ubuntu-24.04",
            "/home/a b",
        ),
    ] {
        let normalized = normalize_wsl_unc_environment(&local, selected).unwrap();
        assert_eq!(normalized.0.kind, "wsl");
        assert_eq!(normalized.0.distribution.as_deref(), Some(distribution));
        assert_eq!(normalized.1, path);
    }
    for unchanged in ["C:\\Projects\\App", "\\\\server\\share\\App"] {
        assert_eq!(
            normalize_wsl_unc_environment(&local, unchanged).unwrap(),
            (local.clone(), unchanged.into())
        );
    }
    assert_eq!(
        posix_directory_name("/home/a b/été's\\dossier"),
        Some("été's\\dossier".into())
    );
}
#[test]
fn explicit_wsl_unc_requires_the_selected_distribution() {
    let environment = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some("Ubuntu-24.04".into()),
        ssh: None,
    };
    assert_eq!(
        normalize_wsl_unc_environment(&environment, "\\\\wsl.localhost\\ubuntu-24.04\\home\\me")
            .unwrap(),
        (environment.clone(), "/home/me".into())
    );
    assert!(
        normalize_wsl_unc_environment(&environment, "\\\\wsl$\\Debian\\tmp")
            .unwrap_err()
            .contains("bonne distribution")
    );
    assert!(normalize_wsl_unc_environment(
        &AgentEnvironment {
            kind: "local".into(),
            distribution: Some("Ubuntu".into()),
            ssh: None,
        },
        "C:\\Projects"
    )
    .is_err());
    assert!(normalize_wsl_unc_environment(&environment, "\\\\wsl$\\\\tmp").is_err());
}
#[test]
fn wsl_path_output_requires_clean_absolute_utf8() {
    assert_eq!(
        parse_wsl_path_output(b"/home/me/a b  \n".to_vec()).unwrap(),
        "/home/me/a b  "
    );
    assert_eq!(
        parse_wsl_path_output(b"/home/name\n\n".to_vec()).unwrap(),
        "/home/name\n"
    );
    for output in [
        Vec::new(),
        b"relative\n".to_vec(),
        b"/bad\0path\n".to_vec(),
        vec![0xff],
    ] {
        assert!(parse_wsl_path_output(output).is_err());
    }
}
#[cfg(not(windows))]
#[test]
fn wsl_directory_selection_is_rejected_outside_windows() {
    let environment = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some("Ubuntu-24.04".into()),
        ssh: None,
    };
    assert!(validate_project_directory(&environment, "/tmp")
        .unwrap_err()
        .contains("uniquement sous Windows"));
}
