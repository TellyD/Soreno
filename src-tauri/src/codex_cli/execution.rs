use super::{
    codex_command, find_codex_binary, native_codex_binary, process::kill_unowned_child,
    write_prompt, CODEX_UPDATE,
};
use crate::process_owner::ProcessOwner;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const IO_POLL_INTERVAL: Duration = Duration::from_millis(20);
const IO_CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);
const STDERR_LIMIT: usize = 8 * 1024;

static ACTIVE_EXECUTIONS: AtomicUsize = AtomicUsize::new(0);

struct OwnedChild {
    child: Child,
    owner: ProcessOwner,
}

struct TerminateOnDrop(Arc<Mutex<OwnedChild>>);

impl Drop for TerminateOnDrop {
    fn drop(&mut self) {
        terminate(&self.0);
    }
}

pub(super) struct CodexExecution {
    pub(super) output_path: PathBuf,
}

impl Drop for CodexExecution {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.output_path);
        ACTIVE_EXECUTIONS.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Debug)]
pub(super) enum CodexExecutionError {
    Setup(String),
    Spawn(String),
    StdoutUnavailable,
    ReadStdout(String),
    Wait(String),
    Write(String),
    TimedOut,
}

pub(super) fn format_execution_error(error: CodexExecutionError) -> String {
    use CodexExecutionError::*;
    match error {
        Setup(error) => error,
        Spawn(error) => format!("Impossible de lancer Codex : {error}"),
        StdoutUnavailable => "La sortie standard Codex est indisponible.".into(),
        ReadStdout(error) => format!("Impossible de lire la sortie Codex : {error}"),
        Wait(error) => format!("Impossible d’attendre Codex : {error}"),
        Write(error) => error.replace(
            "Failed to write Codex input",
            "Impossible d’écrire le prompt Codex",
        ),
        TimedOut => "La génération du message de commit a expiré.".into(),
    }
}

#[derive(Debug)]
pub(super) enum CodexOutputError {
    Read(String),
    TooLong,
    InvalidUtf8,
}

pub(super) struct CodexExecutionResult {
    pub status: ExitStatus,
    pub stderr: String,
    pub last_message: Result<Option<String>, CodexOutputError>,
}

#[cfg(test)]
pub(super) fn test_execution_guard() -> std::sync::MutexGuard<'static, ()> {
    static TEST_EXECUTIONS: Mutex<()> = Mutex::new(());
    TEST_EXECUTIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(super) fn is_active() -> bool {
    ACTIVE_EXECUTIONS.load(Ordering::Acquire) > 0
}

pub(super) fn reserve() -> Result<CodexExecution, String> {
    let _update = CODEX_UPDATE
        .try_lock()
        .map_err(|_| "CODEX_UPDATE_BUSY".to_string())?;
    ACTIVE_EXECUTIONS.fetch_add(1, Ordering::AcqRel);
    Ok(CodexExecution {
        output_path: last_message_path(),
    })
}

