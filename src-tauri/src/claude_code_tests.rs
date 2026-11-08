use super::*;
use std::fs;

fn executable(path: &Path) {
    fs::write(path, "fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn auth(email: &str) -> String {
    format!(
        "{{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\",\n  \"email\": \"{email}\",\n  \"orgId\": \"org-1\",\n  \"subscriptionType\": \"team\"\n}}\n"
    )
}

fn usage(rows: &str) -> String {
    format!(
        "{{\"type\":\"system\",\"subtype\":\"init\",\"tools\":[\"Bash\"]}}\n{{\"type\":\"assistant\",\"message\":{{\"content\":[]}},\"usage_report\":{{\"rate_limits\":{{\"limits\":[{rows}]}}}}}}\n{{\"type\":\"result\",\"subtype\":\"success\"}}\n"
    )
}

const SESSION_ROW: &str = r#"{"kind":"session","group":"session","percent":60.4,"resets_at":"2026-10-12T16:59:59.737127+00:00","scope":null}"#;

#[test]
fn finds_claude_in_path_shell_then_candidates() {
    let root = std::env::temp_dir().join(format!("soreno-claude-find-{}", std::process::id()));
    let binary = root.join("claude");
    let windows_binary = root.join("claude.exe");
    let shell = root.join("shell");
    fs::create_dir_all(&root).unwrap();
    executable(&binary);
    executable(&windows_binary);
    executable(&shell);

    for winner in 0..=2 {
        let mut calls = 0;
        let found =
            find_claude_binary_with(false, vec![shell.clone()], vec![binary.clone()], |_| {
                calls += 1;
                (calls == winner + 1).then(|| binary.to_string_lossy().into_owned())
            });
        assert_eq!(found, Some(binary.clone()));
        assert_eq!(calls, (winner + 1).min(2));
    }
    assert_eq!(
        find_claude_binary_with(true, vec![shell], vec![windows_binary.clone()], |_| None),
        Some(windows_binary)
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reads_account_and_usage_rows_through_login_shell_noise() {
    let rows = [
        SESSION_ROW,
        r#"{"kind":"weekly_all","group":"weekly","percent":120,"resets_at":null,"scope":null}"#,
        r#"{"kind":"weekly_scoped","group":"weekly","percent":2,"resets_at":"2026-10-13T10:59:59Z","scope":{"model":{"display_name":"Opus"},"surface":null}}"#,
        r#"{"kind":"weekly_scoped","group":"weekly","percent":9,"resets_at":null,"scope":{"model":null,"surface":{"display_name":"Cowork"}}}"#,
        r#"{"kind":"future_meter","group":"other","percent":50,"resets_at":null,"scope":null}"#,
    ]
    .join(",");
    let output = format!(
        "Welcome to devbox {{motd}}\n{}{}",
        auth("A@x.com"),
        usage(&rows)
    );

    let probe = parse_probe(&output);

    assert_eq!(
        probe.profile,
        Some(ClaudeProfile {
            id: "org-1:a@x.com".into(),
            email: Some("A@x.com".into()),
        })
    );
    assert!(!probe.signed_out);
    assert_eq!(
        probe.limits,
        Some(ClaudeRateLimits {
            primary: Some(ClaudeRateLimitWindow {
                used_percent: 60,
                window_duration_mins: 300,
                resets_at: Some(1_791_824_399),
            }),
            secondary: Some(ClaudeRateLimitWindow {
                used_percent: 100,
                window_duration_mins: 10_080,
                resets_at: None,
            }),
            models: vec![ClaudeModelRateLimit {
                model: "Opus".into(),
                window: ClaudeRateLimitWindow {
                    used_percent: 2,
                    window_duration_mins: 10_080,
                    resets_at: Some(1_791_889_199),
                },
            }],
            stale: false,
            expired: false,
        })
    );
}

#[test]
fn failed_or_signed_out_probes_keep_the_last_reading_of_the_same_account() {
    let key = "test:fallback";
    let fresh = format!("{}{}", auth("a@x.com"), usage(SESSION_ROW));
    let first = account_usage(key, Some(&fresh)).unwrap();
    assert!(!first.limits.stale);

    let failed = account_usage(key, None).unwrap();
    assert_eq!(failed.profile, first.profile);
    assert!(failed.limits.stale && !failed.limits.expired);
    assert_eq!(failed.limits.primary, first.limits.primary);

    let signed_out = account_usage(key, Some("{\"loggedIn\": false}")).unwrap();
    assert!(signed_out.limits.stale && signed_out.limits.expired);
    assert_eq!(signed_out.limits.primary, first.limits.primary);

    let other_account = account_usage(key, Some(&auth("b@x.com"))).unwrap();
    assert_eq!(other_account.profile.unwrap().id, "org-1:b@x.com");
    assert!(!other_account.limits.has_windows());
    assert_eq!(account_usage(key, None), None);

    account_usage(key, Some(&fresh)).unwrap();
    let refreshed = account_usage(key, Some(&auth("A@x.com"))).unwrap();
    assert_eq!(refreshed.profile.unwrap().email.as_deref(), Some("A@x.com"));
    assert!(refreshed.limits.stale && !refreshed.limits.expired);
    assert_eq!(refreshed.limits.primary, first.limits.primary);

    let no_meters = account_usage(key, Some(&format!("{}{}", auth("a@x.com"), usage("")))).unwrap();
    assert!(!no_meters.limits.has_windows() && !no_meters.limits.stale);
    assert_eq!(account_usage(key, None), None);
}
