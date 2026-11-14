use super::*;

fn project() -> AgentProject {
    AgentProject {
        id: "project".into(),
        name: "Projet".into(),
        path: std::env::temp_dir().to_string_lossy().into(),
        environment: AgentEnvironment {
            kind: "local".into(),
            distribution: None,
            ssh: None,
        },
        icon_data_url: None,
        icon: None,
        color: None,
    }
}
pub(super) fn memory_state() -> AgentSessions {
    AgentSessions::from_connection(Connection::open_in_memory().unwrap()).unwrap()
}
pub(crate) fn unique_temp_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ))
}
fn local_project(project_id: &str) -> AgentProject {
    AgentProject {
        id: project_id.into(),
        name: format!("Projet {project_id}"),
        ..project()
    }
}
fn ssh_project(project_id: &str) -> AgentProject {
    static NEXT_CONNECTION: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
    AgentProject {
        id: project_id.into(),
        name: "Projet SSH".into(),
        path: "/srv/project".into(),
        environment: AgentEnvironment {
            kind: "ssh".into(),
            distribution: None,
            ssh: Some(SshConnection {
                host: format!(
                    "{project_id}-{}.invalid",
                    NEXT_CONNECTION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                ),
                user: Some("alice".into()),
                port: Some(22),
                identity_file: None,
                host_key: None,
            }),
        },
        icon_data_url: None,
        icon: None,
        color: None,
    }
}
pub(super) fn insert_project(state: &AgentSessions, project: &AgentProject) {
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
            params![project.id, serde_json::to_string(project).unwrap()],
        )
        .unwrap();
}
fn disconnect_project(state: &AgentSessions, project_id: &str) -> Result<()> {
    state.set_project_connected_with(project_id, false, |_, _| Ok(None))
}
fn session() -> AgentSession {
    AgentSession {
        id: "session".into(),
        project_id: "project".into(),
        name: "Shell".into(),
        custom_name: None,
        kind: "terminal".into(),
        service_id: None,
        working_directory: None,
        executable: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "printf ready; read line; printf 'received:%s' \"$line\"".into(),
        ],
        created_at: "2026-01-01T00:00:00Z".into(),
        favorite: false,
        design: false,
    }
}
fn stored_conversation_json(db: &Connection, session_id: &str) -> String {
    db.query_row(
        "SELECT data FROM agent_conversations WHERE session_id=?1",
        [session_id],
        |row| row.get(0),
    )
    .unwrap()
}
/// Retained PTY output and status of a session.
pub(crate) struct Terminal {
    pub(crate) bytes: Vec<u8>,
    pub(crate) restored_end: u64,
    pub(crate) status: AgentSessionStatus,
}
impl Terminal {
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}
pub(crate) fn terminal(state: &AgentSessions, session_id: &str) -> Result<Terminal> {
    Ok(match state.runtime(session_id)? {
        Some(runtime) => {
            let output = lock(&runtime.output)?;
            Terminal {
                bytes: output.bytes.iter().copied().collect(),
                restored_end: output.restored_end,
                status: output.status(session_id),
            }
        }
        None => Terminal {
            bytes: Vec::new(),
            restored_end: 0,
            status: idle(session_id),
        },
    })
}

