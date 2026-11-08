use crate::{relay::Endpoint, service, stop::Stop};
use soreno_mobile_protocol::{
    chunks, decode_key, encode_key, generate_keypair, initiator, open, responder, seal, Frame,
    HandshakeState, Key, Keypair, Reassembly, TransportState, LINK_READY, NOISE_MESSAGE_LIMIT,
    PHONE_PROLOGUE, RELAY_PROLOGUE,
};
use std::{
    collections::VecDeque,
    fs,
    net::{TcpListener, TcpStream},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        // Kept short: Unix socket paths are limited to about 100 bytes.
        let path = std::env::temp_dir().join(format!(
            "sr-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn shrink_buffer(stream: &TcpStream, option: libc::c_int) {
    let size: libc::c_int = 64 << 10;
    let result = unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            option,
            (&size as *const libc::c_int).cast(),
            size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    assert_eq!(result, 0);
}

const WAIT: Duration = Duration::from_secs(10);

/// A relay in the test process: takes server links, speaks for the phones.
pub struct FakeRelay {
    listener: TcpListener,
    keypair: Keypair,
}

impl FakeRelay {
    pub fn new() -> Self {
        Self {
            listener: TcpListener::bind("127.0.0.1:0").unwrap(),
            keypair: generate_keypair().unwrap(),
        }
    }

    pub fn endpoint(&self) -> Endpoint {
        let url = format!("ws://{}", self.listener.local_addr().unwrap());
        Endpoint::parse(&url, &encode_key(&self.keypair.public)).unwrap()
    }

    /// The next server link, once its Noise handshake is done and the server confirmed it.
    pub fn accept(&self) -> Link {
        self.accept_sending(|_| Vec::new())
    }

    /// Like `accept`, with the frames `early` makes for the server sent along with the answer to
    /// its message 1, in the same write.
    pub fn accept_sending(&self, early: impl FnOnce(&Key) -> Vec<Frame>) -> Link {
        self.listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + WAIT;
        let stream = loop {
            match self.listener.accept() {
                Ok((stream, _)) => break stream,
                Err(_) => {
                    assert!(Instant::now() < deadline, "aucun lien du serveur");
                    thread::sleep(Duration::from_millis(10));
                }
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        let first = loop {
            if let Message::Binary(bytes) = ws.read().unwrap() {
                break bytes.to_vec();
            }
        };
        let mut noise = responder(&self.keypair.private, RELAY_PROLOGUE).unwrap();
        let mut payload = vec![0u8; first.len()];
        let length = noise.read_message(&first, &mut payload).unwrap();
        let hello: serde_json::Value = serde_json::from_slice(&payload[..length]).unwrap();
        assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
        let server: Key = noise.get_remote_static().unwrap().try_into().unwrap();
        let mut reply = vec![0u8; NOISE_MESSAGE_LIMIT];
        let length = noise.write_message(br#"{"ok":true}"#, &mut reply).unwrap();
        reply.truncate(length);
        ws.write(Message::binary(reply)).unwrap();
        let mut transport = noise.into_transport_mode().unwrap();
        for frame in early(&server) {
            let sealed = seal(&mut transport, &frame.encode()).unwrap();
            ws.write(Message::binary(sealed)).unwrap();
        }
        ws.flush().unwrap();
        let ready = loop {
            if let Message::Binary(bytes) = ws.read().unwrap() {
                break bytes.to_vec();
            }
        };
        assert_eq!(open(&mut transport, &ready).unwrap(), LINK_READY);
        Link {
            ws,
            transport,
            server,
            waiting: VecDeque::new(),
        }
    }
}

/// The relay's side of one server link.
pub struct Link {
    ws: WebSocket<TcpStream>,
    transport: TransportState,
    pub server: Key,
    /// Frames read while looking for another channel's.
    waiting: VecDeque<Frame>,
}

impl Link {
    pub fn send(&mut self, frame: &Frame) {
        let sealed = seal(&mut self.transport, &frame.encode()).unwrap();
        self.ws.send(Message::binary(sealed)).unwrap();
    }

    fn read(&mut self, deadline: Instant) -> Option<Frame> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            self.ws.get_ref().set_read_timeout(Some(left)).unwrap();
            match self.ws.read() {
                Ok(Message::Binary(bytes)) => {
                    let plain = open(&mut self.transport, &bytes).unwrap();
                    return Some(Frame::decode(&plain).unwrap());
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return None
                }
                Err(error) => panic!("lien coupé : {error}"),
            }
        }
    }

    /// The next frame of `channel` before `deadline`.
    pub fn frame_until(&mut self, channel: u32, deadline: Instant) -> Option<Frame> {
        let ours = |frame: &Frame| match frame {
            Frame::Open(other) | Frame::Close(other) | Frame::Data(other, _) => *other == channel,
        };
        if let Some(index) = self.waiting.iter().position(ours) {
            return self.waiting.remove(index);
        }
        loop {
            let frame = self.read(deadline)?;
            if ours(&frame) {
                return Some(frame);
            }
            self.waiting.push_back(frame);
        }
    }

    pub fn frame(&mut self, channel: u32) -> Frame {
        self.frame_until(channel, Instant::now() + WAIT)
            .expect("aucune trame du serveur")
    }

    /// Whether the link went down, without waiting for long.
    pub fn closed(&mut self) -> bool {
        self.ws
            .get_ref()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        loop {
            match self.ws.read() {
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return false
                }
                Err(_) => return true,
            }
        }
    }
}

/// A phone with its own key for this server.
pub struct Phone {
    keypair: Keypair,
}

impl Phone {
    pub fn new() -> Self {
        Self {
            keypair: generate_keypair().unwrap(),
        }
    }

    pub fn id(&self) -> String {
        soreno_mobile_protocol::device_id(&self.keypair.public)
    }

    /// Opens `channel` with `hello`: message 2's payload, and the channel when it says ok.
    pub fn open(
        &self,
        link: &mut Link,
        channel: u32,
        server: &Key,
        hello: serde_json::Value,
    ) -> (serde_json::Value, Option<PhoneChannel>) {
        let (frames, noise) = self.start(channel, server, hello);
        for frame in &frames {
            link.send(frame);
        }
        self.finish(link, channel, noise)
    }

    /// The frames that open `channel` with `hello`, and the handshake that `finish` completes.
    pub fn start(
        &self,
        channel: u32,
        server: &Key,
        hello: serde_json::Value,
    ) -> ([Frame; 2], HandshakeState) {
        let mut noise = initiator(&self.keypair.private, server, PHONE_PROLOGUE).unwrap();
        let mut message = vec![0u8; NOISE_MESSAGE_LIMIT];
        let length = noise
            .write_message(hello.to_string().as_bytes(), &mut message)
            .unwrap();
        message.truncate(length);
        ([Frame::Open(channel), Frame::Data(channel, message)], noise)
    }

    /// Message 2's payload, and the channel when it says ok.
    pub fn finish(
        &self,
        link: &mut Link,
        channel: u32,
        mut noise: HandshakeState,
    ) -> (serde_json::Value, Option<PhoneChannel>) {
        let Frame::Data(_, reply) = link.frame(channel) else {
            panic!("message 2 attendu");
        };
        let mut payload = vec![0u8; reply.len()];
        let length = noise.read_message(&reply, &mut payload).unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&payload[..length]).unwrap();
        if reply["ok"] != true {
            assert_eq!(link.frame(channel), Frame::Close(channel));
            return (reply, None);
        }
        let opened = PhoneChannel {
            channel,
            transport: noise.into_transport_mode().unwrap(),
            reassembly: Reassembly::default(),
        };
        (reply, Some(opened))
    }
}

/// One end-to-end channel, on the phone.
pub struct PhoneChannel {
    pub channel: u32,
    transport: TransportState,
    reassembly: Reassembly,
}

impl PhoneChannel {
    pub fn send(&mut self, link: &mut Link, message: &serde_json::Value) {
        for chunk in chunks(message.to_string().as_bytes()) {
            let sealed = seal(&mut self.transport, &chunk).unwrap();
            link.send(&Frame::Data(self.channel, sealed));
        }
    }

    /// The next message before `deadline`; `None` once closed or late.
    pub fn next_until(&mut self, link: &mut Link, deadline: Instant) -> Option<serde_json::Value> {
        loop {
            match link.frame_until(self.channel, deadline)? {
                Frame::Data(_, sealed) => {
                    let chunk = open(&mut self.transport, &sealed).unwrap();
                    if let Some(message) = self.reassembly.push(&chunk).unwrap() {
                        return Some(serde_json::from_slice(&message).unwrap());
                    }
                }
                Frame::Close(_) => return None,
                Frame::Open(_) => panic!("ouverture venue du serveur"),
            }
        }
    }

    pub fn next(&mut self, link: &mut Link) -> serde_json::Value {
        self.next_until(link, Instant::now() + WAIT)
            .expect("canal fermé")
    }

    /// Whether the server closes the channel before `deadline`, whatever it sends meanwhile.
    pub fn closed_until(&mut self, link: &mut Link, deadline: Instant) -> bool {
        loop {
            match link.frame_until(self.channel, deadline) {
                Some(Frame::Close(_)) => return true,
                Some(_) => {}
                None => return false,
            }
        }
    }
}

/// The service, linked to a fake relay, as the deployed one is to Soreno's.
pub struct Running {
    pub relay: FakeRelay,
    pub stop: Arc<Stop>,
    serving: Option<JoinHandle<()>>,
}

impl Running {
    pub fn start(home: &Path) -> (Self, Link) {
        Self::start_with(home, |relay| relay.accept())
    }

    /// Like `start`, with `accept` taking the first link.
    pub fn start_with(home: &Path, accept: impl FnOnce(&FakeRelay) -> Link) -> (Self, Link) {
        let relay = FakeRelay::new();
        let config = service::Config {
            home: home.to_owned(),
            host: "vps".into(),
            relay: relay.endpoint(),
        };
        let stop = Arc::new(Stop::new().unwrap());
        let running = stop.clone();
        let serving = thread::spawn(move || service::run(config, running).unwrap());
        let link = accept(&relay);
        let running = Self {
            relay,
            stop,
            serving: Some(serving),
        };
        (running, link)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.request();
        if let Some(serving) = self.serving.take() {
            let _ = serving.join();
        }
    }
}

pub fn hello(open: serde_json::Value, pair: Option<&str>) -> serde_json::Value {
    let mut hello = serde_json::json!({ "v": 1, "label": "iPhone · Safari", "open": open });
    if let Some(secret) = pair {
        hello["pair"] = secret.into();
    }
    hello
}

pub fn server_key(home: &Path) -> Key {
    let identity: serde_json::Value = serde_json::from_slice(
        &fs::read(crate::files::remote_dir(home).join("identity.json")).unwrap(),
    )
    .unwrap();
    decode_key(identity["public"].as_str().unwrap()).unwrap()
}
