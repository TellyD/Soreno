use super::{execution::read_bounded, read_stderr, read_stderr_async};
use crate::process_owner::ProcessOwner;
use std::{
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

const CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);
const DEFAULT_STDOUT_LIMIT: u64 = 8192;

pub(super) fn failed(error: impl std::fmt::Display) -> String {
    format!(
        "CODEX_UPDATE_FAILED: {}",
        error.to_string().chars().take(1024).collect::<String>()
    )
}

pub(crate) fn run_command(
    command: &mut Command,
    timeout: Duration,
    capture_stdout: bool,
) -> Result<String, String> {
    run_command_with_stdout_limit(command, timeout, capture_stdout, DEFAULT_STDOUT_LIMIT)
}

pub(crate) fn run_command_with_stdout_limit(
    command: &mut Command,
    timeout: Duration,
    capture_stdout: bool,
    stdout_limit: u64,
) -> Result<String, String> {
    let output =
        run_command_output(command, timeout, capture_stdout, stdout_limit).map_err(|failure| {
            match failure {
                CommandFailure::Io(error) => failed(error),
                CommandFailure::Timeout => "CODEX_UPDATE_TIMEOUT".into(),
            }
        })?;
    if !output.status.success() {
        return Err(failed(if output.stderr.trim().is_empty() {
            output.status.to_string()
        } else {
            output.stderr
        }));
    }
    Ok(output.stdout)
}

pub(crate) struct CommandOutput {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

pub(crate) enum CommandFailure {
    Io(String),
    Timeout,
}

pub(crate) fn run_command_output(
    command: &mut Command,
    timeout: Duration,
    capture_stdout: bool,
    stdout_limit: u64,
) -> Result<CommandOutput, CommandFailure> {
    let io = |error: std::io::Error| CommandFailure::Io(error.to_string());
    ProcessOwner::configure(command);
    command
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(if capture_stdout {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = command.spawn().map_err(io)?;
    let mut owner = ProcessOwner::new(&child).map_err(|error| {
        kill_unowned_child(&mut child, CLEANUP_TIMEOUT);
        CommandFailure::Io(error.to_string())
    })?;
    let stderr = read_stderr_async(child.stderr.take());
    // Drains past the limit so a chatty child does not fail on a closed pipe.
    let stdout_limit = usize::try_from(stdout_limit).unwrap_or(usize::MAX);
    let stdout = child
        .stdout
        .take()
        .map(|stdout| std::thread::spawn(move || read_bounded(stdout, stdout_limit)));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20))
            }
            result => {
                owner.terminate(&mut child, CLEANUP_TIMEOUT);
                return Err(match result {
                    Err(error) => io(error),
                    _ => CommandFailure::Timeout,
                });
            }
        }
    };
    owner.terminate(&mut child, CLEANUP_TIMEOUT);
    while stderr.as_ref().is_some_and(|reader| !reader.is_finished())
        || stdout.as_ref().is_some_and(|reader| !reader.is_finished())
    {
        if started.elapsed() >= timeout {
            return Err(CommandFailure::Timeout);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(CommandOutput {
        status,
        stderr: read_stderr(stderr),
        stdout: stdout
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default(),
    })
}

pub(super) fn kill_unowned_child(child: &mut Child, timeout: Duration) {
    let _ = child.kill();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture_command(mode: &str, output: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "codex_cli::execution::tests::execution_fixture",
                "--nocapture",
            ])
            .env("SORENO_CODEX_EXECUTION_FIXTURE", mode)
            .env("SORENO_CODEX_EXECUTION_OUTPUT", output);
        command
    }

    #[test]
    fn descendants_stop_after_parent_exit_and_timeout() {
        for (mode, timeout, times_out) in [
            ("descendant", Duration::from_secs(2), false),
            ("descendant-wait", Duration::from_millis(300), true),
        ] {
            let marker = std::env::temp_dir().join(format!(
                "soreno-codex-process-{}-{mode}",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&marker);
            let _ = std::fs::remove_file(marker.with_extension("started"));
            let result = run_command(&mut fixture_command(mode, &marker), timeout, true);
            if times_out {
                assert_eq!(result.unwrap_err(), "CODEX_UPDATE_TIMEOUT");
            } else {
                result.unwrap();
            }
            std::thread::sleep(Duration::from_millis(700));
            assert!(!marker.exists());
            let _ = std::fs::remove_file(marker.with_extension("started"));
        }
    }

    #[test]
    fn stdout_beyond_the_limit_is_drained() {
        let marker = std::env::temp_dir().join(format!(
            "soreno-codex-process-{}-stdout-flood",
            std::process::id()
        ));
        let output = run_command_output(
            &mut fixture_command("stdout-flood", &marker),
            Duration::from_secs(30),
            true,
            1024,
        )
        .unwrap_or_else(|_| panic!("fixture failed to run"));
        let _ = std::fs::remove_file(&marker);
        assert!(output.status.success(), "{}", output.stderr);
        assert_eq!(output.stdout.len(), 1024);
    }
}
