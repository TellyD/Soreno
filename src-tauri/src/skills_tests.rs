use super::*;
use crate::agent_sessions::tests::unique_temp_path;
use std::path::Path;

fn temp_root(label: &str) -> PathBuf {
    let root = unique_temp_path(&format!("soreno-skills-{label}"));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn write_skill(root: &Path, directory: &str, name: &str, content: &str) {
    let skill = root.join(directory).join(name);
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), content).unwrap();
}

fn entry(directory: &str, name: &str, skill_md: &str) -> RawSkillEntry {
    RawSkillEntry {
        directory: directory.into(),
        name: name.into(),
        skill_md: skill_md.into(),
    }
}

fn raw_listing(scope: SkillScope, entries: Vec<RawSkillEntry>, lock: Option<&str>) -> RawListing {
    RawListing {
        directories: SkillDirectories::default_for(scope),
        entries,
        lock: lock.map(str::to_owned),
    }
}

fn skill<'a>(inventory: &'a SkillInventory, name: &str) -> &'a InstalledSkill {
    inventory
        .skills
        .iter()
        .find(|skill| skill.name == name)
        .unwrap()
}

#[test]
fn frontmatter_reads_plain_quoted_and_block_values() {
    assert_eq!(
        frontmatter_fields("---\nname: Pdf tools\ndescription: Extract text: fast.\n---\n# Body"),
        (Some("Pdf tools".into()), Some("Extract text: fast.".into()))
    );
    assert_eq!(
        frontmatter_fields("---\nname: \"Quoted \\\"name\\\"\"\ndescription: 'It''s here'\n---\n"),
        (Some("Quoted \"name\"".into()), Some("It's here".into()))
    );
    assert_eq!(
        frontmatter_fields(
            "\u{feff}---\nname: folded\ndescription: >-\n  First line\n  second line.\n\n  Third.\nlicense: MIT\n---\n"
        ),
        (
            Some("folded".into()),
            Some("First line second line. Third.".into())
        )
    );
    assert_eq!(
        frontmatter_fields("---\ndescription: |\n  Literal\n  block\nname: x\n---"),
        (Some("x".into()), Some("Literal block".into()))
    );
    assert_eq!(
        frontmatter_fields("---\nnames: wrong\ndescription: \"\"\n---\n"),
        (None, None)
    );
    assert_eq!(
        frontmatter_fields("# No frontmatter\nname: body"),
        (None, None)
    );
    assert_eq!(
        frontmatter_fields("---\nname: unterminated\n"),
        (None, None)
    );
}

#[test]
fn sanitize_mirrors_cli_directory_names() {
    assert_eq!(
        sanitize_skill_name("Vercel React Best Practices"),
        "vercel-react-best-practices"
    );
    assert_eq!(sanitize_skill_name("..--Foo__Bar!!v1.2"), "foo__bar-v1.2");
    assert_eq!(sanitize_skill_name("!!!"), "unnamed-skill");
    assert_eq!(sanitize_skill_name(&"a".repeat(300)).len(), 255);
}

#[test]
fn inventory_dedups_by_name_and_matches_lock_sources() {
    let lock = r#"{"version":3,"skills":{
        "Shared Skill":{"source":"acme/skills","sourceType":"github","sourceUrl":"https://github.com/acme/skills.git"},
        "local-one":{"source":"../mine","sourceType":"local"},
        "pkg":{"source":"pkg","sourceType":"node_modules"},
        "broken":{"sourceType":"github"}
    }}"#;
    let inventory = build_inventory(raw_listing(
        SkillScope::Global,
        vec![
            entry(".claude/skills", "shared-skill", "---\nname: Ignored\n---"),
            entry(
                ".agents/skills",
                "shared-skill",
                "---\nname: beta\ndescription: Shared.\n---",
            ),
            entry(".codex/skills", "local-one", "---\nname: Alpha\n---"),
            entry(".pi/agent/skills", "pkg", ""),
            entry(".omp/agent/skills", "zeta", "---\nname: alpha\n---"),
            entry(".agents/skills", "broken", ""),
        ],
        Some(lock),
    ));
    let names: Vec<_> = inventory
        .skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect();
    assert_eq!(
        names,
        ["local-one", "zeta", "shared-skill", "broken", "pkg"]
    );

    let shared = skill(&inventory, "shared-skill");
    assert_eq!(shared.title, "beta");
    assert_eq!(shared.description.as_deref(), Some("Shared."));
    assert_eq!(
        shared.source,
        Some(SkillSource {
            lock_name: "Shared Skill".into(),
            source: "acme/skills".into(),
            source_type: "github".into(),
            source_url: Some("https://github.com/acme/skills.git".into()),
        })
    );
    assert!(skill(&inventory, "local-one").source.is_some());
    assert_eq!(skill(&inventory, "pkg").title, "pkg");
    assert!(skill(&inventory, "broken").source.is_none());
}

