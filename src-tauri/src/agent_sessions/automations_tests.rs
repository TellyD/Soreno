use super::*;
use crate::agent_sessions::AgentEnvironment;

fn input() -> AgentAutomationInput {
    AgentAutomationInput {
        session_id: "session".into(),
        prompt: "/revue-du-matin".into(),
        frequency: "weekdays".into(),
        weekday: 1,
        time: "08:05".into(),
        time_zone: "Europe/Paris".into(),
        enabled: true,
    }
}

fn project(path: &str) -> AgentProject {
    AgentProject {
        id: "project".into(),
        name: "Projet".into(),
        path: path.into(),
        environment: AgentEnvironment {
            kind: "ssh".into(),
            distribution: None,
            ssh: Some(SshConnection {
                host: "automation.invalid".into(),
                user: None,
                port: None,
                identity_file: None,
                host_key: None,
            }),
        },
        icon_data_url: None,
        icon: None,
        color: None,
    }
}

fn session(id: &str, executable: &str, args: &[&str]) -> AgentSession {
    AgentSession {
        id: id.into(),
        project_id: "project".into(),
        name: "Revue".into(),
        custom_name: None,
        kind: "terminal".into(),
        service_id: None,
        working_directory: None,
        executable: executable.into(),
        args: args.iter().map(|arg| (*arg).into()).collect(),
        created_at: "2026-01-01T00:00:00Z".into(),
        favorite: true,
        design: false,
    }
}

#[test]
fn schedules_are_validated_then_written_for_systemd() {
    for (change, field) in [
        (
            AgentAutomationInput {
                prompt: "  ".into(),
                ..input()
            },
            "prompt",
        ),
        (
            AgentAutomationInput {
                frequency: "hourly".into(),
                ..input()
            },
            "frequency",
        ),
        (
            AgentAutomationInput {
                weekday: 8,
                ..input()
            },
            "weekday",
        ),
        (
            AgentAutomationInput {
                time: "24:00".into(),
                ..input()
            },
            "time",
        ),
        (
            AgentAutomationInput {
                time: "8:5".into(),
                ..input()
            },
            "short time",
        ),
        (
            AgentAutomationInput {
                time: "+8:05".into(),
                ..input()
            },
            "signed time",
        ),
        // The zone lands in a unit file: a line break would add a directive.
        (
            AgentAutomationInput {
                time_zone: "UTC\nOnCalendar=minutely".into(),
                ..input()
            },
            "zone",
        ),
        (
            AgentAutomationInput {
                time_zone: "../etc".into(),
                ..input()
            },
            "zone path",
        ),
    ] {
        assert!(validate(&change).is_err(), "{field} accepted");
    }
    assert!(validate(&input()).is_ok());

    for (frequency, weekday, expected) in [
        ("daily", 3, "*-*-* 08:05:00 Europe/Paris"),
        ("weekdays", 3, "Mon..Fri *-*-* 08:05:00 Europe/Paris"),
        ("weekly", 7, "Sun *-*-* 08:05:00 Europe/Paris"),
    ] {
        let schedule = AgentAutomationInput {
            frequency: frequency.into(),
            weekday,
            ..input()
        };
        assert_eq!(on_calendar(&schedule), expected);
    }
}

#[test]
fn a_scheduled_session_cannot_be_deleted_before_its_automation() {
    let state = AgentSessions::from_connection(Connection::open_in_memory().unwrap()).unwrap();
    let project = project("/tmp");
    {
        let store = lock(&state.store).unwrap();
        store
            .db
            .execute(
                "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
                params![project.id, serde_json::to_string(&project).unwrap()],
            )
            .unwrap();
    }
    state
        .save_session(AgentSession {
            favorite: false,
            ..session("session", "claude", &[])
        })
        .unwrap();
    put(
        &lock(&state.store).unwrap().db,
        &AgentAutomation {
            input: input(),
            last_run: None,
            seen_run_at: None,
        },
    )
    .unwrap();

    assert_eq!(state.delete_session("session").unwrap_err(), HAS_AUTOMATION);
    assert_eq!(state.delete_project("project").unwrap_err(), HAS_AUTOMATION);

    // Disconnected, the automation is only forgotten here, without reaching the server.
    state
        .set_project_connected_with("project", false, |_, _| Ok(None))
        .unwrap();
    // The automation keeps a session no favorite holds closed, until it is deleted.
    state.set_session_closed("session", true).unwrap();
    let workspace = state.workspace().unwrap();
    assert_eq!(workspace.closed_session_ids, ["session"]);
    assert_eq!(workspace.automation_session_ids, ["session"]);
    state.delete_automation("session").unwrap();
    assert!(state.automations().unwrap().is_empty());
    assert!(state.workspace().unwrap().closed_session_ids.is_empty());
    state.delete_session("session").unwrap();
}

