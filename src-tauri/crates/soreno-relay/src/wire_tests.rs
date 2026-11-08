use super::{Wire, CLOSE_TIMEOUT};
use crate::relay_tests::shrink_buffer;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tungstenite::{handshake::derive_accept_key, Message};

/// The next connection on `listener`, upgraded to a WebSocket with nothing read past the request.
fn upgraded(listener: &TcpListener) -> TcpStream {
    let (mut stream, _) = listener.accept().unwrap();
    let mut request = Vec::new();
    let mut byte = [0u8; 1];
    while !request.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        request.push(byte[0]);
    }
    let request = String::from_utf8(request).unwrap();
    let key = request
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("sec-websocket-key")
                .then(|| value.trim())
        })
        .unwrap();
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Accept: {}\r\n\r\n",
        derive_accept_key(key.as_bytes())
    )
    .unwrap();
    stream
}

#[test]
fn fails_a_peer_that_pings_without_reading() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let peer = thread::spawn(move || {
        let stream = TcpStream::connect(address).unwrap();
        shrink_buffer(&stream, libc::SO_RCVBUF);
        let (mut ws, _) = tungstenite::client(format!("ws://{address}/"), stream).unwrap();
        // Several times the bound in replies, which the peer never reads.
        for _ in 0..20_000 {
            ws.write(Message::Ping(vec![0u8; 125].into())).unwrap();
        }
        ws.send(Message::binary(b"fin".to_vec())).unwrap();
        ws
    });
    let stream = upgraded(&listener);
    shrink_buffer(&stream, libc::SO_SNDBUF);
    let mut wire = Wire::accept(stream.into(), Vec::new(), 1 << 16).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (messages, fault) = wire.receive();
        assert_eq!(fault, None);
        if !messages.is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "message final jamais reçu");
        wire.wait(&[], Some(deadline));
    }
    assert!(!wire.send(vec![0u8; 1024]));
    drop(peer.join().unwrap());
}

/// `finish` ends within about `CLOSE_TIMEOUT` while the peer keeps sending `head` then `flood`.
fn assert_closes_on_time(head: &'static [u8], flood: Vec<u8>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let peer = thread::spawn(move || {
        let stream = TcpStream::connect(address).unwrap();
        let (ws, _) = tungstenite::client(format!("ws://{address}/"), stream).unwrap();
        let mut stream = ws.into_inner();
        stream.write_all(head).unwrap();
        while stream.write_all(&flood).is_ok() {}
    });
    let stream = upgraded(&listener);
    let wire = Wire::accept(stream.into(), Vec::new(), 1 << 16).unwrap();
    let (done, finished) = mpsc::channel();
    let started = Instant::now();
    thread::spawn(move || {
        wire.finish(1000);
        let _ = done.send(started.elapsed());
    });
    let elapsed = finished
        .recv_timeout(CLOSE_TIMEOUT + Duration::from_secs(5))
        .expect("fermeture retenue par le flot entrant");
    assert!(
        elapsed < CLOSE_TIMEOUT + Duration::from_secs(1),
        "{elapsed:?}"
    );
    peer.join().unwrap();
}

#[test]
fn closes_on_time_under_a_continuous_flood() {
    // Empty masked binary frames, far cheaper to write than to read: the relay never runs dry.
    assert_closes_on_time(&[], [0x82, 0x80, 0, 0, 0, 0].repeat(10_000));
}

#[test]
fn closes_on_time_under_endless_fragments() {
    // A binary frame left open, then empty continuations that never end the message.
    let head = &[0x02, 0x80, 0, 0, 0, 0];
    assert_closes_on_time(head, [0x00, 0x80, 0, 0, 0, 0].repeat(10_000));
}

#[test]
fn receive_returns_under_endless_fragments() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let peer = thread::spawn(move || {
        let stream = TcpStream::connect(address).unwrap();
        let (ws, _) = tungstenite::client(format!("ws://{address}/"), stream).unwrap();
        let mut stream = ws.into_inner();
        stream.write_all(&[0x02, 0x80, 0, 0, 0, 0]).unwrap();
        let flood = [0x00, 0x80, 0, 0, 0, 0].repeat(10_000);
        while stream.write_all(&flood).is_ok() {}
    });
    let stream = upgraded(&listener);
    let mut wire = Wire::accept(stream.into(), Vec::new(), 1 << 16).unwrap();
    let (done, finished) = mpsc::channel();
    let started = Instant::now();
    // As the handshake does: each turn gives the caller its deadline back.
    thread::spawn(move || {
        let deadline = started + Duration::from_secs(1);
        let mut slowest = Duration::ZERO;
        while Instant::now() < deadline {
            let turn = Instant::now();
            let (messages, fault) = wire.receive();
            slowest = slowest.max(turn.elapsed());
            assert!(messages.is_empty() && fault.is_none());
            wire.wait(&[], Some(deadline));
        }
        let _ = done.send(slowest);
    });
    let slowest = finished
        .recv_timeout(Duration::from_secs(10))
        .expect("réception retenue par le flot entrant");
    assert!(slowest < Duration::from_millis(500), "{slowest:?}");
    assert!(started.elapsed() < Duration::from_secs(3));
    peer.join().unwrap();
}
