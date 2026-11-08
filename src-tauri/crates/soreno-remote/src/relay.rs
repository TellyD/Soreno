//! The link to the Soreno relay: an outgoing WebSocket, Noise between this server and the relay,
//! then the frames of the phones' channels.
use crate::{
    channel::{self, Context, Handle},
    identity::Identity,
    mailbox::Mailbox,
    state::State,
    stop::{self, Stop},
    wire::{Budgeted, Wire},
};
use soreno_mobile_protocol::{
    initiator, open, seal, Frame, Key, TransportState, LINK_READY, NOISE_MESSAGE_LIMIT,
    RELAY_PROLOGUE,
};
use std::{
    collections::{HashMap, VecDeque},
    net::{TcpStream, ToSocketAddrs},
    os::fd::AsRawFd,
    sync::{atomic::Ordering, Arc},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    client::IntoClientRequest, handshake::HandshakeError, protocol::WebSocketConfig,
};

const FIRST_RETRY: Duration = Duration::from_secs(1);
const LAST_RETRY: Duration = Duration::from_secs(30);
/// A link that held this long was not refused: the next one is tried at once.
const STABLE_LINK: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The relay's own limit.
pub const MAX_CHANNELS: usize = 32;
/// Unsent bytes on the link; the channels' own limits keep it far below.
const LINK_SEND_LIMIT: usize = 64 << 20;
pub const LINK_PATH: &str = "/relay/server";

/// Where the relay takes servers, and its static key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// `host:port`.
    pub authority: String,
    pub url: String,
    pub key: Key,
}

impl Endpoint {
    /// `ws://<host>:<port>`, optionally with the link path; no TLS: Noise protects the link.
    pub fn parse(url: &str, key: &str) -> Option<Self> {
        let rest = url.strip_prefix("ws://")?;
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let (host, port) = authority.rsplit_once(':')?;
        if host.is_empty() || port.parse::<u16>().ok()? == 0 {
            return None;
        }
        if !matches!(path, "" | "relay/server") {
            return None;
        }
        Some(Self {
            authority: authority.to_owned(),
            url: format!("ws://{authority}{LINK_PATH}"),
            key: soreno_mobile_protocol::decode_key(key)?,
        })
    }
}

/// Links to the relay until `stop`, again and again with a growing pause while it fails.
pub fn run(
    endpoint: &Endpoint,
    identity: &Identity,
    context: &Context,
    state: &State,
    stop: &Stop,
) {
    let mut delay = FIRST_RETRY;
    let mut failing = false;
    while !stop.requested() {
        let started = Instant::now();
        match connect(endpoint, identity, stop, HANDSHAKE_TIMEOUT) {
            Ok((wire, transport, early)) => {
                eprintln!("soreno-remote : relié au relais {}", endpoint.authority);
                failing = false;
                state.set_connected(true);
                serve(wire, transport, early, context, stop);
                state.set_connected(false);
                eprintln!("soreno-remote : lien avec le relais coupé");
            }
            Err(error) => {
                if !failing && !stop.requested() {
                    eprintln!(
                        "soreno-remote : relais {} injoignable : {error}",
                        endpoint.authority
                    );
                }
                failing = true;
            }
        }
        if started.elapsed() >= STABLE_LINK {
            delay = FIRST_RETRY;
        } else {
            stop::poll(&[(stop.fd(), false)], delay.as_millis() as i32);
            delay = (delay * 2).min(LAST_RETRY);
        }
    }
}

/// The link, its Noise transport, and the relay's messages that came along with its answer.
type Linked = (Wire, TransportState, Vec<Vec<u8>>);

