use crate::{
    access, files, sessions,
    testing::{hello, Link, Phone, PhoneChannel, Running, TempDir},
};
use serde_json::json;
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

const KEY: &str = "0123456789abcdef0123456789abcdef";
// What the program reads goes to `recu`, where the tests look for it.
const SCRIPT: &str = r#"d=$1
printf '%s tok\n' "$PPID" > "$d/pid"
while IFS= read -r line; do printf '%s\n' "$line" >> "$d/recu"; done"#;

struct Session {
    directory: PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(pid) = fs::read_to_string(self.directory.join("pid"))
            .ok()
            .and_then(|pid| pid.split_whitespace().next()?.parse::<i32>().ok())
            .filter(|&pid| pid > 0)
        {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
}

fn start_session(home: &Path) -> Session {
    let directory = sessions::roots(home)[0].join(KEY);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("label"), "Projet · Test\n").unwrap();
    // Checked in without the execute bit: deployed like Soreno desktop does.
    let dtach = home.join(".cache/soreno/dtach/test/dtach");
    fs::create_dir_all(dtach.parent().unwrap()).unwrap();
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dtach/bin/linux-x86_64/dtach"),
        &dtach,
    )
    .unwrap();
    fs::set_permissions(&dtach, fs::Permissions::from_mode(0o700)).unwrap();
    // A sibling test forking while this copy was open for writing makes exec fail for a moment.
    let status = loop {
        let status = Command::new(&dtach)
            .arg("-n")
            .arg(directory.join("socket"))
            .args(["-E", "-z", "sh", "-c", SCRIPT, "sh"])
            .arg(&directory)
            .env("HOME", home)
            .status();
        match status {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                thread::sleep(Duration::from_millis(20));
            }
            status => break status.unwrap(),
        }
    };
    assert!(status.success());
    let session = Session { directory };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !sessions::running(&session.directory) {
        assert!(Instant::now() < deadline, "la session n’a pas démarré");
        thread::sleep(Duration::from_millis(20));
    }
    session
}

