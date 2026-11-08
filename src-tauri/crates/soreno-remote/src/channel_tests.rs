use super::*;
use crate::{testing::TempDir, wire::Budgeted};
use soreno_mobile_protocol::{generate_keypair, initiator, RELAY_PROLOGUE};
use std::{
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
};
use tungstenite::{protocol::Role, WebSocket};

/// The server's transport and the phone's.
fn transports() -> (TransportState, TransportState) {
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

/// A paired device's watch.
fn watch(directory: &std::path::Path) -> Watch {
    let public = generate_keypair().unwrap().public;
    let secret = access::pair(directory).unwrap().secret;
    access::admit(directory, &public, "iPhone", Some(&secret))
        .unwrap()
        .unwrap();
    Watch::new(directory, &public)
}

/// A bridge connection whose peer reads nothing, its writes left unsent.
fn stuck_bridge() -> (Wire, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (peer, _) = listener.accept().unwrap();
    let config = WebSocketConfig::default().max_write_buffer_size(2 * MESSAGE_LIMIT);
    let ws = WebSocket::from_raw_socket(Budgeted::new(stream), Role::Client, Some(config));
    let mut wire = Wire::new(ws).unwrap();
    let text = "x".repeat(64 << 10);
    let mut sent = 0;
    // The kernel grows its buffers for a while: full means still full a moment later.
    loop {
        while wire.flushed() {
            assert!(sent < 4096, "le socket ne se remplit pas");
            assert!(wire.send(text.clone()));
            sent += 1;
        }
        thread::sleep(Duration::from_millis(200));
        if !wire.flushed() {
            break;
        }
    }
    (wire, peer)
}

/// Whether the conversation ends within two seconds, with a full link and `inbox` as given.
fn ends_quickly(wire: Wire, prepare: impl FnOnce(&Handle)) -> bool {
    let home = TempDir::new();
    let watch = watch(home.path());
    let handle = Handle::new().unwrap();
    handle.pending.store(SEND_LIMIT, Ordering::Release);
    prepare(&handle);
    let outbox = Mailbox::new().unwrap();
    let stop = Stop::new().unwrap();
    let mut secure = Secure {
        channel: 1,
        transport: transports().0,
        reassembly: Reassembly::default(),
        handle: &handle,
        outbox: &outbox,
    };
    let (done, ended) = mpsc::channel();
    thread::scope(|scope| {
        scope.spawn(|| {
            follow_conversation(&mut secure, wire, watch, &stop);
            let _ = done.send(());
        });
        let ended = ended.recv_timeout(Duration::from_secs(2)).is_ok();
        stop.request();
        ended
    })
}

#[test]
fn a_closed_channel_ends_while_the_bridge_and_the_link_are_full() {
    let (wire, _peer) = stuck_bridge();
    assert!(ends_quickly(wire, |handle| {
        assert!(handle.inbox.push(vec![0u8; 32]));
        handle.inbox.close();
    }));
}

#[test]
fn a_bridge_gone_with_unsent_writes_ends_the_conversation() {
    let (wire, peer) = stuck_bridge();
    drop(peer);
    assert!(ends_quickly(wire, |_| {}));
}

#[test]
fn a_text_sent_just_before_the_channel_closes_reaches_a_busy_bridge() {
    let (wire, peer) = stuck_bridge();
    let home = TempDir::new();
    let watch = watch(home.path());
    let handle = Handle::new().unwrap();
    let (transport, mut phone) = transports();
    for chunk in chunks(b"bonjour\n") {
        assert!(handle.inbox.push(seal(&mut phone, &chunk).unwrap()));
    }
    handle.inbox.close();
    let outbox = Mailbox::new().unwrap();
    let stop = Stop::new().unwrap();
    let mut secure = Secure {
        channel: 1,
        transport,
        reassembly: Reassembly::default(),
        handle: &handle,
        outbox: &outbox,
    };
    let last = thread::scope(|scope| {
        scope.spawn(|| follow_conversation(&mut secure, wire, watch, &stop));
        thread::sleep(Duration::from_millis(300));
        peer.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut bridge = WebSocket::from_raw_socket(peer, Role::Server, None);
        let mut last = None;
        while let Ok(message) = bridge.read() {
            if let tungstenite::Message::Text(text) = message {
                last = Some(text.as_str().to_owned());
            }
        }
        last
    });
    assert_eq!(last.as_deref(), Some("bonjour\n"));
}
