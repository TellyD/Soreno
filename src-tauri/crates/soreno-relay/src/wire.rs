use crate::{net::Stream, stop};
use std::{
    io::{self, Read, Write},
    net::Shutdown,
    os::fd::{AsRawFd, RawFd},
    time::{Duration, Instant},
};
use tungstenite::{
    protocol::{frame::coding::CloseCode, CloseFrame, Role, WebSocketConfig},
    Message, WebSocket,
};

pub const PING_INTERVAL: Duration = Duration::from_secs(30);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
/// What one `receive` takes at most, so that a flooding peer cannot hold its caller.
const RECEIVE_MESSAGES: usize = 256;
/// Read from the socket, below the parser: endless empty fragments never complete a message.
const RECEIVE_BYTES: usize = 1 << 20;
/// What callers send at most between two `receive`, each message once `flushed`.
pub const SEND_MESSAGES: usize = 256;
const WRITE_BUFFER: usize = 128 << 10;
/// Above one message and the replies to a peer that pings without reading, which then fail.
const MAX_WRITE_BUFFER: usize = 1 << 20;

#[derive(Debug, PartialEq, Eq)]
pub enum Fault {
    /// Closed, cut or silent for too long.
    Gone,
    /// A text message or one over the size limit.
    Invalid,
}

/// The socket, which seems dry once `left` bytes were read from it.
struct Budgeted {
    stream: Stream,
    left: usize,
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
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

/// A non-blocking WebSocket carrying binary messages, pinged and dropped when silent.
pub struct Wire {
    ws: WebSocket<Budgeted>,
    last_received: Instant,
    next_ping: Instant,
    /// The last write or flush left bytes behind.
    unsent: bool,
    /// The last `receive` stopped at its bound with messages possibly left in the socket.
    unread: bool,
}

impl Wire {
    /// Over the upgraded `stream`, `rest` being what was read past the request.
    pub fn accept(stream: Stream, rest: Vec<u8>, message_limit: usize) -> Option<Self> {
        let config = WebSocketConfig::default()
            .max_message_size(Some(message_limit))
            .max_frame_size(Some(message_limit))
            .write_buffer_size(WRITE_BUFFER)
            .max_write_buffer_size(MAX_WRITE_BUFFER);
        let stream = Budgeted { stream, left: 0 };
        let ws = WebSocket::from_partially_read(stream, rest, Role::Server, Some(config));
        let stream = &ws.get_ref().stream;
        stream.set_nonblocking(true).ok()?;
        let _ = stream.set_nodelay(true);
        let now = Instant::now();
        Some(Self {
            ws,
            last_received: now,
            next_ping: now + PING_INTERVAL,
            unsent: false,
            unread: false,
        })
    }

    /// The binary messages received so far, within a bound, and why the peer cannot go on.
    pub fn receive(&mut self) -> (Vec<Vec<u8>>, Option<Fault>) {
        let mut messages = Vec::new();
        let mut count = 0;
        self.ws.get_mut().left = RECEIVE_BYTES;
        self.unread = false;
        while !self.unread {
            match self.ws.read() {
                Ok(message) => {
                    self.last_received = Instant::now();
                    count += 1;
                    self.unread = count >= RECEIVE_MESSAGES;
                    match message {
                        Message::Binary(data) => messages.push(data.to_vec()),
                        Message::Text(_) => return (messages, Some(Fault::Invalid)),
                        _ => {}
                    }
                }
                Err(tungstenite::Error::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.unread = self.ws.get_ref().left == 0;
                    break;
                }
                Err(tungstenite::Error::Capacity(_)) => return (messages, Some(Fault::Invalid)),
                Err(_) => return (messages, Some(Fault::Gone)),
            }
        }
        let now = Instant::now();
        if now.duration_since(self.last_received) >= IDLE_TIMEOUT {
            return (messages, Some(Fault::Gone));
        }
        if now >= self.next_ping {
            self.next_ping = now + PING_INTERVAL;
            if !self.write(Message::Ping(Default::default())) {
                return (messages, Some(Fault::Gone));
            }
        }
        (messages, None)
    }

    /// `false` when the peer is gone or reads too little of what it is sent.
    pub fn send(&mut self, data: Vec<u8>) -> bool {
        self.write(Message::binary(data))
    }

    /// `true` once everything sent so far went out to the socket.
    pub fn flushed(&mut self) -> bool {
        self.unsent = !matches!(self.ws.flush(), Ok(()));
        !self.unsent
    }

    fn write(&mut self, message: Message) -> bool {
        let result = self.ws.send(message);
        self.unsent = result.is_err();
        match result {
            Ok(()) => true,
            Err(tungstenite::Error::Io(error)) => error.kind() == io::ErrorKind::WouldBlock,
            Err(_) => false,
        }
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
        let mut watched = vec![(self.ws.get_ref().stream.as_raw_fd(), self.unsent)];
        watched.extend(fds.iter().map(|&fd| (fd, false)));
        stop::poll(&watched, timeout);
    }

    /// Best effort, for a peer already gone or that treats a cut connection like a close.
    pub fn close(mut self) {
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
    }

    /// Sends what is still queued and a close frame with `code`, then waits a while for the peer
    /// to close, never parsing frames again: endless empty fragments would hold the parser.
    pub fn finish(mut self, code: u16) {
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        let frame = CloseFrame {
            code: CloseCode::from(code),
            reason: "".into(),
        };
        let _ = self.ws.close(Some(frame));
        loop {
            match self.ws.flush() {
                Ok(()) => break,
                Err(tungstenite::Error::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                }
                Err(_) => return,
            }
            if !discard(&mut self.ws.get_mut().stream, deadline) {
                return;
            }
            wait_until(&self.ws.get_ref().stream, deadline, true);
        }
        // Closing over unread bytes would reset the connection before the peer reads the frame.
        let stream = &mut self.ws.get_mut().stream;
        let _ = stream.shutdown(Shutdown::Write);
        while discard(stream, deadline) {
            wait_until(stream, deadline, false);
        }
    }
}

/// Reads and drops what `stream` holds; `false` once the peer is done or gone, or past `deadline`.
fn discard(stream: &mut Stream, deadline: Instant) -> bool {
    let mut drain = [0u8; 4096];
    while Instant::now() < deadline {
        match stream.read(&mut drain) {
            Ok(0) => return false,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return true,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
    false
}

/// Until `stream` is readable, or writable when `writing`, or `deadline`.
fn wait_until(stream: &Stream, deadline: Instant, writing: bool) {
    let left = deadline
        .saturating_duration_since(Instant::now())
        .as_millis()
        .clamp(1, i32::MAX as u128) as i32;
    stop::poll(&[(stream.as_raw_fd(), writing)], left);
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
