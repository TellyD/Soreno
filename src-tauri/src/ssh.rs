//! OpenSSH transport for remote POSIX projects. Credentials stay in OpenSSH/ssh-agent.
mod auth_diagnostic;
mod forward;
mod relay;

pub(crate) use forward::{SshPortForward, SshPortForwardStart};

use crate::process_owner::ProcessOwner;
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;
pub(crate) const TIMEOUT: Duration = Duration::from_secs(15);
const READY_ATTEMPTS: usize = 6;
const READY_RETRY_DELAY: Duration = Duration::from_millis(250);
const READY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
static KNOWN_HOSTS_DIR: OnceLock<PathBuf> = OnceLock::new();
static PIN_WRITE: Mutex<()> = Mutex::new(());
static DISCOVERY_FILES: AtomicU64 = AtomicU64::new(0);
const DISCOVERY_FILE_LIMIT: usize = 256 * 1024;
#[cfg(test)]
static TEST_COMMANDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn reset_test_commands() {
    TEST_COMMANDS.store(0, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
pub(crate) fn test_commands() -> usize {
    TEST_COMMANDS.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
fn record_test_process() {
    TEST_COMMANDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(not(test))]
fn record_test_process() {}

#[cfg(test)]
pub(crate) fn reset_test_relays() {
    relay::reset_test_relays();
}

#[cfg(test)]
pub(crate) static RELAY_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn is_blocked(connection: &SshConnection) -> bool {
    relay::is_blocked(connection)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshConnection {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub host_key: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKey {
    pub key: String,
    pub fingerprint: String,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectory {
    pub name: String,
    pub path: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirectoryListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub directories: Vec<SshDirectory>,
}

pub(crate) fn initialize(app_data: &Path) -> Result<()> {
    let path = app_data.join("ssh-known-hosts");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    KNOWN_HOSTS_DIR
        .set(path)
        .map_err(|_| "Le transport SSH est déjà initialisé.".into())
}

pub(crate) fn validate(connection: &SshConnection) -> Result<()> {
    validate_host(&connection.host)?;
    if connection.port == Some(0) {
        return Err("Le port SSH doit être compris entre 1 et 65535.".into());
    }
    if let Some(user) = &connection.user {
        if user.is_empty()
            || user.len() > 256
            || user.starts_with('-')
            || !user
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-@\\".contains(c))
        {
            return Err("Utilisateur SSH invalide.".into());
        }
    }
    if let Some(path) = &connection.identity_file {
        if path.len() > 4096 || path.chars().any(char::is_control) || !Path::new(path).is_absolute()
        {
            return Err("La clé SSH doit utiliser un chemin local absolu valide.".into());
        }
        if Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pub"))
        {
            return Err("Indiquez la clé privée SSH, pas le fichier de clé publique .pub.".into());
        }
    }
    if let Some(key) = &connection.host_key {
        parse_key(key)?;
    }
    Ok(())
}
fn validate_host(host: &str) -> Result<()> {
    if host.is_empty()
        || host.len() > 253
        || host.starts_with('-')
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_:%".contains(c))
    {
        return Err("Indiquez un nom de serveur, une adresse IP ou un alias OpenSSH (sans utilisateur ni options).".into());
    }
    Ok(())
}
pub(crate) fn validate_path(path: &str) -> Result<()> {
    if !path.starts_with('/') || path.len() > 4096 || path.contains('\0') {
        return Err("Le dossier SSH doit être un chemin POSIX absolu valide.".into());
    }
    Ok(())
}
pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
/// `script` in the user's login shell, which puts CLIs installed by a version manager on PATH.
pub(crate) fn login_shell_script(script: &str) -> String {
    format!(r#"exec "${{SHELL:-/bin/sh}}" -ilc {}"#, quote(script))
}

fn parse_key(value: &str) -> Result<Vec<u8>> {
    if value.len() > 16384 || value.chars().any(char::is_control) {
        return Err("Clé du serveur SSH invalide.".into());
    }
    let parts: Vec<_> = value.split(' ').collect();
    if parts.len() != 2
        || ![
            "ssh-ed25519",
            "ssh-rsa",
            "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384",
            "ecdsa-sha2-nistp521",
        ]
        .contains(&parts[0])
    {
        return Err("Type de clé du serveur SSH invalide.".into());
    }
    let bytes = STANDARD
        .decode(parts[1])
        .map_err(|_| "Clé du serveur SSH non base64.".to_string())?;
    let length = bytes
        .get(..4)
        .map(|n| u32::from_be_bytes(n.try_into().unwrap()) as usize)
        .ok_or("Clé du serveur SSH tronquée.")?;
    if bytes.get(4..4usize.saturating_add(length)) != Some(parts[0].as_bytes())
        || bytes.len() <= 4 + length
    {
        return Err("Clé du serveur SSH incompatible avec son type.".into());
    }
    Ok(bytes)
}
fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
const PINNED_ALIAS: &str = "soreno-pinned";
// Trust files written before the Telaoi → Soreno rename keep their alias.
const LEGACY_PINNED_ALIAS: &str = "telaoi-pinned";

fn pinned_hosts(key: &str) -> Result<(PathBuf, &'static str)> {
    parse_key(key)?;
    let _guard = PIN_WRITE
        .lock()
        .map_err(|_| "État de confiance SSH indisponible.")?;
    let dir = KNOWN_HOSTS_DIR
        .get()
        .ok_or("Transport SSH non initialisé.")?;
    let path = dir.join(format!("{:x}", Sha256::digest(key.as_bytes())));
    let content = |alias: &str| format!("{alias} {key}\n");
    match create_private_file(&path) {
        Ok(mut file) => {
            file.write_all(content(PINNED_ALIAS).as_bytes())
                .map_err(|e| e.to_string())?;
            Ok((path, PINNED_ALIAS))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = std::fs::read(&path).map_err(|e| e.to_string())?;
            let alias = [PINNED_ALIAS, LEGACY_PINNED_ALIAS]
                .into_iter()
                .find(|alias| existing == content(alias).as_bytes())
                .ok_or("Le fichier de confiance SSH a été modifié. Refus de connexion.")?;
            Ok((path, alias))
        }
        Err(error) => Err(error.to_string()),
    }
}
// OpenSSH parses this option itself: quote spaces and escape token expansion.
fn openssh_path(path: &Path) -> Result<String> {
    let path = path
        .to_str()
        .ok_or("Chemin de confiance SSH non Unicode.")?
        .replace('\\', "/")
        .replace('%', "%%");
    if path.contains(['\"', '\n', '\r']) {
        return Err("Chemin de confiance SSH incompatible.".into());
    }
    Ok(format!("\"{path}\""))
}

fn arguments(connection: &SshConnection) -> Result<Vec<String>> {
    validate(connection)?;
    let mut args = Vec::new();
    for option in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ConnectTimeout=8",
        "ConnectionAttempts=1",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=2",
        "ForwardAgent=no",
        "ForkAfterAuthentication=no",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "ControlMaster=no",
        "ControlPath=none",
        "UpdateHostKeys=no",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    if let Some(user) = &connection.user {
        args.extend(["-l".into(), user.clone()]);
    }
    if let Some(port) = connection.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(identity) = &connection.identity_file {
        args.extend([
            "-i".into(),
            identity.clone(),
            "-o".into(),
            "IdentitiesOnly=yes".into(),
        ]);
    }
    if let Some(key) = &connection.host_key {
        let (path, alias) = pinned_hosts(key)?;
        args.extend([
            "-o".into(),
            format!("UserKnownHostsFile={}", openssh_path(&path)?),
            "-o".into(),
            "GlobalKnownHostsFile=none".into(),
            "-o".into(),
            "KnownHostsCommand=none".into(),
            "-o".into(),
            "VerifyHostKeyDNS=no".into(),
            "-o".into(),
            "CheckHostIP=no".into(),
            "-o".into(),
            format!("HostKeyAlias={alias}"),
        ]);
    }
    Ok(args)
}
pub(crate) fn command(connection: &SshConnection, script: &str) -> Result<Command> {
    if script.contains('\0') {
        return Err("Commande SSH contenant un caractère nul.".into());
    }
    let mut command = Command::new("ssh");
    command.args(arguments(connection)?).args([
        "-T",
        "--",
        &connection.host,
        &format!("sh -c {}", quote(script)),
    ]);
    Ok(command)
}
/// `command` with a remote terminal for piped local I/O, which dtach requires; no escape
/// character, so no input sequence can act on the connection.
pub(crate) fn tty_command(connection: &SshConnection, script: &str) -> Result<Command> {
    if script.contains('\0') {
        return Err("Commande SSH contenant un caractère nul.".into());
    }
    let mut command = Command::new("ssh");
    command.args(arguments(connection)?).args([
        "-tt",
        "-e",
        "none",
        "--",
        &connection.host,
        &format!("sh -c {}", quote(script)),
    ]);
    Ok(command)
}
pub(crate) fn terminal_command(
    connection: &SshConnection,
    script: &str,
) -> Result<portable_pty::CommandBuilder> {
    if script.contains('\0') {
        return Err("Commande SSH contenant un caractère nul.".into());
    }
    let mut command = portable_pty::CommandBuilder::new("ssh");
    command.args(arguments(connection)?);
    command.args([
        "-tt",
        "--",
        &connection.host,
        &format!("sh -c {}", quote(script)),
    ]);
    command.env("TERM", "xterm-256color");
    Ok(command)
}
#[derive(Debug)]
pub(crate) struct SshOutput {
    pub status: u8,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub(crate) fn run_output(
    connection: &SshConnection,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
) -> Result<SshOutput> {
    run_output_with_timeout(connection, script, input, limit, TIMEOUT)
}

pub(crate) fn run_output_with_timeout(
    connection: &SshConnection,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
    timeout: Duration,
) -> Result<SshOutput> {
    run_relayed(connection, script, input, limit, timeout, false)
}

/// For side-effect-free scripts only: a connection dropped mid-request is retried once.
pub(crate) fn run_read_output_with_timeout(
    connection: &SshConnection,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
    timeout: Duration,
) -> Result<SshOutput> {
    run_relayed(connection, script, input, limit, timeout, true)
}

fn run_relayed(
    connection: &SshConnection,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
    timeout: Duration,
    idempotent: bool,
) -> Result<SshOutput> {
    validate(connection)?;
    let started = Instant::now();
    relay::run(connection, script, input, limit, timeout, idempotent).map_err(|error| {
        auth_diagnostic::annotate(connection, error, timeout.saturating_sub(started.elapsed()))
    })
}

pub(crate) fn run(
    connection: &SshConnection,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<u8>> {
    checked_output(run_output(connection, script, input, limit)?)
}

fn checked_output(output: SshOutput) -> Result<Vec<u8>> {
    if output.status != 0 {
        return Err(format!(
            "Connexion ou commande SSH échouée : {}\nVérifiez l’identité du serveur, votre clé ou ssh-agent, et les droits du compte.",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn retry_ready(
    mut probe: impl FnMut() -> Result<()>,
    attempts: usize,
    delay: Duration,
) -> Result<()> {
    let mut last_error = "Connexion SSH indisponible.".to_owned();
    for attempt in 0..attempts {
        match probe() {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
        if attempt + 1 < attempts {
            thread::sleep(delay);
        }
    }
    Err(format!("Connexion SSH non stabilisée : {last_error}"))
}

pub(crate) fn wait_ready(connection: &SshConnection) -> Result<()> {
    retry_ready(
        || {
            checked_output(run_output_with_timeout(
                connection,
                "sleep 1",
                None,
                16,
                READY_PROBE_TIMEOUT,
            )?)
            .map(|_| ())
        },
        READY_ATTEMPTS,
        READY_RETRY_DELAY,
    )
}

pub(crate) fn block(connection: &SshConnection) {
    relay::block(connection);
}

pub(crate) fn unblock(connection: &SshConnection) {
    relay::unblock(connection);
}

/// Holds the connection open against `block` until dropped; refuses blocked connections.
pub(crate) fn begin_access(connection: &SshConnection) -> Result<relay::RunGuard> {
    relay::begin_run(connection)
}

pub(crate) fn forward_list(connection: &SshConnection) -> Result<Vec<SshPortForward>> {
    forward::list(connection)
}

pub(crate) fn forward_start(
    connection: &SshConnection,
    ports: &str,
) -> Result<SshPortForwardStart> {
    forward::start(connection, ports)
}

pub(crate) fn forward_stop(connection: &SshConnection) {
    forward::stop(connection);
}

pub(crate) fn close(connection: &SshConnection) {
    forward::stop(connection);
    relay::close(connection);
}

pub(crate) fn shutdown() {
    forward::shutdown();
    relay::shutdown();
}

fn output(
    command: Command,
    input: Option<&[u8]>,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<u8>> {
    checked_output(process_output(command, input, limit, timeout)?)
}

fn openssh_unavailable(error: std::io::Error) -> String {
    format!("OpenSSH indisponible : {error}. Installez le client OpenSSH et vérifiez le PATH.")
}

fn timed_out() -> String {
    "Délai SSH dépassé. Vérifiez le réseau et le serveur avant de réessayer.".into()
}

// Bounded stdout, stderr, stdin and wall time; no shell is invoked on the client.
fn process_output(
    mut command: Command,
    input: Option<&[u8]>,
    limit: usize,
    timeout: Duration,
) -> Result<SshOutput> {
    if limit > 8 * 1024 * 1024 || input.is_some_and(|bytes| bytes.len() > 4 * 1024 * 1024) {
        return Err("Commande SSH trop volumineuse.".into());
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ProcessOwner::configure(&mut command);
    let mut child = command.spawn().map_err(openssh_unavailable)?;
    let mut owner = match ProcessOwner::new(&child) {
        Ok(owner) => owner,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let (sender, receiver) = mpsc::channel();
    for (index, stream, cap) in [
        (
            0,
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
            limit,
        ),
        (
            1,
            Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
            64 * 1024,
        ),
    ] {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut data = Vec::new();
            let result = stream
                .take(cap as u64 + 1)
                .read_to_end(&mut data)
                .map_err(|e| e.to_string())
                .and_then(|_| {
                    if data.len() > cap {
                        Err("Réponse SSH trop volumineuse.".into())
                    } else {
                        Ok(data)
                    }
                });
            let _ = sender.send((index, result));
        });
    }
    let has_input = input.is_some();
    if let Some(bytes) = input {
        let bytes = bytes.to_vec();
        let mut stdin = child.stdin.take().unwrap();
        let sender = sender.clone();
        thread::spawn(move || {
            let result = stdin
                .write_all(&bytes)
                .map(|_| Vec::new())
                .map_err(|e| e.to_string());
            drop(stdin);
            let _ = sender.send((2, result));
        });
    }
    drop(sender);
    let deadline = Instant::now() + timeout;
    let mut results = [None, None, if has_input { None } else { Some(Vec::new()) }];
    let result = (|| loop {
        while let Ok((index, result)) = receiver.try_recv() {
            results[index] = Some(result?);
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if results.iter().all(Option::is_some) {
                return Ok(SshOutput {
                    status: status
                        .code()
                        .and_then(|code| u8::try_from(code).ok())
                        .unwrap_or(255),
                    stdout: results[0].take().unwrap(),
                    stderr: results[1].take().unwrap(),
                });
            }
        }
        if Instant::now() >= deadline {
            return Err(timed_out());
        }
        thread::sleep(Duration::from_millis(10));
    })();
    owner.terminate(&mut child, Duration::from_secs(1));
    result
}

fn openssh_config_command(connection: &SshConnection) -> Result<Command> {
    let mut unpinned = connection.clone();
    unpinned.host_key = None;
    let mut command = Command::new("ssh");
    command
        .args(arguments(&unpinned)?)
        .args(["-G", "--", &connection.host]);
    Ok(command)
}

pub(crate) fn openssh_config(connection: &SshConnection) -> Result<String> {
    let command = openssh_config_command(connection)?;
    String::from_utf8(output(command, None, 256 * 1024, TIMEOUT)?)
        .map_err(|_| "Configuration OpenSSH non UTF-8.".into())
}

struct DiscoveryKnownHosts {
    path: PathBuf,
}

impl DiscoveryKnownHosts {
    fn create() -> Result<Self> {
        let dir = KNOWN_HOSTS_DIR
            .get()
            .ok_or("Transport SSH non initialisé.")?;
        loop {
            let id = DISCOVERY_FILES.fetch_add(1, Ordering::Relaxed);
            let path = dir.join(format!("discovery-{}-{id}", std::process::id()));
            match create_private_file(&path) {
                Ok(_) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
    }
}

impl Drop for DiscoveryKnownHosts {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn discovery_options(known_hosts: &Path, host_key_algorithms: &str) -> Result<Vec<String>> {
    let mut args = Vec::new();
    for option in [
        "StrictHostKeyChecking=accept-new".to_owned(),
        format!("UserKnownHostsFile={}", openssh_path(known_hosts)?),
        "GlobalKnownHostsFile=none".to_owned(),
        "KnownHostsCommand=none".to_owned(),
        "VerifyHostKeyDNS=no".to_owned(),
        "CheckHostIP=no".to_owned(),
        "HashKnownHosts=no".to_owned(),
        format!("HostKeyAlgorithms={host_key_algorithms}"),
        "PreferredAuthentications=none".to_owned(),
        "PubkeyAuthentication=no".to_owned(),
        "PasswordAuthentication=no".to_owned(),
        "KbdInteractiveAuthentication=no".to_owned(),
        "GSSAPIAuthentication=no".to_owned(),
        "HostbasedAuthentication=no".to_owned(),
        "IdentityAgent=none".to_owned(),
        "ProxyCommand=none".to_owned(),
        "ProxyJump=none".to_owned(),
        "Tunnel=no".to_owned(),
    ] {
        args.extend(["-o".to_owned(), option]);
    }
    Ok(args)
}

fn validate_discovery_config(config: &str) -> Result<String> {
    let value = |name: &str| config.lines().find_map(|line| line.strip_prefix(name));
    if value("proxyjump ").is_some_and(|value| value != "none")
        || value("proxycommand ").is_some_and(|value| value != "none")
    {
        return Err("Pour un serveur via ProxyJump/ProxyCommand, vérifiez d’abord son identité avec OpenSSH dans un terminal, puis utilisez Parcourir sans épingler de clé ici.".into());
    }
    validate_host(value("hostname ").ok_or("Nom du serveur absent de la configuration OpenSSH.")?)?;
    value("port ")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .ok_or("Port SSH invalide.")?;
    let algorithms = value("hostkeyalgorithms ")
        .ok_or("Algorithmes de clé d’hôte absents de la configuration OpenSSH.")?
        .split(',')
        .filter(|algorithm| {
            [
                "ssh-ed25519",
                "ecdsa-sha2-nistp256",
                "ecdsa-sha2-nistp384",
                "ecdsa-sha2-nistp521",
                "rsa-sha2-512",
                "rsa-sha2-256",
                "ssh-rsa",
            ]
            .contains(algorithm)
        })
        .collect::<Vec<_>>()
        .join(",");
    if algorithms.is_empty() {
        return Err("Aucun algorithme de clé d’hôte pris en charge n’est autorisé par la configuration OpenSSH.".into());
    }
    Ok(algorithms)
}

fn discovery_command(
    connection: &SshConnection,
    known_hosts: &Path,
    host_key_algorithms: &str,
) -> Result<Command> {
    let mut probe = connection.clone();
    probe.identity_file = None;
    probe.host_key = None;
    let mut command = Command::new("ssh");
    command
        .args(discovery_options(known_hosts, host_key_algorithms)?)
        .args(arguments(&probe)?)
        .args(["-N", "-T", "--", &probe.host]);
    Ok(command)
}

fn read_discovered_keys(path: &Path, process_result: Result<Vec<u8>>) -> Result<Vec<SshHostKey>> {
    let mut data = Vec::new();
    std::fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(DISCOVERY_FILE_LIMIT as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    if data.len() > DISCOVERY_FILE_LIMIT {
        return Err("Clés SSH reçues trop volumineuses.".into());
    }
    let text = String::from_utf8(data).map_err(|_| "Clés SSH non UTF-8.")?;
    let mut keys = Vec::<SshHostKey>::new();
    for line in text.lines() {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() != 3 || parts[0].len() > 4096 || parts[0].chars().any(char::is_control) {
            return Err("Fichier de découverte des clés SSH invalide.".into());
        }
        let key = format!("{} {}", parts[1], parts[2]);
        let bytes = parse_key(&key)?;
        if !keys.iter().any(|existing| existing.key == key) {
            keys.push(SshHostKey {
                key,
                fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(bytes))),
            });
        }
    }
    if !keys.is_empty() {
        return Ok(keys);
    }
    process_result?;
    Err("Aucune clé SSH reçue du serveur.".into())
}

/// Discovery is not authentication. Only explicit fingerprint confirmation may
/// put one of these keys into a connection's host_key field.
pub(crate) fn scan(connection: &SshConnection) -> Result<Vec<SshHostKey>> {
    let host_key_algorithms = validate_discovery_config(&openssh_config(connection)?)?;
    let known_hosts = DiscoveryKnownHosts::create()?;
    let process_result = output(
        discovery_command(connection, &known_hosts.path, &host_key_algorithms)?,
        None,
        DISCOVERY_FILE_LIMIT,
        TIMEOUT,
    );
    read_discovered_keys(&known_hosts.path, process_result)
}

pub(crate) fn browse(
    connection: &SshConnection,
    path: Option<&str>,
) -> Result<SshDirectoryListing> {
    if let Some(path) = path {
        validate_path(path)?;
    }
    let target = path.map(quote).unwrap_or_else(|| "\"$HOME\"".into());
    // NUL framing preserves spaces, tabs, newlines and shell metacharacters.
    // One directory level only; refuse overlarge results instead of silently truncating.
    let script = format!("cd -- {target} && test -r . && test -x . || exit 1; root=$(pwd -P; printf .); root=${{root%.}}; root=${{root%?}}; printf '%s\\0' \"$root\"; for entry in .[!.]* ..?* *; do [ -d \"$entry\" ] || continue; printf '%s\\0' \"$entry\"; done");
    parse_listing(&run(connection, &script, None, 1024 * 1024)?)
}
fn parse_listing(data: &[u8]) -> Result<SshDirectoryListing> {
    if !data.ends_with(&[0]) {
        return Err("Réponse de dossiers SSH incomplète.".into());
    }
    let mut fields = data[..data.len() - 1].split(|byte| *byte == 0);
    let path = String::from_utf8(fields.next().ok_or("Dossier SSH absent.")?.to_vec())
        .map_err(|_| "Dossier SSH non Unicode.")?;
    validate_path(&path)?;
    let mut directories = Vec::new();
    for field in fields {
        let name =
            String::from_utf8(field.to_vec()).map_err(|_| "Nom de dossier SSH non Unicode.")?;
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err("Nom de dossier SSH invalide.".into());
        }
        if directories.len() >= 10_000 {
            return Err("Trop de sous-dossiers SSH : saisissez un chemin plus précis.".into());
        }
        let entry_path = format!("{}/{}", path.trim_end_matches('/'), name);
        validate_path(&entry_path)?;
        directories.push(SshDirectory {
            path: entry_path,
            name,
        });
    }
    directories.sort_by(|a, b| a.name.cmp(&b.name));
    let parent_path = if path == "/" {
        None
    } else {
        Some(
            path.rsplit_once('/')
                .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
                .unwrap_or("/")
                .into(),
        )
    };
    Ok(SshDirectoryListing {
        path,
        parent_path,
        directories,
    })
}

#[cfg(test)]
mod discovery_tests;
#[cfg(test)]
mod live_tests;

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod tests;
