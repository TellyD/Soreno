use crate::stop;
use std::{
    io::{self, Read, Write},
    net::TcpStream,
    os::fd::{AsRawFd, RawFd},
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket};

pub const PING_INTERVAL: Duration = Duration::from_secs(15);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
/// What one `receive` takes at most, so that a flooding peer cannot hold its caller.
const RECEIVE_MESSAGES: usize = 256;
/// Read from the socket, below the parser: endless empty fragments never complete a message.
const RECEIVE_BYTES: usize = 4 << 20;

/// The socket, which seems dry once `left` bytes were read from it; unbounded until a `Wire`
/// takes it, the WebSocket upgrade bounding its own reads.
pub struct Budgeted {
    stream: TcpStream,
    left: usize,
    /// The last write found the socket full.
    full: bool,
}

impl Budgeted {
    pub fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            left: usize::MAX,
            full: false,
        }
    }

    pub fn stream(&self) -> &TcpStream {
        &self.stream
    }

    pub fn full(&self) -> bool {
        self.full
    }
}

impl Read for Budgeted {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.left == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let limit = buffer.len().min(self.left);
        let read = self.stream.read(&mut buffer[..limit])?;
        self.left -= read;
        Ok(read)
    }
}

impl Write for Budgeted {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let result = self.stream.write(buffer);
        self.full = matches!(&result, Err(error) if error.kind() == io::ErrorKind::WouldBlock);
        result
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

/// A non-blocking WebSocket carrying text or binary messages, pinged and dropped when silent.
pub struct Wire {
    ws: WebSocket<Budgeted>,
    last_received: Instant,
    next_ping: Instant,
    /// The last write or flush left bytes behind.
    unsent: bool,
    /// The last `receive` stopped at its bound with messages possibly left in the socket.
    unread: bool,
    /// A write or flush failed for good: the peer is gone.
    broken: bool,
}

impl Wire {
    pub fn new(ws: WebSocket<Budgeted>) -> Option<Self> {
        let stream = ws.get_ref().stream();
        stream.set_nonblocking(true).ok()?;
        let _ = stream.set_nodelay(true);
        let now = Instant::now();
        Some(Self {
            ws,
            last_received: now,
            next_ping: now + PING_INTERVAL,
            unsent: false,
            unread: false,
            broken: false,
        })
    }

    /// The texts received so far, within a bound, and `false` once the peer is gone or silent for
    /// too long.
    pub fn receive(&mut self) -> (Vec<String>, bool) {
        self.receive_with(|message| match message {
            Message::Text(text) => Some(text.as_str().to_owned()),
            _ => None,
        })
    }

    /// Like `receive`, for binary messages.
    pub fn receive_binary(&mut self) -> (Vec<Vec<u8>>, bool) {
        self.receive_with(|message| match message {
            Message::Binary(bytes) => Some(bytes.to_vec()),
            _ => None,
        })
    }

    fn receive_with<T>(&mut self, keep: impl Fn(Message) -> Option<T>) -> (Vec<T>, bool) {
        let mut kept = Vec::new();
        let (mut messages, mut bytes) = (0, 0);
        self.ws.get_mut().left = RECEIVE_BYTES;
        self.unread = false;
        while !self.unread {
            match self.ws.read() {
                Ok(message) => {
                    self.last_received = Instant::now();
                    messages += 1;
                    bytes += message.len();
                    self.unread = messages >= RECEIVE_MESSAGES || bytes >= RECEIVE_BYTES;
                    kept.extend(keep(message));
                }
                Err(tungstenite::Error::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.unread = self.ws.get_ref().left == 0;
                    break;
                }
                Err(_) => return (kept, false),
            }
        }
        let now = Instant::now();
        if now.duration_since(self.last_received) >= IDLE_TIMEOUT {
            return (kept, false);
        }
        if now >= self.next_ping {
            self.next_ping = now + PING_INTERVAL;
            if !self.write(Message::Ping(Default::default())) {
                return (kept, false);
            }
        }
        (kept, true)
    }

    /// `false` when the peer is gone.
    pub fn send(&mut self, text: String) -> bool {
        self.write(Message::text(text))
    }

    pub fn send_binary(&mut self, bytes: Vec<u8>) -> bool {
        self.write(Message::binary(bytes))
    }

    /// `true` once everything sent so far went out to the socket.
    pub fn flushed(&mut self) -> bool {
        let result = self.ws.flush();
        self.note(&result);
        !self.unsent
    }

    /// Whether a write or flush failed otherwise than by a full socket.
    pub fn broken(&self) -> bool {
        self.broken
    }

    fn write(&mut self, message: Message) -> bool {
        let result = self.ws.send(message);
        self.note(&result);
        !self.broken
    }

    fn note(&mut self, result: &tungstenite::Result<()>) {
        self.unsent = result.is_err();
        self.broken |= fatal(result);
    }

    /// Until the socket or one of `fds` is ready, the next ping, or `deadline`; at once when the
    /// send buffer empties, since a caller that saw it full may be watching less, or once after a
    /// `receive` that left messages behind, which may wait in a buffer the socket does not show.
    pub fn wait(&mut self, fds: &[RawFd], deadline: Option<Instant>) {
        let unsent = self.unsent;
        let unread = std::mem::take(&mut self.unread);
        if (self.flushed() && unsent) || unread {
            return;
        }
        let next = [
            Some(self.next_ping),
            Some(self.last_received + IDLE_TIMEOUT),
            deadline,
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(self.next_ping);
        let timeout = next
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(i32::MAX as u128) as i32;
        let mut watched = vec![(self.ws.get_ref().stream().as_raw_fd(), self.unsent)];
        watched.extend(fds.iter().map(|&fd| (fd, false)));
        stop::poll(&watched, timeout);
    }

    /// Best effort: the peer treats a cut connection like a close.
    pub fn close(mut self) {
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
    }

    /// Sends what is still queued, then drives the close handshake until `deadline`.
    pub fn finish(mut self, deadline: Instant) {
        let _ = self.ws.close(None);
        loop {
            self.ws.get_mut().left = RECEIVE_BYTES;
            let progressed = match self.ws.read().map(drop).and_then(|()| self.ws.flush()) {
                Ok(()) => true,
                Err(tungstenite::Error::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                    false
                }
                Err(_) => return,
            };
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            if progressed {
                continue;
            }
            let writing = !matches!(self.ws.flush(), Ok(()));
            let left = deadline.duration_since(now).as_millis().max(1) as i32;
            stop::poll(&[(self.ws.get_ref().stream().as_raw_fd(), writing)], left);
        }
    }
}

/// Whether a write or flush failed otherwise than by a full socket or a signal.
fn fatal(result: &tungstenite::Result<()>) -> bool {
    match result {
        Ok(()) => false,
        Err(tungstenite::Error::Io(error)) => !matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ),
        Err(_) => true,
    }
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
