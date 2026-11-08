use super::{command, openssh_unavailable, timed_out, Result, SshConnection, SshOutput};
use crate::process_owner::ProcessOwner;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError,
    },
    thread,
    time::Duration,
};

mod frames;
use frames::{parse_cancel_header, parse_header, read_header};

const RELAY_LIMIT: usize = 8;
const SCRIPT_LIMIT: usize = 1024 * 1024;
const INPUT_LIMIT: usize = 32 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
const HEADER_LIMIT: usize = 256;

pub(super) const RELAY_SCRIPT: &str = r#"
umask 077
root=$(mktemp -d "${TMPDIR:-/tmp}/soreno-ssh-relay.XXXXXXXX") || exit 70
printf '%s\n' "$$" > "$root/owner" || { rm -rf -- "$root"; exit 70; }
if command -v setsid >/dev/null 2>&1; then has_setsid=1; else has_setsid=0; fi
freeze_tree() {
  kill -STOP "$1" 2>/dev/null || return
  ps -A -o pid= -o ppid= 2>/dev/null | while read -r child parent; do
    [ "$parent" = "$1" ] && freeze_tree "$child" "$2"
  done
  printf '%s\n' "$1" >> "$2"
}
remember_marked() (
  token=$1
  list=$2
  snapshot=$3
  ps axeww -o pid= -o stat= -o command= > "$snapshot" 2>/dev/null || return 1
  while read -r target state command; do
    case "$state:$command " in
      Z*:*) ;;
      *:*" SORENO_RELAY_REQUEST=$token "*) printf '%s\n' "$target" >> "$list";;
    esac
  done < "$snapshot"
)
is_live() {
  state=$(ps -o stat= -p "$1" 2>/dev/null || :)
  case "$state" in ''|Z*) return 1;; *) return 0;; esac
}
group_is_live() {
  group=$1
  snapshot=$2
  ps -A -o pgid= -o stat= > "$snapshot" 2>/dev/null || return 0
  awk -v group="$group" '$1 == group && $2 !~ /^Z/ { found=1; exit } END { exit !found }' < "$snapshot"
}
stop_request() {
  id=$1
  pid_file="$root/$id.pid"; pgid_file="$root/$id.pgid"
  list="$root/$id.pids"; marked="$root/$id.marked"; tmp="$root/$id.tmp"
  inventory="$root/$id.ps"; group_snapshot="$root/$id.group.ps"
  token="${root##*/}.$id."
  if [ -s "$pgid_file" ]; then pgid=$(cat "$pgid_file" 2>/dev/null || :); else pgid=; fi
  [ -z "$pgid" ] || kill -STOP "-$pgid" 2>/dev/null || :
  : > "$list"
  if [ -s "$pid_file" ]; then pid=$(cat "$pid_file" 2>/dev/null || :); else pid=; fi
  [ -z "$pid" ] || freeze_tree "$pid" "$list"
  : > "$marked"
  remember_marked "$token" "$marked" "$inventory" || return 1
  while read -r target; do freeze_tree "$target" "$list"; done < "$marked"
  [ -z "$pgid" ] || kill -KILL "-$pgid" 2>/dev/null || :
  while read -r target; do kill -KILL "$target" 2>/dev/null || :; done < "$list"
  [ -z "$pid" ] || wait "$pid" 2>/dev/null || :
  attempts=0
  while [ "$attempts" -lt 100 ]; do
    alive=0
    [ -z "$pgid" ] || ! group_is_live "$pgid" "$group_snapshot" || alive=1
    while read -r target; do is_live "$target" && alive=1; done < "$list"
    : > "$marked"
    remember_marked "$token" "$marked" "$inventory" || return 1
    [ ! -s "$marked" ] || alive=1
    [ "$alive" -eq 0 ] && break
    attempts=$((attempts + 1))
    sleep 0.01
  done
  [ "$alive" -eq 0 ] || return 1
  if [ -e "$root/lock" ]; then
    owner=$(cat "$root/lock" 2>/dev/null || :)
    owner=${owner%% *}
    if [ -z "$owner" ] || [ "$owner" = "$id" ]; then rm -f -- "$root/lock"; fi
  fi
  rm -f -- "$root/$id."* 2>/dev/null || :
  rm -rf -- "$tmp"
}
lock() {
  lock_owner=$1
  lock_pid=$2
  lock_waits=0
  # Noclobber creates with O_EXCL in the shell itself: some mkdir(1) builds exit 0 when a racing mkdir won.
  # shortcut: a failed owner write (full /tmp) leaves an empty lock that blocks this relay until it is restarted; split create and write if that shows up.
  while ! (set -C; printf '%s %s\n' "$lock_owner" "$lock_pid" > "$root/lock") 2>/dev/null; do
    lock_waits=$((lock_waits + 1))
    if [ $((lock_waits % 50)) -eq 0 ]; then
      if [ "$lock_pid" = "$$" ]; then
        reclaim_dead_lock
      else
        # Orphaned by a dead relay: nobody would ever read the response.
        kill -0 "$$" 2>/dev/null || exit 75
      fi
    fi
    sleep 0.01
  done
}
# Reclaim only a gone or zombie owner whose complete record is unchanged on re-read; main shell only.
reclaim_dead_lock() {
  IFS= read -r holder 2>/dev/null < "$root/lock" || return 0
  holder_pid=${holder##* }
  case $holder_pid in ''|*[!0-9]*) return 0;; esac
  # A SIGPIPE-killed writer stays a signalable zombie until reaped; a failing ps keeps the lock.
  if kill -0 "$holder_pid" 2>/dev/null; then
    holder_state=$(ps -o stat= -p "$holder_pid" 2>/dev/null) || return 0
    holder_state=${holder_state#"${holder_state%%[! ]*}"}
    case $holder_state in Z*) ;; *) return 0;; esac
  fi
  IFS= read -r holder_again 2>/dev/null < "$root/lock" || return 0
  [ "$holder_again" = "$holder" ] || return 0
  rm -f -- "$root/lock"
}
unlock() {
  rm -f -- "$root/lock"
}
cancel_request() {
  id=$1
  lock "C$id" "$$"
  if stop_request "$id"; then
    trap '' PIPE
    printf 'X %s\n' "$id"
    trap - PIPE
    unlock
  else
    unlock
    exit 74
  fi
}
cleanup() {
  for pid_file in "$root"/*.pid; do
    [ -f "$pid_file" ] || continue
    id=${pid_file##*/}; id=${id%.pid}
    stop_request "$id"
  done
  wait 2>/dev/null || :
  rm -rf -- "$root"
}
trap cleanup 0
trap 'exit 129' HUP INT TERM
# Relays a dead connection left behind: nobody reads them, and older versions spin on their lock.
# `telaoi-ssh-relay` marks relays started before the Soreno rename.
# A relay's topmost relay ancestor is adopted by init (or a systemd subreaper) once its SSH
# session is gone; a connected one still has sshd, or the login shell, as parent.
reap_orphan_relays() {
  # procps and BSD ps cut args at $COLUMNS even into a file.
  unset COLUMNS
  tree="$root/reap.tree"; args="$root/reap.args"
  ps -A -o pid= -o ppid= -o comm= > "$tree" 2>/dev/null &&
    ps -A -o pid= -o args= > "$args" 2>/dev/null || return 0
  awk -v self="$$" '
    FNR == NR { parent[$1] = $2; name = $3; sub(/.*\//, "", name); comm[$1] = name; next }
    $2 ~ /(^|\/)sh$/ && $3 == "-c" && (index($0, "/soreno-ssh-relay.XXXXXXXX") || index($0, "/telaoi-ssh-relay.XXXXXXXX")) { relay[$1] = 1 }
    END {
      for (pid in relay) {
        top = pid
        while (parent[top] in relay) top = parent[top]
        up = parent[top]
        if (top != self && (up == 1 || comm[up] == "systemd" || comm[up] == "launchd" || comm[up] == "init")) print pid
      }
    }' "$tree" "$args" | while read -r orphan; do kill -KILL "$orphan" 2>/dev/null || :; done
  rm -f -- "$tree" "$args"
  # A SIGKILLed relay skips its exit trap, which may leave requests frozen mid-cancellation: redo
  # that cleanup for any relay whose owner is gone. Finished requests, and their daemons, stay.
  stale_roots="$root/reap.stale"; tokens="$root/reap.tokens"; supervisors="$root/reap.supervisors"
  inventory="$root/reap.ps"; targets="$root/reap.targets"
  : > "$stale_roots" && : > "$tokens" && : > "$supervisors" || return 0
  for stale in "${root%.*}".* "${root%/*}"/telaoi-ssh-relay.*; do
    [ "$stale" != "$root" ] || continue
    IFS= read -r relay_pid < "$stale/owner" || continue
    case $relay_pid in ''|*[!0-9]*) continue;; esac
    if kill -0 "$relay_pid" 2>/dev/null; then
      relay_state=$(ps -o stat= -p "$relay_pid" 2>/dev/null) || continue
      relay_state=${relay_state#"${relay_state%%[! ]*}"}
      case $relay_state in Z*) ;; *) continue;; esac
    fi
    printf '%s\n' "$stale" >> "$stale_roots" || return 0
    for pid_file in "$stale"/*.pid; do
      [ -f "$pid_file" ] || continue
      id=${pid_file##*/}; id=${id%.pid}
      printf ' SORENO_RELAY_REQUEST=%s.%s. \n' "${stale##*/}" "$id" >> "$tokens" || return 0
      supervisor=$(cat "$pid_file" 2>/dev/null) || return 0
      case $supervisor in ''|*[!0-9]*) ;; *) printf '%s\n' "$supervisor" >> "$supervisors" || return 0;; esac
    done
  done
  # Marked processes may fork after a snapshot, and the root holds their only record: retry.
  attempts=0
  while [ -s "$tokens" ]; do
    ps axeww -o pid= -o ppid= -o stat= -o command= > "$inventory" 2>/dev/null || return 0
    # A supervisor is unmarked: take it, and its tree, only if stopped, a relay's and orphaned.
    awk 'FILENAME == ARGV[1] { token[$0] = 1; next }
      FILENAME == ARGV[2] { supervisor[$1] = 1; next }
      {
        parent[$1] = $2; state[$1] = $3; line = $0 " "
        if (index(line, "/soreno-ssh-relay.XXXXXXXX") || index(line, "/telaoi-ssh-relay.XXXXXXXX")) relay[$1] = 1
        for (t in token) if (index(line, t)) { marked[$1] = 1; break }
      }
      END {
        for (pid in supervisor)
          if ((pid in parent) && state[pid] ~ /^T/ && (pid in relay) && !(parent[pid] in relay)) tree[pid] = 1
        do {
          grown = 0
          for (pid in parent) if (!(pid in tree) && (parent[pid] in tree)) { tree[pid] = 1; grown = 1 }
        } while (grown)
        for (pid in parent) if (state[pid] !~ /^Z/ && ((pid in marked) || (pid in tree))) print pid
      }' "$tokens" "$supervisors" "$inventory" > "$targets" || return 0
    [ -s "$targets" ] || break
    [ "$attempts" -lt 100 ] || return 0
    while read -r target; do kill -KILL "$target" 2>/dev/null || :; done < "$targets"
    attempts=$((attempts + 1))
    sleep 0.01
  done
  while IFS= read -r stale; do rm -rf -- "$stale"; done < "$stale_roots"
  rm -f -- "$stale_roots" "$tokens" "$supervisors" "$inventory" "$targets"
}
reap_orphan_relays < /dev/null > /dev/null 2>&1 &
read_exact() {
  target=$1
  remaining=$2
  chunk=$3
  : > "$target" || return 1
  while [ "$remaining" -gt 0 ]; do
    if [ "$remaining" -gt 65536 ]; then wanted=65536; else wanted=$remaining; fi
    dd bs="$wanted" count=1 of="$chunk" 2>/dev/null || return 1
    got=$(wc -c < "$chunk") || return 1
    got=$((got + 0))
    [ "$got" -gt 0 ] && [ "$got" -le "$wanted" ] || return 1
    cat "$chunk" >> "$target" || return 1
    remaining=$((remaining - got))
  done
  rm -f -- "$chunk"
}
while IFS= read -r header; do
  old_ifs=$IFS
  IFS=' '
  set -- $header
  IFS=$old_ifs
  case "$1:$#" in
    C:2)
      case "$2" in ''|*[!0-9]*) exit 71;; esac
      cancel_request "$2"
      continue
      ;;
    R:5)
      [ "$header" = "R $2 $3 $4 $5" ] || exit 71
      case "$2$3$4$5" in ''|*[!0-9]*) exit 71;; esac
      ;;
    *) exit 71;;
  esac
  id=$2; script_len=$3; input_len=$4; output_limit=$5
  [ ${#id} -le 20 ] && [ "$script_len" -le 1048576 ] && [ "$input_len" -le 33554432 ] && [ "$output_limit" -le 8388608 ] || exit 71
  script="$root/$id.script"; input="$root/$id.input"; chunk="$root/$id.chunk"; start="$root/$id.start"
  request_tmp="$root/$id.tmp"
  read_exact "$script" "$script_len" "$chunk" && read_exact "$input" "$input_len" "$chunk" || exit 72
  mkdir "$request_tmp" && mkfifo "$start" || exit 73
  (
    read -r _ < "$start" || exit 73
    rm -f -- "$start"
    read -r self < "$root/$id.pid" || exit 73
    TMPDIR="$request_tmp"; export TMPDIR
    # Marks every command of the request, output readers included, for its cancellation.
    SORENO_RELAY_REQUEST="${root##*/}.$id."; export SORENO_RELAY_REQUEST
    stdout="$root/$id.stdout"; stderr="$root/$id.stderr"
    stdout_pipe="$root/$id.stdout.pipe"; stderr_pipe="$root/$id.stderr.pipe"
    : > "$stdout" && : > "$stderr" && mkfifo "$stdout_pipe" "$stderr_pipe" || exit 73
    blocks=$((output_limit / 512 + 1))
    (ulimit -f "$blocks"; cat < "$stdout_pipe" > "$stdout") 2>/dev/null & stdout_pid=$!
    (ulimit -f 129; cat < "$stderr_pipe" > "$stderr") 2>/dev/null & stderr_pid=$!
    if [ "$has_setsid" -eq 1 ]; then
      setsid sh "$script" < "$input" > "$stdout_pipe" 2> "$stderr_pipe" & command_pid=$!
      printf '%s\n' "$command_pid" > "$root/$id.pgid"
    else
      sh "$script" < "$input" > "$stdout_pipe" 2> "$stderr_pipe" & command_pid=$!
    fi
    wait "$command_pid" 2>/dev/null; status=$?
    wait "$stdout_pid" 2>/dev/null; stdout_status=$?
    wait "$stderr_pid" 2>/dev/null; stderr_status=$?
    if [ "$stdout_status" -eq 0 ] && [ "$stderr_status" -eq 0 ]; then capture_status=0; else capture_status=1; fi
    stdout_len=$(wc -c < "$stdout") || exit 73
    stderr_len=$(wc -c < "$stderr") || exit 73
    stdout_len=$((stdout_len + 0)); stderr_len=$((stderr_len + 0))
    rm -f -- "$script" "$input" "$stdout_pipe" "$stderr_pipe"
    rm -rf -- "$request_tmp"
    # A closed connection fails the write instead of killing the lock holder.
    trap '' PIPE
    lock "$id" "$self"
    printf 'S %s %s %s %s %s\n' "$id" "$status" "$stdout_len" "$stderr_len" "$capture_status" &&
      cat "$stdout" "$stderr"
    response_status=$?
    unlock
    rm -f -- "$root/$id.pid" "$root/$id.pgid" "$stdout" "$stderr"
    exit "$response_status"
  ) &
  pid=$!
  printf '%s\n' "$pid" > "$root/$id.pid"
  printf 'start\n' > "$start"
done
"#;

struct Pending {
    limit: usize,
    sender: mpsc::Sender<Result<SshOutput>>,
}

struct OwnedChild {
    child: Child,
    owner: ProcessOwner,
}

struct Relay {
    generation: u64,
    alive: AtomicBool,
    // A relay that answered once proved its connection; a later death is a dropped link.
    served: AtomicBool,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, Pending>>,
    cancellations: Mutex<HashMap<u64, mpsc::Sender<()>>>,
    stderr: Mutex<Vec<u8>>,
    child: Mutex<Option<OwnedChild>>,
}

struct RegistryEntry {
    connection: SshConnection,
    relay: Arc<Relay>,
}

static REGISTRY: OnceLock<Mutex<VecDeque<RegistryEntry>>> = OnceLock::new();
static SHUT_DOWN: AtomicBool = AtomicBool::new(false);
static ACCESS: OnceLock<(Mutex<Access>, Condvar)> = OnceLock::new();
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
#[cfg(test)]
static TEST_RUN_GATE: Mutex<Option<TestRunGate>> = Mutex::new(None);
#[cfg(test)]
struct TestRunGate {
    connection: SshConnection,
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
}

#[derive(Default)]
struct Access {
    blocked: HashSet<SshConnection>,
    active: HashMap<SshConnection, usize>,
}

pub(crate) struct RunGuard {
    connection: SshConnection,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let (access, changed) = access();
        let mut access = lock(access);
        if let Some(count) = access.active.get_mut(&self.connection) {
            *count -= 1;
            if *count == 0 {
                access.active.remove(&self.connection);
                changed.notify_all();
            }
        }
    }
}

fn registry() -> &'static Mutex<VecDeque<RegistryEntry>> {
    REGISTRY.get_or_init(Mutex::default)
}

