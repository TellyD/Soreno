use crate::{
    dtach,
    history::{Item, Normalizer, Pending, Provider},
    images, sessions,
    stop::Stop,
    wire::{Budgeted, Wire},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    net::TcpStream,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};
use tungstenite::{
    protocol::{Role, WebSocketConfig},
    WebSocket,
};

const TICK: Duration = Duration::from_millis(500);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const INPUT_LIMIT: usize = 64 * 1024;
/// An image with room for its fields, far above an input message.
pub const MESSAGE_LIMIT: usize = images::ENCODED_LIMIT + (1 << 20);
// Well below the stop wait of `bridge::run`.
const DTACH_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const LINE_LIMIT: usize = 4 << 20;
const TAIL: u64 = 8 << 20;
const FIRST_ITEMS: usize = 200;
/// Read per batch, so a burst of history leaves room for input and pings.
const READ_LIMIT: u64 = 1 << 20;
/// Room for the first items and a batch; past it the connection closes.
const SEND_LIMIT: usize = 16 << 20;
const CHUNK: usize = 64 * 1024;
/// Enough for the last lines of a turn; a longer one only hides the session list badge.
const PENDING_TAIL: u64 = 1 << 20;
const PENDING_MEMORY: usize = 256;

/// Histories read for the session list, by path and stamp: the list is taken every second.
static PENDING: Mutex<Vec<(PathBuf, (u64, u64, u64), Pending)>> = Mutex::new(Vec::new());

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Input {
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        id: u64,
        mime_type: String,
        data: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage<'a> {
    Reset {
        provider: Option<Provider>,
        available: bool,
        truncated: bool,
        /// Tells the page it may send images, which an older server would not answer.
        images: bool,
        /// The agent's history was deleted while it runs; omitted otherwise.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        deleted: bool,
        /// The page sends RPC prompts instead of keystrokes.
        rpc: bool,
        /// The last items: in the same message, so the page never shows the history empty first.
        items: &'a [Item],
    },
    Items {
        items: &'a [Item],
    },
    Status {
        working: Option<bool>,
    },
    Ended,
    ImageSaved {
        id: u64,
        path: &'a str,
    },
    ImageFailed {
        id: u64,
    },
}

/// An agent history file, read line by line as it grows.
struct History {
    path: PathBuf,
    file: File,
    identity: (u64, u64),
    /// Where the next read starts.
    offset: u64,
    /// The incomplete line read so far, and where it starts.
    line: Vec<u8>,
    line_start: u64,
    /// Dropping a line cut by the tail start or longer than `LINE_LIMIT`, up to its end.
    skipping: bool,
    normalizer: Normalizer,
}

fn owned_file(metadata: &Metadata) -> bool {
    metadata.file_type().is_file() && metadata.uid() == unsafe { libc::geteuid() }
}

impl History {
    /// The file with its last items, and whether older ones were left out.
    fn open(path: &Path, provider: Provider) -> Option<(Self, Vec<Item>, bool)> {
        let (history, mut items, start) = Self::tail(path, provider, TAIL)?;
        let truncated = start > 0 || items.len() > FIRST_ITEMS;
        items.drain(..items.len().saturating_sub(FIRST_ITEMS));
        Some((history, items, truncated))
    }

    /// The file with the items of its last `tail` bytes, and where they start.
    fn tail(path: &Path, provider: Provider, tail: u64) -> Option<(Self, Vec<Item>, u64)> {
        if !path.is_absolute() {
            return None;
        }
        let linked = fs::symlink_metadata(path).ok()?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .ok()?;
        let opened = file.metadata().ok()?;
        let identity = (opened.dev(), opened.ino());
        if !owned_file(&linked) || !owned_file(&opened) || identity != (linked.dev(), linked.ino())
        {
            return None;
        }
        let start = opened.len().saturating_sub(tail);
        // From the byte before the tail: a newline there means the first line is whole.
        let offset = start.saturating_sub(1);
        let mut history = Self {
            path: path.to_owned(),
            file,
            identity,
            offset,
            line: Vec::new(),
            line_start: offset,
            skipping: start > 0,
            normalizer: Normalizer::new(provider),
        };
        let (items, _) = history.read(tail + READ_LIMIT);
        Some((history, items, start))
    }

