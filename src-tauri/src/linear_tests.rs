use super::mutations::{upload_target, validate_image};
use super::responses::{FileUploadData, RawIssueCreate};
use super::*;
use crate::kanban::{KanbanSubIssueState, KanbanUserRef, KanbanWorkflowState};

fn team(id: &str, name: &str) -> KanbanTeam {
    KanbanTeam {
        id: id.into(),
        key: id.to_uppercase(),
        name: name.into(),
    }
}

fn state(id: &str, state_type: &str, position: f64) -> KanbanWorkflowState {
    KanbanWorkflowState {
        id: id.into(),
        name: id.into(),
        r#type: state_type.into(),
        color: "#bec2c8".into(),
        position,
    }
}

fn label(id: &str, name: &str) -> KanbanLabel {
    KanbanLabel {
        id: id.into(),
        name: name.into(),
        color: "#000000".into(),
    }
}

fn links() -> ProjectLinks {
    ProjectLinks::new(vec![(
        "p-auth".into(),
        KanbanProjectRef {
            id: "soreno-web".into(),
            name: "Web".into(),
        },
    )])
}

#[test]
fn board_project_choices_keep_only_projects_linked_in_its_workspace() {
    let mut links = links();
    links.0.push((
        "p-other-workspace".into(),
        KanbanProjectRef {
            id: "soreno-api".into(),
            name: "API".into(),
        },
    ));

    assert_eq!(links.project_ids_in(&["p-auth"]), ["soreno-web"]);
    assert_eq!(
        links.project_ids_in(&links.linear_project_ids()),
        ["soreno-web", "soreno-api"]
    );
}

fn code(error: &str) -> &str {
    error
        .strip_prefix("[Kanban/")
        .and_then(|rest| rest.split_once(']'))
        .map(|(code, _)| code)
        .unwrap_or_else(|| panic!("untagged error: {error}"))
}

#[test]
fn http_statuses_map_to_their_error_codes() {
    for (status, expected) in [
        (401, "linearAuth"),
        (403, "linearForbidden"),
        (429, "linearRateLimit"),
        (500, "linearUnavailable"),
        (502, "linearUnavailable"),
        (503, "linearUnavailable"),
        (400, "linearRequest"),
        (404, "linearRequest"),
    ] {
        let error = classify_response_error(status, "<html>error</html>").expect("an error");
        assert_eq!(code(&error), expected, "HTTP {status}");
    }
}

#[test]
fn graphql_error_extensions_map_to_their_error_codes() {
    for (extension, expected) in [
        ("AUTHENTICATION_ERROR", "linearAuth"),
        ("FORBIDDEN", "linearForbidden"),
        ("RATELIMITED", "linearRateLimit"),
        ("INPUT_ERROR", "linearRequest"),
    ] {
        let body = format!(
            r#"{{"data":null,"errors":[{{"message":"Nope","extensions":{{"code":"{extension}"}}}}]}}"#
        );
        for status in [200, 400] {
            let error = classify_response_error(status, &body).expect("an error");
            assert_eq!(code(&error), expected, "{extension} with HTTP {status}");
        }
    }
}

#[test]
fn other_graphql_errors_show_linear_s_first_message_after_the_tag() {
    let body = r#"{"data":null,"errors":[{"message":"Entity not found: Team","extensions":{"code":"INPUT_ERROR"}}]}"#;
    assert_eq!(
        classify_response_error(200, body).as_deref(),
        Some("[Kanban/linearRequest] Entity not found: Team")
    );
    assert_eq!(
        classify_response_error(400, "Bad request").as_deref(),
        Some("[Kanban/linearRequest] HTTP 400")
    );
}