fn access() -> &'static (Mutex<Access>, Condvar) {
    ACCESS.get_or_init(|| (Mutex::new(Access::default()), Condvar::new()))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(super) fn begin_run(connection: &SshConnection) -> Result<RunGuard> {
    let mut access = lock(&access().0);
    if access.blocked.contains(connection) {
        return Err("Connexion SSH bloquée : reconnectez explicitement le projet.".into());
    }
    *access.active.entry(connection.clone()).or_default() += 1;
    Ok(RunGuard {
        connection: connection.clone(),
    })
}

fn validate_request(script: &str, input: Option<&[u8]>, limit: usize) -> Result<()> {
    if script.contains('\0') {
        return Err("Commande SSH contenant un caractère nul.".into());
    }
    if script.len() > SCRIPT_LIMIT
        || limit > OUTPUT_LIMIT
        || input.is_some_and(|bytes| bytes.len() > INPUT_LIMIT)
    {
        return Err("Commande SSH trop volumineuse.".into());
    }
    Ok(())
}

pub(super) fn run(
    connection: &SshConnection,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
    timeout: Duration,
    idempotent: bool,
) -> Result<SshOutput> {
    validate_request(script, input, limit)?;
    let _guard = begin_run(connection)?;
    #[cfg(test)]
    if let Some(gate) = lock(&TEST_RUN_GATE)
        .take()
        .filter(|gate| gate.connection == *connection)
    {
        gate.entered.wait();
        gate.release.wait();
    }
    request_with_reconnect(
        || relay(connection),
        script.as_bytes(),
        input.unwrap_or_default(),
        limit,
        timeout,
        idempotent,
    )
}

