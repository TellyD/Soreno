//! Remote SSH sessions run under dtach so they outlive the local `ssh` client.
use super::{remote_dtach, remote_mobile, Result, Runtime};
use crate::ssh::{quote, SshConnection};
use portable_pty::PtySize;
use sha2::{Digest, Sha256};
use std::{
    sync::{Mutex, Weak},
    thread,
    time::Duration,
};

/// Terminal sessions, which `soreno-attach` and the mobile page list.
pub(super) const TERMINALS: &str = "sessions";
/// OMP Chat sessions: RPC JSON lines over their terminal; the mobile page lists them too.
pub(super) const CONVERSATIONS: &str = "conversations";
// Removes the run's prompt directory (`upload_prompt_files`) named in `$d/prompt`, read from `$d`.
macro_rules! purge_prompt {
    () => {
        r#"p=; IFS= read -r p 2>/dev/null < "$d/prompt"; case ${p#/tmp/soreno-agent-} in "$p"|*[!A-Za-z0-9]*) ;; ??????????) rm -rf -- "$p";; esac"#
    };
}
const PURGE_PROMPT: &str = purge_prompt!();
// Runs inside the dtach PTY; its parent is the dtach master. The grid decodes UTF-8 only: under a
// POSIX locale (no LANG from a macOS GUI app) readline misreads U+00A0 and non-ASCII prompts.
// A set LC_ALL overrides LC_CTYPE, so it is the one replaced then.
const WRAPPER: &str = concat!(
    r#"d=$2; printf '%s %s\n' "$PPID" "$1" > "$d/pid"; tty > "$d/tty" || rm -f -- "$d/tty"; case $(locale charmap 2>/dev/null) in UTF-8) ;; *) for l in C.UTF-8 en_US.UTF-8; do [ "$(LC_ALL=$l locale charmap 2>/dev/null)" = UTF-8 ] && { if [ -n "${LC_ALL:-}" ]; then export LC_ALL=$l; else export LC_CTYPE=$l; fi; break; }; done;; esac; "${SHELL:-/bin/bash}" -ilc "$3"; code=$?; "#,
    purge_prompt!(),
    r#"; printf '%s\n' "$code" > "$d/status"; rm -f -- "$d/pid"; exit "$code""#
);
// Shells and Node TUIs redraw only when the size really changes, so dtach's
// SIGWINCH at an unchanged size shows nothing: grow the detached PTY by a row
// first; attaching then restores the client's size.
const FORCE_REDRAW: &str = r#"t=$(cat "$d/tty" 2>/dev/null) || t=
case "$t" in /dev/*)
  size=$(stty size < "$t" 2>/dev/null) || size=
  case "$size" in [0-9]*' '[0-9]*)
    set -- $size
    stty rows "$(($1 + 1))" < "$t" 2>/dev/null && { sleep 0.3 2>/dev/null || sleep 1; };;
  esac;;
esac"#;
// The dtach client always exits 0 on EOF: report the session's own exit code.
const TAIL: &str = r#"code=$?
if [ -f "$d/status" ]; then code=$(cat "$d/status"); rm -rf -- "$d"; fi
exit "$code""#;
const DTACH_OPTIONS: &str = "-E -z -r winch";
// OMP blocks writing to a full terminal but spills its output to a file when a pipe backs up:
// through `cat`, it keeps reading the input the dtach master may be blocked writing. Its stderr
// stays out of the records, which a write of its own could split.
const CONVERSATION_WRAPPER: &str = concat!(
    r#"d=$2; printf '%s %s\n' "$PPID" "$1" > "$d/pid"; { "${SHELL:-/bin/bash}" -ilc "$3" 2>>"$d/stderr"; printf '%s\n' "$?" > "$d/code"; } | cat; code=$(cat "$d/code" 2>/dev/null) || code=1; "#,
    purge_prompt!(),
    r#"; printf '%s\n' "$code" > "$d/status"; rm -f -- "$d/pid"; exit "$code""#
);
// Also reports the end of the run's stderr, which Soreno keeps from the terminal's text.
const CONVERSATION_TAIL: &str = r#"code=$?
if [ -f "$d/status" ]; then code=$(cat "$d/status"); tail -c 16384 "$d/stderr" 2>/dev/null; rm -rf -- "$d"; fi
exit "$code""#;

/// How a kind of dtach session runs.
struct Layout {
    root: &'static str,
    options: &'static str,
    wrapper: &'static str,
    tail: &'static str,
}
const TERMINAL: Layout = Layout {
    root: TERMINALS,
    options: DTACH_OPTIONS,
    wrapper: WRAPPER,
    tail: TAIL,
};
const CONVERSATION: Layout = Layout {
    root: CONVERSATIONS,
    options: "-E -z -r none",
    wrapper: CONVERSATION_WRAPPER,
    tail: CONVERSATION_TAIL,
};
// dtach skips output for a client that cannot take it at once while another can: a client
// stranded by a dropped connection would make the new one lose JSON lines. `dtach -c` stays
// the first client under the master's args, so `-c` is killed only when `$d/pid` names the master.
// SIGKILL: on SIGTERM a stranded client blocks for good printing its exit message to the dead
// terminal, and the master, waiting for it, never serves the new client's attach.
const DETACH_OTHERS: &str = r#"m=; read m _ < "$d/pid" 2>/dev/null || m=; { ps -A -ww -o pid= -o args= 2>/dev/null || ps -o pid= -o args= 2>/dev/null; } | S="$d/socket" M="$m" awk '$2 ~ /\/dtach$/ && $4 == ENVIRON["S"] && ($3 == "-a" || $3 == "-c" && ENVIRON["M"] ~ /^[0-9]+$/ && $1 != ENVIRON["M"]) { print $1 }' | while read -r p; do kill -9 "$p" 2>/dev/null; done"#;
const LABEL_LIMIT: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RemoteHost {
    Absent,
    Live,
}

pub(super) fn key(session_id: &str) -> String {
    let mut key = format!("{:x}", Sha256::digest(session_id.as_bytes()));
    key.truncate(32);
    key
}

fn session_dir(root: &str, session_id: &str) -> String {
    format!("\"$HOME/.cache/soreno/{root}/{}\"", key(session_id))
}

const VERIFY_RUN: &str = r#"is_run() {
  test -S "$d/socket" && kill -0 "$pid" 2>/dev/null || return 1
  case "$token" in ????????????????????????????????) ;; *) return 1;; esac
  case "$token" in *[!0-9a-f]*) return 1;; esac
  if info=$(LC_ALL=C ps -ww -p "$pid" -o pid=,comm=,args= 2>/dev/null); then :
  elif info=$(LC_ALL=C ps -o pid=,comm=,args= 2>/dev/null); then :
  else return 2
  fi
  record=$(printf '%s\n' "$info" | while read -r found_pid found_comm found_args; do
    test "$found_pid" = "$pid" || continue
    printf '%s %s\n' "$found_comm" "$found_args"
    break
  done)
  test -n "$record" || return 1
  comm=${record%% *}; comm=${comm##*/}; args=${record#* }
  test "$comm" = dtach || return 1
  printf '%s\n' "$args" | grep -F -- "$d/socket" >/dev/null 2>&1 || return 1
  printf '%s\n' "$args" | grep -F -- "$token" >/dev/null 2>&1
}"#;

