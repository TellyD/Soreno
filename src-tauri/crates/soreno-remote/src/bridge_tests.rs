use super::*;
use crate::testing::TempDir;

const KEY: &str = "0123456789abcdef0123456789abcdef";
const TOKEN: &str = "jeton";

fn request(raw: &str) -> Request {
    parse_request(raw.as_bytes()).unwrap().unwrap().0
}

fn conversation(extra: &str) -> Request {
    request(&format!(
        "GET /api/sessions/{KEY}/conversation HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    ))
}

#[test]
fn only_the_channels_get_in() {
    let temp = TempDir::new();
    let bridge = Bridge {
        sessions: sessions::roots(temp.path()),
        token: TOKEN.into(),
    };
    let token = format!("{TOKEN_HEADER}: {TOKEN}\r\n");
    assert_eq!(route(&conversation(""), &bridge), Reply::Refused(403));
    let wrong = format!("{TOKEN_HEADER}: jetoN\r\n");
    assert_eq!(route(&conversation(&wrong), &bridge), Reply::Refused(403));
    let browser = format!("{token}Origin: https://evil.example\r\n");
    assert_eq!(route(&conversation(&browser), &bridge), Reply::Refused(403));
    // The checks pass; the session simply does not exist.
    assert_eq!(route(&conversation(&token), &bridge), Reply::Refused(404));
    let page = request(&format!("GET / HTTP/1.1\r\n{token}\r\n"));
    assert_eq!(route(&page, &bridge), Reply::Refused(404));
    let plain = request(&format!(
        "GET /api/sessions/{KEY}/conversation HTTP/1.1\r\n{token}\r\n"
    ));
    assert_eq!(route(&plain, &bridge), Reply::Refused(400));
}

#[test]
fn refuses_a_header_over_the_limit_even_when_complete() {
    let long = format!(
        "GET / HTTP/1.1\r\nX-Long: {}\r\n\r\n",
        "a".repeat(HEADER_LIMIT)
    );
    assert_eq!(parse_request(long.as_bytes()).unwrap_err(), 431);
    assert_eq!(
        parse_request(&long.as_bytes()[..HEADER_LIMIT + 1]).unwrap_err(),
        431
    );
}