// After sleep or a network change, the first request finds the established connection dead;
// only an idempotent request may be replayed, once, on a fresh connection.
fn request_with_reconnect(
    mut relay: impl FnMut() -> Result<Arc<Relay>>,
    script: &[u8],
    input: &[u8],
    limit: usize,
    timeout: Duration,
    idempotent: bool,
) -> Result<SshOutput> {
    let deadline = std::time::Instant::now() + timeout;
    let first = relay()?;
    match first.request(script, input, limit, timeout) {
        Err(error) if idempotent && first.dropped_after_serving(&error) => {
            let fresh = relay()?;
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(error);
            }
            fresh.request(script, input, limit, remaining)
        }
        result => result,
    }
}

pub(super) fn block(connection: &SshConnection) {
    let (access, changed) = access();
    let mut state = lock(access);
    state.blocked.insert(connection.clone());
    while state.active.get(connection).copied().unwrap_or_default() != 0 {
        state = changed
            .wait(state)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}

pub(super) fn unblock(connection: &SshConnection) {
    lock(&access().0).blocked.remove(connection);
}

pub(super) fn is_blocked(connection: &SshConnection) -> bool {
    lock(&access().0).blocked.contains(connection)
}

fn insert_relay(
    entries: &mut VecDeque<RegistryEntry>,
    connection: SshConnection,
    relay: Arc<Relay>,
) -> Option<Arc<Relay>> {
    let evicted = (entries.len() == RELAY_LIMIT)
        .then(|| entries.pop_front().map(|entry| entry.relay))
        .flatten();
    entries.push_back(RegistryEntry { connection, relay });
    evicted
}

fn relay(connection: &SshConnection) -> Result<Arc<Relay>> {
    let evicted;
    let result = {
        let mut entries = lock(registry());
        if SHUT_DOWN.load(Ordering::Acquire) {
            return Err("Transport SSH arrêté.".into());
        }
        if let Some(index) = entries
            .iter()
            .position(|entry| entry.connection == *connection && entry.relay.is_alive())
        {
            let entry = entries.remove(index).expect("entrée de relais présente");
            let relay = Arc::clone(&entry.relay);
            entries.push_back(entry);
            return Ok(relay);
        }
        entries.retain(|entry| entry.relay.is_alive());
        let relay = Relay::spawn(command(connection, RELAY_SCRIPT)?, true)?;
        evicted = insert_relay(&mut entries, connection.clone(), Arc::clone(&relay));
        relay
    };
    drop(evicted);
    Ok(result)
}

impl Relay {
    fn spawn(mut command: Command, count_process: bool) -> Result<Arc<Self>> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        ProcessOwner::configure(&mut command);
        let mut child = command.spawn().map_err(openssh_unavailable)?;
        if count_process {
            super::record_test_process();
        }
        let owner = match ProcessOwner::new(&child) {
            Ok(owner) => owner,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or("Entrée du relais SSH indisponible.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Sortie du relais SSH indisponible.")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Erreurs du relais SSH indisponibles.")?;
        let relay = Arc::new(Self {
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            alive: AtomicBool::new(true),
            served: AtomicBool::new(false),
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            stderr: Mutex::new(Vec::new()),
            child: Mutex::new(Some(OwnedChild { child, owner })),
        });
        let weak = Arc::downgrade(&relay);
        thread::spawn(move || reader(weak, stdout));
        let weak = Arc::downgrade(&relay);
        thread::spawn(move || drain_stderr(weak, stderr));
        Ok(relay)
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn dropped_after_serving(&self, error: &str) -> bool {
        self.served.load(Ordering::Acquire) && !self.is_alive() && !error.starts_with(&timed_out())
    }

    #[cfg(all(test, unix))]
    fn close_input(&self) {
        lock(&self.stdin).take();
    }

    fn request(
        self: &Arc<Self>,
        script: &[u8],
        input: &[u8],
        limit: usize,
        timeout: Duration,
    ) -> Result<SshOutput> {
        if !self.is_alive() {
            return Err("Connexion SSH interrompue.".into());
        }
        let id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        lock(&self.pending).insert(id, Pending { limit, sender });
        let deadline = std::time::Instant::now() + timeout;
        let relay = Arc::clone(self);
        let script = script.to_vec();
        let input = input.to_vec();
        let (write_sender, write_receiver) = mpsc::channel();
        thread::spawn(move || {
            let result = (|| {
                let mut stdin = relay
                    .stdin
                    .lock()
                    .map_err(|_| "Entrée du relais SSH indisponible.".to_string())?;
                let stdin = stdin
                    .as_mut()
                    .ok_or_else(|| "Entrée du relais SSH fermée.".to_string())?;
                write!(stdin, "R {id} {} {} {limit}\n", script.len(), input.len())
                    .and_then(|_| stdin.write_all(&script))
                    .and_then(|_| stdin.write_all(&input))
                    .and_then(|_| stdin.flush())
                    .map_err(|error| format!("Écriture vers le relais SSH impossible : {error}"))
            })();
            let _ = write_sender.send(result);
        });
        match write_receiver
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                self.fail(error.clone());
                return Err(error);
            }
            Err(_) => {
                let error = timed_out();
                self.fail(error.clone());
                return Err(error);
            }
        }
        match receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
            Ok(response) => response,
            Err(_) => {
                lock(&self.pending).remove(&id);
                let error = timed_out();
                let relay = Arc::clone(self);
                thread::spawn(move || {
                    if let Err(cancel_error) = relay.cancel(id) {
                        relay.fail(cancel_error);
                    }
                });
                Err(error)
            }
        }
    }

    fn cancel(&self, id: u64) -> Result<()> {
        let (sender, receiver) = mpsc::channel();
        lock(&self.cancellations).insert(id, sender);
        let write_result = (|| {
            let mut stdin = self
                .stdin
                .lock()
                .map_err(|_| "Entrée du relais SSH indisponible.".to_string())?;
            let stdin = stdin
                .as_mut()
                .ok_or_else(|| "Entrée du relais SSH fermée.".to_string())?;
            writeln!(stdin, "C {id}")
                .and_then(|_| stdin.flush())
                .map_err(|error| format!("Annulation SSH impossible : {error}"))
        })();
        if let Err(error) = write_result {
            lock(&self.cancellations).remove(&id);
            return Err(error);
        }
        // Without setsid, the relay walks the process tree one `ps` per level: slow on loaded hosts.
        if receiver.recv_timeout(Duration::from_secs(10)).is_err() {
            lock(&self.cancellations).remove(&id);
            return Err("Annulation SSH non confirmée.".into());
        }
        Ok(())
    }

    fn fail(&self, error: String) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        let detail = lock(&self.stderr);
        let error = if detail.is_empty() {
            error
        } else {
            format!("{error}\n{}", String::from_utf8_lossy(&detail).trim())
        };
        drop(detail);
        for (_, pending) in lock(&self.pending).drain() {
            let _ = pending.sender.send(Err(error.clone()));
        }
        for (_, cancellation) in lock(&self.cancellations).drain() {
            let _ = cancellation.send(());
        }
        self.terminate();
        remove(self.generation);
    }

    fn terminate(&self) {
        if let Some(mut owned) = lock(&self.child).take() {
            owned
                .owner
                .terminate(&mut owned.child, Duration::from_secs(1));
        }
        if let Ok(mut stdin) = self.stdin.try_lock() {
            stdin.take();
        }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.stdin
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(mut owned) = self
            .child
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            owned
                .owner
                .terminate(&mut owned.child, Duration::from_secs(1));
        }
    }
}