    /// The items of the lines completed since, and whether more is left to read.
    fn read(&mut self, limit: u64) -> (Vec<Item>, bool) {
        let mut items = Vec::new();
        if self.file.seek(SeekFrom::Start(self.offset)).is_err() {
            return (items, false);
        }
        let mut buffer = vec![0u8; CHUNK];
        let mut read_total = 0;
        while read_total < limit {
            let read = match self.file.read(&mut buffer) {
                Ok(0) => return (items, false),
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return (items, false),
            };
            self.feed(&buffer[..read], &mut items);
            read_total += read as u64;
        }
        (items, true)
    }

    fn feed(&mut self, mut bytes: &[u8], items: &mut Vec<Item>) {
        while let Some(end) = bytes.iter().position(|&byte| byte == b'\n') {
            if !self.skipping && self.line.len() + end <= LINE_LIMIT {
                self.line.extend_from_slice(&bytes[..end]);
                items.extend(self.normalizer.line(&self.line, self.line_start));
            }
            self.line.clear();
            self.skipping = false;
            self.offset += end as u64 + 1;
            self.line_start = self.offset;
            bytes = &bytes[end + 1..];
        }
        if self.line.len() + bytes.len() > LINE_LIMIT {
            self.line.clear();
            self.skipping = true;
        }
        if !self.skipping {
            self.line.extend_from_slice(bytes);
        }
        self.offset += bytes.len() as u64;
    }

    /// Another file now has the path, or this one shrank.
    fn replaced(&self) -> bool {
        let moved = fs::symlink_metadata(&self.path)
            .is_ok_and(|metadata| (metadata.dev(), metadata.ino()) != self.identity);
        let shrunk = self
            .file
            .metadata()
            .is_ok_and(|metadata| metadata.len() < self.offset);
        moved || shrunk
    }
}

/// What `metadata.json` says the conversation is.
#[derive(Debug, PartialEq, Eq)]
struct Source {
    provider: Option<Provider>,
    file: Option<PathBuf>,
    deleted: bool,
}

struct Conversation<'a> {
    wire: Wire,
    /// Input only, never attached.
    dtach: UnixStream,
    session: &'a Path,
    source: Option<Source>,
    history: Option<History>,
    working: Option<Option<bool>>,
    next_tick: Instant,
}

pub fn serve(stream: TcpStream, rest: Vec<u8>, dtach: UnixStream, session: &Path, stop: &Stop) {
    let config = WebSocketConfig::default()
        .max_message_size(Some(MESSAGE_LIMIT))
        .max_write_buffer_size(SEND_LIMIT);
    let ws =
        WebSocket::from_partially_read(Budgeted::new(stream), rest, Role::Server, Some(config));
    let Some(wire) = Wire::new(ws) else {
        return;
    };
    let mut conversation = Conversation {
        wire,
        dtach,
        session,
        source: None,
        history: None,
        working: None,
        next_tick: Instant::now(),
    };
    let ended = conversation.run(stop);
    if ended {
        conversation.wire.finish(Instant::now() + CLOSE_TIMEOUT);
    } else {
        conversation.wire.close();
    }
}

