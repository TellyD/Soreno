use crate::{
    http::{self, Side, SERVERS_PER_ADDRESS},
    mailbox::Pop,
    net::Listener,
    relay::{
        Link, Relay, CHANNELS_PER_ADDRESS, CHANNEL_QUEUE_LIMIT, LINK_QUEUE_LIMIT, MAX_CHANNELS,
        MESSAGE_COST, OVERFLOW, RELAY_QUEUE_LIMIT, TOO_MANY,
    },
    stop::Stop,
};
use soreno_mobile_protocol::{
    encode_key, generate_keypair, initiator, open, responder, seal, Frame, Key, Keypair,
    TransportState, LINK_READY, PHONE_FRAME_LIMIT, PHONE_PROLOGUE, RELAY_PROLOGUE,
};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::fd::AsRawFd,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{client::IntoClientRequest, Message, WebSocket};

const ORIGIN: &str = "https://relais.test";
const TIMEOUT: Duration = Duration::from_secs(5);

struct TestRelay {
    relay: Arc<Relay>,
    public: Key,
    phones: SocketAddr,
    servers: SocketAddr,
    stop: Arc<Stop>,
}

impl TestRelay {
    fn start() -> Self {
        let keypair = generate_keypair().unwrap();
        let relay = Arc::new(Relay::new(keypair.private, ORIGIN.into()));
        let stop = Arc::new(Stop::new().unwrap());
        let listen = |side| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (relay, stop) = (relay.clone(), stop.clone());
            thread::spawn(move || http::run(Listener::Tcp(listener), side, relay, stop));
            address
        };
        let phones = listen(Side::Phones);
        let servers = listen(Side::Servers);
        Self {
            relay,
            public: keypair.public,
            phones,
            servers,
            stop,
        }
    }

    fn until_linked(&self, server: &Key) {
        let id = encode_key(server);
        let deadline = Instant::now() + TIMEOUT;
        while self.relay.link(&id).is_none() {
            assert!(Instant::now() < deadline, "serveur jamais relié");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for TestRelay {
    fn drop(&mut self) {
        self.stop.request();
    }
}

fn connect(
    address: SocketAddr,
    path: &str,
    headers: &[(&'static str, &str)],
) -> WebSocket<TcpStream> {
    try_connect(address, path, headers).unwrap()
}

fn try_connect(
    address: SocketAddr,
    path: &str,
    headers: &[(&'static str, &str)],
) -> Result<WebSocket<TcpStream>, u16> {
    let mut request = format!("ws://{address}{path}")
        .into_client_request()
        .unwrap();
    for &(name, value) in headers {
        request.headers_mut().insert(name, value.parse().unwrap());
    }
    let stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    match tungstenite::client(request, stream) {
        Ok((ws, _)) => Ok(ws),
        Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response))) => {
            Err(response.status().as_u16())
        }
        Err(error) => panic!("poignée de main WebSocket : {error}"),
    }
}

/// The next binary message, or `None` once closed.
fn binary(ws: &mut WebSocket<TcpStream>) -> Option<Vec<u8>> {
    loop {
        match ws.read() {
            Ok(Message::Binary(data)) => return Some(data.to_vec()),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

/// The close code the relay sent.
fn close_code<S: Read + Write>(ws: &mut WebSocket<S>) -> u16 {
    loop {
        match ws.read() {
            Ok(Message::Close(frame)) => return frame.map_or(1005, |frame| frame.code.into()),
            Ok(Message::Binary(_) | Message::Text(_)) => panic!("message inattendu"),
            Ok(_) => {}
            Err(error) => panic!("fermé sans code : {error}"),
        }
    }
}

struct FakeServer {
    ws: WebSocket<TcpStream>,
    transport: TransportState,
    keypair: Keypair,
    /// Its first handshake message, which anyone watching the link can replay.
    hello: Vec<u8>,
}

impl FakeServer {
    fn connect(relay: &TestRelay, keypair: Keypair) -> Self {
        Self::try_connect(relay, keypair, &relay.public).expect("lien refusé")
    }

    fn try_connect(relay: &TestRelay, keypair: Keypair, relay_key: &Key) -> Option<Self> {
        let mut ws = connect(relay.servers, "/relay/server", &[]);
        let mut noise = initiator(&keypair.private, relay_key, RELAY_PROLOGUE).unwrap();
        let mut buffer = vec![0u8; 65535];
        let length = noise
            .write_message(br#"{"version":"0.0.0-test"}"#, &mut buffer)
            .unwrap();
        let hello = buffer[..length].to_vec();
        ws.send(Message::binary(hello.clone())).unwrap();
        let reply = binary(&mut ws)?;
        let length = noise.read_message(&reply, &mut buffer).unwrap();
        assert_eq!(&buffer[..length], br#"{"ok":true}"#);
        let mut transport = noise.into_transport_mode().unwrap();
        let ready = seal(&mut transport, LINK_READY).unwrap();
        ws.send(Message::binary(ready)).unwrap();
        relay.until_linked(&keypair.public);
        Some(Self {
            ws,
            transport,
            keypair,
            hello,
        })
    }

    fn id(&self) -> String {
        encode_key(&self.keypair.public)
    }

    fn send(&mut self, frame: Frame) {
        let message = seal(&mut self.transport, &frame.encode()).unwrap();
        self.ws.send(Message::binary(message)).unwrap();
    }

    fn receive(&mut self) -> Frame {
        let message = binary(&mut self.ws).expect("lien fermé");
        Frame::decode(&open(&mut self.transport, &message).unwrap()).unwrap()
    }

    fn opened(&mut self) -> u32 {
        match self.receive() {
            Frame::Open(channel) => channel,
            frame => panic!("ouverture attendue : {frame:?}"),
        }
    }
}

fn phone(relay: &TestRelay, server: &str) -> WebSocket<TcpStream> {
    connect(
        relay.phones,
        &format!("/relay/phone/{server}"),
        &[("Origin", ORIGIN)],
    )
}

/// A phone behind Caddy, which names it in `X-Forwarded-For`.
fn phone_from(relay: &TestRelay, server: &str, address: &str) -> WebSocket<TcpStream> {
    connect(
        relay.phones,
        &format!("/relay/phone/{server}"),
        &[("Origin", ORIGIN), ("X-Forwarded-For", address)],
    )
}

fn new_link(queued: &Arc<AtomicUsize>) -> Link {
    Link::new(
        encode_key(&generate_keypair().unwrap().public),
        queued.clone(),
    )
    .unwrap()
}

#[test]
fn refuses_another_origin() {
    let relay = TestRelay::start();
    let server = encode_key(&generate_keypair().unwrap().public);
    let path = format!("/relay/phone/{server}");
    let refused = |origin| try_connect(relay.phones, &path, &[("Origin", origin)]).err();
    assert_eq!(refused("https://ailleurs.test"), Some(403));
    assert_eq!(refused("http://relais.test"), Some(403));
    assert_eq!(try_connect(relay.phones, &path, &[]).err(), Some(403));
}

#[test]
fn closes_phones_of_an_unknown_server() {
    let relay = TestRelay::start();
    let server = encode_key(&generate_keypair().unwrap().public);
    assert_eq!(close_code(&mut phone(&relay, &server)), 4404);
    assert_eq!(close_code(&mut phone(&relay, "pas-une-cle")), 4400);
}

#[test]
fn refuses_a_server_with_another_relay_key() {
    let relay = TestRelay::start();
    let keypair = generate_keypair().unwrap();
    let public = keypair.public;
    let wrong = generate_keypair().unwrap().public;
    assert!(FakeServer::try_connect(&relay, keypair, &wrong).is_none());
    assert!(relay.relay.link(&encode_key(&public)).is_none());
}

#[test]
fn relays_end_to_end_both_ways() {
    let relay = TestRelay::start();
    let mut server = FakeServer::connect(&relay, generate_keypair().unwrap());
    let server_static = server.keypair.private;
    let phone_keys = generate_keypair().unwrap();
    let mut phone_ws = phone(&relay, &server.id());
    let channel = server.opened();

    let mut buffer = vec![0u8; 65535];
    let mut phone_noise =
        initiator(&phone_keys.private, &server.keypair.public, PHONE_PROLOGUE).unwrap();
    let length = phone_noise.write_message(b"bonjour", &mut buffer).unwrap();
    phone_ws
        .send(Message::binary(buffer[..length].to_vec()))
        .unwrap();
    let Frame::Data(data_channel, first) = server.receive() else {
        panic!("données attendues");
    };
    assert_eq!(data_channel, channel);
    let mut server_noise = responder(&server_static, PHONE_PROLOGUE).unwrap();
    let length = server_noise.read_message(&first, &mut buffer).unwrap();
    assert_eq!(&buffer[..length], b"bonjour");
    assert_eq!(
        server_noise.get_remote_static().unwrap(),
        &phone_keys.public[..]
    );
    let length = server_noise.write_message(b"ok", &mut buffer).unwrap();
    server.send(Frame::Data(channel, buffer[..length].to_vec()));
    let second = binary(&mut phone_ws).unwrap();
    let length = phone_noise.read_message(&second, &mut buffer).unwrap();
    assert_eq!(&buffer[..length], b"ok");

    let mut phone_transport = phone_noise.into_transport_mode().unwrap();
    let mut server_transport = server_noise.into_transport_mode().unwrap();
    let up = seal(&mut phone_transport, b"vers le serveur").unwrap();
    phone_ws.send(Message::binary(up)).unwrap();
    let Frame::Data(_, up) = server.receive() else {
        panic!("données attendues");
    };
    assert_eq!(
        open(&mut server_transport, &up).unwrap(),
        b"vers le serveur"
    );
    let down = seal(&mut server_transport, b"vers le telephone").unwrap();
    server.send(Frame::Data(channel, down));
    let down = binary(&mut phone_ws).unwrap();
    assert_eq!(
        open(&mut phone_transport, &down).unwrap(),
        b"vers le telephone"
    );

    phone_ws.close(None).unwrap();
    assert_eq!(server.receive(), Frame::Close(channel));

    let mut other = phone(&relay, &server.id());
    let other_channel = server.opened();
    assert_ne!(other_channel, channel);
    server.send(Frame::Close(other_channel));
    assert_eq!(close_code(&mut other), 1000);
}

#[test]
fn a_new_link_replaces_the_previous_one() {
    let relay = TestRelay::start();
    let keypair = generate_keypair().unwrap();
    let copy = Keypair {
        private: keypair.private,
        public: keypair.public,
    };
    let mut first = FakeServer::connect(&relay, keypair);
    let mut old_phone = phone(&relay, &first.id());
    first.opened();
    let previous = relay.relay.link(&first.id()).unwrap();

    let mut second = FakeServer::connect(&relay, copy);
    let deadline = Instant::now() + TIMEOUT;
    while relay
        .relay
        .link(&second.id())
        .is_some_and(|link| Arc::ptr_eq(&link, &previous))
    {
        assert!(Instant::now() < deadline, "lien jamais remplacé");
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(close_code(&mut old_phone), 4404);
    assert!(binary(&mut first.ws).is_none());

    let _new_phone = phone(&relay, &second.id());
    second.opened();
}

#[test]
fn limits_the_channels_of_a_server() {
    let relay = TestRelay::start();
    let mut server = FakeServer::connect(&relay, generate_keypair().unwrap());
    let phones: Vec<_> = (0..MAX_CHANNELS)
        .map(|i| {
            let ws = phone_from(
                &relay,
                &server.id(),
                &format!("192.0.2.{}", i / CHANNELS_PER_ADDRESS),
            );
            server.opened();
            ws
        })
        .collect();
    assert_eq!(
        close_code(&mut phone_from(&relay, &server.id(), "198.51.100.1")),
        4429
    );
    drop(phones);
}

#[test]
fn limits_the_channels_of_one_address_to_a_server() {
    let relay = TestRelay::start();
    let mut server = FakeServer::connect(&relay, generate_keypair().unwrap());
    let phones: Vec<_> = (0..CHANNELS_PER_ADDRESS)
        .map(|_| {
            let ws = phone(&relay, &server.id());
            server.opened();
            ws
        })
        .collect();
    assert_eq!(close_code(&mut phone(&relay, &server.id())), 4429);
    let _other = phone_from(&relay, &server.id(), "192.0.2.1");
    server.opened();
    drop(phones);
}

#[test]
fn limits_the_server_connections_of_one_address() {
    let relay = TestRelay::start();
    // Closed at once when refused; otherwise left waiting for a header.
    let refused = || {
        let mut stream = TcpStream::connect(relay.servers).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        matches!(stream.read(&mut [0]), Ok(0))
    };
    let held: Vec<_> = (0..SERVERS_PER_ADDRESS)
        .map(|_| TcpStream::connect(relay.servers).unwrap())
        .collect();
    assert!(refused(), "une adresse prend toutes les places");
    drop(held);
    let deadline = Instant::now() + TIMEOUT;
    while refused() {
        assert!(Instant::now() < deadline, "places jamais rendues");
    }
    FakeServer::connect(&relay, generate_keypair().unwrap());
}

#[test]
fn closes_a_phone_sending_a_frame_too_large() {
    let relay = TestRelay::start();
    let mut server = FakeServer::connect(&relay, generate_keypair().unwrap());
    let mut phone_ws = phone(&relay, &server.id());
    let channel = server.opened();
    phone_ws
        .send(Message::binary(vec![0u8; PHONE_FRAME_LIMIT + 1]))
        .unwrap();
    assert_eq!(close_code(&mut phone_ws), 4400);
    assert_eq!(server.receive(), Frame::Close(channel));
}

#[test]
fn a_replayed_hello_does_not_replace_the_link() {
    let relay = TestRelay::start();
    let mut server = FakeServer::connect(&relay, generate_keypair().unwrap());
    let linked = relay.relay.link(&server.id()).unwrap();
    let unchanged = || {
        relay
            .relay
            .link(&server.id())
            .is_some_and(|link| Arc::ptr_eq(&link, &linked))
    };
    let mut replay = connect(relay.servers, "/relay/server", &[]);
    replay.send(Message::binary(server.hello.clone())).unwrap();
    assert!(binary(&mut replay).is_some(), "message 2 attendu");
    thread::sleep(Duration::from_millis(200));
    assert!(unchanged(), "lien remplacé avant d’être prêt");
    replay.send(Message::binary(vec![0u8; 32])).unwrap();
    assert!(binary(&mut replay).is_none());
    assert!(unchanged(), "lien remplacé par un message rejoué");
    let _phone = phone(&relay, &server.id());
    server.opened();
}

#[test]
fn empty_messages_count_towards_the_channel_limits() {
    let link = new_link(&Arc::default());
    let most = CHANNEL_QUEUE_LIMIT / MESSAGE_COST;
    let up = link.open().unwrap();
    assert!((0..=most).any(|_| !link.send(&up, Vec::new())));
    assert_eq!(up.code(), OVERFLOW);
    let down = link.open().unwrap();
    for _ in 0..=most {
        link.deliver(down.id, Vec::new());
    }
    assert_eq!(down.code(), OVERFLOW);
}

#[test]
fn phones_that_come_and_go_cannot_pile_up_messages() {
    let link = new_link(&Arc::default());
    let message = vec![0u8; PHONE_FRAME_LIMIT];
    let per_channel = CHANNEL_QUEUE_LIMIT / (PHONE_FRAME_LIMIT + MESSAGE_COST);
    let channels = 2 * LINK_QUEUE_LIMIT / CHANNEL_QUEUE_LIMIT;
    let refused = (0..channels).find_map(|_| {
        let channel = match link.open() {
            Ok(channel) => channel,
            Err(code) => return Some(code),
        };
        for _ in 0..per_channel {
            if !link.send(&channel, message.clone()) {
                break;
            }
        }
        link.release(&channel);
        None
    });
    assert_eq!(refused, Some(TOO_MANY));
    while let Pop::Item(item) = link.outbox.pop() {
        item.sent();
    }
    assert!(link.open().is_ok(), "le serveur lit de nouveau");
}

#[test]
fn phones_that_leave_free_their_queue_behind_a_server_that_stopped_reading() {
    let link = new_link(&Arc::default());
    let message = vec![0u8; PHONE_FRAME_LIMIT];
    let left: Vec<_> = (0..2 * MAX_CHANNELS)
        .map(|_| {
            let channel = link.open().unwrap();
            assert!(link.send(&channel, message.clone()));
            // A phone that reads nothing either.
            for _ in 0..16 {
                link.deliver(channel.id, message.clone());
            }
            link.release(&channel);
            Arc::downgrade(&channel)
        })
        .collect();
    let kept = left.iter().filter(|channel| channel.strong_count() > 0);
    assert_eq!(kept.count(), 0, "files vers des téléphones partis retenues");
    let mut queued = 0;
    while let Pop::Item(item) = link.outbox.pop() {
        queued += matches!(item.frame, Frame::Data(..)) as usize;
    }
    assert_eq!(queued, 2 * MAX_CHANNELS);
}

#[test]
fn the_relay_bounds_what_all_its_links_hold_queued() {
    // Other links already hold all but one channel's worth.
    let others = RELAY_QUEUE_LIMIT - CHANNEL_QUEUE_LIMIT;
    let queued = Arc::new(AtomicUsize::new(others));
    let (first, second) = (new_link(&queued), new_link(&queued));
    let message = vec![0u8; PHONE_FRAME_LIMIT];
    let per_channel = CHANNEL_QUEUE_LIMIT / (PHONE_FRAME_LIMIT + MESSAGE_COST);
    let early = first.open().unwrap();
    assert!((0..per_channel / 2).all(|_| first.send(&early, message.clone())));
    let late = second.open().unwrap();
    assert!((0..per_channel).any(|_| !second.send(&late, message.clone())));
    assert_eq!(late.code(), OVERFLOW);
    assert!(queued.load(Ordering::Acquire) <= RELAY_QUEUE_LIMIT);
    drop((second, late));
    while let Pop::Item(item) = first.outbox.pop() {
        item.sent();
    }
    assert_eq!(
        queued.load(Ordering::Acquire),
        others,
        "files jamais rendues"
    );
}

pub(crate) fn shrink_buffer(stream: &TcpStream, option: libc::c_int) {
    let size: libc::c_int = 4096;
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

/// The CPU time of each relay connection thread, in clock ticks.
fn connection_ticks() -> HashMap<String, u64> {
    let mut ticks = HashMap::new();
    for task in std::fs::read_dir("/proc/self/task").unwrap().flatten() {
        let path = task.path();
        let (Ok(name), Ok(stat)) = (
            std::fs::read_to_string(path.join("comm")),
            std::fs::read_to_string(path.join("stat")),
        ) else {
            continue;
        };
        if name.trim_end() != "connexion" {
            continue;
        }
        let fields: Vec<&str> = stat[stat.rfind(')').unwrap() + 2..].split(' ').collect();
        let used = fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap();
        ticks.insert(task.file_name().to_string_lossy().into_owned(), used);
    }
    ticks
}

/// Once done with what it was given, no connection thread keeps a core busy.
fn assert_relay_settles() {
    let mut busiest = 0;
    for _ in 0..20 {
        let before = connection_ticks();
        thread::sleep(Duration::from_millis(500));
        busiest = connection_ticks()
            .into_iter()
            .map(|(task, used)| used - before.get(&task).copied().unwrap_or(0))
            .max()
            .unwrap_or(0);
        if busiest < 20 {
            return;
        }
    }
    panic!("une connexion occupe le processeur : {busiest}/50");
}

#[test]
fn a_server_that_stopped_reading_costs_no_cpu() {
    let relay = TestRelay::start();
    let keypair = generate_keypair().unwrap();
    let copy = Keypair {
        private: keypair.private,
        public: keypair.public,
    };
    let mut server = FakeServer::connect(&relay, keypair);
    shrink_buffer(server.ws.get_ref(), libc::SO_RCVBUF);
    let mut phone_ws = phone(&relay, &server.id());
    server.opened();
    // Past the relay's socket buffer, within the channel's limit.
    for _ in 0..(12 << 20) / PHONE_FRAME_LIMIT {
        phone_ws
            .send(Message::binary(vec![0u8; PHONE_FRAME_LIMIT]))
            .unwrap();
    }
    assert_relay_settles();
    let _replacement = FakeServer::connect(&relay, copy);
    assert_relay_settles();
}

#[test]
fn serves_the_phones_on_a_unix_socket_behind_caddy() {
    use std::os::unix::{fs::PermissionsExt, net::UnixStream};
    let dir = std::env::temp_dir().join(format!("soreno-relay-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("phones.sock");
    // What the previous run left behind.
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    let listener = Listener::bind(&format!("unix:{}", path.display())).unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o660);
    let relay = Arc::new(Relay::new([7; 32], ORIGIN.into()));
    let stop = Arc::new(Stop::new().unwrap());
    {
        let (relay, stop) = (relay.clone(), stop.clone());
        thread::spawn(move || http::run(listener, Side::Phones, relay, stop));
    }
    let mut page = UnixStream::connect(&path).unwrap();
    page.set_read_timeout(Some(TIMEOUT)).unwrap();
    write!(page, "GET / HTTP/1.1\r\nHost: relais.test\r\n\r\n").unwrap();
    let mut response = String::new();
    page.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 404"), "{response}");

    let server = encode_key(&generate_keypair().unwrap().public);
    let phone = |forwarded: Option<&str>| {
        let mut request = format!("ws://relais.test/relay/phone/{server}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", ORIGIN.parse().unwrap());
        if let Some(forwarded) = forwarded {
            request
                .headers_mut()
                .insert("X-Forwarded-For", forwarded.parse().unwrap());
        }
        let stream = UnixStream::connect(&path).unwrap();
        stream.set_read_timeout(Some(TIMEOUT)).unwrap();
        tungstenite::client(request, stream).ok().map(|(ws, _)| ws)
    };
    assert!(phone(None).is_none(), "téléphone sans adresse admis");
    assert_eq!(close_code(&mut phone(Some("203.0.113.9")).unwrap()), 4404);
    stop.request();
    let _ = std::fs::remove_dir_all(&dir);
}