/// The link once its WebSocket upgrade and its Noise handshake are done within `handshake`, or
/// an error as soon as `stop` is requested.
fn connect(
    endpoint: &Endpoint,
    identity: &Identity,
    stop: &Stop,
    handshake: Duration,
) -> Result<Linked, String> {
    let addresses = endpoint
        .authority
        .to_socket_addrs()
        .map_err(|error| error.to_string())?;
    let mut last_error = String::from("adresse introuvable");
    let stream = addresses
        .into_iter()
        .find_map(
            |address| match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
                Ok(stream) => Some(stream),
                Err(error) => {
                    last_error = error.to_string();
                    None
                }
            },
        )
        .ok_or(last_error)?;
    let deadline = Instant::now() + handshake;
    let failed = |error: &dyn std::fmt::Display| error.to_string();
    stream.set_nonblocking(true).map_err(|e| failed(&e))?;
    let fd = stream.as_raw_fd();
    let request = endpoint
        .url
        .as_str()
        .into_client_request()
        .map_err(|e| failed(&e))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(NOISE_MESSAGE_LIMIT))
        .max_frame_size(Some(NOISE_MESSAGE_LIMIT))
        .max_write_buffer_size(LINK_SEND_LIMIT);
    let stream = Budgeted::new(stream);
    let mut upgrade = tungstenite::client::client_with_config(request, stream, Some(config));
    let ws = loop {
        match upgrade {
            Ok((ws, _)) => break ws,
            Err(HandshakeError::Failure(error)) => return Err(failed(&error)),
            Err(HandshakeError::Interrupted(mid)) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("délai de connexion dépassé".into());
                }
                let writing = mid.get_ref().get_ref().full();
                stop::poll(
                    &[(fd, writing), (stop.fd(), false)],
                    remaining.as_millis().max(1) as i32,
                );
                if stop.requested() {
                    return Err("arrêt demandé".into());
                }
                upgrade = mid.handshake();
            }
        }
    };
    let mut wire = Wire::new(ws).ok_or("socket")?;

    let mut noise =
        initiator(&identity.private, &endpoint.key, RELAY_PROLOGUE).map_err(|e| failed(&e))?;
    let hello = serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }).to_string();
    let mut message = vec![0u8; NOISE_MESSAGE_LIMIT];
    let length = noise
        .write_message(hello.as_bytes(), &mut message)
        .map_err(|e| failed(&e))?;
    message.truncate(length);
    if !wire.send_binary(message) {
        return Err("envoi impossible".into());
    }
    let mut messages = first_binaries(&mut wire, stop, deadline).ok_or("pas de réponse")?;
    let early = messages.split_off(1);
    let reply = messages.remove(0);
    let mut payload = vec![0u8; reply.len()];
    let length = noise
        .read_message(&reply, &mut payload)
        .map_err(|_| "clé du relais refusée".to_owned())?;
    let accepted = serde_json::from_slice::<serde_json::Value>(&payload[..length])
        .is_ok_and(|reply| reply["ok"] == true);
    if !accepted {
        return Err("refusé par le relais".into());
    }
    let mut transport = noise.into_transport_mode().map_err(|e| failed(&e))?;
    // The relay takes the link only once this shows that message 1 was not replayed.
    let ready = seal(&mut transport, LINK_READY).map_err(|e| failed(&e))?;
    if !wire.send_binary(ready) {
        return Err("envoi impossible".into());
    }
    Ok((wire, transport, early))
}

/// The first binary messages to arrive, at least one, before `deadline` and `stop`.
fn first_binaries(wire: &mut Wire, stop: &Stop, deadline: Instant) -> Option<Vec<Vec<u8>>> {
    loop {
        let (messages, alive) = wire.receive_binary();
        if !messages.is_empty() {
            return Some(messages);
        }
        if !alive || stop.requested() || Instant::now() >= deadline {
            return None;
        }
        wire.wait(&[stop.fd()], Some(deadline));
    }
}

