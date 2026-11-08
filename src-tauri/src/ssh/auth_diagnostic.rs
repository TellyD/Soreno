use super::{process_output, Result, SshConnection, SshOutput};
use std::{
    process::Command,
    time::{Duration, Instant},
};

const KEY_REQUIRES_AGENT: &str = "[SSH/keyRequiresAgent]";

pub(super) fn annotate(connection: &SshConnection, error: String, budget: Duration) -> String {
    diagnose(connection, error, budget, |command, timeout| {
        process_output(command, None, 256 * 1024, timeout)
    })
}

fn diagnose(
    connection: &SshConnection,
    error: String,
    budget: Duration,
    mut execute: impl FnMut(Command, Duration) -> Result<SshOutput>,
) -> String {
    let Some(identity) = connection.identity_file.as_deref() else {
        return error;
    };
    if !error.contains("Permission denied (")
        || error.contains("Host key verification failed")
        || error.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
        || error.contains("REVOKED HOST KEY")
    {
        return error;
    }
    let deadline = Instant::now() + budget.min(Duration::from_secs(3));
    let mut run = |mut command: Command| {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Diagnostic SSH expiré.".into());
        }
        command
            .env("LC_ALL", "C")
            .env("SSH_ASKPASS_REQUIRE", "never");
        execute(command, remaining)
    };
    let needs_agent = (|| {
        let mut keygen = Command::new("ssh-keygen");
        keygen.args(["-y", "-P", "", "-f", identity]);
        let keygen = run(keygen).ok()?;
        if keygen.status == 0
            || !String::from_utf8_lossy(&keygen.stderr)
                .contains("incorrect passphrase supplied to decrypt private key")
        {
            return None;
        }

        let config = run(super::openssh_config_command(connection).ok()?).ok()?;
        if config.status != 0 {
            return None;
        }
        let config = String::from_utf8(config.stdout).ok()?;
        // ssh-add inspects the default agent, not a custom IdentityAgent from ssh_config.
        if config.lines().any(|line| {
            line.strip_prefix("identityagent ")
                .is_some_and(|agent| agent != "SSH_AUTH_SOCK")
                || matches!(
                    line,
                    "pubkeyauthentication no" | "pubkeyauthentication false"
                )
        }) {
            return None;
        }
        let mut agent = Command::new("ssh-add");
        agent.arg("-l");
        let agent = run(agent).ok()?;
        let stderr = String::from_utf8_lossy(&agent.stderr);
        let stdout = String::from_utf8_lossy(&agent.stdout);
        ((agent.status != 0
            && [
                "Error connecting to agent:",
                "Could not open a connection to your authentication agent",
            ]
            .iter()
            .any(|message| stderr.contains(message)))
            || (agent.status == 1 && stdout.contains("The agent has no identities")))
        .then_some(())
    })();
    if needs_agent.is_some() {
        format!("{KEY_REQUIRES_AGENT}\n{error}")
    } else {
        error
    }
}

#[cfg(test)]
#[path = "auth_diagnostic_tests.rs"]
mod tests;