#[test]
fn project_inventory_uses_project_cli_directories_and_ignores_invalid_lock() {
    let inventory = build_inventory(raw_listing(
        SkillScope::Project,
        vec![
            entry(".claude/skills", "a", ""),
            entry(".pi/skills", "b", ""),
            entry(".agents/skills", "b", ""),
            entry(".omp/skills", "c", ""),
        ],
        Some("{not json"),
    ));
    let names: Vec<_> = inventory
        .skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect();
    assert_eq!(names, ["a", "b", "c"]);
    assert!(inventory.skills.iter().all(|skill| skill.source.is_none()));
    assert_eq!(
        serde_json::to_value(skill(&inventory, "a")).unwrap(),
        serde_json::json!({
            "name": "a", "title": "a", "description": null, "source": null
        })
    );
}

#[test]
fn remote_listing_parser_accepts_frames_and_rejects_corruption() {
    let output =
        b"L\0{\"skills\":{}}\0S\0.claude/skills\0pdf\0---\nname: P\n---\0S\0.agents/skills\0x\0\0";
    let listing = remote::parse_listing(SkillScope::Project, output).unwrap();
    assert_eq!(listing.lock.as_deref(), Some("{\"skills\":{}}"));
    assert_eq!(
        listing.entries,
        [
            entry(".claude/skills", "pdf", "---\nname: P\n---"),
            entry(".agents/skills", "x", ""),
        ]
    );
    assert_eq!(
        remote::parse_listing(SkillScope::Global, b"").unwrap(),
        raw_listing(SkillScope::Global, Vec::new(), None)
    );
    let relocated = remote::parse_listing(
        SkillScope::Global,
        b"G\0/opt/claude/skills\0.codex/skills\0S\0/opt/claude/skills\0pdf\0\0",
    )
    .unwrap();
    assert_eq!(
        relocated.directories,
        SkillDirectories::global("/opt/claude/skills".into(), ".codex/skills".into())
    );
    assert_eq!(relocated.entries, [entry("/opt/claude/skills", "pdf", "")]);
    for corrupt in [
        &b"S\0.claude/skills\0pdf\0trunc"[..],
        b"S\0.claude/skills\0pdf\0",
        b"L\0",
        b"X\0data\0",
        b"\0\0",
        b"S\0.codex/skills\0pdf\0\0",
        b"G\0.claude/skills\0.codex/skills\0",
        b"S\0.claude/skills\0a/b\0\0",
    ] {
        assert_eq!(
            remote::parse_listing(SkillScope::Project, corrupt)
                .unwrap_err()
                .code,
            "io"
        );
    }
}

