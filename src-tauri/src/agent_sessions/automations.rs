//! Agent runs scheduled on an SSH server by a systemd user timer; the desktop attaches later.
use super::{
    conversations, environment_dormant, get, groups, id, list, lock,
    posix_command_in_with_environment, project_disconnected, remote_dtach, remote_host,
    require_project, require_session, wake_project, AgentProject, AgentSession, AgentSessions,
    Result,
};
use crate::ssh::{quote, SshConnection};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 64 * 1024;
const PROMPT_LIMIT: usize = 16 * 1024;
const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
pub(crate) const HAS_AUTOMATION: &str =
    "[Session/hasAutomation]\nSupprimez d’abord l’automatisation de cette session.";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAutomationInput {
    pub session_id: String,
    pub prompt: String,
    /// `daily`, `weekdays` or `weekly`.
    pub frequency: String,
    /// 1 (Monday) to 7 (Sunday); read for `weekly` only.
    pub weekday: u8,
    /// `HH:MM`, in `time_zone`.
    pub time: String,
    /// IANA name, appended to systemd's `OnCalendar`.
    pub time_zone: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAutomationRun {
    /// Unix seconds, on the server's clock.
    pub at: u64,
    /// `started`, `skipped` (a run of the session still lived) or `failed` (not launched).
    pub outcome: String,
    pub exit_code: Option<i32>,
    /// The started run still lives on the server.
    pub running: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAutomation {
    #[serde(flatten)]
    pub input: AgentAutomationInput,
    pub last_run: Option<AgentAutomationRun>,
    pub seen_run_at: Option<u64>,
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute(
        "CREATE TABLE IF NOT EXISTS agent_automations (id TEXT PRIMARY KEY REFERENCES agent_sessions(id), data TEXT NOT NULL)",
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Deleting a session must not orphan its timer on the server.
pub(super) fn ensure_none(db: &Connection, session_ids: &[&str]) -> Result<()> {
    for session_id in session_ids {
        if get::<AgentAutomation>(db, "agent_automations", session_id)?.is_some() {
            return Err(HAS_AUTOMATION.into());
        }
    }
    Ok(())
}

fn put(db: &Connection, automation: &AgentAutomation) -> Result<()> {
    db.execute(
        "INSERT INTO agent_automations(id,data) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params![
            automation.input.session_id,
            serde_json::to_string(automation).map_err(|error| error.to_string())?
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn require(db: &Connection, session_id: &str) -> Result<AgentAutomation> {
    get(db, "agent_automations", session_id)?.ok_or("Automatisation introuvable.".into())
}

fn validate(input: &AgentAutomationInput) -> Result<()> {
    id(&input.session_id)?;
    let prompt = input.prompt.trim();
    if prompt.is_empty() || input.prompt.len() > PROMPT_LIMIT || input.prompt.contains('\0') {
        return Err("Le prompt est requis (16 Kio maximum, sans caractère nul).".into());
    }
    if !matches!(input.frequency.as_str(), "daily" | "weekdays" | "weekly")
        || !(1..=7).contains(&input.weekday)
    {
        return Err("Fréquence invalide.".into());
    }
    let time = input.time.as_bytes();
    let valid_time = time.len() == 5
        && time[2] == b':'
        && input.time[..2].parse::<u8>().is_ok_and(|hour| hour < 24)
        && input.time[3..]
            .parse::<u8>()
            .is_ok_and(|minute| minute < 60)
        && time
            .iter()
            .enumerate()
            .all(|(i, byte)| i == 2 || byte.is_ascii_digit());
    if !valid_time {
        return Err("Heure invalide (HH:MM).".into());
    }
    let zone = &input.time_zone;
    if zone.is_empty()
        || zone.len() > 64
        || zone.starts_with('/')
        || zone.contains("..")
        || !zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_+-/".contains(&byte))
    {
        return Err("Fuseau horaire invalide.".into());
    }
    Ok(())
}

fn on_calendar(input: &AgentAutomationInput) -> String {
    let days = match input.frequency.as_str() {
        "weekdays" => "Mon..Fri ".to_owned(),
        "weekly" => format!("{} ", DAYS[usize::from(input.weekday - 1)]),
        _ => String::new(),
    };
    format!("{days}*-*-* {}:00 {}", input.time, input.time_zone)
}

/// systemd expands `%` specifiers and stops a value at a line break.
fn unit_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect::<String>()
        .replace('%', "%%")
}

/// The agent's own command with the prompt as its first message, as `PreparedLaunch` sends it.
fn launch_command(project: &AgentProject, session: &AgentSession, prompt: &str) -> Result<String> {
    let directory = session
        .working_directory
        .as_deref()
        .unwrap_or(&project.path);
    crate::ssh::validate_path(directory)?;
    let mut launch = session.clone();
    if !launch.args.iter().any(|arg| arg == "--") {
        launch.args.push("--".into());
    }
    launch.args.push(prompt.into());
    super::validate_launch_args(launch.args.iter().map(String::as_str))?;
    Ok(posix_command_in_with_environment(
        directory,
        &launch,
        &[],
        None,
    ))
}

// shortcut: members are read at save, so a later group change reaches the timer once the automation is saved again.
// shortcut: the 256-argument launch limit counts the members' `--add-dir`, so a group of 127+ repositories cannot be scheduled; validate the user's args alone if such groups appear.
fn scheduled_session(
    db: &Connection,
    project: &AgentProject,
    session: &AgentSession,
) -> Result<Option<AgentSession>> {
    let (Some(group), Some(provider)) = (
        groups::group_by_group_project(db, &project.id)?,
        conversations::provider(&session.executable),
    ) else {
        return Ok(None);
    };
    conversations::validate_group_args(&session.args)?;
    let mut launch = session.clone();
    groups::add_launch_args(
        &mut launch.args,
        provider,
        &group.name,
        &groups::group_members(db, &group)?,
        false,
    );
    Ok(Some(launch))
}

fn label(project: &AgentProject, session: &AgentSession) -> String {
    format!("{} · {}", project.name, session.display_name())
}

fn names(session_id: &str) -> (String, String) {
    let key = remote_host::key(session_id);
    (format!("soreno-automation-{key}"), key)
}

/// Exits 31 without a systemd user manager, 32 on files, 33 without lingering, 34 on systemd.
const SYSTEMD: &str = r#"[ -d /run/systemd/system ] || exit 31
case "$(systemctl --user show -p Version 2>/dev/null)" in Version=?*) ;; *) exit 31 ;; esac
base="$HOME/.config/soreno/automations"
units="$HOME/.config/systemd/user"
(umask 077 && mkdir -p -- "$base" "$units") || exit 32
"#;

/// The dtach the desktop last ensured: scheduled runs follow its updates.
fn dtach_line(dtach: &str) -> String {
    format!(
        "printf '%s\\n' {} > \"$base/dtach.tmp\" && mv -f -- \"$base/dtach.tmp\" \"$base/dtach\" || exit 32\n",
        quote(dtach)
    )
}

fn run_script(project: &AgentProject, session: &AgentSession, prompt: &str) -> Result<String> {
    let (_, key) = names(&session.id);
    let inner = launch_command(project, session, prompt)?;
    // The TUI gets a terminal type as over SSH; the login shell of the wrapper sets PATH.
    Ok(format!(
        r#"#!/bin/sh
a="$HOME/.config/soreno/automations/{key}"
now=$(date +%s)
dtach=
IFS= read -r dtach 2>/dev/null < "$HOME/.config/soreno/automations/dtach"
if [ ! -x "$dtach" ]; then printf '%s failed 127\n' "$now" > "$a/last"; exit 1; fi
export TERM=xterm-256color
( {} )
code=$?
case "$code" in
  0) printf '%s started\n' "$now" > "$a/last" ;;
  75) printf '%s skipped\n' "$now" > "$a/last" ;;
  *) printf '%s failed %s\n' "$now" "$code" > "$a/last" ;;
esac
exit 0
"#,
        remote_host::scheduled_script(&session.id, &label(project, session), &inner)
    ))
}

