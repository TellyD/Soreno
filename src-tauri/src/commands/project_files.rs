use crate::{
    agent_sessions::AgentSessions,
    project_files::{
        self, ProjectFileContent, ProjectFileEntry, ProjectFileError, ProjectFileKind,
        ProjectFileListing, ProjectFileSearchResult, ProjectFileWriteResult,
        ProjectTextSearchOptions, ProjectTextSearchResult,
    },
};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::DialogExt;

async fn with_project<T: Send + 'static>(
    app: AppHandle,
    project_id: String,
    action: impl FnOnce(&crate::agent_sessions::AgentProject) -> Result<T, ProjectFileError>
        + Send
        + 'static,
) -> Result<T, ProjectFileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = app
            .state::<AgentSessions>()
            .project(&project_id)
            .map_err(|message| ProjectFileError {
                code: "project".into(),
                message,
            })?;
        action(&project)
    })
    .await
    .map_err(|error| ProjectFileError {
        code: "internal".into(),
        message: error.to_string(),
    })?
}

#[tauri::command]
pub(crate) async fn project_files_list(
    app: AppHandle,
    project_id: String,
    directory: String,
) -> Result<ProjectFileListing, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::list(project, &directory)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_search(
    app: AppHandle,
    project_id: String,
    query: String,
    refresh: Option<bool>,
    recent: Option<Vec<String>>,
) -> Result<ProjectFileSearchResult, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::search_with_refresh(
            project,
            &query,
            refresh.unwrap_or(false),
            &recent.unwrap_or_default(),
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_search_text(
    app: AppHandle,
    project_id: String,
    query: String,
    options: ProjectTextSearchOptions,
    refresh: Option<bool>,
) -> Result<ProjectTextSearchResult, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::search_text(project, &query, options, refresh.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_read(
    app: AppHandle,
    project_id: String,
    path: String,
) -> Result<ProjectFileContent, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::read(project, &path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_write(
    app: AppHandle,
    project_id: String,
    path: String,
    content: String,
    expected_version: String,
) -> Result<ProjectFileWriteResult, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::write(project, &path, content, &expected_version)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_create(
    app: AppHandle,
    project_id: String,
    path: String,
    kind: ProjectFileKind,
) -> Result<ProjectFileEntry, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::create(project, &path, kind)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_rename(
    app: AppHandle,
    project_id: String,
    from: String,
    to: String,
) -> Result<ProjectFileEntry, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::rename(project, &from, &to)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_delete(
    app: AppHandle,
    project_id: String,
    path: String,
) -> Result<(), ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::delete(project, &path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_duplicate(
    app: AppHandle,
    project_id: String,
    path: String,
) -> Result<ProjectFileEntry, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::duplicate(project, &path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files_paste(
    app: AppHandle,
    project_id: String,
    directory: String,
) -> Result<Vec<ProjectFileEntry>, ProjectFileError> {
    with_project(app, project_id, move |project| {
        project_files::import_files(project, &directory, &clipboard_files()?)
    })
    .await
}

/// The destination comes from the native dialog, never from the webview.
#[tauri::command]
pub(crate) async fn project_files_download(
    app: AppHandle,
    window: Window,
    project_id: String,
    path: String,
) -> Result<bool, ProjectFileError> {
    let picker = app.clone();
    with_project(app, project_id, move |project| {
        let name = path.rsplit('/').next().unwrap_or(&path);
        let mut dialog = picker
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(name);
        if let Ok(directory) = picker.path().download_dir() {
            dialog = dialog.set_directory(directory);
        }
        let Some(destination) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let destination = destination.into_path().map_err(|_| ProjectFileError {
            code: "path".into(),
            message: "Le sélecteur n’a pas retourné un chemin local.".into(),
        })?;
        project_files::download(project, &path, &destination)?;
        Ok(true)
    })
    .await
}

fn clipboard_files() -> Result<Vec<std::path::PathBuf>, ProjectFileError> {
    let unavailable = |error: arboard::Error| ProjectFileError {
        code: "clipboard".into(),
        message: error.to_string(),
    };
    let files = match arboard::Clipboard::new()
        .map_err(unavailable)?
        .get()
        .file_list()
    {
        Err(arboard::Error::ContentNotAvailable) => Vec::new(),
        files => files.map_err(unavailable)?,
    };
    if files.is_empty() {
        return Err(ProjectFileError {
            code: "clipboardEmpty".into(),
            message: "Le presse-papiers ne contient aucun fichier.".into(),
        });
    }
    #[cfg(target_os = "linux")]
    let files = files.into_iter().map(without_uri_list_cr).collect();
    Ok(files)
}

// arboard 3.6 splits `text/uri-list` on `\n` only, leaving the `\r` of RFC 2483 CRLF lists.
#[cfg(target_os = "linux")]
fn without_uri_list_cr(path: std::path::PathBuf) -> std::path::PathBuf {
    use std::os::unix::ffi::OsStrExt;
    match path.as_os_str().as_bytes().strip_suffix(b"\r") {
        Some(trimmed) if path.symlink_metadata().is_err() => {
            std::ffi::OsStr::from_bytes(trimmed).into()
        }
        _ => path,
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::without_uri_list_cr;

    #[test]
    fn clipboard_paths_drop_the_uri_list_carriage_return() {
        let dir = std::env::temp_dir().join(format!(
            "soreno-clipboard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("a.png");
        std::fs::write(&file, "a").unwrap();

        let mut with_cr = file.clone().into_os_string();
        with_cr.push("\r");
        assert_eq!(without_uri_list_cr(with_cr.into()), file);
        assert_eq!(without_uri_list_cr(file.clone()), file);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