#[test]
fn global_directories_follow_agent_environment() {
    use std::ffi::OsStr;

    let base = std::env::temp_dir().join("soreno-skills-environment");
    let home = base.join("me");
    let outside = base.join("opt claude");
    let defaults = SkillDirectories::default_for(SkillScope::Global);
    assert_eq!(local::global_directories(&home, None, None), defaults);
    assert_eq!(
        local::global_directories(&home, Some(OsStr::new(" \t")), Some(OsStr::new(""))),
        defaults
    );
    let codex = home.join(".codex-work");
    let relocated = local::global_directories(
        &home,
        Some(OsStr::new(&format!(" {} ", outside.display()))),
        Some(codex.as_os_str()),
    );
    let absolute = outside.join("skills").display().to_string();
    assert_eq!(
        relocated.listed,
        [
            ".agents/skills",
            absolute.as_str(),
            ".codex-work/skills",
            ".pi/agent/skills",
            ".omp/agent/skills"
        ]
    );
    let relative = local::global_directories(
        &home,
        Some(OsStr::new("./claude alt")),
        Some(OsStr::new(".agents")),
    );
    assert_eq!(
        relative.listed[..2],
        [".agents/skills", "claude alt/skills"],
        "a CODEX_HOME of ~/.agents shares the agents directory"
    );
    let normalized = |configured: &str| {
        local::global_directories(&home, Some(OsStr::new(configured)), None).listed[1].clone()
    };
    assert_eq!(normalized("a/../claude"), "claude/skills");
    assert_eq!(normalized("./x"), "x/skills");
    assert_eq!(normalized("x//./"), "x/skills");
    assert_eq!(normalized("../me/.claude"), ".claude/skills");
    let dotted = base
        .join("me")
        .join("..")
        .join("x")
        .join("..")
        .join("opt claude");
    assert_eq!(normalized(&dotted.display().to_string()), absolute);
}

#[cfg(windows)]
#[test]
fn normalize_lexically_keeps_drive_relative_parents() {
    let normalized = |path: &str| local::normalize_lexically(Path::new(path));
    assert_eq!(normalized(r"C:..\claude"), PathBuf::from(r"C:..\claude"));
    assert_eq!(normalized(r"C:\..\claude"), PathBuf::from(r"C:\claude"));
    assert_eq!(normalized(r"C:\a\..\b"), PathBuf::from(r"C:\b"));
}