/// Waits until the program has read `line`.
fn wait_received(session: &Session, line: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let received = fs::read_to_string(session.directory.join("recu")).unwrap_or_default();
        if received.lines().any(|read| read == line) {
            return;
        }
        assert!(Instant::now() < deadline, "{line:?} absent de {received:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn session_entry() -> serde_json::Value {
    json!({
        "key": KEY, "label": "Projet · Test", "attached": false,
        "provider": null, "name": null, "working": null, "awaiting": false, "rpc": false,
    })
}

fn assistant_line(id: &str, text: &str) -> String {
    json!({"type": "message", "id": id, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
        .to_string()
        + "\n"
}

fn assistant_item(id: &str, text: &str) -> serde_json::Value {
    json!({"kind": "assistant", "id": format!("{id}:0"), "text": text})
}

fn append(path: &Path, text: &str) {
    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

/// An OMP agent for the session, as Soreno desktop and its bridge describe it.
struct Agent {
    directory: PathBuf,
}

impl Agent {
    fn new(home: &Path, session: &Session) -> Self {
        let directory = home.join(".cache/soreno/agent.test");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            session.directory.join("agent"),
            format!("{}\n", directory.display()),
        )
        .unwrap();
        Self { directory }
    }

    fn history(&self, name: &str, lines: &str) -> PathBuf {
        let path = self.directory.join(name);
        fs::write(&path, lines).unwrap();
        path
    }

    /// Replaced whole, as the bridge does: the service never reads half of it.
    fn describe(&self, history: &Path, working: bool) {
        let metadata = json!({
            "version": 1, "provider": "omp", "sessionFile": history, "working": working,
        });
        let partial = self.directory.join("metadata.json.tmp");
        fs::write(&partial, metadata.to_string()).unwrap();
        fs::rename(partial, self.directory.join("metadata.json")).unwrap();
    }
}

fn reset(items: serde_json::Value) -> serde_json::Value {
    json!({"type": "reset", "provider": "omp", "available": true, "truncated": false, "images": true, "rpc": false, "items": items})
}

fn input(link: &mut Link, channel: &mut PhoneChannel, data: &str) {
    channel.send(link, &json!({"type": "input", "data": data}));
}

fn send_image(link: &mut Link, channel: &mut PhoneChannel, id: u64, mime_type: &str, bytes: &[u8]) {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let message =
        json!({"type": "image", "id": id, "mimeType": mime_type, "data": STANDARD.encode(bytes)});
    channel.send(link, &message);
}

/// The saved image, checked to be the one sent and to sit in the session directory.
fn saved_image(
    link: &mut Link,
    channel: &mut PhoneChannel,
    id: u64,
    session: &Session,
    bytes: &[u8],
) {
    let reply = channel.next(link);
    assert_eq!(reply["type"], "imageSaved", "{reply}");
    assert_eq!(reply["id"], id);
    let path = PathBuf::from(reply["path"].as_str().unwrap());
    assert!(
        path.starts_with(session.directory.join("clipboard")),
        "{path:?}"
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}

/// A paired phone's conversation with the test session.
fn converse(home: &Path, link: &mut Link, phone: &Phone, channel: u32) -> PhoneChannel {
    let secret = access::pair(&files::remote_dir(home)).unwrap().secret;
    let open = json!({"kind": "conversation", "key": KEY});
    let server = link.server;
    let (reply, opened) = phone.open(link, channel, &server, hello(open, Some(&secret)));
    assert_eq!(reply["ok"], true, "{reply}");
    opened.unwrap()
}

#[test]
fn a_phone_lists_the_sessions_of_the_server() {
    let home = TempDir::new();
    let _session = start_session(home.path());
    let (_running, mut link) = Running::start(home.path());
    let secret = access::pair(&files::remote_dir(home.path()))
        .unwrap()
        .secret;
    let server = link.server;
    let (_, opened) = Phone::new().open(
        &mut link,
        1,
        &server,
        hello(json!({"kind": "sessions"}), Some(&secret)),
    );
    let mut channel = opened.unwrap();
    assert_eq!(
        channel.next(&mut link),
        json!({"type": "sessions", "host": "vps", "sessions": [session_entry()]})
    );
}

#[test]
fn a_session_past_the_sun_path_limit_still_takes_input() {
    let temp = TempDir::new();
    let home = temp.path().join("h".repeat(80));
    let session = start_session(&home);
    assert!(session.directory.join("socket").as_os_str().len() > 108);
    let (_running, mut link) = Running::start(&home);
    let mut channel = converse(&home, &mut link, &Phone::new(), 1);
    input(&mut link, &mut channel, "long\r");
    wait_received(&session, "long");
}

#[test]
fn a_conversation_follows_the_agent_history_and_types_into_the_session() {
    let home = TempDir::new();
    let session = start_session(home.path());
    let (_running, mut link) = Running::start(home.path());
    let mut channel = converse(home.path(), &mut link, &Phone::new(), 1);
    let ws = &mut link;
    assert_eq!(
        channel.next(ws),
        json!({"type": "reset", "provider": null, "available": false, "truncated": false, "images": true, "rpc": false, "items": []})
    );
    assert_eq!(channel.next(ws), json!({"type": "status", "working": null}));

    let agent = Agent::new(home.path(), &session);
    let first = agent.history("premier.jsonl", &assistant_line("a1", "Salut"));
    agent.describe(&first, true);
    assert_eq!(
        channel.next(ws),
        reset(json!([assistant_item("a1", "Salut")]))
    );
    assert_eq!(channel.next(ws), json!({"type": "status", "working": true}));

    append(&first, &assistant_line("a2", "Je regarde"));
    let items = json!({"type": "items", "items": [assistant_item("a2", "Je regarde")]});
    assert_eq!(channel.next(ws), items);
    agent.describe(&first, false);
    assert_eq!(
        channel.next(ws),
        json!({"type": "status", "working": false})
    );

    let second = agent.history("second.jsonl", &assistant_line("b1", "Nouvelle session"));
    agent.describe(&second, false);
    assert_eq!(
        channel.next(ws),
        reset(json!([assistant_item("b1", "Nouvelle session")]))
    );

    input(ws, &mut channel, "depuis le téléphone\r");
    wait_received(&session, "depuis le téléphone");

    // Several MiB: the image crosses the relay in many chunks.
    let mut image = b"\x89PNG\r\n\x1a\n".to_vec();
    image.resize(3 << 20, 7);
    send_image(ws, &mut channel, 7, "image/png", &image);
    saved_image(ws, &mut channel, 7, &session, &image);
    send_image(ws, &mut channel, 8, "image/jpeg", &image[..64]);
    assert_eq!(channel.next(ws), json!({"type": "imageFailed", "id": 8}));

    input(ws, &mut channel, "\u{4}");
    assert_eq!(channel.next(ws), json!({"type": "ended"}));
    assert!(channel.closed_until(ws, Instant::now() + Duration::from_secs(5)));
}

#[test]
fn revoking_the_phone_cuts_its_conversation() {
    let home = TempDir::new();
    let session = start_session(home.path());
    let (_running, mut link) = Running::start(home.path());
    let phone = Phone::new();
    let mut channel = converse(home.path(), &mut link, &phone, 1);
    channel.next(&mut link);
    input(&mut link, &mut channel, "avant\r");
    wait_received(&session, "avant");
    let revoked = Instant::now();
    access::revoke(&files::remote_dir(home.path()), &phone.id()).unwrap();
    assert!(channel.closed_until(&mut link, revoked + Duration::from_secs(1)));
    assert!(sessions::running(&session.directory));
}
