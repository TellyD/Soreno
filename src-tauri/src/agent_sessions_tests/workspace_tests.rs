use super::*;

fn icon_data_url() -> String {
    format!(
        "{PNG_DATA_URL_PREFIX}{}",
        STANDARD.encode(include_bytes!("../../icons/64x64.png"))
    )
}
pub(super) fn run_git(path: &Path, args: &[&str]) -> String {
    let mut command = std::process::Command::new("git");
    command.args(["-C", path.to_str().unwrap()]).args(args);
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
    ] {
        command.env_remove(name);
    }
    crate::project_git::test_fixtures::successful_stdout(command.output().unwrap(), args)
}
#[test]
fn legacy_sessions_default_to_terminal_without_service_metadata() {
    let legacy = serde_json::json!({
        "id": "legacy",
        "projectId": "project",
        "name": "Legacy",
        "executable": "sh",
        "args": [],
        "createdAt": "2026-01-01T00:00:00Z"
    });
    let session: AgentSession = serde_json::from_value(legacy).unwrap();
    assert_eq!(session.kind, "terminal");
    assert_eq!(session.service_id, None);
    assert_eq!(session.working_directory, None);
    let serialized = serde_json::to_value(session).unwrap();
    assert_eq!(serialized["kind"], "terminal");
    assert!(serialized.get("serviceId").is_some());
    assert!(serialized.get("workingDirectory").is_some());
}
#[test]
fn opening_removes_retired_chat_sessions() {
    let root = unique_temp_path("soreno-retired-chat");
    {
        let state = AgentSessions::open(&root).unwrap();
        insert_project(&state, &project());
        let chat = AgentSession {
            id: "chat".into(),
            kind: "chat".into(),
            executable: "soreno-chat".into(),
            args: Vec::new(),
            ..session()
        };
        let store = lock(&state.store).unwrap();
        for session in [session(), chat] {
            store
                .db
                .execute(
                    "INSERT INTO agent_sessions(id,project_id,data) VALUES (?1,?2,?3)",
                    params![
                        session.id,
                        session.project_id,
                        serde_json::to_string(&session).unwrap()
                    ],
                )
                .unwrap();
        }
        store
            .db
            .execute_batch(
                "CREATE TABLE agent_chat_conversations (session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
                INSERT INTO agent_chat_conversations(session_id,data) VALUES ('chat','{}');",
            )
            .unwrap();
    }
    {
        let state = AgentSessions::open(&root).unwrap();
        let store = lock(&state.store).unwrap();
        let sessions: Vec<AgentSession> = list(&store.db, "agent_sessions").unwrap();
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["session"]
        );
        let chat_table: bool = store
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='agent_chat_conversations')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!chat_table);
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn service_metadata_is_validated_and_persisted() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    let mut service = session();
    service.kind = "service".into();
    service.service_id = Some("web".into());
    service.working_directory = Some(project().path);
    service.executable = "pi".into();
    service.args.clear();
    state.save_session(service.clone()).unwrap();

    let workspace = state.workspace().unwrap();
    assert_eq!(workspace.sessions[0].kind, "service");
    assert_eq!(workspace.sessions[0].service_id.as_deref(), Some("web"));
    assert_eq!(
        workspace.sessions[0].working_directory,
        service.working_directory
    );
    assert_eq!(workspace.statuses[0].resume, "unsupported");
    assert!(workspace.statuses[0].conversation.is_none());

    let mut invalid = service.clone();
    invalid.kind = "terminal".into();
    assert!(validate_session(&invalid).is_err());
    invalid = service.clone();
    invalid.service_id = None;
    assert!(validate_session(&invalid).is_err());
    invalid = service;
    invalid.working_directory = None;
    assert!(validate_session(&invalid).is_err());
}

#[cfg(unix)]
#[test]
fn active_sessions_are_not_artificially_capped() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    for index in 0..13 {
        let mut active = session();
        active.id = format!("session-{index}");
        active.args = vec!["-c".into(), "trap '' HUP; sleep 60".into()];
        state.save_session(active.clone()).unwrap();
        state.start(&active.id, 80, 24, None).unwrap();
    }
    assert_eq!(
        state
            .statuses()
            .unwrap()
            .into_iter()
            .filter(|status| status.state == "running")
            .count(),
        13
    );
    state.shutdown();
}