#[test]
fn successful_response_without_errors_is_not_an_error() {
    assert_eq!(
        classify_response_error(200, r#"{"data":{"viewer":{"id":"u1"}}}"#),
        None
    );
}

#[test]
fn malformed_or_empty_responses_are_request_errors() {
    for body in [r#"{"data":{"viewer":1}}"#, r#"{"data":null}"#, "not json"] {
        let error = parse_graphql_response::<TeamsData>(200, body).expect_err("an error");
        assert_eq!(code(&error), "linearRequest", "{body}");
    }
}

#[test]
fn missing_key_and_unreachable_linear_have_their_own_codes() {
    assert_eq!(code(MISSING_API_KEY_MESSAGE), "linearMissingKey");
    assert_eq!(code(&unavailable()), "linearUnavailable");
    assert_eq!(code(NO_TEAM_MESSAGE), "linearNoTeam");
    assert_eq!(
        code(&tauri::async_runtime::block_on(set_api_key("  ")).unwrap_err()),
        "linearMissingKey"
    );
}

fn update_input(patch: Value) -> Result<Value> {
    issue_update_input(
        serde_json::from_value(patch).expect("patch deserializes"),
        &links(),
    )
}

#[test]
fn issue_update_input_maps_every_editable_field_and_the_linked_project() {
    assert_eq!(
        update_input(json!({ "priority": 0 })),
        Ok(json!({ "priority": 0 }))
    );
    assert_eq!(
        update_input(json!({
            "stateId": "s-done",
            "priority": 2,
            "title": "  Fix login redirect \n",
            "projectId": "soreno-web",
            "addedLabelIds": ["l-bug"],
            "removedLabelIds": ["l-chore", "l-ux"],
        })),
        Ok(json!({
            "stateId": "s-done",
            "priority": 2,
            "title": "Fix login redirect",
            "projectId": "p-auth",
            "addedLabelIds": ["l-bug"],
            "removedLabelIds": ["l-chore", "l-ux"],
        }))
    );
    assert_eq!(
        update_input(json!({ "projectId": null })),
        Ok(json!({ "projectId": null }))
    );
}

#[test]
fn invalid_issue_patches_are_rejected_with_local_codes() {
    for (patch, expected) in [
        (json!({}), "emptyUpdate"),
        (
            json!({ "addedLabelIds": [], "removedLabelIds": [] }),
            "emptyUpdate",
        ),
        (json!({ "title": " \t\n" }), "invalidTitle"),
        (
            json!({ "addedLabelIds": ["l-bug", "l-ux"], "removedLabelIds": ["l-ux"] }),
            "labelConflict",
        ),
        (json!({ "priority": 9 }), "invalidPriority"),
        (json!({ "projectId": "unlinked" }), "linearProjectNotLinked"),
    ] {
        let error = update_input(patch.clone()).expect_err("rejected");
        assert_eq!(code(&error), expected, "{patch}");
    }
    assert!(serde_json::from_value::<KanbanIssueInput>(json!({ "assigneeId": "u" })).is_err());
}

#[test]
fn invalid_writes_fail_before_any_request() {
    let error =
        tauri::async_runtime::block_on(update_issue("i1", KanbanIssueInput::default(), &links()))
            .unwrap_err();
    assert_eq!(code(&error), "emptyUpdate");
    let error = tauri::async_runtime::block_on(create_comment("i1", "  \n")).unwrap_err();
    assert_eq!(code(&error), "emptyComment");
    let error = tauri::async_runtime::block_on(create_label("t1", "  ")).unwrap_err();
    assert_eq!(code(&error), "invalidLabelName");
}

fn create_input(input: Value) -> Result<Value> {
    issue_create_input(
        serde_json::from_value(input).expect("input deserializes"),
        &links(),
    )
}

#[test]
fn issue_create_input_sends_only_the_given_fields() {
    assert_eq!(
        create_input(
            json!({ "teamId": "t-eng", "title": "  Fix login redirect \n", "description": " \n" })
        ),
        Ok(json!({ "teamId": "t-eng", "title": "Fix login redirect" }))
    );
    assert_eq!(
        create_input(json!({
            "teamId": "t-eng",
            "title": "Fix login redirect",
            "description": "\n  Steps:\n\n- open `/login`  \n",
            "stateId": "s-todo",
            "priority": 0,
            "projectId": "soreno-web",
            "labelIds": ["l-bug", "l-ux"],
            "parentId": "i-1",
        })),
        Ok(json!({
            "teamId": "t-eng",
            "title": "Fix login redirect",
            "description": "Steps:\n\n- open `/login`",
            "stateId": "s-todo",
            "priority": 0,
            "projectId": "p-auth",
            "labelIds": ["l-bug", "l-ux"],
            "parentId": "i-1",
        }))
    );
    for (input, expected) in [
        (json!({ "teamId": "t", "title": " " }), "invalidTitle"),
        (
            json!({ "teamId": "t", "title": "Chore", "priority": 5 }),
            "invalidPriority",
        ),
        (
            json!({ "teamId": "t", "title": "Chore", "projectId": "unlinked" }),
            "linearProjectNotLinked",
        ),
    ] {
        let error = create_input(input.clone()).expect_err("rejected");
        assert_eq!(code(&error), expected, "{input}");
    }
}

#[test]
fn applied_issue_update_maps_the_linked_project_and_linear_fields() {
    let data: IssueUpdateData = serde_json::from_str(
        r##"{"issueUpdate":{"success":true,"issue":{
            "id":"i1","title":"Fix login redirect","url":"https://linear.app/i1","priority":3.0,"updatedAt":"2026-09-27T10:00:00.000Z",
            "state":{"id":"s-done"},
            "assignee":{"name":"Ada Lovelace"},
            "project":{"id":"p-auth","name":"Auth revamp","color":"#f2994a"},
            "labelIds":["l-bug"],
            "labels":{"nodes":[{"id":"l-bug","name":"Bug","color":"#eb5757"}]}
        }}}"##,
    )
    .unwrap();
    let update = applied_issue_update(data.issue_update, &links()).expect("update applied");

    assert_eq!(
        serde_json::to_value(update).expect("serialize update"),
        json!({
            "id": "i1",
            "title": "Fix login redirect",
            "stateId": "s-done",
            "priority": 3,
            "project": { "id": "soreno-web", "name": "Web" },
            "labels": [{ "id": "l-bug", "name": "Bug", "color": "#eb5757" }],
            "updatedAt": "2026-09-27T10:00:00.000Z",
            "url": "https://linear.app/i1",
            "assignee": { "name": "Ada Lovelace" },
            "linearProject": { "id": "p-auth", "name": "Auth revamp", "color": "#f2994a" },
        })
    );
}

