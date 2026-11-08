use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn version_checks_use_semver_precedence_and_reject_unknown_versions() {
    for (installed, latest, expected) in [
        ("codex-cli 0.9.0", "0.10.0", UpdateStatus::Available),
        ("codex-cli 0.10.0", "0.10.0", UpdateStatus::UpToDate),
        ("0.11.0", "0.10.0", UpdateStatus::UpToDate),
        ("0.10.0-alpha.1", "0.10.0", UpdateStatus::Available),
        ("0.10.0", "0.10.0-alpha.1", UpdateStatus::UpToDate),
        ("0.10.0-alpha.2", "0.10.0-alpha.10", UpdateStatus::Available),
        ("0.10.0+local", "0.10.0+remote", UpdateStatus::UpToDate),
    ] {
        let installed = parse_installed_version(installed).unwrap();
        let result = compare_versions(&installed, latest).unwrap();
        assert_eq!(result.status, expected);
        assert_eq!(result.latest_version.as_deref(), Some(latest));
    }
    for invalid in [
        "",
        "unknown",
        "0.10",
        "v0.10.0",
        "codex 0.10.0",
        "codex-cli0.10.0",
    ] {
        assert!(parse_installed_version(invalid).is_err(), "{invalid}");
        assert!(compare_versions(&semver::Version::new(0, 10, 0), invalid).is_err());
    }
    for (status, expected, latest_version) in [
        (
            UpdateStatus::Available,
            "available",
            Some("0.10.0".to_string()),
        ),
        (
            UpdateStatus::UpToDate,
            "upToDate",
            Some("0.10.0".to_string()),
        ),
        (UpdateStatus::Unsupported, "unsupported", None),
    ] {
        let result = CodexUpdateStatus {
            status,
            latest_version: latest_version.clone(),
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({ "status": expected, "latestVersion": latest_version }),
        );
    }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
                    "soreno-codex-update-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                )))
    }
    fn file(&self, path: &str, content: &str) -> PathBuf {
        let path = self.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn npm_arguments_remove_only_windows_disk_and_unc_namespaces() {
    for (input, expected) in [
        (
            r"\\?\C:\Program Files\nodejs\npm-cli.js",
            r"C:\Program Files\nodejs\npm-cli.js",
        ),
        (
            r"\\?\D:\Users\Léa\AppData\Roaming\npm",
            r"D:\Users\Léa\AppData\Roaming\npm",
        ),
        (
            r"\\?\UNC\server\shared folder\npm",
            r"\\server\shared folder\npm",
        ),
        (
            r"C:\Program Files\nodejs\npm-cli.js",
            r"C:\Program Files\nodejs\npm-cli.js",
        ),
        (r"\\server\share\npm", r"\\server\share\npm"),
        (r"\\?\Volume{abc}\npm", r"\\?\Volume{abc}\npm"),
        (r"\\.\C:\npm", r"\\.\C:\npm"),
    ] {
        assert_eq!(
            npm_path_argument(Path::new(input), "windows"),
            Path::new(expected)
        );
        for os in ["macos", "linux"] {
            assert_eq!(npm_path_argument(Path::new(input), os), Path::new(input));
        }
    }
}

#[test]
fn windows_npm_uses_exact_prefix_and_separate_node_installation() {
    let fixture = Fixture::new();
    fixture.file(
        "Roaming/npm/node_modules/@openai/codex/package.json",
        r#"{"name":"@openai/codex"}"#,
    );
    fixture.file("Roaming/npm/node_modules/@openai/codex/bin/codex.js", "");
    let launcher = fixture.file(
        "Roaming/npm/codex.cmd",
        r#""%dp0%\node_modules\@openai\codex\bin\codex.js""#,
    );
    let node = fixture.file("Program Files/nodejs/node.exe", "");
    let npm = fixture.file("Program Files/nodejs/node_modules/npm/bin/npm-cli.js", "");
    fixture.file(
        "Program Files/nodejs/node_modules/npm/package.json",
        r#"{"name":"npm"}"#,
    );
    let (command, source) = update_command(&launcher, "windows", &node).unwrap();
    assert_eq!(source, UpdateSource::Npm);
    assert_eq!(command.get_program(), node.as_os_str());
    let args = command
        .get_args()
        .map(|arg| arg.to_os_string())
        .collect::<Vec<_>>();
    assert_eq!(
        args,
        vec![
            npm_path_argument(&std::fs::canonicalize(npm).unwrap(), "windows").into_os_string(),
            "install".into(),
            "--global".into(),
            "--prefix".into(),
            npm_path_argument(
                &std::fs::canonicalize(fixture.0.join("Roaming/npm")).unwrap(),
                "windows",
            )
            .into_os_string(),
            "@openai/codex@latest".into(),
            "--no-audit".into(),
            "--no-fund".into()
        ]
    );
    let local = fixture.file(
        "Roaming/npm/node_modules/.bin/codex.cmd",
        r#""%dp0%\..\@openai\codex\bin\codex.js""#,
    );
    assert!(update_command(&local, "windows", &node).is_none());
}

#[cfg(unix)]
#[test]
fn unix_npm_and_homebrew_detection_refuses_other_installations() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let script = fixture.file("prefix/lib/node_modules/@openai/codex/bin/codex.js", "");
    let manifest = fixture.file(
        "prefix/lib/node_modules/@openai/codex/package.json",
        r#"{"name":"@openai/codex"}"#,
    );
    let node = fixture.file("prefix/bin/node", "");
    let npm = fixture.file("prefix/lib/node_modules/npm/bin/npm-cli.js", "");
    fixture.file(
        "prefix/lib/node_modules/npm/package.json",
        r#"{"name":"npm"}"#,
    );
    symlink(&npm, fixture.0.join("prefix/bin/npm")).unwrap();
    let launcher = fixture.0.join("prefix/bin/codex");
    symlink(&script, &launcher).unwrap();
    for os in ["macos", "linux"] {
        let (command, source) = update_command(&launcher, os, &node).unwrap();
        assert_eq!(source, UpdateSource::Npm);
        assert_eq!(command.get_program(), node.as_os_str());
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(args[1..4], ["install", "--global", "--prefix"]);
        assert_eq!(
            args[4],
            std::fs::canonicalize(fixture.0.join("prefix"))
                .unwrap()
                .to_string_lossy()
        );
        assert_eq!(
            args[5..],
            ["@openai/codex@latest", "--no-audit", "--no-fund"]
        );
    }
    assert!(update_command(&script, "linux", &node).is_none());
    std::fs::write(manifest, r#"{"name":"other"}"#).unwrap();
    assert!(update_command(&launcher, "macos", &node).is_none());
    let manual = fixture.file("manual/codex", "native");
    assert!(update_command(&manual, "macos", &node).is_none());
    let brew = fixture.file("brew/bin/brew", "");
    let native = fixture.file("brew/Caskroom/codex/1.2/codex", "native");
    let launcher = fixture.0.join("brew/bin/codex");
    symlink(native, &launcher).unwrap();
    let (command, source) = update_command(&launcher, "macos", &node).unwrap();
    assert_eq!(source, UpdateSource::Homebrew);
    assert_eq!(
        command.get_program(),
        std::fs::canonicalize(brew).unwrap().as_os_str()
    );
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        ["upgrade", "--cask", "codex"]
    );
    assert!(command
        .get_envs()
        .any(|(key, value)| key == "NONINTERACTIVE" && value == Some(std::ffi::OsStr::new("1"))));
    assert!(update_command(&launcher, "linux", &node).is_none());
}