// Also revives a standalone mobile service before each session start, at no extra round trip.
fn probe_script(root: &str, session_id: &str) -> String {
    format!(
        "{}\n{}",
        remote_mobile::revive_script(),
        probe_body(root, session_id)
    )
}

/// Prints `live`, `absent` or `inspection_error` for the session's dtach run, then exits 0.
pub(super) fn probe_body(root: &str, session_id: &str) -> String {
    format!(
        r#"d={}
{VERIFY_RUN}
pid= token= extra=
read pid token extra < "$d/pid" 2>/dev/null || pid=
case "$pid" in ''|*[!0-9]*) printf absent; exit 0;; esac
if [ -n "$extra" ]; then printf absent; exit 0; fi
is_run; result=$?
case "$result" in 0) printf live;; 1) printf absent;; *) printf inspection_error;; esac"#,
        session_dir(root, session_id)
    )
}

pub(super) fn prepare(
    kind: &str,
    connection: Option<&SshConnection>,
    session_id: &str,
) -> Result<(Option<RemoteHost>, Option<String>)> {
    match (kind, connection) {
        ("ssh", Some(connection)) => {
            let host = probe(connection, TERMINALS, session_id)?;
            let dtach = remote_dtach::ensure(connection)?;
            Ok((Some(host), Some(dtach)))
        }
        _ => Ok((None, None)),
    }
}

