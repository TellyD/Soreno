use super::{hooks::WINDOWS_HOOK_SCRIPT, sidecar::Sidecar, *};
use crate::agent_sessions::{tests::unique_temp_path, AgentEnvironment};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::SystemTime,
};

fn root(label: &str) -> PathBuf {
    let root = unique_temp_path(&format!("soreno-conversation-{label}"));
    std::fs::create_dir_all(&root).unwrap();
    root
}
fn fixture(root: &Path, executable: &str) -> (Connection, AgentProject, AgentSession) {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);").unwrap();
    initialize(&db).unwrap();
    let project = AgentProject {
        id: "project".into(),
        name: "Project".into(),
        path: root.to_string_lossy().into(),
        environment: AgentEnvironment {
            kind: "local".into(),
            distribution: None,
            ssh: None,
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };
    let session = AgentSession {
        id: "agent".into(),
        project_id: project.id.clone(),
        name: "Agent".into(),
        custom_name: None,
        kind: "terminal".into(),
        service_id: None,
        working_directory: None,
        executable: executable.into(),
        args: vec!["--version".into()],
        created_at: "2026-01-01T00:00:00Z".into(),
        favorite: false,
        design: false,
    };
    db.execute(
        "INSERT INTO agent_sessions(id,data) VALUES (?1,?2)",
        params![session.id, serde_json::to_string(&session).unwrap()],
    )
    .unwrap();
    session_saved(&db, None, &session).unwrap();
    (db, project, session)
}
fn observe(record: &ConversationRecord, provider: &str, id: &str, file: &Path, name: &str) {
    std::fs::write(
        record.metadata_path.as_ref().unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "version": 1, "runId": record.run_id, "provider": provider,
            "sessionId": id, "sessionFile": file.to_string_lossy(), "name": name, "error": null,
        }))
        .unwrap(),
    )
    .unwrap();
}
fn observe_working(
    record: &ConversationRecord,
    provider: &str,
    id: &str,
    file: &Path,
    working: serde_json::Value,
) {
    std::fs::write(
        record.metadata_path.as_ref().unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "version": 1, "runId": record.run_id, "provider": provider,
            "sessionId": id, "sessionFile": file.to_string_lossy(), "name": "Agent",
            "working": working, "error": null,
        }))
        .unwrap(),
    )
    .unwrap();
}
fn history(path: &Path, provider: &str, id: &str) {
    let header = serde_json::json!({"type": "session", "id": id});
    std::fs::write(
        path,
        if provider == "omp" {
            format!(
                "{}\n{header}\n",
                serde_json::json!({
                    "type": "title", "v": 1, "title": "Conversation",
                    "updatedAt": "2026-01-01T00:00:00Z", "pad": " ", "source": "auto"
                })
            )
        } else {
            format!("{header}\n")
        },
    )
    .unwrap();
}

fn osc(run_id: &str, metadata: &serde_json::Value) -> Vec<u8> {
    format!(
        "\x1b]777;soreno;{run_id};{}\x07",
        STANDARD.encode(serde_json::to_vec(metadata).unwrap())
    )
    .into_bytes()
}

#[test]
fn remote_metadata_parser_filters_split_osc_and_updates_local_sidecar() {
    let root = root("osc");
    let path = root.join("metadata.json");
    let run_id = "0123456789abcdef0123456789abcdef";
    let mut parser =
        RemoteMetadataParser::new(run_id.into(), path.clone(), Arc::new(Mutex::new(0)));
    let metadata = |name: &str| {
        serde_json::json!({
            "version": 1, "runId": run_id, "provider": "pi",
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sessionFile": "/home/me/session.jsonl", "name": name, "working": true,
            "error": null,
        })
    };
    let mut stream = b"avant \xe2\x82\xac".to_vec();
    stream.extend(osc(run_id, &metadata("Premier")));
    stream.extend_from_slice(b" apres");
    let mut visible = Vec::new();
    for chunk in stream.chunks(1) {
        visible.extend(parser.push(chunk));
    }
    visible.extend(parser.finish());
    assert_eq!(visible, "avant € apres".as_bytes());
    let sidecar: Sidecar = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(sidecar.name.as_deref(), Some("Premier"));
    assert_eq!(sidecar.working, Some(true));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    assert!(parser
        .push(&osc(run_id, &metadata("Nouveau titre")))
        .is_empty());
    let sidecar: Sidecar = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(sidecar.name.as_deref(), Some("Nouveau titre"));

    let mut legacy = b"\x1b]777;so".to_vec();
    legacy.extend_from_slice(LEGACY_OSC_PREFIX);
    legacy.extend_from_slice(&osc(run_id, &metadata("Ancien pont"))[OSC_PREFIX.len()..]);
    let visible: Vec<u8> = legacy
        .chunks(1)
        .flat_map(|chunk| parser.push(chunk))
        .collect();
    assert_eq!(visible, b"\x1b]777;so");
    let sidecar: Sidecar = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(sidecar.name.as_deref(), Some("Ancien pont"));

    let before = std::fs::read(&path).unwrap();
    assert!(parser
        .push(&osc(
            "ffffffffffffffffffffffffffffffff",
            &metadata("Étranger")
        ))
        .is_empty());
    let mut oversized = OSC_PREFIX.to_vec();
    oversized.extend_from_slice(run_id.as_bytes());
    oversized.push(b';');
    oversized.extend(std::iter::repeat_n(b'x', OSC_PAYLOAD_LIMIT + 1));
    oversized.extend_from_slice(b"\x07visible");
    assert_eq!(parser.push(&oversized), b"visible");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let hook = serde_json::json!({
        "version": 1,
        "runId": run_id,
        "provider": "codex",
        "payload": {
            "hook_event_name": "SessionStart",
            "session_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "transcript_path": null,
            "cwd": root.to_string_lossy(),
            "source": "startup"
        }
    });
    assert!(parser.push(&osc(run_id, &hook)).is_empty());
    let hook_sidecar = parse_sidecar(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(hook_sidecar.provider, "codex");
    assert_eq!(hook_sidecar.session_file, None);

    assert!(parser.push(b"\x1b]777;soreno;").is_empty());
    assert_eq!(parser.finish(), b"");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn replayed_metadata_frames_are_hidden_without_overwriting_newer_state() {
    let root = root("osc-history");
    let path = root.join("metadata.json");
    let run_id = "0123456789abcdef0123456789abcdef";
    let generation = Arc::new(Mutex::new(0));
    let mut parser =
        RemoteMetadataParser::new(run_id.into(), path.clone(), Arc::clone(&generation));
    let metadata = |working: bool| {
        serde_json::json!({
            "version": 1, "runId": run_id, "provider": "pi",
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sessionFile": "/home/me/session.jsonl", "working": working, "error": null,
        })
    };
    std::fs::write(&path, serde_json::to_vec(&metadata(false)).unwrap()).unwrap();
    let mut replay = b"old".to_vec();
    replay.extend(osc(run_id, &metadata(true)));
    let split = replay.len() - 3;
    assert_eq!(parser.push_history(&replay[..split]), b"old");
    assert!(parser.push_history(&replay[split..]).is_empty());
    assert_eq!(*generation.lock().unwrap(), 0);
    let sidecar: Sidecar = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(sidecar.working, Some(false));

    // A frame the program was writing when the client attached ends live and applies.
    let live = osc(run_id, &metadata(true));
    assert!(parser.push_history(&live[..10]).is_empty());
    assert_eq!(parser.push(&live[10..]), b"");
    let sidecar: Sidecar = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(sidecar.working, Some(true));
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn missing_remote_sidecar_is_distinct_from_an_invalid_file_type() {
    let root = root("remote-sidecar-read");
    let path = root.join("metadata.json");
    let run = |path: &Path| {
        std::process::Command::new("sh")
            .args(["-c", &remote_sidecar_script(path.to_str().unwrap())])
            .output()
            .unwrap()
    };

    let missing = run(&path);
    assert!(missing.status.success());
    assert_eq!(parse_remote_sidecar(missing.stdout).unwrap(), None);

    std::fs::create_dir(&path).unwrap();
    let invalid = run(&path);
    assert!(invalid.status.success());
    assert!(parse_remote_sidecar(invalid.stdout).is_err());

    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, b"sidecar").unwrap();
    let present = run(&path);
    assert!(present.status.success());
    assert_eq!(
        parse_remote_sidecar(present.stdout).unwrap(),
        Some(b"sidecar".to_vec())
    );

    let inaccessible = run(&root.join("missing/metadata.json"));
    assert!(!inaccessible.status.success());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cached_ssh_reconcile_links_valid_sidecar_without_verifying_history() {
    let root = root("cached-ssh-link");
    let links = root.join("links");
    let (db, mut project, session) = fixture(&root, "pi");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    observe(
        &record,
        "pi",
        id,
        Path::new("/home/alice/session.jsonl"),
        "Remote",
    );
    project.path = "/srv/project".into();
    project.environment = AgentEnvironment {
        kind: "ssh".into(),
        distribution: None,
        ssh: None,
    };

    reconcile_cached(&db, &session, &project, true).unwrap();

    let linked = fields(&db, &session).unwrap();
    assert_eq!(linked.resume, "linked");
    assert_eq!(linked.conversation.unwrap().session_id, id);
    assert!(!get(&db, &session.id).unwrap().unwrap().history_verified);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn remote_sidecar_refresh_rejects_another_run_or_provider() {
    let root = root("remote-refresh");
    let path = root.join("metadata.json");
    let sidecar = |run_id: &str, provider: &str| {
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "runId": run_id,
            "provider": provider,
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sessionFile": "/home/me/session.jsonl",
            "name": "Agent",
            "working": true,
            "error": null,
        }))
        .unwrap()
    };
    let current = sidecar("current", "pi");
    store_sidecar(&path, "current", Some("pi"), &current).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), current);

    assert!(store_sidecar(&path, "stale", Some("pi"), &sidecar("current", "pi")).is_err());
    assert!(store_sidecar(&path, "current", Some("codex"), &sidecar("current", "pi")).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), current);
    std::fs::remove_dir_all(root).unwrap();
}

fn remote_sidecar_pair(
    record: &ConversationRecord,
    project: &AgentProject,
    generation: Arc<Mutex<u64>>,
) -> (RemoteMetadataParser, RemoteSidecarSync) {
    remote_channels(
        project,
        record.provider.clone(),
        record.run_id.clone().unwrap(),
        PathBuf::from(record.metadata_path.as_ref().unwrap()),
        record.remote_metadata_path.clone().unwrap(),
        generation,
    )
    .unwrap()
}

