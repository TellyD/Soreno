use crate::{
    agent_sessions::AgentEnvironment,
    claude_code::{self, ClaudeRateLimits},
    codex_cli::{self, AppServerStop, CodexRateLimits, CodexUsage},
    ssh::SshConnection,
};
use serde::Serialize;
use std::path::Path;
#[cfg(windows)]
use std::process::Command;

// Login shell like agent sessions, so nvm/npm installs are on PATH.
const CODEX_APP_SERVER_SCRIPT: &str = r#"exec "${SHELL:-/bin/sh}" -ilc 'exec codex app-server'"#;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSource {
    pub key: String,
    pub kind: &'static str,
    pub label: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAccount<L> {
    pub id: String,
    pub email: Option<String>,
    pub sources: Vec<UsageSource>,
    pub limits: Option<L>,
}

enum SourceTarget {
    Local,
    #[cfg_attr(not(windows), allow(dead_code))]
    Wsl(String),
    Ssh(SshConnection),
}

struct SourceUsage<L> {
    source: UsageSource,
    identity: Option<String>,
    email: Option<String>,
    limits: Option<L>,
}

impl<L> SourceUsage<L> {
    fn unavailable(source: UsageSource) -> Self {
        Self {
            source,
            identity: None,
            email: None,
            limits: None,
        }
    }
}

fn usage_sources(environments: Vec<AgentEnvironment>) -> Vec<(UsageSource, SourceTarget)> {
    let mut sources = vec![(
        UsageSource {
            key: "local".into(),
            kind: "local",
            label: None,
        },
        SourceTarget::Local,
    )];
    for environment in environments {
        match (
            environment.kind.as_str(),
            environment.distribution,
            environment.ssh,
        ) {
            ("wsl", Some(distribution), _) => sources.push((
                UsageSource {
                    key: format!("wsl:{}", distribution.to_lowercase()),
                    kind: "wsl",
                    label: Some(distribution.clone()),
                },
                SourceTarget::Wsl(distribution),
            )),
            ("ssh", _, Some(connection)) => sources.push((
                UsageSource {
                    key: format!(
                        "ssh:{}@{}:{}",
                        connection.user.as_deref().unwrap_or(""),
                        connection.host,
                        connection
                            .port
                            .map(|port| port.to_string())
                            .unwrap_or_default()
                    ),
                    kind: "ssh",
                    label: Some(ssh_label(&connection)),
                },
                SourceTarget::Ssh(connection),
            )),
            _ => {}
        }
    }
    sources
}

fn ssh_label(connection: &SshConnection) -> String {
    let user = connection
        .user
        .as_deref()
        .map(|user| format!("{user}@"))
        .unwrap_or_default();
    match connection.port {
        Some(port) if connection.host.contains(':') => {
            format!("{user}[{}]:{port}", connection.host)
        }
        Some(port) => format!("{user}{}:{port}", connection.host),
        None => format!("{user}{}", connection.host),
    }
}

#[cfg(windows)]
pub(crate) fn wsl_command(distribution: &str, script: &str) -> Command {
    let mut command = Command::new("wsl.exe");
    command
        .args(["--distribution", distribution, "--exec", "sh", "-c", script])
        .env("WSLENV", crate::agent_sessions::host_wslenv())
        .env_remove("WSL_UTF8");
    command
}

fn codex_usage(target: &SourceTarget) -> (Result<CodexUsage, String>, Option<AppServerStop>) {
    match target {
        SourceTarget::Local => match codex_cli::local_app_server_command() {
            Ok(command) => codex_cli::read_usage(command),
            Err(error) => (Err(error), None),
        },
        #[cfg(windows)]
        SourceTarget::Wsl(distribution) => {
            codex_cli::read_usage(wsl_command(distribution, CODEX_APP_SERVER_SCRIPT))
        }
        #[cfg(not(windows))]
        SourceTarget::Wsl(_) => (
            Err("WSL est disponible uniquement sous Windows.".into()),
            None,
        ),
        SourceTarget::Ssh(connection) => {
            // Held until the probe process is gone so a disconnect waits for it.
            let _access = match crate::ssh::begin_access(connection) {
                Ok(access) => access,
                Err(error) => return (Err(error), None),
            };
            match crate::ssh::command(connection, CODEX_APP_SERVER_SCRIPT) {
                Ok(command) => codex_cli::read_usage(command),
                Err(error) => (Err(error), None),
            }
        }
    }
}

