use super::*;
use sha2::{Digest, Sha256};

fn group(group_id: &str, name: &str, project_ids: &[&str]) -> AgentProjectGroupInput {
    AgentProjectGroupInput {
        id: group_id.into(),
        name: name.into(),
        project_ids: project_ids.iter().map(|id| (*id).into()).collect(),
    }
}
fn groups(state: &AgentSessions) -> Vec<AgentProjectGroup> {
    state.workspace().unwrap().groups
}
fn temp_root(label: &str) -> PathBuf {
    let root = unique_temp_path(&format!("soreno-groups-{label}"));
    std::fs::create_dir_all(&root).unwrap();
    root
}
fn prepare_in(state: &AgentSessions, root: &Path, group_id: &str) -> AgentProject {
    state
        .prepare_group_project_with(group_id, |_, id| {
            let path = root.join(".soreno").join("groups").join(id);
            std::fs::create_dir_all(&path).unwrap();
            Ok(path.to_string_lossy().into_owned())
        })
        .unwrap()
}
fn with_local_group(state: &AgentSessions) {
    insert_project(state, &local_project("a"));
    insert_project(state, &local_project("b"));
    state.save_group(group("g1", "Jinka", &["a", "b"])).unwrap();
}

#[test]
fn save_group_requires_members_on_one_machine() {
    let state = memory_state();
    insert_project(&state, &ssh_project("left"));
    insert_project(&state, &ssh_project("right"));
    assert_eq!(
        state
            .save_group(group("g1", "Jinka", &["left", "right"]))
            .unwrap_err(),
        "Les projets d'un groupe doivent être sur la même machine."
    );
    insert_project(&state, &local_project("wide"));
    assert_eq!(
        state
            .save_group(group("g2", &"你".repeat(90), &["wide"]))
            .unwrap_err(),
        "Nom du groupe vide, trop long ou contenant un caractère nul."
    );
    with_local_group(&state);
    assert_eq!(
        groups(&state),
        vec![AgentProjectGroup {
            id: "g1".into(),
            name: "Jinka".into(),
            project_ids: vec!["a".into(), "b".into()],
            group_project_id: None,
            appearance: Default::default(),
        }]
    );
}

#[test]
fn moving_a_project_removes_it_from_its_previous_group() {
    let state = memory_state();
    with_local_group(&state);
    insert_project(&state, &local_project("c"));
    state.save_group(group("g2", "Autre", &["c", "a"])).unwrap();
    let groups = groups(&state);
    assert_eq!(groups[0].project_ids, vec!["b".to_string()]);
    assert_eq!(
        groups[1].project_ids,
        vec!["c".to_string(), "a".to_string()]
    );
}