pub(super) fn probe(
    connection: &SshConnection,
    root: &str,
    session_id: &str,
) -> Result<RemoteHost> {
    match crate::ssh::run(connection, &probe_script(root, session_id), None, 64)?.as_slice() {
        b"absent" => Ok(RemoteHost::Absent),
        b"live" => Ok(RemoteHost::Live),
        b"inspection_error" => {
            Err("Impossible d’inspecter le processus dtach sur le serveur SSH.".into())
        }
        _ => Err("Réponse SSH inattendue lors de la détection de dtach.".into()),
    }
}

// Lists the session in `soreno-attach` and the mobile page; best effort, it must never block the launch.
fn label_line(label: &str) -> String {
    let label: String = label
        .chars()
        .filter(|c| !c.is_control())
        .take(LABEL_LIMIT)
        .collect();
    format!(
        "printf '%s\\n' {} > \"$d/label\" 2>/dev/null || :",
        quote(&label)
    )
}

fn listing_lines(label: &str, agent: Option<&str>) -> String {
    let agent = match agent {
        // Renamed into place: the launch purge must never read a half-written pointer.
        Some(directory) => format!(
            "printf '%s\\n' {} > \"$d/agent.tmp\" 2>/dev/null && mv -f -- \"$d/agent.tmp\" \"$d/agent\" 2>/dev/null || :",
            quote(directory)
        ),
        None => "rm -f -- \"$d/agent\" 2>/dev/null || :".into(),
    };
    format!("{}\n{agent}", label_line(label))
}

// Renames a running session of `root`; a missing directory means it is not under dtach.
fn label_script(root: &str, session_id: &str, label: &str) -> String {
    format!(
        "d={}\n[ -d \"$d\" ] || exit 0\n{}",
        session_dir(root, session_id),
        label_line(label)
    )
}

pub(super) fn set_label(
    connection: &SshConnection,
    root: &str,
    session_id: &str,
    label: &str,
) -> Result<()> {
    crate::ssh::run(connection, &label_script(root, session_id, label), None, 64).map(|_| ())
}

/// `prompt` is the run's prompt directory, which the run removes when it ends.
fn create_script(
    dtach: &str,
    session_id: &str,
    label: &str,
    agent: Option<&str>,
    prompt: Option<&str>,
    inner: &str,
) -> String {
    spawn_script(
        dtach,
        &TERMINAL,
        session_id,
        &listing_lines(label, agent),
        prompt,
        inner,
    )
}

fn spawn_script(
    dtach: &str,
    layout: &Layout,
    session_id: &str,
    listing: &str,
    prompt: Option<&str>,
    inner: &str,
) -> String {
    format!(
        "{}\n{}",
        spawn_command(
            &quote(dtach),
            "-c",
            layout,
            session_id,
            listing,
            prompt,
            inner
        ),
        layout.tail
    )
}

/// `dtach` is a shell word naming the binary; `mode` is `-c` (create and attach) or `-n` (detached).
fn spawn_command(
    dtach: &str,
    mode: &str,
    layout: &Layout,
    session_id: &str,
    listing: &str,
    prompt: Option<&str>,
    inner: &str,
) -> String {
    let prompt = prompt
        .map(|prompt| format!("printf '%s\\n' {} > \"$d/prompt\" || exit\n", quote(prompt)))
        .unwrap_or_default();
    // The previous run's prompt directory outlives it when that run was killed.
    format!(
        "d={}\n{PURGE_PROMPT}\nrm -rf -- \"$d\" && (umask 077 && mkdir -p -- \"$d\" \"$d/clipboard\") || exit\n{prompt}{listing}\ntoken=$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]') || exit\ncase \"$token\" in ????????????????????????????????) ;; *) exit 1;; esac\n{dtach} {mode} \"$d/socket\" {} sh -c {} soreno \"$token\" \"$d\" {}",
        session_dir(layout.root, session_id),
        layout.options,
        quote(layout.wrapper),
        quote(inner),
    )
}

/// Starts the terminal session detached with `"$dtach"`, where the desktop's next open attaches.
/// Exits 75 while a run of it still lives, 76 when that cannot be checked, else with dtach's status.
// shortcut: a desktop launch probed `Absent` just before the timer fires still recreates the directory
// and orphans that run's dtach; add a per-session remote lock if launches at the scheduled minute matter.
pub(super) fn scheduled_script(session_id: &str, label: &str, inner: &str) -> String {
    format!(
        "live=$( ( {} ) )\ncase \"$live\" in live) exit 75;; absent) ;; *) exit 76;; esac\n{}",
        probe_body(TERMINALS, session_id),
        spawn_command(
            "\"$dtach\"",
            "-n",
            &TERMINAL,
            session_id,
            &listing_lines(label, None),
            None,
            inner,
        )
    )
}