#[test]
fn a_failed_creation_is_forgotten_only_once_its_timer_is_removed() {
    let state = AgentSessions::from_connection(Connection::open_in_memory().unwrap()).unwrap();
    let project = project("/tmp");
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
            params![project.id, serde_json::to_string(&project).unwrap()],
        )
        .unwrap();
    state
        .save_session(session("session", "claude", &[]))
        .unwrap();
    let automation = AgentAutomation {
        input: input(),
        last_run: None,
        seen_run_at: None,
    };
    put(&lock(&state.store).unwrap().db, &automation).unwrap();

    assert!(state
        .forget_failed_creation("session", || Err("timeout".into()))
        .is_err());
    assert_eq!(state.automations().unwrap(), vec![automation]);
    assert_eq!(state.delete_session("session").unwrap_err(), HAS_AUTOMATION);

    state
        .forget_failed_creation("session", || Ok(Vec::new()))
        .unwrap();
    assert!(state.automations().unwrap().is_empty());
}

#[test]
fn a_group_overview_agent_is_scheduled_with_the_group_repositories() {
    let state = AgentSessions::from_connection(Connection::open_in_memory().unwrap()).unwrap();
    let member = project("/srv/api");
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
            params![member.id, serde_json::to_string(&member).unwrap()],
        )
        .unwrap();
    state
        .save_group(super::super::AgentProjectGroupInput {
            id: "g1".into(),
            name: "Suite".into(),
            project_ids: vec![member.id.clone()],
        })
        .unwrap();
    let overview = state
        .prepare_group_project_with("g1", |_, id| Ok(format!("/srv/groups/{id}")))
        .unwrap();
    let agent = session("session", "claude", &["--model", "opus"]);
    let db = &lock(&state.store).unwrap().db;

    let launch = scheduled_session(db, &overview, &agent).unwrap().unwrap();
    let command = launch_command(&overview, &launch, "/revue").unwrap();
    assert!(command.contains("'--add-dir' '/srv/api'"), "{command}");
    assert!(command.contains("'--model' 'opus'"), "{command}");
    assert!(scheduled_session(db, &member, &agent).unwrap().is_none());
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod server {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        process::Command,
        time::Instant,
    };

    struct Server {
        home: PathBuf,
    }
    impl Server {
        fn new() -> Self {
            // Sockets must fit in sun_path: a short root, not temp_dir().
            let root = Path::new("/tmp").join(format!("soreno-au-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let home = root.join("home");
            let automations = home.join(".config/soreno/automations");
            std::fs::create_dir_all(&automations).unwrap();
            let dtach = root.join("dtach");
            std::fs::copy(
                concat!(env!("CARGO_MANIFEST_DIR"), "/dtach/bin/linux-x86_64/dtach"),
                &dtach,
            )
            .unwrap();
            std::fs::set_permissions(&dtach, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::write(automations.join("dtach"), format!("{}\n", dtach.display())).unwrap();
            Self { home }
        }
        fn sh(&self, script: &str) -> Vec<u8> {
            let output = Command::new("/bin/sh")
                .args(["-c", script])
                .env_clear()
                .env("HOME", &self.home)
                .env("PATH", "/usr/bin:/bin")
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            output.stdout
        }
        /// Writes the run script as installation does, then runs it as the timer would.
        fn fire(&self, session: &AgentSession) {
            let directory = self
                .home
                .join(".config/soreno/automations")
                .join(remote_host::key(&session.id));
            std::fs::create_dir_all(&directory).unwrap();
            let script = run_script(&project("/tmp"), session, "/revue").unwrap();
            std::fs::write(directory.join("run"), script).unwrap();
            self.sh(&format!("/bin/sh {}", directory.join("run").display()));
        }
        fn state(&self, session_id: &str) -> AgentAutomationRun {
            parse_state(&self.sh(&state_script(&[session_id])))
                .pop()
                .unwrap()
                .1
        }
        fn wait_for(&self, session_id: &str, check: impl Fn(&AgentAutomationRun) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let run = self.state(session_id);
                if check(&run) {
                    return;
                }
                assert!(Instant::now() < deadline, "{run:?}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        fn kill(&self, session_id: &str) {
            let pid = std::fs::read_to_string(
                self.home
                    .join(".cache/soreno/sessions")
                    .join(remote_host::key(session_id))
                    .join("pid"),
            )
            .unwrap();
            let master = pid.split_whitespace().next().unwrap();
            Command::new("kill").args(["-9", master]).status().unwrap();
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.home.parent().unwrap());
        }
    }

    #[test]
    fn a_run_starts_detached_skips_while_open_and_reports_a_missing_agent() {
        let server = Server::new();
        let agent = session("agent", "/bin/sh", &["-c", "sleep 30"]);
        server.fire(&agent);
        server.wait_for("agent", |run| run.running);
        assert_eq!(server.state("agent").outcome, "started");

        // The user's open session is never replaced by the next run.
        server.fire(&agent);
        let skipped = server.state("agent");
        assert_eq!(skipped.outcome, "skipped");
        assert!(!skipped.running);
        server.kill("agent");

        let missing = session("missing", "soreno-missing-agent", &[]);
        server.fire(&missing);
        server.wait_for("missing", |run| run.exit_code == Some(209));
        assert_eq!(server.state("missing").outcome, "started");
    }
}
