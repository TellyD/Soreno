//! Optional `soreno-remote` user service that links the dtach sessions to the Soreno relay.
use super::{remote_dtach::HASH_FILE, Result};
use crate::ssh::{quote, SshConnection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    sync::LazyLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) const RELAY_ORIGIN: &str = "https://mobile.soreno.dev";
pub(crate) const RELAY_LINK: &str = "ws://relay.soreno.dev:8790";
// `soreno-relay public-key` on the VPS; a new relay key needs a Soreno release.
pub(crate) const RELAY_PUBLIC_KEY: &str = "bFhMt3JKgduyksRtdIp8pAUImvZdBXwonkyBTlucrEA";
const RELAY: Relay = Relay {
    link: RELAY_LINK,
    key: RELAY_PUBLIC_KEY,
};
const LEGACY_HTTPS_PORT: &str = "8443";
const LEGACY_LINK_PORT: &str = "8444";
const STATE_VERSION: u64 = 4;
const STATE_MAX_AGE_MS: u64 = 30_000;
// Needs `$base`. Without systemd the service runs detached: `$base/standalone` holds its command
// line like the unit's `ExecStart`, `$base/pid` its PID, and a `flock` on `$base/start.lock`
// serializes starts.
const SERVICE: &str = r#"standalone_pid() {
  read -r pid < "$base/pid" 2>/dev/null || return 1
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null) || return 1
  real=$(cd -- "$base" 2>/dev/null && pwd -P) || return 1
  case "$exe" in "$real"/*/soreno-remote) printf '%s' "$pid" ;; *) return 1 ;; esac
}
service_pid() {
  if [ -f "$base/standalone" ]; then
    standalone_pid
    return
  fi
  pid=$(systemctl --user show -p MainPID soreno-remote.service 2>/dev/null) || return 1
  pid=${pid#MainPID=}
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  printf '%s' "$pid"
}
# Succeeds when the running service executes `$1/soreno-remote`, the file on disk being no proof.
runs_binary() {
  pid=$(service_pid) || return 1
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null) || return 1
  dir=$(cd -- "$1" 2>/dev/null && pwd -P) || return 1
  [ "$exe" = "$dir/soreno-remote" ]
}
# `$1` tries 0.2 s apart; the kernel releases the lock when its holder dies.
take_lock() {
  # Without `flock`, starts are not serialized.
  command -v flock >/dev/null 2>&1 || return 0
  command exec 9> "$base/start.lock" || return 1
  tries=0
  while :; do
    if flock -n 9; then
      # `disable_script` may have removed the locked pathname: lock the current file instead.
      [ /dev/fd/9 -ef "$base/start.lock" ] && return 0
      exec 9>&-
      command exec 9> "$base/start.lock" || return 1
    fi
    tries=$((tries + 1))
    [ "$tries" -le "$1" ] || { exec 9>&-; return 1; }
    sleep 0.2
  done
}
drop_lock() {
  exec 9>&-
}
start_standalone() {
  line=$(head -n 1 -- "$base/standalone" 2>/dev/null) || return 1
  case "$line" in '%h/.cache/soreno/remote/'*'/soreno-remote serve --relay '*' --relay-key '*) ;; *) return 1 ;; esac
  rest=${line#%h/.cache/soreno/remote/}
  run_hash=${rest%%/*}
  case "$run_hash" in ''|*[!0-9a-f]*) return 1 ;; esac
  args=${rest#*/soreno-remote serve --relay }
  run_link=${args%% --relay-key *}
  run_key=${args#* --relay-key }
  run_bin="$base/$run_hash/soreno-remote"
  [ -f "$run_bin" ] && [ -x "$run_bin" ] || return 1
  detach=
  command -v setsid >/dev/null 2>&1 && detach=setsid
  # Not a group leader, setsid execs in place: `$!` is the service itself.
  (trap '' HUP; cd -- "$HOME" && exec $detach "$run_bin" serve --relay "$run_link" --relay-key "$run_key") < /dev/null > /dev/null 2> "$base/serve.log" 9>&- &
  printf '%s\n' "$!" > "$base/pid"
  # Until the exec shows, another starter would see no service: callers keep the lock meanwhile.
  tries=0
  until standalone_pid >/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -le 25 ] || return 0
    sleep 0.2
  done
}
stop_standalone() {
  stop_pid=$(standalone_pid) || return 0
  kill "$stop_pid" 2>/dev/null
  tries=0
  while standalone_pid >/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -ne 25 ] || kill -9 "$stop_pid" 2>/dev/null
    [ "$tries" -le 30 ] || return 1
    sleep 0.2
  done
  rm -f -- "$base/pid"
}"#;
const STATUS_LIMIT: usize = 1024 * 1024;
const SCRIPT_LIMIT: usize = 64 * 1024;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(60);
// `soreno-remote` pairing secrets never live longer.
const PAIRING_LIFETIME_MS: u64 = 10 * 60 * 1000;