fn attach_script(
    dtach: &str,
    session_id: &str,
    label: &str,
    agent: Option<&str>,
    default_shell: bool,
) -> String {
    let force_redraw = if default_shell { "" } else { FORCE_REDRAW };
    let options = if default_shell {
        "-E -z -r ctrl_l"
    } else {
        DTACH_OPTIONS
    };
    format!(
        "d={}\n{}\n{force_redraw}\n{} -a \"$d/socket\" {options}\n{TAIL}",
        session_dir(TERMINALS, session_id),
        listing_lines(label, agent),
        quote(dtach)
    )
}

/// `agent` is the remote launch directory of a conversation-integrated agent; `prompt` see
/// `create_script`.
#[allow(clippy::too_many_arguments)]
pub(super) fn session_script(
    dtach: Option<&str>,
    host: Option<RemoteHost>,
    session_id: &str,
    label: &str,
    agent: Option<&str>,
    prompt: Option<&str>,
    inner: &str,
    default_shell: bool,
) -> Result<String> {
    let dtach = dtach.ok_or("Chemin dtach distant inconnu.")?;
    match host.ok_or("État dtach distant inconnu.")? {
        RemoteHost::Live => Ok(attach_script(
            dtach,
            session_id,
            label,
            agent,
            default_shell,
        )),
        RemoteHost::Absent => Ok(create_script(
            dtach, session_id, label, agent, prompt, inner,
        )),
    }
}

/// Starts or reattaches a Chat session; `inner` runs OMP in the session's terminal.
pub(super) fn conversation_script(
    dtach: &str,
    host: RemoteHost,
    session_id: &str,
    label: &str,
    prompt: Option<&str>,
    inner: &str,
) -> String {
    match host {
        RemoteHost::Absent => spawn_script(
            dtach,
            &CONVERSATION,
            session_id,
            &listing_lines(label, None),
            prompt,
            inner,
        ),
        RemoteHost::Live => format!(
            "d={}\n{DETACH_OTHERS}\n{} -a \"$d/socket\" {}\n{}",
            session_dir(CONVERSATIONS, session_id),
            quote(dtach),
            CONVERSATION.options,
            CONVERSATION.tail
        ),
    }
}

pub(super) fn attach_command(connection: &SshConnection, session_id: &str) -> String {
    let mut command = String::from("ssh -t");
    if let Some(port) = connection.port {
        command.push_str(&format!(" -p {port}"));
    }
    if let Some(user) = &connection.user {
        command.push_str(" -l ");
        // Validated users only need quoting for a Windows domain backslash; double
        // quotes are stripped by cmd.exe, PowerShell and POSIX shells alike.
        if user.contains('\\') {
            command.push_str(&format!("\"{user}\""));
        } else {
            command.push_str(user);
        }
    }
    // Relative to the remote home: a local shell would expand `~` itself.
    command.push_str(&format!(
        " {} {} {}",
        connection.host,
        remote_dtach::ATTACH_HELPER_PATH,
        key(session_id)
    ));
    command
}

fn redraw_locked(size: &Mutex<PtySize>, redraw: impl FnOnce(), restore: impl FnOnce(PtySize)) {
    let Ok(size) = size.lock() else {
        return;
    };
    redraw();
    restore(*size);
}

pub(super) fn schedule_redraw(
    runtime: Weak<Runtime>,
    connection: Option<&SshConnection>,
    host: Option<RemoteHost>,
    session_id: &str,
) {
    if host != Some(RemoteHost::Live) {
        return;
    }
    let Some(connection) = connection.cloned() else {
        return;
    };
    let session_id = session_id.to_owned();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(1));
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        redraw_locked(
            &runtime.size,
            || {
                let _ = redraw(&connection, &session_id);
            },
            |size| {
                if let Ok(master) = runtime.master.lock() {
                    if let Some(master) = master.as_ref() {
                        let _ = master.resize(size);
                    }
                }
            },
        );
    });
}

