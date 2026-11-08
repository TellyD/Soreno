use super::*;
use crate::testing::TempDir;
use std::ffi::CString;
use std::os::unix::{ffi::OsStrExt, net::UnixListener};

const LIVE_A: &str = "0123456789abcdef0123456789abcdef";
const LIVE_B: &str = "fedcba9876543210fedcba9876543210";
const CHAT: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

struct Fixture {
    temp: TempDir,
    sockets: Vec<UnixListener>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            temp: TempDir::new(),
            sockets: Vec::new(),
        }
    }

    fn roots(&self) -> [PathBuf; 2] {
        roots(self.temp.path())
    }

    fn session(&mut self, key: &str, pid: &str) -> PathBuf {
        self.launch(0, key, pid)
    }

    fn conversation(&mut self, key: &str, pid: &str) -> PathBuf {
        self.launch(1, key, pid)
    }

    fn launch(&mut self, root: usize, key: &str, pid: &str) -> PathBuf {
        let directory = self.roots()[root].join(key);
        fs::create_dir_all(&directory).unwrap();
        self.sockets
            .push(UnixListener::bind(directory.join("socket")).unwrap());
        fs::write(directory.join("pid"), pid).unwrap();
        directory
    }

    fn agent(&self, directory: &Path, metadata: &str) {
        let agent = self.temp.path().join(format!(
            "agent.{}",
            directory.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&agent).unwrap();
        fs::write(agent.join("metadata.json"), metadata).unwrap();
        fs::write(directory.join("agent"), format!("{}\n", agent.display())).unwrap();
    }
}

fn own_pid() -> String {
    format!("{} token\n", std::process::id())
}

fn launched_at(directory: &Path, seconds: libc::time_t) {
    let socket = CString::new(directory.join("socket").as_os_str().as_bytes()).unwrap();
    let time = libc::timespec {
        tv_sec: seconds,
        tv_nsec: 0,
    };
    let times = [time, time];
    let set = unsafe { libc::utimensat(libc::AT_FDCWD, socket.as_ptr(), times.as_ptr(), 0) };
    assert_eq!(set, 0);
}