#[test]
fn unsuccessful_payloads_are_request_errors() {
    let update: IssueUpdateData =
        serde_json::from_str(r#"{"issueUpdate":{"success":false,"issue":null}}"#).unwrap();
    assert_eq!(
        code(&applied_issue_update(update.issue_update, &links()).unwrap_err()),
        "linearRequest"
    );
    let description: IssueDescriptionUpdateData =
        serde_json::from_str(r#"{"issueUpdate":{"success":true,"issue":null}}"#).unwrap();
    assert!(applied_description_update(description.issue_update).is_err());
    let comment: CommentCreateData =
        serde_json::from_str(r#"{"commentCreate":{"success":false,"comment":null}}"#).unwrap();
    assert!(created_comment(comment.comment_create).is_err());
    let deleted = parse_graphql_response::<CommentDeleteData>(
        200,
        r#"{"data":{"commentDelete":{"success":false}}}"#,
    )
    .unwrap();
    assert!(confirmed(deleted.comment_delete, "refused").is_err());
    let label = parse_graphql_response::<LabelCreateData>(
        200,
        r#"{"data":{"issueLabelCreate":{"success":false,"issueLabel":null}}}"#,
    )
    .unwrap();
    assert!(created_label(label.issue_label_create).is_err());
}

#[test]
fn description_update_succeeds_only_when_linear_confirms_it() {
    let data: IssueDescriptionUpdateData = serde_json::from_str(
        r#"{"issueUpdate":{"success":true,"issue":{"id":"i1","description":"Steps","updatedAt":"2026-09-27T12:00:00.000Z"}}}"#,
    )
    .unwrap();
    assert_eq!(
        applied_description_update(data.issue_update),
        Ok(KanbanIssueDescriptionUpdate {
            id: "i1".into(),
            description: Some("Steps".into()),
            updated_at: "2026-09-27T12:00:00.000Z".into(),
        })
    );
}

#[test]
fn created_comment_keeps_its_author() {
    let data: CommentCreateData = serde_json::from_str(
        r#"{"commentCreate":{"success":true,"comment":{"id":"c-9","body":"Looks good","createdAt":"2026-09-27T12:00:00.000Z","user":null}}}"#,
    )
    .unwrap();
    let comment = created_comment(data.comment_create).unwrap();
    assert_eq!(
        serde_json::to_value(comment).unwrap(),
        json!({ "id": "c-9", "body": "Looks good", "createdAt": "2026-09-27T12:00:00.000Z", "user": null })
    );
    assert_eq!(
        comment_create_input("i1", "\n  Looks good  \n"),
        Ok(json!({ "issueId": "i1", "body": "Looks good" }))
    );
}

#[test]
fn image_upload_accepts_only_non_empty_images_within_the_limit() {
    use crate::kanban::images::{IMAGE_TOO_LARGE_MESSAGE, IMAGE_TYPE_MESSAGE, MAX_IMAGE_BYTES};
    assert_eq!(validate_image("image/png", MAX_IMAGE_BYTES), Ok(()));
    assert_eq!(
        validate_image("image/png", MAX_IMAGE_BYTES + 1),
        Err(IMAGE_TOO_LARGE_MESSAGE.into())
    );
    for (content_type, size) in [("application/pdf", 10), ("image/png", 0)] {
        assert_eq!(
            validate_image(content_type, size),
            Err(IMAGE_TYPE_MESSAGE.into())
        );
    }
}

#[test]
fn image_upload_target_keeps_the_signed_headers_only_when_linear_confirms_it() {
    let accepted = parse_graphql_response::<FileUploadData>(
        200,
        r#"{"data":{"fileUpload":{"success":true,"uploadFile":{"uploadUrl":"https://storage/put","assetUrl":"https://uploads.linear.app/a/b","headers":[{"key":"x-goog-meta","value":"v"}]}}}}"#,
    )
    .expect("payload parses");
    let target = upload_target(accepted.file_upload).expect("upload target");
    assert_eq!(target.asset_url, "https://uploads.linear.app/a/b");
    assert_eq!(target.headers[0].key, "x-goog-meta");

    let refused = parse_graphql_response::<FileUploadData>(
        200,
        r#"{"data":{"fileUpload":{"success":false,"uploadFile":null}}}"#,
    )
    .expect("payload parses");
    assert!(upload_target(refused.file_upload).is_err());
}

#[test]
fn team_labels_keep_plain_labels_sorted_by_name() {
    let labels = parse_graphql_response::<IssueLabelsData>(
        200,
        r##"{"data":{"issueLabels":{
            "nodes":[
                {"id":"l-ux","name":"ux","color":"#222222","isGroup":false},
                {"id":"l-type","name":"Type","color":"#333333","isGroup":true},
                {"id":"l-bug","name":"Bug","color":"#eb5757","isGroup":false}
            ],
            "pageInfo":{"hasNextPage":false,"endCursor":null}
        }}}"##,
    )
    .expect("labels parse")
    .issue_labels
    .nodes;
    assert_eq!(
        plain_labels(labels)
            .iter()
            .map(|label| label.id.as_str())
            .collect::<Vec<_>>(),
        ["l-bug", "l-ux"]
    );
}

