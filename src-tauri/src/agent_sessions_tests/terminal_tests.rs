use super::*;

#[test]
fn buffer_evicts_bytes_beyond_the_limit() {
    let mut output = Output::default();
    output.append(b"evicted");
    output.append(&vec![b'x'; BUFFER_LIMIT]);
    assert_eq!(output.bytes.len(), BUFFER_LIMIT);
    assert_eq!(output.end, BUFFER_LIMIT as u64 + 7);
    assert!(output.bytes.iter().all(|&byte| byte == b'x'));
}

#[test]
fn reattached_history_keeps_its_mode_prefix_through_the_following_redraw() {
    let mut output = Output::default();
    let preamble = b"ssh and dtach preamble\r\n";
    let prefix = b"\x1b[?2004h";
    let mut history = prefix.to_vec();
    history.extend(vec![b'h'; 1024 * 1024]);
    output.append(preamble);
    output.append_history(&history);
    output.append(&vec![b'x'; 200 * 1024]);

    let data: Vec<u8> = output.bytes.iter().copied().collect();
    let base = output.end - data.len() as u64;
    let prefix_start = preamble.len() as u64;
    assert!(base <= prefix_start, "the mode-restore prefix was evicted");
    assert!(data[(prefix_start - base) as usize..].starts_with(prefix));
    assert_eq!(output.restored_end, prefix_start + history.len() as u64);
}

fn full_redraw(screen: &[u8]) -> Vec<u8> {
    [
        b"\x1b[?2026h\x1b[?7l\x1b[H\x1b[2J\x1b[3J".as_slice(),
        screen,
        b"\x1b[?7h\x1b[?2026l",
    ]
    .concat()
}

#[test]
fn the_last_full_redraw_is_retained_beyond_the_buffer_limit() {
    let mut output = Output::default();
    let painted = b"frames painted before the redraw";
    output.append(painted);
    let redraw = full_redraw(&vec![b'h'; BUFFER_LIMIT]);
    for piece in redraw.chunks(7) {
        output.append(piece);
    }
    let diffs = vec![b'd'; BUFFER_LIMIT];
    output.append(&diffs);

    assert_eq!(output.keyframe, Some(painted.len() as u64));
    let retained: Vec<u8> = output.bytes.iter().copied().collect();
    assert_eq!(retained, [redraw, diffs].concat());
}

#[test]
fn full_redraw_beyond_the_keyframe_limit_is_evicted() {
    let mut output = Output::default();
    output.append(&full_redraw(b"screen"));
    output.append(&vec![b'd'; KEYFRAME_LIMIT]);
    assert_eq!(output.bytes.len(), BUFFER_LIMIT);
    assert_eq!(output.keyframe, None);
}

#[test]
fn program_status_comes_before_hooks_and_flags_clis_too_old_to_report_it() {
    use crate::agent_sessions::program_status::ProgramState::{Blocked, Finished, Idle, Working};
    use conversations::Provider::{Claude, Pi};
    let reported = |working, awaiting| conversations::Activity {
        working,
        awaiting,
        turn: None,
    };
    for (provider, state, seen, reported, expected) in [
        (
            Claude,
            None,
            false,
            reported(None, false),
            (None, false, false),
        ),
        (
            Claude,
            None,
            false,
            reported(Some(true), true),
            (None, false, true),
        ),
        // Escape interrupts the turn without a Stop hook.
        (
            Claude,
            Some(Idle),
            true,
            reported(Some(true), false),
            (Some(false), false, false),
        ),
        // The prompt was answered without a hook.
        (
            Claude,
            Some(Working),
            true,
            reported(Some(true), true),
            (Some(true), false, false),
        ),
        (
            Claude,
            Some(Blocked),
            true,
            reported(Some(true), false),
            (Some(true), true, false),
        ),
        // Background agents still run after `done`.
        (
            Claude,
            Some(Finished),
            true,
            reported(Some(true), false),
            (Some(true), false, false),
        ),
        (
            Claude,
            None,
            true,
            reported(Some(true), false),
            (None, false, false),
        ),
        (
            Pi,
            None,
            false,
            reported(Some(true), true),
            (Some(true), true, false),
        ),
        (
            Pi,
            Some(Idle),
            true,
            reported(Some(true), true),
            (Some(false), true, false),
        ),
    ] {
        let output = Output {
            program_state: state,
            reports_program_status: seen,
            ..Output::default()
        };
        let mut status = output.status("session");
        output.report_activity(provider, &reported, &mut status);
        assert_eq!(
            (status.working, status.awaiting, status.outdated_cli),
            expected,
            "{provider:?} {state:?} {reported:?}"
        );
    }
}

