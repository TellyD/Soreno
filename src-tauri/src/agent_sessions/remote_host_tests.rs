use super::*;
use std::{
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

struct Sandbox {
    home: PathBuf,
    bin: PathBuf,
}
impl Sandbox {
    fn new(name: &str) -> Self {
        // The test socket must fit in sun_path (104 bytes on macOS), beyond reach of its long temp_dir().
        let root = Path::new("/tmp").join(format!("soreno-rh-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let bin = root.join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let dtach = bin.join("dtach");
        std::fs::write(&dtach, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&dtach, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self { home, bin }
    }
    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.root_dir(TERMINALS, session_id)
    }
    fn root_dir(&self, root: &str, session_id: &str) -> PathBuf {
        self.home
            .join(".cache/soreno")
            .join(root)
            .join(key(session_id))
    }
    fn command(&self, script: &str, path: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", script])
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", path);
        command
    }
    fn with_dtach(&self) -> String {
        format!("{}:/usr/bin:/bin", self.bin.display())
    }
    fn run(&self, script: &str, path: &str) -> Output {
        self.command(script, path).output().unwrap()
    }
    fn live(&self, session_id: &str, pid: &str, token: &str) -> UnixListener {
        self.live_in(TERMINALS, session_id, pid, token)
    }
    fn live_in(&self, root: &str, session_id: &str, pid: &str, token: &str) -> UnixListener {
        let directory = self.root_dir(root, session_id);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("pid"), format!("{pid} {token}\n")).unwrap();
        UnixListener::bind(directory.join("socket")).unwrap()
    }
    /// Makes `dtach` a shell, so the processes it starts are named dtach.
    fn shell_as_dtach(&self) -> PathBuf {
        let dtach = self.bin.join("dtach");
        std::fs::remove_file(&dtach).unwrap();
        // Multicall coreutils (uutils) dispatch on the executable name, so `sleep` cannot pose as dtach.
        #[cfg(not(target_os = "macos"))]
        std::os::unix::fs::symlink("/bin/sh", &dtach).unwrap();
        // macOS `/bin/sh` re-executes the selected shell, whose process would not be named dtach.
        #[cfg(target_os = "macos")]
        std::fs::copy("/bin/dash", &dtach).unwrap();
        dtach
    }
    fn spawn_dtach(&self, socket_path: &Path, token: &str) -> Child {
        Command::new(self.shell_as_dtach())
            .args(["-c", "read line"])
            .arg(socket_path)
            .arg(token)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap()
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.home.parent().unwrap());
    }
}

fn probe_output(sandbox: &Sandbox, session_id: &str, path: &str) -> String {
    let output = sandbox.run(&probe_script(TERMINALS, session_id), path);
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn probe_reports_absent_live_and_invalid_pid_without_a_dtach_client() {
    let sandbox = Sandbox::new("probe");
    assert_eq!(probe_output(&sandbox, "s", "/usr/bin:/bin"), "absent");

    let socket_path = sandbox.session_dir("s").join("socket");
    let token = "0123456789abcdef0123456789abcdef";
    let mut child = sandbox.spawn_dtach(&socket_path, token);
    let _socket = sandbox.live("s", &child.id().to_string(), token);
    let fallback_marker = sandbox.home.join("portable-ps-used");
    let prefixed_record = format!(
        "{}0 dtach dtach -c {} {token}",
        child.id(),
        socket_path.display()
    );
    let exact_record = format!(
        "{} dtach dtach -c {} {token}",
        child.id(),
        socket_path.display()
    );
    let ps = format!(
        "#!/bin/sh\nif [ \"$1\" = -ww ]; then : > {}; exit 1; fi\n[ -f {} ] || exit 2\n[ \"$#\" -eq 2 ] && [ \"$1\" = -o ] && [ \"$2\" = 'pid=,comm=,args=' ] || exit 2\nprintf '%s\\n' {} {}\n",
        quote(fallback_marker.to_str().unwrap()),
        quote(fallback_marker.to_str().unwrap()),
        quote(&prefixed_record),
        quote(&exact_record)
    );
    std::fs::write(sandbox.bin.join("ps"), ps).unwrap();
    std::fs::set_permissions(
        sandbox.bin.join("ps"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert_eq!(probe_output(&sandbox, "s", &sandbox.with_dtach()), "live");
    assert!(fallback_marker.exists());

    std::fs::write(sandbox.bin.join("ps"), "#!/bin/sh\nexit 1\n").unwrap();
    assert_eq!(
        probe_output(&sandbox, "s", &sandbox.with_dtach()),
        "inspection_error"
    );
    let stopped = sandbox.run(&stop_script(&["s"]), &sandbox.with_dtach());
    assert!(!stopped.status.success());
    assert!(sandbox.session_dir("s").exists());
    assert!(child.try_wait().unwrap().is_none());

    std::fs::write(sandbox.session_dir("s").join("pid"), "abc\n").unwrap();
    assert_eq!(probe_output(&sandbox, "s", &sandbox.with_dtach()), "absent");
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn stop_only_signals_the_dtach_process_for_this_socket() {
    let sandbox = Sandbox::new("stop");
    let socket_path = sandbox.session_dir("live session").join("socket");
    let token = "0123456789abcdef0123456789abcdef";
    let mut child = sandbox.spawn_dtach(&socket_path, token);
    let _socket = sandbox.live("live session", &child.id().to_string(), token);
    let mut stop = sandbox
        .command(
            &stop_script(&["live session", "never started"]),
            &sandbox.with_dtach(),
        )
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    while child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "session still running");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(stop.wait().unwrap().success());
    assert!(!Path::new(&sandbox.session_dir("live session")).exists());

    let mut foreign = Command::new("sleep").arg("60").spawn().unwrap();
    let _foreign_socket = sandbox.live("stale", &foreign.id().to_string(), token);
    assert_eq!(
        probe_output(&sandbox, "stale", &sandbox.with_dtach()),
        "absent"
    );
    assert!(sandbox
        .run(&stop_script(&["stale"]), &sandbox.with_dtach())
        .status
        .success());
    assert!(foreign.try_wait().unwrap().is_none());
    foreign.kill().unwrap();
    foreign.wait().unwrap();
    // A Chat session lives under its own root.
    let socket_path = sandbox.root_dir(CONVERSATIONS, "chat").join("socket");
    let mut child = sandbox.spawn_dtach(&socket_path, token);
    let _socket = sandbox.live_in(CONVERSATIONS, "chat", &child.id().to_string(), token);
    assert!(sandbox
        .run(&stop_script(&["chat"]), &sandbox.with_dtach())
        .status
        .success());
    assert!(child.wait().is_ok());
    assert!(!sandbox.root_dir(CONVERSATIONS, "chat").exists());
}

#[test]
fn a_chat_reattach_detaches_only_the_other_clients_of_its_socket() {
    let sandbox = Sandbox::new("detach");
    let dtach = sandbox.shell_as_dtach();
    let spawn = |args: &[&str]| Command::new(&dtach).args(args).spawn().unwrap();
    let socket = sandbox.root_dir(CONVERSATIONS, "s").join("socket");
    let other = sandbox.root_dir(CONVERSATIONS, "t").join("socket");
    for path in [&socket, &other] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // `dtach -a <socket>` is a shell running this script; like a client stuck on a dead
        // SSH terminal, it outlives SIGTERM.
        std::fs::write(path, "trap '' TERM; while :; do sleep 0.1; done\n").unwrap();
    }
    let (socket, other) = (socket.to_str().unwrap(), other.to_str().unwrap());
    // `$4` must be the socket, as in `dtach -c <socket> <command>`.
    let first_client = format!("{socket} 2>/dev/null; trap '' TERM; while :; do sleep 0.1; done");
    let mut stranded = spawn(&["-a", socket, "-E", "-z", "-r", "none"]);
    let mut stranded_first = spawn(&["-c", &first_client]);
    let mut elsewhere = spawn(&["-a", other, "-E", "-z", "-r", "none"]);
    let mut master = spawn(&["-c", &first_client]);
    std::fs::write(
        sandbox.root_dir(CONVERSATIONS, "s").join("pid"),
        format!("{} token\n", master.id()),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(200));

    let detached = sandbox.run(
        &format!("d={}\n{DETACH_OTHERS}", session_dir(CONVERSATIONS, "s")),
        &sandbox.with_dtach(),
    );
    assert!(detached.status.success());
    let deadline = Instant::now() + Duration::from_secs(5);
    for client in [&mut stranded, &mut stranded_first] {
        while client.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "stranded client still attached");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    assert!(elsewhere.try_wait().unwrap().is_none());
    assert!(master.try_wait().unwrap().is_none());
    for child in [&mut elsewhere, &mut master] {
        child.kill().unwrap();
        child.wait().unwrap();
    }
}

#[test]
fn redraw_holds_the_size_lock_until_the_current_size_is_restored() {
    let size = Mutex::new(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    });
    let restored = Mutex::new(None);
    let (redraw_entered, redraw_started) = std::sync::mpsc::sync_channel(0);
    let (release_redraw, redraw_released) = std::sync::mpsc::sync_channel(0);

    thread::scope(|scope| {
        let size = &size;
        let restored = &restored;
        scope.spawn(move || {
            redraw_locked(
                size,
                || {
                    redraw_entered.send(()).unwrap();
                    redraw_released.recv().unwrap();
                },
                |current| *restored.lock().unwrap() = Some(current),
            );
        });
        redraw_started.recv().unwrap();
        assert!(size.try_lock().is_err());
        release_redraw.send(()).unwrap();
    });

    assert_eq!(*restored.lock().unwrap(), Some(*size.lock().unwrap()));
}

#[test]
fn create_keeps_the_clipboard_directory_granted_before_launch() {
    let sandbox = Sandbox::new("create");
    let output = sandbox.run(&clipboard_directory_script(TERMINALS, "s"), "/usr/bin:/bin");
    assert!(output.status.success());
    let clipboard = PathBuf::from(String::from_utf8(output.stdout).unwrap());
    std::fs::write(clipboard.join("stale"), "old").unwrap();

    let created = sandbox.run(
        &create_script("dtach", "s", "Soreno", None, None, "true"),
        &sandbox.with_dtach(),
    );
    assert!(created.status.success());
    assert!(clipboard.is_dir());
    assert!(!clipboard.join("stale").exists());
    let mode = std::fs::metadata(&clipboard).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
}

#[test]
fn launches_run_the_shell_with_a_utf8_charset_under_a_posix_locale() {
    for (case, lc_all) in [None, Some("C")].into_iter().enumerate() {
        let sandbox = Sandbox::new(&format!("locale{case}"));
        // Runs the wrapped command as the real dtach does: `dtach -c <socket> -E -z -r winch <command>`.
        std::fs::write(
            sandbox.bin.join("dtach"),
            "#!/bin/sh\nshift 6\nexec \"$@\"\n",
        )
        .unwrap();
        // Skips /etc/profile, which may set LANG and hide a missing fallback.
        let shell = sandbox.bin.join("shell");
        std::fs::write(
            &shell,
            "#!/bin/sh\nexec /bin/bash --noprofile --norc \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = sandbox.command(
            &create_script(
                "dtach",
                "s",
                "Soreno",
                None,
                None,
                "locale charmap > \"$HOME/charmap\"",
            ),
            &sandbox.with_dtach(),
        );
        command.env("SHELL", &shell);
        if let Some(lc_all) = lc_all {
            command.env("LC_ALL", lc_all);
        }
        assert!(command.output().unwrap().status.success());
        let charmap = std::fs::read_to_string(sandbox.home.join("charmap")).unwrap();
        assert_eq!(charmap, "UTF-8\n", "LC_ALL={lc_all:?}");
    }
}

#[test]
fn launches_label_the_session_without_control_characters() {
    let sandbox = Sandbox::new("label");
    let label = sandbox.session_dir("s").join("label");
    let created = sandbox.run(
        &create_script(
            "dtach",
            "s",
            "Soreno · \u{1b}[31mrevue\n",
            None,
            None,
            "true",
        ),
        &sandbox.with_dtach(),
    );
    assert!(created.status.success());
    assert_eq!(
        std::fs::read_to_string(&label).unwrap(),
        "Soreno · [31mrevue\n"
    );

    let attached = sandbox.run(
        &attach_script("dtach", "s", "Renommée", None, false),
        &sandbox.with_dtach(),
    );
    assert!(attached.status.success());
    assert_eq!(std::fs::read_to_string(&label).unwrap(), "Renommée\n");
}

#[test]
fn renaming_replaces_the_label_only_in_an_existing_session_directory() {
    let sandbox = Sandbox::new("rename");
    let missing = sandbox.run(
        &label_script(TERMINALS, "s", "Soreno · revue"),
        "/usr/bin:/bin",
    );
    assert!(missing.status.success());
    assert!(!sandbox.session_dir("s").exists());

    let label = sandbox.session_dir("s").join("label");
    std::fs::create_dir_all(sandbox.session_dir("s")).unwrap();
    std::fs::write(&label, "Ancien\n").unwrap();
    let renamed = sandbox.run(
        &label_script(TERMINALS, "s", "Soreno · \u{1b}[31mrevue\n"),
        "/usr/bin:/bin",
    );
    assert!(renamed.status.success());
    assert_eq!(
        std::fs::read_to_string(&label).unwrap(),
        "Soreno · [31mrevue\n"
    );

    // A Chat session is renamed under its own root.
    let chat = sandbox.root_dir(CONVERSATIONS, "s").join("label");
    std::fs::create_dir_all(chat.parent().unwrap()).unwrap();
    let renamed = sandbox.run(
        &label_script(CONVERSATIONS, "s", "Soreno · chat"),
        "/usr/bin:/bin",
    );
    assert!(renamed.status.success());
    assert_eq!(std::fs::read_to_string(&chat).unwrap(), "Soreno · chat\n");
    assert_eq!(
        std::fs::read_to_string(&label).unwrap(),
        "Soreno · [31mrevue\n"
    );
}

#[test]
fn a_new_chat_session_is_listed_with_its_label_and_no_agent_pointer() {
    let sandbox = Sandbox::new("chat-label");
    let directory = sandbox.root_dir(CONVERSATIONS, "c");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("agent"), "/stale\n").unwrap();
    let created = sandbox.run(
        &conversation_script(
            "dtach",
            RemoteHost::Absent,
            "c",
            "Soreno · Chat",
            None,
            "true",
        ),
        &sandbox.with_dtach(),
    );
    assert!(created.status.success());
    assert_eq!(
        std::fs::read_to_string(directory.join("label")).unwrap(),
        "Soreno · Chat\n"
    );
    assert!(!directory.join("agent").exists());
}

#[test]
fn launches_link_the_session_to_its_agent_directory_only_with_an_integration() {
    let sandbox = Sandbox::new("agent");
    let agent = sandbox.session_dir("s").join("agent");
    let directory = "/home/u/.cache/soreno/agent.AbCd12345678";
    let created = sandbox.run(
        &create_script("dtach", "s", "Soreno", Some(directory), None, "true"),
        &sandbox.with_dtach(),
    );
    assert!(created.status.success());
    assert_eq!(
        std::fs::read_to_string(&agent).unwrap(),
        format!("{directory}\n")
    );

    let relinked = "/home/u/.cache/soreno/agent.EfGh12345678";
    let attached = sandbox.run(
        &attach_script("dtach", "s", "Soreno", Some(relinked), false),
        &sandbox.with_dtach(),
    );
    assert!(attached.status.success());
    assert_eq!(
        std::fs::read_to_string(&agent).unwrap(),
        format!("{relinked}\n")
    );

    let terminal = sandbox.run(
        &attach_script("dtach", "s", "Terminal", None, true),
        &sandbox.with_dtach(),
    );
    assert!(terminal.status.success());
    assert!(!agent.exists());
}

fn prompt_directory(sandbox: &Sandbox) -> PathBuf {
    let output = sandbox.run(
        "umask 077; mktemp -d /tmp/soreno-agent-XXXXXXXXXX",
        "/usr/bin:/bin",
    );
    assert!(output.status.success());
    let directory = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim_end());
    std::fs::write(directory.join("issue.md"), "# Issue").unwrap();
    directory
}

