//! One phone on the relay: the end-to-end Noise handshake, the phone's admission, then its
//! session list or one conversation.
use crate::{
    access::{self, Watch},
    bridge,
    mailbox::Mailbox,
    sessions::{self, Session},
    stop::{self, Stop},
    wire::Wire,
};
use serde::Deserialize;
use soreno_mobile_protocol::{
    chunks, open, responder, seal, Frame, Key, Reassembly, TransportState, MESSAGE_LIMIT,
    NOISE_MESSAGE_LIMIT, PHONE_PROLOGUE,
};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use tungstenite::protocol::WebSocketConfig;

const HELLO_TIMEOUT: Duration = Duration::from_secs(15);
/// Sealed bytes of one channel waiting for the relay link; past it the channel stops reading
/// what it forwards until they went out.
pub const SEND_LIMIT: usize = 1 << 20;
/// Phone messages not yet forwarded; past it the channel closes.
pub const INBOX_LIMIT: usize = 16 << 20;
/// What an inbox counts for a phone message at least, its bookkeeping included.
pub const MESSAGE_COST: usize = 64;
/// Keeps a revoked device's channels open well under a second.
const CHECK_INTERVAL: Duration = Duration::from_millis(250);
const LIST_INTERVAL: Duration = Duration::from_secs(1);
const LIST_REFRESH: Duration = Duration::from_secs(15);
const BLOCKED_POLL: i32 = 20;
/// What a channel closed by the phone leaves the bridge to take its last texts.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// What the server needs to answer phones.
pub struct Context {
    /// `~/.cache/soreno/remote`.
    pub directory: PathBuf,
    pub sessions: [PathBuf; 2],
    pub host: String,
    pub private: Key,
    pub bridge: SocketAddr,
    pub token: String,
}

/// The relay link's side of a channel.
pub struct Handle {
    /// Phone Noise messages; closed when the phone or the link goes.
    pub inbox: Mailbox<Vec<u8>>,
    /// Bytes this channel queued on the link and the link did not send yet.
    pub pending: AtomicUsize,
}

impl Handle {
    pub fn new() -> std::io::Result<Self> {
        Ok(Self {
            inbox: Mailbox::new()?,
            pending: AtomicUsize::new(0),
        })
    }
}

