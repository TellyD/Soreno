//! The internal loopback server the phone channels reach their conversations through, so that
//! a conversation is served exactly as a WebSocket client sees it.
use crate::{
    conversation, dtach, files, peer, sessions,
    stop::{self, Stop},
    wire::{Budgeted, Wire},
};
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::fd::AsRawFd,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    client::IntoClientRequest, handshake::derive_accept_key, protocol::WebSocketConfig,
};

const HEADER_LIMIT: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_CONNECTIONS: usize = 64;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
// Room for an input write that times out.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
pub const TOKEN_HEADER: &str = "X-Soreno-Bridge";

pub struct Bridge {
    pub sessions: [PathBuf; 2],
    /// Known to the channels only: no other program of the user, browsers included, gets in.
    pub token: String,
}

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    Refused(u16),
    Conversation { session: PathBuf, accept: String },
}

/// A place among the `MAX_CONNECTIONS`, given back when dropped.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn take(active: &Arc<AtomicUsize>) -> Option<Slot> {
        let slot = Slot(active.clone());
        (active.fetch_add(1, Ordering::AcqRel) < MAX_CONNECTIONS).then_some(slot)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Serves until `stop`, then lets the connections end for a while.
pub fn run(listener: TcpListener, bridge: Arc<Bridge>, stop: Arc<Stop>) {
    let active = Arc::new(AtomicUsize::new(0));
    if let Err(error) = listener.set_nonblocking(true) {
        eprintln!("soreno-remote : écoute interne : {error}");
        return;
    }
    loop {
        stop::poll(&[(listener.as_raw_fd(), false), (stop.fd(), false)], -1);
        if stop.requested() {
            break;
        }
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(error) => {
                eprintln!("soreno-remote : accept : {error}");
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let Some(slot) = Slot::take(&active) else {
            continue;
        };
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        let bridge = bridge.clone();
        let stop = stop.clone();
        let spawned = thread::Builder::new()
            .name("conversation".into())
            .spawn(move || {
                let _slot = slot;
                handle(stream, &bridge, &stop);
            });
        if let Err(error) = spawned {
            eprintln!("soreno-remote : thread : {error}");
        }
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while active.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
}

fn handle(mut stream: TcpStream, bridge: &Bridge, stop: &Stop) {
    let local_peer = stream
        .local_addr()
        .and_then(|local| Ok((local, stream.peer_addr()?)));
    if !local_peer.is_ok_and(|(local, peer)| peer::allowed(local, peer)) {
        return;
    }
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let (request, rest) = match read_request(&mut stream) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(status) => {
            let _ = refuse(&mut stream, status);
            return;
        }
    };
    match route(&request, bridge) {
        Reply::Refused(status) => {
            let _ = refuse(&mut stream, status);
        }
        Reply::Conversation { session, accept } => {
            let socket = session.join("socket");
            let Ok(dtach) = dtach::connect(&socket, Instant::now() + CONNECT_TIMEOUT) else {
                let _ = refuse(&mut stream, 404);
                return;
            };
            let upgrade = format!(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            if stream.write_all(upgrade.as_bytes()).is_ok() {
                conversation::serve(stream, rest, dtach, &session, stop);
            }
        }
    }
}

/// `Ok(None)`: the peer closed before sending a request.
fn read_request(stream: &mut TcpStream) -> Result<Option<(Request, Vec<u8>)>, u16> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        let read = match stream.read(&mut chunk) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok(None),
        };
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some((request, length)) = parse_request(&buffer)? {
            return Ok(Some((request, buffer.split_off(length))));
        }
    }
}

/// `Ok(None)` while the header is incomplete; otherwise the request and its header length.
pub fn parse_request(bytes: &[u8]) -> Result<Option<(Request, usize)>, u16> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut parsed = httparse::Request::new(&mut headers);
    let length = match parsed.parse(bytes) {
        Ok(httparse::Status::Complete(length)) if length > HEADER_LIMIT => return Err(431),
        Ok(httparse::Status::Complete(length)) => length,
        Ok(httparse::Status::Partial) if bytes.len() > HEADER_LIMIT => return Err(431),
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(_) => return Err(400),
    };
    let headers = parsed
        .headers
        .iter()
        .map(|header| {
            let value = std::str::from_utf8(header.value).map_err(|_| 400u16)?;
            Ok((header.name.to_owned(), value.trim().to_owned()))
        })
        .collect::<Result<_, u16>>()?;
    let request = Request {
        method: parsed.method.ok_or(400u16)?.to_owned(),
        path: parsed.path.ok_or(400u16)?.to_owned(),
        headers,
    };
    Ok(Some((request, length)))
}

/// A browser always sends `Origin` with a WebSocket: refused even with a leaked token.
pub fn route(request: &Request, bridge: &Bridge) -> Reply {
    let token = request.header(TOKEN_HEADER).unwrap_or_default();
    if request.header("Origin").is_some()
        || !files::same_secret(token.as_bytes(), bridge.token.as_bytes())
    {
        return Reply::Refused(403);
    }
    if request.method != "GET" {
        return Reply::Refused(405);
    }
    let Some(key) = request
        .path
        .strip_prefix("/api/sessions/")
        .and_then(|rest| rest.strip_suffix("/conversation"))
    else {
        return Reply::Refused(404);
    };
    let upgrade = request
        .header("Upgrade")
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let key_header = request
        .header("Sec-WebSocket-Key")
        .filter(|key| !key.is_empty());
    let accept = match (upgrade, key_header, request.header("Sec-WebSocket-Version")) {
        (true, Some(key), Some("13")) => derive_accept_key(key.as_bytes()),
        _ => return Reply::Refused(400),
    };
    match sessions::live(&bridge.sessions, key) {
        Some(session) => Reply::Conversation { session, accept },
        None => Reply::Refused(404),
    }
}

fn refuse(stream: &mut TcpStream, status: u16) -> io::Result<()> {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()
}

/// The conversation of `key` as a WebSocket client; `None` when the session is gone.
pub fn connect(
    address: SocketAddr,
    token: &str,
    key: &str,
    config: WebSocketConfig,
) -> Option<Wire> {
    let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    let mut request = format!("ws://{address}/api/sessions/{key}/conversation")
        .into_client_request()
        .ok()?;
    request
        .headers_mut()
        .insert(TOKEN_HEADER, token.parse().ok()?);
    let stream = Budgeted::new(stream);
    let (ws, _) = tungstenite::client::client_with_config(request, stream, Some(config)).ok()?;
    ws.get_ref().stream().set_read_timeout(None).ok()?;
    ws.get_ref().stream().set_write_timeout(None).ok()?;
    Wire::new(ws)
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
