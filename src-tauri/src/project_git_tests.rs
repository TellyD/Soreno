use super::test_fixtures::{local_project, successful_stdout};
use super::*;
#[cfg(windows)]
use crate::agent_sessions::{picker_default_directory, AgentSessions};
use crate::{
    agent_sessions::{tests::unique_temp_path, AgentEnvironment},
    ssh::SshConnection,
};
use std::{
    io::Write,
    path::{Path, PathBuf},
    thread,
};

struct TempRepository(PathBuf);

impl TempRepository {
    fn new(label: &str) -> Self {
        let path = unique_temp_path(&format!("soreno-project-git-{label}"));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn project(&self, path: &Path) -> AgentProject {
        local_project("project", "Projet", path)
    }

    fn configure(&self, directory: &Path) {
        self.git(directory, &["config", "--local", "core.autocrlf", "false"]);
        self.git(directory, &["config", "--local", "core.eol", "lf"]);
    }

    fn git(&self, directory: &Path, args: &[&str]) -> String {
        let config = self.0.join("config");
        let output = Command::new("git")
            .args(["-c", "commit.gpgSign=false", "-C"])
            .arg(directory)
            .args(args)
            .env("HOME", &self.0)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", config)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .output()
            .unwrap();
        successful_stdout(output, args)
    }
}

impl Drop for TempRepository {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn wsl_git_uses_a_windows_local_working_directory() {
    let project = AgentProject {
        id: "project".into(),
        name: "Projet".into(),
        path: "/home/user/project".into(),
        environment: AgentEnvironment {
            kind: "wsl".into(),
            distribution: Some("Ubuntu".into()),
            ssh: None,
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };

    assert_eq!(
        command_builder::git_program(&project).get_current_dir(),
        Some(std::env::temp_dir().as_path())
    );
}

#[test]
fn wsl_readonly_command_keeps_distribution_and_script_literal() {
    let distribution = "Ubuntu; literal";
    let script = "printf '%s' \"$HOME;$(touch nope)\"";
    let command = wsl_readonly_command(distribution, script);
    let args = command
        .get_args()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    assert_eq!(
        args,
        [
            "--distribution",
            distribution,
            "--cd",
            "/",
            "--exec",
            "sh",
            "-c",
            script,
        ]
    );
    assert_eq!(
        command.get_current_dir(),
        Some(std::env::temp_dir().as_path())
    );
    let expected_wslenv = crate::agent_sessions::host_wslenv();
    assert!(command.get_envs().any(|(key, value)| {
        key == "WSLENV"
            && value.is_some_and(|value| value == std::ffi::OsStr::new(&expected_wslenv))
    }));
    for name in GIT_OVERRIDES {
        assert!(command
            .get_envs()
            .any(|(key, value)| key == *name && value.is_none()));
    }
}

#[test]
fn unignored_file_inventory_deduplicates_conflict_stages() {
    let temp = TempRepository::new("deduplicated-inventory");
    temp.git(&temp.0, &["init", "--quiet"]);
    std::fs::write(temp.0.join("source"), "content").unwrap();
    let oid = temp.git(&temp.0, &["hash-object", "-w", "source"]);
    std::fs::remove_file(temp.0.join("source")).unwrap();

    let mut child = Command::new("git")
        .args(["-C"])
        .arg(&temp.0)
        .args(["update-index", "--index-info"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let records = format!(
        "100644 {oid} 1\tconflict.txt\n100644 {oid} 2\tconflict.txt\n100644 {oid} 3\tconflict.txt\n"
    );
    child
        .stdin
        .take()
        .unwrap()
        .write_all(records.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());

    assert_eq!(
        unignored_files(&temp.project(&temp.0)).unwrap().unwrap(),
        b"conflict.txt\0"
    );
}

#[cfg(windows)]
fn process_owner_fixture_command(marker: &Path, wait: bool) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "project_git::tests::windows_process_owner_fixture",
        ])
        .env("SORENO_TEST_PROCESS_OWNER_MARKER", marker)
        .env("SORENO_TEST_PROCESS_OWNER_WAIT", wait.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    ProcessOwner::configure(&mut command);
    command
}

#[cfg(windows)]
#[test]
fn windows_process_owner_fixture() {
    let Some(marker) = std::env::var_os("SORENO_TEST_PROCESS_OWNER_MARKER") else {
        return;
    };
    use windows_sys::Win32::System::{JobObjects::IsProcessInJob, Threading::GetCurrentProcess};
    let mut in_job = 0;
    assert_ne!(
        unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) },
        0
    );
    std::fs::write(marker, if in_job != 0 { "owned" } else { "unowned" }).unwrap();
    if std::env::var("SORENO_TEST_PROCESS_OWNER_WAIT").as_deref() == Ok("true") {
        thread::sleep(Duration::from_secs(30));
    }
}

#[cfg(windows)]
#[test]
fn process_owner_keeps_child_suspended_until_job_ownership_then_resumes_it() {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::{JobObjects::IsProcessInJob, Threading::WaitForSingleObject},
    };

    let temp = TempRepository::new("process-owner-resume");
    let marker = temp.0.join("started");
    let mut child = process_owner_fixture_command(&marker, false)
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(!marker.exists());

    let owner = ProcessOwner::new(&child).unwrap();
    let mut in_job = 0;
    assert_ne!(
        unsafe { IsProcessInJob(child.as_raw_handle() as _, owner.job_handle(), &mut in_job,) },
        0
    );
    assert_ne!(in_job, 0);
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle() as _, 5_000) },
        WAIT_OBJECT_0
    );
    assert!(child.wait().unwrap().success());
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "owned");
}

#[cfg(windows)]
#[test]
fn process_owner_terminates_waiting_child_job() {
    let temp = TempRepository::new("process-owner-terminate");
    let marker = temp.0.join("started");
    let mut child = process_owner_fixture_command(&marker, true)
        .spawn()
        .unwrap();
    let mut owner = ProcessOwner::new(&child).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "owned");
    assert!(owner.terminate(&mut child, IO_STOP_TIMEOUT));
    assert!(child.try_wait().unwrap().is_some());
}

#[cfg(windows)]
struct WslRepositoryFixture {
    linux_root: String,
    unc_root: PathBuf,
    app_data: PathBuf,
    environment: AgentEnvironment,
    sessions: AgentSessions,
}