#[test]
fn group_project_is_managed_by_its_group() {
    let state = memory_state();
    with_local_group(&state);
    let root = temp_root("managed");
    let group_project = prepare_in(&state, &root, "g1");
    insert_project(&state, &local_project("c"));
    assert_eq!(
        state
            .save_group(group("g2", "Autre", &["c", &group_project.id]))
            .unwrap_err(),
        "Un projet de groupe ne peut pas être membre d'un groupe."
    );
    assert_eq!(
        state.delete_project(&group_project.id).unwrap_err(),
        "Supprimez le groupe pour supprimer ce projet."
    );
    assert_eq!(
        state.save_project(group_project.clone()).unwrap_err(),
        "Ce projet est géré par son groupe."
    );
    assert_eq!(
        state
            .update_project_appearance(&group_project.id, Default::default())
            .unwrap_err(),
        "Ce projet est géré par son groupe."
    );
    state
        .update_group_appearance(
            "g1",
            serde_json::from_value(serde_json::json!({ "icon": "rocket", "color": "#37a3a5" }))
                .unwrap(),
        )
        .unwrap();
    assert_eq!(
        state
            .update_group_appearance(
                "g1",
                serde_json::from_value(serde_json::json!({ "color": "red" })).unwrap(),
            )
            .unwrap_err(),
        "Couleur du projet invalide."
    );
    state
        .save_group(group("g1", "  Nouveau nom ", &["a", "b"]))
        .unwrap();
    let workspace = state.workspace().unwrap();
    assert_eq!(workspace.groups[0].name, "Nouveau nom");
    assert_eq!(
        workspace.groups[0].appearance.icon.as_deref(),
        Some("rocket")
    );
    assert_eq!(
        workspace.groups[0].appearance.color.as_deref(),
        Some("#37a3a5")
    );
    let cleared = state
        .update_group_appearance(
            "g1",
            serde_json::from_value(serde_json::json!({ "icon": null })).unwrap(),
        )
        .unwrap();
    assert_eq!(cleared.icon, None);
    assert_eq!(cleared.color.as_deref(), Some("#37a3a5"));
    let renamed = workspace
        .projects
        .iter()
        .find(|project| project.id == group_project.id)
        .unwrap();
    assert_eq!(renamed.name, "Nouveau nom");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn member_machine_is_locked_while_grouped() {
    let state = memory_state();
    with_local_group(&state);
    let remote = AgentProject {
        environment: ssh_project("a").environment,
        path: "/srv/project".into(),
        ..local_project("a")
    };
    assert_eq!(
        state.save_project(remote).unwrap_err(),
        "Retirez d'abord ce projet du groupe pour changer sa machine."
    );
}

#[test]
fn import_keeps_the_largest_machine_and_is_idempotent() {
    let state = memory_state();
    let a1 = ssh_project("a1");
    let a2 = AgentProject {
        id: "a2".into(),
        ..a1.clone()
    };
    let b = ssh_project("b");
    let tie_left = ssh_project("tie-left");
    let tie_right = ssh_project("tie-right");
    for project in [&a1, &a2, &b, &tie_left, &tie_right] {
        insert_project(&state, project);
    }
    let legacy = || {
        vec![
            group("g1", "Mixte", &["b", "a1", "missing", "a2"]),
            group("g 1", "Égalité", &["tie-left", "tie-right"]),
        ]
    };
    let imported = state.import_groups(legacy()).unwrap();
    assert_eq!(
        imported.ungrouped_project_ids,
        vec!["b".to_string(), "tie-right".to_string()]
    );
    let first = groups(&state);
    let legacy_id = format!(
        "legacy-{}",
        Sha256::digest(b"g 1")[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    assert_eq!(
        first,
        vec![
            AgentProjectGroup {
                id: "g1".into(),
                name: "Mixte".into(),
                project_ids: vec!["a1".into(), "a2".into()],
                group_project_id: None,
                appearance: Default::default(),
            },
            AgentProjectGroup {
                id: legacy_id.clone(),
                name: "Égalité".into(),
                project_ids: vec!["tie-left".into()],
                group_project_id: None,
                appearance: Default::default(),
            },
        ]
    );
    assert_eq!(imported.group_ids, vec!["g1".to_string(), legacy_id]);
    let again = state.import_groups(legacy()).unwrap();
    assert!(again.ungrouped_project_ids.is_empty());
    assert_eq!(again.group_ids, imported.group_ids);
    assert_eq!(groups(&state), first);
}

#[test]
fn group_project_is_prepared_once_on_the_members_machine() {
    let state = memory_state();
    with_local_group(&state);
    let root = temp_root("prepare");
    let prepared = prepare_in(&state, &root, "g1");
    let expected_path = root.join(".soreno").join("groups").join("g1");
    assert_eq!(prepared.id, "group-g1");
    assert_eq!(prepared.name, "Jinka");
    assert_eq!(prepared.path, expected_path.to_string_lossy());
    assert_eq!(prepared.environment, project().environment);
    assert_eq!(
        groups(&state)[0].group_project_id.as_deref(),
        Some("group-g1")
    );
    let again = state
        .prepare_group_project_with("g1", |_, _| panic!("already prepared"))
        .unwrap();
    assert_eq!(again.path, prepared.path);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn disconnected_group_is_not_prepared() {
    let state = memory_state();
    insert_project(&state, &ssh_project("remote"));
    state
        .save_group(group("g1", "Distant", &["remote"]))
        .unwrap();
    disconnect_project(&state, "remote").unwrap();
    assert_eq!(
        state
            .prepare_group_project_with("g1", |_, _| panic!("resolved while disconnected"))
            .unwrap_err(),
        "Ce projet SSH est déconnecté. Reconnectez-le avant cette opération."
    );
}

#[test]
fn group_disconnected_while_resolving_is_not_prepared() {
    let state = memory_state();
    insert_project(&state, &ssh_project("remote"));
    state
        .save_group(group("g1", "Distant", &["remote"]))
        .unwrap();
    assert_eq!(
        state
            .prepare_group_project_with("g1", |_, id| {
                disconnect_project(&state, "remote")?;
                Ok(format!("/srv/soreno/groups/{id}"))
            })
            .unwrap_err(),
        "Ce projet SSH est déconnecté. Reconnectez-le avant cette opération."
    );
    assert!(state
        .workspace()
        .unwrap()
        .projects
        .iter()
        .all(|project| project.id != "group-g1"));
    assert_eq!(groups(&state)[0].group_project_id, None);
}

#[test]
fn deleting_a_group_keeps_members_and_only_removes_an_empty_folder() {
    let state = memory_state();
    with_local_group(&state);
    let root = temp_root("delete");
    let prepared = prepare_in(&state, &root, "g1");
    let deletion = state.delete_group("g1", false).unwrap();
    assert_eq!(deletion.retained_folder, None);
    assert!(!Path::new(&prepared.path).exists());
    let workspace = state.workspace().unwrap();
    assert!(workspace.groups.is_empty());
    assert_eq!(
        workspace
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );

    state.save_group(group("g2", "Jinka", &["a", "b"])).unwrap();
    let prepared = prepare_in(&state, &root, "g2");
    std::fs::write(Path::new(&prepared.path).join("notes.md"), "garder").unwrap();
    assert_eq!(
        state.delete_group("g2", false).unwrap().retained_folder,
        Some(prepared.path.clone())
    );
    assert!(Path::new(&prepared.path).join("notes.md").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn group_folder_links_members_and_deletion_never_follows_them() {
    let root = temp_root("links");
    let folder = root.join("group");
    for directory in ["repos/api", "forks/API", "web", "group"] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    std::fs::write(root.join("repos/api/main.rs"), "fn main() {}").unwrap();
    std::fs::write(folder.join("notes.md"), "garder").unwrap();
    std::os::unix::fs::symlink(root.join("web"), folder.join("old")).unwrap();
    std::os::unix::fs::symlink(root.join("repos/api"), folder.join("web")).unwrap();
    let member = |name: &str, path: &str| {
        (
            name.to_owned(),
            root.join(path).to_string_lossy().into_owned(),
        )
    };
    let environment = local_project("a").environment;
    let path = folder.to_string_lossy();

    groups::link_members(
        &environment,
        &path,
        &[
            member("API", "repos/api/"),
            member("Fork", "forks/API"),
            member("Web", "web"),
        ],
    );
    let mut entries = std::fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    entries.sort();
    assert_eq!(entries, ["api", "notes.md", "web"]);
    assert_eq!(
        std::fs::read_link(folder.join("web")).unwrap(),
        root.join("web")
    );
    assert!(folder.join("api/main.rs").is_file());

    assert!(!groups::remove_empty_group_directory(&environment, &path));
    assert!(!folder.join("api").exists());
    assert!(root.join("repos/api/main.rs").is_file());
    std::fs::remove_file(folder.join("notes.md")).unwrap();
    groups::link_members(&environment, &path, &[member("Web", "web")]);
    assert!(groups::remove_empty_group_directory(&environment, &path));
    assert!(root.join("web").is_dir());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn saving_a_group_updates_its_folder_links() {
    let state = memory_state();
    let root = temp_root("save-links");
    for name in ["api", "web"] {
        std::fs::create_dir_all(root.join("repos").join(name)).unwrap();
        insert_project(
            &state,
            &AgentProject {
                path: root.join("repos").join(name).to_string_lossy().into_owned(),
                ..local_project(name)
            },
        );
    }
    state.save_group(group("g1", "Jinka", &["api"])).unwrap();
    let folder = PathBuf::from(prepare_in(&state, &root, "g1").path);

    state
        .save_group(group("g1", "Jinka", &["api", "web"]))
        .unwrap();
    assert_eq!(
        std::fs::read_link(folder.join("web")).unwrap(),
        root.join("repos/web")
    );
    state.save_group(group("g1", "Jinka", &["web"])).unwrap();
    assert!(folder.join("api").symlink_metadata().is_err());
    assert!(folder.join("web").symlink_metadata().is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn deleting_a_group_with_its_projects_is_all_or_nothing() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    insert_project(&state, &local_project("b"));
    insert_project(&state, &local_project("outside"));
    state
        .save_group(group("g1", "Jinka", &["b", "project"]))
        .unwrap();
    let root = temp_root("delete-projects");
    let prepared = prepare_in(&state, &root, "g1");
    state.save_session(session()).unwrap();
    state.start("session", 80, 24, None).unwrap();

    assert_eq!(
        state.delete_group("g1", true).unwrap_err(),
        "Arrêtez la session active avant cette opération."
    );
    let workspace = state.workspace().unwrap();
    assert_eq!(workspace.groups.len(), 1);
    assert_eq!(workspace.projects.len(), 4);

    state.stop("session").unwrap();
    wait_for(|| state.statuses().unwrap()[0].state == "exited");
    state.delete_group("g1", true).unwrap();
    let workspace = state.workspace().unwrap();
    assert!(workspace.groups.is_empty());
    assert!(workspace.sessions.is_empty());
    assert_eq!(
        workspace
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        vec!["outside"]
    );
    assert!(!Path::new(&prepared.path).exists());
    assert!(Path::new(&project().path).is_dir());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn launch_args_follow_each_agent() {
    let members = [
        ("Front".to_string(), "/a".to_string()),
        ("Back".to_string(), "/b".to_string()),
    ];
    let launch = |provider, args: &[&str], windows_local| {
        let mut args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        groups::add_launch_args(&mut args, provider, "Jinka", &members, windows_local);
        args
    };
    let claude = launch(conversations::Provider::Claude, &["--model", "opus"], false);
    let prompt = claude[1].as_str();
    for expected in ["Jinka", "/a", "/b"] {
        assert!(prompt.contains(expected), "{prompt}");
    }
    assert_eq!(
        claude,
        vec![
            "--append-system-prompt",
            prompt,
            "--add-dir",
            "/a",
            "--add-dir",
            "/b",
            "--model",
            "opus"
        ]
    );
    assert_eq!(
        launch(conversations::Provider::Pi, &[], false),
        vec!["--append-system-prompt", prompt]
    );
    // Codex keeps the user's sandbox mode and still starts when it is read-only.
    assert_eq!(
        launch(conversations::Provider::Codex, &["--yolo"], false),
        vec![
            "-c".to_owned(),
            r#"sandbox_workspace_write.writable_roots=["/a","/b"]"#.to_owned(),
            "-c".to_owned(),
            format!(
                "developer_instructions={}",
                serde_json::to_string(prompt).unwrap()
            ),
            "--yolo".to_owned()
        ]
    );
    // Windows passes a TOML literal string, on one line.
    assert_eq!(
        launch(
            conversations::Provider::Codex,
            &["-c", "sandbox_workspace_write.writable_roots=['/b','/c']"],
            true
        ),
        vec![
            "-c".to_owned(),
            format!("developer_instructions='{}'", prompt.replace('\n', " ")),
            "-c".to_owned(),
            "sandbox_workspace_write.writable_roots=['/b','/c','/a']".to_owned(),
        ]
    );
    let mut args = Vec::new();
    groups::add_launch_args(&mut args, conversations::Provider::Omp, "Jinka", &[], false);
    assert!(args.is_empty());
}

#[test]
fn group_sessions_cannot_override_managed_arguments() {
    assert!(conversations::validate_group_args(&["--add-dir=/x".into()]).is_err());
    assert!(conversations::validate_group_args(&["--".into(), "--add-dir".into()]).is_ok());
}

#[test]
fn oversized_group_launch_is_refused_before_windows_spawns_it() {
    let members = |count: usize| {
        (0..count)
            .map(|index| {
                (
                    format!("Dépôt {index}"),
                    format!("C:\\Users\\dev\\{}\\depot-{index}", "projets".repeat(12)),
                )
            })
            .collect::<Vec<_>>()
    };
    let command = |count: usize| {
        let mut session = session();
        session.executable = "claude".into();
        session.args = Vec::new();
        groups::add_launch_args(
            &mut session.args,
            conversations::Provider::Claude,
            "Jinka",
            &members(count),
            true,
        );
        windows_command(&session).unwrap()
    };
    assert!(ensure_windows_command_line(&command(3), true).is_ok());
    assert!(ensure_windows_command_line(&command(40), true).is_err());
}
