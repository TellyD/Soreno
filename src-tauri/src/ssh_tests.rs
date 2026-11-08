use super::*;

fn connection() -> SshConnection {
    SshConnection {
        host: "example.com".into(),
        user: None,
        port: None,
        identity_file: None,
        host_key: None,
    }
}

fn host_key() -> String {
    host_key_with(1)
}

fn host_key_with(byte: u8) -> String {
    let mut blob = Vec::new();
    blob.extend(11u32.to_be_bytes());
    blob.extend(b"ssh-ed25519");
    blob.extend(32u32.to_be_bytes());
    blob.extend([byte; 32]);
    format!("ssh-ed25519 {}", STANDARD.encode(blob))
}

pub(super) fn initialize_test_trust() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let path = std::env::temp_dir().join(format!("soreno-ssh-test-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        initialize(&path).unwrap();
    });
}

#[test]
fn reject_option_injection_and_keep_config_defaults() {
    for host in [
        "-oProxyCommand=evil",
        "user@host",
        "host\nlocalcommand evil",
        "host;touch /tmp/no",
        "",
    ] {
        assert!(validate(&SshConnection {
            host: host.into(),
            ..connection()
        })
        .is_err());
    }
    assert!(validate(&SshConnection {
        host: "2001:db8::1".into(),
        ..connection()
    })
    .is_ok());
    let args = arguments(&connection()).unwrap();
    assert!(!args.iter().any(|v| v == "-p" || v == "-l"));
    assert!(args.contains(&"StrictHostKeyChecking=yes".into()));
    assert!(args.contains(&"ForwardAgent=no".into()));
    assert!(args.contains(&"ForkAfterAuthentication=no".into()));
    for pinned_only in [
        "KnownHostsCommand=none",
        "VerifyHostKeyDNS=no",
        "CheckHostIP=no",
    ] {
        assert!(!args.contains(&pinned_only.into()));
    }
    assert!(validate(&SshConnection {
        port: Some(0),
        ..connection()
    })
    .is_err());
}

#[test]
fn openssh_config_keeps_user_and_port_but_drops_host_key_pinning() {
    let config = openssh_config(&SshConnection {
        user: Some("alice".into()),
        port: Some(2222),
        host_key: Some(host_key()),
        ..connection()
    })
    .unwrap();
    assert!(config.lines().any(|line| line == "user alice"));
    assert!(config.lines().any(|line| line == "port 2222"));
    assert!(!config.contains("hostkeyalias soreno-pinned"));
}

#[test]
fn pinned_host_disables_alternate_trust_sources() {
    initialize_test_trust();
    let args = arguments(&SshConnection {
        host_key: Some(host_key()),
        ..connection()
    })
    .unwrap();
    for option in [
        "ForkAfterAuthentication=no",
        "KnownHostsCommand=none",
        "VerifyHostKeyDNS=no",
        "CheckHostIP=no",
    ] {
        assert!(args.contains(&option.into()));
    }
}

#[test]
fn pinned_host_files_keep_their_alias_and_reject_tampering() {
    initialize_test_trust();
    let alias = |key: &str| {
        let args = arguments(&SshConnection {
            host_key: Some(key.into()),
            ..connection()
        })?;
        Ok::<_, String>(
            args.into_iter()
                .find(|arg| arg.starts_with("HostKeyAlias=")),
        )
    };
    let file = |key: &str| {
        KNOWN_HOSTS_DIR
            .get()
            .unwrap()
            .join(format!("{:x}", Sha256::digest(key.as_bytes())))
    };
    let fresh = host_key_with(2);
    let _ = std::fs::remove_file(file(&fresh));
    assert_eq!(
        alias(&fresh).unwrap().as_deref(),
        Some("HostKeyAlias=soreno-pinned")
    );
    assert_eq!(
        alias(&fresh).unwrap().as_deref(),
        Some("HostKeyAlias=soreno-pinned")
    );

    let legacy = host_key_with(3);
    std::fs::write(file(&legacy), format!("telaoi-pinned {legacy}\n")).unwrap();
    assert_eq!(
        alias(&legacy).unwrap().as_deref(),
        Some("HostKeyAlias=telaoi-pinned")
    );

    let tampered = host_key_with(4);
    std::fs::write(file(&tampered), format!("telaoi-pinned {fresh}\n")).unwrap();
    assert!(alias(&tampered).is_err());
}