#[test]
fn a_run_removes_its_prompt_directory_when_it_ends_even_unattached() {
    for (case, layout) in [&TERMINAL, &CONVERSATION].into_iter().enumerate() {
        let sandbox = Sandbox::new(&format!("prompt{case}"));
        // `dtach -c <socket> <4 options> <command>` runs the wrapper in place; the client tail
        // never touches the prompt directory, so only the run itself can remove it.
        std::fs::write(
            sandbox.bin.join("dtach"),
            "#!/bin/sh\nshift 6\nexec \"$@\"\n",
        )
        .unwrap();
        let shell = sandbox.bin.join("shell");
        std::fs::write(&shell, "#!/bin/sh\nshift\nexec /bin/sh -c \"$1\"\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let prompt = prompt_directory(&sandbox);
        let path = prompt.to_str().unwrap();
        let inner = format!("test -f {}/issue.md && : > \"$HOME/seen\"", quote(path));
        let mut command = sandbox.command(
            &spawn_script("dtach", layout, "s", "", Some(path), &inner),
            &sandbox.with_dtach(),
        );
        command.env("SHELL", &shell);
        assert!(command.output().unwrap().status.success());
        assert!(
            sandbox.home.join("seen").exists(),
            "run saw no prompt files"
        );
        assert!(!prompt.exists(), "{path} left behind");
    }
}

#[test]
fn stopping_or_relaunching_removes_a_killed_run_prompt_directory_only() {
    let sandbox = Sandbox::new("prompt-stale");
    let record = |path: &Path| {
        std::fs::create_dir_all(sandbox.session_dir("s")).unwrap();
        std::fs::write(
            sandbox.session_dir("s").join("prompt"),
            format!("{}\n", path.display()),
        )
        .unwrap();
    };
    let stopped = prompt_directory(&sandbox);
    record(&stopped);
    assert!(sandbox
        .run(&stop_script(&["s"]), &sandbox.with_dtach())
        .status
        .success());
    assert!(!stopped.exists());

    let killed = prompt_directory(&sandbox);
    record(&killed);
    // The fake dtach exits at once: no run, so nothing records or removes a new directory.
    assert!(sandbox
        .run(
            &create_script("dtach", "s", "Soreno", None, None, "true"),
            &sandbox.with_dtach()
        )
        .status
        .success());
    assert!(!killed.exists());

    // Only a directory named like `remote_clipboard_directory_script`'s is ever removed.
    let foreign = sandbox.home.join("soreno-agent-AbCd123456");
    std::fs::create_dir_all(&foreign).unwrap();
    record(&foreign);
    assert!(sandbox
        .run(&stop_script(&["s"]), &sandbox.with_dtach())
        .status
        .success());
    assert!(foreign.exists());
}

#[test]
fn attach_command_targets_the_session_from_any_local_shell() {
    let mut connection = SshConnection {
        host: "devbox".into(),
        user: None,
        port: None,
        identity_file: Some("/home/me/.ssh/id_ed25519".into()),
        host_key: None,
    };
    assert_eq!(
        attach_command(&connection, "s"),
        format!("ssh -t devbox .cache/soreno/bin/soreno-attach {}", key("s"))
    );
    connection.user = Some("CORP\\dev".into());
    connection.port = Some(2222);
    assert_eq!(
        attach_command(&connection, "s"),
        format!(
            "ssh -t -p 2222 -l \"CORP\\dev\" devbox .cache/soreno/bin/soreno-attach {}",
            key("s")
        )
    );
}

#[test]
fn clipboard_directory_must_belong_to_the_session() {
    let expected = format!("/home/u/.cache/soreno/sessions/{}/clipboard", key("s"));
    assert_eq!(
        clipboard_directory(expected.clone().into_bytes(), TERMINALS, "s").unwrap(),
        expected
    );
    let other = format!("/home/u/.cache/soreno/sessions/{}/clipboard", key("t"));
    assert!(clipboard_directory(other.into_bytes(), TERMINALS, "s").is_err());
    assert!(clipboard_directory(expected[1..].as_bytes().to_vec(), TERMINALS, "s").is_err());
    let control = format!("/home/u\n/.cache/soreno/sessions/{}/clipboard", key("s"));
    assert!(clipboard_directory(control.into_bytes(), TERMINALS, "s").is_err());
}