#[test]
fn remote_sidecar_sync_replaces_a_stale_working_state() {
    let root = root("remote-working-refresh");
    let links = root.join("links");
    let (db, mut project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let mut record = get(&db, &session.id).unwrap().unwrap();
    record.remote_metadata_path = Some("/home/me/metadata.json".into());
    project.environment = AgentEnvironment {
        kind: "ssh".into(),
        distribution: None,
        ssh: Some(crate::ssh::SshConnection {
            host: "example.test".into(),
            user: None,
            port: None,
            identity_file: None,
            host_key: None,
        }),
    };
    let payload = |event: &str| {
        serde_json::json!({
            "hook_event_name": event,
            "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "transcript_path": null,
            "cwd": root
        })
    };
    let (mut parser, sync) = remote_sidecar_pair(&record, &project, Arc::new(Mutex::new(0)));
    let working = serde_json::json!({
        "version": 1,
        "runId": record.run_id,
        "provider": "claude",
        "payload": payload("UserPromptSubmit")
    });
    assert!(parser
        .push(&osc(record.run_id.as_deref().unwrap(), &working))
        .is_empty());
    let generation = sync.capture_generation_if_working().unwrap().unwrap();

    let stopped = serde_json::json!({
        "version": 1,
        "runId": record.run_id,
        "provider": "claude",
        "payload": payload("Stop")
    });
    sync.install_if_generation(generation, stopped.to_string().as_bytes())
        .unwrap();
    assert!(sync.capture_generation_if_working().unwrap().is_none());
    assert_eq!(
        parse_sidecar(&std::fs::read(record.metadata_path.unwrap()).unwrap())
            .unwrap()
            .working,
        Some(false)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn remote_sidecar_sync_does_not_replace_a_new_osc_generation() {
    let root = root("remote-working-race");
    let links = root.join("links");
    let (db, mut project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let mut record = get(&db, &session.id).unwrap().unwrap();
    record.remote_metadata_path = Some("/home/me/metadata.json".into());
    project.environment = AgentEnvironment {
        kind: "ssh".into(),
        distribution: None,
        ssh: Some(crate::ssh::SshConnection {
            host: "example.test".into(),
            user: None,
            port: None,
            identity_file: None,
            host_key: None,
        }),
    };
    let payload = |event: &str| {
        serde_json::json!({
            "hook_event_name": event,
            "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "transcript_path": null,
            "cwd": root
        })
    };
    let (mut parser, sync) = remote_sidecar_pair(&record, &project, Arc::new(Mutex::new(0)));
    let working = serde_json::json!({
        "version": 1,
        "runId": record.run_id,
        "provider": "claude",
        "payload": payload("UserPromptSubmit")
    });
    let working_osc = osc(record.run_id.as_deref().unwrap(), &working);
    assert!(parser.push(&working_osc).is_empty());
    let stale_generation = sync.capture_generation_if_working().unwrap().unwrap();
    assert!(parser.push(&working_osc).is_empty());
    assert_ne!(
        sync.capture_generation_if_working().unwrap(),
        Some(stale_generation)
    );

    let stopped = serde_json::json!({
        "version": 1,
        "runId": record.run_id,
        "provider": "claude",
        "payload": payload("Stop")
    });
    sync.install_if_generation(stale_generation, stopped.to_string().as_bytes())
        .unwrap();
    assert_eq!(
        parse_sidecar(&std::fs::read(record.metadata_path.unwrap()).unwrap())
            .unwrap()
            .working,
        Some(true)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn remote_sidecar_refresh_with_identical_bytes_is_not_a_new_report() {
    let root = root("remote-identical-refresh");
    let links = root.join("links");
    let (db, mut project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let mut record = get(&db, &session.id).unwrap().unwrap();
    record.remote_metadata_path = Some("/home/me/metadata.json".into());
    project.environment = AgentEnvironment {
        kind: "ssh".into(),
        distribution: None,
        ssh: Some(crate::ssh::SshConnection {
            host: "example.test".into(),
            user: None,
            port: None,
            identity_file: None,
            host_key: None,
        }),
    };
    let (_, sync) = remote_sidecar_pair(&record, &project, Arc::new(Mutex::new(0)));
    let path = PathBuf::from(record.metadata_path.as_ref().unwrap());
    let sidecar = |event: &str| {
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "runId": record.run_id,
            "provider": "claude",
            "payload": {
                "hook_event_name": event,
                "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "transcript_path": null,
                "cwd": root
            }
        }))
        .unwrap()
    };
    let run_id = record.run_id.as_deref().unwrap();
    store_sidecar(&path, run_id, Some("claude"), &sidecar("UserPromptSubmit")).unwrap();
    let old = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let modified = || std::fs::metadata(&path).unwrap().modified().unwrap();

    sync.install_if_generation(0, &sidecar("UserPromptSubmit"))
        .unwrap();
    assert_eq!(modified(), old);
    sync.install_if_generation(0, &sidecar("Stop")).unwrap();
    assert_ne!(modified(), old);
    assert_eq!(
        parse_sidecar(&std::fs::read(&path).unwrap())
            .unwrap()
            .working,
        Some(false)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn attach_reuses_generation_and_rejects_the_previous_sync_response() {
    let root = root("remote-attach-race");
    let links = root.join("links");
    let (db, mut project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let mut record = get(&db, &session.id).unwrap().unwrap();
    record.remote_metadata_path = Some("/home/me/metadata.json".into());
    project.environment = AgentEnvironment {
        kind: "ssh".into(),
        distribution: None,
        ssh: Some(crate::ssh::SshConnection {
            host: "example.test".into(),
            user: None,
            port: None,
            identity_file: None,
            host_key: None,
        }),
    };
    let payload = |event: &str| {
        serde_json::json!({
            "hook_event_name": event,
            "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "transcript_path": null,
            "cwd": root
        })
    };
    let generation = Arc::new(Mutex::new(0));
    let (mut old_parser, old_sync) =
        remote_sidecar_pair(&record, &project, Arc::clone(&generation));
    let working = serde_json::json!({
        "version": 1,
        "runId": record.run_id,
        "provider": "claude",
        "payload": payload("UserPromptSubmit")
    });
    assert!(old_parser
        .push(&osc(record.run_id.as_deref().unwrap(), &working))
        .is_empty());
    let stale_generation = old_sync.capture_generation_if_working().unwrap().unwrap();

    let attached_generation = attach_generation(Some(Arc::clone(&generation))).unwrap();
    assert!(Arc::ptr_eq(&generation, &attached_generation));
    let (mut new_parser, _new_sync) = remote_sidecar_pair(&record, &project, attached_generation);
    assert!(new_parser
        .push(&osc(record.run_id.as_deref().unwrap(), &working))
        .is_empty());

    let stopped = serde_json::json!({
        "version": 1,
        "runId": record.run_id,
        "provider": "claude",
        "payload": payload("Stop")
    });
    old_sync
        .install_if_generation(stale_generation, stopped.to_string().as_bytes())
        .unwrap();
    assert_eq!(
        parse_sidecar(&std::fs::read(record.metadata_path.unwrap()).unwrap())
            .unwrap()
            .working,
        Some(true)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn provider_and_arguments_are_classified_per_cli() {
    for (executable, expected) in [
        ("/usr/local/bin/PI", Some(Provider::Pi)),
        (r"C:\tools\omp.exe", Some(Provider::Omp)),
        (r"C:\tools\PI.PS1", Some(Provider::Pi)),
        (r"C:\tools\OmP.ps1", Some(Provider::Omp)),
        ("/opt/Claude", Some(Provider::Claude)),
        (r"C:\tools\CODEX.exe", Some(Provider::Codex)),
        ("pi.cmd", None),
        ("omp.bat", None),
        ("pilot", None),
    ] {
        assert_eq!(provider(executable), expected, "{executable}");
    }
    for (provider, arg) in [
        (Provider::Pi, "--resume"),
        (Provider::Pi, "--resume=x"),
        (Provider::Pi, "-r"),
        (Provider::Pi, "-r=x"),
        (Provider::Pi, "--session=x"),
        (Provider::Pi, "--session-id=x"),
        (Provider::Pi, "--print"),
        (Provider::Pi, "-p"),
        (Provider::Pi, "-p=x"),
        (Provider::Omp, "--from-claude"),
        (Provider::Omp, "--from-codex=x"),
        (Provider::Omp, "--no-extensions"),
        (Provider::Omp, "--trusted-extension=other"),
        (Provider::Omp, "--fork"),
    ] {
        assert!(
            validate_args(&[arg.into()], provider, false).is_err(),
            "{arg}"
        );
    }
    for (provider, args) in [
        (
            Provider::Pi,
            vec![
                "--tools".into(),
                "read".into(),
                "--system-prompt".into(),
                "text".into(),
                "--append-system-prompt=more".into(),
                "--session-dir".into(),
                "/tmp/sessions".into(),
            ],
        ),
        (
            Provider::Omp,
            vec![
                "--tools".into(),
                "read".into(),
                "--config".into(),
                "settings.yml".into(),
                "--session-dir=/tmp/sessions".into(),
            ],
        ),
    ] {
        assert!(validate_args(&args, provider, true).is_ok(), "{args:?}");
    }
    assert!(validate_args(
        &["--system-prompt".into(), "--literal-value".into()],
        Provider::Pi,
        true
    )
    .is_ok());
    assert!(validate_args(
        &["--model".into(), "--literal-value".into()],
        Provider::Omp,
        true
    )
    .is_err());
    for arg in ["--sessionids=x", "-unknown", "prompt"] {
        assert!(
            validate_args(&[arg.into()], Provider::Pi, true).is_err(),
            "{arg}"
        );
    }
}

fn observe_hook(record: &ConversationRecord, provider: &str, payload: serde_json::Value) {
    std::fs::write(
        record.metadata_path.as_ref().unwrap(),
        serde_json::json!({
            "version": 1,
            "runId": record.run_id,
            "provider": provider,
            "payload": payload,
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn hook_cli_arguments_handle_variadics_and_protected_short_forms() {
    let claude = [
        "--add-dir",
        "/first",
        "/second",
        "--allowedTools",
        "Read",
        "Bash",
        "--betas",
        "beta-one",
        "beta-two",
        "--disallowed-tools",
        "Write",
        "Edit",
        "--file",
        "one.txt",
        "two.txt",
        "--mcp-config",
        "one.json",
        "two.json",
        "--tools",
        "Read",
        "Bash",
        "--model",
        "sonnet",
    ]
    .map(str::to_string);
    assert!(validate_args(&claude, Provider::Claude, true).is_ok());
    assert!(validate_args(
        &["--model".into(), "sonnet".into(), "real prompt".into()],
        Provider::Claude,
        true
    )
    .is_err());
    for arg in [
        "-rsession",
        "-r=session",
        "-canything",
        "-c=true",
        "-pc",
        "-cp",
        "-prbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ] {
        assert!(
            validate_args(&[arg.into()], Provider::Claude, false).is_err(),
            "{arg}"
        );
    }
    assert!(validate_args(
        &["--from-pr".into(), "--continue".into(), "-p".into()],
        Provider::Claude,
        false
    )
    .is_err());
    for arg in ["-p", "-narchive", "-dcontinue", "-pnarchive", "-dp"] {
        assert!(
            validate_args(&[arg.into()], Provider::Claude, false).is_ok(),
            "{arg}"
        );
    }

    for args in [
        vec!["-chooks.SessionStart=[]".into()],
        vec!["-cfeatures={}".into()],
        vec!["-cfeatures.hooks=false".into()],
        vec!["-c".into(), "hooks={}".into()],
        vec!["--config".into(), "features.hooks_extra=false".into()],
        vec!["--config=hooks.SessionEnd=[]".into()],
        vec!["--config=features.\"hooks\"=false".into()],
        vec!["--disable=hooks".into()],
    ] {
        assert!(
            validate_args(&args, Provider::Codex, false).is_err(),
            "{args:?}"
        );
    }
    for args in [
        vec!["-cfeatures.foo=true".into()],
        vec!["-c".into(), "features.foo=true".into()],
        vec!["--config=features.foo=true".into()],
    ] {
        assert!(
            validate_args(&args, Provider::Codex, false).is_ok(),
            "{args:?}"
        );
    }
}

#[test]
fn hook_payloads_are_normalized_without_changing_pi_sidecars() {
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let start = parse_sidecar(
        serde_json::json!({
            "version": 1,
            "runId": "run",
            "provider": "claude",
            "payload": {
                "hook_event_name": "SessionStart",
                "session_id": id,
                "transcript_path": "/tmp/claude.jsonl",
                "source": "resume",
                "cwd": cwd
            }
        })
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(start.session_id.as_deref(), Some(id));
    assert_eq!(start.session_file.as_deref(), Some("/tmp/claude.jsonl"));
    assert_eq!(start.source.as_deref(), Some("resume"));

    let end = parse_sidecar(
        serde_json::json!({
            "version": 1,
            "runId": "run",
            "provider": "codex",
            "payload": {
                "hook_event_name": "SessionEnd",
                "session_id": id,
                "transcript_path": null,
                "cwd": cwd,
                "reason": "other"
            }
        })
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(end.session_file, None);
    assert_eq!(end.source, None);

    let pi = parse_sidecar(
        serde_json::json!({
            "version": 1,
            "runId": "run",
            "provider": "pi",
            "sessionId": id,
            "sessionFile": "/tmp/pi.jsonl",
            "name": null,
            "error": null
        })
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(pi.session_file.as_deref(), Some("/tmp/pi.jsonl"));
    assert_eq!(pi.source, None);
}

#[test]
fn claude_and_codex_hooks_report_live_turn_activity() {
    let root = root("hook-working");
    let links = root.join("links");
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (provider, stop_event) in [("claude", "StopFailure"), ("codex", "Stop")] {
        let case_root = root.join(provider);
        std::fs::create_dir(&case_root).unwrap();
        let (db, project, session) = fixture(&case_root, provider);
        prepare_launch(&db, &links, &session, &project, None).unwrap();
        let record = get(&db, &session.id).unwrap().unwrap();
        let payload = |event: &str| {
            serde_json::json!({
                "hook_event_name": event,
                "session_id": id,
                "transcript_path": null,
                "cwd": project.path,
                "source": if event == "SessionStart" { Some("startup") } else { None }
            })
        };

        observe_hook(&record, provider, payload("SessionStart"));
        assert_eq!(
            reconcile(&db, &session, &project, true).unwrap().working,
            None
        );
        observe_hook(&record, provider, payload("UserPromptSubmit"));
        assert_eq!(
            reconcile(&db, &session, &project, true).unwrap().working,
            Some(true)
        );
        observe_hook(&record, provider, payload(stop_event));
        assert_eq!(
            reconcile(&db, &session, &project, true).unwrap().working,
            Some(false)
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_hooks_use_in_memory_scripts_and_short_quote_safe_arguments() {
    let root = root("windows-hook");
    let settings_path = root.join("claude-settings.json");
    let commands = hook_commands(true);
    write_claude_settings(&settings_path, &commands).unwrap();

    for (command, event) in commands
        .iter()
        .zip(["start", "end", "working", "idle", "awaiting"])
    {
        let encoded = command.rsplit_once(' ').unwrap().1;
        let bytes = STANDARD.decode(encoded).unwrap();
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let runner = String::from_utf16(&words).unwrap();
        assert!(runner.ends_with(&format!(")) {event}")));
    }
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
    assert_eq!(
        settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
        commands[0]
    );
    assert_eq!(
        settings["hooks"]["SessionEnd"][0]["hooks"][0]["command"],
        commands[1]
    );
    assert_eq!(
        settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
        commands[2]
    );
    for event in ["Stop", "StopFailure"] {
        assert_eq!(
            settings["hooks"][event][0]["hooks"][0]["command"],
            commands[3]
        );
    }
    for (event, matcher) in [
        ("PermissionRequest", None),
        ("PreToolUse", Some("AskUserQuestion|ExitPlanMode")),
        (
            "Notification",
            Some("permission_prompt|elicitation_dialog|elicitation_url_dialog"),
        ),
    ] {
        let hook = &settings["hooks"][event][0];
        assert_eq!(hook["hooks"][0]["command"], commands[4]);
        assert_eq!(hook["matcher"].as_str(), matcher);
    }

    let claude_args = [
        "--settings".to_string(),
        settings_path.to_string_lossy().into_owned(),
        "a modest prompt".into(),
    ];
    let mut codex_args = codex_hook_args(&commands, true);
    codex_args.push("a modest prompt".into());
    for args in [&claude_args[..], &codex_args[..]] {
        assert!(args.iter().all(|arg| !arg.contains('"')), "{args:?}");
        assert!(super::super::legacy_powershell_args_safe(args));
    }
    for (event, command) in [
        ("SessionStart", &commands[0]),
        ("SessionEnd", &commands[1]),
        ("UserPromptSubmit", &commands[2]),
        ("Stop", &commands[3]),
        ("PermissionRequest", &commands[4]),
    ] {
        assert!(codex_args.iter().any(
            |arg| arg.starts_with(&format!("hooks.{event}=")) && arg.contains(command.as_str())
        ));
    }
    assert!(!root.join("conversation-hook.ps1").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
fn posix_hook_status(
    command: &str,
    record: &ConversationRecord,
    provider: &str,
    payload: serde_json::Value,
    output: Option<&Path>,
    extra_environment: &[(&str, &str)],
) -> std::process::ExitStatus {
    let script = format!("printf '%s' \"$PAYLOAD\" | {command}");
    let mut process = std::process::Command::new("sh");
    process
        .args(["-c", &script])
        .env("PAYLOAD", payload.to_string())
        .env(
            "SORENO_CONVERSATION_RUN_ID",
            record.run_id.as_ref().unwrap(),
        )
        .env("SORENO_CONVERSATION_PROVIDER", provider)
        .env(
            "SORENO_CONVERSATION_METADATA",
            record.metadata_path.as_ref().unwrap(),
        )
        .env(
            "SORENO_CONVERSATION_HOOK",
            Path::new(record.metadata_path.as_ref().unwrap())
                .parent()
                .unwrap()
                .join("conversation-hook.sh"),
        )
        .env(
            "SORENO_CONVERSATION_REMOTE",
            if output.is_some() { "1" } else { "0" },
        );
    if let Some(output) = output {
        process.env("SORENO_CONVERSATION_OUTPUT", output);
    }
    process.envs(extra_environment.iter().copied());
    process.status().unwrap()
}

#[cfg(unix)]
fn run_posix_hook(
    command: &str,
    record: &ConversationRecord,
    provider: &str,
    payload: serde_json::Value,
    output: Option<&Path>,
    extra_environment: &[(&str, &str)],
) {
    let status = posix_hook_status(
        command,
        record,
        provider,
        payload,
        output,
        extra_environment,
    );
    assert!(status.success());
}

#[cfg(unix)]
#[test]
fn unwritable_hook_outputs_never_block_the_agent() {
    let root = root("hook-unwritable");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let missing = root.join("missing");
    let missing_metadata = missing.join("metadata.json");
    let missing_terminal = missing.join("tty");
    let commands = hook_commands(false);
    for provider in ["claude", "codex"] {
        for (command, event) in [
            (&commands[0], "SessionStart"),
            (&commands[2], "UserPromptSubmit"),
            (&commands[3], "Stop"),
        ] {
            let payload = serde_json::json!({
                "hook_event_name": event,
                "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "cwd": project.path,
            });
            let unwritable_metadata = posix_hook_status(
                command,
                &record,
                provider,
                payload.clone(),
                None,
                &[(
                    "SORENO_CONVERSATION_METADATA",
                    missing_metadata.to_str().unwrap(),
                )],
            );
            assert_eq!(unwritable_metadata.code(), Some(0), "{provider} {event}");
            let unwritable_terminal = posix_hook_status(
                command,
                &record,
                provider,
                payload,
                Some(&missing_terminal),
                &[],
            );
            assert_eq!(unwritable_terminal.code(), Some(0), "{provider} {event}");
            // RLIMIT_FSIZE 0 with SIGXFSZ ignored: tmp files are created but every write fails.
            let metadata = Path::new(record.metadata_path.as_ref().unwrap());
            let identity = metadata.with_extension("json.identity");
            std::fs::write(metadata, "{\"valid\":\"metadata\"}").unwrap();
            std::fs::write(&identity, "{\"valid\":\"identity\"}").unwrap();
            let full_disk = posix_hook_status(
                &format!("{{ trap '' XFSZ; ulimit -f 0; {command}; }}"),
                &record,
                provider,
                serde_json::json!({
                    "hook_event_name": event,
                    "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "cwd": project.path,
                }),
                None,
                &[],
            );
            assert_eq!(full_disk.code(), Some(0), "{provider} {event}");
            assert_eq!(
                std::fs::read_to_string(metadata).unwrap(),
                "{\"valid\":\"metadata\"}",
                "{provider} {event}"
            );
            assert_eq!(
                std::fs::read_to_string(&identity).unwrap(),
                "{\"valid\":\"identity\"}",
                "{provider} {event}"
            );
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn compact_session_start_preserves_active_turn_and_updates_identity() {
    let root = root("hook-activity");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let payload = |event: &str, source: Option<&str>| {
        let mut payload = serde_json::json!({
            "hook_event_name": event,
            "session_id": id,
            "transcript_path": null,
            "cwd": project.path,
        });
        if let Some(source) = source {
            payload["source"] = source.into();
        }
        payload
    };
    let commands = hook_commands(false);

    run_posix_hook(
        &commands[0],
        &record,
        "claude",
        payload("SessionStart", Some("startup")),
        None,
        &[],
    );
    run_posix_hook(
        &commands[2],
        &record,
        "claude",
        payload("UserPromptSubmit", None),
        None,
        &[],
    );
    let working =
        parse_sidecar(&std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap()).unwrap();
    assert_eq!(working.working, Some(true));
    assert_eq!(working.source.as_deref(), Some("startup"));

    run_posix_hook(
        &commands[0],
        &record,
        "claude",
        payload("SessionStart", Some("compact")),
        None,
        &[],
    );
    let compact =
        parse_sidecar(&std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap()).unwrap();
    assert_eq!(compact.working, Some(true));
    assert_eq!(compact.source.as_deref(), Some("compact"));

    run_posix_hook(
        &commands[3],
        &record,
        "claude",
        payload("Stop", None),
        None,
        &[],
    );
    let idle =
        parse_sidecar(&std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap()).unwrap();
    assert_eq!(idle.working, Some(false));
    assert_eq!(idle.source.as_deref(), Some("compact"));

    let stop_with = |task_type: &str, description: &str| {
        let mut stop = payload("Stop", None);
        stop["background_tasks"] = serde_json::json!([
            {"id": "t1", "type": task_type, "status": "running", "description": description},
        ]);
        run_posix_hook(&commands[3], &record, "claude", stop, None, &[]);
        parse_sidecar(&std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap())
            .unwrap()
            .working
    };
    assert_eq!(stop_with("subagent", "Explore"), Some(true));
    assert_eq!(stop_with("workflow", "ideation"), Some(true));
    assert_eq!(stop_with("cloud session", "remote"), Some(true));
    assert_eq!(stop_with("shell", r#""type": "subagent""#), Some(false));
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn hooks_publish_bounded_turns_and_awaited_replies() {
    let root = root("hook-summary");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "codex");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let osc_path = root.join("hook.osc");
    let payload = |event: &str, message: Option<&str>| {
        serde_json::json!({
            "hook_event_name": event,
            "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "transcript_path": null,
            "cwd": project.path,
            "source": if event == "SessionStart" { Some("startup") } else { None },
            "last_assistant_message": message,
        })
    };
    let commands = hook_commands(false);
    let stop = |message: &str| {
        run_posix_hook(
            &commands[3],
            &record,
            "codex",
            payload("Stop", Some(message)),
            Some(&osc_path),
            &[],
        );
        reconcile(&db, &session, &project, true).unwrap()
    };
    run_posix_hook(
        &commands[0],
        &record,
        "codex",
        payload("SessionStart", None),
        None,
        &[],
    );

    let message = "Done.\n<soreno-summary>Fixed \"it\" in `a.rs`</soreno-summary>";
    let first = stop(message);
    assert_eq!(first.working, Some(false));
    let turn = first.turn.unwrap();
    assert_eq!(turn.message.as_deref(), Some(message));
    // summary_id is a global key: remote hosts can share second and PID.
    assert!(turn
        .id
        .starts_with(&format!("{}-", record.run_id.as_ref().unwrap())));
    // SSH delivers the same sidecar through the private OSC frame.
    let frame = std::fs::read(&osc_path).unwrap();
    let encoded = frame
        .strip_prefix(format!("\x1b]777;soreno;{};", record.run_id.as_ref().unwrap()).as_bytes())
        .and_then(|rest| rest.strip_suffix(b"\x07"))
        .unwrap();
    assert_eq!(
        STANDARD.decode(encoded).unwrap(),
        std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap()
    );
    assert_ne!(stop(message).turn.unwrap().id, turn.id);

    let question = "Which file should I edit?";
    let ordinary = stop(question).turn.unwrap();
    assert_eq!(ordinary.message.as_deref(), Some(question));
    assert_ne!(ordinary.id, turn.id);
    let oversized = format!("{}<soreno-summary>x</soreno-summary>", "a".repeat(40_000));
    let skipped = stop(&oversized);
    assert_eq!(skipped.working, Some(false));
    assert_eq!(skipped.turn, None);

    for (command, event, working, awaiting) in [
        (&commands[2], "UserPromptSubmit", Some(true), false),
        (&commands[4], "PermissionRequest", Some(true), true),
        (&commands[2], "UserPromptSubmit", Some(true), false),
        (&commands[4], "PreToolUse", Some(true), true),
        (&commands[3], "Stop", Some(false), false),
    ] {
        run_posix_hook(command, &record, "codex", payload(event, None), None, &[]);
        let activity = reconcile(&db, &session, &project, true).unwrap();
        assert_eq!(
            (activity.working, activity.awaiting),
            (working, awaiting),
            "{event}"
        );
    }
    // SSH installs only changed bytes: a repeated prompt must still refresh the copy.
    let metadata = record.metadata_path.as_ref().unwrap();
    let awaited = || {
        run_posix_hook(
            &commands[4],
            &record,
            "codex",
            payload("PermissionRequest", None),
            None,
            &[],
        );
        std::fs::read(metadata).unwrap()
    };
    assert_ne!(awaited(), awaited());
    assert!(reconcile(&db, &session, &project, true).unwrap().awaiting);
    // Without a saved SessionStart identity the hook writes the raw event.
    std::fs::remove_file(format!("{metadata}.identity")).unwrap();
    assert_ne!(awaited(), awaited());
    assert!(reconcile(&db, &session, &project, true).unwrap().awaiting);
    run_posix_hook(
        &commands[4],
        &record,
        "codex",
        payload("Notification", None),
        None,
        &[],
    );
    assert!(
        !reconcile(&db, &session, &project, false).unwrap().awaiting,
        "an exited agent awaits nothing"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn session_end_preserves_a_start_transition_until_reconcile() {
    let root = root("hook-transition");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let first = get(&db, &session.id).unwrap().unwrap();
    let first_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let second_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let payload = |event: &str, id: &str, source: Option<&str>| {
        let mut payload = serde_json::json!({
            "hook_event_name": event,
            "session_id": id,
            "transcript_path": null,
            "cwd": project.path,
        });
        if let Some(source) = source {
            payload["source"] = source.into();
        }
        payload
    };
    let commands = hook_commands(false);
    run_posix_hook(
        &commands[0],
        &first,
        "claude",
        payload("SessionStart", first_id, Some("startup")),
        None,
        &[],
    );
    reconcile(&db, &session, &project, false).unwrap();

    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let transition = get(&db, &session.id).unwrap().unwrap();
    let osc_path = root.join("hook.osc");
    run_posix_hook(
        &commands[0],
        &transition,
        "claude",
        payload("SessionStart", second_id, Some("clear")),
        Some(&osc_path),
        &[],
    );
    let start_osc = std::fs::read(&osc_path).unwrap();
    run_posix_hook(
        &commands[1],
        &transition,
        "claude",
        payload("SessionEnd", second_id, None),
        Some(&osc_path),
        &[],
    );
    assert_eq!(std::fs::read(&osc_path).unwrap(), start_osc);
    reconcile(&db, &session, &project, false).unwrap();
    let linked = fields(&db, &session).unwrap();
    assert_eq!(linked.conversation.unwrap().session_id, second_id);
    assert!(linked.error.is_none());

    let first_end_root = root.join("first-end");
    std::fs::create_dir(&first_end_root).unwrap();
    let (end_db, end_project, end_session) = fixture(&first_end_root, "codex");
    prepare_launch(&end_db, &links, &end_session, &end_project, None).unwrap();
    let first_end = get(&end_db, &end_session.id).unwrap().unwrap();
    run_posix_hook(
        &commands[1],
        &first_end,
        "codex",
        serde_json::json!({
            "hook_event_name": "SessionEnd",
            "session_id": first_id,
            "transcript_path": null,
            "cwd": end_project.path,
        }),
        None,
        &[],
    );
    reconcile(&end_db, &end_session, &end_project, false).unwrap();
    assert_eq!(
        fields(&end_db, &end_session)
            .unwrap()
            .conversation
            .unwrap()
            .session_id,
        first_id
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn child_agent_hooks_do_not_replace_root_metadata() {
    let root = root("child-hooks");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let command = &hook_commands(false)[0];
    let payload = |id: &str| {
        serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": id,
            "transcript_path": null,
            "cwd": project.path,
            "source": "startup"
        })
    };
    run_posix_hook(
        command,
        &record,
        "claude",
        payload("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        None,
        &[],
    );
    let metadata = std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap();
    run_posix_hook(
        command,
        &record,
        "claude",
        payload("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        None,
        &[("CLAUDE_JOB_DIR", "/tmp/child")],
    );
    assert_eq!(
        std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap(),
        metadata
    );

    let mut codex_root = payload("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    codex_root["agent_id"] = serde_json::Value::Null;
    run_posix_hook(command, &record, "codex", codex_root, None, &[]);
    let metadata = std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap();
    assert_eq!(
        parse_sidecar(&metadata).unwrap().session_id.as_deref(),
        Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    );

    let mut codex_child = payload("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    codex_child["agent_id"] = "child".into();
    run_posix_hook(command, &record, "codex", codex_child, None, &[]);
    assert_eq!(
        std::fs::read(record.metadata_path.as_ref().unwrap()).unwrap(),
        metadata
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn service_sessions_never_prepare_or_resume_conversations() {
    let root = root("service");
    let links = root.join("links");
    let (db, project, mut session) = fixture(&root, "pi");
    assert!(get(&db, &session.id).unwrap().is_some());
    let previous = session.clone();
    session.kind = "service".into();
    session.service_id = Some("web".into());
    session.working_directory = Some(root.to_string_lossy().into());
    session_saved(&db, Some(&previous), &session).unwrap();
    assert!(get(&db, &session.id).unwrap().is_none());

    let fields = fields(&db, &session).unwrap();
    assert_eq!(fields.resume, "unsupported");
    assert!(fields.conversation.is_none());
    assert_eq!(
        reconcile(&db, &session, &project, false).unwrap().working,
        None
    );
    let launch = prepare_launch(&db, &links, &session, &project, None).unwrap();
    assert_eq!(launch.args, session.args);
    assert!(!links.exists());
    assert!(get(&db, &session.id).unwrap().is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn claude_and_codex_hooks_link_ids_and_prepare_exact_resume_commands() {
    let root = root("native-resume");
    let links = root.join("links");
    let id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    for executable in ["claude", "codex"] {
        let provider = executable;
        let case_root = root.join(executable);
        std::fs::create_dir(&case_root).unwrap();
        let (db, project, session) = fixture(&case_root, executable);
        let first = prepare_launch(&db, &links, &session, &project, None).unwrap();
        assert!(first
            .environment
            .iter()
            .any(|(key, value)| key == "SORENO_CONVERSATION_PROVIDER" && value == provider));
        assert!(!first
            .args
            .iter()
            .any(|arg| arg == "--dangerously-bypass-hook-trust"));
        if cfg!(windows) {
            let encoded = first
                .environment
                .iter()
                .find_map(|(key, value)| (key == WINDOWS_HOOK_SCRIPT_VARIABLE).then_some(value))
                .unwrap();
            assert_eq!(
                String::from_utf8(STANDARD.decode(encoded).unwrap()).unwrap(),
                WINDOWS_HOOK_SCRIPT
            );
            assert!(super::super::legacy_powershell_args_safe(&first.args));
        }
        if provider == "claude" {
            assert_eq!(first.args[0], "--settings");
            let settings_data = if cfg!(windows) {
                std::fs::read_to_string(&first.args[1]).unwrap()
            } else {
                first.args[1].clone()
            };
            let settings: serde_json::Value = serde_json::from_str(&settings_data).unwrap();
            assert_eq!(
                settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
                hook_commands(cfg!(windows))[0]
            );
        } else {
            assert_eq!(&first.args[..2], ["-c", "features.hooks=true"]);
            for event in ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop"] {
                assert!(first
                    .args
                    .iter()
                    .any(|arg| arg.starts_with(&format!("hooks.{event}="))));
            }
        }

        let record = get(&db, &session.id).unwrap().unwrap();
        observe_hook(
            &record,
            provider,
            serde_json::json!({
                "hook_event_name": "SessionStart",
                "session_id": id,
                "transcript_path": null,
                "cwd": project.path,
                "source": "startup"
            }),
        );
        reconcile(&db, &session, &project, false).unwrap();
        let conversation = fields(&db, &session).unwrap().conversation.unwrap();
        assert_eq!(conversation.session_id, id);
        assert_eq!(conversation.session_file, None);

        let resumed = prepare_launch(&db, &links, &session, &project, None).unwrap();
        if provider == "claude" {
            assert_eq!(&resumed.args[2..4], ["--resume", id]);
        } else {
            assert!(resumed.args.windows(2).any(|args| args == ["resume", id]));
        }
    }
    assert!(validate_args(
        &["--dangerously-bypass-hook-trust".into()],
        Provider::Codex,
        false
    )
    .is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn initial_prompt_is_appended_only_to_a_launch_starting_a_new_conversation() {
    let root = root("initial-prompt");
    let links = root.join("links");
    let id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let prompt = "Issue SOR-1: fix\n--help";
    for provider in ["claude", "codex"] {
        let case_root = root.join(provider);
        std::fs::create_dir(&case_root).unwrap();
        let (db, project, session) = fixture(&case_root, provider);
        let mut fresh = prepare_launch(&db, &links, &session, &project, None).unwrap();
        fresh.append_initial_prompt(prompt).unwrap();
        assert_eq!(
            fresh.args[fresh.args.len() - 3..],
            ["--version", "--", prompt]
        );

        let separated_root = root.join(format!("{provider}-separated"));
        std::fs::create_dir(&separated_root).unwrap();
        let (separated_db, separated_project, mut separated_session) =
            fixture(&separated_root, provider);
        separated_session.args = vec!["--".into()];
        let mut separated = prepare_launch(
            &separated_db,
            &links,
            &separated_session,
            &separated_project,
            None,
        )
        .unwrap();
        separated.append_initial_prompt(prompt).unwrap();
        assert_eq!(separated.args[separated.args.len() - 2..], ["--", prompt]);
        assert_eq!(separated.args.iter().filter(|arg| *arg == "--").count(), 1);

        observe_hook(
            &get(&db, &session.id).unwrap().unwrap(),
            provider,
            serde_json::json!({
                "hook_event_name": "SessionStart",
                "session_id": id,
                "transcript_path": null,
                "cwd": project.path,
                "source": "startup"
            }),
        );
        reconcile(&db, &session, &project, false).unwrap();
        let mut resumed = prepare_launch(&db, &links, &session, &project, None).unwrap();
        assert_eq!(
            resumed.append_initial_prompt(prompt).unwrap_err(),
            INITIAL_PROMPT_MESSAGE
        );
        assert!(!resumed.args.iter().any(|arg| arg == prompt));
    }
    std::fs::remove_dir_all(root).unwrap();
}

/// Mirrors `PROMPT_COST_LIMIT` and `charCost` in src/domain/kanbanAgent.ts.
const KANBAN_PROMPT_COST_LIMIT: usize = 1000;

fn kanban_prompt_cost(text: &str) -> usize {
    text.chars()
        .map(|ch| match ch {
            '"' | '\\' => 3,
            '\n' | '\r' | '\t' => 2,
            ch if ch < ' ' => 6,
            ch => ch.len_utf8(),
        })
        .sum()
}

#[test]
fn initial_prompt_of_a_full_kanban_issue_fits_the_native_windows_codex_launch() {
    let root = root("windows-prompt-budget");
    let links = root.join("links");
    let posix_hooks = codex_hook_args(&hook_commands(false), false);
    let windows_hooks = codex_hook_args(&hook_commands(true), true);
    let json = "{\"path\": \"C:\\\\dev\\\\\", \"ok\": true}\n";
    // Shape of `attachment_directory` under `attachment_root` and an `instance-<pid>-<ns>-<n>`
    // directory, with a 32-char user name and the widest pid and timestamp.
    let private_directory = format!(
        r"C:\Users\{}\AppData\Roaming\com.soreno.notes\agent-attachments\instance-4294967295-{}-1\{}",
        "u".repeat(32),
        u128::from(u64::MAX),
        "f".repeat(32)
    );
    for (index, unit) in ["a", "é", "界", "\n", "\"", "\\", "\u{1}", json]
        .into_iter()
        .enumerate()
    {
        let cost = kanban_prompt_cost(unit);
        // Leading padding keeps the expensive unit at the end, where CRT quoting doubles backslashes.
        let prompt = "a".repeat(KANBAN_PROMPT_COST_LIMIT % cost)
            + &unit.repeat(KANBAN_PROMPT_COST_LIMIT / cost);
        assert_eq!(kanban_prompt_cost(&prompt), KANBAN_PROMPT_COST_LIMIT);
        let case_root = root.join(index.to_string());
        std::fs::create_dir(&case_root).unwrap();
        let (db, project, mut session) = fixture(&case_root, "codex");
        session.args.clear();
        let mut fresh = prepare_launch(&db, &links, &session, &project, None).unwrap();
        if cfg!(windows) {
            assert_eq!(fresh.args[..windows_hooks.len()], windows_hooks);
        } else {
            // Native Windows swaps the POSIX hook commands for longer in-memory runners.
            assert_eq!(fresh.args[..posix_hooks.len()], posix_hooks);
            fresh
                .session
                .args
                .splice(..posix_hooks.len(), windows_hooks.clone());
        }
        crate::agent_sessions::issue_requests::add_instruction(
            &mut fresh.session.args,
            Provider::Codex,
            &private_directory,
            false,
            true,
        )
        .unwrap();
        fresh.append_initial_prompt(&prompt).unwrap();
        let command = crate::agent_sessions::windows_command(&fresh.session).unwrap();
        assert!(
            crate::agent_sessions::ensure_windows_command_line(&command, false).is_ok(),
            "{unit:?}"
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_design_agent_fits_the_native_windows_codex_launch() {
    let root = root("windows-design-budget");
    let links = root.join("links");
    let posix_hooks = codex_hook_args(&hook_commands(false), false);
    let windows_hooks = codex_hook_args(&hook_commands(true), true);
    let private_directory = format!(
        r"C:\Users\{}\AppData\Roaming\com.soreno.notes\agent-attachments\instance-4294967295-{}-1\{}",
        "u".repeat(32),
        u128::from(u64::MAX),
        "f".repeat(32)
    );
    let (db, project, mut session) = fixture(&root, "codex");
    session.args.clear();
    session.design = true;
    let mut fresh = prepare_launch(&db, &links, &session, &project, None).unwrap();
    if !cfg!(windows) {
        fresh
            .session
            .args
            .splice(..posix_hooks.len(), windows_hooks);
    }
    crate::agent_sessions::issue_requests::add_instruction(
        &mut fresh.session.args,
        Provider::Codex,
        &private_directory,
        true,
        true,
    )
    .unwrap();
    let command = crate::agent_sessions::windows_command(&fresh.session).unwrap();
    let length = command
        .get_argv()
        .iter()
        .skip(1)
        .map(|arg| {
            crate::agent_sessions::windows_quote(&arg.to_string_lossy())
                .encode_utf16()
                .count()
                + 1
        })
        .sum::<usize>();
    // Margin for a longer private directory and a few user arguments.
    assert!(length + 260 + 4096 < 32_767, "{length}");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_exact_hook_resume_without_sidecar_preserves_link() {
    let id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    for provider in ["claude", "codex"] {
        let root = root(&format!("{provider}-interrupted-resume"));
        let links = root.join("links");
        let (db, project, session) = fixture(&root, provider);
        prepare_launch(&db, &links, &session, &project, None).unwrap();
        let first = get(&db, &session.id).unwrap().unwrap();
        observe_hook(
            &first,
            provider,
            serde_json::json!({
                "hook_event_name": "SessionStart",
                "session_id": id,
                "transcript_path": null,
                "cwd": project.path,
                "source": "startup"
            }),
        );
        reconcile(&db, &session, &project, false).unwrap();

        prepare_launch(&db, &links, &session, &project, None).unwrap();
        let interrupted = get(&db, &session.id).unwrap().unwrap();
        assert_eq!(interrupted.requested_session_id.as_deref(), Some(id));
        assert!(interrupted.history_verified);
        reconcile(&db, &session, &project, false).unwrap();

        let linked = fields(&db, &session).unwrap();
        assert_eq!(linked.resume, "linked");
        assert_eq!(linked.conversation.unwrap().session_id, id);
        assert!(linked.error.is_none());
        assert!(!linked.pending);
        let preserved = get(&db, &session.id).unwrap().unwrap();
        assert!(preserved.history_verified);
        assert!(preserved.run_id.is_none());
        assert!(preserved.metadata_path.is_none());
        assert!(preserved.requested_session_id.is_none());
        assert!(preserved.conversation_error.is_none());

        let relaunched = prepare_launch(&db, &links, &session, &project, None).unwrap();
        assert!(relaunched.args.windows(2).any(|pair| {
            pair == [
                if provider == "codex" {
                    "resume"
                } else {
                    "--resume"
                },
                id,
            ]
        }));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn hook_payload_rejects_a_relative_working_directory() {
    let root = root("hook-cwd");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    observe_hook(
        &record,
        "claude",
        serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "transcript_path": null,
            "cwd": "relative",
            "source": "startup"
        }),
    );
    reconcile(&db, &session, &project, false).unwrap();
    assert!(fields(&db, &session)
        .unwrap()
        .error
        .as_deref()
        .unwrap()
        .contains("incompatibles"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_first_claude_launch_without_sidecar_retries_as_new() {
    let root = root("claude-interrupted-first-launch");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "claude");
    let first = prepare_launch(&db, &links, &session, &project, None).unwrap();
    assert!(!first.args.iter().any(|arg| arg == "--resume"));

    reconcile(&db, &session, &project, false).unwrap();

    let fields = fields(&db, &session).unwrap();
    assert_eq!(fields.resume, "new");
    assert!(fields.error.is_none());
    assert!(fields.conversation.is_none());
    assert!(!fields.pending);
    let record = get(&db, &session.id).unwrap().unwrap();
    assert!(record.run_id.is_none());
    assert!(record.metadata_path.is_none());
    assert!(record.conversation_error.is_none());

    let retry = prepare_launch(&db, &links, &session, &project, None).unwrap();
    assert!(!retry.args.iter().any(|arg| arg == "--resume"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn codex_missing_hook_requests_approval_and_retries_with_the_native_selector() {
    let root = root("codex-approval");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "codex");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    reconcile(&db, &session, &project, false).unwrap();

    let fields = fields(&db, &session).unwrap();
    assert_eq!(fields.resume, "approval");
    assert_eq!(fields.error.as_deref(), Some(MISSING_LINK));
    assert!(fields.conversation.is_none());

    let retry = prepare_launch(&db, &links, &session, &project, None).unwrap();
    assert_eq!(&retry.args[retry.args.len() - 2..], ["resume", "--version"]);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn codex_self_update_exit_retries_as_new_without_missing_link() {
    let banner = b"Updating Codex via `bun install -g @openai/codex`...\r\n\x1b[32minstalled\x1b[0m\r\n\xf0\x9f\x8e\x89 Update ran\x1b[1C\x1b]0;codex\x07successfully! Please restart Codex.\r\n\x1b[?25h";
    assert!(codex_requested_restart(banner.iter().copied()));
    assert!(!codex_requested_restart(
        b"Update ran successfully! Please restart Claude."
            .iter()
            .copied()
    ));

    let root = root("codex-self-update");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "codex");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    forget_codex_update_run(&db, &session, || false).unwrap();
    assert!(get(&db, &session.id).unwrap().unwrap().pending);

    forget_codex_update_run(&db, &session, || true).unwrap();
    reconcile(&db, &session, &project, false).unwrap();

    let fields = fields(&db, &session).unwrap();
    assert_eq!(fields.resume, "new");
    assert!(fields.error.is_none());
    assert!(!fields.pending);
    let retry = prepare_launch(&db, &links, &session, &project, None).unwrap();
    assert!(!retry.args.iter().any(|arg| arg == "resume"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unrequested_resume_replaces_startup_identity_but_exact_resume_does_not() {
    for provider in ["claude", "codex"] {
        let root = root(&format!("{provider}-resume-transition"));
        let links = root.join("links");
        let (db, project, session) = fixture(&root, provider);
        prepare_launch(&db, &links, &session, &project, None).unwrap();
        let first_run = get(&db, &session.id).unwrap().unwrap();
        assert!(first_run.requested_session_id.is_none());
        let write = |record: &ConversationRecord, id: &str, source: &str| {
            observe_hook(
                record,
                provider,
                serde_json::json!({
                    "hook_event_name": "SessionStart",
                    "session_id": id,
                    "transcript_path": null,
                    "cwd": project.path,
                    "source": source
                }),
            );
        };
        let startup = "11111111-1111-4111-8111-111111111111";
        let resumed = "22222222-2222-4222-8222-222222222222";
        write(&first_run, startup, "startup");
        reconcile(&db, &session, &project, false).unwrap();
        write(&first_run, resumed, "resume");

        let reopened = prepare_launch(&db, &links, &session, &project, None).unwrap();
        let linked = fields(&db, &session).unwrap();
        assert_eq!(linked.conversation.unwrap().session_id, resumed);
        assert!(linked.error.is_none());
        assert!(reopened.args.windows(2).any(|pair| {
            pair == [
                if provider == "codex" {
                    "resume"
                } else {
                    "--resume"
                },
                resumed,
            ]
        }));

        let exact_run = get(&db, &session.id).unwrap().unwrap();
        assert_eq!(exact_run.requested_session_id.as_deref(), Some(resumed));
        write(&exact_run, "33333333-3333-4333-8333-333333333333", "resume");
        reconcile(&db, &session, &project, false).unwrap();
        let rejected = fields(&db, &session).unwrap();
        assert_eq!(rejected.conversation.unwrap().session_id, resumed);
        assert_eq!(rejected.error.as_deref(), Some(IDENTITY_ERROR));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn hook_identity_changes_require_clear_or_fork() {
    let root = root("hook-identity");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "claude");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let write = |record: &ConversationRecord, id: &str, source: &str| {
        observe_hook(
            record,
            "claude",
            serde_json::json!({
                "hook_event_name": "SessionStart",
                "session_id": id,
                "transcript_path": null,
                "cwd": project.path,
                "source": source
            }),
        );
    };
    let first = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    write(&record, first, "startup");
    reconcile(&db, &session, &project, false).unwrap();
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let resumed = get(&db, &session.id).unwrap().unwrap();
    write(&resumed, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "resume");
    reconcile(&db, &session, &project, false).unwrap();
    assert_eq!(
        fields(&db, &session)
            .unwrap()
            .conversation
            .unwrap()
            .session_id,
        first
    );

    write(&resumed, "ffffffff-ffff-4fff-8fff-ffffffffffff", "clear");
    reconcile(&db, &session, &project, false).unwrap();
    assert_eq!(
        fields(&db, &session)
            .unwrap()
            .conversation
            .unwrap()
            .session_id,
        "ffffffff-ffff-4fff-8fff-ffffffffffff"
    );

    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let ended = get(&db, &session.id).unwrap().unwrap();
    let ended_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    observe_hook(
        &ended,
        "claude",
        serde_json::json!({
            "hook_event_name": "SessionEnd",
            "session_id": ended_id,
            "transcript_path": null,
            "cwd": project.path,
            "reason": "clear"
        }),
    );
    reconcile(&db, &session, &project, false).unwrap();
    let rejected_end = fields(&db, &session).unwrap();
    assert_eq!(
        rejected_end.conversation.as_ref().unwrap().session_id,
        "ffffffff-ffff-4fff-8fff-ffffffffffff"
    );
    assert_eq!(rejected_end.error.as_deref(), Some(IDENTITY_ERROR));

    observe_hook(
        &ended,
        "claude",
        serde_json::json!({
            "hook_event_name": "SessionEnd",
            "session_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
            "transcript_path": null,
            "cwd": project.path
        }),
    );
    reconcile(&db, &session, &project, false).unwrap();
    assert_eq!(
        fields(&db, &session).unwrap().error.as_deref(),
        Some(IDENTITY_ERROR)
    );

    write(&ended, ended_id, "fork");
    reconcile(&db, &session, &project, false).unwrap();
    assert_eq!(
        fields(&db, &session)
            .unwrap()
            .conversation
            .unwrap()
            .session_id,
        ended_id
    );

    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let compacted = get(&db, &session.id).unwrap().unwrap();
    write(
        &compacted,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "compact",
    );
    reconcile(&db, &session, &project, false).unwrap();
    let compacted_fields = fields(&db, &session).unwrap();
    assert_eq!(
        compacted_fields.conversation.as_ref().unwrap().session_id,
        ended_id
    );
    assert_eq!(compacted_fields.error.as_deref(), Some(IDENTITY_ERROR));

    let first_end_root = root.join("first-session-end");
    std::fs::create_dir(&first_end_root).unwrap();
    let (end_db, end_project, end_session) = fixture(&first_end_root, "codex");
    prepare_launch(&end_db, &links, &end_session, &end_project, None).unwrap();
    let first_end = get(&end_db, &end_session.id).unwrap().unwrap();
    observe_hook(
        &first_end,
        "codex",
        serde_json::json!({
            "hook_event_name": "SessionEnd",
            "session_id": ended_id,
            "transcript_path": null,
            "cwd": end_project.path
        }),
    );
    reconcile(&end_db, &end_session, &end_project, false).unwrap();
    assert_eq!(
        fields(&end_db, &end_session)
            .unwrap()
            .conversation
            .unwrap()
            .session_id,
        ended_id
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn omp_history_requires_a_native_title_slot_or_legacy_session_header() {
    let root = root("omp-title");
    let file = root.join("history.jsonl");
    let id = "99999999-9999-4999-8999-999999999999";
    let conversation = AgentConversation {
        provider: "omp".into(),
        session_id: id.into(),
        session_file: Some(file.to_string_lossy().into()),
        name: None,
    };
    let (_, project, _) = fixture(&root, "omp");
    history(&file, "omp", id);
    verify_history(&project, &conversation).unwrap();

    let header = serde_json::json!({"type": "session", "id": id});
    std::fs::write(&file, format!("{header}\n")).unwrap();
    verify_history(&project, &conversation).unwrap();

    for invalid_title in [
        serde_json::json!({"type": "title"}),
        serde_json::json!({
            "type": "title", "v": 1, "title": "Title",
            "updatedAt": "now", "pad": "", "source": "manual"
        }),
        serde_json::json!({"type": "message"}),
    ] {
        std::fs::write(&file, format!("{invalid_title}\n{header}\n")).unwrap();
        assert!(verify_history(&project, &conversation)
            .unwrap_err()
            .contains("Titre initial"));
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn omp_new_launch_appends_the_last_config_overlay_before_separator() {
    let root = root("omp-overlay");
    let links = root.join("links");
    let (db, project, mut session) = fixture(&root, "omp");
    session.args = vec![
        "--config".into(),
        "user.yml".into(),
        "prompt".into(),
        "--".into(),
        "--literal-prompt".into(),
    ];
    let launch = prepare_launch(&db, &links, &session, &project, None).unwrap();
    let separator = launch.args.iter().position(|arg| arg == "--").unwrap();
    assert_eq!(&launch.args[separator - 2], "--config");
    assert_eq!(
        std::fs::read_to_string(&launch.args[separator - 1]).unwrap(),
        "autoResume: false\n"
    );
    assert_eq!(
        launch.args[..separator]
            .iter()
            .filter(|arg| arg.as_str() == "--config")
            .count(),
        2
    );
    assert_eq!(&launch.args[separator + 1], "--literal-prompt");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rollback_restores_the_post_reconcile_record_exactly() {
    let root = root("rollback");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "pi");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let id = "88888888-8888-4888-8888-888888888888";
    let file = root.join("history.jsonl");
    history(&file, "pi", id);
    observe(&record, "pi", id, &file, "Old");
    reconcile(&db, &session, &project, false).unwrap();
    observe(&record, "pi", id, &file, "Newest");

    let launch = prepare_launch(&db, &links, &session, &project, None).unwrap();
    assert!(get(&db, &session.id).unwrap().unwrap().pending);
    assert_eq!(
        launch.rollback::<()>(&db, "pre-spawn".into()).unwrap_err(),
        "pre-spawn"
    );
    let restored = get_data(&db, &session.id).unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<ConversationRecord>(&restored)
            .unwrap()
            .conversation
            .unwrap()
            .name
            .as_deref(),
        Some("Newest")
    );
    let retry = prepare_launch(&db, &links, &session, &project, None).unwrap();
    retry
        .rollback::<()>(&db, "retry fixture".into())
        .unwrap_err();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rollback_failure_keeps_the_launch_error_explicit() {
    let root = root("rollback-failure");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "pi");
    let launch = prepare_launch(&db, &links, &session, &project, None).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_conversation_restore
         BEFORE UPDATE ON agent_conversations
         BEGIN SELECT RAISE(FAIL, 'restore blocked'); END;",
    )
    .unwrap();
    let error = launch
        .rollback::<()>(&db, "pre-spawn failed".into())
        .unwrap_err();
    assert!(error.contains("pre-spawn failed"), "{error}");
    assert!(error.contains("Restauration"), "{error}");
    assert!(error.contains("restore blocked"), "{error}");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn active_pending_run_defers_missing_link_and_identical_reconcile_is_noop() {
    let root = root("reconcile");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "pi");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    reconcile(&db, &session, &project, true).unwrap();
    let active = fields(&db, &session).unwrap();
    assert!(active.pending);
    assert!(active.error.is_none());
    reconcile(&db, &session, &project, false).unwrap();
    assert_eq!(
        fields(&db, &session).unwrap().error.as_deref(),
        Some(MISSING_LINK)
    );

    let record = get(&db, &session.id).unwrap().unwrap();
    let id = "77777777-7777-4777-8777-777777777777";
    let file = root.join("history.jsonl");
    history(&file, "pi", id);
    observe(&record, "pi", id, &file, "Stable");
    reconcile(&db, &session, &project, false).unwrap();
    let changes = db.total_changes();
    reconcile(&db, &session, &project, false).unwrap();
    assert_eq!(db.total_changes(), changes);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn empty_history_is_not_linked_and_restarts_as_a_new_conversation() {
    let root = root("empty-history");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "pi");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    observe(
        &record,
        "pi",
        "77777777-7777-4777-8777-777777777777",
        &root.join("missing.jsonl"),
        "Vide",
    );

    reconcile(&db, &session, &project, false).unwrap();
    let empty = fields(&db, &session).unwrap();
    assert_eq!(empty.resume, "new");
    assert!(empty.conversation.is_none());
    assert!(empty.error.is_none());

    let restarted = prepare_launch(&db, &links, &session, &project, None).unwrap();
    assert_eq!(restarted.args[0], "-e");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_verified_history_remains_an_explicit_error() {
    let root = root("deleted-history");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "pi");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let file = root.join("history.jsonl");
    let id = "77777777-7777-4777-8777-777777777777";
    history(&file, "pi", id);
    observe(&record, "pi", id, &file, "Durable");
    reconcile(&db, &session, &project, false).unwrap();
    std::fs::remove_file(file).unwrap();

    assert_eq!(
        prepare_launch(&db, &links, &session, &project, None).unwrap_err(),
        MISSING_HISTORY
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reconcile_reports_only_valid_live_working_state() {
    let root = root("working");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "pi");
    prepare_launch(&db, &links, &session, &project, None).unwrap();
    let record = get(&db, &session.id).unwrap().unwrap();
    let id = "99999999-9999-4999-8999-999999999999";
    let file = root.join("history.jsonl");
    history(&file, "pi", id);

    observe(&record, "pi", id, &file, "Legacy");
    assert_eq!(
        reconcile(&db, &session, &project, true).unwrap().working,
        None
    );
    observe_working(&record, "pi", id, &file, serde_json::json!(true));
    assert_eq!(
        reconcile(&db, &session, &project, true).unwrap().working,
        Some(true)
    );
    observe_working(&record, "pi", id, &file, serde_json::json!(false));
    assert_eq!(
        reconcile(&db, &session, &project, true).unwrap().working,
        Some(false)
    );
    observe_working(&record, "pi", id, &file, serde_json::json!(true));
    assert_eq!(
        reconcile(&db, &session, &project, false).unwrap().working,
        None
    );
    observe_working(&record, "pi", id, &file, serde_json::json!("busy"));
    assert_eq!(
        reconcile(&db, &session, &project, true).unwrap().working,
        None
    );
    assert!(fields(&db, &session)
        .unwrap()
        .error
        .as_deref()
        .unwrap()
        .contains("invalides"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn lifecycle_preserves_links_and_blocks_invalid_sidecars_and_headers() {
    let root = root("lifecycle");
    let links = root.join("links");
    let (db, project, session) = fixture(&root, "pi");
    assert_eq!(fields(&db, &session).unwrap().resume, "new");
    let first = prepare_launch(&db, &links, &session, &project, None).unwrap();
    assert_eq!(first.args[0], "-e");
    assert_eq!(first.args[2], "--version");
    assert!(std::fs::read_to_string(&first.args[1])
        .unwrap()
        .contains("\"expectedSessionId\":null"));
    assert_eq!(fields(&db, &session).unwrap().resume, "select");

    let first_record = get(&db, &session.id).unwrap().unwrap();
    let first_id = "11111111-1111-4111-8111-111111111111";
    let first_file = root.join("first.jsonl");
    history(&first_file, "pi", first_id);
    observe(&first_record, "pi", first_id, &first_file, "Premier");
    reconcile(&db, &session, &project, false).unwrap();
    let linked = fields(&db, &session).unwrap();
    assert_eq!(linked.resume, "linked");
    assert_eq!(
        linked.conversation.as_ref().unwrap().name.as_deref(),
        Some("Premier")
    );

    let mut renamed = session.clone();
    renamed.name = "Launcher renamed".into();
    session_saved(&db, Some(&session), &renamed).unwrap();
    assert_eq!(
        fields(&db, &renamed)
            .unwrap()
            .conversation
            .unwrap()
            .session_id,
        first_id
    );
    for executable in ["omp", "/bin/sh"] {
        let mut switched = renamed.clone();
        switched.executable = executable.into();
        assert!(session_saved(&db, Some(&renamed), &switched)
            .unwrap_err()
            .contains("ne peut pas changer"));
    }

    let second_id = "22222222-2222-4222-8222-222222222222";
    let second_file = root.join("second.jsonl");
    history(&second_file, "pi", second_id);
    observe(&first_record, "pi", second_id, &second_file, "Second");
    reconcile(&db, &renamed, &project, false).unwrap();
    let changed = fields(&db, &renamed).unwrap();
    assert_eq!(changed.conversation.as_ref().unwrap().session_id, second_id);
    assert_eq!(
        changed.conversation.as_ref().unwrap().name.as_deref(),
        Some("Second")
    );

    observe(&first_record, "omp", first_id, &first_file, "Bad");
    reconcile(&db, &renamed, &project, false).unwrap();
    let invalid = fields(&db, &renamed).unwrap();
    assert_eq!(invalid.conversation.as_ref().unwrap().session_id, second_id);
    assert!(invalid.error.as_deref().unwrap().contains("incompatibles"));
    let run_count = std::fs::read_dir(&links).unwrap().count();
    assert!(prepare_launch(&db, &links, &renamed, &project, None)
        .unwrap_err()
        .contains("ne peut pas être reprise"));
    assert_eq!(std::fs::read_dir(&links).unwrap().count(), run_count);
    let mut wrong_run = first_record.clone();
    wrong_run.run_id = Some("00000000000000000000000000000000".into());
    observe(&wrong_run, "pi", first_id, &first_file, "Wrong run");
    reconcile(&db, &renamed, &project, false).unwrap();
    assert_eq!(
        fields(&db, &renamed)
            .unwrap()
            .conversation
            .unwrap()
            .session_id,
        second_id
    );

    observe(&first_record, "pi", second_id, &second_file, "Second");
    reconcile(&db, &renamed, &project, false).unwrap();
    history(&second_file, "pi", first_id);
    assert!(prepare_launch(&db, &links, &renamed, &project, None)
        .unwrap_err()
        .contains("ne correspond pas"));
    std::fs::write(&second_file, "{}\n").unwrap();
    assert!(prepare_launch(&db, &links, &renamed, &project, None)
        .unwrap_err()
        .contains("type incorrect"));
    assert_eq!(std::fs::read_dir(&links).unwrap().count(), run_count);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn omp_existing_and_parallel_agents_get_exact_resume_arguments_and_unique_runs() {
    let root = root("argv");
    let links = root.join("links");
    let (db, project, omp) = fixture(&root, "omp");
    prepare_launch(&db, &links, &omp, &project, None).unwrap();
    let record = get(&db, &omp.id).unwrap().unwrap();
    let id = "33333333-3333-4333-8333-333333333333";
    let file = root.join("omp.jsonl");
    history(&file, "omp", id);
    observe(&record, "omp", id, &file, "OMP");
    reconcile(&db, &omp, &project, false).unwrap();
    let conversation = fields(&db, &omp).unwrap().conversation.unwrap();
    verify_history(&project, &conversation).unwrap();
    let linked_data = get_data(&db, &omp.id).unwrap().unwrap();
    let run_count = std::fs::read_dir(&links).unwrap().count();
    std::fs::write(
        &file,
        format!(
            "{{\"type\":\"title\"}}\n{}\n",
            serde_json::json!({"type": "session", "version": 3, "id": id})
        ),
    )
    .unwrap();
    assert!(prepare_launch(&db, &links, &omp, &project, None)
        .unwrap_err()
        .contains("Titre initial"));
    assert_eq!(get_data(&db, &omp.id).unwrap().unwrap(), linked_data);
    assert_eq!(std::fs::read_dir(&links).unwrap().count(), run_count);
    std::fs::write(
        &file,
        format!(
            "{}\n",
            serde_json::json!({"type": "session", "version": 3, "id": id})
        ),
    )
    .unwrap();
    verify_history(&project, &conversation).unwrap();
    let resumed = prepare_launch(&db, &links, &omp, &project, None).unwrap();
    assert_eq!(resumed.args[..2], ["--resume", file.to_str().unwrap()]);
    assert_eq!(resumed.args[2], "-e");
    reconcile(&db, &omp, &project, false).unwrap();
    let unconfirmed = fields(&db, &omp).unwrap();
    assert_eq!(unconfirmed.conversation.as_ref().unwrap().session_id, id);
    assert_eq!(unconfirmed.error.as_deref(), Some(MISSING_LINK));
    assert!(prepare_launch(&db, &links, &omp, &project, None)
        .unwrap_err()
        .contains("aucune liaison"));

    let mut existing = omp.clone();
    existing.id = "existing".into();
    existing.executable = "pi".into();
    db.execute(
        "INSERT INTO agent_sessions(id,data) VALUES (?1,?2)",
        params![existing.id, serde_json::to_string(&existing).unwrap()],
    )
    .unwrap();
    assert_eq!(fields(&db, &existing).unwrap().resume, "select");
    let selected = prepare_launch(&db, &links, &existing, &project, None).unwrap();
    assert_eq!(selected.args[..2], ["--resume", "-e"]);
    reconcile(&db, &existing, &project, false).unwrap();
    assert_eq!(
        fields(&db, &existing).unwrap().error.as_deref(),
        Some(MISSING_LINK)
    );
    let selected_again = prepare_launch(&db, &links, &existing, &project, None).unwrap();
    assert_eq!(selected_again.args[..2], ["--resume", "-e"]);
    assert_ne!(
        get(&db, &omp.id).unwrap().unwrap().metadata_path,
        get(&db, &existing.id).unwrap().unwrap().metadata_path
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn conversation_reference_and_name_survive_reopen() {
    let root = root("reopen");
    let db_path = root.join("agents.sqlite");
    let links = root.join("links");
    let project;
    let session;
    {
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);").unwrap();
        initialize(&db).unwrap();
        project = AgentProject {
            id: "project".into(),
            name: "Project".into(),
            path: root.to_string_lossy().into(),
            environment: AgentEnvironment {
                kind: "local".into(),
                distribution: None,
                ssh: None,
            },
            icon_data_url: None,
            icon: None,
            color: None,
        };
        session = AgentSession {
            id: "agent".into(),
            project_id: project.id.clone(),
            name: "Pi".into(),
            custom_name: None,
            kind: "terminal".into(),
            service_id: None,
            working_directory: None,
            executable: "pi".into(),
            args: Vec::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            favorite: false,
            design: false,
        };
        db.execute(
            "INSERT INTO agent_sessions(id,data) VALUES (?1,?2)",
            params![session.id, serde_json::to_string(&session).unwrap()],
        )
        .unwrap();
        session_saved(&db, None, &session).unwrap();
        prepare_launch(&db, &links, &session, &project, None).unwrap();
        let record = get(&db, &session.id).unwrap().unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let file = root.join("pi.jsonl");
        history(&file, "pi", id);
        observe(&record, "pi", id, &file, "Durable");
    }
    let reopened = Connection::open(&db_path).unwrap();
    initialize(&reopened).unwrap();
    reconcile(&reopened, &session, &project, false).unwrap();
    let fields = fields(&reopened, &session).unwrap();
    assert_eq!(fields.resume, "linked");
    assert_eq!(
        fields.conversation.unwrap().name.as_deref(),
        Some("Durable")
    );
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn wsl_history_command_keeps_the_path_as_one_argument() {
    let command = wsl_command(
        "Ubuntu literal",
        "head",
        &["-c", "65536", "--", "/tmp/a b;$(touch no)"],
    );
    assert_eq!(
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        [
            "--distribution",
            "Ubuntu literal",
            "--exec",
            "head",
            "-c",
            "65536",
            "--",
            "/tmp/a b;$(touch no)",
        ]
    );
    let command = wsl_command(
        "Ubuntu literal",
        "wslpath",
        &["-a", "-u", r"C:\Users\A B\bridge;literal.ts"],
    );
    assert_eq!(
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        [
            "--distribution",
            "Ubuntu literal",
            "--exec",
            "wslpath",
            "-a",
            "-u",
            r"C:\Users\A B\bridge;literal.ts",
        ]
    );
}

/// Files named `0.jsonl`… whose modification times grow with their index, plus decoys.
fn history_directory(label: &str, count: u64) -> PathBuf {
    let directory = root(label).join("sessions");
    std::fs::create_dir_all(directory.join("folder.jsonl")).unwrap();
    std::fs::write(directory.join("notes.txt"), "{}").unwrap();
    let start = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    for index in 0..count {
        let path = directory.join(format!("{index}.jsonl"));
        std::fs::write(&path, vec![b'x'; 5000]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(start + std::time::Duration::from_secs(index * 60))
            .unwrap();
    }
    directory
}

#[test]
fn local_history_pages_the_newest_files_first_within_bounds() {
    let directory = history_directory("history-local", 205);
    let project_root = root("history-local-project");
    let (_, mut project, _) = fixture(&project_root, "omp");
    project.path = directory.to_string_lossy().into();
    let page = |offset, limit| {
        let (files, more) =
            history_files(&project, directory.to_str().unwrap(), offset, limit).unwrap();
        let paths: Vec<_> = files.iter().map(|file| file.path.clone()).collect();
        (files, paths, more)
    };
    let name = |index: u64| {
        directory
            .join(format!("{index}.jsonl"))
            .to_string_lossy()
            .into_owned()
    };
    let (files, paths, more) = page(0, 20);
    assert_eq!(paths, (185..205).rev().map(name).collect::<Vec<_>>());
    assert!(more);
    assert_eq!(files[0].modified, (1_700_000_000 + 204 * 60) * 1000);
    assert!(files
        .iter()
        .all(|file| file.head.len() == HISTORY_HEAD as usize));
    let (_, paths, more) = page(185, 20);
    assert_eq!(paths, (0..20).rev().map(name).collect::<Vec<_>>());
    assert!(!more);
    let (_, paths, more) = page(200, 20);
    assert_eq!(paths, (0..5).rev().map(name).collect::<Vec<_>>());
    assert!(!more);
    let (_, paths, more) = page(0, usize::MAX);
    assert_eq!(paths.len(), HISTORY_PAGE_LIMIT);
    assert!(more);
    let missing = directory.join("missing");
    assert!(matches!(
        history_files(&project, missing.to_str().unwrap(), 0, 20),
        Ok((files, false)) if files.is_empty()
    ));
    std::fs::remove_dir_all(directory.parent().unwrap()).unwrap();
    std::fs::remove_dir_all(project_root).unwrap();
}

#[cfg(unix)]
#[test]
fn remote_history_script_pages_newest_first() {
    let directory = history_directory("history-remote", 5);
    std::os::unix::fs::symlink(directory.join("0.jsonl"), directory.join("link.jsonl")).unwrap();
    let directory = directory.to_str().unwrap();
    let page = |directory: &str, offset, limit| {
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &history_files_script(directory, offset, limit)])
            .output()
            .unwrap();
        assert!(output.status.success());
        parse_history_files(directory, &output.stdout)
    };
    let paths = |files: &[HistoryFile]| {
        files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>()
    };
    let (files, more) = page(directory, 1, 2);
    assert_eq!(
        paths(&files),
        [3, 2].map(|index| format!("{directory}/{index}.jsonl"))
    );
    assert!(more);
    assert_eq!(files[1].modified, (1_700_000_000 + 2 * 60) * 1000);
    assert!(files.iter().all(|file| file.head == [b'x'; 4096]));
    let (files, more) = page(directory, 3, 2);
    assert_eq!(
        paths(&files),
        [1, 0].map(|index| format!("{directory}/{index}.jsonl"))
    );
    assert!(!more);
    let (files, more) = page(&format!("{directory}/missing"), 0, 20);
    assert!(files.is_empty() && !more);
    std::fs::remove_dir_all(Path::new(directory).parent().unwrap()).unwrap();
}
