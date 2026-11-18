use serde::Serialize;
use tauri::{ipc::Channel, Manager, Resource, ResourceId, Webview};
use tauri_plugin_updater::Update;

// Same shape as the updater plugin's private event, so the frontend handler is shared.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

struct RpmPackage(Vec<u8>);
impl Resource for RpmPackage {}

// The plugin installs with a bare `rpm -U`, which RPM 6 (Fedora 45+) refuses for packages
// without a GPG signature; `Update::download` already checked the minisign signature.
#[tauri::command]
pub(crate) async fn download_rpm_update(
    webview: Webview,
    rid: ResourceId,
    on_event: Channel<DownloadEvent>,
) -> Result<ResourceId, String> {
    let update = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|error| error.to_string())?;
    let mut started = false;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(webview.resources_table().add(RpmPackage(bytes)))
}

#[tauri::command]
pub(crate) async fn install_rpm_update(webview: Webview, rid: ResourceId) -> Result<(), String> {
    // Kept in the table so a retry after a dismissed password prompt reuses the download.
    let package = webview
        .resources_table()
        .get::<RpmPackage>(rid)
        .map_err(|error| error.to_string())?;
    // User-owned directory: root installs this file, so it must not sit in a shared /tmp.
    let dir = webview
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    super::run_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        // shortcut: fixed path, two Soreno instances updating at once can delete each other's package; use a unique temp dir if that shows up.
        let path = dir.join("update.rpm");
        std::fs::write(&path, &package.0).map_err(|error| error.to_string())?;
        // shortcut: pkexec only, no zenity/sudo fallback like the plugin; add one if an RPM desktop without polkit reports it.
        let status = std::process::Command::new("pkexec")
            .args(["rpm", "-U", "--nosignature"])
            .arg(&path)
            .status();
        let _ = std::fs::remove_file(&path);
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("rpm update failed: {status}")),
            Err(error) => Err(format!("cannot run pkexec: {error}")),
        }
    })
    .await
}