fn redraw(connection: &SshConnection, session_id: &str) -> Result<()> {
    let script = format!(
        "d={}\n{VERIFY_RUN}\npid= token= extra=\nread pid token extra < \"$d/pid\" 2>/dev/null || exit 0\n[ -z \"$extra\" ] && is_run || exit 0\nt=$(cat \"$d/tty\" 2>/dev/null) || exit 0\ncase \"$t\" in /dev/*) ;; *) exit 0;; esac\nsize=$(stty size < \"$t\" 2>/dev/null) || exit 0\nset -- $size\n[ \"$#\" -eq 2 ] || exit 0\ncase \"$1\" in ''|*[!0-9]*) exit 0;; esac\ncase \"$2\" in ''|*[!0-9]*) exit 0;; esac\nrows=$1 cols=$2\nsignal_tree() {{\n  kill -WINCH \"$1\" 2>/dev/null || :\n  ps -A -o pid= -o ppid= 2>/dev/null | while read -r child parent; do\n    [ \"$parent\" = \"$1\" ] && signal_tree \"$child\"\n  done\n  return 0\n}}\nstty rows \"$((rows + 1))\" cols \"$cols\" < \"$t\" 2>/dev/null || exit 0\nsignal_tree \"$pid\"\nsleep 0.1 2>/dev/null || sleep 1\nstty rows \"$rows\" cols \"$cols\" < \"$t\" 2>/dev/null || exit 0\nsignal_tree \"$pid\"",
        session_dir(TERMINALS, session_id),
    );
    crate::ssh::run(connection, &script, None, 64).map(|_| ())
}

// Covers both roots: callers end sessions without knowing their kind.
fn stop_script(session_ids: &[&str]) -> String {
    let keys = session_ids
        .iter()
        .flat_map(|session_id| {
            let key = key(session_id);
            [TERMINALS, CONVERSATIONS].map(|root| format!("{root}/{key}"))
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"set -u
base="$HOME/.cache/soreno"
{VERIFY_RUN}
for k in {keys}; do
  d="$base/$k"; pid= token= extra=
  read pid token extra < "$d/pid" 2>/dev/null || pid=
  case "$pid" in ''|*[!0-9]*) continue;; esac
  [ -z "$extra" ] || continue
  is_run; result=$?
  [ "$result" -ne 2 ] || exit 2
  [ "$result" -ne 0 ] || kill -TERM "$pid" 2>/dev/null
done
i=0
while [ "$i" -lt 5 ]; do
  alive=
  for k in {keys}; do
    d="$base/$k"; pid= token= extra=
    read pid token extra < "$d/pid" 2>/dev/null || pid=
    case "$pid" in ''|*[!0-9]*) continue;; esac
    [ -z "$extra" ] || continue
    is_run; result=$?
    [ "$result" -ne 2 ] || exit 2
    [ "$result" -ne 0 ] || alive=1
  done
  [ -z "$alive" ] && break; sleep 1; i=$((i+1))
done
for k in {keys}; do
  d="$base/$k"; pid= token= extra=
  read pid token extra < "$d/pid" 2>/dev/null || pid=
  case "$pid" in ''|*[!0-9]*) continue;; esac
  [ -z "$extra" ] || continue
  is_run; result=$?
  [ "$result" -ne 2 ] || exit 2
  [ "$result" -ne 0 ] || kill -KILL "$pid" 2>/dev/null
done
for k in {keys}; do d="$base/$k"; {PURGE_PROMPT}; rm -rf -- "$d" || exit 1; done"#
    )
}

pub(super) fn stop(connection: &SshConnection, session_ids: &[&str]) -> Result<()> {
    if session_ids.is_empty() {
        return Ok(());
    }
    crate::ssh::run(connection, &stop_script(session_ids), None, 64).map(|_| ())
}

pub(super) fn clipboard_directory_script(root: &str, session_id: &str) -> String {
    format!(
        "set -eu; umask 077; dir={}/clipboard; mkdir -p -- \"$dir\"; test ! -L \"$dir\"; printf '%s' \"$dir\"",
        session_dir(root, session_id)
    )
}

pub(super) fn clipboard_directory(output: Vec<u8>, root: &str, session_id: &str) -> Result<String> {
    const INVALID: &str = "Chemin du presse-papiers distant invalide.";
    let path = String::from_utf8(output).map_err(|_| INVALID.to_string())?;
    let suffix = format!("/.cache/soreno/{root}/{}/clipboard", key(session_id));
    if !path.starts_with('/') || path.chars().any(char::is_control) || !path.ends_with(&suffix) {
        return Err(INVALID.into());
    }
    Ok(path)
}

#[cfg(all(test, unix))]
#[path = "remote_host_tests.rs"]
mod tests;
