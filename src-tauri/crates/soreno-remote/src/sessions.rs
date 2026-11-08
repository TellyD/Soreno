use crate::conversation;
use serde::Serialize;
use std::{
    fs,
    io::Read,
    os::unix::fs::{FileTypeExt, PermissionsExt},
    path::{Path, PathBuf},
    time::SystemTime,
};

const METADATA_LIMIT: u64 = 1 << 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Session {
    pub key: String,
    pub label: Option<String>,
    pub attached: bool,
    pub provider: Option<String>,
    pub name: Option<String>,
    pub working: Option<bool>,
    pub awaiting: bool,
    /// The agent's history was deleted while it runs; omitted otherwise.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    /// Hosted by the Chat page: input goes as RPC JSON lines, not keystrokes.
    pub rpc: bool,
}

/// Terminal sessions, then the Chat page's `omp --mode rpc-ui` sessions.
pub fn roots(home: &Path) -> [PathBuf; 2] {
    let cache = home.join(".cache/soreno");
    [cache.join("sessions"), cache.join(CONVERSATIONS)]
}

const CONVERSATIONS: &str = "conversations";

pub fn rpc(directory: &Path) -> bool {
    directory.parent().and_then(Path::file_name) == Some(CONVERSATIONS.as_ref())
}

pub fn valid_key(key: &str) -> bool {
    key.len() == 32
        && key
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Newest launch first, then by key: renaming or activity never moves a session.
pub fn list(roots: &[PathBuf]) -> Vec<Session> {
    let mut sessions: Vec<(SystemTime, Session)> = roots
        .iter()
        .filter_map(|root| Some((root, fs::read_dir(root).ok()?)))
        .flat_map(|(root, entries)| entries.flatten().map(move |entry| (root, entry)))
        .filter_map(|(root, entry)| {
            let key = entry.file_name().into_string().ok()?;
            let directory = live(std::slice::from_ref(root), &key)?;
            let socket = fs::metadata(directory.join("socket")).ok()?;
            let metadata = agent_metadata(&directory);
            let text = |field: &str| {
                metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get(field)?.as_str().map(str::to_owned))
            };
            let working = metadata
                .as_ref()
                .and_then(|metadata| metadata.get("working")?.as_bool());
            // dtach creates the socket at launch; attaching only changes its mode.
            let launched = socket.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let session = Session {
                label: label(&directory),
                attached: socket.permissions().mode() & 0o100 != 0,
                provider: text("provider"),
                name: text("name"),
                awaiting: metadata
                    .as_ref()
                    .is_some_and(|metadata| conversation::pending(metadata).awaiting(working)),
                working,
                deleted: metadata
                    .as_ref()
                    .is_some_and(|metadata| metadata["deleted"].as_bool() == Some(true)),
                rpc: rpc(&directory),
                key,
            };
            Some((launched, session))
        })
        .collect();
    sessions.sort_by(|(a_launched, a), (b_launched, b)| {
        b_launched.cmp(a_launched).then_with(|| a.key.cmp(&b.key))
    });
    sessions.into_iter().map(|(_, session)| session).collect()
}

/// The session directory when `key` names a running dtach session. shortcut: a key live in both roots (an old terminal run left on the server, then the session turned into a Chat) opens the terminal one; carry the root with the key if it shows up.
pub fn live(roots: &[PathBuf], key: &str) -> Option<PathBuf> {
    if !valid_key(key) {
        return None;
    }
    roots
        .iter()
        .map(|root| root.join(key))
        .find(|directory| running(directory))
}

pub fn running(directory: &Path) -> bool {
    let socket = fs::symlink_metadata(directory.join("socket"));
    if !socket.is_ok_and(|socket| socket.file_type().is_socket()) {
        return false;
    }
    let pid = fs::read_to_string(directory.join("pid"));
    let pid = pid
        .ok()
        .and_then(|pid| pid.split_whitespace().next()?.parse::<libc::pid_t>().ok());
    // pid 0 or negative would probe a whole process group.
    pid.is_some_and(|pid| pid > 0 && unsafe { libc::kill(pid, 0) } == 0)
}

fn label(directory: &Path) -> Option<String> {
    let label = fs::read_to_string(directory.join("label")).ok()?;
    let label: String = label.chars().filter(|c| !c.is_control()).collect();
    let label = label.trim();
    (!label.is_empty()).then(|| label.to_owned())
}

/// Terminal sessions name their launch directory in `agent`; Chat sessions keep `metadata.json` inline.
pub fn agent_metadata(directory: &Path) -> Option<serde_json::Value> {
    let launch = match fs::read_to_string(directory.join("agent")) {
        Ok(agent) => Some(PathBuf::from(agent.trim())).filter(|agent| agent.is_absolute())?,
        Err(_) => directory.to_owned(),
    };
    let mut bytes = Vec::new();
    fs::File::open(launch.join("metadata.json"))
        .ok()?
        .take(METADATA_LIMIT)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .filter(serde_json::Value::is_object)
}

pub fn host_name() -> String {
    let mut buffer = [0u8; 256];
    let name = if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
        let end = buffer.iter().position(|&byte| byte == 0).unwrap_or(0);
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    } else {
        String::new()
    };
    name.split('.').next().unwrap_or_default().to_owned()
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
