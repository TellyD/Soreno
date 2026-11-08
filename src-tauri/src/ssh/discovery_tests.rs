use super::*;

const HOST_KEY_ALGORITHMS: &str = "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256";

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
    let mut blob = Vec::new();
    blob.extend(11u32.to_be_bytes());
    blob.extend(b"ssh-ed25519");
    blob.extend(32u32.to_be_bytes());
    blob.extend([1; 32]);
    format!("ssh-ed25519 {}", STANDARD.encode(blob))
}

fn initialize_test_trust() {
    super::tests::initialize_test_trust();
}

#[test]
fn rejects_public_identity_files_before_running_ssh() {
    let identity = std::env::current_dir().unwrap().join("identity.PuB");
    let error = validate(&SshConnection {
        identity_file: Some(identity.to_string_lossy().into_owned()),
        ..connection()
    })
    .unwrap_err();
    assert!(error.contains("privée") && error.contains("publique .pub"));
}

#[test]
fn parses_keys_after_auth_failure_and_propagates_empty_failure() {
    initialize_test_trust();
    let known_hosts = DiscoveryKnownHosts::create().unwrap();
    std::fs::write(&known_hosts.path, format!("example.com {}\n", host_key())).unwrap();
    let keys =
        read_discovered_keys(&known_hosts.path, Err("authentication failed".into())).unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].key, host_key());
    assert!(keys[0].fingerprint.starts_with("SHA256:"));

    std::fs::write(&known_hosts.path, []).unwrap();
    assert_eq!(
        read_discovered_keys(&known_hosts.path, Err("network failed".into())).unwrap_err(),
        "network failed"
    );
    assert!(read_discovered_keys(&known_hosts.path, Ok(Vec::new()))
        .unwrap_err()
        .contains("Aucune clé"));
    std::fs::write(&known_hosts.path, "ignored malformed record\n").unwrap();
    assert!(
        read_discovered_keys(&known_hosts.path, Err("authentication failed".into()))
            .unwrap_err()
            .contains("invalide")
    );
}

#[test]
fn known_hosts_are_exclusive_and_cleaned_on_success_or_error() {
    initialize_test_trust();
    let success_path;
    {
        let known_hosts = DiscoveryKnownHosts::create().unwrap();
        success_path = known_hosts.path.clone();
        std::fs::write(&known_hosts.path, format!("host {}\n", host_key())).unwrap();
        read_discovered_keys(&known_hosts.path, Ok(Vec::new())).unwrap();
    }
    assert!(!success_path.exists());

    let error_path;
    {
        let first = DiscoveryKnownHosts::create().unwrap();
        let second = DiscoveryKnownHosts::create().unwrap();
        error_path = second.path.clone();
        assert_ne!(first.path, second.path);
        std::fs::write(&first.path, "sentinel").unwrap();
        assert_eq!(std::fs::read_to_string(&first.path).unwrap(), "sentinel");
        assert!(read_discovered_keys(&second.path, Err("failed".into())).is_err());
    }
    assert!(!error_path.exists());
}

#[test]
fn options_precede_shared_options_and_clear_credentials() {
    initialize_test_trust();
    let known_hosts = DiscoveryKnownHosts::create().unwrap();
    let command = discovery_command(
        &SshConnection {
            identity_file: Some(
                std::env::current_dir()
                    .unwrap()
                    .join("id")
                    .to_string_lossy()
                    .into_owned(),
            ),
            host_key: Some(host_key()),
            ..connection()
        },
        &known_hosts.path,
        HOST_KEY_ALGORITHMS,
    )
    .unwrap();
    let args: Vec<_> = command
        .get_args()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    let accept_new = args
        .iter()
        .position(|argument| argument == "StrictHostKeyChecking=accept-new")
        .unwrap();
    let strict = args
        .iter()
        .position(|argument| argument == "StrictHostKeyChecking=yes")
        .unwrap();
    assert!(accept_new < strict);
    assert!(!args.iter().any(|argument| argument == "-i"));
    assert!(args
        .windows(4)
        .any(|args| args == ["-N", "-T", "--", "example.com"]));
    for option in [
        "PreferredAuthentications=none",
        "PubkeyAuthentication=no",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "GSSAPIAuthentication=no",
        "HostbasedAuthentication=no",
        "IdentityAgent=none",
        "ProxyCommand=none",
        "ProxyJump=none",
        "Tunnel=no",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "ControlMaster=no",
        "UpdateHostKeys=no",
    ] {
        assert!(args.iter().any(|argument| argument == option), "{option}");
    }
}

