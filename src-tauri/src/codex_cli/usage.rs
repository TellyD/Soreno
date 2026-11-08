use super::{codex_command, find_codex_binary, process::kill_unowned_child};
use crate::process_owner::ProcessOwner;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fmt,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

const IO_LIMIT: u64 = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const EXIT_GRACE: Duration = Duration::from_secs(3);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    pub primary: Option<CodexRateLimitWindow>,
    pub secondary: Option<CodexRateLimitWindow>,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitWindow {
    pub used_percent: i32,
    pub window_duration_mins: Option<i64>,
    pub resets_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitSnapshot {
    #[serde(default)]
    primary: Option<CodexRateLimitWindow>,
    #[serde(default)]
    secondary: Option<CodexRateLimitWindow>,
}

#[derive(Debug, PartialEq)]
pub struct CodexAccount {
    pub email: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct CodexUsage {
    pub account: Option<CodexAccount>,
    pub limits: Option<CodexRateLimits>,
}

#[derive(Debug, PartialEq)]
pub enum AppServerStop {
    Exited { code: Option<i32>, after: Duration },
    Killed { after: Duration, confirmed: bool },
}

impl fmt::Display for AppServerStop {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exited { code, after } => {
                let code = code.map_or_else(|| "none".into(), |code| code.to_string());
                write!(
                    formatter,
                    "exited code={code} after_ms={}",
                    after.as_millis()
                )
            }
            Self::Killed { after, confirmed } => write!(
                formatter,
                "killed after_ms={} confirmed={confirmed}",
                after.as_millis()
            ),
        }
    }
}

pub fn local_app_server_command() -> Result<Command, String> {
    let binary = find_codex_binary()?;
    let mut command = codex_command(&binary);
    command.arg("app-server");
    Ok(command)
}

/// `None` stop: the app server never ran.
pub fn read_usage(command: Command) -> (Result<CodexUsage, String>, Option<AppServerStop>) {
    run(command, REQUEST_TIMEOUT, EXIT_GRACE)
}

fn run(
    mut command: Command,
    timeout: Duration,
    grace: Duration,
) -> (Result<CodexUsage, String>, Option<AppServerStop>) {
    ProcessOwner::configure(&mut command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return (
                Err(format!("Failed to start Codex app server: {error}")),
                None,
            )
        }
    };
    let mut owner = match ProcessOwner::new(&child) {
        Ok(owner) => owner,
        Err(error) => {
            // Still suspended on Windows: it never reached LSASS.
            kill_unowned_child(&mut child, CLEANUP_TIMEOUT);
            return (
                Err(format!("Failed to isolate Codex app server: {error}")),
                None,
            );
        }
    };

    let stdin = Arc::new(Mutex::new(child.stdin.take()));
    let result = match child.stdout.take() {
        Some(stdout) => {
            let (sender, receiver) = mpsc::sync_channel(1);
            let input = Arc::clone(&stdin);
            std::thread::spawn(move || {
                let mut stdout = BufReader::new(stdout.take(IO_LIMIT));
                let _ = sender.send(exchange(&input, &mut stdout));
                // A closed pipe would fail Codex's next write instead of letting it exit cleanly.
                let _ = std::io::copy(&mut stdout.into_inner().into_inner(), &mut std::io::sink());
            });
            receiver
                .recv_timeout(timeout)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => "Codex app server timed out".to_string(),
                    mpsc::RecvTimeoutError::Disconnected => {
                        "Codex app server I/O task failed".to_string()
                    }
                })
                .and_then(|result| result)
        }
        None => Err("Codex app server stdio was not available".into()),
    };

    // Killing Codex mid-call into LSASS can crash LSASS on Windows 11 (RPCRT4, 0xc0000005);
    // closing its input lets it exit by itself.
    drop(stdin.lock().unwrap_or_else(PoisonError::into_inner).take());
    (result, Some(stop(&mut child, &mut owner, grace)))
}

fn stop(child: &mut Child, owner: &mut ProcessOwner, grace: Duration) -> AppServerStop {
    let closed = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Reaps descendants left in the job or process group.
                owner.terminate(child, CLEANUP_TIMEOUT);
                return AppServerStop::Exited {
                    code: status.code(),
                    after: closed.elapsed(),
                };
            }
            Ok(None) if closed.elapsed() < grace => std::thread::sleep(Duration::from_millis(10)),
            _ => break,
        }
    }
    let after = closed.elapsed();
    AppServerStop::Killed {
        after,
        confirmed: owner.terminate(child, CLEANUP_TIMEOUT),
    }
}