fn claude_output(target: &SourceTarget) -> Option<String> {
    match target {
        SourceTarget::Local => claude_code::local_usage_output(),
        #[cfg(windows)]
        SourceTarget::Wsl(distribution) => {
            claude_code::run_probe(&mut wsl_command(distribution, &claude_code::usage_script()))
        }
        #[cfg(not(windows))]
        SourceTarget::Wsl(_) => None,
        // The probe only reads: a dropped connection may retry it.
        SourceTarget::Ssh(connection) => crate::ssh::run_read_output_with_timeout(
            connection,
            &claude_code::usage_script(),
            None,
            claude_code::PROBE_OUTPUT_LIMIT,
            claude_code::PROBE_TIMEOUT,
        )
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok()),
    }
}

fn group_accounts<L>(
    entries: Vec<SourceUsage<L>>,
    rank: impl Fn(&L) -> u8,
) -> Vec<UsageAccount<L>> {
    let mut accounts: Vec<UsageAccount<L>> = Vec::new();
    for entry in entries {
        let id = match &entry.identity {
            Some(identity) => format!("account:{identity}"),
            None => format!("source:{}", entry.source.key),
        };
        let index = accounts
            .iter()
            .position(|account| account.id == id)
            .unwrap_or_else(|| {
                accounts.push(UsageAccount {
                    id,
                    email: None,
                    sources: Vec::new(),
                    limits: None,
                });
                accounts.len() - 1
            });
        let account = &mut accounts[index];
        account.sources.push(entry.source);
        if account.email.is_none() {
            account.email = entry.email;
        }
        let replace = match (&account.limits, &entry.limits) {
            (None, Some(_)) => true,
            (Some(current), Some(next)) => rank(next) > rank(current),
            _ => false,
        };
        if replace {
            account.limits = entry.limits;
        }
    }
    accounts
}

/// Logs how each app server stopped, to correlate with Windows LSASS crashes.
pub fn codex_accounts(
    environments: Vec<AgentEnvironment>,
    log: Option<&Path>,
) -> Vec<UsageAccount<CodexRateLimits>> {
    let sources = usage_sources(environments);
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = sources
            .iter()
            .map(|(source, target)| {
                scope.spawn(move || {
                    let (usage, stop) = codex_usage(target);
                    if let (Some(log), Some(stop)) = (log, &stop) {
                        let outcome = usage.as_ref().map_or_else(String::as_str, |_| "ok");
                        crate::log_file::append(
                            log,
                            &format!("source={} app-server {stop} usage={outcome}", source.key),
                        );
                    }
                    usage
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err("Codex usage task panicked".into()))
                    .ok()
            })
            .collect()
    });
    let entries = sources
        .into_iter()
        .zip(results)
        .filter_map(|((source, target), usage)| {
            let usage = usage.filter(|usage| usage.account.is_some() || usage.limits.is_some());
            let Some(usage) = usage else {
                return matches!(target, SourceTarget::Local)
                    .then(|| SourceUsage::unavailable(source));
            };
            let email = usage.account.and_then(|account| account.email);
            Some(SourceUsage {
                source,
                identity: email.as_deref().map(str::to_lowercase),
                email,
                limits: usage.limits,
            })
        })
        .collect();
    group_accounts(entries, |limits| {
        u8::from(limits.primary.is_some() || limits.secondary.is_some())
    })
}

fn claude_limits_rank(limits: &ClaudeRateLimits) -> u8 {
    match (limits.has_windows(), limits.stale) {
        (false, _) => 0,
        (true, true) => 1,
        (true, false) => 2,
    }
}