impl Conversation<'_> {
    /// `true` when the session ended, `false` when the client left.
    fn run(&mut self, stop: &Stop) -> bool {
        loop {
            if stop.requested() {
                return false;
            }
            let (texts, alive) = self.wire.receive();
            for text in texts {
                if !self.handle(&text, stop) {
                    return false;
                }
            }
            if !alive {
                return false;
            }
            if Instant::now() >= self.next_tick {
                self.next_tick = Instant::now() + TICK;
                if !sessions::running(self.session) {
                    // The agent may have switched to another history just before ending.
                    if sessions::agent_metadata(self.session).is_some() && !self.follow() {
                        return false;
                    }
                    self.drain(stop, Instant::now() + CLOSE_TIMEOUT);
                    self.send(&ServerMessage::Ended);
                    return true;
                }
                if !self.follow() {
                    return false;
                }
            }
            self.wire.wait(&[stop.fd()], Some(self.next_tick));
        }
    }

    /// `false` closes the connection.
    fn handle(&mut self, text: &str, stop: &Stop) -> bool {
        match serde_json::from_str(text) {
            Ok(ClientMessage::Input { data }) => {
                if data.len() > INPUT_LIMIT {
                    return false;
                }
                let deadline = Instant::now() + DTACH_WRITE_TIMEOUT;
                let packets = dtach::push_packets(data.as_bytes());
                dtach::write_until(&mut self.dtach, &packets, deadline, Some(stop))
            }
            Ok(ClientMessage::Image {
                id,
                mime_type,
                data,
            }) => {
                let saved = images::save(self.session, &mime_type, &data);
                match saved.as_deref().and_then(Path::to_str) {
                    Some(path) => self.send(&ServerMessage::ImageSaved { id, path }),
                    None => self.send(&ServerMessage::ImageFailed { id }),
                }
            }
            Err(_) => true,
        }
    }

    /// Sends what changed since the last tick; `false` when the client is gone.
    fn follow(&mut self) -> bool {
        let metadata = sessions::agent_metadata(self.session).unwrap_or_default();
        let provider = metadata["provider"].as_str().and_then(Provider::parse);
        let source = Source {
            provider,
            file: provider.and(history_file(&metadata)).map(PathBuf::from),
            deleted: metadata["deleted"].as_bool() == Some(true),
        };
        let working = metadata["working"].as_bool();
        let changed = self.source.as_ref() != Some(&source);
        let stale = self.history.as_ref().is_some_and(History::replaced);
        let waiting = self.history.is_none() && source.file.is_some();
        let sent = if changed || stale || waiting {
            let opened = source
                .provider
                .zip(source.file.as_deref())
                .and_then(|(provider, file)| History::open(file, provider));
            if changed || stale || opened.is_some() {
                self.source = Some(source);
                self.reset(opened)
            } else {
                true
            }
        } else {
            self.read_more()
        };
        if !sent {
            return false;
        }
        if self.working != Some(working) {
            self.working = Some(working);
            return self.send(&ServerMessage::Status { working });
        }
        true
    }

    fn reset(&mut self, opened: Option<(History, Vec<Item>, bool)>) -> bool {
        let provider = self.source.as_ref().and_then(|source| source.provider);
        let (history, items, truncated) = match opened {
            Some((history, items, truncated)) => (Some(history), items, truncated),
            None => (None, Vec::new(), false),
        };
        let reset = ServerMessage::Reset {
            provider,
            available: history.is_some(),
            truncated,
            images: true,
            deleted: history.is_none() && self.source.as_ref().is_some_and(|source| source.deleted),
            rpc: sessions::rpc(self.session),
            items: &items,
        };
        self.history = history;
        self.send(&reset)
    }

    /// Waits while the client has not taken the last items: a slow one never grows the buffer.
    fn read_more(&mut self) -> bool {
        if !self.wire.flushed() {
            return true;
        }
        let Some(history) = &mut self.history else {
            return true;
        };
        let (items, more) = history.read(READ_LIMIT);
        if more {
            self.next_tick = Instant::now();
        }
        self.send_items(&items)
    }

    /// Sends the lines the agent completed before the session ended, until `deadline`.
    fn drain(&mut self, stop: &Stop, deadline: Instant) {
        while self.history.is_some() && !stop.requested() && Instant::now() < deadline {
            if !self.wire.flushed() {
                self.wire.wait(&[stop.fd()], Some(deadline));
                continue;
            }
            let Some(history) = &mut self.history else {
                return;
            };
            let (items, more) = history.read(READ_LIMIT);
            if !self.send_items(&items) || !more {
                return;
            }
        }
    }

    fn send_items(&mut self, items: &[Item]) -> bool {
        items.is_empty() || self.send(&ServerMessage::Items { items })
    }

    fn send(&mut self, message: &ServerMessage) -> bool {
        self.wire
            .send(serde_json::to_string(message).expect("message sérialisable"))
    }
}