#[cfg(windows)]
impl WslRepositoryFixture {
    fn new(distribution: String) -> Self {
        let id = format!(
            "{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        );
        let linux_root = format!("/tmp/soreno-git-wsl-{id}");
        let environment = AgentEnvironment {
            kind: "wsl".into(),
            distribution: Some(distribution),
            ssh: None,
        };
        let unc_root = picker_default_directory(&environment, Some(&linux_root))
            .unwrap()
            .unwrap();
        std::fs::create_dir_all(&unc_root).unwrap();
        let app_data = std::env::temp_dir().join(format!("soreno-git-wsl-app-data-{id}"));
        let sessions = AgentSessions::open(&app_data).unwrap();
        Self {
            linux_root,
            unc_root,
            app_data,
            environment,
            sessions,
        }
    }

    fn project(&self, id: &str, name: &str, path: String) -> AgentProject {
        AgentProject {
            id: id.into(),
            name: name.into(),
            path,
            environment: self.environment.clone(),
            icon_data_url: None,
            icon: None,
            color: None,
        }
    }

    fn configure(&self, project: &AgentProject) {
        for (key, value) in [
            ("core.autocrlf", "false"),
            ("core.eol", "lf"),
            ("core.hooksPath", ""),
            ("commit.gpgSign", "false"),
            ("user.name", "Soreno WSL Test"),
            ("user.email", "wsl-test@soreno.invalid"),
        ] {
            execute(
                project,
                &["config", "--local", key, value],
                GitOperation::LocalMutation,
                None,
            )
            .unwrap();
        }
    }

    fn run(&self, args: &[&str]) {
        assert!(std::process::Command::new("wsl.exe")
            .args([
                "--distribution",
                self.environment.distribution.as_deref().unwrap(),
                "--exec",
            ])
            .args(args)
            .status()
            .unwrap()
            .success());
    }
}

#[cfg(windows)]
impl Drop for WslRepositoryFixture {
    fn drop(&mut self) {
        self.sessions.shutdown();
        let _ = std::fs::remove_dir_all(&self.unc_root);
        let _ = std::fs::remove_dir_all(&self.app_data);
    }
}

#[test]
#[ignore = "manual isolated latency measurement; opt into WSL with SORENO_TEST_WSL_DISTRO"]
fn benchmark_repository_and_comparison() {
    fn measure(project: &AgentProject, directory: &Path, label: &str) {
        for index in 0..50 {
            std::fs::write(
                directory.join(format!("file-{index:02}.txt")),
                format!("base-{index}\n"),
            )
            .unwrap();
        }
        execute(
            project,
            &["add", "--all"],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
        execute(
            project,
            &[
                "-c",
                "user.name=Soreno Benchmark",
                "-c",
                "user.email=benchmark@soreno.invalid",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "core.hooksPath=",
                "commit",
                "-qm",
                "Baseline",
            ],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
        for index in 0..50 {
            std::fs::write(
                directory.join(format!("file-{index:02}.txt")),
                format!("content-{index}\n"),
            )
            .unwrap();
        }
        TEST_GIT_COMMANDS.with(|count| count.set(0));
        let started = Instant::now();
        let snapshot = repository(project).unwrap();
        assert_eq!(snapshot.files.len(), 50);
        eprintln!(
            "BENCH {label} status: {} ms, {} logical Git requests",
            started.elapsed().as_millis(),
            TEST_GIT_COMMANDS.with(|count| count.get())
        );
        TEST_GIT_COMMANDS.with(|count| count.set(0));
        let started = Instant::now();
        let diff = comparison(project, "file-00.txt", GitSide::Unstaged).unwrap();
        assert_eq!(diff.before.text.as_deref(), Some("base-0\n"));
        assert_eq!(diff.after.text.as_deref(), Some("content-0\n"));
        assert_eq!(diff.version, snapshot.version);
        let fresh_commands = TEST_GIT_COMMANDS.with(|count| count.get());
        eprintln!(
            "BENCH {label} comparison fresh: {} ms, {fresh_commands} logical Git requests",
            started.elapsed().as_millis(),
        );
        assert_eq!(fresh_commands, 8);
        // Distinct blobs prevent the second file from benefiting from the first file's OID.
        for (index, phase, expected_commands) in [
            (0, "preview cold", 2),
            (1, "preview other file", 2),
            (0, "preview return", 0),
        ] {
            TEST_GIT_COMMANDS.with(|count| count.set(0));
            let started = Instant::now();
            let diff = preview_comparison(
                project,
                &format!("file-{index:02}.txt"),
                GitSide::Unstaged,
                Some(&snapshot.version),
            )
            .unwrap();
            assert_eq!(diff.before.text, Some(format!("base-{index}\n")));
            assert_eq!(diff.after.text, Some(format!("content-{index}\n")));
            assert_eq!(diff.version, snapshot.version);
            let commands = TEST_GIT_COMMANDS.with(|count| count.get());
            eprintln!(
                "BENCH {label} {phase}: {} ms, {commands} logical Git requests",
                started.elapsed().as_millis(),
            );
            assert_eq!(commands, expected_commands);
        }
        std::fs::write(directory.join("file-00.txt"), "changed-0\n").unwrap();
        TEST_GIT_COMMANDS.with(|count| count.set(0));
        let started = Instant::now();
        let changed = preview_comparison(
            project,
            "file-00.txt",
            GitSide::Unstaged,
            Some(&snapshot.version),
        )
        .unwrap();
        assert_eq!(changed.before.text.as_deref(), Some("base-0\n"));
        assert_eq!(changed.after.text.as_deref(), Some("changed-0\n"));
        assert_ne!(changed.version, snapshot.version);
        eprintln!(
            "BENCH {label} external change fallback: {} ms, {} logical Git requests",
            started.elapsed().as_millis(),
            TEST_GIT_COMMANDS.with(|count| count.get()),
        );
        std::fs::write(directory.join("file-00.txt"), "content-0\n").unwrap();
        if std::env::var_os("SORENO_TEST_GIT_ACTIONS").is_some() {
            let data = TempRepository::new("benchmark-sessions");
            let sessions = crate::agent_sessions::AgentSessions::open(&data.0).unwrap();
            sessions.save_project(project.clone()).unwrap();
            for (key, value) in [
                ("core.hooksPath", ""),
                ("commit.gpgSign", "false"),
                ("user.name", "Soreno Benchmark"),
                ("user.email", "benchmark@soreno.invalid"),
            ] {
                execute(
                    project,
                    &["config", "--local", key, value],
                    GitOperation::LocalMutation,
                    None,
                )
                .unwrap();
            }
            let started = Instant::now();
            stage(
                &sessions,
                &project.id,
                vec!["file-00.txt".into()],
                &snapshot.version,
            )
            .unwrap();
            let work_ms = started.elapsed().as_millis();
            let staged = repository(project).unwrap();
            eprintln!(
                "ACTION {label} stage: work={work_ms} total={} ms",
                started.elapsed().as_millis()
            );
            let started = Instant::now();
            unstage(
                &sessions,
                &project.id,
                vec!["file-00.txt".into()],
                &staged.version,
            )
            .unwrap();
            let work_ms = started.elapsed().as_millis();
            let unstaged = repository(project).unwrap();
            eprintln!(
                "ACTION {label} unstage: work={work_ms} total={} ms",
                started.elapsed().as_millis()
            );
            stage(
                &sessions,
                &project.id,
                vec!["file-00.txt".into()],
                &unstaged.version,
            )
            .unwrap();
            let staged = repository(project).unwrap();
            let started = Instant::now();
            assert!(commit(
                &sessions,
                &project.id,
                "Benchmark commit".into(),
                &staged.version
            )
            .unwrap()
            .oid
            .is_some());
            let work_ms = started.elapsed().as_millis();
            assert!(repository(project).unwrap().head.is_some());
            eprintln!(
                "ACTION {label} commit: work={work_ms} total={} ms",
                started.elapsed().as_millis()
            );
            execute(
                project,
                &["reset", "--hard", "HEAD"],
                GitOperation::LocalMutation,
                None,
            )
            .unwrap();
            execute(
                project,
                &["branch", "benchmark-switch", "HEAD"],
                GitOperation::LocalMutation,
                None,
            )
            .unwrap();
            let before_switch = repository(project).unwrap();
            TEST_GIT_COMMANDS.with(|count| count.set(0));
            let started = Instant::now();
            switch_branch(
                &sessions,
                &project.id,
                "benchmark-switch".into(),
                false,
                &before_switch.version,
            )
            .unwrap();
            let work_ms = started.elapsed().as_millis();
            let switch_commands = TEST_GIT_COMMANDS.with(|count| count.get());
            assert_eq!(switch_commands, 3);
            assert_eq!(
                repository(project).unwrap().branch.as_deref(),
                Some("benchmark-switch")
            );
            eprintln!(
                "ACTION {label} switch branch: work={work_ms} total={} ms, {switch_commands} logical Git requests",
                started.elapsed().as_millis()
            );
            sessions.shutdown();
        }
    }
    let local = TempRepository::new("benchmark");
    local.git(&local.0, &["init", "-q", "--initial-branch=main"]);
    local.configure(&local.0);
    measure(&local.project(&local.0), &local.0, "local");
    #[cfg(windows)]
    if let Ok(distribution) = std::env::var("SORENO_TEST_WSL_DISTRO") {
        let wsl = WslRepositoryFixture::new(distribution);
        let project = wsl.project("benchmark", "Benchmark", wsl.linux_root.clone());
        execute(
            &project,
            &["init", "-q", "--initial-branch=main"],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
        wsl.configure(&project);
        measure(&project, &wsl.unc_root, "wsl");
    }
}

#[test]
#[ignore = "manual Git panel read benchmark; opt into WSL with SORENO_TEST_WSL_DISTRO"]
fn benchmark_git_panel_all_reads() {
    // Counts Soreno logical requests; the relay may additionally run internal
    // read-only Python config and gitlink probes for relayed requests.
    fn timed<T>(
        repository_label: &str,
        phase: &str,
        read: impl FnOnce() -> Result<T, GitError>,
    ) -> T {
        TEST_GIT_COMMANDS.with(|count| count.set(0));
        let started = Instant::now();
        let value = read().unwrap();
        eprintln!(
            "BENCH {repository_label} {phase}: {:.3} ms, {} logical Git requests",
            started.elapsed().as_secs_f64() * 1_000.0,
            TEST_GIT_COMMANDS.with(|count| count.get())
        );
        value
    }

    fn commit(project: &AgentProject, message: &str) {
        execute(
            project,
            &[
                "-c",
                "user.name=Soreno Benchmark",
                "-c",
                "user.email=benchmark@soreno.invalid",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "core.hooksPath=",
                "commit",
                "-qm",
                message,
            ],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
    }

    fn prepare(project: &AgentProject, directory: &Path) -> String {
        for index in 0..50 {
            std::fs::write(
                directory.join(format!("file-{index:02}.txt")),
                format!("base-{index}\n"),
            )
            .unwrap();
        }
        execute(
            project,
            &["add", "--all"],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
        commit(project, "Baseline");
        std::fs::write(directory.join("file-00.txt"), "committed-0\n").unwrap();
        execute(
            project,
            &["add", "file-00.txt"],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
        commit(project, "Second commit");
        let head = oid_output(
            &execute(
                project,
                &["rev-parse", "--verify", "HEAD"],
                GitOperation::Read,
                None,
            )
            .unwrap()
            .stdout,
            "OID du benchmark",
        )
        .unwrap();
        execute(
            project,
            &["branch", "secondary"],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
        execute(
            project,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/soreno.git",
            ],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
        for index in 0..50 {
            std::fs::write(
                directory.join(format!("file-{index:02}.txt")),
                format!("current-{index}\n"),
            )
            .unwrap();
        }
        head
    }

    fn measure(project: &AgentProject, directory: &Path, label: &str) {
        let head = prepare(project, directory);
        let status = timed(label, "status cold", || repository(project));
        assert_eq!(status.files.len(), 50);
        assert_eq!(status.head.as_deref(), Some(head.as_str()));
        let refreshed = timed(label, "status refresh", || repository(project));
        assert_eq!(refreshed.files.len(), 50);
        assert_eq!(refreshed.version, status.version);

        let diff = timed(label, "diff cold", || {
            preview_comparison(
                project,
                "file-00.txt",
                GitSide::Unstaged,
                Some(&refreshed.version),
            )
        });
        assert_eq!(diff.before.text.as_deref(), Some("committed-0\n"));
        assert_eq!(diff.after.text.as_deref(), Some("current-0\n"));
        let other = timed(label, "diff other", || {
            preview_comparison(
                project,
                "file-01.txt",
                GitSide::Unstaged,
                Some(&refreshed.version),
            )
        });
        assert_eq!(other.before.text.as_deref(), Some("base-1\n"));
        assert_eq!(other.after.text.as_deref(), Some("current-1\n"));
        let returned = timed(label, "diff return", || {
            preview_comparison(
                project,
                "file-00.txt",
                GitSide::Unstaged,
                Some(&refreshed.version),
            )
        });
        assert_eq!(returned.before.text.as_deref(), Some("committed-0\n"));
        assert_eq!(returned.after.text.as_deref(), Some("current-0\n"));

        let branch_list = timed(label, "branches", || branches(project));
        assert!(branch_list
            .iter()
            .any(|branch| branch.name == "main" && branch.current));
        assert!(branch_list
            .iter()
            .any(|branch| branch.name == "secondary" && !branch.current));
        let remote_list = timed(label, "remotes", || remotes(project));
        assert!(remote_list.iter().any(|remote| {
            remote.name == "origin" && remote.url == "https://example.invalid/soreno.git"
        }));
        let history_page = timed(label, "history", || history(project, None, 0, None));
        assert!(history_page.roots.contains(&head));
        assert!(history_page
            .commits
            .iter()
            .any(|commit| commit.oid == head && commit.subject == "Second commit"));
        let detail = timed(label, "commit detail", || commit_detail(project, &head));
        assert!(detail.files.iter().any(|file| file.path == "file-00.txt"));
        let commit_diff = timed(label, "commit diff", || {
            commit_comparison(project, &head, "file-00.txt")
        });
        assert_eq!(commit_diff.before.text.as_deref(), Some("base-0\n"));
        assert_eq!(commit_diff.after.text.as_deref(), Some("committed-0\n"));

        for repetition in 1..=2 {
            timed(label, &format!("warm reads {repetition}"), || {
                let status = repository(project)?;
                let comparison = preview_comparison(
                    project,
                    "file-00.txt",
                    GitSide::Unstaged,
                    Some(&status.version),
                )?;
                assert_eq!(comparison.after.text.as_deref(), Some("current-0\n"));
                assert!(!branches(project)?.is_empty());
                assert!(!remotes(project)?.is_empty());
                assert!(
                    !history(project, Some(std::slice::from_ref(&head)), 0, None)?
                        .commits
                        .is_empty()
                );
                assert!(!commit_detail(project, &head)?.files.is_empty());
                assert_eq!(
                    commit_comparison(project, &head, "file-00.txt")?
                        .after
                        .text
                        .as_deref(),
                    Some("committed-0\n")
                );
                Ok(())
            });
        }
    }

    let local = TempRepository::new("git-panel-benchmark");
    local.git(&local.0, &["init", "-q", "--initial-branch=main"]);
    local.configure(&local.0);
    measure(&local.project(&local.0), &local.0, "local");

    #[cfg(windows)]
    if let Ok(distribution) = std::env::var("SORENO_TEST_WSL_DISTRO") {
        let wsl = WslRepositoryFixture::new(distribution);
        let project = wsl.project(
            "git-panel-benchmark",
            "Git panel benchmark",
            wsl.linux_root.clone(),
        );
        execute(
            &project,
            &["init", "-q", "--initial-branch=main"],
            GitOperation::LocalMutation,
            None,
        )
        .unwrap();
        wsl.configure(&project);
        measure(&project, &wsl.unc_root, "wsl");
    }
}

#[test]
fn version_and_failures_are_classified_without_parsing_guesswork_at_call_sites() {
    assert_eq!(parse_version("2.45.1.windows.1"), Some((2, 45, 1)));
    assert_eq!(parse_version("2.35.0"), Some((2, 35, 0)));
    assert_eq!(parse_version("2.x.0"), None);
    assert_eq!(parse_version("2.35"), None);
    for summary in ["[rejected] (non-fast-forward)", "[rejected] (fetch first)"] {
        assert_eq!(
            failure_code(
                format!("!\trefs/heads/main:refs/heads/main\t{summary}\n").as_bytes(),
                b"error: failed to push some refs"
            ),
            "nonFastForward"
        );
    }
    assert_eq!(
        failure_code(
            b"!\trefs/heads/main:refs/heads/main\t[rejected] (remote rejected)\n",
            b"error: failed to push some refs"
        ),
        "failed"
    );
    assert_eq!(
        failure_code(
            b"",
            b"Updates were rejected because the tip of your current branch is behind its remote counterpart"
        ),
        "nonFastForward"
    );
    assert_eq!(
        failure_code(b"", b"operation named non-fast-forward failed"),
        "failed"
    );
    assert_eq!(
        failure_code(b"fatal: detected dubious ownership", b""),
        "unsafe"
    );
    assert_eq!(failure_code(b"fatal: not a git repository", b""), "notRepo");
    assert_eq!(
        failure_code(
            b"",
            b"fatal: cannot change to '/missing': No such file or directory"
        ),
        "missingDirectory"
    );
    assert_eq!(
        failure_code(
            b"",
            b"fatal: cannot change to '/private': Permission denied"
        ),
        "inaccessible"
    );
    assert_eq!(
        failure_code(
            b"",
            b"fatal: cannot change to '/tmp/No such file or directory/repo': Permission denied"
        ),
        "inaccessible"
    );

    let error = run_command(
        Command::new("soreno-git-command-that-does-not-exist"),
        Duration::from_secs(1),
        false,
        None,
    )
    .unwrap_err();
    assert_eq!(error.code, "missing");
}

#[test]
fn ssh_transport_failures_are_not_classified_as_missing_refs() {
    assert_eq!(ssh_transport_error_code("Délai SSH dépassé."), "timeout");
    assert_eq!(
        ssh_transport_error_code("OpenSSH indisponible : introuvable"),
        "missing"
    );
    assert_eq!(
        ssh_transport_error_code("Réponse SSH trop volumineuse."),
        "outputTooLarge"
    );
    for message in [
        "Connexion SSH interrompue.",
        "En-tête du relais SSH invalide.",
        "Écriture vers le relais SSH impossible.",
        "Annulation SSH non confirmée.",
    ] {
        assert_eq!(ssh_transport_error_code(message), "inaccessible");
    }
}

#[test]
fn parses_fast_metadata_without_trimming_paths_and_falls_back_for_extra_lines() {
    let (git_dir, common_dir, root, format) =
        parse_fast_metadata(b"false\n/repo/.git\r\n/repo/.git\r\n/repo\r\nsha256\n")
            .unwrap()
            .unwrap();
    assert_eq!(git_dir, "/repo/.git\r");
    assert_eq!(common_dir, "/repo/.git\r");
    assert_eq!(root, "/repo\r");
    assert_eq!(format, object_hash::ObjectFormat::Sha256);
    assert!(
        parse_fast_metadata(b"false\n/repo/.git\n/repo/.git\n/repo\nwith-newline\nsha1\n")
            .unwrap()
            .is_none()
    );
    assert!(parse_fast_metadata(b"true\n/a\n/b\n/c\nsha1\n").is_err());
    assert!(parse_fast_metadata(b"false\n/a\n/b\n/c\nunknown\n").is_err());
}

#[test]
fn version_cache_is_scoped_by_distribution_and_invalidated_individually() {
    let project = |distribution: &str| AgentProject {
        id: "cache-test".into(),
        name: "Cache test".into(),
        path: "/unused".into(),
        environment: AgentEnvironment {
            kind: "wsl".into(),
            distribution: Some(distribution.into()),
            ssh: None,
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };
    let first = project("Soreno-Cache-First");
    let second = project("Soreno-Cache-Second");
    {
        let mut cache = version_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.insert(environment_key(&first), "2.45.1".into());
        cache.insert(environment_key(&second), "2.46.0".into());
    }
    assert_eq!(version(&first).unwrap(), "2.45.1");
    assert_eq!(version(&second).unwrap(), "2.46.0");
    invalidate_version(&first);
    let cache = version_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(!cache.contains_key(&environment_key(&first)));
    assert_eq!(
        cache.get(&environment_key(&second)).map(String::as_str),
        Some("2.46.0")
    );
    drop(cache);
    invalidate_version(&second);
}

#[test]
fn version_cache_key_includes_the_complete_ssh_target() {
    let mut project = AgentProject {
        id: "ssh-cache".into(),
        name: "SSH cache".into(),
        path: "/repository".into(),
        environment: AgentEnvironment {
            kind: "ssh".into(),
            distribution: None,
            ssh: Some(SshConnection {
                host: "first.example".into(),
                user: Some("user".into()),
                port: Some(22),
                identity_file: None,
                host_key: None,
            }),
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };
    let first = environment_key(&project);
    project.environment.ssh.as_mut().unwrap().host = "second.example".into();
    assert_ne!(first, environment_key(&project));
    project.environment.ssh.as_mut().unwrap().host = "first.example".into();
    project.environment.ssh.as_mut().unwrap().identity_file = Some("/tmp/key".into());
    assert_ne!(first, environment_key(&project));
}

#[test]
fn serde_contract_is_camel_case_and_omits_known_certainty() {
    let cases = [
        (
            serde_json::to_value(GitIdentity {
                root: "/repo".into(),
                git_dir: "/repo/.git".into(),
                common_dir: "/repo/.git".into(),
                object_format: object_hash::ObjectFormat::Sha1,
            }),
            serde_json::json!({
                "root": "/repo",
                "gitDir": "/repo/.git",
                "commonDir": "/repo/.git"
            }),
        ),
        (
            serde_json::to_value(GitError::new("missing", "Git absent")),
            serde_json::json!({ "code": "missing", "message": "Git absent" }),
        ),
        (
            serde_json::to_value(GitError::command("failed", "Échec", true).with_path("a.txt")),
            serde_json::json!({
                "code": "failed",
                "message": "Échec",
                "uncertain": true,
                "path": "a.txt"
            }),
        ),
    ];
    for (actual, expected) in cases {
        assert_eq!(actual.unwrap(), expected);
    }
}

#[test]
fn executor_caps_input_and_drains_beyond_output_limits() {
    let captured = drain(std::io::Cursor::new(vec![b'x'; LOG_LIMIT + 17]), LOG_LIMIT).unwrap();
    assert_eq!(captured.bytes.len(), LOG_LIMIT);
    assert!(captured.truncated);

    let error = run_command(
        Command::new("git"),
        Duration::from_secs(1),
        false,
        Some(&vec![0; STDIN_LIMIT + 1]),
    )
    .unwrap_err();
    assert_eq!(error.code, "inputTooLarge");
}

#[cfg(unix)]
#[test]
fn executor_reports_a_failed_status_before_broken_stdin() {
    let mut command = Command::new("sh");
    command.args(["-c", "exec 0<&-; printf 'expected failure' >&2; exit 7"]);
    let input = vec![b'x'; STDIN_LIMIT];

    let error = run_command(command, Duration::from_secs(2), false, Some(&input)).unwrap_err();

    assert_eq!(error.code, "failed");
    assert!(error.message.contains("expected failure"));
}

#[test]
fn branch_hint_uses_one_eight_second_budget_without_renewing_a_parent() {
    let temp = TempRepository::new("branch-hint-budget");
    let project = temp.project(&temp.0);
    let started = Instant::now();
    branch_hint_read(&project, || {
        let deadline = read_deadline().unwrap();
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(remaining > Duration::from_secs(7));
        assert!(remaining <= BRANCH_HINT_TIMEOUT);
        assert!(deadline > started + Duration::from_secs(7));
        with_read_budget(Duration::from_secs(30), || {
            assert_eq!(read_deadline(), Some(deadline));
            Ok(())
        })
    })
    .unwrap();
    assert!(read_deadline().is_none());

    let parent = Instant::now() + Duration::from_millis(100);
    with_read_deadline(parent, || {
        branch_hint_read(&project, || {
            assert_eq!(read_deadline(), Some(parent));
            Ok(())
        })
    })
    .unwrap();
    assert!(read_deadline().is_none());
}

#[test]
fn branch_hint_only_falls_back_after_a_normal_git_failure_or_empty_output() {
    let mut failed_calls = 0;
    let detached = branch_hint_from(|_| {
        failed_calls += 1;
        if failed_calls == 1 {
            Err(GitError::new("failed", "HEAD détachée"))
        } else {
            Ok(b"abc123\n".to_vec())
        }
    })
    .unwrap();
    assert_eq!(detached.as_deref(), Some("HEAD @ abc123"));
    assert_eq!(failed_calls, 2);

    let mut empty_calls = 0;
    let detached = branch_hint_from(|_| {
        empty_calls += 1;
        Ok(if empty_calls == 1 {
            b"\n".to_vec()
        } else {
            b"def456\n".to_vec()
        })
    })
    .unwrap();
    assert_eq!(detached.as_deref(), Some("HEAD @ def456"));
    assert_eq!(empty_calls, 2);
}

#[test]
fn branch_hint_does_not_retry_uncertain_non_repository_or_malformed_results() {
    for error in [
        GitError::command("timeout", "terminaison incertaine", true),
        GitError::new("notRepo", "hors dépôt"),
    ] {
        let mut calls = 0;
        let returned = branch_hint_from(|_| {
            calls += 1;
            Err(error.clone())
        })
        .unwrap_err();
        assert_eq!(returned.code, error.code);
        assert_eq!(calls, 1);
    }

    let mut calls = 0;
    let error = branch_hint_from(|_| {
        calls += 1;
        Ok(vec![0xff])
    })
    .unwrap_err();
    assert_eq!(error.code, "malformed");
    assert_eq!(calls, 1);
}

#[test]
fn read_budget_is_cumulative_and_nested_scopes_do_not_renew_it() {
    assert!(read_deadline().is_none());
    let error = with_read_budget(Duration::from_millis(40), || {
        let outer_deadline = read_deadline().unwrap();
        thread::sleep(Duration::from_millis(20));
        with_read_budget(Duration::from_secs(1), || {
            assert_eq!(read_deadline(), Some(outer_deadline));
            thread::sleep(Duration::from_millis(40));
            check_read_deadline()
        })
    })
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert!(error.message.contains("lecture Git complète"));
    assert_eq!(error.uncertain, None);
    assert!(read_deadline().is_none());
}

#[test]
fn read_budget_checks_deadline_after_a_successful_read() {
    let error = with_read_budget(Duration::from_millis(10), || {
        thread::sleep(Duration::from_millis(20));
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert_eq!(error.uncertain, None);
    assert!(read_deadline().is_none());
}

#[test]
fn read_budget_is_restored_after_errors_and_panics() {
    let error = with_read_budget(Duration::from_secs(1), || {
        Err::<(), _>(GitError::new("test", "erreur attendue"))
    })
    .unwrap_err();
    assert_eq!(error.code, "test");
    assert!(read_deadline().is_none());

    let panic = std::panic::catch_unwind(|| {
        let _ = with_read_budget(Duration::from_secs(1), || -> Result<(), GitError> {
            panic!("panic attendue");
        });
    });
    assert!(panic.is_err());
    assert!(read_deadline().is_none());
}

#[test]
fn read_budget_scopes_are_thread_local() {
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let child_barrier = Arc::clone(&barrier);
    let child = thread::spawn(move || {
        with_read_budget(Duration::from_millis(20), || {
            child_barrier.wait();
            thread::sleep(Duration::from_millis(40));
            check_read_deadline()
        })
        .unwrap_err()
    });
    barrier.wait();
    assert!(check_read_deadline().is_ok());
    assert_eq!(child.join().unwrap().code, "timeout");
    assert!(check_read_deadline().is_ok());
}

#[cfg(unix)]
#[test]
fn expired_read_budget_prevents_spawn_and_bounds_slow_processes() {
    let temp = TempRepository::new("read-budget");
    let marker = temp.0.join("spawned");
    TEST_GIT_COMMANDS.with(|count| count.set(0));
    let error = with_read_budget(Duration::from_millis(10), || {
        thread::sleep(Duration::from_millis(20));
        let mut command = Command::new("sh");
        command
            .args(["-c", "printf spawned > \"$MARKER\""])
            .env("MARKER", &marker);
        run_command(command, Duration::from_secs(1), false, None)
    })
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert_eq!(error.uncertain, None);
    assert!(!marker.exists());
    assert_eq!(TEST_GIT_COMMANDS.with(|count| count.get()), 0);

    let started = Instant::now();
    let error = with_read_budget(Duration::from_millis(50), || {
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 10"]);
        run_command(command, Duration::from_secs(2), false, None)
    })
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert!(error.message.contains("lecture Git complète"));
    assert_eq!(error.uncertain, None);
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[cfg(unix)]
#[test]
fn expired_read_budget_does_not_shorten_mutation_timeouts() {
    let error = with_read_budget(Duration::from_millis(10), || {
        thread::sleep(Duration::from_millis(20));
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 0.05; printf mutation"]);
        let output = run_command(command, Duration::from_millis(500), true, None)?;
        assert_eq!(output.stdout, b"mutation");
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert_eq!(error.uncertain, None);
}

#[test]
fn validators_reject_unsafe_paths_refs_and_oids() {
    assert!(validate_relative_path("src/file.rs").is_ok());
    for path in [
        "/tmp/file",
        "../file",
        "src/../file",
        ".git/config",
        "a\\.git\\x",
        "C:/x",
        "c:\\x",
    ] {
        assert!(validate_relative_path(path).is_err(), "{path}");
    }
    assert!(validate_ref_name("feature/literal-name").is_ok());
    for reference in ["-main", "a..b", "refs/x.lock", "a@{b", "a b", "@"] {
        assert!(validate_ref_name(reference).is_err(), "{reference}");
    }
    assert!(validate_oid("0123456789012345678901234567890123456789").is_ok());
    assert!(validate_oid("HEAD").is_err());
}

#[test]
fn command_is_literal_cleans_overrides_and_preserves_user_git_behavior() {
    let root = TempRepository::new("command");
    let project = root.project(Path::new("/tmp/a b;$(touch nope)"));
    let command = git_command(&project, &["status", "--short"]).unwrap();
    let args = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        args.first().map(String::as_str),
        Some("--no-replace-objects")
    );
    assert!(args.windows(2).any(|args| args == ["-C", &project.path]));
    assert_eq!(&args[args.len() - 2..], ["status", "--short"]);
    for forbidden in [
        "core.hooksPath=",
        "commit.gpgSign=false",
        "tag.gpgSign=false",
        "merge.gpgSign=false",
    ] {
        assert!(!args.iter().any(|arg| arg == forbidden));
    }
    for name in GIT_OVERRIDES {
        assert!(command
            .get_envs()
            .any(|(key, value)| key == *name && value.is_none()));
    }
    for (name, expected) in [
        ("LC_ALL", "C"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_EDITOR", "true"),
        ("GIT_ALLOW_PROTOCOL", "https:ssh:file"),
    ] {
        assert!(command
            .get_envs()
            .any(|(key, value)| { key == name && value.is_some_and(|value| value == expected) }));
    }

    root.git(&root.0, &["init"]);
    root.configure(&root.0);
    std::fs::write(root.0.join("tracked"), "original").unwrap();
    root.git(&root.0, &["add", "tracked"]);
    root.git(
        &root.0,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "original",
        ],
    );
    let original = root.git(&root.0, &["rev-parse", "HEAD"]);
    let tree = root.git(&root.0, &["rev-parse", "HEAD^{tree}"]);
    let replacement = root.git(
        &root.0,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit-tree",
            &tree,
            "-m",
            "replacement",
        ],
    );
    root.git(&root.0, &["replace", &original, &replacement]);
    assert_eq!(
        read_text(
            &root.project(&root.0),
            &["show", "-s", "--format=%s", "HEAD"]
        )
        .unwrap(),
        "original"
    );
}

#[test]
fn ssh_command_routes_git_to_the_pinned_target_without_a_local_worktree_path() {
    let project = AgentProject {
        id: "ssh".into(),
        name: "SSH".into(),
        path: "/srv/a b;$(touch nope)".into(),
        environment: AgentEnvironment {
            kind: "ssh".into(),
            distribution: None,
            ssh: Some(SshConnection {
                host: "example.test".into(),
                user: Some("git".into()),
                port: Some(2222),
                identity_file: None,
                host_key: None,
            }),
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };
    let command = git_command(&project, &["status", "--short"]).unwrap();
    assert_eq!(command.get_program(), "ssh");
    assert!(is_ssh_command(&command));
    let remote = command.get_args().last().unwrap().to_string_lossy();
    let remote = remote
        .strip_prefix("sh -c '")
        .unwrap()
        .strip_suffix('\'')
        .unwrap()
        .replace("'\"'\"'", "'");
    assert!(remote.contains("exec git '--no-replace-objects'"));
    assert!(remote.contains("'-C' '/srv/a b;$(touch nope)' 'status' '--short'"));

    let mut invalid = project.clone();
    invalid.path = "relative".into();
    assert_eq!(
        git_command(&invalid, &["status"]).unwrap_err().code,
        "invalidPath"
    );
    invalid.path = "/srv/repository".into();
    invalid.environment.ssh = None;
    assert_eq!(
        git_command(&invalid, &["status"]).unwrap_err().code,
        "inaccessible"
    );
}

#[test]
fn ssh_unignored_files_respects_a_disconnected_transport() {
    let project = AgentProject {
        id: "blocked-search".into(),
        name: "SSH".into(),
        path: "/srv/project".into(),
        environment: AgentEnvironment {
            kind: "ssh".into(),
            distribution: None,
            ssh: Some(SshConnection {
                host: "blocked-search.invalid".into(),
                user: Some("git".into()),
                port: Some(22),
                identity_file: None,
                host_key: None,
            }),
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };
    let connection = project.environment.ssh.as_ref().unwrap();
    crate::ssh::block(connection);

    let error = unignored_files(&project).unwrap_err();

    crate::ssh::unblock(connection);
    assert_eq!(error.code, "inaccessible");
    assert!(error.message.contains("reconnectez explicitement"));
}

#[cfg(unix)]
#[test]
fn forced_protocol_allowlist_blocks_specific_remote_helper_overrides() {
    let temp = TempRepository::new("protocol");
    let marker = temp.0.join("remote-helper-ran");
    let project = temp.project(&temp.0);
    let remote = format!("ext::touch {}", marker.display());
    let mut args = remotes::NETWORK_CONFIG.to_vec();
    args.extend(["-c", "protocol.ext.allow=always", "ls-remote", &remote]);
    let error = execute(&project, &args, GitOperation::Read, None).unwrap_err();
    assert_eq!(error.code, "failed");
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn executor_drains_both_streams_and_kills_then_reaps_on_timeout() {
    let mut output = Command::new("sh");
    output.args([
        "-c",
        "i=0; while [ $i -lt 4000 ]; do printf x; printf y >&2; i=$((i+1)); done",
    ]);
    let result = run_command(output, Duration::from_secs(2), false, None).unwrap();
    assert_eq!(result.stdout.len(), 4000);
    assert_eq!(result.stderr.len(), 4000);

    let mut timeout = Command::new("sh");
    timeout.args(["-c", "exec sleep 10"]);
    let started = Instant::now();
    let error = run_command(timeout, Duration::from_millis(50), true, None).unwrap_err();
    assert_eq!(error.code, "timeout");
    assert_eq!(error.uncertain, Some(true));
    assert!(started.elapsed() < Duration::from_secs(2));

    for _ in 0..4 {
        let mut inherited_pipe = Command::new("sh");
        inherited_pipe.args(["-c", "sleep 10 & exit 0"]);
        let started = Instant::now();
        let error = run_command(inherited_pipe, Duration::from_millis(50), true, None).unwrap_err();
        assert_eq!(error.code, "timeout");
        assert!(started.elapsed() < Duration::from_millis(500));
        require_idle().unwrap();
    }

    let temp = TempRepository::new("timeout-hook");
    let repository_path = temp.0.join("repository");
    let marker = temp.0.join("hook-finished");
    std::fs::create_dir(&repository_path).unwrap();
    temp.git(&repository_path, &["init"]);
    temp.configure(&repository_path);
    std::fs::write(repository_path.join("tracked"), "content").unwrap();
    temp.git(&repository_path, &["add", "tracked"]);
    let hook = repository_path.join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\nexec 1>&- 2>&-\nsleep 1\nprintf finished > \"$HOOK_MARKER\"\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let project = temp.project(&repository_path);
    let mut commit = git_command(
        &project,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "hook timeout",
        ],
    )
    .unwrap();
    commit.env("HOOK_MARKER", &marker);
    let error = run_command(commit, Duration::from_millis(50), true, None).unwrap_err();
    assert_eq!(error.code, "timeout");
    require_idle().unwrap();
    thread::sleep(Duration::from_millis(1100));
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn abnormal_ssh_mutations_block_following_mutations() {
    for mode in ["exit-255", "signal"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "project_git::tests::abnormal_ssh_mutation_fixture",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("SORENO_TEST_ABNORMAL_SSH_MUTATION", mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(unix)]
#[test]
fn abnormal_ssh_mutation_fixture() {
    let Some(mode) = std::env::var_os("SORENO_TEST_ABNORMAL_SSH_MUTATION") else {
        return;
    };

    let mut read = Command::new("sh");
    read.args(["-c", "exit 255"])
        .env("SORENO_GIT_SSH_COMMAND", "1");
    run_command(read, Duration::from_secs(1), false, None).unwrap_err();
    require_idle().unwrap();

    let mut mutation = Command::new("sh");
    mutation
        .args([
            "-c",
            if mode == "signal" {
                "kill -TERM $$"
            } else {
                "exit 255"
            },
        ])
        .env("SORENO_GIT_SSH_COMMAND", "1");
    run_command(mutation, Duration::from_secs(1), true, None).unwrap_err();
    assert_eq!(require_idle().unwrap_err().code, "uncertain");
}

#[test]
fn discovers_subdirectories_bare_repositories_and_linked_worktrees() {
    let temp = TempRepository::new("identity");
    let repository_path = temp.0.join("repository");
    let worktree_path = temp.0.join("linked worktree");
    let nested_path = worktree_path.join("nested");
    std::fs::create_dir(&repository_path).unwrap();
    temp.git(&repository_path, &["init"]);
    temp.configure(&repository_path);
    std::fs::write(repository_path.join("tracked"), "content").unwrap();
    temp.git(&repository_path, &["add", "tracked"]);
    temp.git(
        &repository_path,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "initial",
        ],
    );
    temp.git(
        &repository_path,
        &["worktree", "add", worktree_path.to_str().unwrap(), "HEAD"],
    );
    std::fs::create_dir(&nested_path).unwrap();

    let discovered = repository(&temp.project(&nested_path)).unwrap();
    let identity = discovered.identity.unwrap();
    assert_eq!(discovered.availability, "ready");
    assert_eq!(
        identity.root,
        std::fs::canonicalize(&worktree_path)
            .unwrap()
            .to_string_lossy()
    );
    assert_ne!(identity.git_dir, identity.common_dir);
    assert_eq!(
        identity.common_dir,
        std::fs::canonicalize(repository_path.join(".git"))
            .unwrap()
            .to_string_lossy()
    );

    let bare_path = temp.0.join("bare.git");
    std::fs::create_dir(&bare_path).unwrap();
    temp.git(&bare_path, &["init", "--bare"]);
    temp.configure(&bare_path);
    let bare = repository(&temp.project(&bare_path)).unwrap();
    assert_eq!(bare.availability, "bare");
    let bare_identity = bare.identity.unwrap();
    assert_eq!(bare_identity.root, bare_identity.git_dir);

    let plain_path = temp.0.join("plain");
    std::fs::create_dir(&plain_path).unwrap();
    let plain = repository(&temp.project(&plain_path)).unwrap();
    assert_eq!(plain.availability, "notRepository");
    assert!(plain.identity.is_none());
}

#[cfg(unix)]
#[test]
fn discovers_repository_roots_ending_in_lf_or_cr_and_sha256() {
    let temp = TempRepository::new("metadata-paths");
    for suffix in ['\r', '\n'] {
        let root = temp.0.join(format!("repository{suffix}"));
        std::fs::create_dir(&root).unwrap();
        temp.git(&root, &["init"]);
        TEST_GIT_COMMANDS.with(|count| count.set(0));
        let identity = discover_repository(&temp.project(&root))
            .unwrap()
            .identity
            .unwrap();
        if suffix == '\n' {
            assert_eq!(TEST_GIT_COMMANDS.with(|count| count.get()), 6);
        }
        assert_eq!(
            identity.root,
            std::fs::canonicalize(&root).unwrap().to_string_lossy()
        );
        assert_eq!(identity.object_format, object_hash::ObjectFormat::Sha1);
    }

    let sha256 = temp.0.join("sha256");
    std::fs::create_dir(&sha256).unwrap();
    temp.git(&sha256, &["init", "--object-format=sha256"]);
    let identity = discover_repository(&temp.project(&sha256))
        .unwrap()
        .identity
        .unwrap();
    assert_eq!(identity.object_format, object_hash::ObjectFormat::Sha256);
}

#[test]
fn reads_partial_changes_and_versions_real_worktree_content() {
    let temp = TempRepository::new("partial");
    let root = temp.0.join("repository");
    let nested = root.join("nested");
    std::fs::create_dir(&root).unwrap();
    temp.git(&root, &["init"]);
    temp.configure(&root);
    std::fs::write(root.join("file.txt"), "base\r\n").unwrap();
    temp.git(&root, &["add", "file.txt"]);
    temp.git(
        &root,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "initial",
        ],
    );
    std::fs::write(root.join("file.txt"), "next\r\n").unwrap();
    temp.git(&root, &["add", "file.txt"]);
    std::fs::write(root.join("file.txt"), "last\r\n").unwrap();
    std::fs::create_dir(&nested).unwrap();

    let project = temp.project(&nested);
    let first = repository(&project).unwrap();
    assert_eq!(
        first.identity.as_ref().unwrap().root,
        std::fs::canonicalize(&root).unwrap().to_string_lossy()
    );
    assert_eq!(first.files.len(), 1);
    assert_eq!(first.files[0].index_status, "M");
    assert_eq!(first.files[0].worktree_status, "M");
    assert_eq!(
        (first.files[0].added, first.files[0].deleted),
        (Some(2), Some(2))
    );

    let staged = comparison(&project, "file.txt", GitSide::Staged).unwrap();
    assert_eq!(staged.before.text.as_deref(), Some("base\r\n"));
    assert_eq!(staged.after.text.as_deref(), Some("next\r\n"));
    let unstaged = comparison(&project, "file.txt", GitSide::Unstaged).unwrap();
    assert_eq!(unstaged.before.text.as_deref(), Some("next\r\n"));
    assert_eq!(unstaged.after.text.as_deref(), Some("last\r\n"));

    std::fs::write(root.join("file.txt"), "else\r\n").unwrap();
    let second = repository(&project).unwrap();
    assert_ne!(first.version, second.version);
}

#[test]
fn reads_unborn_renamed_deleted_special_binary_and_symlink_entries() {
    let temp = TempRepository::new("files");
    let root = temp.0.join("repository");
    std::fs::create_dir(&root).unwrap();
    temp.git(&root, &["init"]);
    temp.configure(&root);
    std::fs::write(root.join("staged.txt"), "staged without newline").unwrap();
    temp.git(&root, &["add", "staged.txt"]);
    let unborn = repository(&temp.project(&root)).unwrap();
    assert!(unborn.head.is_none());
    let staged = comparison(&temp.project(&root), "staged.txt", GitSide::Staged).unwrap();
    assert_eq!(staged.before.text.as_deref(), Some(""));

    temp.git(
        &root,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "initial",
        ],
    );
    std::fs::write(root.join("deleted.txt"), "delete me\n").unwrap();
    std::fs::write(root.join("file[1].txt"), "literal before\n").unwrap();
    temp.git(&root, &["add", "deleted.txt", "file[1].txt"]);
    temp.git(
        &root,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "second",
        ],
    );
    temp.git(&root, &["mv", "staged.txt", "renamed é.txt"]);
    std::fs::remove_file(root.join("deleted.txt")).unwrap();
    std::fs::write(root.join("file[1].txt"), "literal after\n").unwrap();
    temp.git(&root, &["add", "file[1].txt"]);
    #[cfg(unix)]
    let special = "-accentué\nname.txt";
    #[cfg(windows)]
    let special = "-accentué [1].txt";
    std::fs::write(root.join(special), "special\n").unwrap();
    std::fs::write(root.join("binary.bin"), b"a\0b").unwrap();
    temp.git(&root, &["add", "binary.bin"]);
    std::fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
    temp.git(&root, &["add", "image.png"]);
    std::fs::write(root.join("image.png"), b"\xff\xd8\xff\xe0JFIF").unwrap();
    std::fs::write(root.join("non-utf8.txt"), [0xff, b'x']).unwrap();
    std::fs::write(root.join("large.txt"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("missing-target", root.join("link")).unwrap();
    // APFS refuses file names that are not UTF-8.
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::ffi::OsStrExt;
        std::fs::write(root.join(std::ffi::OsStr::from_bytes(b"bad\xff")), "x").unwrap();
    }

    let state = repository(&temp.project(&root)).unwrap();
    let renamed = state
        .files
        .iter()
        .find(|file| file.path == "renamed é.txt")
        .unwrap();
    assert_eq!(renamed.old_path.as_deref(), Some("staged.txt"));
    assert!(state
        .files
        .iter()
        .any(|file| file.path == "deleted.txt" && file.mode == "100644"));
    assert!(state
        .files
        .iter()
        .any(|file| file.path == special && file.index_status == "?"));
    let literal = comparison(&temp.project(&root), "file[1].txt", GitSide::Staged).unwrap();
    assert_eq!(literal.before.text.as_deref(), Some("literal before\n"));
    assert_eq!(literal.after.text.as_deref(), Some("literal after\n"));
    let binary = comparison(&temp.project(&root), "binary.bin", GitSide::Staged).unwrap();
    assert_eq!(binary.before.text.as_deref(), Some(""));
    assert_eq!(binary.after.reason.as_deref(), Some("binary"));
    assert_eq!(binary.after.image_data_url, None);
    let staged_image = comparison(&temp.project(&root), "image.png", GitSide::Staged).unwrap();
    assert_eq!(
        staged_image.after.image_data_url.as_deref(),
        Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")
    );
    let image = comparison(&temp.project(&root), "image.png", GitSide::Unstaged).unwrap();
    assert_eq!(
        image.before.image_data_url,
        staged_image.after.image_data_url
    );
    assert_eq!(image.after.reason.as_deref(), Some("binary"));
    assert_eq!(
        image.after.image_data_url.as_deref(),
        Some("data:image/jpeg;base64,/9j/4EpGSUY=")
    );
    let non_utf8 = comparison(&temp.project(&root), "non-utf8.txt", GitSide::Unstaged).unwrap();
    assert_eq!(non_utf8.after.reason.as_deref(), Some("nonUtf8"));
    let large = comparison(&temp.project(&root), "large.txt", GitSide::Unstaged).unwrap();
    assert_eq!(large.after.reason.as_deref(), Some("tooLarge"));
    #[cfg(unix)]
    {
        assert!(state
            .files
            .iter()
            .any(|file| file.path == "link" && file.mode == "120000"));
        let link = comparison(&temp.project(&root), "link", GitSide::Unstaged).unwrap();
        assert_eq!(link.after.reason.as_deref(), Some("symlink"));
        assert_eq!(link.after.text.as_deref(), Some("missing-target"));
        #[cfg(not(target_os = "macos"))]
        assert!(state
            .files
            .iter()
            .any(|file| file.path == "bad\\xFF" && !file.actionable));
    }
}

#[cfg(windows)]
#[test]
fn real_wsl_repository_round_trip_and_clone_opt_in() {
    let Ok(distribution) = std::env::var("SORENO_TEST_WSL_DISTRO") else {
        eprintln!("test opt-in: set SORENO_TEST_WSL_DISTRO to run Windows-to-WSL Git");
        return;
    };
    let fixture = WslRepositoryFixture::new(distribution);
    assert_eq!(
        picker_default_directory(&fixture.environment, Some(&fixture.linux_root))
            .unwrap()
            .unwrap(),
        fixture.unc_root
    );

    let source_linux = format!("{}/source", fixture.linux_root);
    let source_unc = fixture.unc_root.join("source");
    std::fs::create_dir(&source_unc).unwrap();
    let source = fixture.project("wsl-source", "WSL source", source_linux.clone());
    fixture.sessions.save_project(source.clone()).unwrap();
    let initial = repository(&source).unwrap();
    assert_eq!(initial.availability, "notRepository");
    init(&fixture.sessions, &source.id, &initial.version).unwrap();
    fixture.configure(&source);

    let link_linux = format!("{source_linux}/wsl-link");
    fixture.run(&["ln", "-s", "missing-target", &link_linux]);
    let linked = repository(&source).unwrap();
    assert!(linked
        .files
        .iter()
        .any(|file| file.path == "wsl-link" && file.mode == "120000"));
    let link = comparison(&source, "wsl-link", GitSide::Unstaged).unwrap();
    assert_eq!(link.after.reason.as_deref(), Some("symlink"));
    assert_eq!(link.after.text.as_deref(), Some("missing-target"));
    fixture.run(&["rm", "--", &link_linux]);
    assert!(repository(&source).unwrap().files.is_empty());

    let path = "notes [été].txt";
    std::fs::write(source_unc.join(path), b"initial\n").unwrap();
    let version = repository(&source).unwrap().version;
    stage(&fixture.sessions, &source.id, vec![path.into()], &version).unwrap();
    let index_path = source_unc.join(".git/index");
    let index_before_reads = std::fs::read(&index_path).unwrap();
    let staged = comparison(&source, path, GitSide::Staged).unwrap();
    assert_eq!(staged.before.text.as_deref(), Some(""));
    assert_eq!(staged.after.text.as_deref(), Some("initial\n"));
    assert_eq!(repository(&source).unwrap().files.len(), 1);
    assert_eq!(std::fs::read(&index_path).unwrap(), index_before_reads);
    commit(
        &fixture.sessions,
        &source.id,
        "initial".into(),
        &repository(&source).unwrap().version,
    )
    .unwrap();
    assert!(repository(&source).unwrap().files.is_empty());

    std::fs::write(source_unc.join(path), b"changed\n").unwrap();
    let large_path = "large.bin";
    std::fs::File::create(source_unc.join(large_path))
        .unwrap()
        .set_len(1_048_577)
        .unwrap();
    let preview_source = fixture.project("wsl-preview", "WSL preview", source_linux.clone());
    let snapshot = repository(&preview_source).unwrap();
    assert!(snapshot.files.iter().any(|file| file.path == large_path));
    let large = comparison(&preview_source, large_path, GitSide::Unstaged).unwrap();
    assert_eq!(large.after.reason.as_deref(), Some("tooLarge"));

    let cold = preview_comparison(
        &preview_source,
        path,
        GitSide::Unstaged,
        Some(&snapshot.version),
    )
    .unwrap();
    let warm = preview_comparison(
        &preview_source,
        path,
        GitSide::Unstaged,
        Some(&snapshot.version),
    )
    .unwrap();
    let repeated = preview_comparison(
        &preview_source,
        path,
        GitSide::Unstaged,
        Some(&snapshot.version),
    )
    .unwrap();
    for preview in [&cold, &warm, &repeated] {
        assert_eq!(preview.before.text.as_deref(), Some("initial\n"));
        assert_eq!(preview.after.text.as_deref(), Some("changed\n"));
        assert_eq!(preview.version, snapshot.version);
    }

    let index_before_comparison = std::fs::read(&index_path).unwrap();
    let unstaged = comparison(&source, path, GitSide::Unstaged).unwrap();
    assert_eq!(unstaged.before.text.as_deref(), Some("initial\n"));
    assert_eq!(unstaged.after.text.as_deref(), Some("changed\n"));
    assert_eq!(std::fs::read(source_unc.join(path)).unwrap(), b"changed\n");
    assert_eq!(std::fs::read(&index_path).unwrap(), index_before_comparison);
    stage(
        &fixture.sessions,
        &source.id,
        vec![path.into()],
        &repository(&source).unwrap().version,
    )
    .unwrap();
    commit(
        &fixture.sessions,
        &source.id,
        "changed".into(),
        &repository(&source).unwrap().version,
    )
    .unwrap();
    let source_head = read_text(&source, &["rev-parse", "HEAD"]).unwrap();

    let cloned = clone(
        &fixture.sessions,
        GitCloneRequest {
            id: "wsl-clone".into(),
            name: "WSL clone".into(),
            environment: fixture.environment.clone(),
            parent_path: fixture.linux_root.clone(),
            folder_name: "clone sibling".into(),
            url: source_linux,
        },
    )
    .unwrap();
    assert_eq!(cloned.path, format!("{}/clone sibling", fixture.linux_root));
    assert_eq!(
        fixture.sessions.project(&cloned.id).unwrap().environment,
        fixture.environment
    );
    assert_eq!(
        read_text(&cloned, &["rev-parse", "HEAD"]).unwrap(),
        source_head
    );
    assert_eq!(
        execute(
            &cloned,
            &["show", &format!("HEAD:{path}")],
            GitOperation::Read,
            None,
        )
        .unwrap()
        .stdout,
        b"changed\n"
    );
    assert_eq!(
        picker_default_directory(&cloned.environment, Some(&cloned.path))
            .unwrap()
            .unwrap(),
        fixture.unc_root.join("clone sibling")
    );
}

#[test]
fn reports_merge_conflicts_and_merge_message() {
    let temp = TempRepository::new("conflict");
    let root = temp.0.join("repository");
    std::fs::create_dir(&root).unwrap();
    temp.git(&root, &["init"]);
    temp.configure(&root);
    std::fs::write(root.join("conflict.txt"), "base\n").unwrap();
    temp.git(&root, &["add", "conflict.txt"]);
    temp.git(
        &root,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "base",
        ],
    );
    let main = temp.git(&root, &["branch", "--show-current"]);
    temp.git(&root, &["checkout", "-b", "side"]);
    std::fs::write(root.join("conflict.txt"), "side\n").unwrap();
    temp.git(&root, &["add", "conflict.txt"]);
    temp.git(
        &root,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "side",
        ],
    );
    temp.git(&root, &["checkout", &main]);
    std::fs::write(root.join("conflict.txt"), "main\n").unwrap();
    temp.git(&root, &["add", "conflict.txt"]);
    temp.git(
        &root,
        &[
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "commit",
            "-m",
            "main",
        ],
    );
    let merge = Command::new("git")
        .args([
            "-C",
            root.to_str().unwrap(),
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "merge",
            "side",
        ])
        .env("HOME", &temp.0)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", temp.0.join("config"))
        .output()
        .unwrap();
    assert!(!merge.status.success());

    let state = repository(&temp.project(&root)).unwrap();
    assert_eq!(state.operation.as_deref(), Some("merge"));
    assert!(state
        .merge_message
        .as_deref()
        .is_some_and(|message| !message.is_empty()));
    assert!(state
        .files
        .iter()
        .any(|file| file.conflict && file.actionable));
    assert_eq!(
        comparison(&temp.project(&root), "conflict.txt", GitSide::Staged)
            .unwrap_err()
            .code,
        "conflict"
    );
    let conflict = comparison(&temp.project(&root), "conflict.txt", GitSide::Unstaged).unwrap();
    assert_eq!(conflict.before.text.as_deref(), Some("main\n"));
    assert!(conflict
        .after
        .text
        .as_deref()
        .is_some_and(|text| text.starts_with("<<<<<<<")));
    let stages = conflict.conflict_stages.unwrap();
    assert_eq!(
        stages.iter().map(|stage| stage.stage).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(stages[0].content.text.as_deref(), Some("base\n"));
    assert_eq!(stages[1].content.text.as_deref(), Some("main\n"));
    assert_eq!(stages[2].content.text.as_deref(), Some("side\n"));
}
