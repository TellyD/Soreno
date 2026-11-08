use super::*;
use crate::{
    access, files,
    testing::{hello, server_key, shrink_buffer, Phone, Running, TempDir},
};
use serde_json::json;
use soreno_mobile_protocol::{encode_key, generate_keypair, responder};
use tungstenite::{protocol::Role, WebSocket};

fn sessions() -> serde_json::Value {
    json!({"kind": "sessions"})
}

fn pairing_secret(home: &std::path::Path) -> String {
    access::pair(&files::remote_dir(home)).unwrap().secret
}

fn state(home: &std::path::Path) -> serde_json::Value {
    let path = files::remote_dir(home).join("state.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn a_phone_pairs_once_then_comes_back_with_its_key() {
    let home = TempDir::new();
    let (_running, mut link) = Running::start(home.path());
    let server = link.server;
    assert_eq!(server, server_key(home.path()));
    let secret = pairing_secret(home.path());
    let phone = Phone::new();

    let (reply, opened) = phone.open(&mut link, 1, &server, hello(sessions(), Some(&secret)));
    assert_eq!(
        reply,
        json!({"ok": true, "host": "vps", "version": env!("CARGO_PKG_VERSION")})
    );
    let mut channel = opened.unwrap();
    assert_eq!(
        channel.next(&mut link),
        json!({"type": "sessions", "host": "vps", "sessions": []})
    );
    let devices = access::read(&files::remote_dir(home.path()))
        .unwrap()
        .devices;
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].id, phone.id());
    assert_eq!(devices[0].label, "iPhone · Safari");

    let other = Phone::new();
    let (reply, _) = other.open(&mut link, 2, &server, hello(sessions(), Some(&secret)));
    assert_eq!(reply, json!({"ok": false, "error": "pairing"}));
    let (reply, _) = other.open(&mut link, 3, &server, hello(sessions(), None));
    assert_eq!(reply, json!({"ok": false, "error": "unpaired"}));
    let (reply, _) = phone.open(&mut link, 4, &server, hello(sessions(), None));
    assert_eq!(reply["ok"], true);

    let (reply, _) = phone.open(
        &mut link,
        5,
        &server,
        hello(json!({"kind": "conversation", "key": "0".repeat(32)}), None),
    );
    assert_eq!(reply, json!({"ok": false, "error": "gone"}));
    let (reply, _) = phone.open(&mut link, 6, &server, json!({"v": 2, "open": sessions()}));
    assert_eq!(reply, json!({"ok": false, "error": "bad"}));
}

#[test]
fn a_phone_with_the_wrong_server_key_gets_no_answer() {
    let home = TempDir::new();
    let (_running, mut link) = Running::start(home.path());
    let secret = pairing_secret(home.path());
    let wrong = soreno_mobile_protocol::generate_keypair().unwrap().public;
    let phone = Phone::new();
    let mut noise = soreno_mobile_protocol::initiator(
        &[7u8; 32],
        &wrong,
        soreno_mobile_protocol::PHONE_PROLOGUE,
    )
    .unwrap();
    let mut message = vec![0u8; NOISE_MESSAGE_LIMIT];
    let length = noise
        .write_message(
            hello(sessions(), Some(&secret)).to_string().as_bytes(),
            &mut message,
        )
        .unwrap();
    message.truncate(length);
    link.send(&Frame::Open(9));
    link.send(&Frame::Data(9, message));
    assert_eq!(link.frame(9), Frame::Close(9));
    // The secret was not spent: the right key still pairs with it.
    let server = link.server;
    let (reply, _) = phone.open(&mut link, 10, &server, hello(sessions(), Some(&secret)));
    assert_eq!(reply["ok"], true);
}

#[test]
fn revoking_a_device_closes_its_channels_within_a_second() {
    let home = TempDir::new();
    let (_running, mut link) = Running::start(home.path());
    let server = link.server;
    let secret = pairing_secret(home.path());
    let phone = Phone::new();
    let (_, opened) = phone.open(&mut link, 1, &server, hello(sessions(), Some(&secret)));
    let mut channel = opened.unwrap();
    channel.next(&mut link);
    let revoked = Instant::now();
    access::revoke(&files::remote_dir(home.path()), &phone.id()).unwrap();
    assert!(channel.closed_until(&mut link, revoked + Duration::from_secs(1)));
    let (reply, _) = phone.open(&mut link, 2, &server, hello(sessions(), None));
    assert_eq!(reply, json!({"ok": false, "error": "unpaired"}));
}