#[test]
fn requested_team_is_selected_else_the_first_by_workspace_then_name() {
    let team = |id: &str, name: &str, workspace: &str| LinearTeam {
        team: team(id, name),
        workspace: workspace.into(),
        workspace_id: workspace.into(),
    };
    let mut teams = vec![
        team("t-ops", "Operations", "acme"),
        team("t-design", "design", "Zeta"),
        team("t-eng", "Engineering", "acme"),
    ];
    sort_teams(&mut teams);
    assert_eq!(
        teams
            .iter()
            .map(|team| team.team.id.as_str())
            .collect::<Vec<_>>(),
        ["t-eng", "t-ops", "t-design"]
    );
    let selected = |team_id| select_team(&teams, team_id).map(|team| team.team.id.as_str());
    assert_eq!(selected(Some("t-design")), Some("t-design"));
    assert_eq!(selected(Some("t-gone")), Some("t-eng"));
    assert_eq!(selected(None), Some("t-eng"));
    assert_eq!(select_team(&[], None), None);
}

fn workspace(id: &str) -> StoredWorkspace {
    StoredWorkspace {
        id: id.into(),
        name: id.to_uppercase(),
        api_key: format!("lin_api_{id}"),
    }
}

#[test]
fn the_single_key_of_older_versions_is_kept_as_an_unnamed_workspace() {
    let legacy = parse_stored_workspaces("lin_api_legacy");
    assert_eq!(legacy.len(), 1);
    assert_eq!(
        (legacy[0].id.as_str(), legacy[0].api_key.as_str()),
        ("", "lin_api_legacy")
    );
    let stored = vec![workspace("w-a"), workspace("w-b")];
    assert!(parse_stored_workspaces(&serde_json::to_string(&stored).unwrap()) == stored);
}