fn reader(relay: std::sync::Weak<Relay>, stdout: impl Read) {
    let mut stdout = BufReader::new(stdout);
    loop {
        let header = match read_header(&mut stdout) {
            Ok(header) => header,
            Err(error) => {
                if let Some(relay) = relay.upgrade() {
                    relay.fail(error);
                }
                return;
            }
        };
        let Some(relay) = relay.upgrade() else {
            return;
        };
        if header.starts_with(b"X ") {
            let id = match parse_cancel_header(&header) {
                Ok(id) => id,
                Err(error) => {
                    relay.fail(error);
                    return;
                }
            };
            if let Some(sender) = lock(&relay.cancellations).remove(&id) {
                let _ = sender.send(());
            }
            continue;
        }
        let (id, status, stdout_len, stderr_len, capture_failed) = match parse_header(&header) {
            Ok(values) => values,
            Err(error) => {
                relay.fail(error);
                return;
            }
        };
        if stdout_len > OUTPUT_LIMIT + 512 || stderr_len > STDERR_LIMIT + 512 {
            relay.fail("Réponse SSH excessivement volumineuse.".into());
            return;
        }
        let mut response = SshOutput {
            status,
            stdout: vec![0; stdout_len],
            stderr: vec![0; stderr_len],
        };
        if stdout
            .read_exact(&mut response.stdout)
            .and_then(|_| stdout.read_exact(&mut response.stderr))
            .is_err()
        {
            relay.fail("Réponse SSH incomplète.".into());
            return;
        }
        relay.served.store(true, Ordering::Release);
        if let Some(pending) = lock(&relay.pending).remove(&id) {
            let result = if capture_failed
                || response.stdout.len() > pending.limit
                || response.stderr.len() > STDERR_LIMIT
            {
                Err("Réponse SSH trop volumineuse ou capture interrompue.".into())
            } else {
                Ok(response)
            };
            let _ = pending.sender.send(result);
        };
    }
}

