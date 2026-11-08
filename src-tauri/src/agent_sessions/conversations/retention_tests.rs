use super::*;
use crate::agent_sessions::tests::unique_temp_path;

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

#[test]
fn only_unreferenced_directories_idle_for_the_retention_period_are_purged() {
    let now = SystemTime::now();
    let idle = Some(now - RETENTION);
    assert!(purgeable(false, idle, now));
    assert!(!purgeable(true, idle, now), "latest run of a session");
    assert!(!purgeable(false, Some(now - RETENTION + DAY), now));
    assert!(!purgeable(false, None, now), "unreadable or symlink");
    assert!(!purgeable(false, Some(now + DAY), now), "clock moved back");
}

#[test]
fn local_purge_keeps_referenced_recent_and_foreign_entries() {
    let links = unique_temp_path("soreno-launch-retention");
    let run = |digit: char| digit.to_string().repeat(32);
    for name in [run('1'), run('2'), run('3'), "notes".into()] {
        std::fs::create_dir_all(links.join(name)).unwrap();
    }
    // A file still written after the purge horizon keeps its run directory.
    let later = SystemTime::now() + RETENTION + DAY;
    std::fs::File::create(links.join(run('3')).join("metadata.json"))
        .unwrap()
        .set_modified(later)
        .unwrap();

    purge_local(&links, &HashSet::from([run('1')]), later).unwrap();

    assert!(links.join(run('1')).exists(), "referenced");
    assert!(!links.join(run('2')).exists(), "idle orphan");
    assert!(links.join(run('3')).exists(), "recent file");
    assert!(links.join("notes").exists(), "not a run directory");
    std::fs::remove_dir_all(links).unwrap();
}

#[test]
fn remote_names_come_only_from_mktemp_directories() {
    assert_eq!(
        remote_name("/home/u/.cache/soreno/agent.AbCd12345678/metadata.json"),
        Some("agent.AbCd12345678")
    );
    assert_eq!(
        remote_name("/home/u/.cache/soreno/agent.AbCd12345678"),
        None
    );
    assert_eq!(
        remote_name("/home/u/agent.Ab'd12345678/metadata.json"),
        None
    );
    assert_eq!(remote_name("/home/u/agent.short/metadata.json"), None);
}

#[cfg(unix)]
#[test]
fn remote_purge_spares_referenced_live_and_active_directories() {
    let home = unique_temp_path("soreno-remote-retention");
    let base = home.join(".cache/soreno");
    let directory = |token: &str| base.join(format!("agent.{}", token.repeat(12)));
    let session = base.join("sessions/key");
    std::fs::create_dir_all(&session).unwrap();
    std::fs::write(
        session.join("agent"),
        format!("{}\n", directory("l").display()),
    )
    .unwrap();
    for token in ["o", "r", "l", "a", "n"] {
        std::fs::create_dir_all(directory(token)).unwrap();
        std::fs::write(directory(token).join("metadata.json"), "{}").unwrap();
    }
    let age = |path: PathBuf| {
        assert!(std::process::Command::new("touch")
            .args(["-t", "202001010000"])
            .arg(path)
            .status()
            .unwrap()
            .success());
    };
    for token in ["o", "r", "l"] {
        age(directory(token).join("metadata.json"));
    }
    for token in ["o", "r", "l", "a"] {
        age(directory(token));
    }

    let run = |script: &str| {
        let output = std::process::Command::new("sh")
            .args(["-c", script])
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    };
    let create = create_remote_script(Some(&[format!("agent.{}", "r".repeat(12))]));

    let legacy = base.join("sessions/legacy");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(legacy.join("socket"), "").unwrap();
    run(&create);
    assert!(directory("o").exists(), "session without agent pointer");
    std::fs::remove_dir_all(legacy).unwrap();

    let created = run(&create);
    assert!(Path::new(created.trim_end()).is_dir(), "{created}");
    assert!(!directory("o").exists(), "idle orphan");
    assert!(directory("r").exists(), "latest run of a session");
    assert!(directory("l").exists(), "live dtach session");
    assert!(directory("a").exists(), "recent file");
    assert!(directory("n").exists(), "recent directory");

    run(&remove_remote_script(&[format!(
        "agent.{}",
        "a".repeat(12)
    )]));
    assert!(!directory("a").exists(), "deleted session");
    assert!(directory("n").exists());
    std::fs::remove_dir_all(home).unwrap();
}