#[test]
fn local_lister_reads_relocated_global_directories() {
    let home = temp_root("local-global");
    let outside = temp_root("local-global-claude");
    write_skill(&outside, "skills", "pdf", "---\nname: Pdf\n---");
    write_skill(&home, ".claude/skills", "legacy", "");
    write_skill(&home, ".codex/skills", "codex", "");
    let directories = local::global_directories(&home, Some(outside.as_os_str()), None);
    let inventory =
        build_inventory(local::read_listing(SkillScope::Global, &home, directories).unwrap());
    let names: Vec<_> = inventory
        .skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect();
    assert_eq!(
        names,
        ["codex", "pdf"],
        "legacy ~/.claude/skills is not listed"
    );
    std::fs::remove_dir_all(home).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[test]
fn local_lister_reads_project_root() {
    let root = temp_root("local");
    write_skill(
        &root,
        ".agents/skills",
        "alpha",
        "---\nname: Alpha\ndescription: >\n  Does\n  things.\n---\n",
    );
    write_skill(&root, ".omp/skills", "beta", "no frontmatter");
    write_skill(&root, ".claude/skills", ".system", "---\nname: hidden\n---");
    std::fs::create_dir_all(root.join(".claude/skills/empty")).unwrap();
    std::fs::write(
        root.join("skills-lock.json"),
        r#"{"skills":{"alpha":{"source":"acme/alpha","sourceType":"github"}}}"#,
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        "../../.agents/skills/alpha",
        root.join(".claude/skills/alpha"),
    )
    .unwrap();

    let inventory = build_inventory(local::list(SkillScope::Project, &root).unwrap());
    let names: Vec<_> = inventory
        .skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect();
    assert_eq!(names, ["alpha", "beta"]);
    let alpha = skill(&inventory, "alpha");
    assert_eq!(alpha.title, "Alpha");
    assert_eq!(alpha.description.as_deref(), Some("Does things."));
    assert!(alpha.source.is_some());

    let missing = local::list(SkillScope::Project, &root.join("missing")).unwrap_err();
    assert_eq!(missing.code, "missingDirectory");
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
fn run_sh(script: &str, home: &Path, path: &str) -> std::process::Output {
    std::process::Command::new("/bin/sh")
        .args(["-c", script])
        .current_dir(if home.is_dir() {
            home
        } else {
            home.parent().unwrap()
        })
        .env_clear()
        .env("HOME", home)
        .env("PATH", path)
        .env("SHELL", "/bin/false")
        .output()
        .unwrap()
}

#[cfg(unix)]
#[test]
fn remote_list_script_reads_hostile_root_literally() {
    use std::os::unix::fs::symlink;

    let base = temp_root("remote-list");
    let root = base.join("it's $(touch pwned) `id`");
    write_skill(&root, ".claude/skills", "pdf", "---\nname: Pdf\0x\n---\n");
    write_skill(&root, ".pi/skills", ".hidden", "---\nname: h\n---");
    std::fs::create_dir_all(root.join(".agents/skills")).unwrap();
    symlink(
        root.join(".claude/skills/pdf"),
        root.join(".agents/skills/pdf"),
    )
    .unwrap();
    std::fs::write(root.join("skills-lock.json"), "{\"skills\":{}}").unwrap();

    let script = remote::list_script(
        SkillScope::Project,
        &RemoteRoot::Path(root.to_str().unwrap().into()),
    );
    let output = run_sh(&script, &base, "/usr/bin:/bin");
    assert!(output.status.success(), "{output:?}");
    let listing = remote::parse_listing(SkillScope::Project, &output.stdout).unwrap();
    assert_eq!(
        listing.entries,
        [
            entry(".agents/skills", "pdf", "---\nname: Pdfx\n---\n"),
            entry(".claude/skills", "pdf", "---\nname: Pdfx\n---\n"),
        ]
    );
    assert!(!base.join("pwned").exists());

    let missing = run_sh(
        &remote::list_script(SkillScope::Global, &RemoteRoot::Home),
        &base.join("nope"),
        "/usr/bin:/bin",
    );
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("SORENO_SKILLS_MISSING_ROOT"));
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(unix)]
#[test]
fn remote_list_script_follows_agent_environment() {
    let base = temp_root("remote-env");
    let home = base.join("home");
    let outside = base.join("claude 'conf' $(id)");
    write_skill(&outside, "skills", "pdf", "---\nname: Pdf\n---");
    write_skill(&home, ".codex-alt/skills", "cx", "");
    write_skill(&home, ".claude/skills", "legacy", "");
    let output = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            &remote::list_script(SkillScope::Global, &RemoteRoot::Home),
        ])
        .current_dir(&base)
        .env_clear()
        .env("HOME", &home)
        .env("PATH", "/usr/bin:/bin")
        .env("CLAUDE_CONFIG_DIR", format!(" {}/ \t", outside.display()))
        .env("CODEX_HOME", ".codex-alt")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let listing = remote::parse_listing(SkillScope::Global, &output.stdout).unwrap();
    let absolute = format!("{}/skills", outside.display());
    assert_eq!(
        listing.directories,
        SkillDirectories::global(absolute.clone(), ".codex-alt/skills".into())
    );
    assert_eq!(
        listing.entries,
        [
            entry(&absolute, "pdf", "---\nname: Pdf\n---"),
            entry(".codex-alt/skills", "cx", ""),
        ]
    );

    let dotted = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            &remote::list_script(SkillScope::Global, &RemoteRoot::Home),
        ])
        .current_dir(&base)
        .env_clear()
        .env("HOME", &home)
        .env("PATH", "/usr/bin:/bin")
        .env(
            "CLAUDE_CONFIG_DIR",
            format!("{}/alias/../../claude 'conf' $(id)/./", home.display()),
        )
        .env("CODEX_HOME", "alias/../.claude")
        .output()
        .unwrap();
    assert!(dotted.status.success(), "{dotted:?}");
    let listing = remote::parse_listing(SkillScope::Global, &dotted.stdout).unwrap();
    assert_eq!(
        listing.directories,
        SkillDirectories::global(absolute.clone(), ".claude/skills".into())
    );
    assert_eq!(
        listing.entries,
        [
            entry(&absolute, "pdf", "---\nname: Pdf\n---"),
            entry(".claude/skills", "legacy", ""),
        ]
    );

    let unset = run_sh(
        &remote::list_script(SkillScope::Global, &RemoteRoot::Home),
        &home,
        "/usr/bin:/bin",
    );
    let listing = remote::parse_listing(SkillScope::Global, &unset.stdout).unwrap();
    assert_eq!(
        listing.directories,
        SkillDirectories::default_for(SkillScope::Global)
    );
    assert_eq!(listing.entries, [entry(".claude/skills", "legacy", "")]);
    std::fs::remove_dir_all(base).unwrap();
}