#[test]
fn routing_skips_failing_workspaces_and_tries_the_owner_first_next_time() {
    let id = "routing-test-issue";
    let attempts = std::cell::RefCell::new(Vec::new());
    let attempt = |workspace: StoredWorkspace| {
        attempts.borrow_mut().push(workspace.id.clone());
        async move {
            match workspace.id.as_str() {
                "w-a" => Err(AUTH_ERROR_MESSAGE.to_owned()),
                "w-b" => Ok(None),
                _ => Ok(Some(workspace.api_key)),
            }
        }
    };
    let mut workspaces = vec![workspace("w-a"), workspace("w-b"), workspace("w-c")];
    assert_eq!(
        tauri::async_runtime::block_on(try_workspaces(id, workspaces.clone(), attempt)),
        Ok("lin_api_w-c".to_owned())
    );
    assert_eq!(*attempts.borrow(), ["w-a", "w-b", "w-c"]);

    assert!(remembered_first(id, &mut workspaces));
    assert_eq!(
        workspaces.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
        ["w-c", "w-a", "w-b"]
    );
    assert!(!remembered_first("routing-test-unknown", &mut workspaces));
}

#[test]
fn routing_reports_a_refused_key_by_workspace_else_that_nothing_holds_the_item() {
    let none = |_: StoredWorkspace| async { Ok::<Option<()>, String>(None) };
    let error = tauri::async_runtime::block_on(try_workspaces(
        "routing-test-missing",
        vec![workspace("w-a"), workspace("w-b")],
        none,
    ))
    .unwrap_err();
    assert_eq!(code(&error), "linearNotFound");

    let refused = |workspace: StoredWorkspace| async move {
        if workspace.id == "w-a" {
            Err(AUTH_ERROR_MESSAGE.to_owned())
        } else {
            Ok::<Option<()>, String>(None)
        }
    };
    assert_eq!(
        tauri::async_runtime::block_on(try_workspaces(
            "routing-test-refused",
            vec![workspace("w-b"), workspace("w-a")],
            refused,
        )),
        Err("[Kanban/linearWorkspaceAuth] W-A".to_owned())
    );
}