#[cfg(unix)]
#[test]
fn security_options_override_adversarial_ssh_config() {
    initialize_test_trust();
    let config_path = std::env::temp_dir().join(format!(
        "soreno-ssh-discovery-config-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::write(
        &config_path,
        "Host *\n  StrictHostKeyChecking no\n  HashKnownHosts yes\n  PreferredAuthentications publickey,password,keyboard-interactive\n  PubkeyAuthentication yes\n  PasswordAuthentication yes\n  KbdInteractiveAuthentication yes\n  GSSAPIAuthentication yes\n  HostbasedAuthentication yes\n  IdentityAgent SSH_AUTH_SOCK\n  ProxyCommand /bin/false\n  Tunnel yes\n  ForwardAgent yes\n  ForkAfterAuthentication yes\n  PermitLocalCommand yes\n  LocalCommand /bin/false\n  ControlMaster yes\n  UpdateHostKeys yes\n  LocalForward 1234 localhost:22\n  RemoteForward 1235 localhost:22\n  DynamicForward 1236\n",
    )
    .unwrap();
    let known_hosts = DiscoveryKnownHosts::create().unwrap();
    let mut command = Command::new("ssh");
    command
        .args(discovery_options(&known_hosts.path, HOST_KEY_ALGORITHMS).unwrap())
        .args(arguments(&connection()).unwrap())
        .args([
            "-F",
            config_path.to_str().unwrap(),
            "-G",
            "--",
            "example.com",
        ]);
    let result = match command.output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => panic!("ssh -G failed: {error}"),
    };
    let _ = std::fs::remove_file(config_path);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let config = String::from_utf8(result.stdout).unwrap();
    for expected in [
        "stricthostkeychecking accept-new\n",
        "hashknownhosts no\n",
        "preferredauthentications none\n",
        "pubkeyauthentication false\n",
        "passwordauthentication no\n",
        "kbdinteractiveauthentication no\n",
        "gssapiauthentication no\n",
        "hostbasedauthentication no\n",
        "identityagent none\n",
        "tunnel false\n",
        "forwardagent no\n",
        "forkafterauthentication no\n",
        "permitlocalcommand no\n",
        "controlmaster false\n",
        "updatehostkeys false\n",
    ] {
        assert!(
            config.contains(expected),
            "missing {expected:?} in {config}"
        );
    }
    assert!(!config.contains("localforward "));
    assert!(!config.contains("remoteforward "));
    assert!(!config.contains("dynamicforward "));
}

#[test]
fn rejects_proxy_and_invalid_effective_targets() {
    assert!(validate_discovery_config(
        "hostname example.com\nport 22\nhostkeyalgorithms ssh-ed25519\nproxycommand /bin/false\nproxyjump none\n"
    )
    .unwrap_err()
    .contains("ProxyJump/ProxyCommand"));
    assert!(validate_discovery_config(
        "hostname example.com\nport 0\nhostkeyalgorithms ssh-ed25519\n"
    )
    .is_err());
    assert!(validate_discovery_config(
        "hostname bad host\nport 22\nhostkeyalgorithms ssh-ed25519\n"
    )
    .is_err());
    validate_discovery_config(
        "hostname example.com\nport 22\nhostkeyalgorithms ssh-ed25519\nproxycommand none\nproxyjump none\n",
    )
    .unwrap();
}

#[test]
fn preserves_supported_effective_host_key_algorithms() {
    let rsa_only = validate_discovery_config(
        "hostname example.com\nport 22\nhostkeyalgorithms rsa-sha2-512\n",
    )
    .unwrap();
    assert_eq!(rsa_only, "rsa-sha2-512");

    initialize_test_trust();
    let known_hosts = DiscoveryKnownHosts::create().unwrap();
    let command = discovery_command(&connection(), &known_hosts.path, &rsa_only).unwrap();
    assert!(command
        .get_args()
        .any(|argument| argument == "HostKeyAlgorithms=rsa-sha2-512"));

    let ordered = validate_discovery_config(
        "hostname example.com\nport 22\nhostkeyalgorithms ssh-ed25519-cert-v01@openssh.com,rsa-sha2-256,ssh-rsa,sk-ssh-ed25519@openssh.com,ecdsa-sha2-nistp384\n",
    )
    .unwrap();
    assert_eq!(ordered, "rsa-sha2-256,ssh-rsa,ecdsa-sha2-nistp384");

    let error = validate_discovery_config(
        "hostname example.com\nport 22\nhostkeyalgorithms ssh-ed25519-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com\n",
    )
    .unwrap_err();
    assert!(error.contains("Aucun algorithme de clé d’hôte"));
}
