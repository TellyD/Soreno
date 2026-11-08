use super::{
    process_io::{drain_pipe, spawn_io, stop_io, Captured, IoThread},
    read_timeout_error, GitError, GitOutput, ProcessOwner,
};
use crate::agent_sessions::AgentProject;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender, TryRecvError, TrySendError},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

#[path = "wsl_read/admission.rs"]
mod admission;

#[path = "wsl_read/protocol.rs"]
mod protocol;

#[path = "wsl_read/relay_spec.rs"]
mod relay_spec;

use admission::{Admission, AdmissionPermit};
#[cfg(test)]
use protocol::RESPONSE_FRAME_LIMIT;
use protocol::{decode_capture, read_response_frame, WireRequest, WireResponse};
use relay_spec::{relay_spec, RelaySpec};

const DISPLAY_BUDGET: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const FALLBACK_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_SCOPES: usize = 4;
const MAX_REQUESTS_PER_SCOPE: usize = 4;
const STDIN_LIMIT: usize = 8 * 1024 * 1024;
const STDOUT_LIMIT: usize = 8 * 1024 * 1024;
const STDERR_LIMIT: usize = 256 * 1024;
const REQUEST_FRAME_LIMIT: usize = 12 * 1024 * 1024;
const RELAY_SOURCE: &[u8] = include_bytes!("wsl_read.py");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PoolPolicy {
    Foreground,
    Background,
}

thread_local! {
    static DISPLAY_SCOPE: RefCell<Option<ScopeKey>> = const { RefCell::new(None) };
    static POOL_POLICY: Cell<PoolPolicy> = const { Cell::new(PoolPolicy::Foreground) };
}

struct DisplayGuard {
    scope: Option<ScopeKey>,
    policy: PoolPolicy,
}

impl Drop for DisplayGuard {
    fn drop(&mut self) {
        DISPLAY_SCOPE.with(|scope| *scope.borrow_mut() = self.scope.take());
        POOL_POLICY.with(|policy| policy.set(self.policy));
    }
}

fn with_display_scope<T>(
    project: &AgentProject,
    policy: PoolPolicy,
    read: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    let previous_scope = DISPLAY_SCOPE.with(|scope| scope.replace(Some(ScopeKey::from(project))));
    let previous_policy = POOL_POLICY.with(|current| current.replace(policy));
    let _guard = DisplayGuard {
        scope: previous_scope,
        policy: previous_policy,
    };
    read()
}

pub(super) fn with_display_reads<T>(
    project: &AgentProject,
    read: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    with_display_scope(project, PoolPolicy::Foreground, || {
        super::with_read_budget(DISPLAY_BUDGET, read)
    })
}

pub(super) fn with_foreground_transport<T>(
    project: &AgentProject,
    operation: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    with_display_scope(project, PoolPolicy::Foreground, operation)
}