#[test]
fn message_previews_fit_one_notification_line() {
    let long = "a".repeat(250);
    for (message, preview) in [
        (
            "  Done.\n\n\tAll   tests\u{7}pass ",
            Some("Done. All testspass".to_string()),
        ),
        (" \n\u{1b}\t", None),
        (long.as_str(), Some(format!("{}…", "a".repeat(199)))),
        (&long[..200], Some("a".repeat(200))),
    ] {
        assert_eq!(message_preview(message), preview, "{message:?}");
    }
}

#[test]
fn wsl_utf16_names_are_clean() {
    let bytes: Vec<u8> = "\u{feff}Ubuntu\r\nDebian\r\nUbuntu\r\n\0"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(parse_wsl(&bytes).unwrap(), ["Ubuntu", "Debian"]);
    assert!(parse_wsl(&[1]).is_err());
    assert!(parse_wsl(&[0, 0xd8]).is_err());
    assert!(parse_wsl(&[]).unwrap().is_empty());
}
#[test]
fn wslenv_filters_only_linux_owned_paths() {
    assert_eq!(filtered_wslenv("PATH/lp:TEMP/p:TMP/p"), "");
    assert_eq!(
        filtered_wslenv("Token/u:paTh/lp:HOME/p:tmpDir/p:Keep/lw:home:temp:tmp"),
        "Token/u:Keep/lw"
    );
    assert_eq!(filtered_wslenv(""), "");
    assert_eq!(
        filtered_wslenv("MY_PATH/p:API_KEY:PATHNAME/l"),
        "MY_PATH/p:API_KEY:PATHNAME/l"
    );
}
#[test]
fn ps1_rejects_arguments_legacy_powershell_cannot_forward() {
    for arg in ["", "a\"b", "a b\\", "a\tb\\"] {
        assert!(!legacy_powershell_args_safe(&[arg.into()]), "{arg:?}");
    }
    assert!(legacy_powershell_args_safe(&[]));
    assert!(legacy_powershell_args_safe(&[
        "--version".into(),
        "a b".into(),
        "a\\".into(),
        "a'b".into(),
        "$() & ;".into()
    ]));
}
#[test]
fn windows_arguments_are_crt_quoted() {
    assert_eq!(windows_quote(""), "\"\"");
    assert_eq!(windows_quote("a b\\"), "\"a b\\\\\"");
    assert_eq!(windows_quote("a\"b"), "\"a\\\"b\"");
    assert_eq!(windows_quote("& %PATH% $()"), "\"& %PATH% $()\"");
}
#[cfg(unix)]
#[test]
fn conversation_environment_reaches_posix_cli_children() {
    let mut agent = session();
    agent.executable = "sh".into();
    agent.args = vec![
        "-c".into(),
        "printf '%s' \"$SORENO_CONVERSATION_METADATA\"".into(),
    ];
    let command = posix_command_with_environment(
        &agent,
        &[(
            "SORENO_CONVERSATION_METADATA".into(),
            "/tmp/sidecar with ' quote.json".into(),
        )],
        None,
    );
    let output = std::process::Command::new("sh")
        .args(["-c", &command])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .ends_with("/tmp/sidecar with ' quote.json"));
}
#[cfg(unix)]
#[test]
fn posix_environment_executes_paths_containing_equals() {
    use std::os::unix::fs::PermissionsExt;

    let root = unique_temp_path("soreno-posix-executable");
    let executable = root.join("cli=stable");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(
        &executable,
        "#!/bin/sh\nprintf '%s' \"$SORENO_TEST_VALUE\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();

    let mut agent = session();
    agent.executable = executable.to_string_lossy().into_owned();
    agent.args.clear();
    let command = posix_command_with_environment(
        &agent,
        &[("SORENO_TEST_VALUE".into(), "value with ' apostrophe".into())],
        None,
    );
    let output = std::process::Command::new("sh")
        .args(["-c", &command])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .ends_with("value with ' apostrophe"));
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn conversation_tty_path_survives_closed_fds_and_setsid() {
    let mut agent = session();
    agent.executable = "sh".into();
    agent.args = vec![
            "-c".into(),
            "exec 3>&-; \"$1\" --ignored --exact agent_sessions::tests::conversation_detached_writer_helper --nocapture".into(),
            "soreno".into(),
            std::env::current_exe().unwrap().to_string_lossy().into_owned(),
        ];
    let command = posix_command_with_environment(
        &agent,
        &[
            ("SORENO_CONVERSATION_REMOTE".into(), "1".into()),
            ("SORENO_TEST_DETACHED_WRITER".into(), "1".into()),
        ],
        None,
    );
    let pair = native_pty_system().openpty(size(80, 24).unwrap()).unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut pty_command = CommandBuilder::new("sh");
    pty_command.args(["-c", &command]);
    let mut child = pair.slave.spawn_command(pty_command).unwrap();
    // An exiting macOS session leader waits until its output is read, and unread output is lost
    // without EOF once the last slave closes: read while it runs and keep our slave open.
    let master = pair.master.as_raw_fd().unwrap();
    assert_ne!(
        unsafe {
            libc::fcntl(
                master,
                libc::F_SETFL,
                libc::fcntl(master, libc::F_GETFL) | libc::O_NONBLOCK,
            )
        },
        -1
    );
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    let status = loop {
        let exited = child.try_wait().unwrap();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => output.extend_from_slice(&buffer[..read]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("{error}"),
            }
        }
        if let Some(status) = exited {
            break status;
        }
        let mut readable = libc::pollfd {
            fd: master,
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe { libc::poll(&mut readable, 1, 100) };
    };
    drop(pair.slave);
    assert!(status.success());
    assert!(output
        .windows(b"private-osc-bytes".len())
        .any(|window| window == b"private-osc-bytes"));
}
#[cfg(unix)]
#[test]
fn commands_use_and_validate_the_session_working_directory() {
    let root = unique_temp_path("soreno-service-cwd");
    let project_directory = root.join("project");
    let service_directory = root.join("service with ' quote");
    std::fs::create_dir_all(&project_directory).unwrap();
    std::fs::create_dir(&service_directory).unwrap();
    let mut saved_project = project();
    saved_project.path = project_directory.to_string_lossy().into();
    let mut service = session();
    service.kind = "service".into();
    service.service_id = Some("web".into());
    service.working_directory = Some(service_directory.to_string_lossy().into());

    let command = local_command(&saved_project, &service).unwrap();
    let argv = command
        .get_argv()
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>();
    assert!(
        argv.iter().any(|arg| arg.contains("service with")),
        "{argv:?}"
    );

    service.working_directory = Some(root.join("missing").to_string_lossy().into());
    assert!(local_command(&saved_project, &service).is_err());

    let mut remote = ssh_project("remote");
    remote.path = "/srv/project".into();
    service.working_directory = Some("/srv/service dir's".into());
    let remote_command = local_command(&remote, &service).unwrap();
    let remote_argv = remote_command
        .get_argv()
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>();
    assert!(
        remote_argv
            .last()
            .is_some_and(|arg| arg.contains("/srv/service dir") && !arg.contains("/srv/project")),
        "{remote_argv:?}"
    );
    service.working_directory = Some("relative".into());
    assert!(local_command(&remote, &service).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn missing_posix_working_directory_does_not_launch_service() {
    let root = unique_temp_path("soreno-missing-service-cwd");
    let marker = root.join("launched");
    std::fs::create_dir(&root).unwrap();
    let mut service = session();
    service.kind = "service".into();
    service.service_id = Some("web".into());
    service.working_directory = Some(root.join("missing").to_string_lossy().into());
    service.args = vec![
        "-c".into(),
        "printf launched > \"$1\"".into(),
        "soreno-service".into(),
        marker.to_string_lossy().into(),
    ];

    let output = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            &posix_command_in(service.working_directory.as_deref().unwrap(), &service),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!marker.exists());
    std::fs::remove_dir(root).unwrap();
}

#[cfg(unix)]
#[test]
fn hostile_posix_arguments_are_data() {
    let args = [
        "",
        "a'b",
        "$(touch /never-created)",
        "x;exit 99",
        "\"quoted\"",
        "a\nb",
        "\\",
        "`id`",
    ];
    let mut session = session();
    session.executable = "/usr/bin/printf".into();
    session.args = std::iter::once("%s\\0")
        .chain(args)
        .map(str::to_owned)
        .collect();
    let output = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            &format!("printf 'shell startup\\n'; {}", posix_command(&session)),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        output.stdout,
        b"shell startup\n\x1b[H\x1b[2J\x1b[3J"
            .iter()
            .copied()
            .chain(args.iter().flat_map(|s| s.bytes().chain([0])))
            .collect::<Vec<_>>()
    );
}
#[cfg(unix)]
#[test]
fn default_shell_is_interactive_in_the_project_directory() {
    let root = unique_temp_path("soreno-terminal-io");
    let directory = root.join("project with ' quote");
    std::fs::create_dir_all(&directory).unwrap();
    let state = memory_state();
    let mut saved_project = project();
    saved_project.path = directory.to_string_lossy().into();
    state.save_project(saved_project).unwrap();
    let mut shell = session();
    shell.executable.clear();
    shell.args.clear();
    state.save_session(shell).unwrap();
    state.start("session", 80, 24, None).unwrap();
    state
        .write("session", "printf 'terminal-cwd:%s\\n' \"$PWD\"\n")
        .unwrap();
    let output = || terminal(&state, "session").unwrap().text();
    wait_for(|| output().contains(&format!("terminal-cwd:{}", directory.display())));
    state.write("session", "exit\n").unwrap();
    wait_for(|| state.statuses().unwrap()[0].state == "exited");
    assert_eq!(state.statuses().unwrap()[0].exit_code, Some(0));
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn launch_reports_a_missing_agent_executable_apart_from_agent_failures() {
    let root = unique_temp_path("soreno-missing-agent");
    std::fs::create_dir_all(&root).unwrap();
    let state = memory_state();
    let mut saved_project = project();
    saved_project.path = root.to_string_lossy().into();
    state.save_project(saved_project).unwrap();
    let mut agent = session();
    agent.executable = "soreno-agent-that-is-not-installed".into();
    agent.args.clear();
    state.save_session(agent.clone()).unwrap();

    state.start("session", 80, 24, None).unwrap();
    wait_for(|| state.statuses().unwrap()[0].state == "exited");
    assert!(state.statuses().unwrap()[0].missing_executable);

    agent.executable = "/bin/sh".into();
    agent.args = vec!["-c".into(), "exit 7".into()];
    state.save_session(agent).unwrap();
    state.start("session", 80, 24, None).unwrap();
    wait_for(|| state.statuses().unwrap()[0].exit_code == Some(7));
    assert!(!state.statuses().unwrap()[0].missing_executable);
    std::fs::remove_dir_all(root).unwrap();
}