#[test]
fn states_are_ordered_by_workflow_type_then_position() {
    let mut states = vec![
        state("Done", "completed", 0.0),
        state("Custom", "mystery", -10.0),
        state("In Review", "started", 2.0),
        state("Todo", "unstarted", 0.0),
        state("Canceled", "canceled", 0.0),
        state("In Progress", "started", 1.0),
        state("Backlog", "backlog", 5.0),
        state("Triage", "triage", 9.0),
    ];
    kanban::sort_states(&mut states);
    assert_eq!(
        states
            .iter()
            .map(|state| state.id.as_str())
            .collect::<Vec<_>>(),
        [
            "Triage",
            "Backlog",
            "Todo",
            "In Progress",
            "In Review",
            "Done",
            "Canceled",
            "Custom"
        ]
    );
}

const TEAM_BOARD_FIXTURE: &str = r##"{
  "data": {
    "team": {
      "states": {
        "nodes": [
          { "id": "s-done", "name": "Done", "type": "completed", "color": "#5e6ad2", "position": 3 },
          { "id": "s-todo", "name": "Todo", "type": "unstarted", "color": "#e2e2e2", "position": 1.5 }
        ]
      },
      "issues": {
        "nodes": [
          {
            "id": "i-1",
            "identifier": "ENG-42",
            "title": "Fix login redirect",
            "url": "https://linear.app/acme/issue/ENG-42/fix-login-redirect",
            "priority": 2.0,
            "createdAt": "2026-08-14T09:12:00.000Z",
            "updatedAt": "2026-08-15T10:00:00.000Z",
            "state": { "id": "s-todo" },
            "assignee": { "name": "Ada Lovelace" },
            "project": { "id": "p-auth", "name": "Auth revamp", "color": "#f2994a" },
            "labelIds": ["l-bug"],
            "labels": { "nodes": [{ "id": "l-bug", "name": "Bug", "color": "#eb5757" }] },
            "attachments": {
              "nodes": [
                { "url": "https://github.com/acme/web/pull/5", "sourceType": "github" },
                { "url": "https://github.com/acme/web/pull/3#issuecomment-5079020044", "sourceType": "api" },
                { "url": "https://acme.slack.com/archives/C1/p1", "sourceType": "slack" }
              ]
            }
          },
          {
            "id": "i-2",
            "identifier": "ENG-43",
            "title": "Unassigned chore",
            "url": "https://linear.app/acme/issue/ENG-43/unassigned-chore",
            "priority": 7.4,
            "createdAt": "2026-08-14T09:13:00.000Z",
            "updatedAt": "2026-08-14T09:13:00.000Z",
            "state": { "id": "s-done" },
            "assignee": null,
            "project": { "id": "p-other", "name": "Other", "color": "#111111" },
            "labelIds": [],
            "labels": { "nodes": [] },
            "attachments": { "nodes": [] }
          }
        ],
        "pageInfo": { "hasNextPage": false, "endCursor": "cursor-2" }
      }
    }
  }
}"##;

fn board_issues(body: &str) -> Vec<RawIssue> {
    parse_graphql_response::<TeamBoardData>(200, body)
        .expect("fixture parses")
        .team
        .issues
        .nodes
}

#[test]
fn board_issues_serialize_in_the_local_shape_with_linear_fields() {
    let issues: Vec<_> = board_issues(TEAM_BOARD_FIXTURE)
        .into_iter()
        .map(|raw| map_issue(raw, &links()))
        .collect();

    assert_eq!(
        serde_json::to_value(&issues[0]).unwrap(),
        json!({
            "source": "linear",
            "id": "i-1",
            "identifier": "ENG-42",
            "title": "Fix login redirect",
            "priority": 2,
            "stateId": "s-todo",
            "createdAt": "2026-08-14T09:12:00.000Z",
            "updatedAt": "2026-08-15T10:00:00.000Z",
            "project": { "id": "soreno-web", "name": "Web" },
            "labels": [{ "id": "l-bug", "name": "Bug", "color": "#eb5757" }],
            "pullRequests": [{ "number": 5, "url": "https://github.com/acme/web/pull/5" }],
            "url": "https://linear.app/acme/issue/ENG-42/fix-login-redirect",
            "assignee": { "name": "Ada Lovelace" },
            "linearProject": { "id": "p-auth", "name": "Auth revamp", "color": "#f2994a" },
        })
    );
    // An unlinked Linear project gives no Soreno project; priorities are clamped.
    assert_eq!(issues[1].project, None);
    assert_eq!(issues[1].priority, 4);
    assert_eq!(issues[1].linear.as_ref().unwrap().assignee, None);
}