pub(super) fn with_background_display_reads<T>(
    project: &AgentProject,
    read: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    with_display_scope(project, PoolPolicy::Background, read)
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ScopeKey {
    id: String,
    path: String,
    environment: String,
    distribution: Option<String>,
}

impl From<&AgentProject> for ScopeKey {
    fn from(project: &AgentProject) -> Self {
        Self {
            id: project.id.clone(),
            path: project.path.clone(),
            environment: project.environment.kind.clone(),
            distribution: project.environment.distribution.clone(),
        }
    }
}

struct PoolEntry {
    sender: SyncSender<WorkerMessage>,
    liveness: Arc<Liveness>,
    stopping: AtomicBool,
    admission: Arc<Admission>,
}

#[derive(Default)]
struct Liveness {
    alive: Mutex<bool>,
    stopped: Condvar,
}

impl Liveness {
    fn new() -> Self {
        Self {
            alive: Mutex::new(true),
            stopped: Condvar::new(),
        }
    }

    fn is_alive(&self) -> bool {
        *self
            .alive
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wait_stopped(&self, deadline: Instant) -> bool {
        let mut alive = self
            .alive
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while *alive {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let waited = self
                .stopped
                .wait_timeout(alive, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            alive = waited.0;
            if waited.1.timed_out() && *alive {
                return false;
            }
        }
        true
    }
}

struct Pool {
    entries: HashMap<ScopeKey, Arc<PoolEntry>>,
}

struct PoolState {
    pool: Mutex<Pool>,
    available: Condvar,
}

fn pool_state() -> &'static PoolState {
    static POOL: OnceLock<PoolState> = OnceLock::new();
    POOL.get_or_init(|| PoolState {
        pool: Mutex::new(Pool {
            entries: HashMap::new(),
        }),
        available: Condvar::new(),
    })
}

const JOB_WAITING: u8 = 0;
const JOB_TRANSMISSION_POSSIBLE: u8 = 1;
const JOB_TERMINAL: u8 = 2;
const JOB_CANCELLED: u8 = 3;

struct JobState(AtomicU8);

impl JobState {
    fn new() -> Self {
        Self(AtomicU8::new(JOB_WAITING))
    }

    fn transmission_possible(&self) -> bool {
        self.0
            .compare_exchange(
                JOB_WAITING,
                JOB_TRANSMISSION_POSSIBLE,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn cancel_and_mutation_uncertain(&self) -> bool {
        self.0
            .compare_exchange(
                JOB_WAITING,
                JOB_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err_and(|state| state == JOB_TRANSMISSION_POSSIBLE)
    }

    fn terminal(&self) {
        self.0.store(JOB_TERMINAL, Ordering::Release);
    }

    fn mutation_uncertain(&self) -> bool {
        self.0.load(Ordering::Acquire) == JOB_TRANSMISSION_POSSIBLE
    }
}

struct Job {
    id: u64,
    args: Vec<String>,
    stdin: Option<Vec<u8>>,
    deadline: Instant,
    mutation: bool,
    response: SyncSender<WorkerReply>,
    state: Arc<JobState>,
    _permit: Arc<AdmissionPermit>,
}

enum WorkerMessage {
    Job(Job),
    Stop,
}

enum WorkerReply {
    Fallback,
    Result(Result<GitOutput, GitError>),
}

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

pub(super) fn execute_if_enabled(
    project: &AgentProject,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
    mutation: bool,
    fallback: impl FnOnce() -> Result<GitOutput, GitError>,
) -> Option<Result<GitOutput, GitError>> {
    let scope = DISPLAY_SCOPE.with(|scope| scope.borrow().clone())?;
    if scope.environment != "wsl" {
        return None;
    }
    // Rooted readers replace project.path after discovery; the configured ScopeKey still isolates the relay.
    if project.id != scope.id
        || project.environment.kind != scope.environment
        || project.environment.distribution != scope.distribution
    {
        return Some(Err(transport_error(
            "Le contexte du relais Git WSL a changé pendant la lecture.",
        )));
    }
    if stdin.is_some_and(|bytes| bytes.len() > STDIN_LIMIT) {
        return Some(Err(GitError::new(
            "inputTooLarge",
            "L’entrée Git dépasse la limite de 8 Mio.",
        )));
    }
    if let Err(error) = super::check_read_deadline() {
        return Some(Err(error));
    }
    let now = Instant::now();
    let deadline = command_deadline(super::read_deadline(), now, timeout);
    let (spec, git_args) = relay_spec(project, args)?;
    let entry = match pool_entry(scope, spec, deadline) {
        PoolEntryResult::Entry(entry) => entry,
        PoolEntryResult::FullUnavailable => {
            return Some(super::with_read_deadline(deadline, fallback));
        }
        PoolEntryResult::Timeout => return Some(Err(read_timeout_error())),
    };
    let permit = match entry.admission.acquire(deadline) {
        Some(permit) => Arc::new(permit),
        None => return Some(Err(read_timeout_error())),
    };
    let state = Arc::new(JobState::new());
    let (response, receiver) = mpsc::sync_channel(1);
    let job = Job {
        id: REQUEST_ID.fetch_add(1, Ordering::Relaxed),
        args: git_args,
        stdin: stdin.map(Vec::from),
        deadline,
        mutation,
        response,
        state: Arc::clone(&state),
        _permit: Arc::clone(&permit),
    };
    match send_before(&entry.sender, WorkerMessage::Job(job), deadline) {
        Ok(()) => {}
        Err(SendError::Timeout(_)) => return Some(Err(read_timeout_error())),
        Err(SendError::Disconnected(_)) => {
            return Some(super::with_read_deadline(deadline, fallback));
        }
    }
    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(WorkerReply::Fallback) => Some(super::with_read_deadline(deadline, fallback)),
        Ok(WorkerReply::Result(result)) => {
            Some(result.map_err(|error| mark_mutation_uncertain(error, mutation)))
        }
        Err(RecvTimeoutError::Timeout) => {
            let transmission_possible = state.cancel_and_mutation_uncertain();
            if transmission_possible && mutation {
                super::block_mutations(true, false);
            }
            Some(Err(mark_mutation_uncertain(
                read_timeout_error(),
                mutation && transmission_possible,
            )))
        }
        Err(RecvTimeoutError::Disconnected) if !state.mutation_uncertain() => {
            Some(super::with_read_deadline(deadline, fallback))
        }
        Err(RecvTimeoutError::Disconnected) => {
            super::block_mutations(true, false);
            Some(Err(mark_mutation_uncertain(
                transport_error("Le relais Git WSL s’est interrompu."),
                mutation,
            )))
        }
    }
}

fn mark_mutation_uncertain(mut error: GitError, uncertain: bool) -> GitError {
    if uncertain {
        error.uncertain = Some(true);
    }
    error
}

fn command_deadline(parent: Option<Instant>, now: Instant, timeout: Duration) -> Instant {
    let command = now + timeout;
    parent.map_or(command, |deadline| deadline.min(command))
}

enum PoolEntryResult {
    Entry(Arc<PoolEntry>),
    FullUnavailable,
    Timeout,
}

fn pool_entry(key: ScopeKey, spec: RelaySpec, deadline: Instant) -> PoolEntryResult {
    let policy = POOL_POLICY.with(Cell::get);
    pool_entry_from(pool_state(), key, spec, deadline, policy)
}

fn pool_entry_from(
    state: &PoolState,
    key: ScopeKey,
    spec: RelaySpec,
    deadline: Instant,
    policy: PoolPolicy,
) -> PoolEntryResult {
    loop {
        let mut pool = state
            .pool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pool.entries.retain(|_, entry| {
            entry.liveness.is_alive() || !entry.admission.idle() || Arc::strong_count(entry) > 1
        });
        if let Some(entry) = pool.entries.get(&key) {
            if entry.liveness.is_alive() {
                if !entry.stopping.load(Ordering::Acquire) {
                    return PoolEntryResult::Entry(Arc::clone(entry));
                }
                let liveness = Arc::clone(&entry.liveness);
                drop(pool);
                if !liveness.wait_stopped(deadline) {
                    return PoolEntryResult::Timeout;
                }
                continue;
            }
            let admission = Arc::clone(&entry.admission);
            let replacement = start_pool_entry(spec, admission);
            pool.entries.insert(key, Arc::clone(&replacement));
            return PoolEntryResult::Entry(replacement);
        }
        if pool.entries.len() < MAX_SCOPES {
            let entry = start_pool_entry(spec, Arc::new(Admission::default()));
            pool.entries.insert(key, Arc::clone(&entry));
            return PoolEntryResult::Entry(entry);
        }
        if policy == PoolPolicy::Background {
            return PoolEntryResult::FullUnavailable;
        }
        let evicted = pool
            .entries
            .values()
            .find(|entry| pool_entry_evictable(entry))
            .cloned();
        if let Some(entry) = evicted {
            entry.stopping.store(true, Ordering::Release);
            drop(pool);
            let _ = send_before(&entry.sender, WorkerMessage::Stop, deadline);
            if !entry.liveness.wait_stopped(deadline) {
                return PoolEntryResult::Timeout;
            }
            continue;
        }
        if wait_for_pool_change(state, pool, deadline).is_none() {
            return PoolEntryResult::Timeout;
        }
    }
}

fn wait_for_pool_change<'a>(
    state: &'a PoolState,
    pool: std::sync::MutexGuard<'a, Pool>,
    deadline: Instant,
) -> Option<std::sync::MutexGuard<'a, Pool>> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return None;
    }
    let (pool, _) = state
        .available
        .wait_timeout(pool, remaining.min(POLL_INTERVAL))
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    (Instant::now() < deadline).then_some(pool)
}

fn pool_entry_evictable(entry: &Arc<PoolEntry>) -> bool {
    !entry.stopping.load(Ordering::Acquire)
        && Arc::strong_count(entry) == 1
        && entry.admission.idle()
}

fn start_pool_entry(spec: RelaySpec, admission: Arc<Admission>) -> Arc<PoolEntry> {
    let (sender, receiver) = mpsc::sync_channel(MAX_REQUESTS_PER_SCOPE - 1);
    let liveness = Arc::new(Liveness::new());
    let entry = Arc::new(PoolEntry {
        sender,
        liveness: Arc::clone(&liveness),
        stopping: AtomicBool::new(false),
        admission,
    });
    std::thread::spawn(move || worker(spec, receiver, liveness));
    entry
}

enum SendError<T> {
    Timeout(T),
    Disconnected(T),
}

fn send_before<T>(
    sender: &SyncSender<T>,
    mut value: T,
    deadline: Instant,
) -> Result<(), SendError<T>> {
    loop {
        match sender.try_send(value) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Full(returned)) if Instant::now() < deadline => {
                value = returned;
                std::thread::sleep(
                    POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Err(TrySendError::Full(returned)) => return Err(SendError::Timeout(returned)),
            Err(TrySendError::Disconnected(returned)) => {
                return Err(SendError::Disconnected(returned))
            }
        }
    }
}

struct WorkerAlive(Arc<Liveness>);

impl Drop for WorkerAlive {
    fn drop(&mut self) {
        let mut alive = self
            .0
            .alive
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *alive = false;
        self.0.stopped.notify_all();
        pool_state().available.notify_all();
    }
}

fn worker(spec: RelaySpec, receiver: mpsc::Receiver<WorkerMessage>, alive: Arc<Liveness>) {
    let _alive = WorkerAlive(alive);
    let mut relay: Option<Relay> = None;
    let mut fallback_until: Option<Instant> = None;
    loop {
        let job = match receiver.recv_timeout(IDLE_TIMEOUT) {
            Ok(WorkerMessage::Job(job)) => job,
            Ok(WorkerMessage::Stop) | Err(_) => break,
        };
        let reply = if Instant::now() >= job.deadline {
            WorkerReply::Result(Err(read_timeout_error()))
        } else if fallback_until.is_some_and(|deadline| Instant::now() < deadline) {
            WorkerReply::Fallback
        } else {
            fallback_until = None;
            if relay.as_mut().is_some_and(|relay| !relay.ready()) {
                relay.take();
            }
            if relay.is_none() {
                match Relay::start(&spec, job.deadline) {
                    Ok(started) => relay = Some(started),
                    Err(StartError::Fallback { cache }) => {
                        if cache {
                            fallback_until = Some(Instant::now() + FALLBACK_COOLDOWN);
                        }
                        let _ = job.response.try_send(WorkerReply::Fallback);
                        continue;
                    }
                    Err(StartError::Error(error)) => {
                        let _ = job.response.try_send(WorkerReply::Result(Err(error)));
                        continue;
                    }
                }
            }
            let result = relay.as_mut().unwrap().execute(&job);
            match result {
                RelayResult::Fallback => WorkerReply::Fallback,
                RelayResult::Result(result) => WorkerReply::Result(result),
                RelayResult::Broken(error) => {
                    relay.take();
                    WorkerReply::Result(Err(error))
                }
            }
        };
        let _ = job.response.try_send(reply);
    }
}

enum WriterMessage {
    Frame(Vec<u8>, SyncSender<std::io::Result<()>>),
    Close,
}

enum JobTransmission {
    Cancelled,
    Sent,
    Failed,
}

fn transmit_job_before(
    writer: &SyncSender<WriterMessage>,
    message: WriterMessage,
    deadline: Instant,
    state: &JobState,
) -> JobTransmission {
    if !state.transmission_possible() {
        return JobTransmission::Cancelled;
    }
    match send_before(writer, message, deadline) {
        Ok(()) => JobTransmission::Sent,
        Err(_) => JobTransmission::Failed,
    }
}

fn write_writer_message(stream: &mut impl Write, message: WriterMessage) -> bool {
    match message {
        WriterMessage::Frame(frame, acknowledgement) => {
            let result = stream.write_all(&frame).and_then(|_| stream.flush());
            let failed = result.is_err();
            let _ = acknowledgement.send(result);
            !failed
        }
        WriterMessage::Close => false,
    }
}

enum StartError {
    Fallback { cache: bool },
    Error(GitError),
}

enum RelayResult {
    Fallback,
    Result(Result<GitOutput, GitError>),
    Broken(GitError),
}

#[cfg(test)]
struct RelayStartupProfile {
    started: Instant,
    spawn: Duration,
    ownership: Duration,
    bootstrap: Duration,
    hello: Duration,
}

#[cfg(test)]
impl RelayStartupProfile {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            spawn: Duration::ZERO,
            ownership: Duration::ZERO,
            bootstrap: Duration::ZERO,
            hello: Duration::ZERO,
        }
    }
}

