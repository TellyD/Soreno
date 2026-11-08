use super::*;
use crate::ssh::RELAY_TEST_LOCK;
use std::{io::BufRead, time::Instant};

const TEST_TIMEOUT: Duration = Duration::from_secs(15);

fn local_relay() -> Arc<Relay> {
    local_relay_with_script(RELAY_SCRIPT)
}

fn local_relay_with_script(script: &str) -> Arc<Relay> {
    let mut command = Command::new("sh");
    command.args(["-c", script]);
    Relay::spawn(command, false).unwrap()
}

fn write_request(stdin: &mut impl Write, id: u64, script: &[u8], limit: usize) {
    write!(stdin, "R {id} {} 0 {limit}\n", script.len()).unwrap();
    stdin.write_all(script).unwrap();
    stdin.flush().unwrap();
}

fn command_exists(command: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {command} >/dev/null 2>&1")])
        .status()
        .is_ok_and(|status| status.success())
}

fn wait_for_file(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(path.exists(), "temporary marker was not created");
}

fn process_is_live(pid: u32) -> bool {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    !state.trim().is_empty() && !state.trim_start().starts_with('Z')
}

/// Runs `script` with its own `TMPDIR`, returning the child, that `TMPDIR` and the relay root.
fn spawn_isolated_relay(
    name: &str,
    script: &str,
) -> (Child, std::path::PathBuf, std::path::PathBuf) {
    let tmp = std::env::temp_dir().join(format!(
        "telaoi-relay-{name}-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let child = Command::new("sh")
        .args(["-c", script])
        .env("TMPDIR", &tmp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let root = loop {
        if let Some(entry) = std::fs::read_dir(&tmp).unwrap().flatten().next() {
            break entry.path();
        }
        assert!(Instant::now() < deadline, "relay root was not created");
        thread::sleep(Duration::from_millis(10));
    };
    (child, tmp, root)
}

fn read_pid(path: &std::path::Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let content = std::fs::read_to_string(path).unwrap_or_default();
        if let Ok(pid) = content.trim().parse() {
            return pid;
        }
        assert!(Instant::now() < deadline, "PID file was not written");
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_until_dead(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_is_live(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
    true
}

#[test]
fn request_validation_accepts_32_mib_input() {
    let input = vec![0; INPUT_LIMIT + 1];
    validate_request("cat", Some(&input[..INPUT_LIMIT]), 16).unwrap();
    assert!(validate_request("cat", Some(&input), 16).is_err());
}

#[test]
fn preserves_binary_input_and_command_errors_without_restarting() {
    let relay = local_relay();
    assert_eq!(
        relay
            .request(b"cat", b"a\0b", 16, TEST_TIMEOUT)
            .unwrap()
            .stdout,
        b"a\0b"
    );
    let error = relay
        .request(b"printf problem >&2; exit 23", b"", 16, TEST_TIMEOUT)
        .unwrap();
    assert_eq!(error.status, 23);
    assert_eq!(error.stderr, b"problem");
    assert_eq!(
        relay
            .request(b"printf reused", b"", 16, TEST_TIMEOUT)
            .unwrap()
            .stdout,
        b"reused"
    );
    assert!(relay.is_alive());
    relay.fail("test terminé".into());
}

#[test]
fn stalled_writer_obeys_its_timeout_without_blocking_termination() {
    let mut command = Command::new("sh");
    command.args(["-c", "sleep 10"]);
    let relay = Relay::spawn(command, false).unwrap();
    let input = vec![0; 1024 * 1024];
    let started = Instant::now();
    assert!(relay
        .request(b":", &input, 16, Duration::from_millis(100))
        .unwrap_err()
        .contains("Délai"));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!relay.is_alive());
}

#[test]
fn cancellation_waits_for_an_engaged_frame_and_detached_descendant() {
    let mut child = Command::new("sh")
        .args(["-c", RELAY_SCRIPT])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (pid_sender, pid_receiver) = mpsc::channel();
    let (result_sender, result_receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = (|| -> Result<()> {
            let mut stdout = BufReader::new(stdout);
            let first = read_header(&mut stdout)?;
            let (id, _, stdout_len, stderr_len, _) = parse_header(&first)?;
            if id != 1 || stdout_len <= 1024 * 1024 || stderr_len != 0 {
                return Err("Première trame inattendue.".into());
            }
            let mut pid_line = Vec::new();
            stdout
                .read_until(b'\n', &mut pid_line)
                .map_err(|error| error.to_string())?;
            let pid = std::str::from_utf8(&pid_line)
                .map_err(|error| error.to_string())?
                .trim()
                .parse::<u32>()
                .map_err(|error| error.to_string())?;
            let _ = pid_sender.send(pid);
            let mut body = vec![1; stdout_len - pid_line.len()];
            stdout
                .read_exact(&mut body)
                .map_err(|error| error.to_string())?;
            if body.iter().any(|byte| *byte != 0) {
                return Err("Corps de réponse interrompu.".into());
            }
            if read_header(&mut stdout)? != b"X 1" || process_is_live(pid) {
                return Err("Annulation confirmée avant extinction du descendant.".into());
            }
            let second = read_header(&mut stdout)?;
            let (id, _, stdout_len, stderr_len, _) = parse_header(&second)?;
            if id != 2 || stderr_len != 0 {
                return Err("Seconde trame inattendue.".into());
            }
            let mut body = vec![0; stdout_len];
            stdout
                .read_exact(&mut body)
                .map_err(|error| error.to_string())?;
            if body != b"intact" {
                return Err("Seconde réponse corrompue.".into());
            }
            Ok(())
        })();
        let _ = result_sender.send(result);
    });
    let launcher = if command_exists("setsid") {
        "setsid sh -c 'trap \"\" HUP TERM; sleep 30'"
    } else {
        "sh -c 'trap \"\" HUP TERM; sleep 30'"
    };
    let script = format!(
        "{launcher} >/dev/null 2>&1 & printf '%s\\n' $!; dd if=/dev/zero bs=1024 count=1024 2>/dev/null"
    );
    write_request(&mut stdin, 1, script.as_bytes(), 2 * 1024 * 1024);
    let pid = pid_receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(process_is_live(pid));
    writeln!(stdin, "C 1").unwrap();
    stdin.flush().unwrap();
    write_request(&mut stdin, 2, b"printf intact", 16);
    let result = result_receiver.recv_timeout(Duration::from_secs(8));
    drop(stdin);
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result.unwrap().unwrap();
}

#[test]
fn inventory_failure_never_confirms_cancellation() {
    if !command_exists("setsid") {
        return;
    }
    let broken_inventory = RELAY_SCRIPT.replacen(
        "  ps axeww -o pid= -o stat= -o command= > \"$snapshot\" 2>/dev/null || return 1",
        "  false > \"$snapshot\" || return 1",
        1,
    );
    assert_ne!(broken_inventory, RELAY_SCRIPT);
    let mut child = Command::new("sh")
        .args(["-c", &broken_inventory])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    write_request(
        &mut stdin,
        1,
        b"setsid sleep 30 >/dev/null 2>&1 & printf '%s' $!",
        32,
    );
    let header = read_header(&mut stdout).unwrap();
    let (id, status, stdout_len, stderr_len, _) = parse_header(&header).unwrap();
    assert_eq!((id, status, stderr_len), (1, 0, 0));
    let mut body = vec![0; stdout_len];
    stdout.read_exact(&mut body).unwrap();
    let descendant = std::str::from_utf8(&body).unwrap().parse::<u32>().unwrap();
    assert!(process_is_live(descendant));
    thread::sleep(Duration::from_millis(50));

    writeln!(stdin, "C 1").unwrap();
    stdin.flush().unwrap();
    let error = read_header(&mut stdout).unwrap_err();
    let exit = child.wait().unwrap();
    assert!(error.contains("interrompue"), "{error}");
    assert_eq!(exit.code(), Some(74));
    assert!(process_is_live(descendant));
    let _ = Command::new("kill")
        .args(["-KILL", &descendant.to_string()])
        .status();
}

#[test]
fn cancelling_request_one_never_matches_request_ten() {
    let fallback = RELAY_SCRIPT.replace(
        "if command -v setsid >/dev/null 2>&1; then has_setsid=1; else has_setsid=0; fi",
        "has_setsid=0",
    );
    let scripts = if command_exists("setsid") {
        vec![RELAY_SCRIPT, fallback.as_str()]
    } else {
        vec![fallback.as_str()]
    };
    for (variant, relay_script) in scripts.into_iter().enumerate() {
        let base = std::env::temp_dir().join(format!(
            "soreno-relay-token-{}-{variant}",
            std::process::id()
        ));
        let one = base.with_extension("one");
        let ten = base.with_extension("ten");
        let mut child = Command::new("sh")
            .args(["-c", relay_script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let first = format!(
            "printf ready > {}; sleep 30",
            super::super::quote(one.to_str().unwrap())
        );
        let tenth = format!(
            "printf ready > {}; sleep 0.3; printf ten",
            super::super::quote(ten.to_str().unwrap())
        );
        write_request(&mut stdin, 1, first.as_bytes(), 16);
        write_request(&mut stdin, 10, tenth.as_bytes(), 16);
        wait_for_file(&one);
        wait_for_file(&ten);
        writeln!(stdin, "C 1").unwrap();
        stdin.flush().unwrap();

        let mut cancelled = false;
        let mut tenth_completed = false;
        while !cancelled || !tenth_completed {
            let header = read_header(&mut stdout).unwrap();
            if header == b"X 1" {
                cancelled = true;
                continue;
            }
            let (id, status, stdout_len, stderr_len, _) = parse_header(&header).unwrap();
            let mut body = vec![0; stdout_len + stderr_len];
            stdout.read_exact(&mut body).unwrap();
            if id == 10 {
                assert_eq!(status, 0);
                assert_eq!(&body[..stdout_len], b"ten");
                tenth_completed = true;
            }
        }
        drop(stdin);
        let _ = child.wait();
        let _ = std::fs::remove_file(one);
        let _ = std::fs::remove_file(ten);
    }
}

#[test]
fn zombie_only_process_group_does_not_block_cancellation() {
    if !command_exists("setsid") {
        return;
    }
    let marker = std::env::temp_dir().join(format!(
        "soreno-relay-zombie-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    let mut child = Command::new("sh")
        .args(["-c", RELAY_SCRIPT])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    // A foreground command would let the shell reap the zombie before it is observed.
    let script = format!(
        "(exit 0) & printf '%s\\n' \"$!\" > {}; kill -STOP $$; exit 75",
        super::super::quote(marker.to_str().unwrap())
    );
    write_request(&mut stdin, 1, script.as_bytes(), 16);
    let deadline = Instant::now() + Duration::from_secs(5);
    let zombie = loop {
        let content = std::fs::read_to_string(&marker).unwrap_or_default();
        if let Ok(pid) = content.trim().parse::<u32>() {
            break pid;
        }
        assert!(Instant::now() < deadline, "zombie PID was not written");
        thread::sleep(Duration::from_millis(10));
    };
    while process_is_live(zombie) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!process_is_live(zombie));
    writeln!(stdin, "C 1").unwrap();
    stdin.flush().unwrap();
    assert_eq!(read_header(&mut stdout).unwrap(), b"X 1");
    write_request(&mut stdin, 2, b"printf alive", 16);
    let header = read_header(&mut stdout).unwrap();
    let (id, status, stdout_len, stderr_len, _) = parse_header(&header).unwrap();
    assert_eq!((id, status, stderr_len), (2, 0, 0));
    let mut body = vec![0; stdout_len];
    stdout.read_exact(&mut body).unwrap();
    assert_eq!(body, b"alive");
    drop(stdin);
    let _ = child.wait();
    let _ = std::fs::remove_file(marker);
}

#[test]
fn runs_two_requests_concurrently() {
    let relay = local_relay();
    let fifo = std::env::temp_dir().join(format!(
        "soreno-relay-concurrent-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    let _ = std::fs::remove_file(&fifo);
    assert!(Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let quoted = super::super::quote(fifo.to_str().unwrap());
    // Each side blocks opening the FIFO until the other opens it: run in turn, neither ends.
    let first = {
        let relay = Arc::clone(&relay);
        let script = format!("read line < {quoted}; printf \"$line\"");
        thread::spawn(move || {
            relay
                .request(script.as_bytes(), b"", 16, TEST_TIMEOUT)
                .unwrap()
                .stdout
        })
    };
    let second = {
        let relay = Arc::clone(&relay);
        let script = format!("printf 'one\\n' > {quoted}; printf two");
        thread::spawn(move || {
            relay
                .request(script.as_bytes(), b"", 16, TEST_TIMEOUT)
                .unwrap()
                .stdout
        })
    };
    assert_eq!(first.join().unwrap(), b"one");
    assert_eq!(second.join().unwrap(), b"two");
    relay.fail("test terminé".into());
    let _ = std::fs::remove_file(fifo);
}

#[test]
fn concurrent_responses_stay_framed_when_mkdir_accepts_an_existing_directory() {
    // uutils mkdir (Ubuntu 26.04) can exit 0 when a concurrent mkdir created the directory.
    let real = Command::new("sh")
        .args(["-c", "command -v mkdir"])
        .output()
        .unwrap()
        .stdout;
    let shim = std::env::temp_dir().join(format!(
        "soreno-relay-mkdir-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    std::fs::create_dir_all(&shim).unwrap();
    std::fs::write(
        shim.join("mkdir"),
        format!(
            "#!/bin/sh\nexec {} -p \"$@\"\n",
            String::from_utf8(real).unwrap().trim()
        ),
    )
    .unwrap();
    assert!(Command::new("chmod")
        .arg("+x")
        .arg(shim.join("mkdir"))
        .status()
        .unwrap()
        .success());
    let mut command = Command::new("sh");
    command.args(["-c", RELAY_SCRIPT]).env(
        "PATH",
        format!("{}:{}", shim.display(), std::env::var("PATH").unwrap()),
    );
    let relay = Relay::spawn(command, false).unwrap();
    // Far larger than a pipe buffer: overlapping writers would interleave their frames.
    const SIZE: usize = 4 * 1024 * 1024;
    let requests = (b'a'..b'i')
        .map(|byte| {
            let relay = Arc::clone(&relay);
            thread::spawn(move || {
                let script = format!(
                    "sleep 0.5; head -c {SIZE} /dev/zero | tr '\\0' {}",
                    byte as char
                );
                let output = relay.request(script.as_bytes(), b"", OUTPUT_LIMIT, TEST_TIMEOUT);
                (byte, output)
            })
        })
        .collect::<Vec<_>>();
    for request in requests {
        let (byte, output) = request.join().unwrap();
        let stdout = output.unwrap().stdout;
        assert!(
            stdout == vec![byte; SIZE],
            "response {} lost its framing",
            byte as char
        );
    }
    relay.fail("test terminé".into());
    let _ = std::fs::remove_dir_all(shim);
}

#[test]
fn parses_normalized_frames_and_rejects_bsd_wc_padding() {
    assert_eq!(
        parse_header(b"S 12 0 34 56 0").unwrap(),
        (12, 0, 34, 56, false)
    );
    assert!(parse_header(b"S 12 0     34     56 0").is_err());
    assert_eq!(parse_cancel_header(b"X 12").unwrap(), 12);
}

#[test]
fn oversized_output_is_explicit_and_keeps_the_relay_reusable() {
    let relay = local_relay();
    assert!(relay
        .request(b"yes x", b"", 20, TEST_TIMEOUT)
        .unwrap_err()
        .contains("volumineuse"));
    assert_eq!(
        relay
            .request(b"printf reused", b"", 16, TEST_TIMEOUT)
            .unwrap()
            .stdout,
        b"reused"
    );
    assert!(relay.is_alive());
    relay.fail("test terminé".into());
}

#[test]
fn one_timeout_cancels_its_descendants_without_stopping_another_request() {
    let script = RELAY_SCRIPT.replace(
        "if command -v setsid >/dev/null 2>&1; then has_setsid=1; else has_setsid=0; fi",
        "has_setsid=0",
    );
    let relay = local_relay_with_script(&script);
    let marker = std::env::temp_dir().join(format!(
        "soreno-relay-timeout-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    // Without setsid, cancellation walks the tree with one `ps` per level; it needs slack under load.
    let short_script = format!(
        "sh -c \"(sleep 3; printf late > {}) >/dev/null 2>&1 &\"; sleep 10",
        super::super::quote(marker.to_str().unwrap())
    );
    let long = {
        let relay = Arc::clone(&relay);
        thread::spawn(move || {
            relay
                .request(b"sleep 0.5; printf long", b"", 16, TEST_TIMEOUT)
                .unwrap()
                .stdout
        })
    };
    let started = Instant::now();
    assert!(relay
        .request(short_script.as_bytes(), b"", 16, Duration::from_millis(100))
        .unwrap_err()
        .contains("Délai"));
    assert!(started.elapsed() < Duration::from_millis(300));
    assert_eq!(long.join().unwrap(), b"long");
    thread::sleep(Duration::from_millis(3300).saturating_sub(started.elapsed()));
    assert!(!marker.exists());
    assert!(started.elapsed() < Duration::from_secs(8));
    assert!(relay.is_alive());
    relay.fail("test terminé".into());
}

#[test]
fn forced_cancellation_removes_the_per_request_tmpdir() {
    let relay = local_relay();
    let marker = std::env::temp_dir().join(format!(
        "soreno-relay-tmpdir-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    let script = format!(
        "printf '%s' \"$TMPDIR\" > {}; : > \"$TMPDIR/soreno-hash.test\"; sleep 10",
        super::super::quote(marker.to_str().unwrap())
    );
    assert!(relay
        .request(script.as_bytes(), b"", 16, Duration::from_millis(100))
        .unwrap_err()
        .contains("Délai"));
    let deadline = Instant::now() + Duration::from_secs(4);
    while !marker.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let tmp = std::path::PathBuf::from(std::fs::read_to_string(&marker).unwrap());
    assert!(tmp
        .parent()
        .and_then(|path| path.file_name())
        .unwrap()
        .to_string_lossy()
        .starts_with("soreno-ssh-relay."));
    while tmp.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!tmp.exists());
    let _ = std::fs::remove_file(marker);
    relay.fail("test terminé".into());
}

#[test]
fn closing_the_relay_cancels_remote_descendants_before_exit() {
    let relay = local_relay();
    let marker = std::env::temp_dir().join(format!(
        "soreno-relay-close-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    let script = format!(
        "(sleep 0.5; printf late > {}) & wait",
        super::super::quote(marker.to_str().unwrap())
    );
    let request = {
        let relay = Arc::clone(&relay);
        thread::spawn(move || relay.request(script.as_bytes(), b"", 16, TEST_TIMEOUT))
    };
    thread::sleep(Duration::from_millis(100));
    relay.close_input();
    assert!(request.join().unwrap().is_err());
    thread::sleep(Duration::from_millis(600));
    assert!(!marker.exists());
}

#[test]
fn only_idempotent_requests_reconnect_once_after_an_established_relay_drops() {
    for (case, (idempotent, established, reconnects)) in [
        (true, true, true),
        (false, true, false),
        (true, false, false),
    ]
    .into_iter()
    .enumerate()
    {
        let marker =
            std::env::temp_dir().join(format!("soreno-relay-replay-{}-{case}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let script = format!(
            "if [ -e {marker} ]; then printf done; else : > {marker}; sleep 10; fi",
            marker = super::super::quote(marker.to_str().unwrap())
        );
        let dropped = local_relay();
        if established {
            dropped
                .request(b"printf ready", b"", 16, TEST_TIMEOUT)
                .unwrap();
        }
        let mut relays = vec![local_relay(), Arc::clone(&dropped)];
        let request = thread::spawn(move || {
            let mut calls = 0;
            let result = request_with_reconnect(
                || {
                    calls += 1;
                    Ok(relays.pop().unwrap())
                },
                script.as_bytes(),
                b"",
                16,
                TEST_TIMEOUT,
                idempotent,
            );
            (result, calls)
        });
        let deadline = Instant::now() + TEST_TIMEOUT;
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(marker.exists(), "first request never started");
        dropped.close_input();
        let (result, calls) = request.join().unwrap();
        let _ = std::fs::remove_file(&marker);
        assert_eq!(
            (result.map(|output| output.stdout).ok(), calls),
            if reconnects {
                (Some(b"done".to_vec()), 2)
            } else {
                (None, 1)
            },
            "idempotent={idempotent} established={established}"
        );
    }
}

#[test]
fn shutdown_prevents_runs_and_relay_creation_until_test_reset() {
    let _registry_guard = RELAY_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    reset_test_relays();
    super::super::reset_test_commands();
    let connection = SshConnection {
        host: "127.0.0.1".into(),
        user: None,
        port: Some(1),
        identity_file: None,
        host_key: None,
    };

    shutdown();
    assert!(run(&connection, ":", None, 16, TEST_TIMEOUT, false)
        .unwrap_err()
        .contains("arrêté"));
    assert_eq!(super::super::test_commands(), 0);
    assert!(registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_empty());
    reset_test_relays();
}

#[test]
fn block_waits_for_an_acquired_run_and_prevents_relay_recreation_after_close() {
    let _registry_guard = RELAY_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    reset_test_relays();
    let connection = SshConnection {
        host: "blocked.test".into(),
        user: None,
        port: None,
        identity_file: None,
        host_key: None,
    };
    let active_relay = local_relay();
    insert_relay(
        &mut registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        connection.clone(),
        Arc::clone(&active_relay),
    );
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    *TEST_RUN_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(TestRunGate {
        connection: connection.clone(),
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
    });
    let running = {
        let connection = connection.clone();
        thread::spawn(move || run(&connection, "printf active", None, 16, TEST_TIMEOUT, false))
    };
    entered.wait();
    let (blocked_sender, blocked_receiver) = mpsc::channel();
    let blocking = {
        let connection = connection.clone();
        thread::spawn(move || {
            block(&connection);
            blocked_sender.send(()).unwrap();
        })
    };
    while !is_blocked(&connection) {
        thread::yield_now();
    }
    assert!(blocked_receiver
        .recv_timeout(Duration::from_millis(50))
        .is_err());

    release.wait();
    assert_eq!(running.join().unwrap().unwrap().stdout, b"active");
    blocked_receiver.recv_timeout(TEST_TIMEOUT).unwrap();
    blocking.join().unwrap();
    close(&connection);

    assert!(run(&connection, ":", None, 16, TEST_TIMEOUT, false)
        .unwrap_err()
        .contains("bloquée"));
    assert!(registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .all(|entry| entry.connection != connection));
    reset_test_relays();
}

#[test]
fn targeted_close_interrupts_only_the_matching_registered_relay() {
    let _registry_guard = RELAY_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    reset_test_relays();
    let target = local_relay();
    let other = local_relay();
    let connection = |host: &str| SshConnection {
        host: host.into(),
        user: None,
        port: None,
        identity_file: None,
        host_key: None,
    };
    {
        let mut entries = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        insert_relay(&mut entries, connection("target.test"), Arc::clone(&target));
        insert_relay(&mut entries, connection("other.test"), Arc::clone(&other));
    }
    let request = {
        let relay = Arc::clone(&target);
        thread::spawn(move || relay.request(b"sleep 10", b"", 16, TEST_TIMEOUT))
    };
    thread::sleep(Duration::from_millis(50));

    close(&connection("target.test"));

    assert!(request.join().unwrap().is_err());
    assert!(!target.is_alive());
    assert!(other.is_alive());
    let entries = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].connection, connection("other.test"));
    drop(entries);

    let replacement = local_relay();
    insert_relay(
        &mut registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        connection("target.test"),
        Arc::clone(&replacement),
    );
    assert_eq!(
        replacement
            .request(b"printf reconnected", b"", 16, TEST_TIMEOUT)
            .unwrap()
            .stdout,
        b"reconnected"
    );
    reset_test_relays();
}

#[test]
fn active_lru_eviction_does_not_stop_the_request_but_shutdown_stops_cached_relays() {
    let _registry_guard = RELAY_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    reset_test_relays();
    let first = local_relay();
    let filler = local_relay();
    let connection = |index| SshConnection {
        host: format!("host-{index}.test"),
        user: None,
        port: None,
        identity_file: None,
        host_key: None,
    };
    {
        let mut entries = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        insert_relay(&mut entries, connection(0), Arc::clone(&first));
        for index in 1..RELAY_LIMIT {
            insert_relay(&mut entries, connection(index), Arc::clone(&filler));
        }
    }
    let active = {
        let relay = Arc::clone(&first);
        thread::spawn(move || {
            relay
                .request(b"sleep 0.2; printf kept", b"", 16, TEST_TIMEOUT)
                .unwrap()
                .stdout
        })
    };
    thread::sleep(Duration::from_millis(50));
    let evicted = {
        let mut entries = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        insert_relay(&mut entries, connection(RELAY_LIMIT), Arc::clone(&filler))
    };
    drop(evicted);
    assert_eq!(active.join().unwrap(), b"kept");
    assert!(first.is_alive());
    shutdown();
    assert!(!filler.is_alive());
    first.fail("test terminé".into());
    reset_test_relays();
}

#[test]
fn closed_connection_during_a_response_still_lets_the_relay_exit() {
    let (mut child, tmp, root) = spawn_isolated_relay("broken-pipe", RELAY_SCRIPT);
    let mut stdin = child.stdin.take().unwrap();
    drop(child.stdout.take());
    let release = tmp.join("release");
    let script = format!(
        "while [ ! -e {} ]; do sleep 0.01; done; printf lost",
        super::super::quote(release.to_str().unwrap())
    );
    write_request(&mut stdin, 1, script.as_bytes(), 16);
    let writer = read_pid(&root.join("1.pid"));
    std::fs::write(&release, b"").unwrap();
    assert!(wait_until_dead(writer));
    writeln!(stdin, "C 1").unwrap();
    stdin.flush().unwrap();
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(5);
    let exited = loop {
        if child.try_wait().unwrap().is_some() {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        thread::sleep(Duration::from_millis(10));
    };
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
    }
    let root_left = root.exists();
    let _ = std::fs::remove_dir_all(tmp);
    assert!(
        exited,
        "the relay kept waiting on the lock of its dead writer"
    );
    assert!(!root_left);
}

#[test]
fn cancellation_reclaims_the_lock_of_a_killed_writer() {
    let (mut child, tmp, root) = spawn_isolated_relay("dead-owner", RELAY_SCRIPT);
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut gone = Command::new("true").spawn().unwrap();
    let gone_pid = gone.id();
    gone.wait().unwrap();
    std::fs::write(root.join("lock"), format!("7 {gone_pid}\n")).unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(read_header(&mut BufReader::new(stdout)));
    });
    writeln!(stdin, "C 1").unwrap();
    stdin.flush().unwrap();
    let header = receiver.recv_timeout(Duration::from_secs(5));
    drop(stdin);
    if header.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(tmp);
    assert_eq!(header.unwrap().unwrap(), b"X 1");
}

#[test]
fn writer_waiting_on_the_lock_exits_once_the_relay_is_gone() {
    // A private marker keeps concurrent tests' reapers away from the orphaned writer.
    let script = RELAY_SCRIPT.replace("ssh-relay.", "ssh-orphan-writer.");
    assert_ne!(script, RELAY_SCRIPT);
    let (mut child, tmp, root) = spawn_isolated_relay("orphan", &script);
    let mut stdin = child.stdin.take().unwrap();
    let _stdout = child.stdout.take().unwrap();
    std::fs::write(root.join("lock"), format!("7 {}\n", std::process::id())).unwrap();
    write_request(&mut stdin, 1, b"printf waiting", 16);
    let writer = read_pid(&root.join("1.pid"));
    // The script is removed once the command finished, just before the writer takes the lock.
    let deadline = Instant::now() + Duration::from_secs(5);
    while root.join("1.script").exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    child.kill().unwrap();
    child.wait().unwrap();
    let exited = wait_until_dead(writer);
    if !exited {
        let _ = Command::new("kill")
            .args(["-KILL", &writer.to_string()])
            .status();
    }
    let _ = std::fs::remove_dir_all(tmp);
    assert!(exited, "the orphaned writer kept waiting on the lock");
}

#[test]
fn a_new_relay_reaps_relays_left_by_a_dead_connection() {
    // A private marker lets only this test's relays reap the fixtures, current and pre-rename.
    let script = RELAY_SCRIPT.replace("ssh-relay.", "ssh-reap-test.");
    assert_ne!(script, RELAY_SCRIPT);
    let orphans = ["soreno", "telaoi"].map(|prefix| {
        let spawned = Command::new("sh")
            .args([
                "-c",
                &format!(
                    "sh -c ': /tmp/{prefix}-ssh-reap-test.XXXXXXXX; while :; do sleep 0.1; done; :' \
                     >/dev/null 2>&1 & printf '%s' $!"
                ),
            ])
            .output()
            .unwrap();
        String::from_utf8(spawned.stdout).unwrap().parse::<u32>().unwrap()
    });
    let kill_orphans = || {
        for orphan in orphans {
            let _ = Command::new("kill")
                .args(["-KILL", &orphan.to_string()])
                .status();
        }
    };
    let adopter = Command::new("ps")
        .args(["-o", "ppid=", "-p", &orphans[0].to_string()])
        .output()
        .unwrap();
    let adopter = String::from_utf8_lossy(&adopter.stdout).trim().to_owned();
    let adopter_name = Command::new("ps")
        .args(["-o", "comm=", "-p", &adopter])
        .output()
        .unwrap();
    let adopter_name = String::from_utf8_lossy(&adopter_name.stdout);
    let adopter_name = adopter_name.trim().rsplit('/').next().unwrap_or_default();
    if adopter != "1" && adopter_name != "systemd" {
        // Another subreaper adopts orphans here: the relay rightly leaves them alone.
        kill_orphans();
        return;
    }
    let connected = local_relay_with_script(&script);
    let relay = local_relay_with_script(&script);
    let reaped = orphans.map(wait_until_dead);
    kill_orphans();
    assert_eq!(
        reaped,
        [true, true],
        "an orphaned relay survived a new connection"
    );
    for relay in [&connected, &relay] {
        assert_eq!(
            relay
                .request(b"printf alive", b"", 16, TEST_TIMEOUT)
                .unwrap()
                .stdout,
            b"alive"
        );
        relay.fail("test terminé".into());
    }
}

#[test]
fn a_new_relay_cleans_up_after_killed_relays_only() {
    let tmp = std::env::temp_dir().join(format!(
        "soreno-relay-stale-roots-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let mut gone = Command::new("true").spawn().unwrap();
    let gone_pid = gone.id();
    gone.wait().unwrap();
    let root = |name: &str, owner: Option<u32>| {
        let root = tmp.join(name);
        std::fs::create_dir(&root).unwrap();
        if let Some(owner) = owner {
            std::fs::write(root.join("owner"), format!("{owner}\n")).unwrap();
        }
        root
    };
    let killed = root("soreno-ssh-relay.killed", Some(gone_pid));
    // Requests below belong to a relay started before the Soreno rename.
    let killed_legacy = root("telaoi-ssh-relay.killed", Some(gone_pid));
    let live = root("soreno-ssh-relay.live", Some(std::process::id()));
    let legacy = root("telaoi-ssh-relay.legacy", None);
    let marked = |id: u32| {
        Command::new("sleep")
            .arg("30")
            .env(
                "SORENO_RELAY_REQUEST",
                format!("telaoi-ssh-relay.killed.{id}."),
            )
            .spawn()
            .unwrap()
    };
    let stop = |pid: u32| {
        assert!(Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .unwrap()
            .success());
    };
    // Request 7 was frozen mid-cancellation; request 8 finished and left a daemon behind.
    let mut frozen = marked(7);
    let mut daemon = marked(8);
    stop(frozen.id());
    // Request 7's supervisor is an unmarked relay subshell, frozen along with its child.
    let mut supervisor = Command::new("sh")
        .args(["-c", ": /telaoi-ssh-relay.XXXXXXXX; sleep 30 & wait"])
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let supervised = loop {
        let output = Command::new("ps")
            .args(["-A", "-o", "pid=", "-o", "ppid="])
            .output()
            .unwrap();
        let child = String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next()?.parse::<u32>().ok()?;
                (fields.next()?.parse::<u32>().ok()? == supervisor.id()).then_some(pid)
            });
        if let Some(child) = child {
            break child;
        }
        assert!(
            Instant::now() < deadline,
            "the supervisor never started its child"
        );
        thread::sleep(Duration::from_millis(10));
    };
    stop(supervised);
    stop(supervisor.id());
    std::fs::write(
        killed_legacy.join("7.pid"),
        format!("{}\n", supervisor.id()),
    )
    .unwrap();
    // Request 7 still runs a process that keeps forking marked children.
    let mut forking = Command::new("sh")
        .args(["-c", "while :; do sleep 0.05; done"])
        .env("SORENO_RELAY_REQUEST", "telaoi-ssh-relay.killed.7.")
        .spawn()
        .unwrap();
    let mut child = Command::new("sh")
        .args(["-c", RELAY_SCRIPT])
        .env("TMPDIR", &tmp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while (killed.exists() || killed_legacy.exists()) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let killed_left = killed.exists() || killed_legacy.exists();
    let output = Command::new("ps")
        .args(["axeww", "-o", "stat=", "-o", "command="])
        .env_remove("COLUMNS")
        .output()
        .unwrap();
    let forked_left = String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        !line.trim_start().starts_with('Z')
            && format!("{line} ").contains(" SORENO_RELAY_REQUEST=telaoi-ssh-relay.killed.7. ")
    });
    let kept = live.exists() && legacy.exists();
    let frozen_reaped = wait_until_dead(frozen.id());
    let supervisor_reaped = wait_until_dead(supervisor.id()) && wait_until_dead(supervised);
    let daemon_kept = process_is_live(daemon.id());
    if process_is_live(supervised) {
        let _ = Command::new("kill")
            .args(["-KILL", &supervised.to_string()])
            .status();
    }
    for process in [&mut frozen, &mut daemon, &mut supervisor, &mut forking] {
        let _ = process.kill();
        let _ = process.wait();
    }
    drop(child.stdin.take());
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(tmp);
    assert!(
        !killed_left,
        "the root of a killed relay survived a new relay"
    );
    assert!(
        !forked_left,
        "a child forked by a killed relay's request outlived its root"
    );
    assert!(kept, "a new relay removed a root it cannot prove stale");
    assert!(
        frozen_reaped,
        "a killed relay's in-flight request stayed frozen"
    );
    assert!(
        supervisor_reaped,
        "a killed relay's frozen supervisor outlived its root"
    );
    assert!(
        daemon_kept,
        "a new relay killed what a finished request left running"
    );
}