fn install_script(
    project: &AgentProject,
    session: &AgentSession,
    input: &AgentAutomationInput,
    dtach: &str,
) -> Result<String> {
    let (unit, key) = names(&session.id);
    let description = unit_text(&format!("Soreno · {}", label(project, session)));
    let service = format!(
        "[Unit]\nDescription={description}\n\n[Service]\nType=oneshot\nExecStart=/bin/sh %h/.config/soreno/automations/{key}/run\n# The detached session outlives this oneshot run.\nKillMode=process\n"
    );
    let timer = format!(
        "[Unit]\nDescription={description}\n\n[Timer]\nOnCalendar={}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n",
        on_calendar(input)
    );
    let activation = if input.enabled {
        format!("systemctl --user enable {unit}.timer >/dev/null 2>&1 && systemctl --user restart {unit}.timer >/dev/null 2>&1 || exit 34")
    } else {
        format!("systemctl --user disable --now {unit}.timer >/dev/null 2>&1 || exit 34")
    };
    Ok(format!(
        r#"set -u
{SYSTEMD}a="$base/{key}"
(umask 077 && mkdir -p -- "$a") || exit 32
{}printf '%s' {} > "$a/run.tmp" && chmod 700 "$a/run.tmp" && mv -f -- "$a/run.tmp" "$a/run" || exit 32
printf '%s' {} > "$units/{unit}.service" || exit 32
printf '%s' {} > "$units/{unit}.timer" || exit 32
if [ "$(loginctl show-user "$(id -u)" -p Linger 2>/dev/null)" != Linger=yes ]; then
  command -v loginctl >/dev/null 2>&1 && loginctl enable-linger >/dev/null 2>&1 || exit 33
fi
systemctl --user daemon-reload >/dev/null 2>&1 || exit 34
{activation}
"#,
        dtach_line(dtach),
        quote(&run_script(project, session, &input.prompt)?),
        quote(&service),
        quote(&timer),
    ))
}