fn exchange(
    stdin: &Mutex<Option<ChildStdin>>,
    stdout: &mut BufReader<std::io::Take<ChildStdout>>,
) -> Result<CodexUsage, String> {
    let send = |message: &Value| -> Result<(), String> {
        let mut input = stdin.lock().unwrap_or_else(PoisonError::into_inner);
        let input = input.as_mut().ok_or("Codex app server input was closed")?;
        write_message(input, message)
    };
    send(&json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "soreno",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    }))?;
    read_response(stdout, 1)?;

    send(&json!({ "method": "initialized" }))?;
    send(&json!({
        "id": 2,
        "method": "account/read",
        "params": { "refreshToken": false }
    }))?;
    let account = read_response(stdout, 2).ok().and_then(parse_account);
    send(&json!({
        "id": 3,
        "method": "account/rateLimits/read",
        "params": null
    }))?;
    let limits = read_response(stdout, 3)
        .ok()
        .and_then(|result| parse_rate_limits(result).ok());
    Ok(CodexUsage { account, limits })
}

fn parse_account(result: Value) -> Option<CodexAccount> {
    let account = result.get("account").filter(|account| !account.is_null())?;
    if account.get("type").and_then(Value::as_str) != Some("chatgpt") {
        return Some(CodexAccount { email: None });
    }
    let text = |key: &str| {
        account
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Some(CodexAccount {
        email: text("email"),
    })
}

fn write_message(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, message)
        .map_err(|error| format!("Failed to encode Codex app server request: {error}"))?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Failed to write Codex app server request: {error}"))
}

fn read_response<R: Read>(
    reader: &mut BufReader<std::io::Take<R>>,
    id: i64,
) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| format!("Failed to read Codex app server response: {error}"))?;
        if read == 0 {
            return Err(if reader.get_ref().limit() == 0 {
                "Codex app server output exceeded 1 MiB".into()
            } else {
                "Codex app server closed before replying".into()
            });
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if message.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(format!("Codex app server error: {error}"));
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex app server response had no result".into());
    }
}