#[derive(Deserialize)]
struct Hello {
    v: u32,
    #[serde(default)]
    label: String,
    pair: Option<String>,
    open: Open,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Open {
    Sessions,
    Conversation { key: String },
}

/// Until the phone, the link or `stop` ends it; the link learns the end from `Close`.
pub fn serve(
    channel: u32,
    handle: &Handle,
    outbox: &Mailbox<Frame>,
    context: &Context,
    stop: &Stop,
) {
    run(channel, handle, outbox, context, stop);
    // What the phone still sends is never read.
    handle.inbox.close();
    outbox.push(Frame::Close(channel));
}

fn run(channel: u32, handle: &Handle, outbox: &Mailbox<Frame>, context: &Context, stop: &Stop) {
    let Some(first) = first_message(handle, stop) else {
        return;
    };
    let Ok(mut noise) = responder(&context.private, PHONE_PROLOGUE) else {
        return;
    };
    let mut payload = vec![0u8; first.len()];
    // A message 1 that does not decrypt gets no answer.
    let Ok(length) = noise.read_message(&first, &mut payload) else {
        return;
    };
    let Some(public) = noise
        .get_remote_static()
        .and_then(|key| Key::try_from(key).ok())
    else {
        return;
    };
    let admitted = admit(&payload[..length], &public, context);
    let reply = match &admitted {
        Ok(_) => serde_json::json!({
            "ok": true, "host": context.host, "version": env!("CARGO_PKG_VERSION"),
        }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    let mut message = vec![0u8; NOISE_MESSAGE_LIMIT];
    let Ok(length) = noise.write_message(reply.to_string().as_bytes(), &mut message) else {
        return;
    };
    message.truncate(length);
    handle.pending.fetch_add(length, Ordering::AcqRel);
    if !outbox.push(Frame::Data(channel, message)) {
        return;
    }
    let (Ok(opened), Ok(transport)) = (admitted, noise.into_transport_mode()) else {
        return;
    };
    let mut secure = Secure {
        channel,
        transport,
        reassembly: Reassembly::default(),
        handle,
        outbox,
    };
    let watch = Watch::new(&context.directory, &public);
    match opened {
        Opened::Sessions => list_sessions(&mut secure, watch, context, stop),
        Opened::Conversation(wire) => follow_conversation(&mut secure, *wire, watch, stop),
    }
}

fn first_message(handle: &Handle, stop: &Stop) -> Option<Vec<u8>> {
    let deadline = Instant::now() + HELLO_TIMEOUT;
    loop {
        let (mut messages, closed) = handle.inbox.take();
        if !messages.is_empty() {
            return (messages.len() == 1).then(|| messages.remove(0));
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if closed || stop.requested() || left.is_zero() {
            return None;
        }
        stop::poll(
            &[(handle.inbox.fd(), false), (stop.fd(), false)],
            left.as_millis().max(1) as i32,
        );
    }
}

enum Opened {
    Sessions,
    Conversation(Box<Wire>),
}

/// The phone's admission and what it opens, or the error message 2 carries.
fn admit(payload: &[u8], public: &Key, context: &Context) -> Result<Opened, &'static str> {
    let hello: Hello = serde_json::from_slice(payload).map_err(|_| "bad")?;
    if hello.v != 1 {
        return Err("bad");
    }
    let admitted = access::admit(
        &context.directory,
        public,
        &hello.label,
        hello.pair.as_deref(),
    );
    match admitted {
        Ok(Ok(())) => {}
        Ok(Err(refusal)) => return Err(refusal.code()),
        Err(error) => {
            eprintln!("soreno-remote : access.json : {error}");
            return Err("bad");
        }
    }
    match hello.open {
        Open::Sessions => Ok(Opened::Sessions),
        Open::Conversation { key } if sessions::valid_key(&key) => {
            let config = WebSocketConfig::default()
                .max_message_size(Some(MESSAGE_LIMIT))
                .max_write_buffer_size(2 * MESSAGE_LIMIT);
            bridge::connect(context.bridge, &context.token, &key, config)
                .map(|wire| Opened::Conversation(Box::new(wire)))
                .ok_or("gone")
        }
        Open::Conversation { .. } => Err("bad"),
    }
}

/// The channel once the handshake is done: application messages, chunked and sealed.
struct Secure<'a> {
    channel: u32,
    transport: TransportState,
    reassembly: Reassembly,
    handle: &'a Handle,
    outbox: &'a Mailbox<Frame>,
}

impl Secure<'_> {
    /// `false` when the channel must close.
    fn send(&mut self, message: &[u8]) -> bool {
        chunks(message).iter().all(|chunk| {
            let Ok(sealed) = seal(&mut self.transport, chunk) else {
                return false;
            };
            self.handle
                .pending
                .fetch_add(sealed.len(), Ordering::AcqRel);
            self.outbox.push(Frame::Data(self.channel, sealed))
        })
    }

    /// Whether more may be queued for the link.
    fn room(&self) -> bool {
        self.handle.pending.load(Ordering::Acquire) < SEND_LIMIT
    }

    /// The application messages completed by `messages`; `None` when the phone broke the
    /// protocol.
    fn receive(&mut self, messages: Vec<Vec<u8>>) -> Option<Vec<Vec<u8>>> {
        let mut complete = Vec::new();
        for message in messages {
            let chunk = open(&mut self.transport, &message).ok()?;
            complete.extend(self.reassembly.push(&chunk).ok()?);
        }
        Some(complete)
    }
}

fn list_sessions(secure: &mut Secure, mut watch: Watch, context: &Context, stop: &Stop) {
    let inbox = &secure.handle.inbox;
    let mut sent: Option<Vec<Session>> = None;
    let mut next_list = Instant::now();
    let mut next_refresh = Instant::now();
    let mut next_check = Instant::now() + CHECK_INTERVAL;
    loop {
        if stop.requested() {
            return;
        }
        let (messages, closed) = inbox.take();
        if closed || secure.receive(messages).is_none() {
            return;
        }
        let now = Instant::now();
        if now >= next_check {
            next_check = now + CHECK_INTERVAL;
            if !watch.allowed() {
                return;
            }
        }
        if now >= next_list {
            next_list = now + LIST_INTERVAL;
            let list = sessions::list(&context.sessions);
            if (sent.as_ref() != Some(&list) || now >= next_refresh) && secure.room() {
                let message = serde_json::json!({
                    "type": "sessions", "host": context.host, "sessions": list,
                });
                if !secure.send(message.to_string().as_bytes()) {
                    return;
                }
                next_refresh = now + LIST_REFRESH;
                sent = Some(list);
            }
        }
        let left = next_list
            .min(next_check)
            .saturating_duration_since(Instant::now());
        stop::poll(
            &[(inbox.fd(), false), (stop.fd(), false)],
            left.as_millis().max(1) as i32,
        );
    }
}

/// Messages go through untouched both ways; a slow phone stops the reading of the session's.
fn follow_conversation(secure: &mut Secure, mut wire: Wire, mut watch: Watch, stop: &Stop) {
    let inbox = &secure.handle.inbox;
    let mut next_check = Instant::now() + CHECK_INTERVAL;
    let mut ended = false;
    loop {
        if stop.requested() {
            break;
        }
        let flushed = wire.flushed();
        // A closing channel ends at once, even with the bridge still busy.
        if flushed || inbox.closed() {
            let (messages, closed) = inbox.take();
            let Some(complete) = secure.receive(messages) else {
                break;
            };
            let forwarded = complete
                .into_iter()
                .all(|message| String::from_utf8(message).is_ok_and(|text| wire.send(text)));
            if !forwarded || closed {
                ended = forwarded;
                break;
            }
        }
        if wire.broken() {
            break;
        }
        let room = secure.room();
        if room {
            let (texts, alive) = wire.receive();
            if !texts.iter().all(|text| secure.send(text.as_bytes())) || !alive {
                break;
            }
        }
        let now = Instant::now();
        if now >= next_check {
            next_check = now + CHECK_INTERVAL;
            if !watch.allowed() {
                break;
            }
        }
        if room {
            let fds = [stop.fd(), inbox.fd()];
            wire.wait(if flushed { &fds } else { &fds[..1] }, Some(next_check));
        } else {
            stop::poll(&[(stop.fd(), false)], BLOCKED_POLL);
        }
    }
    if ended {
        wire.finish(Instant::now() + CLOSE_TIMEOUT);
    } else {
        wire.close();
    }
}

#[cfg(test)]
#[path = "channel_tests.rs"]
mod tests;