struct Embedded {
    bytes: &'static [u8],
    hash: LazyLock<String>,
}

impl Embedded {
    fn hash(&self) -> &str {
        &self.hash
    }
}

const LINUX_X86_64_BYTES: &[u8] = include_bytes!("../../remote/bin/linux-x86_64/soreno-remote");
const LINUX_AARCH64_BYTES: &[u8] = include_bytes!("../../remote/bin/linux-aarch64/soreno-remote");
static LINUX_X86_64: Embedded = Embedded {
    bytes: LINUX_X86_64_BYTES,
    hash: LazyLock::new(|| format!("{:x}", Sha256::digest(LINUX_X86_64_BYTES))),
};
static LINUX_AARCH64: Embedded = Embedded {
    bytes: LINUX_AARCH64_BYTES,
    hash: LazyLock::new(|| format!("{:x}", Sha256::digest(LINUX_AARCH64_BYTES))),
};

fn embedded(platform: &str) -> Option<&'static Embedded> {
    match platform {
        "Linux/x86_64" => Some(&LINUX_X86_64),
        "Linux/aarch64" => Some(&LINUX_AARCH64),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Relay<'a> {
    link: &'a str,
    key: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshMobileDevice {
    pub id: String,
    pub label: String,
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshMobileStatus {
    pub platform: String,
    pub supported: bool,
    pub installed: bool,
    pub up_to_date: bool,
    pub active: bool,
    /// A former Tailscale installation (`serve --listen`) waiting to be converted.
    pub legacy: bool,
    pub connected: bool,
    pub state_fresh: bool,
    pub host: Option<String>,
    pub server: Option<String>,
    /// `None` when the current binary could not read its authorizations (busy lock, unreadable
    /// `access.json`); empty when there is nothing to read (no current binary on the server).
    pub devices: Option<Vec<SshMobileDevice>>,
    /// Ids of the pairing secrets still waiting for a phone; `None` like `devices`.
    pub pairings: Option<Vec<String>>,
    /// Ids of the pairing secrets a phone spent, until they would have expired; `None` like
    /// `devices`.
    pub pairings_used: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshMobilePairing {
    pub id: String,
    pub url: String,
    pub qr_svg: String,
    pub expires_at: u64,
}

struct Probe {
    status: SshMobileStatus,
    binary_current: bool,
    https: Publication,
    link: Publication,
}

// What the root of a legacy Tailscale publication serves; only `Ours` is ever removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Publication {
    Absent,
    Ours,
    Foreign,
    Unknown,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceState {
    version: Option<u64>,
    server: Option<String>,
    host: Option<String>,
    #[serde(default)]
    connected: bool,
    updated_at: Option<u64>,
}

#[derive(Deserialize)]
struct AccessPairing {
    id: String,
}

#[derive(Deserialize)]
struct Access {
    server: Option<String>,
    #[serde(default)]
    devices: Vec<SshMobileDevice>,
    #[serde(default)]
    pairings: Vec<AccessPairing>,
    #[serde(default)]
    used: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairOutput {
    server: String,
    id: String,
    secret: String,
    expires_in_ms: u64,
}

fn exec_start(hash: &str, relay: Relay) -> String {
    format!(
        "%h/.cache/soreno/remote/{hash}/soreno-remote serve --relay {} --relay-key {}",
        relay.link, relay.key
    )
}

fn unit(hash: &str, relay: Relay) -> String {
    format!(
        "[Unit]\nDescription=Soreno mobile access\n\n[Service]\nExecStart={}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target",
        exec_start(hash, relay)
    )
}

fn legacy_port(exec_start: &str) -> Option<u16> {
    exec_start
        .rsplit_once(" serve --listen 127.0.0.1:")?
        .1
        .parse()
        .ok()
        .filter(|port| *port != 0)
}

fn is_key(text: &str) -> bool {
    text.len() == 43
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_hex_id(text: &str) -> bool {
    text.len() == 16
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// Sets `$s`, `$m`, `$base`, `$hash` and `$bin`, the binary this desktop ships for the server.
fn binary_path(x86_64: &str, aarch64: &str) -> String {
    format!(
        r#"s=$(uname -s 2>/dev/null) || s=
m=$(uname -m 2>/dev/null) || m=
base="$HOME/.cache/soreno/remote"
case "$s/$m" in
  Linux/x86_64) hash={x86_64} ;;
  Linux/aarch64) hash={aarch64} ;;
  *) hash= ;;
esac
bin="$base/$hash/soreno-remote""#
    )
}

// Sections separated by NUL: `key=value` lines, legacy `tailscale serve status`, `state.json`,
// `soreno-remote access`.
fn status_script(x86_64: &str, aarch64: &str) -> String {
    let binary_path = binary_path(x86_64, aarch64);
    format!(
        r#"{HASH_FILE}
{SERVICE}
{binary_path}
unit="$HOME/.config/systemd/user/soreno-remote.service"
run=
command -v timeout >/dev/null 2>&1 && run="timeout 5"
printf 'platform=%s/%s\nhash=%s\nnow=%s\n' "$s" "$m" "$hash" "$(date +%s 2>/dev/null)"
access=
if [ -n "$hash" ]; then
  if [ -d "$base" ] && [ ! -L "$base" ] && [ -f "$bin" ] && [ ! -L "$bin" ] && [ -x "$bin" ] && [ "$(hash_file "$bin" 2>/dev/null || :)" = "$hash" ]; then
    printf 'binary=current\n'
    access=$($run "$bin" access 2>/dev/null) || access=
  fi
  if [ -f "$base/standalone" ]; then
    if standalone_pid >/dev/null; then printf 'active=active\n'; fi
    if runs_binary "$base/$hash"; then printf 'running=current\n'; fi
  elif command -v systemctl >/dev/null 2>&1; then
    printf 'active=%s\n' "$(systemctl --user is-active soreno-remote.service 2>/dev/null)"
    if runs_binary "$base/$hash"; then printf 'running=current\n'; fi
  fi
fi
exec_start=
if [ -f "$base/standalone" ]; then
  exec_start=$(head -n 1 -- "$base/standalone")
  printf 'unit=%s\n' "$exec_start"
elif [ -f "$unit" ]; then
  exec_start=$(sed -n 's/^ExecStart=//p' "$unit" | head -n 1)
  printf 'unit=%s\n' "$exec_start"
fi
serve=
case "$exec_start" in
  *" serve --listen 127.0.0.1:"*)
    if command -v tailscale >/dev/null 2>&1; then
      serve=$($run tailscale serve status --json 2>/dev/null) && printf 'serve=read\n' || serve=
    fi ;;
esac
printf '\0'
printf '%s' "$serve"
printf '\0'
[ ! -f "$base/state.json" ] || cat "$base/state.json" 2>/dev/null || :
printf '\0'
printf '%s' "$access""#
    )
}

// Nothing published reads as `{}`; an empty or failed read is unknown, never absent.
fn publication(
    serve: Option<&[u8]>,
    port: &str,
    target: Option<&str>,
    host: Option<&str>,
) -> Publication {
    let Some(config) = serve.and_then(|serve| serde_json::from_slice::<Value>(serve).ok()) else {
        return Publication::Unknown;
    };
    let Some(config) = config.as_object() else {
        return Publication::Unknown;
    };
    let Some(web) = config.get("Web").and_then(Value::as_object) else {
        return Publication::Absent;
    };
    let suffix = format!(":{port}");
    web.iter()
        .filter(|(site, _)| {
            site.strip_suffix(&suffix)
                .is_some_and(|name| host.is_none_or(|host| name == host))
        })
        .filter_map(|(_, config)| config.pointer("/Handlers/~1"))
        .fold(Publication::Absent, |found, root| {
            if found == Publication::Ours
                || target.is_some() && root.get("Proxy").and_then(Value::as_str) == target
            {
                Publication::Ours
            } else {
                Publication::Foreign
            }
        })
}

fn qr_svg(url: &str) -> Option<String> {
    let code = qrcode::QrCode::new(url.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(176, 176)
            .build(),
    )
}

fn parse_status(output: &[u8], relay: Relay) -> Result<Probe> {
    let mut sections = output.split(|byte| *byte == 0);
    let fields = std::str::from_utf8(sections.next().unwrap_or_default())
        .map_err(|_| "Réponse non UTF-8 lors de la lecture de l’accès mobile.".to_string())?;
    let serve_json = sections.next().unwrap_or_default();
    let state_json = sections.next().unwrap_or_default();
    let access_json = sections.next().unwrap_or_default();
    let (mut platform, mut hash, mut now, mut unit) = ("", "", None, None);
    let (mut binary_current, mut running_current, mut active, mut serve_read) =
        (false, false, false, false);
    for line in fields.lines() {
        match line.split_once('=') {
            Some(("platform", value)) => platform = value,
            Some(("hash", value)) => hash = value,
            Some(("now", value)) => now = value.parse::<u64>().ok(),
            Some(("binary", value)) => binary_current = value == "current",
            Some(("running", value)) => running_current = value == "current",
            Some(("unit", value)) => unit = Some(value),
            Some(("active", value)) => active = value == "active",
            Some(("serve", value)) => serve_read = value == "read",
            _ => {}
        }
    }
    if platform.is_empty() {
        return Err("Réponse incomplète lors de la lecture de l’accès mobile.".into());
    }
    let supported = !hash.is_empty();
    binary_current &= supported;
    let port = unit.and_then(legacy_port);
    let target = port.map(|port| format!("http://127.0.0.1:{port}"));
    let serve = serve_read.then_some(serve_json);
    let legacy_publication = |serve_port: &str| match port {
        Some(_) => publication(serve, serve_port, target.as_deref(), None),
        None => Publication::Absent,
    };
    let state = serde_json::from_slice::<ServiceState>(state_json)
        .ok()
        .filter(|state| state.version == Some(STATE_VERSION));
    // The service rewrites `state.json` at least every 10 s.
    let state_fresh = state
        .as_ref()
        .and_then(|state| state.updated_at)
        .zip(now)
        .is_some_and(|(updated, now)| updated.saturating_add(STATE_MAX_AGE_MS) >= now * 1000);
    let access = binary_current.then(|| serde_json::from_slice::<Access>(access_json).ok());
    let (state_server, host, connected) = match state {
        Some(state) => (state.server, state.host, state.connected && state_fresh),
        None => (None, None, false),
    };
    let (access_server, devices, pairings, pairings_used) = match access {
        Some(Some(access)) => (
            access.server,
            Some(access.devices),
            Some(
                access
                    .pairings
                    .into_iter()
                    .map(|pairing| pairing.id)
                    .collect(),
            ),
            Some(access.used),
        ),
        Some(None) => (None, None, None, None),
        None => (None, Some(Vec::new()), Some(Vec::new()), Some(Vec::new())),
    };
    Ok(Probe {
        status: SshMobileStatus {
            platform: platform.to_owned(),
            supported,
            installed: unit.is_some(),
            up_to_date: binary_current
                && (running_current || !active)
                && unit == Some(exec_start(hash, relay).as_str()),
            active,
            legacy: port.is_some(),
            connected,
            state_fresh,
            host,
            server: access_server.or(state_server),
            devices,
            pairings,
            pairings_used,
        },
        binary_current,
        https: legacy_publication(LEGACY_HTTPS_PORT),
        link: legacy_publication(LEGACY_LINK_PORT),
    })
}

// The `[Mobile/<code>]` tag lets the interface show a localized message.
fn coded(code: &str, message: &str) -> String {
    format!("[Mobile/{code}] {message}")
}

fn require_supported(status: &SshMobileStatus) -> Result<()> {
    if status.supported {
        return Ok(());
    }
    Err(coded(
        "unsupported",
        &format!(
            "L’accès mobile exige un serveur Linux x86_64 ou aarch64 (serveur détecté : {}).",
            status.platform
        ),
    ))
}

fn install_script(hash: &str) -> String {
    format!(
        r#"set -eu
{HASH_FILE}
umask 077
base="$HOME/.cache/soreno"
mkdir -p "$base"
[ -d "$base" ] && [ ! -L "$base" ] || exit 20
remote="$base/remote"
mkdir -p "$remote"
[ -d "$remote" ] && [ ! -L "$remote" ] || exit 20
chmod 700 "$remote"
dir="$remote/{hash}"
mkdir -p "$dir"
[ -d "$dir" ] && [ ! -L "$dir" ] || exit 20
t="$dir/soreno-remote"
tmp="$dir/.soreno-remote.$$"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat > "$tmp"
chmod 700 "$tmp"
[ "$(hash_file "$tmp" || :)" = {hash} ] || exit 23
"$tmp" --version >/dev/null 2>&1 || exit 24
mv -f "$tmp" "$t"
trap - EXIT HUP INT TERM"#
    )
}

// Best effort: an absent, stopped or unreadable Tailscale never blocks the conversion.
fn unpublish_legacy(https: Publication, link: Publication) -> String {
    let mut script =
        String::from("run=\ncommand -v timeout >/dev/null 2>&1 && run=\"timeout 15\"\n");
    for (publication, flag, port) in [
        (https, "https", LEGACY_HTTPS_PORT),
        (link, "http", LEGACY_LINK_PORT),
    ] {
        if publication == Publication::Ours {
            script.push_str(&format!(
                "$run tailscale serve --{flag}={port} --set-path=/ off >/dev/null 2>&1 || :\n"
            ));
        }
    }
    script
}

fn activation_script(hash: &str, relay: Relay, https: Publication, link: Publication) -> String {
    let content = quote(&unit(hash, relay));
    let command = quote(&exec_start(hash, relay));
    let unpublish = unpublish_legacy(https, link);
    format!(
        r#"set -u
umask 077
base="$HOME/.cache/soreno/remote"
{SERVICE}
bin="$base/{hash}/soreno-remote"
[ -d "$base" ] && [ ! -L "$base" ] && [ -f "$bin" ] && [ -x "$bin" ] || exit 30
units="$HOME/.config/systemd/user"
unit="$units/soreno-remote.service"
# Only systemd as init creates /run/systemd/system; devcontainer images ship a `systemctl` shim
# that exits 0 without it: run detached there.
systemd=
if [ -d /run/systemd/system ]; then
  case "$(systemctl --user show -p Version 2>/dev/null)" in Version=?*) ;; *) exit 31 ;; esac
  systemd=1
fi
{unpublish}rm -f -- "$base/role" || exit 32
if [ -n "$systemd" ]; then
  take_lock 50 || exit 42
  stop_standalone || {{ drop_lock; exit 43; }}
  rm -f -- "$base/standalone" "$base/pid" "$base/serve.log" || {{ drop_lock; exit 32; }}
  drop_lock
  content={content}
  mkdir -p -- "$units" || exit 32
  changed=
  if [ "$(cat -- "$unit" 2>/dev/null)" != "$content" ]; then
    t="$unit.$$"
    printf '%s\n' "$content" > "$t" && mv -f -- "$t" "$unit" || {{ rm -f -- "$t"; exit 32; }}
    changed=1
  fi
  # logind checks polkit before the current state: re-enabling fails even when already lingering.
  if [ "$(loginctl show-user "$(id -u)" -p Linger 2>/dev/null)" != Linger=yes ]; then
    command -v loginctl >/dev/null 2>&1 && loginctl enable-linger >/dev/null 2>&1 || exit 33
  fi
  systemctl --user daemon-reload >/dev/null 2>&1 || exit 34
  if [ -n "$changed" ] || ! runs_binary "$base/{hash}"; then
    rm -f -- "$base/state.json"
    systemctl --user enable soreno-remote.service >/dev/null 2>&1 && systemctl --user restart soreno-remote.service >/dev/null 2>&1 || exit 34
  else
    systemctl --user enable --now soreno-remote.service >/dev/null 2>&1 || exit 34
  fi
  i=0
  until systemctl --user is-active --quiet soreno-remote.service >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 25 ] || exit 35
    sleep 0.2
  done
else
  # Without systemd nothing ends the processes at logout, and an old unit is inert.
  rm -f -- "$unit" || exit 32
  take_lock 50 || exit 42
  command={command}
  changed=
  if [ "$(cat -- "$base/standalone" 2>/dev/null)" != "$command" ]; then
    t="$base/standalone.$$"
    printf '%s\n' "$command" > "$t" && mv -f -- "$t" "$base/standalone" || {{ rm -f -- "$t"; drop_lock; exit 32; }}
    changed=1
  fi
  if [ -n "$changed" ] || ! runs_binary "$base/{hash}"; then
    stop_standalone || {{ drop_lock; exit 43; }}
    rm -f -- "$base/state.json"
    start_standalone || {{ drop_lock; exit 40; }}
  fi
  drop_lock
  runs_binary "$base/{hash}" || exit 41
fi
if runs_binary "$base/{hash}"; then
  for old in "$base"/*; do
    [ -d "$old" ] && [ ! -L "$old" ] && [ "$old" != "$base/{hash}" ] && rm -rf -- "$old" || :
  done
fi
i=0
until grep -q '"connected": *true' "$base/state.json" 2>/dev/null; do
  [ -n "$systemd" ] || standalone_pid >/dev/null || exit 41
  i=$((i + 1))
  [ "$i" -le 50 ] || exit 39
  sleep 0.2
done
exit 0"#
    )
}

/// Restarts a standalone service that died, before a session starts; silent and best effort.
pub(super) fn revive_script() -> String {
    format!(
        r#"(
base="$HOME/.cache/soreno/remote"
[ -f "$base/standalone" ] || exit 0
umask 077
{SERVICE}
standalone_pid >/dev/null && exit 0
take_lock 5 || exit 0
if ! standalone_pid >/dev/null; then
  rm -f -- "$base/state.json"
  start_standalone
fi
drop_lock
) < /dev/null > /dev/null 2>&1 || :"#
    )
}

fn disable_script(https: Publication, link: Publication) -> String {
    let unpublish = unpublish_legacy(https, link);
    format!(
        r#"set -u
base="$HOME/.cache/soreno/remote"
unit="$HOME/.config/systemd/user/soreno-remote.service"
{SERVICE}
{unpublish}if [ -f "$base/standalone" ] || [ -f "$base/pid" ]; then
  take_lock 50 || exit 42
  stop_standalone || {{ drop_lock; exit 43; }}
  rm -f -- "$base/standalone"
fi
if [ -f "$unit" ] && command -v systemctl >/dev/null 2>&1 && ! systemctl --user disable --now soreno-remote.service >/dev/null 2>&1; then
  case "$(systemctl --user is-active soreno-remote.service 2>/dev/null)" in
    inactive|failed) ;;
    *) exit 38 ;;
  esac
fi
rm -f -- "$unit" || exit 36
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload >/dev/null 2>&1 || :
fi
rm -rf -- "$base" || exit 36
exit 0"#
    )
}

fn pair_script(x86_64: &str, aarch64: &str) -> String {
    let binary_path = binary_path(x86_64, aarch64);
    format!(
        r#"{binary_path}
[ -n "$hash" ] && [ -f "$bin" ] && [ -x "$bin" ] || exit 30
"$bin" pair || exit 50"#
    )
}

fn revoke_script(x86_64: &str, aarch64: &str, device: &str) -> String {
    let binary_path = binary_path(x86_64, aarch64);
    format!(
        r#"{binary_path}
[ -n "$hash" ] && [ -f "$bin" ] && [ -x "$bin" ] || exit 30
"$bin" revoke {device} >/dev/null || exit 51"#
    )
}

/// `received` is this desktop's clock when the output arrived: the server's may be off.
fn pairing(output: &[u8], origin: &str, received: u64) -> Result<SshMobilePairing> {
    let unexpected = || coded("pairing", "soreno-remote a renvoyé un appairage illisible.");
    let line = output
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    let pair = serde_json::from_slice::<PairOutput>(line).map_err(|_| unexpected())?;
    if !is_key(&pair.server) || !is_key(&pair.secret) || !is_hex_id(&pair.id) {
        return Err(unexpected());
    }
    let url = format!("{origin}/#p={}.{}", pair.server, pair.secret);
    let qr_svg = qr_svg(&url).ok_or_else(unexpected)?;
    Ok(SshMobilePairing {
        id: pair.id,
        url,
        qr_svg,
        expires_at: received + pair.expires_in_ms.min(PAIRING_LIFETIME_MS),
    })
}

fn failure(status: u8, stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr).trim().to_owned();
    let (code, message) = match status {
        20 => ("files", "Le dossier `~/.cache/soreno/remote` du serveur est refusé (lien symbolique ou droits insuffisants)."),
        23 => ("hash", "Le binaire soreno-remote transféré ne correspond pas à son empreinte SHA-256 (`sha256sum` ou `shasum` est requis sur le serveur)."),
        24 => ("binary", "Le binaire soreno-remote ne s’exécute pas sur ce serveur."),
        30 => ("binary", "Le binaire soreno-remote est absent du serveur : relancez l’activation."),
        31 => ("systemd", "systemd utilisateur est indisponible pour ce compte : `systemctl --user` doit fonctionner sur le serveur (session systemd utilisateur requise)."),
        32 | 36 => ("files", "Impossible d’écrire ou de supprimer les fichiers de l’accès mobile sur le serveur (`~/.config/systemd/user`, `~/.cache/soreno/remote`)."),
        33 => ("linger", "Impossible de maintenir le service après déconnexion : faites lancer `sudo loginctl enable-linger $USER` sur le serveur par un administrateur."),
        34 => ("start", "systemd n’a pas pu démarrer soreno-remote : consultez `systemctl --user status soreno-remote` sur le serveur."),
        35 => ("stopped", "Le service soreno-remote ne reste pas actif : consultez `journalctl --user -u soreno-remote` sur le serveur."),
        38 => ("stop", "systemd n’a pas pu arrêter soreno-remote ; le service et ses fichiers sont conservés : consultez `systemctl --user status soreno-remote` sur le serveur, puis réessayez."),
        39 => ("relay", "L’accès mobile est activé, mais le serveur ne joint pas encore le relais Soreno : vérifiez qu’il peut se connecter en sortie au port TCP 8790 de relay.soreno.dev, puis consultez `journalctl --user -u soreno-remote` (sans systemd : `~/.cache/soreno/remote/serve.log`)."),
        40 => ("launch", "Impossible de lancer soreno-remote sur ce serveur sans systemd : relancez l’activation."),
        41 => ("exited", "soreno-remote s’arrête dès son lancement : consultez `~/.cache/soreno/remote/serve.log` sur le serveur."),
        42 => ("busy", "Un autre démarrage de soreno-remote est en cours sur le serveur : réessayez dans un instant."),
        43 => ("kill", "soreno-remote ne s’arrête pas ; ses fichiers sont conservés : arrêtez le processus indiqué dans `~/.cache/soreno/remote/pid` sur le serveur, puis réessayez."),
        50 => ("pairing", "soreno-remote n’a pas pu créer de code d’appairage :"),
        51 => ("revoke", "soreno-remote n’a pas pu révoquer cet appareil :"),
        _ => {
            return format!("Connexion ou commande SSH échouée : {detail}");
        }
    };
    let message = coded(code, message);
    if matches!(code, "pairing" | "revoke") && !detail.is_empty() {
        format!("{message}\n{detail}")
    } else {
        message
    }
}

fn run(
    connection: &SshConnection,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<u8>> {
    let output = crate::ssh::run_output_with_timeout(connection, script, input, limit, timeout)?;
    if output.status == 0 {
        Ok(output.stdout)
    } else {
        Err(failure(output.status, &output.stderr))
    }
}

fn probe(connection: &SshConnection) -> Result<Probe> {
    let script = status_script(LINUX_X86_64.hash(), LINUX_AARCH64.hash());
    parse_status(
        &run(connection, &script, None, STATUS_LIMIT, crate::ssh::TIMEOUT)?,
        RELAY,
    )
}

pub(super) fn status(connection: &SshConnection) -> Result<SshMobileStatus> {
    Ok(probe(connection)?.status)
}

pub(super) fn enable(connection: &SshConnection) -> Result<SshMobileStatus> {
    let Probe {
        status,
        binary_current,
        https,
        link,
    } = probe(connection)?;
    require_supported(&status)?;
    let binary = embedded(&status.platform).ok_or("Plateforme du serveur inattendue.")?;
    if !binary_current {
        run(
            connection,
            &install_script(binary.hash()),
            Some(binary.bytes),
            SCRIPT_LIMIT,
            INSTALL_TIMEOUT,
        )?;
    }
    run(
        connection,
        &activation_script(binary.hash(), RELAY, https, link),
        None,
        SCRIPT_LIMIT,
        ACTIVATION_TIMEOUT,
    )?;
    self::status(connection)
}

pub(super) fn disable(connection: &SshConnection) -> Result<SshMobileStatus> {
    // An unreadable status still stops the service; only the legacy publications stay.
    let (https, link) = probe(connection)
        .map_or((Publication::Absent, Publication::Absent), |probe| {
            (probe.https, probe.link)
        });
    run(
        connection,
        &disable_script(https, link),
        None,
        SCRIPT_LIMIT,
        ACTIVATION_TIMEOUT,
    )?;
    status(connection)
}

pub(super) fn pair(connection: &SshConnection) -> Result<SshMobilePairing> {
    let output = run(
        connection,
        &pair_script(LINUX_X86_64.hash(), LINUX_AARCH64.hash()),
        None,
        SCRIPT_LIMIT,
        crate::ssh::TIMEOUT,
    )?;
    let received = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    pairing(&output, RELAY_ORIGIN, received)
}

fn require_device_id(device: &str) -> Result<()> {
    if is_hex_id(device) {
        Ok(())
    } else {
        Err(coded("revoke", "Identifiant d’appareil invalide."))
    }
}

pub(super) fn revoke(connection: &SshConnection, device: &str) -> Result<SshMobileStatus> {
    require_device_id(device)?;
    run(
        connection,
        &revoke_script(LINUX_X86_64.hash(), LINUX_AARCH64.hash(), device),
        None,
        SCRIPT_LIMIT,
        crate::ssh::TIMEOUT,
    )?;
    status(connection)
}

#[cfg(all(test, unix))]
#[path = "remote_mobile_tests.rs"]
mod tests;
