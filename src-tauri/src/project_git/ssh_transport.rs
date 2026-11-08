use super::{
    block_mutations, bounded_by_read_deadline, check_read_deadline,
    command_builder::ssh_git_script, failure_code, read_deadline, read_timeout_error,
    ssh_connection, AgentProject, GitError, GitOutput, DATA_LIMIT,
};
use std::time::{Duration, Instant};

pub(super) fn ssh_transport_error_code(message: &str) -> &'static str {
    if message.contains("Délai SSH") {
        "timeout"
    } else if message.starts_with("OpenSSH indisponible") {
        "missing"
    } else if message.contains("trop volumineuse") {
        "outputTooLarge"
    } else {
        "inaccessible"
    }
}

pub(super) fn ssh_git_execute(
    project: &AgentProject,
    args: &[&str],
    timeout: Duration,
    mutation: bool,
    stdin: Option<&[u8]>,
) -> Result<GitOutput, GitError> {
    let started = Instant::now();
    let read_deadline = if mutation {
        None
    } else {
        check_read_deadline()?;
        read_deadline()
    };
    let command_deadline = started + timeout;
    let (deadline, read_budget_expires_first) =
        bounded_by_read_deadline(read_deadline, command_deadline);
    let timeout = deadline.saturating_duration_since(started);
    if stdin.is_some_and(|data| data.len() > 4 * 1024 * 1024) {
        return Err(GitError::new(
            "inputTooLarge",
            "L’entrée Git dépasse la limite de 4 Mio.",
        ));
    }
    let connection = ssh_connection(project)?;
    let run = if mutation {
        crate::ssh::run_output_with_timeout
    } else {
        crate::ssh::run_read_output_with_timeout
    };
    match run(
        connection,
        &ssh_git_script(project, args)?,
        stdin,
        DATA_LIMIT,
        timeout,
    ) {
        Ok(output) if output.status == 0 => Ok(GitOutput {
            stdout: output.stdout,
            #[cfg(all(test, unix))]
            stderr: output.stderr,
        }),
        Ok(output) => {
            let detail = if output.stderr.is_empty() {
                String::from_utf8_lossy(&output.stdout).into_owned()
            } else {
                String::from_utf8_lossy(&output.stderr).into_owned()
            };
            Err(GitError::command(
                failure_code(&output.stdout, &output.stderr),
                format!("Git a échoué (code {}) : {}", output.status, detail.trim()),
                mutation,
            ))
        }
        Err(message) => {
            if !mutation && read_budget_expires_first && message.contains("Délai SSH") {
                return Err(read_timeout_error());
            }
            if mutation
                && !message.starts_with("OpenSSH indisponible")
                && !message.starts_with("Commande SSH trop volumineuse")
            {
                block_mutations(false, true);
            }
            Err(GitError::command(
                ssh_transport_error_code(&message),
                message,
                mutation,
            ))
        }
    }
}
