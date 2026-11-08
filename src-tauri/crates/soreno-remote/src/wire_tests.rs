use super::*;
use std::{io::Read, net::TcpListener, thread};
use tungstenite::protocol::Role;

/// A relay that saw its buffer full watches only the socket: emptying it must end the wait.
#[test]
fn waiting_ends_once_the_send_buffer_empties() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let server = listener.accept().unwrap().0;
    let mut wire = Wire::new(WebSocket::from_raw_socket(
        Budgeted::new(server),
        Role::Server,
        None,
    ))
    .unwrap();
    assert!(wire.send("x".repeat(64 << 20)));
    assert!(wire.unsent);
    let reader = thread::spawn(move || {
        let mut buffer = vec![0u8; 1 << 16];
        while matches!(client.read(&mut buffer), Ok(read) if read > 0) {}
    });
    while wire.unsent {
        let started = Instant::now();
        wire.wait(&[], Some(started + Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    drop(wire);
    reader.join().unwrap();
}

/// A flooding peer must not hold the caller, which would no longer see `stop`.
#[test]
fn receiving_takes_a_bounded_batch_then_comes_back_at_once() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let server = listener.accept().unwrap().0;
    let mut peer = WebSocket::from_raw_socket(client, Role::Client, None);
    let sent = RECEIVE_MESSAGES * 3 + 10;
    for index in 0..sent {
        peer.send(Message::text(index.to_string())).unwrap();
    }
    let mut wire = Wire::new(WebSocket::from_raw_socket(
        Budgeted::new(server),
        Role::Server,
        None,
    ))
    .unwrap();
    let mut received = Vec::new();
    while received.len() < sent {
        let started = Instant::now();
        wire.wait(&[], Some(started + Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(2));
        let (texts, alive) = wire.receive();
        assert!(alive);
        assert!(texts.len() <= RECEIVE_MESSAGES);
        received.extend(texts);
    }
    let expected: Vec<String> = (0..sent).map(|index| index.to_string()).collect();
    assert_eq!(received, expected);
}

/// A caller that only waits for its writes, as when draining, must not spin on unread messages.
#[test]
fn messages_left_behind_end_one_wait_only() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let server = listener.accept().unwrap().0;
    let mut peer = WebSocket::from_raw_socket(client, Role::Client, None);
    for index in 0..RECEIVE_MESSAGES + 10 {
        peer.send(Message::text(index.to_string())).unwrap();
    }
    let mut wire = Wire::new(WebSocket::from_raw_socket(
        Budgeted::new(server),
        Role::Server,
        None,
    ))
    .unwrap();
    while wire.receive().0.is_empty() {}
    let started = Instant::now();
    wire.wait(&[], Some(started + Duration::from_secs(5)));
    assert!(started.elapsed() < Duration::from_secs(2));
    let started = Instant::now();
    wire.wait(&[], Some(started + Duration::from_millis(300)));
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert_eq!(wire.receive().0.len(), 10);
}

#[test]
fn only_lasting_write_errors_break_the_wire() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let _server = listener.accept().unwrap();
    let mut wire = Wire::new(WebSocket::from_raw_socket(
        Budgeted::new(client),
        Role::Client,
        None,
    ))
    .unwrap();
    let failed = |kind| Err(tungstenite::Error::Io(io::Error::from(kind)));
    for kind in [io::ErrorKind::WouldBlock, io::ErrorKind::Interrupted] {
        wire.note(&failed(kind));
        assert!(wire.unsent && !wire.broken(), "{kind:?}");
    }
    assert!(wire.flushed());
    wire.note(&failed(io::ErrorKind::BrokenPipe));
    assert!(wire.broken());
    assert!(!wire.send("x".into()));
}

/// A peer that keeps talking and never answers the close must not hold the caller.
#[test]
fn finishing_ends_at_the_deadline_while_the_peer_keeps_sending() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let server = listener.accept().unwrap().0;
    // Masked client text frames, the zero key leaving the payload as is.
    let frame = [&[0x81, 0x80 | 100, 0, 0, 0, 0][..], &[b'a'; 100]].concat();
    let frames = frame.repeat(10_000);
    let talking = thread::spawn(
        move || {
            while std::io::Write::write_all(&mut client, &frames).is_ok() {}
        },
    );
    let wire = Wire::new(WebSocket::from_raw_socket(
        Budgeted::new(server),
        Role::Server,
        None,
    ))
    .unwrap();
    thread::sleep(Duration::from_millis(200));
    let (done, finished) = std::sync::mpsc::channel();
    let started = Instant::now();
    thread::spawn(move || {
        wire.finish(Instant::now() + Duration::from_millis(500));
        let _ = done.send(());
    });
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    talking.join().unwrap();
}
