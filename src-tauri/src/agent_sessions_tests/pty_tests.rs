use super::*;

#[cfg(windows)]
#[derive(Debug)]
struct NoopKiller;
#[cfg(windows)]
impl ChildKiller for NoopKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self)
    }
}
#[cfg(windows)]
#[test]
fn exited_wsl_cleanup_is_retried_before_runtime_identity_is_discarded() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let state = memory_state();
    state.save_project(project()).unwrap();
    state.save_session(session()).unwrap();
    let runtime = Arc::new(Runtime {
        output: Mutex::new(Output {
            exited: true,
            exit_code: Some(0),
            ..Output::default()
        }),
        grid: Mutex::new(None),
        writer: Mutex::new(None),
        size: Mutex::new(size(80, 24).unwrap()),
        master: Mutex::new(None),
        killer: Mutex::new(Box::new(NoopKiller)),
        remote_clipboard: None,
        local_attachment_directory: Mutex::new(None),
        remote_sidecar_generation: None,
        wsl: Some(WslRun {
            distribution: String::new(),
            directory: String::new(),
            stopped: AtomicBool::new(false),
            stop_results: Some(Mutex::new(VecDeque::from([
                Err("échec simulé du nettoyage WSL".into()),
                Ok(()),
            ]))),
        }),
        // A successful retry proves stop did not signal this invalid handle
        // after observing that the main process had already exited.
        process_handle: 0,
    });
    lock(&state.store)
        .unwrap()
        .runtimes
        .insert("session".into(), Arc::clone(&runtime));

    assert_eq!(terminal(&state, "session").unwrap().status.state, "exited");

    assert!(state
        .delete_session("session")
        .unwrap_err()
        .contains("échec simulé"));
    assert_eq!(terminal(&state, "session").unwrap().status.state, "exited");
    assert!(!runtime
        .wsl
        .as_ref()
        .unwrap()
        .stopped
        .load(Ordering::Acquire));

    state.stop("session").unwrap();
    assert!(runtime
        .wsl
        .as_ref()
        .unwrap()
        .stopped
        .load(Ordering::Acquire));
    state.delete_session("session").unwrap();
    assert!(lock(&state.store).unwrap().runtimes.is_empty());
}
#[cfg(windows)]
#[test]
fn packaged_conpty_loader_rejects_missing_or_invalid_assets() {
    let root = unique_temp_path("soreno-conpty-loader");
    assert!(conpty::load_from(&root).unwrap_err().contains("conpty.dll"));

    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("conpty.dll"), b"not a dll").unwrap();
    assert!(conpty::load_from(&root)
        .unwrap_err()
        .contains("OpenConsole.exe"));

    std::fs::write(root.join("OpenConsole.exe"), b"not used").unwrap();
    assert!(conpty::load_from(&root)
        .unwrap_err()
        .contains("Impossible de charger"));
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn real_wsl_conpty_synchronized_output_opt_in() {
    let Ok(distribution) = std::env::var("SORENO_TEST_WSL_DISTRO") else {
        return;
    };
    let state = memory_state();
    let mut saved_project = project();
    saved_project.path = "/tmp".into();
    saved_project.environment = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some(distribution),
        ssh: None,
    };
    state.save_project(saved_project).unwrap();
    let mut saved_session = session();
    saved_session.args = vec![
            "-c".into(),
            r#"i=0; while [ "$i" -lt 8 ]; do printf '\033[?2026h\033[2J\033[H'; j=0; while [ "$j" -lt 30 ]; do printf 'SYNTHETIC FRAME %d ROW %02d ....................................\r\n' "$i" "$j"; j=$((j+1)); done; printf 'FOOTER-%d\033[?2026l' "$i"; sleep 0.12; i=$((i+1)); done; sleep 0.2"#.into(),
        ];
    state.save_session(saved_session).unwrap();
    state.start("session", 80, 24, None).unwrap();
    let terminal = wait_for_windows_output(&state, "session", "FOOTER-7", true);
    assert_eq!(terminal.status.exit_code, Some(0));
    let output = terminal.text();
    assert_eq!(output.matches("\u{1b}[?2026h").count(), 8, "{output:?}");
    assert_eq!(output.matches("\u{1b}[?2026l").count(), 8, "{output:?}");

    let mut remainder = output.as_str();
    for frame in 0..8 {
        let begin = remainder
            .find("\u{1b}[?2026h")
            .unwrap_or_else(|| panic!("frame {frame} has no synchronized-output start"));
        let after_begin = &remainder[begin + "\u{1b}[?2026h".len()..];
        let end = after_begin
            .find("\u{1b}[?2026l")
            .unwrap_or_else(|| panic!("frame {frame} has no synchronized-output end"));
        let contents = &after_begin[..end];
        assert!(
            contents.contains(&format!("FOOTER-{frame}")),
            "{contents:?}"
        );
        for row in 0..30 {
            assert!(
                contents.contains(&format!("SYNTHETIC FRAME {frame} ROW {row:02}")),
                "frame {frame}, row {row}: {contents:?}"
            );
        }
        remainder = &after_begin[end + "\u{1b}[?2026l".len()..];
    }
}

