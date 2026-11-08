use super::*;

fn no_worktrees(_: &AgentProject) -> Result<AgentProjectWorktreeSnapshot> {
    Ok(AgentProjectWorktreeSnapshot {
        groups: Vec::new(),
        complete: true,
        missing_project_ids: Vec::new(),
    })
}
fn link(state: &AgentSessions, project_id: &str, linear_project_id: Option<&str>) -> Result<()> {
    state.set_project_linear_link_with(project_id, linear_project_id, no_worktrees)
}
fn links(state: &AgentSessions) -> Vec<(String, String)> {
    state
        .workspace()
        .unwrap()
        .linear_project_links
        .into_iter()
        .map(|link| (link.project_id, link.linear_project_id))
        .collect()
}
fn pair(project_id: &str, linear_project_id: &str) -> (String, String) {
    (project_id.into(), linear_project_id.into())
}

#[test]
fn link_is_set_replaced_and_cleared_in_the_workspace() {
    let state = memory_state();
    insert_project(&state, &local_project("a"));
    insert_project(&state, &local_project("b"));

    link(&state, "a", Some("lin-1")).unwrap();
    link(&state, "b", Some("lin-2")).unwrap();
    assert_eq!(
        serde_json::to_value(state.workspace().unwrap()).unwrap()["linearProjectLinks"],
        serde_json::json!([
            { "projectId": "a", "linearProjectId": "lin-1" },
            { "projectId": "b", "linearProjectId": "lin-2" },
        ])
    );

    link(&state, "a", Some("lin-3")).unwrap();
    assert_eq!(links(&state), [pair("a", "lin-3"), pair("b", "lin-2")]);

    link(&state, "a", None).unwrap();
    link(&state, "a", None).unwrap();
    assert_eq!(links(&state), [pair("b", "lin-2")]);
}

#[test]
fn invalid_targets_are_rejected_without_changing_links() {
    let state = memory_state();
    insert_project(&state, &local_project("a"));
    link(&state, "a", Some("lin-1")).unwrap();

    assert_eq!(
        link(&state, "missing", Some("lin-2")).unwrap_err(),
        "Projet introuvable."
    );
    assert_eq!(
        link(&state, "missing", None).unwrap_err(),
        "Projet introuvable."
    );
    assert!(link(&state, "a", Some("  ")).is_err());
    assert!(link(&state, "", Some("lin-2")).is_err());
    assert_eq!(links(&state), [pair("a", "lin-1")]);
}

#[test]
fn linear_project_already_linked_names_the_other_project() {
    let state = memory_state();
    insert_project(&state, &local_project("a"));
    insert_project(&state, &local_project("b"));
    link(&state, "a", Some("lin-1")).unwrap();

    assert_eq!(
        link(&state, "b", Some("lin-1")).unwrap_err(),
        "Ce projet Linear est déjà lié au projet « Projet a »."
    );
    link(&state, "a", Some("lin-1")).unwrap();
    assert_eq!(links(&state), [pair("a", "lin-1")]);

    link(&state, "a", None).unwrap();
    link(&state, "b", Some("lin-1")).unwrap();
    assert_eq!(links(&state), [pair("b", "lin-1")]);
}

#[test]
fn group_projects_cannot_be_linked() {
    let state = memory_state();
    insert_project(&state, &local_project("a"));
    state
        .save_group(AgentProjectGroupInput {
            id: "g1".into(),
            name: "Jinka".into(),
            project_ids: vec!["a".into()],
        })
        .unwrap();
    let root = unique_temp_path("soreno-linear-links");
    let group_project = state
        .prepare_group_project_with("g1", |_, id| {
            let path = root.join(id);
            std::fs::create_dir_all(&path).unwrap();
            Ok(path.to_string_lossy().into_owned())
        })
        .unwrap();

    assert_eq!(
        link(&state, &group_project.id, Some("lin-1")).unwrap_err(),
        "Ce projet ne peut pas être lié à Linear."
    );
    link(&state, "a", Some("lin-1")).unwrap();
    assert_eq!(links(&state), [pair("a", "lin-1")]);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn only_the_repository_project_of_a_worktree_group_can_be_linked() {
    let state = memory_state();
    insert_project(&state, &local_project("repository"));
    insert_project(&state, &local_project("worktree"));
    let snapshot = |_: &AgentProject| {
        Ok(AgentProjectWorktreeSnapshot {
            groups: vec![AgentProjectWorktreeGroup {
                repository_project_id: "repository".into(),
                project_ids: vec!["repository".into(), "worktree".into()],
                worktrees: Vec::new(),
            }],
            complete: true,
            missing_project_ids: Vec::new(),
        })
    };

    assert_eq!(
        state
            .set_project_linear_link_with("worktree", Some("lin-1"), snapshot)
            .unwrap_err(),
        "Ce projet ne peut pas être lié à Linear."
    );
    state
        .set_project_linear_link_with("repository", Some("lin-1"), snapshot)
        .unwrap();
    state
        .set_project_linear_link_with("worktree", None, |_| {
            panic!("clearing a link must not probe Git")
        })
        .unwrap();
    assert_eq!(links(&state), [pair("repository", "lin-1")]);
}

#[test]
fn registered_git_worktree_is_refused_while_its_repository_is_linked() {
    let root = unique_temp_path("soreno-linear-worktrees");
    let repository = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repository).unwrap();
    workspace_tests::run_git(&repository, &["init"]);
    std::fs::write(repository.join("tracked"), "content").unwrap();
    workspace_tests::run_git(&repository, &["add", "tracked"]);
    workspace_tests::run_git(
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
    workspace_tests::run_git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "feature",
            worktree.to_str().unwrap(),
            "HEAD",
        ],
    );
    let state = memory_state();
    insert_project(
        &state,
        &AgentProject {
            path: repository.to_string_lossy().into(),
            ..local_project("repository")
        },
    );
    insert_project(
        &state,
        &AgentProject {
            path: worktree.to_string_lossy().into(),
            ..local_project("worktree")
        },
    );

    assert_eq!(
        state
            .set_project_linear_link("worktree", Some("lin-1"))
            .unwrap_err(),
        "Ce projet ne peut pas être lié à Linear."
    );
    state
        .set_project_linear_link("repository", Some("lin-1"))
        .unwrap();
    assert_eq!(links(&state), [pair("repository", "lin-1")]);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn deleting_a_project_drops_its_link_and_frees_the_linear_project() {
    let state = memory_state();
    insert_project(&state, &local_project("a"));
    insert_project(&state, &local_project("b"));
    link(&state, "a", Some("lin-1")).unwrap();

    state.delete_project("a").unwrap();
    assert!(links(&state).is_empty());
    link(&state, "b", Some("lin-1")).unwrap();
    assert_eq!(links(&state), [pair("b", "lin-1")]);
}
