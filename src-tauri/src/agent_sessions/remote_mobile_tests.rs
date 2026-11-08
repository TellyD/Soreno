use super::*;
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

const TEST_RELAY: Relay = Relay {
    link: "ws://relay.test:8790",
    key: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE",
};
const SERVER: &str = "c2VydmVyLXB1YmxpYy1rZXktZm9yLXRoZS10ZXN0cyE";
const SECRET: &str = "c2VjcmV0LWZvci1wYWlyaW5nLXRoZS1waG9uZS0xMjM";
const LEGACY_PORT: &str = "41234";
const LEGACY_TARGET: &str = "http://127.0.0.1:41234";
const FOREIGN_TARGET: &str = "http://127.0.0.1:3000";
// Real tools the scripts rely on; everything else (`tailscale` included) is faked or absent.
const TOOLS: &[&str] = &[
    "awk", "cat", "chmod", "date", "grep", "head", "id", "mkdir", "mv", "rm", "sed", "sleep",
];
// The scripts accept either hashing tool (macOS only has `shasum`) and run without `timeout`.
const HASH_TOOLS: &[&str] = &["sha256sum", "shasum"];
const OPTIONAL_TOOLS: &[&str] = &["setsid", "timeout", "flock"];
const UNAME: &str = "#!/bin/sh\ncase \"$1\" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n";
// `$FAKE/exe` stands for `/proc/<MainPID>/exe`: present while the service runs. A started service
// reports itself connected to the relay unless `$FAKE/offline` exists.
const SYSTEMCTL: &str = r#"#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$FAKE/log"
start() {
  exe=$(sed -n 's/^ExecStart=%h\([^ ]*\) .*/\1/p' "$HOME/.config/systemd/user/soreno-remote.service")
  dir=$(cd "$HOME${exe%/*}" && pwd -P) && printf '%s/soreno-remote' "$dir" > "$FAKE/exe"
  [ -e "$FAKE/offline" ] || printf '{"version":4,"server":"%s","host":"devbox","relay":"ws://relay.test:8790","connected":true,"connectedAt":1,"updatedAt":%s000}' "$(cat "$FAKE/server")" "$(date +%s)" > "$HOME/.cache/soreno/remote/state.json"
}
case "$*" in
  "--user show -p Version") echo Version=255 ;;
  *daemon-reload*) ;;
  *"disable --now"*) [ ! -e "$FAKE/stop-fails" ] || exit 1; rm -f "$FAKE/exe" ;;
  *"enable --now"*) [ -e "$FAKE/exe" ] || start ;;
  *restart*) start ;;
  *"show -p MainPID"*) if [ -e "$FAKE/exe" ]; then echo MainPID=4242; else echo MainPID=0; fi ;;
  *is-active*) if [ -e "$FAKE/exe" ]; then echo active; else echo inactive; exit 3; fi ;;