#[test]
fn lists_only_live_sessions_newest_launch_first() {
    let mut fixture = Fixture::new();
    let a = fixture.session(LIVE_A, &own_pid());
    fs::write(a.join("label"), "Alpha · OMP 1\n").unwrap();
    launched_at(&a, 1_000);
    let b = fixture.session(LIVE_B, &own_pid());
    fs::write(b.join("label"), "Zeta\x1b[31m · Shell\n").unwrap();
    launched_at(&b, 2_000);
    let c = fixture.session("dddddddddddddddddddddddddddddddd", &own_pid());
    launched_at(&c, 2_000);
    let chat = fixture.conversation(CHAT, &own_pid());
    launched_at(&chat, 1_500);
    fixture.session("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2147483000 token\n");
    fixture.session("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "0 token\n");
    fixture.session("not-a-session", &own_pid());
    let no_socket = fixture.roots()[0].join("cccccccccccccccccccccccccccccccc");
    fs::create_dir_all(&no_socket).unwrap();
    fs::write(no_socket.join("pid"), own_pid()).unwrap();

    let roots = fixture.roots();
    let sessions = list(&roots);
    let keys: Vec<_> = sessions
        .iter()
        .map(|session| (session.key.as_str(), session.rpc))
        .collect();
    assert_eq!(
        keys,
        [
            ("dddddddddddddddddddddddddddddddd", false),
            (LIVE_B, false),
            (CHAT, true),
            (LIVE_A, false),
        ]
    );
    assert_eq!(sessions[1].label.as_deref(), Some("Zeta[31m · Shell"));
    assert_eq!(sessions[3].label.as_deref(), Some("Alpha · OMP 1"));
    assert_eq!(live(&roots, LIVE_A), Some(a));
    assert_eq!(live(&roots, CHAT), Some(chat));
    assert!(live(&roots, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").is_none());
    assert!(live(&roots, "../sessions").is_none());
}

#[test]
fn attached_follows_the_socket_execute_bit() {
    let mut fixture = Fixture::new();
    let directory = fixture.session(LIVE_A, &own_pid());
    let socket = directory.join("socket");
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(!list(&fixture.roots())[0].attached);
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(list(&fixture.roots())[0].attached);
}

#[test]
fn reads_agent_metadata_tolerantly() {
    let mut fixture = Fixture::new();
    let a = fixture.session(LIVE_A, &own_pid());
    fixture.agent(
        &a,
        r#"{"version":1,"provider":"omp","name":"Suivre les sessions","working":true,"extra":[1]}"#,
    );
    let b = fixture.session(LIVE_B, &own_pid());
    fixture.agent(&b, r#"{"provider":3,"name":null,"working":"yes"}"#);
    // Chat sessions keep their metadata inline, without an `agent` pointer.
    let chat = fixture.conversation(CHAT, &own_pid());
    fs::write(
        chat.join("metadata.json"),
        r#"{"version":1,"provider":"omp","name":"Discussion","working":false}"#,
    )
    .unwrap();

    let sessions = list(&fixture.roots());
    let find = |key: &str| sessions.iter().find(|session| session.key == key).unwrap();
    let a = find(LIVE_A);
    assert_eq!(a.provider.as_deref(), Some("omp"));
    assert_eq!(a.name.as_deref(), Some("Suivre les sessions"));
    assert_eq!(a.working, Some(true));
    let b = find(LIVE_B);
    assert_eq!((&b.provider, &b.name, b.working), (&None, &None, None));
    let chat = find(CHAT);
    assert_eq!(
        (
            chat.provider.as_deref(),
            chat.name.as_deref(),
            chat.working,
            chat.rpc
        ),
        (Some("omp"), Some("Discussion"), Some(false), true)
    );
}

#[test]
fn missing_or_broken_metadata_leaves_fields_empty() {
    let mut fixture = Fixture::new();
    fixture.session(LIVE_A, &own_pid());
    let b = fixture.session(LIVE_B, &own_pid());
    fixture.agent(&b, "{pas du json");

    for session in list(&fixture.roots()) {
        assert_eq!(session.label, None);
        assert_eq!(
            (session.provider, session.name, session.working),
            (None, None, None)
        );
    }
}

#[test]
fn a_question_left_unanswered_awaits_a_reply_even_while_the_agent_works() {
    use std::io::Write;
    let mut fixture = Fixture::new();
    let a = fixture.session(LIVE_A, &own_pid());
    let history = fixture.temp.path().join("omp.jsonl");
    let line = |value: serde_json::Value| format!("{value}\n");
    let call = |id: &str, name: &str| {
        line(
            serde_json::json!({"type": "message", "id": format!("m{id}"), "message": {
                "role": "assistant",
                "content": [{"type": "toolCall", "id": id, "name": name, "arguments": {}}],
            }}),
        )
    };
    let result = |id: &str| {
        line(
            serde_json::json!({"type": "message", "id": format!("r{id}"), "message": {
                "role": "toolResult", "toolCallId": id, "content": "ok",
            }}),
        )
    };
    let describe = |working: bool| {
        fixture.agent(
            &a,
            &serde_json::json!({"provider": "omp", "sessionFile": history, "working": working})
                .to_string(),
        )
    };
    let append = |text: String| {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&history)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap()
    };
    let awaiting = || list(&fixture.roots())[0].awaiting;

    describe(true);
    append(call("b", "bash") + &call("q", "ask") + &result("b"));
    assert!(awaiting());
    append(result("q"));
    assert!(!awaiting());
    append(call("c", "bash"));
    assert!(!awaiting());
    describe(false);
    assert!(awaiting());
}