#[test]
fn the_server_links_again_after_a_cut_and_says_so_in_its_state() {
    let home = TempDir::new();
    let (running, link) = Running::start(home.path());
    let deadline = Instant::now() + Duration::from_secs(5);
    while state(home.path())["connected"] != true {
        assert!(Instant::now() < deadline, "{}", state(home.path()));
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(state(home.path())["server"], encode_key(&link.server));

    drop(link);
    let mut link = running.relay.accept();
    let secret = pairing_secret(home.path());
    let server = link.server;
    let (reply, _) = Phone::new().open(&mut link, 1, &server, hello(sessions(), Some(&secret)));
    assert_eq!(reply["ok"], true);
}

#[test]
fn stopping_closes_the_channels_and_the_link() {
    let home = TempDir::new();
    let (running, mut link) = Running::start(home.path());
    let server = link.server;
    let secret = pairing_secret(home.path());
    let (_, opened) = Phone::new().open(&mut link, 1, &server, hello(sessions(), Some(&secret)));
    let mut channel = opened.unwrap();
    channel.next(&mut link);
    running.stop.request();
    assert!(channel.closed_until(&mut link, Instant::now() + Duration::from_secs(5)));
    drop(running);
    assert!(link.closed());
    assert_eq!(state(home.path())["connected"], false);
}

#[test]
fn frames_arriving_with_the_relay_answer_are_served() {
    let home = TempDir::new();
    let phone = Phone::new();
    let mut started = None;
    let (_running, mut link) = Running::start_with(home.path(), |relay| {
        relay.accept_sending(|server| {
            let (frames, noise) = phone.start(1, server, hello(sessions(), None));
            started = Some(noise);
            frames.into()
        })
    });
    let (reply, _) = phone.finish(&mut link, 1, started.unwrap());
    assert_eq!(reply, json!({"ok": false, "error": "unpaired"}));
    let server = link.server;
    let (reply, _) = phone.open(&mut link, 2, &server, hello(sessions(), None));
    assert_eq!(reply, json!({"ok": false, "error": "unpaired"}));
}

fn noise_pair() -> (TransportState, TransportState) {
    let ours = generate_keypair().unwrap();
    let theirs = generate_keypair().unwrap();
    let mut initiating = initiator(&ours.private, &theirs.public, RELAY_PROLOGUE).unwrap();
    let mut responding = responder(&theirs.private, RELAY_PROLOGUE).unwrap();
    let (mut message, mut payload) = (vec![0u8; 1024], vec![0u8; 1024]);
    let length = initiating.write_message(&[], &mut message).unwrap();
    responding
        .read_message(&message[..length], &mut payload)
        .unwrap();
    let length = responding.write_message(&[], &mut message).unwrap();
    initiating
        .read_message(&message[..length], &mut payload)
        .unwrap();
    (
        initiating.into_transport_mode().unwrap(),
        responding.into_transport_mode().unwrap(),
    )
}

#[test]
fn a_slow_relay_holds_the_frames_back_instead_of_cutting_the_link() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (relay_side, _) = listener.accept().unwrap();
    // Small buffers: a relay that does not read fills them within the backlog, which stays short
    // enough for a debug build on a busy runner.
    shrink_buffer(&stream, libc::SO_SNDBUF);
    shrink_buffer(&relay_side, libc::SO_RCVBUF);
    let config = WebSocketConfig::default().max_write_buffer_size(1 << 20);
    let ws = WebSocket::from_raw_socket(Budgeted::new(stream), Role::Client, Some(config));
    let mut wire = Wire::new(ws).unwrap();
    let (mut transport, mut relay_transport) = noise_pair();
    const FRAMES: usize = 100;
    let mut backlog: VecDeque<Frame> = (0..FRAMES)
        .map(|index| Frame::Data(1, vec![index as u8; 60_000]))
        .collect();

    assert!(forward(&mut wire, &mut transport, &mut backlog, |_| true));
    assert!(
        !backlog.is_empty(),
        "le relais ne lit pas : rien ne doit partir"
    );

    let reading = thread::spawn(move || {
        let mut relay = WebSocket::from_raw_socket(relay_side, Role::Server, None);
        (0..FRAMES)
            .map(|_| {
                let message = relay.read().unwrap().into_data();
                let plain = open(&mut relay_transport, &message).unwrap();
                let Some(Frame::Data(1, data)) = Frame::decode(&plain) else {
                    panic!("trame inattendue");
                };
                data[0]
            })
            .collect::<Vec<u8>>()
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    while !(backlog.is_empty() && wire.flushed()) {
        assert!(
            Instant::now() < deadline,
            "{} trames en attente",
            backlog.len()
        );
        assert!(forward(&mut wire, &mut transport, &mut backlog, |_| true));
        wire.wait(&[], Some(deadline));
    }
    let expected: Vec<u8> = (0..FRAMES).map(|index| index as u8).collect();
    assert_eq!(reading.join().unwrap(), expected);
}

#[test]
fn empty_phone_messages_still_fill_the_inbox() {
    let handle = Handle::new().unwrap();
    for _ in 0..channel::INBOX_LIMIT / channel::MESSAGE_COST {
        deliver(&handle, Vec::new());
    }
    assert!(handle.inbox.push_within(Vec::new(), 0, usize::MAX));
    deliver(&handle, Vec::new());
    assert!(!handle.inbox.push(Vec::new()), "boîte pleine : fermée");
}

#[test]
fn a_finished_channel_takes_no_more_phone_messages() {
    let home = TempDir::new();
    let context = Context {
        directory: home.path().to_owned(),
        sessions: crate::sessions::roots(home.path()),
        host: "vps".into(),
        private: generate_keypair().unwrap().private,
        bridge: "127.0.0.1:1".parse().unwrap(),
        token: String::new(),
    };
    let handle = Handle::new().unwrap();
    let outbox = Mailbox::new().unwrap();
    let stop = Stop::new().unwrap();
    assert!(handle.inbox.push(vec![0u8; 8]));
    channel::serve(1, &handle, &outbox, &context, &stop);
    assert_eq!(outbox.take().0, vec![Frame::Close(1)]);
    assert!(!handle.inbox.push(vec![0u8; 16]));
}

#[test]
fn a_relay_dripping_its_answer_fails_the_link_at_the_deadline_or_the_stop() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = Endpoint::parse(
        &format!("ws://{}", listener.local_addr().unwrap()),
        &encode_key(&generate_keypair().unwrap().public),
    )
    .unwrap();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            thread::spawn(move || {
                let answer = b"HTTP/1.1 101 Switching Protocols\r\nX-Slow: ".iter();
                for byte in answer.chain(std::iter::repeat(&b'a')) {
                    if std::io::Write::write_all(&mut stream, &[*byte]).is_err() {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            });
        }
    });
    let keypair = generate_keypair().unwrap();
    let identity = Identity {
        private: keypair.private,
        public: keypair.public,
    };
    let stop = Stop::new().unwrap();

    let started = Instant::now();
    let error = connect(&endpoint, &identity, &stop, Duration::from_millis(500)).err();
    let elapsed = started.elapsed();
    assert_eq!(error.as_deref(), Some("délai de connexion dépassé"));
    assert!(
        (Duration::from_millis(500)..Duration::from_secs(2)).contains(&elapsed),
        "{elapsed:?}"
    );

    let started = Instant::now();
    let error = thread::scope(|scope| {
        let linking =
            scope.spawn(|| connect(&endpoint, &identity, &stop, Duration::from_secs(60)).err());
        thread::sleep(Duration::from_millis(300));
        stop.request();
        linking.join().unwrap()
    });
    assert_eq!(error.as_deref(), Some("arrêt demandé"));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_relay_streaming_empty_fragments_fails_the_link_at_the_deadline() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = Endpoint::parse(
        &format!("ws://{}", listener.local_addr().unwrap()),
        &encode_key(&generate_keypair().unwrap().public),
    )
    .unwrap();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        // A binary frame never finished, then empty continuations: no message ever completes.
        let mut fragments = vec![0x02, 0x00];
        fragments.extend([0x00, 0x00].repeat(1 << 15));
        let stream = ws.get_mut();
        while std::io::Write::write_all(stream, &fragments).is_ok() {
            fragments.truncate(1 << 16);
            fragments[..2].copy_from_slice(&[0x00, 0x00]);
        }
    });
    let keypair = generate_keypair().unwrap();
    let identity = Identity {
        private: keypair.private,
        public: keypair.public,
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    let started = Instant::now();
    thread::spawn(move || {
        let stop = Stop::new().unwrap();
        let error = connect(&endpoint, &identity, &stop, Duration::from_millis(500)).err();
        let _ = sender.send(error);
    });
    let error = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(error.as_deref(), Some("pas de réponse"));
    assert!(started.elapsed() < Duration::from_secs(5));
}
