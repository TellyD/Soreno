use super::*;
use std::collections::VecDeque;

const AUTH_ERROR: &str = "Connexion SSH interrompue.\nuser@host: Permission denied (publickey).";
const LOCKED_KEY: &str = "Load key: incorrect passphrase supplied to decrypt private key";

fn connection() -> SshConnection {
    SshConnection {
        host: "example.invalid".into(),
        user: Some("user".into()),
        port: None,
        identity_file: Some(
            std::env::current_dir()
                .unwrap()
                .join("key")
                .to_string_lossy()
                .into_owned(),
        ),
        host_key: None,
    }
}

fn captured(status: u8, stdout: &[u8], stderr: &[u8]) -> SshOutput {
    SshOutput {
        status,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    }
}

fn success(stdout: &[u8]) -> Result<SshOutput> {
    Ok(captured(0, stdout, b""))
}

fn failure(stderr: &str) -> Result<SshOutput> {
    Ok(captured(1, b"", stderr.as_bytes()))
}

fn check(responses: Vec<Result<SshOutput>>) -> String {
    let mut responses = VecDeque::from(responses);
    let mut calls = 0;
    let connection = connection();
    let result = diagnose(
        &connection,
        AUTH_ERROR.into(),
        Duration::from_secs(15),
        |command, timeout| {
            assert!(timeout <= Duration::from_secs(3));
            assert!(!timeout.is_zero());
            let args: Vec<_> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            match calls {
                0 => {
                    assert_eq!(command.get_program(), "ssh-keygen");
                    assert_eq!(&args[..4], ["-y", "-P", "", "-f"]);
                    assert_eq!(args[4], connection.identity_file.as_deref().unwrap());
                }
                1 => {
                    assert_eq!(command.get_program(), "ssh");
                    assert_eq!(&args[args.len() - 3..], ["-G", "--", "example.invalid"]);
                    assert!(args.contains(&"StrictHostKeyChecking=yes".into()));
                }
                2 => {
                    assert_eq!(command.get_program(), "ssh-add");
                    assert_eq!(args, ["-l"]);
                }
                _ => panic!("Unexpected subprocess"),
            }
            assert!(command
                .get_envs()
                .any(|(key, value)| key == "SSH_ASKPASS_REQUIRE"
                    && value.is_some_and(|v| v == "never")));
            calls += 1;
            responses.pop_front().expect("No extra diagnostic commands")
        },
    );
    assert!(responses.is_empty());
    result
}

#[test]
fn reports_locked_key_only_when_the_default_agent_is_unavailable_or_empty() {
    for agent in [
        failure("Error connecting to agent: No such file or directory"),
        failure("Could not open a connection to your authentication agent."),
        Ok(captured(1, b"The agent has no identities.\n", b"")),
    ] {
        let result = check(vec![
            failure(LOCKED_KEY),
            success(b"pubkeyauthentication true\n"),
            agent,
        ]);
        assert_eq!(result, format!("{KEY_REQUIRES_AGENT}\n{AUTH_ERROR}"));
    }
}

#[cfg(unix)]
#[test]
fn diagnoses_empty_agent_from_bounded_nonzero_stdout_capture() {
    let mut command = Command::new("sh");
    command.args(["-c", "printf 'The agent has no identities.\\n'; exit 1"]);
    let agent = super::super::process_output(command, None, 1024, Duration::from_secs(1)).unwrap();

    assert_eq!(agent.status, 1);
    assert_eq!(agent.stdout, b"The agent has no identities.\n");
    assert!(agent.stderr.is_empty());
    assert_eq!(
        check(vec![
            failure(LOCKED_KEY),
            success(b"pubkeyauthentication true\n"),
            Ok(agent),
        ]),
        format!("{KEY_REQUIRES_AGENT}\n{AUTH_ERROR}")
    );
}

#[test]
fn preserves_auth_error_when_the_cause_is_not_confirmed() {
    for responses in [
        vec![success(b"public key only")],
        vec![failure("invalid format")],
        vec![Err("OpenSSH indisponible".into())],
        vec![
            failure(LOCKED_KEY),
            Err("Configuration inaccessible".into()),
        ],
        vec![
            failure(LOCKED_KEY),
            success(b"pubkeyauthentication true\n"),
            success(b"256 SHA256:key (ED25519)"),
        ],
        vec![
            failure(LOCKED_KEY),
            success(b"pubkeyauthentication true\n"),
            Err("Diagnostic SSH expiré.".into()),
        ],
        vec![
            failure(LOCKED_KEY),
            success(b"pubkeyauthentication true\n"),
            success(b"The agent has no identities.\n"),
        ],
        vec![
            failure(LOCKED_KEY),
            success(b"pubkeyauthentication true\n"),
            Ok(captured(2, b"The agent has no identities.\n", b"")),
        ],
    ] {
        assert_eq!(check(responses), AUTH_ERROR);
    }
}

#[test]
fn does_not_diagnose_a_different_agent_or_disabled_public_key_authentication() {
    for config in [
        "identityagent /custom/agent\n",
        "identityagent none\n",
        "pubkeyauthentication no\n",
        "pubkeyauthentication false\n",
    ] {
        assert_eq!(
            check(vec![failure(LOCKED_KEY), success(config.as_bytes())]),
            AUTH_ERROR
        );
    }
}

#[test]
fn skips_non_auth_failures_implicit_identities_and_expired_budgets() {
    for (connection, message, budget) in [
        (
            connection(),
            "Host key verification failed.",
            Duration::from_secs(15),
        ),
        (
            SshConnection {
                identity_file: None,
                ..connection()
            },
            AUTH_ERROR,
            Duration::from_secs(15),
        ),
        (connection(), AUTH_ERROR, Duration::ZERO),
    ] {
        assert_eq!(
            diagnose(&connection, message.into(), budget, |_, _| panic!(
                "No subprocess expected"
            )),
            message
        );
    }
}
