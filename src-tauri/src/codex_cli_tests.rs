use super::*;
use std::{
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn codex_home_ignores_only_unix_overrides_on_windows() {
    use std::ffi::OsStr;
    let home = Path::new("native-user");
    for configured in [
        None,
        Some(OsStr::new("")),
        Some(OsStr::new("/home/ada/.codex")),
    ] {
        assert_eq!(
            codex_home_from(configured, Some(home), true),
            Some(home.join(".codex"))
        );
    }
    for configured in [
        r"C:\Users\Ada\.codex",
        "D:/custom-codex",
        r"\\server\share\codex",
        "//server/share/codex",
        "relative-codex",
    ] {
        assert_eq!(
            codex_home_from(Some(OsStr::new(configured)), Some(home), true),
            Some(PathBuf::from(configured))
        );
    }
    for configured in ["/home/ada/.codex", "/Users/ada/custom-codex"] {
        assert_eq!(
            codex_home_from(Some(OsStr::new(configured)), Some(home), false),
            Some(PathBuf::from(configured))
        );
    }
    assert_eq!(
        codex_home_from(Some(OsStr::new("/home/ada/.codex")), None, true),
        None
    );
    let command = codex_command(Path::new("codex"));
    let expected = codex_home();
    assert!(command.get_envs().any(
        |(key, value)| key == "CODEX_HOME" && value == expected.as_deref().map(Path::as_os_str)
    ));
}

#[test]
fn discovery_preserves_order_and_falls_back_after_lookup_failures() {
    let root = std::env::temp_dir().join(format!(
        "soreno-codex-discovery-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let binary = root.join("codex.exe");
    std::fs::write(&binary, "fixture").unwrap();
    std::fs::set_permissions(
        &binary,
        std::fs::metadata(std::env::current_exe().unwrap())
            .unwrap()
            .permissions(),
    )
    .unwrap();
    let shells = vec![
        root.join("missing-shell"),
        root.join("shell-a"),
        root.join("shell-b"),
    ];
    for shell in &shells[1..] {
        std::fs::write(shell, "fixture").unwrap();
    }
    // Each possible winner: PATH, first shell, second shell, then candidates.
    for winner in 0..=3 {
        let mut calls = 0;
        let result = find_codex_binary_with(
            shells.clone(),
            vec![binary.clone()],
            |command, _timeout, capture| {
                assert!(capture);
                if calls == 0 {
                    assert_eq!(
                        command.get_program(),
                        if cfg!(windows) { "where" } else { "which" }
                    );
                    assert_eq!(command.get_args().collect::<Vec<_>>(), ["codex"]);
                } else {
                    assert_eq!(command.get_program(), shells[calls].as_os_str());
                    assert_eq!(
                        command.get_args().collect::<Vec<_>>(),
                        ["-lc", "command -v codex"]
                    );
                }
                let step = calls;
                calls += 1;
                if step == winner {
                    Ok(format!("{}\n", binary.display()))
                } else if step == 1 {
                    Err("CODEX_UPDATE_TIMEOUT".into())
                } else {
                    Err(process::failed("lookup failed"))
                }
            },
        )
        .unwrap();
        assert_eq!(result, Some(binary.clone()));
        assert_eq!(calls, (winner + 1).min(3));
    }
    let absent = find_codex_binary_with(vec![], vec![root.join("missing")], |_, _, _| {
        Ok(String::new())
    });
    assert_eq!(absent.unwrap(), None);
    let unusable = find_codex_binary_with(vec![], vec![root.clone()], |_, _, _| {
        Err("CODEX_UPDATE_TIMEOUT".into())
    });
    assert_eq!(
        unusable.unwrap_err(),
        format!(
            "Codex CLI binary found at {} but it is not executable",
            root.display()
        )
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "subprocess fixture for long_prompt_travels_over_stdin_and_closes_at_eof"]
fn stdin_fixture() {
    if std::env::var_os("SORENO_CODEX_STDIN_TEST").is_none() {
        return;
    }
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    assert_eq!(input, "private é".repeat(200_000));
}

#[test]
fn long_prompt_travels_over_stdin_and_closes_at_eof() {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--ignored", "--exact", "codex_cli::tests::stdin_fixture"])
        .env("SORENO_CODEX_STDIN_TEST", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let prompt = "private é".repeat(200_000);
    assert!(!command
        .get_args()
        .any(|arg| arg.to_string_lossy().contains("private")));
    let mut child = command.spawn().unwrap();
    write_prompt(child.stdin.take(), &prompt).unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn resolves_packaged_native_cli_without_node() {
    let root = std::env::temp_dir().join(format!(
        "soreno-codex-native-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let package = root.join("node_modules/@openai/codex");
    let script = package.join("bin/codex.js");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(&script, "#!/usr/bin/env node\n").unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#).unwrap();
    assert!(native_codex_binary(&script).is_err());
    let (triple, platform) =
        codex_native_platform(std::env::consts::OS, std::env::consts::ARCH).unwrap();
    let native = root
        .join("node_modules/@openai")
        .join(format!("codex-{platform}"))
        .join("vendor")
        .join(triple)
        .join("codex")
        .join(if cfg!(windows) { "codex.exe" } else { "codex" });
    std::fs::create_dir_all(native.parent().unwrap()).unwrap();
    std::fs::copy(std::env::current_exe().unwrap(), &native).unwrap();
    assert_eq!(
        native_codex_binary(&script).unwrap(),
        std::fs::canonicalize(&native).unwrap()
    );
    let current = native
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("bin")
        .join(native.file_name().unwrap());
    std::fs::create_dir_all(current.parent().unwrap()).unwrap();
    std::fs::copy(&native, &current).unwrap();
    assert_eq!(
        native_codex_binary(&script).unwrap(),
        std::fs::canonicalize(&current).unwrap()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn resolves_current_and_legacy_layouts_nested_before_hoisted_before_bundled() {
    let root = std::env::temp_dir().join(format!(
        "soreno-codex-layouts-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let permissions = std::fs::metadata(std::env::current_exe().unwrap())
        .unwrap()
        .permissions();
    for os in [std::env::consts::OS, "windows"] {
        let (triple, platform) = codex_native_platform(os, "x86_64").unwrap();
        for layout in ["bin", "codex"] {
            let fixture = root.join(os).join(layout);
            let package = fixture.join("node_modules/@openai/codex");
            let relative =
                PathBuf::from("vendor")
                    .join(triple)
                    .join(layout)
                    .join(if os == "windows" {
                        "codex.exe"
                    } else {
                        "codex"
                    });
            let bundled = package.join(&relative);
            let hoisted = fixture
                .join("node_modules/@openai")
                .join(format!("codex-{platform}"))
                .join(&relative);
            let nested = package
                .join("node_modules/@openai")
                .join(format!("codex-{platform}"))
                .join(&relative);
            for expected in [&bundled, &hoisted, &nested] {
                std::fs::create_dir_all(expected.parent().unwrap()).unwrap();
                std::fs::write(expected, b"MZ00").unwrap();
                std::fs::set_permissions(expected, permissions.clone()).unwrap();
                assert_eq!(
                    packaged_native_codex_binary(&package, os, "x86_64").unwrap(),
                    *expected
                );
                if os == "windows" {
                    assert_eq!(expected.file_name().unwrap(), "codex.exe");
                }
            }
            std::fs::remove_dir_all(fixture).unwrap();
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn model_cache_exposes_only_visible_models_in_codex_priority_order() {
    let models = models_from_cache(
        r#"{
                "models": [
                    {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","priority":2},
                    {"slug":"hidden-model","display_name":"Hidden","visibility":"hide","priority":0},
                    {"slug":"gpt-6","display_name":"GPT-6","visibility":"list","priority":1}
                ]
            }"#,
    )
    .expect("parse models");

    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-6", "gpt-5.5"]
    );
}

#[test]
fn model_cache_uses_slug_when_display_name_is_missing() {
    let models = models_from_cache(r#"{"models":[{"slug":"gpt-5.4","visibility":"list"}]}"#)
        .expect("parse models");

    assert_eq!(models[0].display_name, "gpt-5.4");
}

#[test]
fn windows_path_lookup_preserves_path_order_for_supported_commands() {
    let dir = std::env::temp_dir().join(format!("soreno-codex-path-test-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let extensionless = dir.join("codex");
    let cmd = dir.join("codex.cmd");
    let exe = dir.join("codex.exe");
    std::fs::write(&extensionless, "").unwrap();
    std::fs::write(&cmd, "").unwrap();
    std::fs::write(&exe, "").unwrap();
    let stdout = format!(
        "{}\n{}\n{}\n",
        extensionless.display(),
        cmd.display(),
        exe.display()
    );

    assert_eq!(first_existing_path_for_platform(&stdout, true), Some(cmd));

    let _ = std::fs::remove_file(extensionless);
    let _ = std::fs::remove_file(dir.join("codex.cmd"));
    let _ = std::fs::remove_file(dir.join("codex.exe"));
    let _ = std::fs::remove_dir(dir);
}

#[cfg(windows)]
#[test]
fn windows_cmd_shim_runs_node_script_directly() {
    let dir = std::env::temp_dir().join(format!("soreno-codex-shim-test-{}", std::process::id()));
    let target = dir
        .join("node_modules")
        .join("@openai")
        .join("codex")
        .join("bin")
        .join("codex.js");
    let node = dir.join("node.exe");
    let shim = dir.join("codex.cmd");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "console.log('codex')").unwrap();
    std::fs::write(&node, "").unwrap();
    std::fs::write(
        &shim,
        r#"@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe" "%~dp0\node_modules\@openai\codex\bin\codex.js" %*
) ELSE (
  node "%~dp0\node_modules\@openai\codex\bin\codex.js" %*
)"#,
    )
    .unwrap();

    let target_command = command_target_avoiding_windows_shim(&shim);

    assert_eq!(target_command.program, node);
    assert_eq!(target_command.first_arg, Some(target));

    let _ = std::fs::remove_file(shim);
    let _ = std::fs::remove_file(node);
    let _ = std::fs::remove_file(dir.join("node_modules/@openai/codex/bin/codex.js"));
    let _ = std::fs::remove_dir_all(dir.join("node_modules"));
    let _ = std::fs::remove_dir(dir);
}