#[cfg(windows)]
#[test]
fn real_windows_ps1_rejects_lossy_args_before_execution() {
    let directory = std::env::temp_dir().join(format!("soreno-ps1-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let script = directory.join("shim.ps1");
    let marker = directory.join("executed");
    std::fs::write(
        &script,
        "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'executed'), 'bad')",
    )
    .unwrap();
    let state = memory_state();
    state.save_project(project()).unwrap();
    for arg in ["", "a\"b", "a b\\"] {
        let mut session = session();
        session.executable = script.to_string_lossy().into();
        session.args = vec![arg.into()];
        state.save_session(session).unwrap();
        state.start("session", 160, 40, None).unwrap();
        let terminal = wait_for_windows_output(&state, "session", "Windows PowerShell 5.1", true);
        assert_eq!(terminal.status.exit_code, Some(1));
        assert!(
            !marker.exists(),
            "shim executed with lossy argument {arg:?}"
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}
#[cfg(windows)]
#[test]
fn real_wsl_hostile_environment_opt_in() {
    if std::env::var("SORENO_TEST_WSL_DISTRO").is_err() {
        return;
    }
    // Change only this subprocess environment, never global test/app state.
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "agent_sessions::tests::wsl_hostile_environment_fixture",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(
            "PATH",
            format!("{}\\System32", std::env::var("SystemRoot").unwrap()),
        )
        .env(
            "WSLENV",
            "PATH/lp:TEMP/p:TMP/p:HOME/p:TMPDIR/p:SORENO_TEST_WSL_CREDENTIAL/u",
        )
        .env("HOME", "C:\\host-only-home")
        .env("TMPDIR", "C:\\host-only-tmp")
        .env("WSL_UTF8", "1")
        .env("SORENO_TEST_WSL_CREDENTIAL", "kept-by-soreno")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
#[cfg(windows)]
#[test]
fn real_windows_native_pty() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    let mut session = session();
    session.executable = "powershell.exe".into();
    session.args = vec!["-NoLogo".into(), "-NoProfile".into(), "-Command".into(), "[Console]::WriteLine(\"ready ' $([char]36) & ;\"); $line=[Console]::ReadLine(); [Console]::WriteLine('received:'+$line); Start-Sleep 60".into()];
    state.save_session(session).unwrap();
    state.start("session", 80, 24, None).unwrap();
    let initial = wait_for_windows_output(&state, "session", "ready ' $ & ;", false);
    let initial = initial.text();
    assert!(initial.find("\u{1b}[2J").unwrap() < initial.find("ready ' $ & ;").unwrap());
    state.resize("session", 120, 40).unwrap();
    state.write("session", "hello\r").unwrap();
    wait_for_windows_output(&state, "session", "received:hello", false);
    state.stop("session").unwrap();
    wait_for(|| state.statuses().unwrap()[0].state == "exited");
    state.stop("session").unwrap();
    state.delete_project("project").unwrap();
}
#[cfg(windows)]
#[test]
pub(super) fn real_wsl_agent_versions_opt_in() {
    if std::env::var("SORENO_TEST_WSL_AGENTS").as_deref() != Ok("1") {
        return;
    }
    let distribution = std::env::var("SORENO_TEST_WSL_DISTRO")
        .expect("Set SORENO_TEST_WSL_DISTRO for the CLI smoke test");
    let state = memory_state();
    let mut project = project();
    project.environment = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some(distribution),
        ssh: None,
    };
    project.path = "/tmp".into();
    state.save_project(project).unwrap();
    for executable in ["pi", "omp", "codex"] {
        let mut session = session();
        session.id = executable.into();
        session.executable = executable.into(); // Exercise login shell PATH, not hard-coded installations.
        session.args = vec!["--version".into()];
        state.save_session(session).unwrap();
        state.start(executable, 100, 30, None).unwrap();
        let terminal = wait_for_windows_output(&state, executable, "", true);
        let output = terminal.text();
        assert_eq!(
            terminal.status.exit_code,
            Some(0),
            "{executable}: {output:?}"
        );
        assert!(
            output
                .split(|c: char| !c.is_ascii_digit() && c != '.')
                .any(|part| {
                    part.contains('.') && part.split('.').all(|digits| !digits.is_empty())
                }),
            "{executable} did not print a version: {output:?}"
        );
        println!("{executable} --version: {output:?}");
    }
}
#[cfg(windows)]
#[test]
pub(super) fn real_wsl_pty_opt_in() {
    let Ok(distribution) = std::env::var("SORENO_TEST_WSL_DISTRO") else {
        return;
    };
    let directory = format!("/tmp/soreno test {}", std::process::id());
    let mut mkdir = std::process::Command::new("wsl.exe");
    mkdir.args([
        "--distribution",
        &distribution,
        "--exec",
        "mkdir",
        "-p",
        "--",
        &directory,
    ]);
    probe_output(mkdir).unwrap();
    let environment = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some(distribution.clone()),
        ssh: None,
    };
    let unc = format!(
        "\\\\wsl.localhost\\{}{}",
        distribution,
        directory.replace('/', "\\")
    );
    let resolved = resolve_picked_project_directory(&environment, PathBuf::from(&unc)).unwrap();
    assert_eq!(resolved.path, directory);
    assert_eq!(resolved.environment, environment);
    assert_eq!(
        resolve_picked_project_directory(&project().environment, PathBuf::from(&unc)).unwrap(),
        resolved
    );
    assert!(validate_local_directory(&unc)
        .unwrap_err()
        .contains("environnement WSL"));
    let drive = resolve_picked_project_directory(&environment, PathBuf::from("C:\\"))
        .expect("wslpath must resolve a Windows drive path");
    assert!(drive.path.starts_with('/'), "{}", drive.path);

    let state = memory_state();
    let mut project = project();
    project.path = unc;
    state.save_project(project).unwrap();
    let workspace = state.workspace().unwrap();
    assert_eq!(workspace.projects[0].path, directory);
    assert_eq!(workspace.projects[0].environment, environment);
    let mut session = session();
    session.args = vec!["-c".into(), "printf 'cwd:%s\\n' \"$PWD\"; printf ready; read line; printf 'received:%s\\n' \"$line\"; sleep 60 & printf 'descendant:%s\\n' \"$!\"; wait".into()];
    state.save_session(session.clone()).unwrap();
    state.start("session", 80, 24, None).unwrap();
    let output = || terminal(&state, "session").unwrap().text();
    wait_for_windows_output(&state, "session", "ready", false);
    assert!(
        output().contains(&format!("cwd:{directory}")),
        "{}",
        output()
    );
    state.resize("session", 120, 40).unwrap();
    state.write("session", "hello\n").unwrap();
    wait_for(|| output().contains("received:hello") && output().contains("descendant:"));
    let output_text = output();
    let descendant: String = output_text
        .split("descendant:")
        .last()
        .unwrap()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    assert!(!descendant.is_empty(), "{output_text}");
    let mut short = session.clone();
    short.id = "short".into();
    short.args = vec!["-c".into(), "printf short-finished".into()];
    state.save_session(short).unwrap();
    state.start("short", 80, 24, None).unwrap();
    let finished = wait_for_windows_output(&state, "short", "short-finished", true);
    assert_eq!(finished.status.exit_code, Some(0));
    assert_eq!(terminal(&state, "session").unwrap().status.state, "running");
    state.stop("session").unwrap();
    wait_for(|| state.statuses().unwrap()[0].state == "exited");
    state.stop("session").unwrap();
    let mut check = std::process::Command::new("wsl.exe");
    check.args([
        "--distribution",
        &distribution,
        "--exec",
        "sh",
        "-c",
        "[ ! -e \"/proc/$1/stat\" ] || grep -q ') Z ' \"/proc/$1/stat\"",
        "soreno",
        &descendant,
    ]);
    probe_output(check).expect("WSL descendant must be dead after stop");

    session.args = vec![
        "-c".into(),
        "printf 'leader:%s\\n' \"$$\"; sleep 60 & printf 'descendant:%s\\n' \"$!\"; wait".into(),
    ];
    state.save_session(session).unwrap();
    state.start("session", 80, 24, None).unwrap();
    wait_for_windows_output(&state, "session", "descendant:", false);
    let output_text = output();
    let pids: Vec<String> = ["leader:", "descendant:"]
        .into_iter()
        .map(|marker| {
            let pid: String = output_text
                .split(marker)
                .last()
                .unwrap()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            assert!(!pid.is_empty(), "{output_text}");
            pid
        })
        .collect();
    state.shutdown();
    wait_for(|| terminal(&state, "session").unwrap().status.state == "exited");
    for pid in pids {
        let mut check = std::process::Command::new("wsl.exe");
        check.args([
            "--distribution",
            &distribution,
            "--exec",
            "sh",
            "-c",
            "[ ! -e \"/proc/$1/stat\" ] || grep -q ') Z ' \"/proc/$1/stat\"",
            "soreno",
            &pid,
        ]);
        probe_output(check).expect("WSL CLI and descendant must be dead after shutdown");
    }
    state.delete_project("project").unwrap();
    let mut remove = std::process::Command::new("wsl.exe");
    remove.args([
        "--distribution",
        &distribution,
        "--exec",
        "rmdir",
        "--",
        &directory,
    ]);
    probe_output(remove).unwrap();
}
#[cfg(unix)]
#[test]
fn unix_descendants_cleaned_after_natural_exit_stop_and_shutdown() {
    use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate};
    let mut independent = std::process::Command::new("/bin/sleep")
        .arg("60")
        .env_remove("SORENO_AGENT_RUN")
        .spawn()
        .unwrap();
    let mut tokens = Vec::new();
    for mode in ["natural", "stop", "shutdown"] {
        let state = memory_state();
        state.save_project(project()).unwrap();
        let mut session = session();
        session.executable = "/usr/bin/env".into();
        session.args = vec![
            format!(
                "SORENO_TEST_UNIX_WAIT={}",
                if mode == "natural" { "0" } else { "1" }
            ),
            std::env::current_exe().unwrap().to_string_lossy().into(),
            "--ignored".into(),
            "--exact".into(),
            "agent_sessions::tests::unix_descendant_fixture".into(),
            "--nocapture".into(),
        ];
        state.save_session(session).unwrap();
        state.start("session", 100, 30, None).unwrap();
        let runtime = state.runtime("session").unwrap().unwrap();
        assert!(!tokens.contains(&runtime.run_token));
        tokens.push(runtime.run_token.clone());
        let output = || terminal(&state, "session").unwrap().text();
        wait_for(|| output().contains("detached:"));
        let text = output();
        let pids: Vec<Pid> = ["normal:", "detached:"]
            .iter()
            .map(|marker| {
                Pid::from_u32(
                    text.split(marker)
                        .last()
                        .unwrap()
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                        .parse()
                        .unwrap(),
                )
            })
            .collect();
        match mode {
            "stop" => state.stop("session").unwrap(),
            "shutdown" => state.shutdown(),
            _ => {}
        }
        wait_for(|| terminal(&state, "session").unwrap().status.state == "exited");
        wait_for(|| {
            let processes = unix_processes(ProcessesToUpdate::Some(&pids));
            pids.iter().all(|pid| {
                processes
                    .process(*pid)
                    .is_none_or(|p| p.status() == ProcessStatus::Zombie)
            })
        });
        assert!(!output().contains("[Arrêt Unix"), "{}", output());
        // Model cleanup needing a retry after exit (e.g. a late descendant).
        // Neither explicit stop nor shutdown may short-circuit on `exited`.
        for shutdown in [false, true] {
            let mut late = std::process::Command::new("/bin/sleep")
                .arg("60")
                .env("SORENO_AGENT_RUN", &runtime.run_token)
                .spawn()
                .unwrap();
            if mode != "shutdown" {
                let lease = state.begin_git_operation("project").unwrap();
                lock(&state.store)
                    .unwrap()
                    .git_stopped_projects
                    .insert("project".into());
                assert!(state
                    .start("session", 80, 24, None)
                    .unwrap_err()
                    .contains("Git"));
                drop(lease);
            }
            if shutdown {
                state.shutdown();
            } else {
                state.stop("session").unwrap();
            }
            wait_for(|| late.try_wait().unwrap().is_some());
        }
        assert!(
            independent.try_wait().unwrap().is_none(),
            "unrelated process killed"
        );
    }
    independent.kill().unwrap();
    independent.wait().unwrap();
}
#[cfg(unix)]
#[test]
fn git_lease_blocks_only_stopped_projects_from_starting() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    state.save_session(session()).unwrap();
    let lease = state.begin_git_operation("project").unwrap();
    state.start("session", 80, 24, None).unwrap();
    state.stop("session").unwrap();
    wait_for(|| terminal(&state, "session").unwrap().status.state == "exited");
    lease.stop_project_sessions(&["project".into()]).unwrap();
    assert!(state
        .start("session", 80, 24, None)
        .unwrap_err()
        .starts_with("[Git/busy]"));
    drop(lease);
    state.start("session", 80, 24, None).unwrap();
    state.stop("session").unwrap();
}
#[cfg(unix)]
#[test]
fn real_pty_lifecycle_resize_write_stop_and_delete_guards() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    state.save_session(session()).unwrap();
    state.start("session", 80, 24, None).unwrap();
    assert!(state.start("session", 80, 24, None).is_err());
    assert!(state.delete_project("project").is_err());
    assert!(state.delete_session("session").is_err());
    let original_runtime = state.runtime("session").unwrap().unwrap();
    let mut renamed = session();
    renamed.name = "Renamed while running".into();
    state.save_session(renamed.clone()).unwrap();
    assert_eq!(state.workspace().unwrap().sessions[0].name, renamed.name);
    assert_eq!(state.statuses().unwrap()[0].state, "running");
    assert!(Arc::ptr_eq(
        &original_runtime,
        &state.runtime("session").unwrap().unwrap()
    ));
    let mut changed = renamed.clone();
    changed.args.push("different argument".into());
    assert!(state.save_session(changed).is_err());
    let mut changed = renamed;
    changed.executable = "different-executable".into();
    assert!(state.save_session(changed).is_err());
    state.resize("session", 120, 40).unwrap();
    let runtime = state.runtime("session").unwrap().unwrap();
    assert_eq!(*lock(&runtime.size).unwrap(), size(120, 40).unwrap());
    assert_eq!(
        lock(&runtime.master)
            .unwrap()
            .as_ref()
            .unwrap()
            .get_size()
            .unwrap()
            .cols,
        120
    );
    wait_for(|| {
        terminal(&state, "session")
            .unwrap()
            .text()
            .contains("ready")
    });
    state.write("session", "hello\n").unwrap();
    wait_for(|| state.statuses().unwrap()[0].state == "exited");
    wait_for(|| {
        terminal(&state, "session")
            .unwrap()
            .text()
            .contains("received:hello")
    });
    assert_eq!(state.statuses().unwrap()[0].exit_code, Some(0));
    let mut sleeping = session();
    sleeping.kind = "service".into();
    sleeping.service_id = Some("worker".into());
    sleeping.working_directory = Some(project().path);
    sleeping.args = vec!["-c".into(), "trap '' HUP; printf ready; sleep 60".into()];
    state.save_session(sleeping.clone()).unwrap();
    state.start("session", 80, 24, None).unwrap();
    wait_for(|| {
        terminal(&state, "session")
            .unwrap()
            .text()
            .contains("ready")
    });
    let mut changed = sleeping.clone();
    changed.service_id = Some("other".into());
    assert!(state.save_session(changed).is_err());
    let mut changed = sleeping.clone();
    changed.working_directory = Some("/".into());
    assert!(state.save_session(changed).is_err());
    let mut changed = sleeping;
    changed.kind = "terminal".into();
    changed.service_id = None;
    changed.working_directory = None;
    assert!(state.save_session(changed).is_err());
    state.stop("session").unwrap();
    state.stop("session").unwrap();
    wait_for(|| state.statuses().unwrap()[0].state == "exited");
    state.stop("session").unwrap();
    state.delete_session("session").unwrap();
    state.shutdown();
    state.save_session(session()).unwrap();
    assert!(state.start("session", 80, 24, None).is_err());
}
#[cfg(unix)]
#[test]
fn real_pty_serializes_repaint_with_concurrent_resize() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    let mut agent = session();
    agent.args = vec![
        "-c".into(),
        "trap 'stty size' WINCH; printf ready; while :; do sleep 0.05; done".into(),
    ];
    state.save_session(agent).unwrap();
    state.start("session", 80, 24, None).unwrap();
    let text = || terminal(&state, "session").unwrap().text();
    wait_for(|| text().contains("ready"));
    let runtime = state.runtime("session").unwrap().unwrap();
    Arc::clone(&runtime).repaint();
    wait_for(|| {
        lock(&runtime.master)
            .unwrap()
            .as_ref()
            .unwrap()
            .get_size()
            .unwrap()
            == size(80, 25).unwrap()
            && runtime.size.try_lock().is_err()
    });
    let (sent, received) = std::sync::mpsc::channel();
    thread::scope(|scope| {
        scope.spawn(|| sent.send(state.resize("session", 120, 40)).unwrap());
        assert!(matches!(
            received.recv_timeout(REPAINT_SETTLE / 2),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
    });
    assert_eq!(*lock(&runtime.size).unwrap(), size(120, 40).unwrap());
    assert_eq!(
        lock(&runtime.master)
            .unwrap()
            .as_ref()
            .unwrap()
            .get_size()
            .unwrap(),
        size(120, 40).unwrap()
    );
    state.stop("session").unwrap();
    wait_for(|| state.statuses().unwrap()[0].state == "exited");
}