fn parse_rate_limits(result: Value) -> Result<CodexRateLimits, String> {
    let snapshot = result
        .get("rateLimitsByLimitId")
        .and_then(|limits| limits.get("codex"))
        .or_else(|| result.get("rateLimits"))
        .ok_or_else(|| "Codex rate-limit response had no usage data".to_string())?;
    let snapshot: RateLimitSnapshot = serde_json::from_value(snapshot.clone())
        .map_err(|error| format!("Invalid Codex rate-limit response: {error}"))?;
    Ok(CodexRateLimits {
        primary: snapshot.primary,
        secondary: snapshot.secondary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{self, BufReader},
        path::{Path, PathBuf},
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture_command(mode: &str, marker: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "codex_cli::usage::tests::app_server_fixture",
                "--nocapture",
            ])
            .env("SORENO_CODEX_USAGE_FIXTURE", mode)
            .env("SORENO_CODEX_USAGE_MARKER", marker);
        command
    }

    fn marker(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "soreno-codex-usage-{}-{name}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn parses_legacy_map_null_and_rejects_malformed_windows() {
        let legacy = parse_rate_limits(json!({
            "rateLimits": {
                "primary": { "usedPercent": 25, "windowDurationMins": 300, "resetsAt": 42 },
                "secondary": null
            }
        }))
        .unwrap();
        assert_eq!(legacy.primary.unwrap().used_percent, 25);
        assert_eq!(legacy.secondary, None);

        let mapped = parse_rate_limits(json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": null,
                    "secondary": { "usedPercent": 60, "windowDurationMins": null, "resetsAt": null }
                }
            },
            "rateLimits": { "primary": { "usedPercent": 1 } }
        }))
        .unwrap();
        assert_eq!(mapped.primary, None);
        assert_eq!(mapped.secondary.unwrap().used_percent, 60);

        let empty = parse_rate_limits(json!({
            "rateLimits": { "primary": null, "secondary": null }
        }))
        .unwrap();
        assert_eq!(
            empty,
            CodexRateLimits {
                primary: None,
                secondary: None
            }
        );
        assert!(parse_rate_limits(json!({
            "rateLimits": { "primary": { "windowDurationMins": 300 } }
        }))
        .is_err());
    }

    #[test]
    fn handshake_returns_usage_lets_the_server_exit_and_reaps_descendants() {
        let marker = marker("cleanup");
        let (usage, stop) = run(
            fixture_command("handshake", &marker),
            Duration::from_secs(3),
            Duration::from_secs(3),
        );
        let usage = usage.unwrap();
        assert_eq!(usage.limits.unwrap().primary.unwrap().used_percent, 17);
        assert_eq!(
            usage.account,
            Some(CodexAccount {
                email: Some("dev@example.com".into()),
            })
        );
        assert!(
            matches!(stop, Some(AppServerStop::Exited { code: Some(0), .. })),
            "{stop:?}"
        );
        std::thread::sleep(Duration::from_millis(700));
        assert!(!marker.exists());
    }

    #[test]
    fn account_error_keeps_rate_limits() {
        let marker = marker("account-error");
        let usage = run(
            fixture_command("account-error", &marker),
            Duration::from_secs(3),
            Duration::from_secs(3),
        )
        .0
        .unwrap();
        assert_eq!(usage.account, None);
        assert_eq!(usage.limits.unwrap().primary.unwrap().used_percent, 17);
    }

    #[test]
    fn a_server_ignoring_closed_input_is_killed_after_the_grace_period() {
        let marker = marker("ignore-eof");
        let (usage, stop) = run(
            fixture_command("ignore-eof", &marker),
            Duration::from_secs(3),
            Duration::from_millis(200),
        );
        assert!(usage.is_ok());
        let Some(AppServerStop::Killed { after, confirmed }) = stop else {
            panic!("{stop:?}");
        };
        assert!(confirmed);
        assert!(after >= Duration::from_millis(200), "{after:?}");
        assert!(after < Duration::from_secs(2), "{after:?}");
    }

    #[test]
    fn a_timed_out_exchange_still_closes_input_so_the_server_exits() {
        let marker = marker("timeout");
        let (usage, stop) = run(
            fixture_command("timeout", &marker),
            Duration::from_millis(100),
            Duration::from_secs(3),
        );
        assert_eq!(usage.unwrap_err(), "Codex app server timed out");
        assert!(
            matches!(stop, Some(AppServerStop::Exited { code: Some(0), .. })),
            "{stop:?}"
        );
    }

    #[test]
    #[ignore = "subprocess fixture for codex app-server usage tests"]
    fn app_server_fixture() {
        let Some(mode) = std::env::var_os("SORENO_CODEX_USAGE_FIXTURE") else {
            return;
        };
        let marker = PathBuf::from(std::env::var_os("SORENO_CODEX_USAGE_MARKER").unwrap());
        if mode == "descendant" {
            std::thread::sleep(Duration::from_millis(500));
            fs::write(marker, b"survived").unwrap();
            return;
        }
        let mut input = BufReader::new(io::stdin());
        // Like `codex app-server`, the fixture exits once its input is closed.
        let drain = |input: &mut BufReader<io::Stdin>| {
            io::copy(input, &mut io::sink()).unwrap();
        };
        if mode == "timeout" {
            drain(&mut input);
            return;
        }

        let mut line = String::new();
        input.read_line(&mut line).unwrap();
        let initialize: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(initialize["id"], 1);
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(initialize["params"]["clientInfo"]["name"], "soreno");
        assert_eq!(
            initialize["params"]["clientInfo"]["version"],
            env!("CARGO_PKG_VERSION")
        );
        println!(r#"{{"id":1,"result":{{}}}}"#);
        io::stdout().flush().unwrap();

        line.clear();
        input.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(line.trim()).unwrap(),
            json!({ "method": "initialized" })
        );
        line.clear();
        input.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(line.trim()).unwrap(),
            json!({ "id": 2, "method": "account/read", "params": { "refreshToken": false } })
        );
        if mode == "account-error" {
            println!(r#"{{"id":2,"error":{{"code":-32601,"message":"unknown"}}}}"#);
        } else {
            println!(
                r#"{{"id":2,"result":{{"account":{{"type":"chatgpt","email":"dev@example.com","planType":"plus"}},"requiresOpenaiAuth":true}}}}"#
            );
        }
        io::stdout().flush().unwrap();
        line.clear();
        input.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(line.trim()).unwrap(),
            json!({ "id": 3, "method": "account/rateLimits/read", "params": null })
        );

        let mut descendant = fixture_command("descendant", &marker);
        descendant
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        descendant.spawn().unwrap();
        println!(
            r#"{{"id":3,"result":{{"rateLimits":{{"primary":{{"usedPercent":17}},"secondary":null}}}}}}"#
        );
        io::stdout().flush().unwrap();
        if mode == "ignore-eof" {
            std::thread::sleep(Duration::from_secs(30));
        } else {
            drain(&mut input);
        }
    }
}