#[test]
#[ignore = "subprocess fixture for update_lock_excludes_commit_message_generation_without_touching_any_installation"]
fn update_lock_fixture() {
    if std::env::var_os("SORENO_CODEX_UPDATE_LOCK").is_none() {
        return;
    }
    let guard = CODEX_UPDATE.lock().unwrap();
    assert_eq!(update_cli().unwrap_err(), "CODEX_UPDATE_BUSY");
    assert!(matches!(execution::reserve(), Err(error) if error == "CODEX_UPDATE_BUSY"));
    drop(guard);
    let commit = execution::reserve().unwrap();
    assert_eq!(update_cli().unwrap_err(), "CODEX_UPDATE_ACTIVE");
    // Dropping an execution must not wait for the update mutex.
    let guard = CODEX_UPDATE.lock().unwrap();
    drop(commit);
    assert!(!execution::is_active());
    drop(guard);
}

#[test]
fn update_lock_excludes_commit_message_generation_without_touching_any_installation() {
    // Isolate the process-wide execution count from parallel execution tests.
    let mut command = hidden_command(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "codex_cli::update::tests::update_lock_fixture",
        ])
        .env("SORENO_CODEX_UPDATE_LOCK", "1");
    run_command(&mut command, Duration::from_secs(5), false).unwrap();
}

#[test]
#[ignore = "subprocess fixture for timeout_kills_owned_fixture_without_running_an_updater"]
fn update_process_fixture() {
    if std::env::var_os("SORENO_CODEX_UPDATE_WAIT").is_some() {
        std::thread::sleep(Duration::from_secs(30));
    }
}

#[test]
fn timeout_kills_owned_fixture_without_running_an_updater() {
    let mut command = hidden_command(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "codex_cli::update::tests::update_process_fixture",
        ])
        .env("SORENO_CODEX_UPDATE_WAIT", "1");
    assert_eq!(
        run_command(&mut command, Duration::from_millis(50), false).unwrap_err(),
        "CODEX_UPDATE_TIMEOUT"
    );
    assert!(failed("é".repeat(9000)).len() < 2100);
}
