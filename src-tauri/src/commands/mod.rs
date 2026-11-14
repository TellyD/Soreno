pub(crate) mod agents;
pub(crate) mod attention;
pub(crate) mod codex;
pub(crate) mod design;
pub(crate) mod diagnostics;
pub(crate) mod forge;
pub(crate) mod kanban;
pub(crate) mod library;
pub(crate) mod linear;
pub(crate) mod note_encryption;
pub(crate) mod project_files;
pub(crate) mod project_git;
pub(crate) mod release_notes;
pub(crate) mod settings;
pub(crate) mod skills;
pub(crate) mod usage;
pub(crate) mod vaults;

async fn run_blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|error| error.to_string())?
}