/// One link, until it breaks or `stop`; every channel ends with it. `early` are the relay's
/// messages already received.
pub fn serve(
    mut wire: Wire,
    mut transport: TransportState,
    early: Vec<Vec<u8>>,
    context: &Context,
    stop: &Stop,
) {
    let Ok(outbox) = Mailbox::<Frame>::new() else {
        wire.close();
        return;
    };
    thread::scope(|scope| {
        let mut channels: HashMap<u32, (Arc<Handle>, bool, thread::ScopedJoinHandle<()>)> =
            HashMap::new();
        let outbox = &outbox;
        // Frames taken from the outbox, sent only while the socket keeps up.
        let mut backlog = VecDeque::new();
        let mut early = Some(early);
        'link: loop {
            if stop.requested() {
                break;
            }
            let (mut messages, alive) = wire.receive_binary();
            if let Some(mut early) = early.take() {
                early.append(&mut messages);
                messages = early;
            }
            for message in messages {
                let frame = open(&mut transport, &message)
                    .ok()
                    .and_then(|plain| Frame::decode(&plain));
                match frame {
                    Some(Frame::Open(channel)) => {
                        if channels.contains_key(&channel) {
                            continue;
                        }
                        let handle = (channels.len() < MAX_CHANNELS)
                            .then(Handle::new)
                            .and_then(Result::ok)
                            .map(Arc::new);
                        let Some(handle) = handle else {
                            if !send(&mut wire, &mut transport, &Frame::Close(channel)) {
                                break 'link;
                            }
                            continue;
                        };
                        let served = handle.clone();
                        let thread = scope
                            .spawn(move || channel::serve(channel, &served, outbox, context, stop));
                        channels.insert(channel, (handle, false, thread));
                    }
                    Some(Frame::Data(channel, data)) => {
                        if let Some((handle, _, _)) = channels.get(&channel) {
                            deliver(handle, data);
                        }
                    }
                    Some(Frame::Close(channel)) => {
                        if let Some((handle, closed_by_relay, _)) = channels.get_mut(&channel) {
                            *closed_by_relay = true;
                            handle.inbox.close();
                        }
                    }
                    None => break 'link,
                }
            }
            if !alive {
                break;
            }
            if backlog.is_empty() && wire.flushed() {
                backlog.extend(outbox.take().0);
            }
            let sent = forward(
                &mut wire,
                &mut transport,
                &mut backlog,
                |frame| match frame {
                    Frame::Data(channel, data) => {
                        if let Some((handle, _, _)) = channels.get(channel) {
                            handle.pending.fetch_sub(data.len(), Ordering::AcqRel);
                        }
                        true
                    }
                    Frame::Close(channel) => {
                        let Some((_, closed_by_relay, thread)) = channels.remove(channel) else {
                            return false;
                        };
                        let _ = thread.join();
                        !closed_by_relay
                    }
                    Frame::Open(_) => false,
                },
            );
            if !sent {
                break;
            }
            let idle = backlog.is_empty() && wire.flushed();
            let fds = [stop.fd(), outbox.fd()];
            wire.wait(if idle { &fds } else { &fds[..1] }, None);
        }
        for (handle, _, _) in channels.values() {
            handle.inbox.close();
        }
        let ending: Vec<u32> = channels
            .iter()
            .filter(|(_, (_, closed_by_relay, _))| !closed_by_relay)
            .map(|(channel, _)| *channel)
            .collect();
        for (_, _, thread) in channels.into_values() {
            let _ = thread.join();
        }
        // Best effort: the relay closes the phones of a link that goes anyway.
        for channel in ending {
            if !send(&mut wire, &mut transport, &Frame::Close(channel)) {
                break;
            }
        }
    });
    wire.close();
}

/// Queues `data` for its channel; every message weighs at least `channel::MESSAGE_COST`, so that
/// empty ones fill the inbox too.
fn deliver(handle: &Handle, data: Vec<u8>) {
    let size = data.len().max(channel::MESSAGE_COST);
    if !handle.inbox.push_within(data, size, channel::INBOX_LIMIT) {
        handle.inbox.close();
    }
}

/// Sends `backlog` from its front, the frames `admit` keeps, while the socket takes everything;
/// `false` once the link is broken.
fn forward(
    wire: &mut Wire,
    transport: &mut TransportState,
    backlog: &mut VecDeque<Frame>,
    mut admit: impl FnMut(&Frame) -> bool,
) -> bool {
    while wire.flushed() {
        let Some(frame) = backlog.pop_front() else {
            break;
        };
        if admit(&frame) && !send(wire, transport, &frame) {
            return false;
        }
    }
    true
}

fn send(wire: &mut Wire, transport: &mut TransportState, frame: &Frame) -> bool {
    seal(transport, &frame.encode()).is_ok_and(|sealed| wire.send_binary(sealed))
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;