pub fn claude_accounts(environments: Vec<AgentEnvironment>) -> Vec<UsageAccount<ClaudeRateLimits>> {
    let sources = usage_sources(environments);
    let outputs: Vec<Option<String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = sources
            .iter()
            .map(|(_, target)| scope.spawn(move || claude_output(target)))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().ok().flatten())
            .collect()
    });
    let entries = sources
        .into_iter()
        .zip(outputs)
        .filter_map(|((source, target), output)| {
            let Some(usage) = claude_code::account_usage(&source.key, output.as_deref()) else {
                return matches!(target, SourceTarget::Local)
                    .then(|| SourceUsage::unavailable(source));
            };
            let profile = usage.profile;
            Some(SourceUsage {
                source,
                identity: profile.as_ref().map(|profile| profile.id.clone()),
                email: profile.as_ref().and_then(|profile| profile.email.clone()),
                limits: Some(usage.limits),
            })
        })
        .collect();
    group_accounts(entries, claude_limits_rank)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(host: &str, user: Option<&str>, port: Option<u16>) -> AgentEnvironment {
        AgentEnvironment {
            kind: "ssh".into(),
            distribution: None,
            ssh: Some(SshConnection {
                host: host.into(),
                user: user.map(Into::into),
                port,
                identity_file: None,
                host_key: None,
            }),
        }
    }

    fn source(key: &str, kind: &'static str, label: Option<&str>) -> UsageSource {
        UsageSource {
            key: key.into(),
            kind,
            label: label.map(Into::into),
        }
    }

    #[test]
    fn blocked_ssh_source_is_not_probed_for_codex() {
        let _relay_guard = crate::ssh::RELAY_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let connection = SshConnection {
            host: "blocked-codex-usage.test".into(),
            user: None,
            port: None,
            identity_file: None,
            host_key: None,
        };
        crate::ssh::block(&connection);
        let (result, stop) = codex_usage(&SourceTarget::Ssh(connection.clone()));
        crate::ssh::unblock(&connection);
        assert!(result.unwrap_err().contains("bloquée"));
        assert_eq!(stop, None);
    }

    #[test]
    fn usage_sources_start_local_and_label_remote_targets() {
        let sources: Vec<UsageSource> = usage_sources(vec![
            ssh("::1", Some("me"), Some(2222)),
            AgentEnvironment {
                kind: "docker".into(),
                distribution: Some("ignored".into()),
                ssh: None,
            },
            ssh("h", None, None),
        ])
        .into_iter()
        .map(|(source, _)| source)
        .collect();
        assert_eq!(
            sources,
            vec![
                source("local", "local", None),
                source("ssh:me@::1:2222", "ssh", Some("me@[::1]:2222")),
                source("ssh:@h:", "ssh", Some("h")),
            ]
        );
    }

    #[test]
    fn group_accounts_merges_identities_and_prefers_windows() {
        let local = source("local", "local", None);
        let remote = source("ssh:@h:", "ssh", Some("h"));
        let wsl = source("wsl:ubuntu", "wsl", Some("Ubuntu"));
        let accounts = group_accounts(
            vec![
                SourceUsage {
                    source: local.clone(),
                    identity: Some("a@x.com".into()),
                    email: None,
                    limits: Some(("local", false)),
                },
                SourceUsage::unavailable(wsl.clone()),
                SourceUsage {
                    source: remote.clone(),
                    identity: Some("a@x.com".into()),
                    email: Some("A@x.com".into()),
                    limits: Some(("ssh", true)),
                },
            ],
            |limits| u8::from(limits.1),
        );
        assert_eq!(
            accounts,
            vec![
                UsageAccount {
                    id: "account:a@x.com".into(),
                    email: Some("A@x.com".into()),
                    sources: vec![local, remote],
                    limits: Some(("ssh", true)),
                },
                UsageAccount {
                    id: "source:wsl:ubuntu".into(),
                    email: None,
                    sources: vec![wsl],
                    limits: None,
                },
            ]
        );
    }

    #[test]
    fn group_accounts_prefers_fresh_claude_limits_over_stale() {
        let limits = |used_percent, stale| ClaudeRateLimits {
            primary: Some(claude_code::ClaudeRateLimitWindow {
                used_percent,
                window_duration_mins: 300,
                resets_at: None,
            }),
            secondary: None,
            models: Vec::new(),
            stale,
            expired: stale,
        };
        let entry = |key: &str, limits: ClaudeRateLimits| SourceUsage {
            source: source(key, "ssh", Some(key)),
            identity: Some("a@x.com".into()),
            email: None,
            limits: Some(limits),
        };
        for entries in [
            vec![
                entry("stale", limits(90, true)),
                entry("fresh", limits(10, false)),
            ],
            vec![
                entry("fresh", limits(10, false)),
                entry("stale", limits(90, true)),
            ],
        ] {
            let accounts = group_accounts(entries, claude_limits_rank);
            assert_eq!(accounts.len(), 1);
            assert_eq!(accounts[0].limits, Some(limits(10, false)));
        }
    }
}
