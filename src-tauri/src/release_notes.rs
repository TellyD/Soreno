use std::{fs, io, path::Path};

use crate::vaults::vaults_root;

const LAST_SEEN_VERSION_FILE: &str = "last-seen-version";

/// Must run before `init_app_state` creates the vault directory: its absence is what
/// tells a fresh install apart from an update of a version without release notes.
pub fn record_fresh_install(app_data_dir: &Path, version: &str) -> Result<(), String> {
    let marker_exists = app_data_dir
        .join(LAST_SEEN_VERSION_FILE)
        .try_exists()
        .map_err(|error| error.to_string())?;
    let vaults_exist = vaults_root(app_data_dir)
        .try_exists()
        .map_err(|error| error.to_string())?;
    if marker_exists || vaults_exist {
        return Ok(());
    }
    mark_version_seen(app_data_dir, version)
}

pub fn last_seen_version(app_data_dir: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(app_data_dir.join(LAST_SEEN_VERSION_FILE)) {
        Ok(contents) => Ok(Some(contents.trim().to_owned()).filter(|version| !version.is_empty())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn mark_version_seen(app_data_dir: &Path, version: &str) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    fs::write(app_data_dir.join(LAST_SEEN_VERSION_FILE), version).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_dir(name: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("soreno-release-notes-{name}-{id}"))
    }

    #[test]
    fn fresh_install_starts_with_the_current_version_seen() {
        let dir = temp_dir("fresh");
        record_fresh_install(&dir, "0.5.0").unwrap();
        assert_eq!(last_seen_version(&dir).unwrap().as_deref(), Some("0.5.0"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_from_a_version_without_release_notes_has_no_seen_version() {
        let dir = temp_dir("legacy");
        fs::create_dir_all(vaults_root(&dir)).unwrap();
        record_fresh_install(&dir, "0.5.0").unwrap();
        assert_eq!(last_seen_version(&dir).unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_interrupted_mid_catalog_write_has_no_seen_version() {
        let dir = temp_dir("catalog-backup");
        fs::create_dir_all(vaults_root(&dir)).unwrap();
        fs::write(dir.join("vaults.json.bak"), "{}").unwrap();
        record_fresh_install(&dir, "0.5.0").unwrap();
        assert_eq!(last_seen_version(&dir).unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn webview_data_alone_does_not_hide_a_fresh_install() {
        let dir = temp_dir("webview");
        fs::create_dir_all(dir.join("WebKitCache")).unwrap();
        fs::write(dir.join("storage"), "").unwrap();
        record_fresh_install(&dir, "0.5.0").unwrap();
        assert_eq!(last_seen_version(&dir).unwrap().as_deref(), Some("0.5.0"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn startup_keeps_the_version_seen_before_the_update() {
        let dir = temp_dir("update");
        mark_version_seen(&dir, "0.4.9").unwrap();
        record_fresh_install(&dir, "0.5.0").unwrap();
        assert_eq!(last_seen_version(&dir).unwrap().as_deref(), Some("0.4.9"));
        mark_version_seen(&dir, "0.5.0").unwrap();
        assert_eq!(last_seen_version(&dir).unwrap().as_deref(), Some("0.5.0"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
