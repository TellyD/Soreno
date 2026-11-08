//! Launch directories hold a run's sidecar, hooks, Pi/OMP bridge and OMP config. Resume and crash
//! recovery only read the latest run of each session, the one its record names; on a server, the
//! directory of a live dtach session also feeds mobile access. Any other directory is purged once
//! nothing in it changed for `RETENTION_DAYS`, which covers launches in progress and other Soreno
//! instances sharing the profile or the server.
use super::{get, ConversationRecord, Result};
use crate::ssh::SshConnection;
use rusqlite::Connection;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const RETENTION_DAYS: u64 = 7;
const RETENTION: Duration = Duration::from_secs(RETENTION_DAYS * 24 * 60 * 60);
const PURGE_LIMIT: u32 = 100;

fn records(db: &Connection) -> Result<Vec<ConversationRecord>> {
    let mut statement = db
        .prepare("SELECT data FROM agent_conversations")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|data| {
        serde_json::from_str(&data.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })
    .collect()
}

/// An unreadable record names no directory; it must never block deleting its session.
fn session_records(db: &Connection, session_ids: &[&str]) -> Vec<ConversationRecord> {
    session_ids
        .iter()
        .filter_map(|session_id| get(db, session_id).ok().flatten())
        .collect()
}

fn is_run_id(name: &str) -> bool {
    name.len() == 32
        && name
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The `agent.XXXXXXXXXXXX` name `mktemp` gave the remote directory of this sidecar.
fn remote_name(metadata_path: &str) -> Option<&str> {
    let name = metadata_path
        .strip_suffix("/metadata.json")?
        .rsplit('/')
        .next()?;
    let token = name.strip_prefix("agent.")?;
    (token.len() == 12 && token.bytes().all(|byte| byte.is_ascii_alphanumeric())).then_some(name)
}

fn remote_names<'a>(records: impl IntoIterator<Item = &'a ConversationRecord>) -> Vec<String> {
    records
        .into_iter()
        .filter_map(|record| record.remote_metadata_path.as_deref().and_then(remote_name))
        .map(str::to_owned)
        .collect()
}

fn purgeable(referenced: bool, last_change: Option<SystemTime>, now: SystemTime) -> bool {
    !referenced
        && last_change
            .and_then(|changed| now.duration_since(changed).ok())
            .is_some_and(|age| age >= RETENTION)
}

/// `None` keeps the directory: a symlink, or anything that cannot be inspected.
fn last_change(directory: &Path) -> Option<SystemTime> {
    let metadata = std::fs::symlink_metadata(directory).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    let mut latest = metadata.modified().ok()?;
    for entry in std::fs::read_dir(directory).ok()? {
        latest = latest.max(entry.ok()?.metadata().ok()?.modified().ok()?);
    }
    Some(latest)
}

pub(in crate::agent_sessions) fn referenced_runs(db: &Connection) -> Result<HashSet<String>> {
    Ok(records(db)?
        .into_iter()
        .filter_map(|record| record.run_id)
        .collect())
}

pub(in crate::agent_sessions) fn purge_local(
    links_dir: &Path,
    referenced: &HashSet<String>,
    now: SystemTime,
) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(links_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        entries => entries?,
    };
    let mut result = Ok(());
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| is_run_id(name)) else {
            continue;
        };
        let path = entry.path();
        if purgeable(referenced.contains(name), last_change(&path), now) {
            if let Err(error) = std::fs::remove_dir_all(&path) {
                result = Err(error);
            }
        }
    }
    result
}

/// Read before the sessions' records cascade away with them.
pub(in crate::agent_sessions) fn session_launch_directories(
    db: &Connection,
    links_dir: &Path,
    session_ids: &[&str],
) -> Vec<PathBuf> {
    session_records(db, session_ids)
        .into_iter()
        .filter_map(|record| record.run_id.filter(|run_id| is_run_id(run_id)))
        .map(|run_id| links_dir.join(run_id))
        .collect()
}

pub(in crate::agent_sessions) fn remove_launch_directories(directories: &[PathBuf]) {
    for directory in directories {
        // A directory left behind is an orphan the next startup purge removes.
        let _ = std::fs::remove_dir_all(directory);
    }
}

pub(in crate::agent_sessions) fn session_remote_names(
    db: &Connection,
    session_ids: &[&str],
) -> Vec<String> {
    remote_names(&session_records(db, session_ids))
}

fn remove_remote_script(names: &[String]) -> String {
    let paths = names
        .iter()
        .map(|name| format!(" \"$HOME/.cache/soreno/\"{}", crate::ssh::quote(name)))
        .collect::<String>();
    format!("rm -rf --{paths}")
}

/// Runs synchronously once the deletion is committed, before the SSH connection may close.
pub(in crate::agent_sessions) fn remove_remote_launch_directories(
    connection: &SshConnection,
    names: &[String],
) {
    if names.is_empty() {
        return;
    }
    if let Err(error) = crate::ssh::run(connection, &remove_remote_script(names), None, 64) {
        eprintln!("Suppression des dossiers de lancement SSH : {error}");
    }
}

/// Purges while creating a run directory, the one time a launch reaches the server anyway.
/// Without every record's directory known, nothing is purged.
pub(super) fn remote_run_directory_script(db: &Connection) -> String {
    let keep = records(db).ok().map(|records| remote_names(&records));
    create_remote_script(keep.as_deref())
}

fn create_remote_script(keep: Option<&[String]>) -> String {
    let purge = keep.map_or_else(String::new, |keep| {
        format!(
            r#"(
  set +e
  for s in "$base"/sessions/*/; do
    # Sessions started before the agent pointer existed name no launch directory.
    [ -e "${{s}}socket" ] && [ ! -e "${{s}}label" ] && exit
  done
  keep=' {keep} '
  for f in "$base"/sessions/*/agent; do
    p=
    read -r p < "$f"
    keep="$keep ${{p##*/}} "
  done
  n=0
  find "$base/." ! -name . -prune -name 'agent.????????????' -type d -mtime +{older} -print | while IFS= read -r d; do
    case "$keep" in *" ${{d##*/}} "*) continue ;; esac
    # Bounded so a backlog never delays the launch; later launches resume it.
    n=$((n+1))
    [ "$n" -le {PURGE_LIMIT} ] || break
    recent=$(find "$d" -mtime -{RETENTION_DAYS} -print) || continue
    [ -n "$recent" ] || rm -rf -- "$d"
  done
) >/dev/null 2>&1 || :
"#,
            keep = keep.join(" "),
            older = RETENTION_DAYS - 1,
        )
    });
    format!(
        "set -eu\numask 077\nbase=\"$HOME/.cache/soreno\"\nmkdir -p -- \"$base\"\n{purge}mktemp -d \"$base/agent.XXXXXXXXXXXX\""
    )
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