fn drain_stderr(relay: std::sync::Weak<Relay>, mut stderr: impl Read) {
    let mut buffer = [0; 8192];
    loop {
        let read = match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        let Some(relay) = relay.upgrade() else {
            return;
        };
        let mut captured = lock(&relay.stderr);
        let remaining = STDERR_LIMIT.saturating_sub(captured.len());
        captured.extend_from_slice(&buffer[..read.min(remaining)]);
    }
}

fn remove(generation: u64) {
    lock(registry()).retain(|entry| entry.relay.generation != generation);
}

pub(super) fn close(connection: &SshConnection) {
    let relays = {
        let mut entries = lock(registry());
        let mut relays = Vec::new();
        entries.retain(|entry| {
            if entry.connection == *connection {
                relays.push(Arc::clone(&entry.relay));
                false
            } else {
                true
            }
        });
        relays
    };
    for relay in relays {
        relay.fail("Connexion SSH fermée.".into());
    }
}

pub(super) fn shutdown() {
    let relays = {
        let mut entries = lock(registry());
        SHUT_DOWN.store(true, Ordering::Release);
        entries
            .drain(..)
            .map(|entry| entry.relay)
            .collect::<Vec<_>>()
    };
    for relay in relays {
        relay.fail("Arrêt du transport SSH.".into());
    }
}

#[cfg(test)]
pub(super) fn reset_test_relays() {
    shutdown();
    {
        let _entries = lock(registry());
        SHUT_DOWN.store(false, Ordering::Release);
    }
    let mut access = lock(&access().0);
    access.blocked.clear();
    access.active.clear();
    lock(&TEST_RUN_GATE).take();
    NEXT_REQUEST.store(1, Ordering::Relaxed);
}

#[cfg(all(test, unix))]
#[path = "relay_tests.rs"]
mod tests;