// Leaves a live run alone: it is the user's session, which they stop from Soreno.
fn remove_script(session_id: &str) -> String {
    let (unit, key) = names(session_id);
    format!(
        r#"units="$HOME/.config/systemd/user"
if [ -f "$units/{unit}.timer" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now {unit}.timer >/dev/null 2>&1 || exit 34
fi
rm -f -- "$units/{unit}.timer" "$units/{unit}.service" && rm -rf -- "$HOME/.config/soreno/automations/{key}" || exit 32
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1
exit 0
"#
    )
}

fn run_now_script(session_id: &str, dtach: &str) -> String {
    let (unit, _) = names(session_id);
    format!(
        r#"set -u
{SYSTEMD}[ -f "$units/{unit}.service" ] || exit 35
{}systemctl --user start {unit}.service >/dev/null 2>&1 || exit 34
"#,
        dtach_line(dtach)
    )
}

/// One line per session: key, probe, the ended run's status, the `last` record.
fn state_script(session_ids: &[&str]) -> String {
    let mut script = String::new();
    for session_id in session_ids {
        let key = remote_host::key(session_id);
        script.push_str(&format!(
            r#"printf '%s\t%s\t' {key} "$( ( {} ) )"
s=; IFS= read -r s 2>/dev/null < "$HOME/.cache/soreno/sessions/{key}/status"
l=; IFS= read -r l 2>/dev/null < "$HOME/.config/soreno/automations/{key}/last"
printf '%s\t%s\n' "$s" "$l"
"#,
            remote_host::probe_body(remote_host::TERMINALS, session_id)
        ));
    }
    script
}

// shortcut: an attached run that ends has its directory, status included, removed by the attach `TAIL`,
// so it reads `finished` whatever its code; keep the code beside `last` if failures seen live must show.
fn parse_state(output: &[u8]) -> Vec<(String, AgentAutomationRun)> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let key = fields.next()?.to_owned();
            // shortcut: `inspection_error` (no usable `ps`) reads as not live, so a run shows finished; keep
            // the last state on that answer if servers without `ps` show up — sessions cannot start there either.
            let live = fields.next()? == "live";
            let status = fields.next()?.trim().parse::<i32>().ok();
            let mut last = fields.next()?.split_whitespace();
            let at = last.next()?.parse::<u64>().ok()?;
            let outcome = last.next()?;
            if !matches!(outcome, "started" | "skipped" | "failed") {
                return None;
            }
            let failure = last.next().and_then(|code| code.parse::<i32>().ok());
            let started = outcome == "started";
            Some((
                key,
                AgentAutomationRun {
                    at,
                    outcome: outcome.into(),
                    exit_code: if started && !live { status } else { failure },
                    running: started && live,
                },
            ))
        })
        .collect()
}