#[cfg(test)]
impl Drop for RelayStartupProfile {
    fn drop(&mut self) {
        if std::env::var_os("SORENO_PROFILE_GIT").is_some() {
            eprintln!(
                "GIT_PROFILE relay_create startup={:.3}ms spawn={:.3}ms ownership={:.3}ms bootstrap={:.3}ms hello={:.3}ms",
                self.started.elapsed().as_secs_f64() * 1_000.0,
                self.spawn.as_secs_f64() * 1_000.0,
                self.ownership.as_secs_f64() * 1_000.0,
                self.bootstrap.as_secs_f64() * 1_000.0,
                self.hello.as_secs_f64() * 1_000.0,
            );
        }
    }
}

struct Relay {
    child: Child,
    owner: ProcessOwner,
    writer: SyncSender<WriterMessage>,
    responses: mpsc::Receiver<Result<WireResponse, String>>,
    writer_task: IoThread<()>,
    reader_task: IoThread<()>,
    stderr_task: IoThread<Captured>,
    cancelled: Arc<AtomicBool>,
    protocol_broken: Arc<AtomicBool>,
    stopped: bool,
}

fn python_missing(status: &std::process::ExitStatus, stderr: &Captured) -> bool {
    let diagnostic = String::from_utf8_lossy(&stderr.bytes).to_ascii_lowercase();
    status.code() == Some(127)
        && diagnostic.contains("python3")
        && (diagnostic.contains("no such file or directory") || diagnostic.contains("not found"))
}