#[cfg(unix)]
#[test]
fn command_line_security_options_override_ssh_config() {
    initialize_test_trust();
    let config = std::env::temp_dir().join(format!(
        "soreno-ssh-config-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::write(
        &config,
        "Host *\n  ForkAfterAuthentication yes\n  KnownHostsCommand /bin/true\n  VerifyHostKeyDNS yes\n  CheckHostIP yes\n",
    )
    .unwrap();
    let mut command = Command::new("ssh");
    command
        .args(
            arguments(&SshConnection {
                host_key: Some(host_key()),
                ..connection()
            })
            .unwrap(),
        )
        .args(["-F", config.to_str().unwrap(), "-G", "--", "example.com"]);
    let output = match command.output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => panic!("ssh -G failed: {error}"),
    };
    let _ = std::fs::remove_file(config);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let config = String::from_utf8(output.stdout).unwrap();
    assert!(config.contains("forkafterauthentication no\n"));
    assert!(config.contains("verifyhostkeydns false\n"));
    assert!(config.contains("checkhostip no\n"));
    assert!(!config.contains("knownhostscommand /bin/true"));
}

#[test]
fn reconnect_readiness_retries_only_the_safe_probe() {
    let mut attempts = 0;
    retry_ready(
        || {
            attempts += 1;
            if attempts < 3 {
                Err(format!("transient {attempts}"))
            } else {
                Ok(())
            }
        },
        3,
        Duration::ZERO,
    )
    .unwrap();
    assert_eq!(attempts, 3);

    let error = retry_ready(|| Err("still starting".into()), 2, Duration::ZERO).unwrap_err();
    assert!(error.contains("still starting"));
}

#[test]
fn remote_command_is_one_quoted_argument() {
    let script = format!("cd -- {} && printf ok", quote("/a' b;$(touch nope)"));
    let command = command(&connection(), &script).unwrap();
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_str().unwrap())
        .collect();
    assert_eq!(
        &args[args.len() - 4..args.len() - 1],
        ["-T", "--", "example.com"]
    );
    assert_eq!(args.last().unwrap(), &format!("sh -c {}", quote(&script)));
}
#[test]
fn directory_protocol_preserves_names_and_rejects_malformed_data() {
    let listing = parse_listing(b"/home/me\0space ' ;\0.hidden\0line\nbreak\0").unwrap();
    assert_eq!(listing.parent_path.as_deref(), Some("/home"));
    assert_eq!(listing.directories[2].path, "/home/me/space ' ;");
    assert_eq!(parse_listing(b"/\0").unwrap().parent_path, None);
    for invalid in [
        b"/tmp\0../escape\0".as_slice(),
        b"/tmp\0..\0",
        b"relative\0",
        b"/tmp\0incomplete",
        b"/tmp\0\xff\0",
    ] {
        assert!(parse_listing(invalid).is_err());
    }
}
#[test]
fn validates_public_key_type_and_fingerprint_bytes() {
    let key = host_key();
    let blob = STANDARD.decode(key.split_once(' ').unwrap().1).unwrap();
    assert_eq!(parse_key(&key).unwrap(), blob);
    assert!(parse_key(&format!("{key}\n")).is_err());
    assert!(parse_key("ssh-ed25519 AAAA").is_err());
}
#[cfg(unix)]
#[test]
fn command_runner_bounds_output_and_time_and_preserves_stdin() {
    let mut command = Command::new("sh");
    command.args(["-c", "cat"]);
    assert_eq!(
        output(command, Some(b"hello\0ssh"), 100, TIMEOUT).unwrap(),
        b"hello\0ssh"
    );
    let mut command = Command::new("sh");
    command.args(["-c", "yes"]);
    assert!(output(command, None, 20, TIMEOUT)
        .unwrap_err()
        .contains("volumineuse"));
    let mut command = Command::new("sh");
    command.args(["-c", "sleep 30"]);
    let start = Instant::now();
    assert!(output(command, None, 20, Duration::from_millis(100))
        .unwrap_err()
        .contains("Délai"));
    assert!(start.elapsed() < Duration::from_secs(3));
}