fn failure(status: u8, stderr: &[u8]) -> String {
    match status {
        31 => "systemd utilisateur est indisponible pour ce compte : les automatisations exigent un serveur Linux dont systemd est l’init, avec `systemctl --user` fonctionnel.".into(),
        32 => "Impossible d’écrire les fichiers de l’automatisation sur le serveur (`~/.config/soreno/automations`, `~/.config/systemd/user`).".into(),
        33 => "Impossible de maintenir les minuteurs après déconnexion : faites lancer `sudo loginctl enable-linger $USER` sur le serveur par un administrateur.".into(),
        34 => "systemd a refusé le minuteur de l’automatisation : consultez `systemctl --user status 'soreno-automation-*'` sur le serveur.".into(),
        35 => "Cette automatisation est absente du serveur : enregistrez-la de nouveau.".into(),
        _ => format!(
            "Connexion ou commande SSH échouée : {}",
            String::from_utf8_lossy(stderr).trim()
        ),
    }
}

fn run(connection: &SshConnection, script: &str) -> Result<Vec<u8>> {
    let output =
        crate::ssh::run_output_with_timeout(connection, script, None, OUTPUT_LIMIT, TIMEOUT)?;
    if output.status == 0 {
        Ok(output.stdout)
    } else {
        Err(failure(output.status, &output.stderr))
    }
}

/// The scheduled session's project, its SSH server reached even when dormant: the user asked.
struct Target {
    project: AgentProject,
    session: AgentSession,
    connection: SshConnection,
}

impl AgentSessions {
    pub fn automations(&self) -> Result<Vec<AgentAutomation>> {
        list(&lock(&self.store)?.db, "agent_automations")
    }

    // shortcut: no `git_busy` check, so a save during a worktree removal targets the removed folder and
    // keeps its project; refuse while a Git lease is held if that removal flow grows common.
    fn automation_target(&self, session_id: &str) -> Result<Target> {
        let mut store = lock(&self.store)?;
        let session = require_session(&store, session_id)?;
        let project = require_project(&store, &session.project_id)?;
        if project_disconnected(&store.db, &project.id)? {
            return Err(
                "Ce projet SSH est déconnecté. Reconnectez-le avant cette opération.".into(),
            );
        }
        let connection = project
            .environment
            .ssh
            .clone()
            .filter(|_| project.environment.kind == "ssh")
            .ok_or("Les automatisations sont réservées aux projets SSH.")?;
        wake_project(&mut store, &project.id)?;
        Ok(Target {
            project,
            session,
            connection,
        })
    }

    pub fn save_automation(&self, input: AgentAutomationInput) -> Result<AgentAutomation> {
        validate(&input)?;
        let _connection_change = lock(&self.connection_changes)?;
        let target = self.automation_target(&input.session_id)?;
        if target.session.kind != "terminal"
            || conversations::provider(&target.session.executable).is_none()
        {
            return Err("Une automatisation lance un agent intégré (Claude Code, Codex, Pi ou OMP) dans un terminal.".into());
        }
        let dtach = remote_dtach::ensure(&target.connection)?;
        let group_session =
            scheduled_session(&lock(&self.store)?.db, &target.project, &target.session)?;
        if group_session.is_some() {
            groups::create_group_directory(&target.project.environment, &target.project.path)?;
        }
        let launch = group_session.as_ref().unwrap_or(&target.session);
        let script = install_script(&target.project, launch, &input, &dtach)?;
        let (automation, created) = {
            let store = lock(&self.store)?;
            let previous =
                get::<AgentAutomation>(&store.db, "agent_automations", &input.session_id)?;
            let created = previous.is_none();
            let automation = AgentAutomation {
                input,
                last_run: previous.as_ref().and_then(|value| value.last_run.clone()),
                seen_run_at: previous.and_then(|value| value.seen_run_at),
            };
            // Written before the timer is enabled: a lost SSH reply must not leave it invisible.
            if created {
                put(&store.db, &automation)?;
            }
            (automation, created)
        };
        let session_id = &automation.input.session_id;
        // shortcut: a kept row after a failed install and removal only returns the error, so the open view
        // lists it once reloaded; return the kept automation if such creations must show at once.
        if let Err(error) = run(&target.connection, &script) {
            if created {
                let _ = self.forget_failed_creation(session_id, || {
                    run(&target.connection, &remove_script(session_id))
                });
            }
            return Err(error);
        }
        // shortcut: an edit rewrites the `seen_run_at` read before the SSH call, so a run marked seen meanwhile
        // turns unread again; the panel disables opening while saving, re-read it here if another caller marks runs.
        if !created {
            put(&lock(&self.store)?.db, &automation)?;
        }
        Ok(automation)
    }