pub(super) fn build_command(
    binary: &Path,
    model: Option<&str>,
    fast_mode: bool,
    output_path: &Path,
) -> Command {
    let mut command = codex_command(binary);
    command.current_dir(std::env::temp_dir());
    // Without a chosen model, Codex picks one available to the account.
    if let Some(model) = model {
        command.args(["--model", model]);
    }
    command.args([
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.view_image=false",
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "web_search=\"disabled\"",
        "-c",
        "model_reasoning_effort=\"low\"",
    ]);
    if fast_mode {
        command.args([
            "-c",
            "features.fast_mode=true",
            "-c",
            "service_tier=\"fast\"",
        ]);
    }
    command.args([
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--json",
    ]);
    command
        .arg("--output-last-message")
        .arg(output_path)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

pub(super) fn run(
    model: Option<&str>,
    fast_mode: bool,
    prompt: &str,
    timeout: Duration,
    output_limit: usize,
) -> Result<CodexExecutionResult, CodexExecutionError> {
    let execution = reserve().map_err(CodexExecutionError::Setup)?;
    let binary = find_codex_binary()
        .and_then(|binary| native_codex_binary(&binary))
        .map_err(CodexExecutionError::Setup)?;
    run_command(
        build_command(&binary, model, fast_mode, &execution.output_path),
        prompt,
        &execution.output_path,
        timeout,
        output_limit,
    )
}

pub(super) fn run_command(
    mut command: Command,
    prompt: &str,
    output_path: &Path,
    timeout: Duration,
    output_limit: usize,
) -> Result<CodexExecutionResult, CodexExecutionError> {
    let deadline = Instant::now() + timeout;
    ProcessOwner::configure(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| CodexExecutionError::Spawn(error.to_string()))?;
    let mut owner = ProcessOwner::new(&child).map_err(|error| {
        kill_unowned_child(&mut child, IO_CLEANUP_TIMEOUT);
        CodexExecutionError::Setup(format!("Failed to isolate Codex process: {error}"))
    })?;
    let stdin = child.stdin.take();
    let Some(mut stdout) = child.stdout.take() else {
        owner.terminate(&mut child, IO_CLEANUP_TIMEOUT);
        return Err(CodexExecutionError::StdoutUnavailable);
    };
    let stderr = child.stderr.take();
    let child = TerminateOnDrop(Arc::new(Mutex::new(OwnedChild { child, owner })));

    let (writer_tx, writer_rx) = mpsc::channel();
    let prompt = prompt.to_owned();
    let writer_child = Arc::clone(&child.0);
    std::thread::spawn(move || {
        let result = write_prompt(stdin, &prompt);
        if result.is_err() {
            terminate(&writer_child);
        }
        let _ = writer_tx.send(result);
    });

    // The answer comes from the last-message file; stdout only has to be drained.
    let (stdout_tx, stdout_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = std::io::copy(&mut stdout, &mut std::io::sink());
        let _ = stdout_tx.send(result.map_err(|error| error.to_string()));
    });

    let (stderr_tx, stderr_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let output = stderr
            .map(|stderr| read_bounded(stderr, STDERR_LIMIT))
            .unwrap_or_default();
        let _ = stderr_tx.send(output);
    });

    let mut status = None;
    let mut writer_result = None;
    let mut stderr_output = None;
    let mut stdout_done = false;
    let mut exit_deadline = deadline;

    let status = loop {
        if Instant::now() >= exit_deadline {
            return Err(CodexExecutionError::TimedOut);
        }
        if stdout_done {
            std::thread::sleep(IO_POLL_INTERVAL);
        } else {
            match stdout_rx.recv_timeout(IO_POLL_INTERVAL) {
                Ok(Err(error)) => return Err(CodexExecutionError::ReadStdout(error)),
                Ok(Ok(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => stdout_done = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        if writer_result.is_none() {
            writer_result = writer_rx.try_recv().ok();
        }
        if stderr_output.is_none() {
            stderr_output = stderr_rx.try_recv().ok();
        }
        if status.is_none() {
            status = child
                .0
                .lock()
                .map_err(|error| CodexExecutionError::Wait(error.to_string()))?
                .child
                .try_wait()
                .map_err(|error| CodexExecutionError::Wait(error.to_string()))?;
            if status.is_some() {
                // Descendants may still hold the pipes open after the CLI exits.
                terminate(&child.0);
                exit_deadline = deadline.min(Instant::now() + IO_CLEANUP_TIMEOUT);
            }
        }
        if let (Some(status), true, Some(_), Some(_)) =
            (status, stdout_done, &writer_result, &stderr_output)
        {
            break status;
        }
    };
    if let Some(Err(error)) = writer_result {
        return Err(CodexExecutionError::Write(error));
    }
    Ok(CodexExecutionResult {
        status,
        stderr: stderr_output.unwrap_or_default(),
        last_message: read_last_message(output_path, output_limit),
    })
}

pub(super) fn read_bounded(mut reader: impl Read, limit: usize) -> String {
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let keep = count.min(limit.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..keep]);
    }
    String::from_utf8_lossy(&output).into_owned()
}

pub(super) fn read_last_message(
    path: &Path,
    limit: usize,
) -> Result<Option<String>, CodexOutputError> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CodexOutputError::Read(error.to_string())),
    };
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CodexOutputError::Read(error.to_string()))?;
    if bytes.len() > limit {
        return Err(CodexOutputError::TooLong);
    }
    let message = String::from_utf8(bytes).map_err(|_| CodexOutputError::InvalidUtf8)?;
    Ok(Some(message.trim().to_string()).filter(|message| !message.is_empty()))
}

fn terminate(child: &Mutex<OwnedChild>) {
    if let Ok(mut child) = child.lock() {
        let OwnedChild { child, owner } = &mut *child;
        owner.terminate(child, IO_CLEANUP_TIMEOUT);
    }
}

