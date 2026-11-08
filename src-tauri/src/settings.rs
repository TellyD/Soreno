use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

// ponytail: one process-wide lock; use per-directory locks if settings I/O becomes concurrent across profiles.
static SETTINGS_IO: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LanguagePreference {
    System,
    Fr,
    En,
}

impl Default for LanguagePreference {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

impl Default for ThemePreference {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalThemePreference {
    App,
    Light,
    Dark,
}

impl Default for TerminalThemePreference {
    fn default() -> Self {
        Self::App
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitMessageStyle {
    #[default]
    Imperative,
    Conventional,
    Detailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub language_preference: LanguagePreference,
    #[serde(default)]
    pub theme_preference: ThemePreference,
    #[serde(default)]
    pub terminal_theme_preference: TerminalThemePreference,
    #[serde(default)]
    pub codex_git_model: Option<String>,
    #[serde(default = "enabled")]
    pub codex_git_fast_mode: bool,
    #[serde(default)]
    pub codex_git_commit_style: CommitMessageStyle,
    #[serde(default)]
    pub codex_usage_account_id: Option<String>,
    #[serde(default)]
    pub claude_usage_account_id: Option<String>,
    #[serde(default)]
    pub hidden_agent_presets: Vec<String>,
    #[serde(default = "default_hidden_chat_commands")]
    pub hidden_chat_commands: Vec<String>,
    #[serde(default)]
    pub terminal_log_enabled: bool,
    #[serde(default = "enabled")]
    pub agent_notifications_enabled: bool,
    #[serde(default)]
    pub material_file_icons_enabled: bool,
    #[serde(default = "default_note_lock_minutes")]
    pub note_lock_minutes: u32,
}

fn enabled() -> bool {
    true
}

fn default_note_lock_minutes() -> u32 {
    10
}

// OMP bundles these commands; they stay hidden until the user shows them in the chat's `/` menu.
fn default_hidden_chat_commands() -> Vec<String> {
    ["autoresearch", "green", "annotate"]
        .map(String::from)
        .to_vec()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language_preference: LanguagePreference::System,
            theme_preference: ThemePreference::System,
            terminal_theme_preference: TerminalThemePreference::App,
            codex_git_model: None,
            codex_git_fast_mode: true,
            codex_git_commit_style: CommitMessageStyle::Imperative,
            codex_usage_account_id: None,
            claude_usage_account_id: None,
            hidden_agent_presets: Vec::new(),
            hidden_chat_commands: default_hidden_chat_commands(),
            terminal_log_enabled: false,
            agent_notifications_enabled: true,
            material_file_icons_enabled: false,
            note_lock_minutes: default_note_lock_minutes(),
        }
    }
}

impl AppSettings {
    pub fn git_codex_model(&self) -> Option<&str> {
        self.codex_git_model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
    }
}

pub fn read_settings(app_data_dir: &Path) -> Result<AppSettings, String> {
    let _guard = SETTINGS_IO.lock().map_err(|error| error.to_string())?;
    read_settings_unlocked(app_data_dir)
}

fn read_settings_unlocked(app_data_dir: &Path) -> Result<AppSettings, String> {
    let primary = settings_path(app_data_dir);
    let mut invalid = None;
    for candidate in [
        primary.clone(),
        app_data_dir.join("settings.json.tmp"),
        app_data_dir.join("settings.json.bak"),
    ] {
        let contents = match fs::read_to_string(&candidate) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{}: {error}", candidate.display())),
        };
        match serde_json::from_str::<AppSettings>(&contents) {
            Ok(settings) => {
                if candidate != primary {
                    if primary.try_exists().map_err(|error| error.to_string())? {
                        preserve_invalid_settings(&primary)?;
                    }
                    fs::rename(&candidate, &primary).map_err(|error| error.to_string())?;
                    sync_settings_directory(app_data_dir);
                }
                return Ok(settings);
            }
            Err(error) => {
                let message = format!("Invalid settings {}: {error}", candidate.display());
                eprintln!("{message}");
                invalid = Some(message);
            }
        }
    }
    match invalid {
        Some(error) => Err(error),
        None => Ok(AppSettings::default()),
    }
}

pub fn write_settings(app_data_dir: &Path, settings: AppSettings) -> Result<AppSettings, String> {
    let _guard = SETTINGS_IO.lock().map_err(|error| error.to_string())?;
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;

    // Recover an interrupted write first, and never silently replace invalid settings.
    read_settings_unlocked(app_data_dir)?;
    let primary = settings_path(app_data_dir);
    let temporary = app_data_dir.join("settings.json.tmp");
    let backup = app_data_dir.join("settings.json.bak");
    for path in [&temporary, &backup] {
        if path.try_exists().map_err(|error| error.to_string())? {
            let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
            if serde_json::from_str::<AppSettings>(&contents).is_err() {
                preserve_invalid_settings(path)?;
            }
        }
    }
    let contents = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(contents.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(file);
    let had_primary = primary.try_exists().map_err(|error| error.to_string())?;
    if had_primary {
        if backup.try_exists().map_err(|error| error.to_string())? {
            fs::remove_file(&backup).map_err(|error| error.to_string())?;
        }
        fs::rename(&primary, &backup).map_err(|error| error.to_string())?;
        sync_settings_directory(app_data_dir);
    }
    if let Err(error) = fs::rename(&temporary, &primary) {
        if had_primary {
            fs::rename(&backup, &primary).map_err(|restore| {
                format!("Settings promotion failed: {error}; restore failed: {restore}")
            })?;
        }
        return Err(error.to_string());
    }
    sync_settings_directory(app_data_dir);
    Ok(settings)
}

fn preserve_invalid_settings(path: &Path) -> Result<(), String> {
    for suffix in 0.. {
        let preserved = path.with_extension(format!("invalid-{suffix}"));
        if !preserved.try_exists().map_err(|error| error.to_string())? {
            fs::rename(path, &preserved).map_err(|error| error.to_string())?;
            eprintln!("Invalid settings preserved at {}", preserved.display());
            return Ok(());
        }
    }
    unreachable!()
}

fn sync_settings_directory(path: &Path) {
    #[cfg(unix)]
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_settings_dir() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();

        std::env::temp_dir().join(format!("soreno-settings-test-{id}"))
    }

    #[test]
    fn read_settings_returns_default_when_file_is_missing() {
        let dir = temp_settings_dir();

        assert_eq!(
            read_settings(&dir).expect("read settings"),
            AppSettings::default()
        );
    }

    #[test]
    fn write_settings_persists_preferences() {
        let dir = temp_settings_dir();
        let settings = AppSettings {
            language_preference: LanguagePreference::En,
            theme_preference: ThemePreference::Dark,
            terminal_theme_preference: TerminalThemePreference::Light,
            codex_git_model: Some("gpt-5.4-mini".into()),
            codex_git_fast_mode: false,
            codex_git_commit_style: CommitMessageStyle::Conventional,
            codex_usage_account_id: Some("account:dev@example.com".into()),
            claude_usage_account_id: Some("source:local".into()),
            hidden_agent_presets: vec!["pi".into()],
            hidden_chat_commands: Vec::new(),
            terminal_log_enabled: true,
            agent_notifications_enabled: false,
            material_file_icons_enabled: true,
            note_lock_minutes: 30,
        };

        write_settings(&dir, settings).expect("write settings");
        let loaded_settings = read_settings(&dir).expect("read settings");

        assert_eq!(loaded_settings.language_preference, LanguagePreference::En);
        assert_eq!(loaded_settings.theme_preference, ThemePreference::Dark);
        assert_eq!(
            loaded_settings.terminal_theme_preference,
            TerminalThemePreference::Light
        );
        assert_eq!(loaded_settings.git_codex_model(), Some("gpt-5.4-mini"));
        assert_eq!(
            loaded_settings.codex_usage_account_id.as_deref(),
            Some("account:dev@example.com")
        );
        assert_eq!(
            loaded_settings.claude_usage_account_id.as_deref(),
            Some("source:local")
        );
        assert_eq!(loaded_settings.hidden_agent_presets, ["pi"]);
        assert!(loaded_settings.hidden_chat_commands.is_empty());
        assert!(!loaded_settings.agent_notifications_enabled);
        assert!(!loaded_settings.codex_git_fast_mode);
        assert_eq!(
            loaded_settings.codex_git_commit_style,
            CommitMessageStyle::Conventional
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn git_codex_model_is_unset_unless_a_model_is_chosen() {
        for unset in [None, Some(" ".to_string())] {
            let settings = AppSettings {
                codex_git_model: unset,
                ..AppSettings::default()
            };
            assert_eq!(settings.git_codex_model(), None);
        }
        let settings = AppSettings {
            codex_git_model: Some(" gpt-5.4-mini ".into()),
            ..AppSettings::default()
        };
        assert_eq!(settings.git_codex_model(), Some("gpt-5.4-mini"));
    }

    #[test]
    fn read_settings_keeps_language_from_older_files_without_theme() {
        let dir = temp_settings_dir();
        fs::create_dir_all(&dir).expect("create settings dir");
        fs::write(settings_path(&dir), r#"{"languagePreference":"en"}"#)
            .expect("write legacy settings");

        let settings = read_settings(&dir).expect("read settings");

        assert_eq!(settings.language_preference, LanguagePreference::En);
        assert_eq!(settings.theme_preference, ThemePreference::System);
        assert_eq!(
            settings.terminal_theme_preference,
            TerminalThemePreference::App
        );
        assert!(settings.agent_notifications_enabled);
        assert!(settings.codex_git_fast_mode);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_settings_ignores_keys_of_retired_settings() {
        let dir = temp_settings_dir();
        fs::create_dir_all(&dir).expect("create settings dir");
        fs::write(
            settings_path(&dir),
            r#"{"assistantProvider":"codex","codexAssistantStatus":"available","codexAssistantVersion":"codex-cli 1.2.3","codexModel":"gpt-5.4","codexReasoningEffort":"xhigh","codexSpeedMode":"fast","languagePreference":"en","codexGitModel":"gpt-5.4-mini"}"#,
        )
        .expect("write legacy settings");

        let settings = read_settings(&dir).expect("read settings");

        assert_eq!(settings.language_preference, LanguagePreference::En);
        assert_eq!(settings.git_codex_model(), Some("gpt-5.4-mini"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_recover_interrupted_writes_and_keep_invalid_copies() {
        let dir = temp_settings_dir();
        let original = AppSettings::default();
        write_settings(&dir, original.clone()).unwrap();
        let changed = AppSettings {
            theme_preference: ThemePreference::Dark,
            ..original.clone()
        };
        write_settings(&dir, changed.clone()).unwrap();
        assert_eq!(
            serde_json::from_str::<AppSettings>(
                &fs::read_to_string(dir.join("settings.json.bak")).unwrap()
            )
            .unwrap(),
            original
        );
        fs::rename(settings_path(&dir), dir.join("settings.json.tmp")).unwrap();
        assert_eq!(read_settings(&dir).unwrap(), changed);
        fs::write(settings_path(&dir), "broken").unwrap();
        assert_eq!(read_settings(&dir).unwrap(), original);
        assert_eq!(
            fs::read_to_string(dir.join("settings.invalid-0")).unwrap(),
            "broken"
        );
        fs::write(dir.join("settings.json.tmp"), "partial").unwrap();
        write_settings(&dir, changed.clone()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("settings.json.invalid-0")).unwrap(),
            "partial"
        );
        assert_eq!(read_settings(&dir).unwrap(), changed);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_write_failure_keeps_primary_readable() {
        let dir = temp_settings_dir();
        write_settings(&dir, AppSettings::default()).unwrap();
        fs::create_dir(dir.join("settings.json.tmp")).unwrap();
        assert!(write_settings(
            &dir,
            AppSettings {
                theme_preference: ThemePreference::Dark,
                ..AppSettings::default()
            }
        )
        .is_err());
        assert_eq!(read_settings(&dir).unwrap(), AppSettings::default());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn read_settings_preserves_and_reports_invalid_file() {
        let dir = temp_settings_dir();
        fs::create_dir_all(&dir).expect("create settings dir");
        fs::write(settings_path(&dir), "{").expect("write invalid settings");
        assert!(read_settings(&dir).is_err());
        assert!(write_settings(&dir, AppSettings::default()).is_err());
        assert_eq!(fs::read_to_string(settings_path(&dir)).unwrap(), "{");

        let _ = fs::remove_dir_all(dir);
    }
}