    /// Keeps the row, so the timer stays deletable from Soreno, unless its removal succeeded.
    fn forget_failed_creation(
        &self,
        session_id: &str,
        remove: impl FnOnce() -> Result<Vec<u8>>,
    ) -> Result<()> {
        remove()?;
        lock(&self.store)?
            .db
            .execute("DELETE FROM agent_automations WHERE id=?1", [session_id])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// A disconnected project only forgets it here, as deleting its sessions does.
    pub fn delete_automation(&self, session_id: &str) -> Result<()> {
        id(session_id)?;
        let _connection_change = lock(&self.connection_changes)?;
        let disconnected = {
            let store = lock(&self.store)?;
            require(&store.db, session_id)?;
            let session = require_session(&store, session_id)?;
            project_disconnected(&store.db, &session.project_id)?
        };
        if !disconnected {
            let target = self.automation_target(session_id)?;
            run(&target.connection, &remove_script(session_id))?;
        }
        lock(&self.store)?
            .db
            .execute("DELETE FROM agent_automations WHERE id=?1", [session_id])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn run_automation(&self, session_id: &str) -> Result<AgentAutomation> {
        id(session_id)?;
        let _connection_change = lock(&self.connection_changes)?;
        require(&lock(&self.store)?.db, session_id)?;
        let target = self.automation_target(session_id)?;
        let dtach = remote_dtach::ensure(&target.connection)?;
        run(&target.connection, &run_now_script(session_id, &dtach))?;
        self.read_states(&target.connection, &[session_id])?;
        require(&lock(&self.store)?.db, session_id)
    }

    /// Reads the last runs of the project's automations; a dormant server is never reached.
    pub fn refresh_automations(&self, project_id: &str) -> Result<Vec<AgentAutomation>> {
        id(project_id)?;
        let _connection_change = lock(&self.connection_changes)?;
        let (connection, session_ids) = {
            let store = lock(&self.store)?;
            let project = require_project(&store, project_id)?;
            let connection = project.environment.ssh.clone().filter(|_| {
                project.environment.kind == "ssh"
                    && !environment_dormant(&store, &project.environment)
            });
            let session_ids = list::<AgentAutomation>(&store.db, "agent_automations")?
                .into_iter()
                .map(|automation| automation.input.session_id)
                .filter(|session_id| {
                    require_session(&store, session_id)
                        .is_ok_and(|session| session.project_id == project_id)
                })
                .collect::<Vec<_>>();
            let connection = match connection {
                Some(connection) if !project_disconnected(&store.db, project_id)? => {
                    Some(connection)
                }
                _ => None,
            };
            (connection, session_ids)
        };
        if let Some(connection) = connection.filter(|_| !session_ids.is_empty()) {
            let ids = session_ids.iter().map(String::as_str).collect::<Vec<_>>();
            self.read_states(&connection, &ids)?;
        }
        self.automations()
    }

    fn read_states(&self, connection: &SshConnection, session_ids: &[&str]) -> Result<()> {
        let states = parse_state(&run(connection, &state_script(session_ids))?);
        let store = lock(&self.store)?;
        for session_id in session_ids {
            let key = remote_host::key(session_id);
            let Some((_, run)) = states.iter().find(|(found, _)| *found == key) else {
                continue;
            };
            let Some(mut automation) =
                get::<AgentAutomation>(&store.db, "agent_automations", session_id)?
            else {
                continue;
            };
            automation.last_run = Some(run.clone());
            put(&store.db, &automation)?;
        }
        Ok(())
    }

    pub fn mark_automation_seen(&self, session_id: &str) -> Result<AgentAutomation> {
        id(session_id)?;
        let store = lock(&self.store)?;
        let mut automation = require(&store.db, session_id)?;
        automation.seen_run_at = automation.last_run.as_ref().map(|run| run.at);
        put(&store.db, &automation)?;
        Ok(automation)
    }
}

#[cfg(test)]
#[path = "automations_tests.rs"]
mod tests;