#[cfg(any(unix, windows))]
fn wait_for(mut check: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while !check() {
        assert!(std::time::Instant::now() < deadline, "PTY timed out");
        thread::sleep(std::time::Duration::from_millis(20));
    }
}
#[cfg(windows)]
fn wait_for_windows_output(
    state: &AgentSessions,
    session_id: &str,
    needle: &str,
    until_exit: bool,
) -> Terminal {
    let mut answered = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let current = terminal(state, session_id).unwrap();
        let output = current.text();
        // ConPTY inherits the cursor by asking its terminal emulator. Keep
        // answering until exit, not just until the first CLI output chunk.
        let queries = output.matches("\u{1b}[6n").count();
        if current.status.state == "running" {
            for _ in answered..queries {
                if let Err(error) = state.write(session_id, "\u{1b}[1;1R") {
                    assert_eq!(
                        terminal(state, session_id).unwrap().status.state,
                        "exited",
                        "{error}"
                    );
                }
            }
        }
        answered = queries;
        if output.contains(needle) && (!until_exit || current.status.state == "exited") {
            if until_exit {
                // Child exit and PTY drain occur on independent threads.
                thread::sleep(std::time::Duration::from_millis(100));
                return terminal(state, session_id).unwrap();
            }
            return current;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "PTY {session_id} timed out: {output:?}"
        );
        thread::sleep(std::time::Duration::from_millis(20));
    }
}
#[cfg(unix)]
#[test]
#[ignore = "subprocess fixture for detached conversation writer tests"]
fn conversation_detached_writer_helper() {
    if std::env::var("SORENO_TEST_DETACHED_WRITER").as_deref() != Ok("1") {
        return;
    }
    assert_ne!(unsafe { libc::setsid() }, -1);
    unsafe { libc::close(3) };
    std::fs::OpenOptions::new()
        .write(true)
        .open(std::env::var("SORENO_CONVERSATION_OUTPUT").unwrap())
        .unwrap()
        .write_all(b"private-osc-bytes")
        .unwrap();
}
#[cfg(windows)]
#[test]
#[ignore = "subprocess fixture with isolated hostile WSL environment"]
fn wsl_hostile_environment_fixture() {
    // Existing service smoke covers prepare, ConPTY launch, natural cleanup,
    // stop and shutdown, including a descendant that must be killed.
    pty_tests::real_wsl_pty_opt_in();
    pty_tests::real_wsl_agent_versions_opt_in();
    let distribution = std::env::var("SORENO_TEST_WSL_DISTRO").unwrap();
    let state = memory_state();
    let mut project = project();
    project.path = "/tmp".into();
    project.environment = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some(distribution),
        ssh: None,
    };
    state.save_project(project).unwrap();
    let mut session = session();
    session.args = vec![
        "-c".into(),
        "printf 'term:%s credential:%s\\n' \"$TERM\" \"$SORENO_TEST_WSL_CREDENTIAL\"".into(),
    ];
    state.save_session(session).unwrap();
    state.start("session", 120, 30, None).unwrap();
    let terminal = wait_for_windows_output(
        &state,
        "session",
        "term:xterm-256color credential:kept-by-soreno",
        true,
    );
    assert_eq!(terminal.status.exit_code, Some(0));
}
#[cfg(unix)]
#[test]
#[ignore = "subprocess fixture for normal and setsid descendants"]
fn unix_descendant_fixture() {
    use std::os::unix::process::CommandExt;
    let token = std::env::var("SORENO_AGENT_RUN").unwrap();
    if let Ok(kind) = std::env::var("SORENO_TEST_UNIX_CHILD") {
        let ready = std::env::temp_dir().join(format!("soreno-{token}-{kind}"));
        std::fs::write(ready, "ready").unwrap();
        thread::sleep(std::time::Duration::from_secs(60));
        return;
    }
    for kind in ["normal", "detached"] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "agent_sessions::tests::unix_descendant_fixture",
                "--nocapture",
            ])
            .env("SORENO_TEST_UNIX_CHILD", kind);
        unsafe {
            command.pre_exec(move || {
                if kind == "detached" && libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::signal(libc::SIGHUP, libc::SIG_IGN);
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        let ready = std::env::temp_dir().join(format!("soreno-{token}-{kind}"));
        wait_for(|| ready.exists());
        std::fs::remove_file(ready).unwrap();
        println!("{kind}:{}", child.id());
    }
    if std::env::var("SORENO_TEST_UNIX_WAIT").as_deref() == Ok("1") {
        thread::sleep(std::time::Duration::from_secs(60));
    }
}

#[path = "agent_sessions_tests/closed_sessions_tests.rs"]
mod closed_sessions_tests;
#[path = "agent_sessions_tests/connectivity_tests.rs"]
mod connectivity_tests;
#[path = "agent_sessions_tests/design_tests.rs"]
mod design_tests;
#[path = "agent_sessions_tests/environment_tests.rs"]
mod environment_tests;
#[path = "agent_sessions_tests/groups_tests.rs"]
mod groups_tests;
#[path = "agent_sessions_tests/initial_prompt_tests.rs"]
mod initial_prompt_tests;
#[path = "agent_sessions_tests/issue_requests_tests.rs"]
mod issue_requests_tests;
#[path = "agent_sessions_tests/kanban_issue_sessions_tests.rs"]
mod kanban_issue_sessions_tests;
#[path = "agent_sessions_tests/linear_issue_sessions_tests.rs"]
mod linear_issue_sessions_tests;
#[path = "agent_sessions_tests/linear_links_tests.rs"]
mod linear_links_tests;
#[path = "agent_sessions_tests/messages_tests.rs"]
mod messages_tests;
#[path = "agent_sessions_tests/pty_tests.rs"]
mod pty_tests;
#[path = "agent_sessions_tests/terminal_tests.rs"]
mod terminal_tests;
#[path = "agent_sessions_tests/workspace_tests.rs"]
mod workspace_tests;