#[test]
fn default_shell_validation_and_commands_are_explicit() {
    let mut terminal = session();
    terminal.executable.clear();
    terminal.args.clear();
    validate_session(&terminal).unwrap();
    assert_eq!(
        posix_command(&terminal),
        "printf '\\033[H\\033[2J\\033[3J'; exec \"${SHELL:-/bin/bash}\" -il"
    );

    terminal.args.push("--unexpected".into());
    assert!(validate_session(&terminal).is_err());
    terminal.args.clear();
    terminal.executable = " ".into();
    assert!(validate_session(&terminal).is_err());

    terminal.executable.clear();
    let command = windows_command(&terminal).unwrap();
    assert_eq!(
        command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        ["powershell.exe", "-NoLogo"]
    );

    terminal.executable = "tool.exe".into();
    let command = windows_command(&terminal).unwrap();
    let argv = command.get_argv();
    assert_eq!(argv[0], "powershell.exe");
    assert_eq!(argv[1], "-NoLogo");
    assert_eq!(argv[2], "-EncodedCommand");
    assert!(!argv[3].is_empty());
}

#[test]
fn branches_follow_real_git_repositories_without_failing_non_repositories() {
    let root = unique_temp_path("soreno-agent-branches");
    let repository = root.join("repo");
    let worktree = root.join("linked worktree;literal");
    let plain = root.join("plain");
    std::fs::create_dir_all(&repository).unwrap();
    std::fs::create_dir(&plain).unwrap();
    run_git(&repository, &["init"]);
    run_git(&repository, &["branch", "-m", "initial"]);

    let state = memory_state();
    let mut saved = project();
    saved.path = repository.to_string_lossy().into();
    state.save_project(saved).unwrap();
    assert_eq!(
        state.branches().unwrap()[0].branch.as_deref(),
        Some("initial")
    );

    run_git(&repository, &["branch", "-m", "changed"]);
    assert_eq!(
        state.branches().unwrap()[0].branch.as_deref(),
        Some("changed")
    );
    std::fs::write(repository.join("tracked"), "content").unwrap();
    run_git(&repository, &["add", "tracked"]);
    run_git(
        &repository,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "initial",
        ],
    );
    let sha = run_git(&repository, &["rev-parse", "--short", "HEAD"]);
    run_git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "linked-branch",
            worktree.to_str().unwrap(),
            "HEAD",
        ],
    );
    let subdirectory = worktree.join("nested folder");
    std::fs::create_dir(&subdirectory).unwrap();
    run_git(&repository, &["checkout", "--detach", "HEAD"]);

    let mut linked = project();
    linked.id = "linked".into();
    linked.path = subdirectory.to_string_lossy().into();
    state.save_project(linked).unwrap();
    let mut no_repository = project();
    no_repository.id = "plain".into();
    no_repository.path = plain.to_string_lossy().into();
    state.save_project(no_repository).unwrap();
    assert_eq!(
        state.branches().unwrap(),
        [
            AgentProjectBranch {
                project_id: "project".into(),
                branch: Some(format!("HEAD @ {sha}")),
            },
            AgentProjectBranch {
                project_id: "linked".into(),
                branch: Some("linked-branch".into()),
            },
            AgentProjectBranch {
                project_id: "plain".into(),
                branch: None,
            },
        ]
    );
    assert_eq!(
        state
            .service_branches(
                "project",
                vec![
                    AgentServiceDirectory {
                        service_id: "api".into(),
                        cwd: subdirectory.to_string_lossy().into(),
                    },
                    AgentServiceDirectory {
                        service_id: "website".into(),
                        cwd: plain.to_string_lossy().into(),
                    },
                ],
            )
            .unwrap(),
        [
            AgentServiceBranch {
                service_id: "api".into(),
                branch: Some("linked-branch".into()),
            },
            AgentServiceBranch {
                service_id: "website".into(),
                branch: None,
            },
        ]
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn groups_saved_projects_with_registered_and_unregistered_worktrees() {
    let root = unique_temp_path("soreno-agent-worktrees");
    let repository = root.join("repo");
    let registered = root.join("registered worktree");
    let unregistered = root.join("unregistered worktree");
    let plain = root.join("plain");
    std::fs::create_dir_all(&repository).unwrap();
    std::fs::create_dir(&plain).unwrap();
    run_git(&repository, &["init"]);
    std::fs::write(repository.join("tracked"), "content").unwrap();
    run_git(&repository, &["add", "tracked"]);
    run_git(
        &repository,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "initial",
        ],
    );
    run_git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "registered",
            registered.to_str().unwrap(),
            "HEAD",
        ],
    );
    run_git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "unregistered",
            unregistered.to_str().unwrap(),
            "HEAD",
        ],
    );

    let state = memory_state();
    let mut primary_project = project();
    primary_project.path = repository.to_string_lossy().into();
    state.save_project(primary_project.clone()).unwrap();
    let mut registered_project = project();
    registered_project.id = "registered".into();
    registered_project.path = registered.to_string_lossy().into();
    state.save_project(registered_project).unwrap();
    let mut plain_project = project();
    plain_project.id = "plain".into();
    plain_project.path = plain.to_string_lossy().into();
    state.save_project(plain_project).unwrap();

    let snapshot = state.worktree_groups().unwrap();
    assert!(snapshot.complete);
    assert_eq!(snapshot.groups.len(), 1);
    let group = &snapshot.groups[0];
    assert_eq!(group.repository_project_id, "project");
    assert_eq!(group.project_ids, ["project", "registered"]);
    assert_eq!(group.worktrees.len(), 3);
    assert!(same_worktree_path(
        &primary_project.environment,
        &group.worktrees[0].path,
        repository.to_str().unwrap()
    ));
    assert_eq!(group.worktrees[0].project_ids, ["project"]);
    let registered_worktree = group
        .worktrees
        .iter()
        .find(|worktree| {
            same_worktree_path(
                &primary_project.environment,
                &worktree.path,
                registered.to_str().unwrap(),
            )
        })
        .unwrap();
    assert_eq!(registered_worktree.project_ids, ["registered"]);
    let unregistered_worktree = group
        .worktrees
        .iter()
        .find(|worktree| {
            same_worktree_path(
                &primary_project.environment,
                &worktree.path,
                unregistered.to_str().unwrap(),
            )
        })
        .unwrap();
    assert!(unregistered_worktree.project_ids.is_empty());

    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn project_of_a_deleted_worktree_leaves_the_snapshot_complete_and_ungrouped() {
    let root = unique_temp_path("soreno-agent-deleted-worktree");
    let repository = root.join("repo");
    let deleted = root.join("deleted worktree");
    std::fs::create_dir_all(&repository).unwrap();
    run_git(&repository, &["init"]);
    std::fs::write(repository.join("tracked"), "content").unwrap();
    run_git(&repository, &["add", "tracked"]);
    run_git(
        &repository,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "initial",
        ],
    );
    run_git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "deleted",
            deleted.to_str().unwrap(),
            "HEAD",
        ],
    );

    let state = memory_state();
    let mut primary_project = project();
    primary_project.path = repository.to_string_lossy().into();
    state.save_project(primary_project).unwrap();
    let mut deleted_project = project();
    deleted_project.id = "deleted".into();
    deleted_project.path = deleted.to_string_lossy().into();
    state.save_project(deleted_project).unwrap();
    run_git(
        &repository,
        &["worktree", "remove", deleted.to_str().unwrap()],
    );

    let snapshot = state.worktree_groups().unwrap();
    assert!(snapshot.complete);
    assert_eq!(snapshot.missing_project_ids, ["deleted"]);
    assert_eq!(snapshot.groups.len(), 1);
    assert_eq!(snapshot.groups[0].project_ids, ["project"]);
    assert_eq!(snapshot.groups[0].worktrees.len(), 1);

    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn worktree_environment_matching_is_semantic() {
    let wsl = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some("Ubuntu-24.04".into()),
        ssh: None,
    };
    let mut differently_cased = wsl.clone();
    differently_cased.distribution = Some("ubuntu-24.04".into());
    assert!(same_agent_environment(&wsl, &differently_cased));
    differently_cased.distribution = Some("Debian".into());
    assert!(!same_agent_environment(&wsl, &differently_cased));

    let ssh = ssh_project("first").environment;
    let mut rotated_key = ssh.clone();
    let connection = rotated_key.ssh.as_mut().unwrap();
    connection.identity_file = Some("/tmp/rotated-key".into());
    connection.host_key = Some("rotated-host-key".into());
    assert!(same_agent_environment(&ssh, &rotated_key));

    for changed in [
        |connection: &mut SshConnection| connection.host = connection.host.to_ascii_uppercase(),
        |connection: &mut SshConnection| connection.host.push('.'),
        |connection: &mut SshConnection| connection.port = None,
        |connection: &mut SshConnection| connection.host = "other.invalid".into(),
        |connection: &mut SshConnection| connection.user = Some("bob".into()),
        |connection: &mut SshConnection| connection.port = Some(2222),
    ] {
        let mut other = ssh.clone();
        changed(other.ssh.as_mut().unwrap());
        assert!(!same_agent_environment(&ssh, &other));
    }
}
#[test]
fn disconnected_ssh_project_with_trailing_slash_is_associated_and_removed() {
    let primary = ssh_project("primary");
    let mut linked = primary.clone();
    linked.id = "linked".into();
    linked.path = "/srv/project-linked/".into();
    let projects = vec![primary.clone(), linked];
    let group = DiscoveredWorktreeGroup {
        environment: primary.environment,
        common_dir: "/srv/project.git".into(),
        members: vec![DiscoveredWorktreeMember {
            project_index: 0,
            root: "/srv/project".into(),
        }],
    };
    let assembled = assemble_worktree_group(
        &projects,
        &HashSet::from([0]),
        &HashSet::from([1]),
        &group,
        vec![
            crate::project_git::GitWorktree {
                path: "/srv/project".into(),
                head: "0123456789012345678901234567890123456789".into(),
                branch: Some("main".into()),
            },
            crate::project_git::GitWorktree {
                path: "/srv/project-linked".into(),
                head: "0123456789012345678901234567890123456789".into(),
                branch: Some("linked".into()),
            },
        ],
    );
    assert_eq!(assembled.project_ids, ["primary", "linked"]);
    assert_eq!(assembled.worktrees[0].project_ids, ["primary"]);
    assert_eq!(assembled.worktrees[1].project_ids, ["linked"]);

    let state = memory_state();
    for project in &projects {
        insert_project(&state, project);
    }
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "INSERT INTO agent_disconnected_projects(project_id) VALUES ('linked')",
            [],
        )
        .unwrap();
    let lease = state.begin_git_operation("primary").unwrap();
    let stopped = lease
        .stop_project_sessions(&assembled.worktrees[1].project_ids)
        .unwrap();
    lease
        .delete_projects(stopped, SessionEnd::Worktree)
        .unwrap();
    assert_eq!(
        state
            .workspace()
            .unwrap()
            .projects
            .into_iter()
            .map(|project| project.id)
            .collect::<Vec<_>>(),
        ["primary"]
    );
}
#[test]
fn worktree_snapshot_is_partial_for_an_indeterminate_disconnected_alias() {
    let state = memory_state();
    let primary = ssh_project("primary");
    let mut alias = primary.clone();
    alias.id = "alias".into();
    alias.path = "/srv/project-linked/nested/".into();
    insert_project(&state, &primary);
    insert_project(&state, &alias);
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "INSERT INTO agent_disconnected_projects(project_id) VALUES ('alias')",
            [],
        )
        .unwrap();

    let snapshot = state
        .worktree_groups_with(
            |project| Ok(Some((project.path.clone(), "/srv/project/.git".into()))),
            |_| {
                Ok(vec![
                    crate::project_git::GitWorktree {
                        path: "/srv/project".into(),
                        head: "0123456789012345678901234567890123456789".into(),
                        branch: Some("main".into()),
                    },
                    crate::project_git::GitWorktree {
                        path: "/srv/project-linked".into(),
                        head: "0123456789012345678901234567890123456789".into(),
                        branch: Some("linked".into()),
                    },
                ])
            },
        )
        .unwrap();

    assert!(!snapshot.complete);
    assert_eq!(snapshot.groups.len(), 1);
    assert!(snapshot.groups[0].worktrees[1].project_ids.is_empty());
}
#[test]
fn disconnected_project_on_another_ssh_target_does_not_make_snapshot_partial() {
    let state = memory_state();
    let primary = ssh_project("primary");
    let mut elsewhere = ssh_project("elsewhere");
    elsewhere.path = "/srv/project-linked/nested".into();
    insert_project(&state, &primary);
    insert_project(&state, &elsewhere);
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "INSERT INTO agent_disconnected_projects(project_id) VALUES ('elsewhere')",
            [],
        )
        .unwrap();

    let snapshot = state
        .worktree_groups_with(
            |project| Ok(Some((project.path.clone(), "/srv/project/.git".into()))),
            |_| {
                Ok(vec![
                    crate::project_git::GitWorktree {
                        path: "/srv/project".into(),
                        head: "0123456789012345678901234567890123456789".into(),
                        branch: Some("main".into()),
                    },
                    crate::project_git::GitWorktree {
                        path: "/srv/project-linked".into(),
                        head: "0123456789012345678901234567890123456789".into(),
                        branch: Some("linked".into()),
                    },
                ])
            },
        )
        .unwrap();

    assert!(snapshot.complete);
    assert_eq!(snapshot.groups.len(), 1);
    assert_eq!(snapshot.groups[0].project_ids, ["primary"]);
}
#[test]
fn discovered_git_identity_prevents_cross_repository_path_fallback() {
    let state = memory_state();
    let primary = ssh_project("primary");
    let mut moved = primary.clone();
    moved.id = "moved".into();
    moved.path = "/srv/project-linked".into();
    insert_project(&state, &primary);
    insert_project(&state, &moved);

    let snapshot = state
        .worktree_groups_with(
            |project| match project.id.as_str() {
                "primary" => Ok(Some(("/srv/project".into(), "/srv/project/.git".into()))),
                "moved" => Ok(Some((
                    "/srv/new-repository".into(),
                    "/srv/new-repository/.git".into(),
                ))),
                _ => unreachable!(),
            },
            |project| {
                let path = if project.id == "primary" {
                    "/srv/project"
                } else {
                    "/srv/new-repository"
                };
                let mut worktrees = vec![crate::project_git::GitWorktree {
                    path: path.into(),
                    head: "0123456789012345678901234567890123456789".into(),
                    branch: Some("main".into()),
                }];
                if project.id == "primary" {
                    worktrees.push(crate::project_git::GitWorktree {
                        path: "/srv/project-linked".into(),
                        head: "0123456789012345678901234567890123456789".into(),
                        branch: Some("linked".into()),
                    });
                }
                Ok(worktrees)
            },
        )
        .unwrap();

    assert!(snapshot.complete);
    assert_eq!(snapshot.groups.len(), 2);
    let primary_group = snapshot
        .groups
        .iter()
        .find(|group| group.repository_project_id == "primary")
        .unwrap();
    assert_eq!(primary_group.project_ids, ["primary"]);
    assert!(primary_group.worktrees[1].project_ids.is_empty());
    let moved_group = snapshot
        .groups
        .iter()
        .find(|group| group.repository_project_id == "moved")
        .unwrap();
    assert_eq!(moved_group.project_ids, ["moved"]);
}
#[test]
fn worktree_group_uses_connected_secondary_when_primary_disconnects() {
    let root = unique_temp_path("soreno-agent-worktree-recheck");
    let state = memory_state();
    for id in ["first", "second", "third"] {
        let path = root.join(id);
        std::fs::create_dir_all(&path).unwrap();
        let mut saved = project();
        saved.id = id.into();
        saved.path = path.to_string_lossy().into();
        insert_project(&state, &saved);
    }
    let discovered = std::cell::RefCell::new(Vec::new());
    let listing_source = std::cell::RefCell::new(Vec::new());
    let groups = state
        .worktree_groups_with(
            |project| {
                discovered.borrow_mut().push(project.id.clone());
                let disconnect = match project.id.as_str() {
                    "first" => Some("third"),
                    "second" => Some("first"),
                    _ => None,
                };
                if let Some(project_id) = disconnect {
                    lock(&state.store)
                        .unwrap()
                        .db
                        .execute(
                            "INSERT INTO agent_disconnected_projects(project_id) VALUES (?1)",
                            [project_id],
                        )
                        .unwrap();
                }
                Ok(Some((project.path.clone(), "common".into())))
            },
            |project| {
                listing_source.borrow_mut().push(project.id.clone());
                Ok(vec![
                    crate::project_git::GitWorktree {
                        path: root.join("first").to_string_lossy().into(),
                        head: "0123456789012345678901234567890123456789".into(),
                        branch: Some("main".into()),
                    },
                    crate::project_git::GitWorktree {
                        path: root.join("second").to_string_lossy().into(),
                        head: "0123456789012345678901234567890123456789".into(),
                        branch: Some("second".into()),
                    },
                ])
            },
        )
        .unwrap();
    assert_eq!(&*discovered.borrow(), &["first", "second"]);
    assert_eq!(&*listing_source.borrow(), &["second"]);
    assert!(groups.complete);
    assert_eq!(groups.groups.len(), 1);
    assert_eq!(groups.groups[0].repository_project_id, "second");
    assert_eq!(groups.groups[0].project_ids, ["first", "second"]);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn worktree_discovery_result_is_ignored_when_project_disconnects_during_probe() {
    let state = memory_state();
    let remote = ssh_project("remote");
    insert_project(&state, &remote);
    let listed = std::cell::Cell::new(false);

    let snapshot = state
        .worktree_groups_with(
            |project| {
                disconnect_project(&state, &project.id).unwrap();
                Ok(Some((project.path.clone(), "/srv/project/.git".into())))
            },
            |_| {
                listed.set(true);
                Ok(Vec::new())
            },
        )
        .unwrap();

    assert!(snapshot.groups.is_empty());
    assert!(!listed.get());
}
#[test]
fn worktree_listing_result_is_ignored_when_source_disconnects_during_probe() {
    let state = memory_state();
    let remote = ssh_project("remote");
    insert_project(&state, &remote);

    let snapshot = state
        .worktree_groups_with(
            |project| Ok(Some((project.path.clone(), "/srv/project/.git".into()))),
            |project| {
                disconnect_project(&state, &project.id).unwrap();
                Ok(vec![crate::project_git::GitWorktree {
                    path: project.path.clone(),
                    head: "0123456789012345678901234567890123456789".into(),
                    branch: Some("main".into()),
                }])
            },
        )
        .unwrap();

    assert!(!snapshot.complete);
    assert!(snapshot.groups.is_empty());
}
#[test]
fn worktree_snapshot_keeps_successful_groups_and_marks_probe_failures_partial() {
    let root = unique_temp_path("soreno-agent-worktree-partial");
    let state = memory_state();
    for id in ["healthy", "plain", "discovery-failure", "listing-failure"] {
        let path = root.join(id);
        std::fs::create_dir_all(&path).unwrap();
        let mut saved = project();
        saved.id = id.into();
        saved.path = path.to_string_lossy().into();
        insert_project(&state, &saved);
    }

    let snapshot = state
        .worktree_groups_with(
            |project| match project.id.as_str() {
                "healthy" => Ok(Some((project.path.clone(), "healthy-common".into()))),
                "plain" => Ok(None),
                "discovery-failure" => Err(WorktreeDiscoveryFailure::Unknown),
                "listing-failure" => Ok(Some((project.path.clone(), "broken-common".into()))),
                _ => unreachable!(),
            },
            |project| {
                if project.id == "listing-failure" {
                    Err(())
                } else {
                    Ok(vec![crate::project_git::GitWorktree {
                        path: project.path.clone(),
                        head: "0123456789012345678901234567890123456789".into(),
                        branch: Some("main".into()),
                    }])
                }
            },
        )
        .unwrap();

    assert!(!snapshot.complete);
    assert_eq!(snapshot.groups.len(), 1);
    assert_eq!(snapshot.groups[0].repository_project_id, "healthy");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn wsl_git_command_keeps_literal_arguments_and_removes_git_overrides() {
    let project = AgentProject {
        id: "project".into(),
        name: "Projet".into(),
        path: "/home/me/a b;$(touch nope)".into(),
        environment: AgentEnvironment {
            kind: "wsl".into(),
            distribution: Some("Ubuntu Test & literal".into()),
            ssh: None,
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };
    let command =
        crate::project_git::git_command(&project, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .unwrap();
    assert_eq!(command.get_program(), "wsl.exe");
    let args = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        &args[..4],
        ["--distribution", "Ubuntu Test & literal", "--exec", "env"]
    );
    assert!(args
        .windows(2)
        .any(|args| args == ["-u", "GIT_CONFIG_PARAMETERS"]));
    for assignment in [
        "LC_ALL=C",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_EDITOR=true",
        "GIT_ALLOW_PROTOCOL=https:ssh:file",
    ] {
        assert!(args.iter().any(|arg| arg == assignment));
    }
    for forbidden in [
        "core.hooksPath=",
        "commit.gpgSign=false",
        "tag.gpgSign=false",
        "merge.gpgSign=false",
    ] {
        assert!(!args.iter().any(|arg| arg == forbidden));
    }
    assert_eq!(
        &args[args.len() - 6..],
        [
            "-C",
            "/home/me/a b;$(touch nope)",
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD",
        ]
    );
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
    ] {
        assert!(command
            .get_envs()
            .any(|(key, value)| key == name && value.is_none()));
    }
}
#[test]
fn project_icon_is_backward_compatible_in_json() {
    let json = serde_json::json!({
        "id": "project",
        "name": "Projet",
        "path": std::env::temp_dir(),
        "environment": { "kind": "local", "distribution": null }
    });
    let project: AgentProject = serde_json::from_value(json).unwrap();
    assert_eq!(project.icon_data_url, None);
    assert!(serde_json::to_value(project)
        .unwrap()
        .get("iconDataUrl")
        .is_none());
}

#[test]
fn project_icon_can_be_saved_reloaded_and_removed_with_existing_sessions() {
    let dir = unique_temp_path("soreno-project-icon");
    let mut saved = project();
    saved.icon_data_url = Some(icon_data_url());
    saved.icon = Some("rocket".into());
    saved.color = Some("#37a3a5".into());
    {
        let state = AgentSessions::open(&dir).unwrap();
        state.save_project(saved.clone()).unwrap();
        state.save_session(session()).unwrap();
    }
    {
        let state = AgentSessions::open(&dir).unwrap();
        let reloaded = state.project(&saved.id).unwrap();
        assert_eq!(reloaded.icon_data_url, saved.icon_data_url);
        assert_eq!(reloaded.icon, saved.icon);
        assert_eq!(reloaded.color, saved.color);
        saved.icon_data_url = None;
        saved.icon = None;
        saved.color = None;
        state.save_project(saved.clone()).unwrap();
    }
    {
        let state = AgentSessions::open(&dir).unwrap();
        let workspace = state.workspace().unwrap();
        assert_eq!(workspace.projects[0].icon_data_url, None);
        assert_eq!(workspace.projects[0].icon, None);
        assert_eq!(workspace.projects[0].color, None);
        assert_eq!(workspace.projects[0].path, saved.path);
        assert_eq!(workspace.sessions.len(), 1);
        assert_eq!(workspace.sessions[0].project_id, saved.id);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn invalid_project_icons_do_not_overwrite_the_saved_icon() {
    let state = memory_state();
    let mut saved = project();
    saved.icon_data_url = Some(icon_data_url());
    saved.icon = Some("rocket".into());
    saved.color = Some("#37a3a5".into());
    state.save_project(saved.clone()).unwrap();

    let valid_png = STANDARD
        .decode(icon_data_url().strip_prefix(PNG_DATA_URL_PREFIX).unwrap())
        .unwrap();
    let mut bad_signature = valid_png.clone();
    bad_signature[0] = 0;
    let mut bad_ihdr = valid_png.clone();
    bad_ihdr[12] = b'X';
    let mut zero_width = valid_png.clone();
    zero_width[16..20].copy_from_slice(&0_u32.to_be_bytes());
    let mut too_wide = valid_png;
    too_wide[16..20].copy_from_slice(&65_u32.to_be_bytes());
    let invalid = [
        "data:image/jpeg;base64,AA==".into(),
        format!("{PNG_DATA_URL_PREFIX}%%%"),
        format!("{PNG_DATA_URL_PREFIX}{}", STANDARD.encode(bad_signature)),
        format!("{PNG_DATA_URL_PREFIX}{}", STANDARD.encode(bad_ihdr)),
        format!("{PNG_DATA_URL_PREFIX}{}", STANDARD.encode(zero_width)),
        format!("{PNG_DATA_URL_PREFIX}{}", STANDARD.encode(too_wide)),
        format!(
            "{PNG_DATA_URL_PREFIX}{}",
            "A".repeat(PROJECT_ICON_DATA_URL_LIMIT)
        ),
    ];
    for icon in invalid {
        let mut update = saved.clone();
        update.icon_data_url = Some(icon);
        assert!(state.save_project(update).is_err());
        assert_eq!(
            state.project(&saved.id).unwrap().icon_data_url,
            saved.icon_data_url
        );
    }
    for (icon, color) in [
        ("", "#37a3a5"),
        ("Rocket", "#37a3a5"),
        ("../rocket", "#37a3a5"),
        ("rocket", "37a3a5"),
        ("rocket", "#37a3a"),
        ("rocket", "#37a3ag"),
        ("rocket", "red"),
    ] {
        let mut update = saved.clone();
        update.icon = Some(icon.into());
        update.color = Some(color.into());
        assert!(state.save_project(update).is_err());
        let stored = state.project(&saved.id).unwrap();
        assert_eq!(
            (stored.icon, stored.color),
            (saved.icon.clone(), saved.color.clone())
        );
    }
}

fn appearance_change(json: serde_json::Value) -> AgentProjectAppearanceChange {
    serde_json::from_value(json).unwrap()
}
fn appearance(project: &AgentProject) -> (Option<String>, Option<String>, Option<String>) {
    (
        project.icon.clone(),
        project.color.clone(),
        project.icon_data_url.clone(),
    )
}

#[test]
fn project_appearance_change_keeps_absent_fields_clears_null_and_sets_strings() {
    let state = memory_state();
    let mut saved = project();
    saved.icon = Some("rocket".into());
    saved.color = Some("#37a3a5".into());
    saved.icon_data_url = Some(icon_data_url());
    state.save_project(saved.clone()).unwrap();

    let unchanged = state
        .update_project_appearance(&saved.id, appearance_change(serde_json::json!({})))
        .unwrap();
    assert_eq!(appearance(&unchanged), appearance(&saved));

    let updated = state
        .update_project_appearance(
            &saved.id,
            appearance_change(serde_json::json!({ "icon": "star", "iconDataUrl": null })),
        )
        .unwrap();
    assert_eq!(
        appearance(&updated),
        (Some("star".into()), saved.color.clone(), None)
    );
    assert_eq!(
        serde_json::to_value(&updated).unwrap(),
        serde_json::to_value(state.project(&saved.id).unwrap()).unwrap()
    );

    let cleared = state
        .update_project_appearance(
            &saved.id,
            appearance_change(serde_json::json!({ "color": null })),
        )
        .unwrap();
    assert_eq!(appearance(&cleared), (Some("star".into()), None, None));
    assert_eq!(
        appearance(&state.project(&saved.id).unwrap()),
        appearance(&cleared)
    );
    assert!(serde_json::from_value::<AgentProjectAppearanceChange>(
        serde_json::json!({ "name": "Autre" })
    )
    .is_err());
}

#[test]
fn invalid_project_appearance_change_leaves_the_stored_project_untouched() {
    let state = memory_state();
    let mut saved = project();
    saved.icon = Some("rocket".into());
    saved.color = Some("#37a3a5".into());
    state.save_project(saved.clone()).unwrap();
    for change in [
        serde_json::json!({ "icon": "Rocket" }),
        serde_json::json!({ "icon": "" }),
        serde_json::json!({ "color": "#37a3a" }),
        serde_json::json!({ "color": "red", "icon": "star" }),
        serde_json::json!({ "iconDataUrl": "data:image/png;base64,AAAA" }),
    ] {
        assert!(state
            .update_project_appearance(&saved.id, appearance_change(change))
            .is_err());
        assert_eq!(
            appearance(&state.project(&saved.id).unwrap()),
            appearance(&saved)
        );
    }
    assert_eq!(
        state
            .update_project_appearance("missing", AgentProjectAppearanceChange::default())
            .unwrap_err(),
        "Projet introuvable."
    );
}

#[test]
fn project_appearance_change_does_not_overwrite_a_newer_full_save() {
    let state = memory_state();
    let saved = project();
    state.save_project(saved.clone()).unwrap();
    let mut renamed = saved.clone();
    renamed.name = "Projet renommé".into();
    state.save_project(renamed.clone()).unwrap();

    let updated = state
        .update_project_appearance(
            &saved.id,
            appearance_change(serde_json::json!({ "icon": "star", "color": "#112233" })),
        )
        .unwrap();
    let stored = state.project(&saved.id).unwrap();
    assert_eq!(
        (stored.name.as_str(), stored.path.as_str()),
        (renamed.name.as_str(), renamed.path.as_str())
    );
    assert_eq!(
        appearance(&stored),
        (Some("star".into()), Some("#112233".into()), None)
    );
    assert_eq!(
        serde_json::to_value(&updated).unwrap(),
        serde_json::to_value(&stored).unwrap()
    );
}

#[test]
fn sqlite_crud_reload_and_validation() {
    let dir = unique_temp_path("soreno-agents");
    {
        let state = AgentSessions::open(&dir).unwrap();
        assert!(state.save_session(session()).is_err());
        state.save_project(project()).unwrap();
        state.save_session(session()).unwrap();
        state.save_session(session()).unwrap(); // Same identity updates, never duplicates.
        assert_eq!(state.workspace().unwrap().sessions.len(), 1);
        let mut changed = project();
        changed.path.push_str("/different");
        assert!(state.save_project(changed).is_err());
        let mut invalid = session();
        invalid.id.clear();
        assert!(state.save_session(invalid).is_err());
        let mut invalid = session();
        invalid.args.push("\0".into());
        assert!(state.save_session(invalid).is_err());
    }
    {
        let state = AgentSessions::open(&dir).unwrap();
        assert_eq!(state.workspace().unwrap().statuses[0].state, "idle");
        assert_eq!(state.workspace().unwrap().sessions[0].args, session().args);
        state.stop("session").unwrap();
        state.delete_session("session").unwrap();
        state.save_session(session()).unwrap();
        state.delete_project("project").unwrap();
        assert!(state.workspace().unwrap().sessions.is_empty());
        assert!(state.workspace().unwrap().projects.is_empty());
    }
    std::fs::remove_dir_all(dir).unwrap();
}