fn last_message_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "soreno-codex-last-message-{}-{nanos}.txt",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const OUTPUT_LIMIT: usize = 1024;

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "soreno-codex-execution-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

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
            .env("SORENO_CODEX_EXECUTION_OUTPUT", output)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    #[test]
    #[ignore = "subprocess fixture for codex execution tests"]
    fn execution_fixture() {
        let Some(mode) = std::env::var_os("SORENO_CODEX_EXECUTION_FIXTURE") else {
            return;
        };
        let output = PathBuf::from(std::env::var_os("SORENO_CODEX_EXECUTION_OUTPUT").unwrap());
        let mode = mode.to_string_lossy();
        match mode.as_ref() {
            "stdout-flood" => {
                let mut stdout = std::io::stdout().lock();
                for index in 0..10_000 {
                    writeln!(stdout, r#"{{"type":"item.updated","index":{index}}}"#).unwrap();
                }
                std::fs::write(output, "final message").unwrap();
            }
            "descendant" | "descendant-wait" => {
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--ignored",
                        "--exact",
                        "codex_cli::execution::tests::execution_fixture",
                    ])
                    .env("SORENO_CODEX_EXECUTION_FIXTURE", "descendant-child")
                    .env("SORENO_CODEX_EXECUTION_OUTPUT", output)
                    .stdin(Stdio::inherit())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
                if mode == "descendant-wait" {
                    std::thread::sleep(Duration::from_secs(30));
                }
            }
            "descendant-child" => {
                std::fs::write(output.with_extension("started"), "started").unwrap();
                std::thread::sleep(Duration::from_millis(600));
                std::fs::write(output, "survived").unwrap();
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn drains_stdout_and_reads_final_message() {
        let _serial = test_execution_guard();
        let output = temp_path("flood");
        let result = run_command(
            fixture_command("stdout-flood", &output),
            "prompt",
            &output,
            Duration::from_secs(5),
            OUTPUT_LIMIT,
        )
        .unwrap();
        assert!(result.status.success());
        assert_eq!(
            result.last_message.unwrap().as_deref(),
            Some("final message")
        );
        std::fs::remove_file(output).unwrap();
    }

    #[test]
    fn dropping_an_execution_removes_its_output_file() {
        let execution = reserve().unwrap();
        let path = execution.output_path.clone();
        std::fs::write(&path, "temporary").unwrap();
        drop(execution);
        assert!(!path.exists());
    }

    #[test]
    fn descendants_stop_on_timeout_and_independent_process_survives() {
        let _serial = test_execution_guard();
        let independent_path = temp_path("independent");
        let mut independent = fixture_command("descendant-child", &independent_path);
        independent
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut independent = independent.spawn().unwrap();

        let output = temp_path("descendant-timeout");
        let started = Instant::now();
        let result = run_command(
            fixture_command("descendant-wait", &output),
            "prompt",
            &output,
            Duration::from_millis(300),
            OUTPUT_LIMIT,
        );
        assert!(matches!(result, Err(CodexExecutionError::TimedOut)));
        assert!(started.elapsed() < Duration::from_secs(1));
        let deadline = Instant::now() + Duration::from_secs(2);
        let independent_status = loop {
            if let Some(status) = independent.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "independent fixture did not exit"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(independent_status.success());
        std::thread::sleep(Duration::from_millis(350));
        assert!(!output.exists());
        let _ = std::fs::remove_file(output.with_extension("started"));
        assert_eq!(
            std::fs::read_to_string(&independent_path).unwrap(),
            "survived"
        );
        let _ = std::fs::remove_file(independent_path.with_extension("started"));
        let _ = std::fs::remove_file(independent_path);
    }

    #[test]
    fn descendants_stop_after_natural_parent_exit() {
        let _serial = test_execution_guard();
        let output = temp_path("descendant-exit");
        let result = run_command(
            fixture_command("descendant", &output),
            "prompt",
            &output,
            Duration::from_secs(2),
            OUTPUT_LIMIT,
        )
        .unwrap();
        assert!(result.status.success());
        std::thread::sleep(Duration::from_millis(700));
        assert!(!output.exists());
        let _ = std::fs::remove_file(output.with_extension("started"));
    }

    #[test]
    fn final_output_is_optional_bounded_and_utf8() {
        let path = temp_path("output");
        assert_eq!(read_last_message(&path, 8).unwrap(), None);
        std::fs::write(&path, " \n").unwrap();
        assert_eq!(read_last_message(&path, 8).unwrap(), None);
        std::fs::write(&path, [0xff]).unwrap();
        assert!(matches!(
            read_last_message(&path, 8),
            Err(CodexOutputError::InvalidUtf8)
        ));
        std::fs::write(&path, "123456789").unwrap();
        assert!(matches!(
            read_last_message(&path, 8),
            Err(CodexOutputError::TooLong)
        ));
        std::fs::remove_file(path).unwrap();
    }
}
