use crate::codex_cli::{
    cli_command, hidden_command, home_dir,
    process::{run_command, run_command_output},
    shell_candidates,
};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{LazyLock, Mutex},
    time::Duration,
};

const DETECTION_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(45);
pub(crate) const PROBE_OUTPUT_LIMIT: usize = 512 * 1024;
// Soreno never reads Claude credentials: the official binary reports its own account and usage.
const AUTH_ARGS: [&str; 3] = ["auth", "status", "--json"];
const USAGE_ARGS: [&str; 9] = [
    "-p",
    "/usage",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--settings",
    r#"{"disableAllHooks":true,"remoteControlAtStartup":false}"#,
];

static LAST_USAGE: LazyLock<Mutex<HashMap<String, ClaudeAccountUsage>>> =
    LazyLock::new(Default::default);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRateLimits {
    pub primary: Option<ClaudeRateLimitWindow>,
    pub secondary: Option<ClaudeRateLimitWindow>,
    pub models: Vec<ClaudeModelRateLimit>,
    pub stale: bool,
    pub expired: bool,
}

impl ClaudeRateLimits {
    pub fn has_windows(&self) -> bool {
        self.primary.is_some() || self.secondary.is_some() || !self.models.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRateLimitWindow {
    pub used_percent: i32,
    pub window_duration_mins: i64,
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelRateLimit {
    pub model: String,
    pub window: ClaudeRateLimitWindow,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeProfile {
    pub id: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeAccountUsage {
    pub profile: Option<ClaudeProfile>,
    pub limits: ClaudeRateLimits,
}

#[derive(Debug, Default, PartialEq)]
struct Probe {
    profile: Option<ClaudeProfile>,
    limits: Option<ClaudeRateLimits>,
    signed_out: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    logged_in: bool,
    email: Option<String>,
    org_id: Option<String>,
}

#[derive(Deserialize)]
struct UsageRow {
    kind: String,
    percent: f64,
    resets_at: Option<String>,
    scope: Option<UsageScope>,
}

#[derive(Deserialize)]
struct UsageScope {
    model: Option<DisplayName>,
}

#[derive(Deserialize)]
struct DisplayName {
    display_name: String,
}

/// `None` when Claude Code is not installed.
pub fn local_usage_output() -> Option<String> {
    let binary = find_claude_binary()?;
    let probe = |args: &[&str]| {
        let mut command = cli_command(&binary);
        command.args(args);
        if let Some(home) = home_dir() {
            command.current_dir(home);
        }
        run_probe(&mut command)
    };
    let auth = probe(&AUTH_ARGS)?;
    if parse_probe(&auth).signed_out {
        return Some(auth);
    }
    Some(auth + "\n" + &probe(&USAGE_ARGS).unwrap_or_default())
}

/// Runs in the login shell like agent sessions, so nvm/npm installs are on PATH.
pub(crate) fn usage_script() -> String {
    let usage = USAGE_ARGS.map(crate::ssh::quote).join(" ");
    let inner = format!(
        "claude {} || exit 0; exec claude {usage}",
        AUTH_ARGS.join(" ")
    );
    crate::ssh::login_shell_script(&inner)
}

/// Stdout even on a failed exit: `auth status` exits non-zero when signed out.
pub(crate) fn run_probe(command: &mut Command) -> Option<String> {
    run_command_output(command, PROBE_TIMEOUT, true, PROBE_OUTPUT_LIMIT as u64)
        .ok()
        .map(|output| output.stdout)
}

/// A failed probe falls back to the source's last reading, marked stale.
pub fn account_usage(source_key: &str, output: Option<&str>) -> Option<ClaudeAccountUsage> {
    let probe = output.map(parse_probe).unwrap_or_default();
    let Ok(mut last) = LAST_USAGE.lock() else {
        return None;
    };
    if let Some(profile) = &probe.profile {
        let cached_id = last
            .get(source_key)
            .map(|previous| previous.profile.as_ref().map(|cached| cached.id.as_str()));
        if cached_id.is_some_and(|id| id != Some(profile.id.as_str())) {
            last.remove(source_key);
        }
    }
    let previous = last.get(source_key).cloned().map(|mut usage| {
        if probe.profile.is_some() {
            usage.profile = probe.profile.clone();
        }
        usage
    });
    let stale = |expired| {
        previous.clone().map(|mut usage| {
            usage.limits.stale = true;
            usage.limits.expired = expired;
            usage
        })
    };
    if probe.signed_out {
        return stale(true).or_else(|| {
            Some(ClaudeAccountUsage {
                profile: probe.profile,
                limits: ClaudeRateLimits {
                    expired: true,
                    ..empty_limits()
                },
            })
        });
    }
    match probe.limits {
        Some(limits) if limits.has_windows() => {
            let usage = ClaudeAccountUsage {
                profile: probe.profile,
                limits,
            };
            last.insert(source_key.to_owned(), usage.clone());
            Some(usage)
        }
        Some(limits) => {
            last.remove(source_key);
            Some(ClaudeAccountUsage {
                profile: probe.profile,
                limits,
            })
        }
        None => stale(false).or_else(|| {
            probe.profile.map(|profile| ClaudeAccountUsage {
                profile: Some(profile),
                limits: empty_limits(),
            })
        }),
    }
}

fn parse_probe(output: &str) -> Probe {
    let mut probe = Probe::default();
    for value in json_objects(output) {
        if value.get("loggedIn").is_some() {
            match serde_json::from_value::<AuthStatus>(value) {
                Ok(status) if status.logged_in => probe.profile = profile(status),
                Ok(_) => probe.signed_out = true,
                Err(_) => {}
            }
        } else if value.get("type").and_then(Value::as_str) == Some("assistant") {
            if value.get("error").and_then(Value::as_str) == Some("authentication_failed") {
                probe.signed_out = true;
            }
            if let Some(rows) = value.pointer("/usage_report/rate_limits/limits") {
                if let Ok(rows) = serde_json::from_value::<Vec<UsageRow>>(rows.clone()) {
                    probe.limits = Some(limits_from_rows(rows));
                }
            }
        }
    }
    probe
}

// A login shell may print banners around the JSON: skip lines that do not start an object.
fn json_objects(output: &str) -> Vec<Value> {
    let mut objects = Vec::new();
    let mut rest = output;
    while !rest.is_empty() {
        let line_end = rest.find('\n').map_or(rest.len(), |index| index + 1);
        if rest[..line_end].trim_start().starts_with('{') {
            let mut stream = serde_json::Deserializer::from_str(rest).into_iter::<Value>();
            if let Some(Ok(value)) = stream.next() {
                objects.push(value);
                rest = &rest[stream.byte_offset()..];
                continue;
            }
        }
        rest = &rest[line_end..];
    }
    objects
}

fn profile(status: AuthStatus) -> Option<ClaudeProfile> {
    let email = status.email.filter(|email| !email.is_empty());
    let org = status.org_id.filter(|org| !org.is_empty());
    // Quotas belong to a member of an organization: one email can have several.
    let id = match (&org, &email) {
        (Some(org), Some(email)) => format!("{org}:{}", email.to_lowercase()),
        (None, Some(email)) => email.to_lowercase(),
        (Some(org), None) => org.clone(),
        (None, None) => return None,
    };
    Some(ClaudeProfile { id, email })
}

// Rows are classified on `kind`, as documented; labels are display-only.
fn limits_from_rows(rows: Vec<UsageRow>) -> ClaudeRateLimits {
    let mut limits = empty_limits();
    for row in rows {
        let duration = if row.kind == "session" { 300 } else { 10_080 };
        let Some(window) = map_window(&row, duration) else {
            continue;
        };
        match row.kind.as_str() {
            "session" => limits.primary = Some(window),
            "weekly_all" => limits.secondary = Some(window),
            "weekly_scoped" => {
                if let Some(model) = row.scope.and_then(|scope| scope.model) {
                    limits.models.push(ClaudeModelRateLimit {
                        model: model.display_name,
                        window,
                    });
                }
            }
            _ => {}
        }
    }
    limits
        .models
        .sort_by(|left, right| left.model.cmp(&right.model));
    limits
}

fn map_window(row: &UsageRow, duration: i64) -> Option<ClaudeRateLimitWindow> {
    if !row.percent.is_finite() {
        return None;
    }
    Some(ClaudeRateLimitWindow {
        used_percent: row.percent.clamp(0.0, 100.0).round() as i32,
        window_duration_mins: duration,
        resets_at: row
            .resets_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|date| date.timestamp()),
    })
}

fn empty_limits() -> ClaudeRateLimits {
    ClaudeRateLimits {
        primary: None,
        secondary: None,
        models: Vec::new(),
        stale: false,
        expired: false,
    }
}

fn find_claude_binary() -> Option<PathBuf> {
    find_claude_binary_with(
        cfg!(windows),
        shell_candidates(),
        claude_binary_candidates(),
        |command| run_command(command, DETECTION_TIMEOUT, true).ok(),
    )
}

fn find_claude_binary_with(
    windows: bool,
    shells: Vec<PathBuf>,
    candidates: Vec<PathBuf>,
    mut run_lookup: impl FnMut(&mut Command) -> Option<String>,
) -> Option<PathBuf> {
    let lookup = if windows { "where" } else { "which" };
    if let Some(path) = run_lookup(hidden_command(lookup).arg("claude"))
        .and_then(|output| first_executable_path(&output, windows))
    {
        return Some(path);
    }

    if !windows {
        for shell in shells.into_iter().filter(|shell| shell.exists()) {
            if let Some(path) = run_lookup(hidden_command(shell).args(["-lc", "command -v claude"]))
                .and_then(|output| first_executable_path(&output, false))
            {
                return Some(path);
            }
        }
    }

    candidates
        .into_iter()
        .find(|path| is_executable_file(path, windows))
}

fn first_executable_path(output: &str, windows: bool) -> Option<PathBuf> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| is_executable_file(path, windows))
}

fn is_executable_file(path: &Path, windows: bool) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    if windows {
        return matches!(
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("exe" | "cmd" | "bat")
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn claude_binary_candidates() -> Vec<PathBuf> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let mut candidates = [
        ".local/bin/claude",
        ".local/bin/claude.exe",
        ".local/bin/claude.cmd",
        ".claude/local/claude",
        ".npm-global/bin/claude",
        ".npm-global/bin/claude.cmd",
        ".npm/bin/claude",
        ".npm/bin/claude.cmd",
        ".bun/bin/claude",
        "AppData/Roaming/npm/claude.cmd",
        "AppData/Roaming/npm/claude.exe",
    ]
    .into_iter()
    .map(|path| home.join(path))
    .chain([
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ])
    .collect::<Vec<_>>();

    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut nvm = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("bin/claude"))
            .collect::<Vec<_>>();
        nvm.sort();
        candidates.extend(nvm);
    }
    candidates
}

#[cfg(test)]
#[path = "claude_code_tests.rs"]
mod tests;
