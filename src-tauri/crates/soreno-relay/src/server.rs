use crate::{
    mailbox::Pop,
    net::Stream,
    relay::{Link, Relay},
    stop::Stop,
    wire::{Wire, SEND_MESSAGES},
};
use soreno_mobile_protocol::{
    encode_key, open, responder, seal, Frame, TransportState, LINK_READY, NOISE_MESSAGE_LIMIT,
    RELAY_PROLOGUE,
};
use std::{
    collections::VecDeque,
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// A server's link, until it leaves, falls silent or is replaced by a newer one.
pub fn serve(stream: Stream, rest: Vec<u8>, relay: &Relay, address: IpAddr, stop: &Stop) {
    let Some(mut wire) = Wire::accept(stream, rest, NOISE_MESSAGE_LIMIT) else {
        return;
    };
    let Some(Linked {
        mut transport,
        server,
        version,
        backlog,
    }) = handshake(&mut wire, relay, stop)
    else {
        eprintln!("soreno-relay : lien serveur refusé ({address})");
        wire.close();
        return;
    };
    let Ok(link) = Link::new(server, relay.queued.clone()).map(Arc::new) else {
        wire.close();
        return;
    };
    let name = short(&link.server);
    relay.connect(link.clone());
    eprintln!("soreno-relay : serveur {name} connecté (soreno-remote {version})");
    let mut messages = Vec::from(backlog);
    let mut fault = None;
    'link: loop {
        for message in messages.drain(..) {
            if !receive(&link, &mut transport, &message) {
                break 'link;
            }
        }
        if fault.is_some() || stop.requested() {
            break;
        }
        if link.ended.requested() {
            eprintln!("soreno-relay : serveur {name} remplacé par un nouveau lien");
            wire.close();
            return;
        }
        // A slow server leaves the phones' messages queued, which ends their channels once full.
        let (mut sent, mut idle) = (0, false);
        while sent < SEND_MESSAGES && wire.flushed() {
            let item = match link.outbox.pop() {
                Pop::Item(item) => item,
                Pop::Empty => {
                    idle = true;
                    break;
                }
                // `ended` is requested first.
                Pop::Closed => continue 'link,
            };
            item.sent();
            let Ok(message) = seal(&mut transport, &item.frame.encode()) else {
                break 'link;
            };
            if !wire.send(message) {
                break 'link;
            }
            sent += 1;
        }
        if sent < SEND_MESSAGES {
            let fds = [stop.fd(), link.ended.fd(), link.outbox.fd()];
            wire.wait(if idle { &fds } else { &fds[..2] }, None);
        }
        (messages, fault) = wire.receive();
    }
    relay.disconnect(&link);
    eprintln!("soreno-relay : serveur {name} déconnecté");
    wire.close();
}

/// `false` when the server sent something it should not have.
fn receive(link: &Link, transport: &mut TransportState, message: &[u8]) -> bool {
    let frame = open(transport, message)
        .ok()
        .and_then(|plain| Frame::decode(&plain));
    match frame {
        Some(Frame::Data(channel, data)) => link.deliver(channel, data),
        Some(Frame::Close(channel)) => link.closed(channel),
        Some(Frame::Open(_)) | None => return false,
    }
    true
}

struct Linked {
    transport: TransportState,
    server: String,
    version: String,
    /// What the server sent right after its readiness.
    backlog: VecDeque<Vec<u8>>,
}

/// Only a server holding its static key gets past its first message, which anyone can replay.
fn handshake(wire: &mut Wire, relay: &Relay, stop: &Stop) -> Option<Linked> {
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let mut backlog = VecDeque::new();
    let first = next(wire, stop, deadline, &mut backlog)?;
    let mut noise = responder(&relay.private, RELAY_PROLOGUE).ok()?;
    let mut buffer = vec![0u8; NOISE_MESSAGE_LIMIT];
    let length = noise.read_message(&first, &mut buffer).ok()?;
    let hello: serde_json::Value = serde_json::from_slice(&buffer[..length]).ok()?;
    let version = hello.get("version")?.as_str()?;
    if version.is_empty() || version.len() > 64 || !version.chars().all(|c| c.is_ascii_graphic()) {
        return None;
    }
    let server = encode_key(noise.get_remote_static()?.try_into().ok()?);
    let version = version.to_owned();
    let length = noise.write_message(br#"{"ok":true}"#, &mut buffer).ok()?;
    if !wire.send(buffer[..length].to_vec()) {
        return None;
    }
    let mut transport = noise.into_transport_mode().ok()?;
    let ready = next(wire, stop, deadline, &mut backlog)?;
    if open(&mut transport, &ready).ok()? != LINK_READY {
        return None;
    }
    Some(Linked {
        transport,
        server,
        version,
        backlog,
    })
}

/// The next message received before `deadline`, `backlog` keeping those that came with it.
fn next(
    wire: &mut Wire,
    stop: &Stop,
    deadline: Instant,
    backlog: &mut VecDeque<Vec<u8>>,
) -> Option<Vec<u8>> {
    loop {
        if let Some(message) = backlog.pop_front() {
            return Some(message);
        }
        let (messages, fault) = wire.receive();
        if fault.is_some() || stop.requested() {
            return None;
        }
        backlog.extend(messages);
        if backlog.is_empty() {
            if Instant::now() >= deadline {
                return None;
            }
            wire.wait(&[stop.fd()], Some(deadline));
        }
    }
}

/// Enough of an id to tell servers apart in the journal.
fn short(server: &str) -> String {
    format!("{}…", &server[..8])
}
