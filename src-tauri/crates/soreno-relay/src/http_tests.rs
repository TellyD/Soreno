use super::*;

fn request(method: &str, path: &str, headers: &[(&str, &str)]) -> Request {
    Request {
        method: method.into(),
        path: path.into(),
        headers: headers
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect(),
    }
}

fn relay() -> Relay {
    Relay::new([7; 32], "https://relais.test".into())
}

const WEBSOCKET: [(&str, &str); 3] = [
    ("Upgrade", "websocket"),
    ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
    ("Sec-WebSocket-Version", "13"),
];

#[test]
fn routes_each_listener_to_its_own_paths() {
    let relay = relay();
    let mut phone_headers = WEBSOCKET.to_vec();
    phone_headers.push(("Origin", "https://relais.test"));
    let phone = request("GET", "/relay/phone/abc?x=1", &phone_headers);
    assert!(matches!(
        route(&phone, Side::Phones, &relay),
        Reply::Phone { server, .. } if server == "abc"
    ));
    assert_eq!(
        route(&phone, Side::Servers, &relay),
        Reply::Response(not_found())
    );
    let server = request("GET", "/relay/server", &WEBSOCKET);
    assert!(matches!(
        route(&server, Side::Servers, &relay),
        Reply::Server { .. }
    ));
    assert_eq!(
        route(&server, Side::Phones, &relay),
        Reply::Response(not_found())
    );
    let post = request("POST", "/", &[]);
    assert_eq!(
        route(&post, Side::Phones, &relay).response_status(),
        Some(405)
    );
    let plain = request(
        "GET",
        "/relay/phone/abc",
        &[("Origin", "https://relais.test")],
    );
    assert_eq!(
        route(&plain, Side::Phones, &relay).response_status(),
        Some(400)
    );
}

#[test]
fn trusts_the_last_forwarded_address() {
    let peer: IpAddr = "127.0.0.1".parse().unwrap();
    let forwarded = request("GET", "/", &[("X-Forwarded-For", "10.0.0.1, 203.0.113.9")]);
    assert_eq!(
        client_address(&forwarded, Some(peer)),
        Some("203.0.113.9".parse::<IpAddr>().unwrap())
    );
    assert_eq!(
        client_address(&forwarded, None),
        client_address(&forwarded, Some(peer))
    );
    assert_eq!(
        client_address(&request("GET", "/", &[]), Some(peer)),
        Some(peer)
    );
    assert_eq!(client_address(&request("GET", "/", &[]), None), None);
    let garbage = request("GET", "/", &[("X-Forwarded-For", "inconnu")]);
    assert_eq!(client_address(&garbage, Some(peer)), Some(peer));
}

#[test]
fn gives_a_trickled_header_a_total_deadline() {
    let (server, mut client) = std::os::unix::net::UnixStream::pair().unwrap();
    let trickle = thread::spawn(move || {
        // Each byte well within the per-read timeout, never a whole header.
        for &byte in b"GET / HTTP/1.1\r\nX-Lent: ".iter().cycle() {
            if client.write_all(&[byte]).is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
    });
    let started = Instant::now();
    let deadline = started + Duration::from_millis(500);
    assert!(matches!(
        read_request(&mut Stream::Unix(server), deadline),
        Ok(None)
    ));
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    trickle.join().unwrap();
}

impl Reply {
    fn response_status(&self) -> Option<u16> {
        match self {
            Reply::Response(response) => Some(response.status),
            _ => None,
        }
    }
}