fn created_issue_response(success: bool, issue: &str) -> RawIssueCreate {
    serde_json::from_str::<IssueCreateData>(&format!(
        r#"{{"issueCreate":{{"success":{success},"issue":{issue}}}}}"#
    ))
    .expect("create response parses")
    .issue_create
}

#[test]
fn created_issue_maps_like_a_board_issue() {
    let fixture: Value = serde_json::from_str(TEAM_BOARD_FIXTURE).unwrap();
    let issue = fixture["data"]["team"]["issues"]["nodes"][0].to_string();
    let expected = map_issue(board_issues(TEAM_BOARD_FIXTURE).remove(0), &links());
    assert_eq!(
        created_issue(created_issue_response(true, &issue), &links()),
        Ok(expected)
    );
    for payload in [
        created_issue_response(false, "null"),
        created_issue_response(true, "null"),
        created_issue_response(false, &issue),
    ] {
        assert!(created_issue(payload, &links()).is_err());
    }
}

#[test]
fn labels_beyond_the_returned_window_are_fetched_once_and_appended() {
    let mut raws = board_issues(
        &TEAM_BOARD_FIXTURE
            .replace(
                r#""labelIds": ["l-bug"]"#,
                r#""labelIds": ["l-bug", "l-ux"]"#,
            )
            .replace(
                r#""labelIds": []"#,
                r#""labelIds": ["l-perf", "l-ux", "l-gone"]"#,
            ),
    );
    assert_eq!(
        missing_label_ids(
            raws.iter()
                .map(|raw| (raw.label_ids.as_slice(), raw.labels.nodes.as_slice()))
        ),
        ["l-ux", "l-perf", "l-gone"]
    );
    add_fetched_labels(
        raws.iter_mut()
            .map(|raw| (raw.label_ids.as_slice(), &mut raw.labels.nodes))
            .collect(),
        &[label("l-perf", "Perf"), label("l-ux", "UX")],
    );
    assert_eq!(
        raws[1].labels.nodes,
        vec![label("l-perf", "Perf"), label("l-ux", "UX")]
    );
    assert_eq!(raws[0].labels.nodes.len(), 2);
}

const ISSUE_DETAIL_FIXTURE: &str = r##"{
  "data": {
    "issue": {
      "id": "i-1",
      "identifier": "ENG-42",
      "title": "Fix login redirect",
      "url": "https://linear.app/acme/issue/ENG-42/fix-login-redirect",
      "description": "Steps:\n\n- open `/login`",
      "branchName": "ada/eng-42-fix-login-redirect",
      "priority": 1.4,
      "createdAt": "2026-08-14T09:12:00.000Z",
      "updatedAt": "2026-08-15T10:00:00.000Z",
      "state": { "id": "s-todo" },
      "team": { "id": "t-eng" },
      "assignee": null,
      "project": null,
      "labelIds": ["l-bug"],
      "labels": { "nodes": [{ "id": "l-bug", "name": "Bug", "color": "#eb5757" }] },
      "children": {
        "nodes": [
          { "id": "i-7", "identifier": "ENG-50", "title": "Add regression test", "state": { "id": "s-done", "name": "Done", "type": "completed", "color": "#5e6ad2" } }
        ],
        "pageInfo": { "hasNextPage": true, "endCursor": "children-1" }
      },
      "comments": {
        "nodes": [
          { "id": "c-3", "body": "Shipped", "createdAt": "2026-08-16T08:00:00.000Z", "user": null },
          { "id": "c-1", "body": "First", "createdAt": "2026-08-14T10:00:00.000Z", "user": { "name": "Ada Lovelace" } }
        ],
        "pageInfo": { "hasNextPage": false, "endCursor": "comments-1" }
      },
      "attachments": {
        "nodes": [{ "url": "https://gitlab.com/acme/api/-/merge_requests/12", "sourceType": "gitlab" }]
      }
    }
  }
}"##;