esac
"#;
// `$FAKE/proc-<pid>` stands for `/proc/<pid>/exe` of a standalone service.
const READLINK: &str = r#"#!/bin/sh
case "$*" in
  /proc/4242/exe) cat "$FAKE/exe" ;;
  /proc/*/exe) pid=${1#/proc/}; cat "$FAKE/proc-${pid%/exe}" 2>/dev/null || exit 1 ;;
  *) exit 1 ;;
esac
"#;
// The `systemctl` of devcontainer images when systemd is not PID 1.
const SYSTEMCTL_SHIM: &str =
    "#!/bin/sh\necho '\"systemd\" is not running in this container due to its overhead.'\n";
// Like logind without polkit, `enable-linger` is refused under `$FAKE/linger-denied`, even when
// `$FAKE/lingering` says an administrator already enabled it.
const LOGINCTL: &str = r#"#!/bin/sh
printf 'loginctl %s\n' "$*" >> "$FAKE/log"
case "$1" in
  show-user) if [ -e "$FAKE/lingering" ]; then echo Linger=yes; else echo Linger=no; fi ;;
  enable-linger) [ ! -e "$FAKE/linger-denied" ] || exit 1; : > "$FAKE/lingering" ;;
esac
"#;
// `$FAKE/web-<port>` holds the proxy target published on `devbox…:<port>`.
const TAILSCALE: &str = r#"#!/bin/sh
printf 'tailscale %s\n' "$*" >> "$FAKE/log"
case "$*" in
  "serve status --json")
    [ ! -e "$FAKE/serve-broken" ] || exit 1
    set -- "$FAKE"/web-*
    if [ ! -e "$1" ]; then printf '{}\n'; exit 0; fi
    printf '{"Web":{'
    sep=
    for f in "$FAKE"/web-*; do
      printf '%s"devbox.example.ts.net:%s":{"Handlers":{"/":{"Proxy":"%s"}}}' "$sep" "${f##*-}" "$(cat "$f")"
      sep=,
    done
    printf '}}' ;;
  *" --set-path=/ off")
    [ ! -e "$FAKE/serve-broken" ] || exit 1
    rm -f "$FAKE/web-${2#*=}" ;;
esac
"#;

struct Sandbox {
    root: PathBuf,
    home: PathBuf,
    fake: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "soreno-remote-mobile-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let fake = root.join("fake");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(fake.join("bin")).unwrap();
        std::fs::create_dir_all(fake.join("sys")).unwrap();
        // Stands for `/run/systemd/system`: systemd is the init unless a test removes it.
        std::fs::create_dir_all(fake.join("systemd-run")).unwrap();
        for (name, script) in [
            ("uname", UNAME),
            ("systemctl", SYSTEMCTL),
            ("loginctl", LOGINCTL),
            ("readlink", READLINK),
            ("tailscale", TAILSCALE),
        ] {
            let path = fake.join("bin").join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let system_tool = |tool: &str| {
            ["/usr/bin", "/bin"]
                .iter()
                .map(|dir| Path::new(dir).join(tool))
                .find(|path| path.exists())
                .map(|path| (tool.to_owned(), path))
        };
        let hash_tool = HASH_TOOLS
            .iter()
            .find_map(|tool| system_tool(tool))
            .expect("sha256sum or shasum is required by the tests");
        let required = TOOLS.iter().map(|tool| {
            system_tool(tool).unwrap_or_else(|| panic!("{tool} is required by the tests"))
        });
        let optional = OPTIONAL_TOOLS.iter().filter_map(|tool| system_tool(tool));
        for (tool, found) in required.chain([hash_tool]).chain(optional) {
            std::os::unix::fs::symlink(found, fake.join("sys").join(tool)).unwrap();
        }
        std::fs::write(fake.join("server"), SERVER).unwrap();
        Self { root, home, fake }
    }

    fn run(&self, script: &str, input: Option<&[u8]>) -> Output {
        let script = script.replace(
            "/run/systemd/system",
            &self.fake.join("systemd-run").display().to_string(),
        );
        let mut child = Command::new("/bin/sh")
            .args(["-c", &script])
            .env_clear()
            .env("HOME", &self.home)
            .env("FAKE", &self.fake)
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    self.fake.join("bin").display(),
                    self.fake.join("sys").display()
                ),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        if let Some(input) = input {
            stdin.write_all(input).unwrap();
        }
        drop(stdin);
        child.wait_with_output().unwrap()
    }

    fn succeed(&self, script: &str, input: Option<&[u8]>) -> Vec<u8> {
        let output = self.run(script, input);
        assert!(
            output.status.success(),
            "{:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    // Mirrors `probe`.
    fn probe(&self, hash: &str) -> Result<Probe> {
        let output = self.run(&status_script(hash, "0"), None);
        match output.status.code() {
            Some(0) => parse_status(&output.stdout, TEST_RELAY),
            code => Err(failure(code.unwrap_or(255) as u8, &output.stderr)),
        }
    }

    fn status(&self, hash: &str) -> Probe {
        self.probe(hash).unwrap()
    }

    // Mirrors `enable`.
    fn enable(&self, bytes: &[u8], hash: &str) -> Output {
        let probe = self.status(hash);
        if !probe.binary_current {
            self.succeed(&install_script(hash), Some(bytes));
        }
        self.run(
            &activation_script(hash, TEST_RELAY, probe.https, probe.link),
            None,
        )
    }

    fn enabled(&self, bytes: &[u8], hash: &str) {
        let output = self.enable(bytes, hash);
        assert!(
            output.status.success(),
            "{:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    // Mirrors `disable`.
    fn disable(&self, hash: &str) -> Output {
        let (https, link) = self
            .probe(hash)
            .map_or((Publication::Absent, Publication::Absent), |probe| {
                (probe.https, probe.link)
            });
        self.run(&disable_script(https, link), None)
    }

    // A running Tailscale-era installation publishing its port on 8443 and 8444.
    fn install_legacy(&self) -> PathBuf {
        let (bytes, hash) = fake_binary(0);
        self.succeed(&install_script(&hash), Some(&bytes));
        std::fs::write(self.remote().join("role"), "principal 1759680012345\n").unwrap();
        std::fs::create_dir_all(self.unit().parent().unwrap()).unwrap();
        std::fs::write(
            self.unit(),
            format!(
                "[Unit]\nDescription=Soreno mobile access\n\n[Service]\nExecStart=%h/.cache/soreno/remote/{hash}/soreno-remote serve --listen 127.0.0.1:{LEGACY_PORT}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n"
            ),
        )
        .unwrap();
        std::fs::write(self.fake.join("offline"), "").unwrap();
        self.succeed("systemctl --user restart soreno-remote.service", None);
        std::fs::remove_file(self.fake.join("offline")).unwrap();
        self.set_web("8443", LEGACY_TARGET);
        self.set_web("8444", LEGACY_TARGET);
        self.take_log();
        self.remote().join(hash)
    }

    fn web(&self, port: &str) -> Option<String> {
        std::fs::read_to_string(self.fake.join(format!("web-{port}"))).ok()
    }

    fn set_web(&self, port: &str, proxy: &str) {
        std::fs::write(self.fake.join(format!("web-{port}")), proxy).unwrap();
    }

    fn take_log(&self) -> String {
        let log = std::fs::read_to_string(self.fake.join("log")).unwrap_or_default();
        let _ = std::fs::remove_file(self.fake.join("log"));
        log
    }

    fn remote(&self) -> PathBuf {
        self.home.join(".cache/soreno/remote")
    }

    fn unit(&self) -> PathBuf {
        self.home.join(".config/systemd/user/soreno-remote.service")
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fake_binary(version: u8) -> (Vec<u8>, String) {
    let bytes = format!(
        r#"#!/bin/sh
printf 'soreno-remote %s\n' "$*" >> "$FAKE/log"
case "$1" in
  access) [ ! -e "$FAKE/access-fails" ] || exit 1
    printf '{{"server":"%s","devices":[{{"id":"0123456789abcdef","label":"iPhone · Safari","pairedAt":1,"lastSeenAt":null}}],"pairings":[{{"id":"fedcba9876543210","expiresAt":2}}],"used":["0011223344556677"]}}' "$(cat "$FAKE/server")" ;;
  pair) [ ! -e "$FAKE/pair-fails" ] || {{ echo 'trop de codes en attente' >&2; exit 1; }}
    printf '{{"server":"%s","id":"fedcba9876543210","secret":"{SECRET}","expiresAt":1759680612345,"expiresInMs":540000}}\n' "$(cat "$FAKE/server")" ;;
  revoke) ;;
  serve) [ ! -e "$FAKE/serve-dies" ] || exit 1
    printf '%s/soreno-remote' "$(cd "${{0%/*}}" && pwd -P)" > "$FAKE/proc-$$"
    [ -e "$FAKE/offline" ] || printf '{{"version":4,"server":"%s","host":"devbox","relay":"%s","connected":true,"connectedAt":1,"updatedAt":%s000}}' "$(cat "$FAKE/server")" "$3" "$(date +%s)" > "$HOME/.cache/soreno/remote/state.json"
    trap 'rm -f "$FAKE/proc-$$"; exit 0' TERM
    while [ -d "$FAKE" ]; do sleep 0.1; done ;;
  *) echo soreno-remote {version} ;;
esac
"#
    )
    .into_bytes();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    (bytes, hash)
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn status_output(fields: &str, serve: &str, state: &str, access: &str) -> Vec<u8> {
    format!("{fields}\0{serve}\0{state}\0{access}").into_bytes()
}

#[test]
fn embedded_binaries_cover_supported_linux_targets() {
    for platform in ["Linux/x86_64", "Linux/aarch64"] {
        let binary = embedded(platform).unwrap();
        assert!(!binary.bytes.is_empty());
    }
    assert!(embedded("Darwin/arm64").is_none());
}

#[test]
fn enabling_installs_privately_links_to_the_relay_and_never_touches_tailscale() {
    let sandbox = Sandbox::new("enable");
    let (bytes, hash) = fake_binary(1);
    let before = sandbox.status(&hash);
    assert!(!before.binary_current);
    assert!(!before.status.installed && !before.status.legacy && !before.status.connected);

    sandbox.enabled(&bytes, &hash);
    let binary = sandbox.remote().join(&hash).join("soreno-remote");
    assert_eq!(std::fs::read(&binary).unwrap(), bytes);
    assert_eq!(mode(&binary), 0o700);
    assert_eq!(mode(&sandbox.remote()), 0o700);
    let unit_text = std::fs::read_to_string(sandbox.unit()).unwrap();
    assert_eq!(unit_text, format!("{}\n", unit(&hash, TEST_RELAY)));
    assert!(unit_text.contains(&format!(
        "ExecStart=%h/.cache/soreno/remote/{hash}/soreno-remote serve --relay ws://relay.test:8790 --relay-key {}\n",
        TEST_RELAY.key
    )));
    let log = sandbox.take_log();
    assert!(log.contains("loginctl enable-linger\n"), "{log}");
    assert!(log.contains("systemctl --user daemon-reload\n"), "{log}");
    assert!(
        log.contains("systemctl --user restart soreno-remote.service\n"),
        "{log}"
    );
    assert!(!log.contains("tailscale"), "{log}");

    let probe = sandbox.status(&hash);
    assert!(probe.binary_current);
    assert_eq!(
        probe.status,
        SshMobileStatus {
            platform: "Linux/x86_64".into(),
            supported: true,
            installed: true,
            up_to_date: true,
            active: true,
            legacy: false,
            connected: true,
            state_fresh: true,
            host: Some("devbox".into()),
            server: Some(SERVER.into()),
            devices: Some(vec![SshMobileDevice {
                id: "0123456789abcdef".into(),
                label: "iPhone · Safari".into(),
                paired_at: 1,
                last_seen_at: None,
            }]),
            pairings: Some(vec!["fedcba9876543210".into()]),
            pairings_used: Some(vec!["0011223344556677".into()]),
        }
    );
    assert!(!sandbox.take_log().contains("tailscale"));

    std::fs::write(sandbox.fake.join("access-fails"), "").unwrap();
    let unread = sandbox.status(&hash).status;
    assert!(unread.installed && unread.up_to_date);
    assert_eq!(
        (unread.devices, unread.pairings, unread.pairings_used),
        (None, None, None)
    );
    std::fs::remove_file(sandbox.fake.join("access-fails")).unwrap();

    sandbox.enabled(&bytes, &hash);
    let log = sandbox.take_log();
    assert!(
        log.contains("systemctl --user enable --now soreno-remote.service\n"),
        "{log}"
    );
    assert!(!log.contains("restart"), "{log}");

    let (next_bytes, next_hash) = fake_binary(2);
    assert!(!sandbox.status(&next_hash).status.up_to_date);
    sandbox.enabled(&next_bytes, &next_hash);
    assert!(sandbox
        .take_log()
        .contains("systemctl --user restart soreno-remote.service\n"));
    assert!(!binary.exists());
    assert!(sandbox.status(&next_hash).status.up_to_date);
}

#[test]
fn updating_a_tailscale_installation_withdraws_its_publications_and_converts_the_unit() {
    let sandbox = Sandbox::new("legacy");
    let old = sandbox.install_legacy();
    sandbox.set_web("443", FOREIGN_TARGET);
    let (bytes, hash) = fake_binary(1);

    let before = sandbox.status(&hash);
    assert!(before.status.installed && before.status.legacy && !before.status.up_to_date);
    assert_eq!(
        (before.https, before.link),
        (Publication::Ours, Publication::Ours)
    );
    sandbox.take_log();

    sandbox.enabled(&bytes, &hash);
    let log = sandbox.take_log();
    assert!(
        log.contains("tailscale serve --https=8443 --set-path=/ off\n"),
        "{log}"
    );
    assert!(
        log.contains("tailscale serve --http=8444 --set-path=/ off\n"),
        "{log}"
    );
    assert!(
        log.contains("systemctl --user restart soreno-remote.service\n"),
        "{log}"
    );
    assert!(sandbox.web("8443").is_none() && sandbox.web("8444").is_none());
    assert_eq!(sandbox.web("443").as_deref(), Some(FOREIGN_TARGET));
    assert!(!sandbox.remote().join("role").exists());
    assert!(!old.exists());
    assert_eq!(
        std::fs::read_to_string(sandbox.unit()).unwrap(),
        format!("{}\n", unit(&hash, TEST_RELAY))
    );
    let status = sandbox.status(&hash).status;
    assert!(status.up_to_date && !status.legacy && status.connected);
    assert!(!sandbox.take_log().contains("tailscale"));
}

#[test]
fn updating_a_tailscale_installation_never_blocks_on_tailscale() {
    for (name, setup) in [
        ("absent", "rm -f \"$FAKE/bin/tailscale\""),
        ("unreadable", ": > \"$FAKE/serve-broken\""),
    ] {
        let sandbox = Sandbox::new(&format!("legacy-{name}"));
        sandbox.install_legacy();
        sandbox.succeed(setup, None);
        let (bytes, hash) = fake_binary(1);
        let before = sandbox.status(&hash);
        assert!(before.status.legacy, "{name}");

        sandbox.enabled(&bytes, &hash);
        assert!(!sandbox.take_log().contains("off"), "{name}");
        assert!(!sandbox.remote().join("role").exists(), "{name}");
        assert_eq!(
            std::fs::read_to_string(sandbox.unit()).unwrap(),
            format!("{}\n", unit(&hash, TEST_RELAY)),
            "{name}"
        );
        assert!(sandbox.status(&hash).status.up_to_date, "{name}");
    }
}

#[test]
fn a_foreign_legacy_publication_is_left_in_place() {
    let sandbox = Sandbox::new("legacy-foreign");
    sandbox.install_legacy();
    sandbox.set_web("8444", FOREIGN_TARGET);
    let (bytes, hash) = fake_binary(1);
    sandbox.enabled(&bytes, &hash);
    let log = sandbox.take_log();
    assert!(log.contains("--https=8443 --set-path=/ off"), "{log}");
    assert!(!log.contains("--http=8444"), "{log}");
    assert_eq!(sandbox.web("8444").as_deref(), Some(FOREIGN_TARGET));
}

#[test]
fn an_unreachable_user_bus_leaves_a_tailscale_installation_published() {
    let sandbox = Sandbox::new("legacy-no-bus");
    sandbox.install_legacy();
    std::fs::write(sandbox.fake.join("bin/systemctl"), SYSTEMCTL_SHIM).unwrap();
    let (bytes, hash) = fake_binary(1);
    assert_eq!(sandbox.enable(&bytes, &hash).status.code(), Some(31));
    assert_eq!(sandbox.web("8443").as_deref(), Some(LEGACY_TARGET));
    assert_eq!(sandbox.web("8444").as_deref(), Some(LEGACY_TARGET));
    assert!(sandbox.remote().join("role").exists());
}

#[test]
fn disabling_removes_the_service_its_files_and_any_legacy_publication() {
    let sandbox = Sandbox::new("disable");
    let (bytes, hash) = fake_binary(1);
    sandbox.enabled(&bytes, &hash);
    sandbox.take_log();
    assert!(sandbox.disable(&hash).status.success());
    let log = sandbox.take_log();
    assert!(
        log.contains("systemctl --user disable --now soreno-remote.service\n"),
        "{log}"
    );
    assert!(!log.contains("tailscale"), "{log}");
    assert!(!sandbox.unit().exists() && !sandbox.remote().exists());
    let status = sandbox.status(&hash).status;
    assert!(!status.installed && !status.active && !status.connected);
    assert!(sandbox.disable(&hash).status.success());

    sandbox.install_legacy();
    assert!(sandbox.disable(&hash).status.success());
    let log = sandbox.take_log();
    assert!(
        log.contains("tailscale serve --https=8443 --set-path=/ off\n"),
        "{log}"
    );
    assert!(
        log.contains("tailscale serve --http=8444 --set-path=/ off\n"),
        "{log}"
    );
    assert!(sandbox.web("8443").is_none() && sandbox.web("8444").is_none());
    assert!(!sandbox.unit().exists() && !sandbox.remote().exists());

    sandbox.install_legacy();
    std::fs::write(sandbox.fake.join("serve-broken"), "").unwrap();
    assert!(sandbox.disable(&hash).status.success());
    assert!(!sandbox.unit().exists() && !sandbox.remote().exists());
}

#[test]
fn disabling_keeps_the_files_when_systemd_cannot_stop_the_service() {
    let sandbox = Sandbox::new("stop-fails");
    let (bytes, hash) = fake_binary(1);
    sandbox.enabled(&bytes, &hash);
    std::fs::write(sandbox.fake.join("stop-fails"), "").unwrap();
    let output = sandbox.disable(&hash);
    assert_eq!(output.status.code(), Some(38));
    assert!(failure(38, b"").starts_with("[Mobile/stop] "));
    assert!(sandbox.unit().exists() && sandbox.remote().exists());
}

#[test]
fn activation_reports_installation_failures_with_codes() {
    let sandbox = Sandbox::new("failures");
    let (bytes, hash) = fake_binary(1);
    let output = sandbox.run(&install_script(&hash), Some(b"#!/bin/sh\nexit 0\n"));
    assert_eq!(output.status.code(), Some(23));
    assert!(!sandbox.remote().join(&hash).join("soreno-remote").exists());

    std::fs::write(sandbox.fake.join("bin/systemctl"), SYSTEMCTL_SHIM).unwrap();
    std::fs::create_dir_all(sandbox.unit().parent().unwrap()).unwrap();
    std::fs::write(sandbox.unit(), "[Service]\nExecStart=%h/old serve\n").unwrap();
    assert_eq!(sandbox.enable(&bytes, &hash).status.code(), Some(31));
    assert!(failure(31, b"").starts_with("[Mobile/systemd] "));
    assert!(sandbox.unit().exists());

    std::fs::remove_dir(sandbox.fake.join("systemd-run")).unwrap();
    std::fs::write(sandbox.fake.join("serve-dies"), "").unwrap();
    assert_eq!(sandbox.enable(&bytes, &hash).status.code(), Some(41));
    assert!(failure(41, b"").starts_with("[Mobile/exited] "));
    assert!(failure(39, b"").starts_with("[Mobile/relay] "));
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..100 {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{what}");
}

#[test]
fn without_systemd_the_service_runs_detached_and_revives_before_a_session() {
    let sandbox = Sandbox::new("standalone");
    std::fs::remove_dir(sandbox.fake.join("systemd-run")).unwrap();
    std::fs::write(sandbox.fake.join("bin/systemctl"), SYSTEMCTL_SHIM).unwrap();
    // Left by an activation that stopped at `loginctl` before systemd was detected properly.
    std::fs::create_dir_all(sandbox.unit().parent().unwrap()).unwrap();
    std::fs::write(sandbox.unit(), "[Service]\nExecStart=%h/old serve\n").unwrap();
    let (bytes, hash) = fake_binary(1);
    let before = sandbox.status(&hash).status;
    assert!(before.installed && !before.active && !before.up_to_date);

    sandbox.enabled(&bytes, &hash);
    assert!(!sandbox.unit().exists());
    assert_eq!(
        std::fs::read_to_string(sandbox.remote().join("standalone")).unwrap(),
        format!("{}\n", exec_start(&hash, TEST_RELAY))
    );
    let serve = format!(
        "soreno-remote serve --relay {} --relay-key {}\n",
        TEST_RELAY.link, TEST_RELAY.key
    );
    let log = sandbox.take_log();
    assert!(log.contains(&serve), "{log}");
    assert!(!log.contains("loginctl"), "{log}");
    let status = sandbox.status(&hash).status;
    assert!(status.installed && status.up_to_date && status.active && status.connected);

    let pid = || std::fs::read_to_string(sandbox.remote().join("pid")).unwrap();
    let first = pid();
    sandbox.enabled(&bytes, &hash);
    assert_eq!(pid(), first);
    assert!(!sandbox.take_log().contains(&serve));

    sandbox.succeed("kill \"$(cat \"$HOME/.cache/soreno/remote/pid\")\"", None);
    let gone = sandbox.fake.join(format!("proc-{}", first.trim()));
    wait_until("the service stops", || !gone.exists());
    assert!(!sandbox.status(&hash).status.active);
    sandbox.succeed(&revive_script(), None);
    wait_until("the service revives", || {
        sandbox.status(&hash).status.active
    });
    assert_ne!(pid(), first);
    assert!(sandbox.take_log().contains(&serve));
    sandbox.succeed(&revive_script(), None);
    assert!(!sandbox.take_log().contains(&serve));

    let (next_bytes, next_hash) = fake_binary(2);
    assert!(!sandbox.status(&next_hash).status.up_to_date);
    let old = pid();
    sandbox.enabled(&next_bytes, &next_hash);
    assert!(!sandbox.fake.join(format!("proc-{}", old.trim())).exists());
    assert!(!sandbox.remote().join(&hash).exists());
    let updated = sandbox.status(&next_hash).status;
    assert!(updated.up_to_date && updated.active && updated.connected);

    let last = pid();
    let output = sandbox.disable(&next_hash);
    assert!(output.status.success(), "{output:?}");
    assert!(!sandbox.fake.join(format!("proc-{}", last.trim())).exists());
    assert!(!sandbox.remote().exists());
    sandbox.succeed(&revive_script(), None);
    assert!(!sandbox.remote().exists());
}

#[test]
fn activation_needs_linger_but_accepts_one_enabled_by_an_administrator() {
    let sandbox = Sandbox::new("linger");
    let (bytes, hash) = fake_binary(1);
    std::fs::write(sandbox.fake.join("linger-denied"), "").unwrap();
    assert_eq!(sandbox.enable(&bytes, &hash).status.code(), Some(33));
    assert!(failure(33, b"").starts_with("[Mobile/linger] "));
    assert!(!sandbox.remote().join("state.json").exists());
    sandbox.take_log();

    std::fs::write(sandbox.fake.join("lingering"), "").unwrap();
    sandbox.enabled(&bytes, &hash);
    let log = sandbox.take_log();
    assert!(!log.contains("enable-linger"), "{log}");
    assert!(sandbox.status(&hash).status.connected);
}

#[test]
fn status_reads_legacy_freshness_devices_and_currency() {
    let hash = "abc";
    let current_unit = exec_start(hash, TEST_RELAY);
    let fields = |unit: &str, extra: &str| {
        format!("platform=Linux/x86_64\nhash={hash}\nnow=1000\nbinary=current\nactive=active\nrunning=current\nunit={unit}\n{extra}")
    };
    let state = |version: u64, connected: bool, updated: u64| {
        format!(
            r#"{{"version":{version},"server":"{SERVER}","host":"devbox","relay":"ws://relay.test:8790","connected":{connected},"connectedAt":1,"updatedAt":{updated}}}"#
        )
    };
    let access = r#"{"server":"from-access","devices":[{"id":"0123456789abcdef","label":"Android · Chrome","pairedAt":5,"lastSeenAt":7}],"pairings":[]}"#;

    let probe = parse_status(
        &status_output(
            &fields(&current_unit, ""),
            "",
            &state(4, true, 990_000),
            access,
        ),
        TEST_RELAY,
    )
    .unwrap();
    let status = probe.status;
    assert!(status.up_to_date && status.connected && status.state_fresh && !status.legacy);
    assert_eq!(status.server.as_deref(), Some("from-access"));
    assert_eq!(status.host.as_deref(), Some("devbox"));
    assert_eq!(status.devices.unwrap()[0].last_seen_at, Some(7));
    assert_eq!(status.pairings, Some(Vec::new()));
    // An older binary lists no spent pairings.
    assert_eq!(status.pairings_used, Some(Vec::new()));
    assert_eq!(
        (probe.https, probe.link),
        (Publication::Absent, Publication::Absent)
    );

    let stale = parse_status(
        &status_output(&fields(&current_unit, ""), "", &state(4, true, 960_000), ""),
        TEST_RELAY,
    )
    .unwrap()
    .status;
    assert!(!stale.connected && !stale.state_fresh);
    assert_eq!(stale.server.as_deref(), Some(SERVER));
    assert_eq!((stale.devices, stale.pairings), (None, None));

    let invalid = parse_status(
        &status_output(&fields(&current_unit, ""), "", "", r#"{"devices":"#),
        TEST_RELAY,
    )
    .unwrap()
    .status;
    assert_eq!(
        (invalid.devices, invalid.pairings, invalid.pairings_used),
        (None, None, None)
    );

    let not_current = parse_status(
        &status_output(
            &fields(&current_unit, "").replace("binary=current\n", ""),
            "",
            "",
            access,
        ),
        TEST_RELAY,
    )
    .unwrap()
    .status;
    assert_eq!(
        (
            not_current.devices,
            not_current.pairings,
            not_current.pairings_used
        ),
        (Some(Vec::new()), Some(Vec::new()), Some(Vec::new()))
    );

    let old_version = parse_status(
        &status_output(&fields(&current_unit, ""), "", &state(3, true, 999_000), ""),
        TEST_RELAY,
    )
    .unwrap()
    .status;
    assert!(!old_version.connected && !old_version.state_fresh && old_version.host.is_none());

    let other_relay = parse_status(
        &status_output(
            &fields(&exec_start(hash, RELAY), ""),
            "",
            &state(4, false, 999_000),
            "",
        ),
        TEST_RELAY,
    )
    .unwrap()
    .status;
    assert!(!other_relay.up_to_date && !other_relay.connected && other_relay.state_fresh);

    let stale_process = parse_status(
        &status_output(
            &fields(&current_unit, "").replace("running=current\n", ""),
            "",
            "",
            "",
        ),
        TEST_RELAY,
    )
    .unwrap()
    .status;
    assert!(!stale_process.up_to_date);

    let legacy_unit =
        format!("%h/.cache/soreno/remote/old/soreno-remote serve --listen 127.0.0.1:{LEGACY_PORT}");
    let serve = format!(
        r#"{{"Web":{{"devbox.ts.net:8443":{{"Handlers":{{"/":{{"Proxy":"{LEGACY_TARGET}"}}}}}},"devbox.ts.net:8444":{{"Handlers":{{"/":{{"Proxy":"{FOREIGN_TARGET}"}}}}}}}}}}"#
    );
    let legacy = parse_status(
        &status_output(&fields(&legacy_unit, "serve=read\n"), &serve, "", ""),
        TEST_RELAY,
    )
    .unwrap();
    assert!(legacy.status.legacy && legacy.status.installed && !legacy.status.up_to_date);
    assert_eq!(
        (legacy.https, legacy.link),
        (Publication::Ours, Publication::Foreign)
    );
    let unread = parse_status(
        &status_output(&fields(&legacy_unit, ""), &serve, "", ""),
        TEST_RELAY,
    )
    .unwrap();
    assert_eq!(
        (unread.https, unread.link),
        (Publication::Unknown, Publication::Unknown)
    );

    let unsupported = parse_status(
        &status_output("platform=Darwin/arm64\nhash=\nnow=1\n", "", "", ""),
        TEST_RELAY,
    )
    .unwrap()
    .status;
    assert!(!unsupported.supported && !unsupported.installed);
    assert!(require_supported(&unsupported).is_err());
    assert!(parse_status(b"", TEST_RELAY).is_err());
}

#[test]
fn pairing_builds_the_relay_link_and_its_qr_code() {
    let sandbox = Sandbox::new("pair");
    let (bytes, hash) = fake_binary(1);
    let missing = sandbox.run(&pair_script(&hash, "0"), None);
    assert_eq!(missing.status.code(), Some(30));

    sandbox.enabled(&bytes, &hash);
    let output = sandbox.succeed(&pair_script(&hash, "0"), None);
    // The server's clock is hours behind: only the time left counts.
    let received = 1_759_700_000_000;
    let created = pairing(&output, "https://relay.test", received).unwrap();
    assert_eq!(created.id, "fedcba9876543210");
    assert_eq!(created.expires_at, received + 540_000);
    assert_eq!(
        created.url,
        format!("https://relay.test/#p={SERVER}.{SECRET}")
    );
    assert!(created.qr_svg.contains("<svg"));
    let longer = format!(
        r#"{{"server":"{SERVER}","id":"fedcba9876543210","secret":"{SECRET}","expiresAt":1,"expiresInMs":86400000}}"#
    );
    assert_eq!(
        pairing(longer.as_bytes(), "https://relay.test", received)
            .unwrap()
            .expires_at,
        received + PAIRING_LIFETIME_MS
    );

    std::fs::write(sandbox.fake.join("pair-fails"), "").unwrap();
    let failed = sandbox.run(&pair_script(&hash, "0"), None);
    assert_eq!(failed.status.code(), Some(50));
    assert_eq!(
        failure(50, &failed.stderr),
        "[Mobile/pairing] soreno-remote n’a pas pu créer de code d’appairage :\ntrop de codes en attente"
    );
    for garbage in [
        "not json".to_owned(),
        format!(
            r#"{{"server":"short","id":"fedcba9876543210","secret":"{SECRET}","expiresInMs":1}}"#
        ),
        format!(
            r#"{{"server":"{SERVER}","id":"FEDCBA9876543210","secret":"{SECRET}","expiresInMs":1}}"#
        ),
        format!(r#"{{"server":"{SERVER}","id":"fedcba9876543210","secret":"{SECRET}"}}"#),
    ] {
        assert!(
            pairing(garbage.as_bytes(), "https://relay.test", received).is_err(),
            "{garbage}"
        );
    }
}

#[test]
fn revoking_validates_the_device_id_before_any_ssh() {
    let unreachable = SshConnection {
        host: "invalid.invalid".into(),
        user: None,
        port: Some(1),
        identity_file: None,
        host_key: None,
    };
    for device in [
        "",
        "0123456789abcde",
        "0123456789ABCDEF",
        "0123456789abcdef0",
        "../../../etc/x",
        "0123456789abcde;",
    ] {
        assert_eq!(
            revoke(&unreachable, device).unwrap_err(),
            "[Mobile/revoke] Identifiant d’appareil invalide.",
            "{device}"
        );
    }

    let sandbox = Sandbox::new("revoke");
    let (bytes, hash) = fake_binary(1);
    sandbox.enabled(&bytes, &hash);
    sandbox.take_log();
    sandbox.succeed(&revoke_script(&hash, "0", "0123456789abcdef"), None);
    assert!(sandbox
        .take_log()
        .contains("soreno-remote revoke 0123456789abcdef\n"));
}