/// Pi and OMP report `sessionFile`; Claude and Codex hooks leave the transcript in their
/// payload, nested under `identity` once they report activity.
fn history_file(metadata: &serde_json::Value) -> Option<&str> {
    if let Some(file) = metadata["sessionFile"].as_str() {
        return Some(file);
    }
    let identity = &metadata["identity"];
    let hook = if identity.is_object() {
        // An identity from another run belongs to a stale launch.
        (identity["runId"] == metadata["runId"]).then_some(identity)?
    } else {
        metadata
    };
    hook["payload"]["transcript_path"].as_str()
}

/// The calls without result that end the conversation `metadata` describes.
pub fn pending(metadata: &serde_json::Value) -> Pending {
    let provider = metadata["provider"].as_str().and_then(Provider::parse);
    let (Some(provider), Some(file)) = (provider, history_file(metadata)) else {
        return Pending::default();
    };
    let path = Path::new(file);
    let Ok(found) = fs::symlink_metadata(path) else {
        return Pending::default();
    };
    let stamp = (found.dev(), found.ino(), found.len());
    let remembered = PENDING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .find(|(known, known_stamp, _)| known == path && *known_stamp == stamp)
        .map(|(_, _, pending)| *pending);
    if let Some(pending) = remembered {
        return pending;
    }
    let pending = History::tail(path, provider, PENDING_TAIL)
        .map_or_else(Pending::default, |(_, items, _)| Pending::of(&items));
    let mut memory = PENDING.lock().unwrap_or_else(PoisonError::into_inner);
    memory.retain(|(known, _, _)| known != path);
    if memory.len() >= PENDING_MEMORY {
        memory.remove(0);
    }
    memory.push((path.to_owned(), stamp, pending));
    pending
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{shrink_buffer, TempDir};
    use std::{
        io::Write,
        net::{TcpListener, TcpStream},
    };
    use tungstenite::Message;

    fn message(id: usize) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"m{id}\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"réponse {id}\"}}]}}}}\n"
        )
    }

    fn texts(items: &[Item]) -> Vec<String> {
        items
            .iter()
            .map(|item| match item {
                Item::Assistant { text, .. } => text.clone(),
                other => panic!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn hook_agents_find_their_transcript_in_the_hook_payload() {
        let path = "/home/u/.claude/projects/p/s.jsonl";
        let omp = serde_json::json!({"runId": "r", "provider": "omp", "sessionFile": "/h/s.jsonl"});
        assert_eq!(history_file(&omp), Some("/h/s.jsonl"));
        let started = serde_json::json!({
            "runId": "r", "provider": "claude",
            "payload": {"hook_event_name": "SessionStart", "transcript_path": path},
        });
        assert_eq!(history_file(&started), Some(path));
        let active = serde_json::json!({
            "runId": "r", "provider": "claude", "working": true,
            "identity": {"runId": "r", "payload": {"transcript_path": path}},
        });
        assert_eq!(history_file(&active), Some(path));
        let stale = serde_json::json!({
            "runId": "r", "provider": "codex", "working": false,
            "identity": {"runId": "old", "payload": {"transcript_path": path}},
        });
        assert_eq!(history_file(&stale), None);
    }

    /// A conversation following `history` for a client socket returned with it.
    /// Small socket buffers: a client that does not read fills them within a batch.
    fn following(session: &Path, history: History) -> (Conversation<'_>, WebSocket<TcpStream>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        shrink_buffer(&client, libc::SO_RCVBUF);
        let server = listener.accept().unwrap().0;
        shrink_buffer(&server, libc::SO_SNDBUF);
        let config = WebSocketConfig::default().max_write_buffer_size(SEND_LIMIT);
        let ws = WebSocket::from_raw_socket(Budgeted::new(server), Role::Server, Some(config));
        let conversation = Conversation {
            wire: Wire::new(ws).unwrap(),
            dtach: UnixStream::pair().unwrap().0,
            session,
            source: None,
            history: Some(history),
            working: None,
            next_tick: Instant::now(),
        };
        (
            conversation,
            WebSocket::from_raw_socket(client, Role::Client, None),
        )
    }

    #[test]
    fn a_client_that_does_not_read_stops_the_reading_of_the_history() {
        let temp = TempDir::new();
        let path = temp.path().join("s.jsonl");
        fs::write(&path, message(0)).unwrap();
        let (history, _, _) = History::open(&path, Provider::Omp).unwrap();
        let line = format!(
            "{{\"type\":\"message\",\"id\":\"m\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}\n",
            "x".repeat(4000)
        );
        let added = line.repeat((8 * READ_LIMIT as usize) / line.len());
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(added.as_bytes())
            .unwrap();
        let length = fs::metadata(&path).unwrap().len();
        let (mut conversation, _client) = following(temp.path(), history);
        for _ in 0..100 {
            assert!(conversation.read_more());
        }
        let offset = conversation.history.as_ref().unwrap().offset;
        assert!(offset < length / 2, "{offset} lus sur {length}");
    }

    #[test]
    fn lines_added_just_before_the_session_ends_go_out_before_ended() {
        let temp = TempDir::new();
        let path = temp.path().join("s.jsonl");
        fs::write(&path, message(1)).unwrap();
        let (history, _, _) = History::open(&path, Provider::Omp).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(message(2).as_bytes()).unwrap();
        // No dtach socket in the session directory: the session has ended.
        let (mut conversation, mut client) = following(temp.path(), history);
        assert!(conversation.run(&Stop::new().unwrap()));
        let mut received = Vec::new();
        while received.last() != Some(&serde_json::json!({"type": "ended"})) {
            if let Message::Text(text) = client.read().unwrap() {
                received.push(serde_json::from_str::<serde_json::Value>(text.as_str()).unwrap());
            }
        }
        assert_eq!(
            received,
            serde_json::json!([
                {"type": "items", "items": [{"kind": "assistant", "id": "m2:0", "text": "réponse 2"}]},
                {"type": "ended"},
            ])
            .as_array()
            .unwrap()
            .clone()
        );
    }

    #[test]
    fn a_history_switched_to_just_before_the_end_is_shown_before_ended() {
        let temp = TempDir::new();
        let old = temp.path().join("ancien.jsonl");
        let new = temp.path().join("nouveau.jsonl");
        fs::write(&old, message(1)).unwrap();
        fs::write(&new, message(2)).unwrap();
        let agent = temp.path().join("agent");
        fs::create_dir(&agent).unwrap();
        fs::write(
            agent.join("metadata.json"),
            serde_json::json!({"provider": "omp", "sessionFile": new, "working": false})
                .to_string(),
        )
        .unwrap();
        let session = temp.path().join("session");
        fs::create_dir(&session).unwrap();
        fs::write(session.join("agent"), agent.to_str().unwrap()).unwrap();
        let (history, _, _) = History::open(&old, Provider::Omp).unwrap();
        let (mut conversation, mut client) = following(&session, history);
        conversation.source = Some(Source {
            provider: Some(Provider::Omp),
            file: Some(old),
            deleted: false,
        });
        conversation.working = Some(Some(false));
        assert!(conversation.run(&Stop::new().unwrap()));
        let mut received = Vec::new();
        while received.last() != Some(&serde_json::json!({"type": "ended"})) {
            if let Message::Text(text) = client.read().unwrap() {
                received.push(serde_json::from_str::<serde_json::Value>(text.as_str()).unwrap());
            }
        }
        assert_eq!(
            received,
            serde_json::json!([
                {
                    "type": "reset", "provider": "omp", "available": true, "truncated": false,
                    "images": true, "rpc": false, "items": [{"kind": "assistant", "id": "m2:0", "text": "réponse 2"}],
                },
                {"type": "ended"},
            ])
            .as_array()
            .unwrap()
            .clone()
        );
    }

    #[test]
    fn a_history_deleted_while_followed_is_reported_as_deleted() {
        let temp = TempDir::new();
        let path = temp.path().join("s.jsonl");
        fs::write(&path, message(1)).unwrap();
        let agent = temp.path().join("agent");
        fs::create_dir(&agent).unwrap();
        let metadata = |deleted: bool| {
            let metadata = serde_json::json!({
                "provider": "omp", "sessionFile": path, "working": false, "deleted": deleted,
            });
            fs::write(agent.join("metadata.json"), metadata.to_string()).unwrap();
        };
        metadata(false);
        let session = temp.path().join("session");
        fs::create_dir(&session).unwrap();
        fs::write(session.join("agent"), agent.to_str().unwrap()).unwrap();
        let (history, _, _) = History::open(&path, Provider::Omp).unwrap();
        let (mut conversation, mut client) = following(&session, history);
        conversation.source = Some(Source {
            provider: Some(Provider::Omp),
            file: Some(path.clone()),
            deleted: false,
        });
        conversation.working = Some(Some(false));
        fs::remove_file(&path).unwrap();
        metadata(true);
        assert!(conversation.follow());
        let Message::Text(text) = client.read().unwrap() else {
            panic!("message texte attendu");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(text.as_str()).unwrap(),
            serde_json::json!({
                "type": "reset", "provider": "omp", "available": false,
                "truncated": false, "images": true, "deleted": true, "rpc": false, "items": [],
            })
        );
    }

    #[test]
    fn the_first_batch_keeps_the_last_items_and_says_older_ones_exist() {
        let temp = TempDir::new();
        let path = temp.path().join("s.jsonl");
        fs::write(&path, (0..FIRST_ITEMS + 5).map(message).collect::<String>()).unwrap();
        let (_, items, truncated) = History::open(&path, Provider::Omp).unwrap();
        assert!(truncated);
        assert_eq!(items.len(), FIRST_ITEMS);
        assert_eq!(texts(&items[..1]), ["réponse 5"]);

        fs::write(&path, message(1)).unwrap();
        let (_, items, truncated) = History::open(&path, Provider::Omp).unwrap();
        assert!(!truncated);
        assert_eq!(texts(&items), ["réponse 1"]);
    }

    #[test]
    fn only_complete_lines_are_read_and_overlong_ones_are_dropped() {
        let temp = TempDir::new();
        let path = temp.path().join("s.jsonl");
        fs::write(&path, message(1)).unwrap();
        let (mut history, _, _) = History::open(&path, Provider::Omp).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        let second = message(2);
        let (head, tail) = second.split_at(20);
        file.write_all(head.as_bytes()).unwrap();
        assert!(history.read(READ_LIMIT).0.is_empty());
        file.write_all(tail.as_bytes()).unwrap();
        assert_eq!(texts(&history.read(READ_LIMIT).0), ["réponse 2"]);

        file.write_all(&vec![b'x'; LINE_LIMIT + 1]).unwrap();
        file.write_all(format!("\n{}", message(3)).as_bytes())
            .unwrap();
        let mut items = Vec::new();
        loop {
            let (read, more) = history.read(READ_LIMIT);
            items.extend(read);
            if !more {
                break;
            }
        }
        assert_eq!(texts(&items), ["réponse 3"]);
        assert!(!history.replaced());
    }

    #[test]
    fn a_replaced_or_shrunk_file_is_noticed() {
        let temp = TempDir::new();
        let path = temp.path().join("s.jsonl");
        fs::write(&path, message(1) + &message(2)).unwrap();
        let (history, _, _) = History::open(&path, Provider::Omp).unwrap();
        fs::write(&path, message(1)).unwrap();
        assert!(history.replaced());

        let (history, _, _) = History::open(&path, Provider::Omp).unwrap();
        let other = temp.path().join("autre.jsonl");
        fs::write(&other, message(1)).unwrap();
        fs::rename(&other, &path).unwrap();
        assert!(history.replaced());
    }

    #[test]
    fn links_and_relative_paths_are_refused() {
        let temp = TempDir::new();
        let path = temp.path().join("s.jsonl");
        fs::write(&path, message(1)).unwrap();
        let link = temp.path().join("lien.jsonl");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(History::open(&link, Provider::Omp).is_none());
        assert!(History::open(Path::new("s.jsonl"), Provider::Omp).is_none());
        assert!(History::open(temp.path(), Provider::Omp).is_none());
    }
}