impl Relay {
    fn start(spec: &RelaySpec, deadline: Instant) -> Result<Self, StartError> {
        #[cfg(test)]
        let mut profile = RelayStartupProfile::new();
        let mut command = Command::new(&spec.program);
        command.args(&spec.args);
        for (name, value) in &spec.env {
            if let Some(value) = value {
                command.env(name, value);
            } else {
                command.env_remove(name);
            }
        }
        if let Some(current_dir) = &spec.current_dir {
            command.current_dir(current_dir);
        }
        ProcessOwner::configure(&mut command);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(test)]
        let phase_started = Instant::now();
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                StartError::Fallback { cache: false }
            } else {
                StartError::Error(transport_error(&format!(
                    "Impossible de lancer le relais Git WSL : {error}"
                )))
            }
        })?;
        #[cfg(test)]
        {
            profile.spawn = phase_started.elapsed();
        }
        #[cfg(test)]
        let phase_started = Instant::now();
        let owner = ProcessOwner::new(&child).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            StartError::Error(transport_error(&format!(
                "Impossible d’isoler le relais Git WSL : {error}"
            )))
        })?;
        #[cfg(test)]
        {
            profile.ownership = phase_started.elapsed();
        }
        let stdin = child.stdin.take().ok_or_else(|| {
            StartError::Error(transport_error("Entrée du relais Git WSL indisponible."))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            StartError::Error(transport_error("Sortie du relais Git WSL indisponible."))
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            StartError::Error(transport_error("Erreurs du relais Git WSL indisponibles."))
        })?;

        let (writer, writer_receiver) = mpsc::sync_channel(0);
        let writer_task = spawn_io(stdin, move |stdin| {
            while let Ok(message) = writer_receiver.recv() {
                if !write_writer_message(stdin, message) {
                    break;
                }
            }
            Ok(())
        });
        let (response_sender, responses) = mpsc::sync_channel(1);
        let protocol_broken = Arc::new(AtomicBool::new(false));
        let reader_protocol_broken = Arc::clone(&protocol_broken);
        let reader_task = spawn_io(stdout, move |stdout| {
            forward_responses(stdout, &response_sender, &reader_protocol_broken)
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let stderr_cancelled = Arc::clone(&cancelled);
        let stderr_task = spawn_io(stderr, move |stderr| {
            drain_pipe(stderr, STDERR_LIMIT, &stderr_cancelled)
        });
        let mut relay = Self {
            child,
            owner,
            writer,
            responses,
            writer_task,
            reader_task,
            stderr_task,
            cancelled,
            protocol_broken,
            stopped: false,
        };
        #[cfg(test)]
        let phase_started = Instant::now();
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        let source_sent = send_before(
            &relay.writer,
            WriterMessage::Frame(spec.source.to_vec(), acknowledgement),
            deadline,
        )
        .is_ok()
            && matches!(
                acknowledged.recv_timeout(deadline.saturating_duration_since(Instant::now())),
                Ok(Ok(()))
            );
        #[cfg(test)]
        {
            profile.bootstrap = phase_started.elapsed();
        }
        if !source_sent {
            relay.stop(false);
            return Err(StartError::Fallback { cache: false });
        }
        #[cfg(test)]
        let phase_started = Instant::now();
        let hello = relay.receive(deadline);
        #[cfg(test)]
        {
            profile.hello = phase_started.elapsed();
        }
        match hello {
            Ok(response) if response.v == 1 && response.kind == "hello" => Ok(relay),
            Ok(_) => {
                relay.stop(false);
                Err(StartError::Fallback { cache: false })
            }
            Err(error) => {
                let startup_deadline = (Instant::now() + Duration::from_millis(100)).min(deadline);
                let status = relay.exit_status_before(startup_deadline);
                let stderr = status.as_ref().and_then(|_| {
                    relay
                        .stderr_task
                        .receive(startup_deadline)
                        .ok()
                        .and_then(Result::ok)
                });
                let cache = status
                    .as_ref()
                    .zip(stderr.as_ref())
                    .is_some_and(|(status, stderr)| python_missing(status, stderr));
                relay.stop(false);
                if status.is_some() {
                    Err(StartError::Fallback { cache })
                } else {
                    Err(StartError::Error(error))
                }
            }
        }
    }

    fn ready(&mut self) -> bool {
        if self.protocol_broken.load(Ordering::Acquire) {
            return false;
        }
        match self.child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => return false,
        }
        match self.responses.try_recv() {
            Err(TryRecvError::Empty) => true,
            Ok(_) | Err(TryRecvError::Disconnected) => {
                self.protocol_broken.store(true, Ordering::Release);
                false
            }
        }
    }

    fn execute(&mut self, job: &Job) -> RelayResult {
        let now = Instant::now();
        let remaining = job.deadline.saturating_duration_since(now);
        if remaining.is_zero() {
            return RelayResult::Result(Err(read_timeout_error()));
        }
        let request = WireRequest {
            v: 1,
            id: job.id,
            args: &job.args,
            stdin: job.stdin.as_deref().map(|bytes| BASE64.encode(bytes)),
            timeout_ms: wire_timeout_ms(job.deadline, now),
        };
        let payload = match serde_json::to_vec(&request) {
            Ok(payload) if !payload.is_empty() && payload.len() <= REQUEST_FRAME_LIMIT => payload,
            Ok(_) => {
                return RelayResult::Result(Err(GitError::new(
                    "inputTooLarge",
                    "La requête Git dépasse la limite du transport WSL.",
                )))
            }
            Err(error) => {
                return RelayResult::Result(Err(transport_error(&format!(
                    "Impossible d’encoder la requête Git WSL : {error}"
                ))))
            }
        };
        let mut frame = Vec::with_capacity(payload.len() + 4);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&payload);
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        match transmit_job_before(
            &self.writer,
            WriterMessage::Frame(frame, acknowledgement),
            job.deadline,
            &job.state,
        ) {
            JobTransmission::Cancelled => {
                return RelayResult::Result(Err(read_timeout_error()));
            }
            JobTransmission::Sent => {}
            JobTransmission::Failed => {
                self.stop(true);
                return RelayResult::Broken(transport_error(
                    "Impossible d’envoyer la lecture au relais Git WSL.",
                ));
            }
        }
        match acknowledged.recv_timeout(job.deadline.saturating_duration_since(Instant::now())) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                self.stop(false);
                super::block_mutations(true, false);
                return RelayResult::Broken(transport_error(&format!(
                    "Impossible d’écrire vers le relais Git WSL : {error}"
                )));
            }
            Err(_) => {
                self.stop(true);
                return RelayResult::Broken(read_timeout_error());
            }
        }
        let response = match self.receive(job.deadline) {
            Ok(response) if response.v == 1 && response.id == Some(job.id) => response,
            Ok(_) => {
                self.stop(true);
                return RelayResult::Broken(transport_error(
                    "Le relais Git WSL a retourné une réponse inattendue.",
                ));
            }
            Err(error) => {
                self.stop(true);
                return RelayResult::Broken(error);
            }
        };
        if self.protocol_broken.load(Ordering::Acquire) {
            self.stop(true);
            return RelayResult::Broken(transport_error(
                "Le relais Git WSL a envoyé des réponses excédentaires.",
            ));
        }
        let result = self.convert(response, job.mutation);
        if matches!(&result, RelayResult::Fallback | RelayResult::Result(_)) {
            job.state.terminal();
        } else {
            self.stop(true);
        }
        result
    }

    fn receive(&mut self, deadline: Instant) -> Result<WireResponse, GitError> {
        match self
            .responses
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(error)) => Err(transport_error(&error)),
            Err(RecvTimeoutError::Timeout) => Err(read_timeout_error()),
            Err(RecvTimeoutError::Disconnected) => {
                Err(transport_error("Le flux du relais Git WSL est fermé."))
            }
        }
    }

    fn convert(&mut self, response: WireResponse, mutation: bool) -> RelayResult {
        if !response.terminated {
            super::block_mutations(true, false);
            return RelayResult::Broken(if response.kind == "timeout" {
                read_timeout_error()
            } else {
                transport_error("La terminaison de Git dans WSL n’a pas pu être confirmée.")
            });
        }
        match response.kind.as_str() {
            "unsupported" => RelayResult::Fallback,
            "timeout" => {
                if mutation {
                    super::block_mutations(true, false);
                }
                RelayResult::Result(Err(read_timeout_error()))
            }
            "outputTooLarge" => RelayResult::Result(Err(GitError::new(
                "outputTooLarge",
                "La sortie Git dépasse la limite de 8 Mio.",
            ))),
            "badRequest" => RelayResult::Result(Err(GitError::new(
                "malformed",
                response
                    .message
                    .unwrap_or_else(|| "Requête Git WSL refusée.".into()),
            ))),
            "io" => RelayResult::Result(Err(transport_error(
                response
                    .message
                    .as_deref()
                    .unwrap_or("Le relais Git WSL a rencontré une erreur d’entrée/sortie."),
            ))),
            "ok" | "git" => {
                let stdout = match decode_capture(&response.stdout, STDOUT_LIMIT) {
                    Ok(bytes) => bytes,
                    Err(error) => return RelayResult::Broken(error),
                };
                let stderr = match decode_capture(&response.stderr, STDERR_LIMIT) {
                    Ok(bytes) => bytes,
                    Err(error) => return RelayResult::Broken(error),
                };
                if response.kind == "ok" {
                    RelayResult::Result(Ok(GitOutput { stdout }))
                } else {
                    use std::os::windows::process::ExitStatusExt;
                    let Some(code) = response.status.filter(|code| *code >= 0) else {
                        return RelayResult::Broken(transport_error("Statut Git WSL invalide."));
                    };
                    let status = std::process::ExitStatus::from_raw(code as u32);
                    RelayResult::Result(Err(super::command_failure(
                        status,
                        Captured {
                            bytes: stderr,
                            truncated: response.stderr_truncated,
                        },
                        stdout,
                        mutation,
                    )))
                }
            }
            _ => RelayResult::Broken(transport_error(
                "Type de réponse du relais Git WSL invalide.",
            )),
        }
    }

    fn exit_status_before(&mut self, deadline: Instant) -> Option<std::process::ExitStatus> {
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => std::thread::sleep(POLL_INTERVAL),
                Err(_) => return None,
            }
        }
        None
    }

    fn stop(&mut self, uncertain: bool) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        let deadline = Instant::now() + STOP_TIMEOUT;
        let _ = send_before(&self.writer, WriterMessage::Close, deadline);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => std::thread::sleep(POLL_INTERVAL),
                Err(_) => break,
            }
        }
        let clean = self.child.try_wait().ok().flatten().is_some();
        let terminated = clean
            || self
                .owner
                .terminate(&mut self.child, super::IO_STOP_TIMEOUT);
        self.cancelled.store(true, Ordering::Release);
        let io_deadline = Instant::now() + STOP_TIMEOUT;
        let streams_stopped = stop_io(&mut self.writer_task, io_deadline)
            & stop_io(&mut self.reader_task, io_deadline)
            & stop_io(&mut self.stderr_task, io_deadline);
        if uncertain {
            super::block_mutations(true, false);
        }
        let _ = (terminated, streams_stopped);
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.stop(false);
    }
}

fn wire_timeout_ms(deadline: Instant, now: Instant) -> u64 {
    deadline
        .saturating_duration_since(now)
        .saturating_sub(STOP_TIMEOUT)
        .as_millis()
        .clamp(1, super::LOCAL_MUTATION_TIMEOUT.as_millis()) as u64
}

fn forward_responses(
    stream: &mut impl Read,
    sender: &SyncSender<Result<WireResponse, String>>,
    protocol_broken: &AtomicBool,
) -> std::io::Result<()> {
    loop {
        let response = read_response_frame(stream);
        let finished = response.is_err();
        if finished {
            protocol_broken.store(true, Ordering::Release);
        }
        match sender.try_send(response) {
            Ok(()) if !finished => {}
            Ok(()) => break,
            Err(TrySendError::Full(_)) => {
                protocol_broken.store(true, Ordering::Release);
                break;
            }
            Err(TrySendError::Disconnected(_)) => break,
        }
    }
    Ok(())
}

fn transport_error(message: &str) -> GitError {
    GitError::new("io", message)
}

#[cfg(test)]
#[path = "wsl_read_tests.rs"]
mod tests;
