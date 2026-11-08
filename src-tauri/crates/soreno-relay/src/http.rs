use crate::{
    net::{Listener, Stream},
    phone,
    relay::{Counts, Relay},
    server,
    stop::{self, Stop},
};
use std::{
    io::{self, Read, Write},
    net::IpAddr,
    os::fd::AsRawFd,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::handshake::derive_accept_key;

const HEADER_LIMIT: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;
/// Per listener; each connection holds a thread.
const MAX_CONNECTIONS: usize = 2048;
/// On the servers' listener, handshaking or linked: one host cannot take every slot.
pub const SERVERS_PER_ADDRESS: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
/// For the whole header, so that a peer trickling bytes cannot hold a slot.
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// Which listener a connection came through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// Behind Caddy: the phones' WebSockets.
    Phones,
    /// The servers' links, in the clear under Noise.
    Servers,
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
pub struct Response {
    pub status: u16,
    pub body: &'static str,
}

impl Response {
    fn text(status: u16, body: &'static str) -> Self {
        Self { status, body }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    Response(Response),
    Phone { server: String, accept: String },
    Server { accept: String },
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

/// A place among the `SERVERS_PER_ADDRESS` of a peer, given back when dropped.
struct Quota(Arc<Counts<IpAddr>>, IpAddr);

impl Quota {
    fn take(peers: &Arc<Counts<IpAddr>>, peer: IpAddr) -> Option<Quota> {
        peers
            .take(peer, SERVERS_PER_ADDRESS)
            .then(|| Quota(peers.clone(), peer))
    }
}

impl Drop for Quota {
    fn drop(&mut self) {
        self.0.give(&self.1);
    }
}

/// Serves until `stop`, then lets the connections end for a while.
pub fn run(listener: Listener, side: Side, relay: Arc<Relay>, stop: Arc<Stop>) {
    let active = Arc::new(AtomicUsize::new(0));
    let peers = Arc::new(Counts::default());
    if let Err(error) = listener.set_nonblocking(true) {
        eprintln!("soreno-relay : écoute : {error}");
        return;
    }
    loop {
        stop::poll(&[(listener.as_raw_fd(), false), (stop.fd(), false)], -1);
        if stop.requested() {
            break;
        }
        let stream = match listener.accept() {
            Ok(stream) => stream,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(error) => {
                eprintln!("soreno-relay : accept : {error}");
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let Some(slot) = Slot::take(&active) else {
            continue;
        };
        // Behind Caddy, phones all come from it: they are counted by `Relay::admit` instead.
        let quota = match stream.peer_ip() {
            Ok(Some(peer)) if side == Side::Servers => match Quota::take(&peers, peer) {
                None => continue,
                quota => quota,
            },
            _ => None,
        };
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        let relay = relay.clone();
        let stop = stop.clone();
        let spawned = thread::Builder::new()
            .name("connexion".into())
            .spawn(move || {
                let _held = (slot, quota);
                handle(stream, side, &relay, &stop);
            });
        if let Err(error) = spawned {
            eprintln!("soreno-relay : thread : {error}");
        }
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while active.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
}

fn handle(mut stream: Stream, side: Side, relay: &Relay, stop: &Stop) {
    let Ok(peer) = stream.peer_ip() else {
        return;
    };
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let (request, rest) = match read_request(&mut stream, Instant::now() + HEADER_TIMEOUT) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(response) => {
            let _ = write_response(&mut stream, &response);
            return;
        }
    };
    let address = client_address(&request, peer);
    match route(&request, side, relay) {
        Reply::Response(response) => {
            if response.status == 403 {
                match address {
                    Some(address) => eprintln!("soreno-relay : origine refusée ({address})"),
                    None => eprintln!("soreno-relay : origine refusée"),
                }
            }
            let _ = write_response(&mut stream, &response);
        }
        Reply::Phone { server, accept } => {
            // Behind Caddy's Unix socket, only `X-Forwarded-For` names the phone.
            let Some(address) = address else {
                return;
            };
            if upgrade(&mut stream, &accept) {
                phone::serve(stream, rest, relay, &server, address, stop);
            }
        }
        Reply::Server { accept } => {
            // The servers' listener is always TCP.
            let Some(peer) = peer else {
                return;
            };
            if upgrade(&mut stream, &accept) {
                server::serve(stream, rest, relay, peer, stop);
            }
        }
    }
}

/// Caddy appends the address it saw to `X-Forwarded-For`: only its last entry is trusted.
fn client_address(request: &Request, peer: Option<IpAddr>) -> Option<IpAddr> {
    request
        .header("X-Forwarded-For")
        .and_then(|value| value.rsplit(',').next())
        .and_then(|last| last.trim().parse().ok())
        .or(peer)
}

fn upgrade(stream: &mut Stream, accept: &str) -> bool {
    let upgrade = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    stream.write_all(upgrade.as_bytes()).is_ok()
}

/// `Ok(None)`: the peer closed or had not sent its whole header by `deadline`.
fn read_request(
    stream: &mut Stream,
    deadline: Instant,
) -> Result<Option<(Request, Vec<u8>)>, Response> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            return Ok(None);
        }
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
pub fn parse_request(bytes: &[u8]) -> Result<Option<(Request, usize)>, Response> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut parsed = httparse::Request::new(&mut headers);
    let bad = || Response::text(400, "Requête invalide");
    let too_long = || Response::text(431, "En-têtes trop longs");
    let length = match parsed.parse(bytes) {
        Ok(httparse::Status::Complete(length)) if length > HEADER_LIMIT => return Err(too_long()),
        Ok(httparse::Status::Complete(length)) => length,
        Ok(httparse::Status::Partial) if bytes.len() > HEADER_LIMIT => return Err(too_long()),
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(_) => return Err(bad()),
    };
    let headers = parsed
        .headers
        .iter()
        .map(|header| {
            let value = std::str::from_utf8(header.value).map_err(|_| bad())?;
            Ok((header.name.to_owned(), value.trim().to_owned()))
        })
        .collect::<Result<_, Response>>()?;
    let request = Request {
        method: parsed.method.ok_or_else(bad)?.to_owned(),
        path: parsed.path.ok_or_else(bad)?.to_owned(),
        headers,
    };
    Ok(Some((request, length)))
}

pub fn route(request: &Request, side: Side, relay: &Relay) -> Reply {
    if request.method != "GET" {
        return Reply::Response(Response::text(405, "Méthode non autorisée"));
    }
    let path = request.path.split(['?', '#']).next().unwrap_or_default();
    match side {
        Side::Servers if path == "/relay/server" => match websocket_accept(request) {
            Ok(accept) => Reply::Server { accept },
            Err(response) => Reply::Response(response),
        },
        Side::Servers => Reply::Response(not_found()),
        Side::Phones => {
            let Some(server) = path.strip_prefix("/relay/phone/") else {
                return Reply::Response(not_found());
            };
            if request.header("Origin") != Some(relay.origin.as_str()) {
                return Reply::Response(Response::text(403, "Origine refusée"));
            }
            match websocket_accept(request) {
                Ok(accept) => Reply::Phone {
                    server: server.to_owned(),
                    accept,
                },
                Err(response) => Reply::Response(response),
            }
        }
    }
}

fn not_found() -> Response {
    Response::text(404, "Introuvable")
}

fn websocket_accept(request: &Request) -> Result<String, Response> {
    let upgrade = request
        .header("Upgrade")
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let key_header = request
        .header("Sec-WebSocket-Key")
        .filter(|key| !key.is_empty());
    match (upgrade, key_header, request.header("Sec-WebSocket-Version")) {
        (true, Some(key), Some("13")) => Ok(derive_accept_key(key.as_bytes())),
        _ => Err(Response::text(400, "WebSocket attendu")),
    }
}

fn write_response(stream: &mut Stream, response: &Response) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{}",
        response.status,
        reason(response.status),
        response.body.len(),
        response.body,
    )?;
    stream.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    }
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