#[test]
fn issue_detail_merges_follow_up_pages_with_comments_oldest_first() {
    let mut raw = parse_graphql_response::<IssueDetailData>(200, ISSUE_DETAIL_FIXTURE)
        .expect("fixture parses")
        .issue;
    assert_eq!(
        raw.children.page_info.take_next_cursor().as_deref(),
        Some("children-1")
    );
    assert_eq!(raw.comments.page_info.take_next_cursor(), None);
    let more_children = vec![KanbanSubIssue {
        id: "i-8".into(),
        identifier: "ENG-51".into(),
        title: "Document redirect".into(),
        state: KanbanSubIssueState {
            id: "s-todo".into(),
            name: "Todo".into(),
            r#type: "unstarted".into(),
            color: "#e2e2e2".into(),
        },
    }];
    let more_comments = vec![RawComment {
        id: "c-0".into(),
        body: "Opened".into(),
        created_at: "2026-08-14T09:30:00.000Z".into(),
        user: None,
    }];
    let detail = map_issue_detail(raw, more_children, more_comments, &links());

    assert_eq!(detail.source, KanbanSource::Linear);
    assert_eq!(detail.branch_name, "ada/eng-42-fix-login-redirect");
    assert_eq!(detail.priority, 1);
    assert_eq!(detail.project, None);
    assert_eq!(
        detail
            .children
            .iter()
            .map(|child| child.identifier.as_str())
            .collect::<Vec<_>>(),
        ["ENG-50", "ENG-51"]
    );
    assert_eq!(
        detail
            .comments
            .iter()
            .map(|comment| comment.id.as_str())
            .collect::<Vec<_>>(),
        ["c-0", "c-1", "c-3"]
    );
    assert_eq!(
        detail.comments[1].user,
        Some(Some(KanbanUserRef {
            name: "Ada Lovelace".into(),
            avatar_url: None,
        }))
    );
    assert_eq!(detail.pull_requests[0].number, 12);
    let json = serde_json::to_value(&detail).unwrap();
    assert_eq!(json["source"], "linear");
    assert_eq!(json["linearProject"], Value::Null);
    assert_eq!(json["teamId"], "t-eng");
    assert_eq!(json["comments"][0]["user"], Value::Null);
}

#[test]
fn project_pages_are_merged_and_sorted_by_name_case_insensitively() {
    let project = |id: &str, name: &str| LinearProjectSummary {
        id: id.into(),
        name: name.into(),
        teams: Vec::new(),
        workspace: String::new(),
    };
    let projects = sorted_projects(vec![
        vec![project("p-web", "web"), project("p-mobile", "Mobile")],
        vec![project("p-auth", "Auth revamp"), project("p-api", "API")],
    ]);
    assert_eq!(
        projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        ["p-api", "p-auth", "p-mobile", "p-web"]
    );
}

#[test]
fn completion_targets_the_first_review_state_unless_the_issue_is_settled() {
    let states = [
        state("In Progress", "started", 1.0),
        state("Code Review", "started", 3.0),
        state("Revue", "started", 2.0),
        state("Review later", "backlog", 0.0),
        state("Done", "completed", 4.0),
    ];
    for (current, current_type, expected) in [
        ("Todo", "unstarted", Some("Revue")),
        ("In Progress", "started", Some("Revue")),
        ("Revue", "started", None),
        ("Done", "completed", None),
        ("Canceled", "canceled", None),
    ] {
        assert_eq!(
            kanban::review_state_id(&states, current, current_type),
            expected,
            "{current}"
        );
    }
}
