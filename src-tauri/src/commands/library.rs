use crate::{
    app_state::{sync_attachment_asset_scope, AppState},
    attachments::{self, AttachmentImage},
    note_types::{self, NoteType},
    notes::{self, Note},
    tasks::{self, Task},
    vaults,
};
use tauri::State;

#[tauri::command]
pub(crate) fn list_notes(state: State<'_, AppState>) -> Result<Vec<Note>, String> {
    state.with_db(notes::list_notes)
}

#[tauri::command]
pub(crate) fn create_note(
    id: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<Note, String> {
    state.with_db(|db| notes::create_note(db, &id, &kind))
}

#[tauri::command]
pub(crate) fn update_note(
    id: String,
    title: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<Note, String> {
    state.with_db(|db| notes::update_note(db, &id, &title, &content))
}

#[tauri::command]
pub(crate) fn update_note_kind(
    id: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<Note, String> {
    state.with_db(|db| notes::update_note_kind(db, &id, &kind))
}

#[tauri::command]
pub(crate) fn update_note_archived(
    id: String,
    archived: bool,
    state: State<'_, AppState>,
) -> Result<Note, String> {
    state.with_db(|db| notes::update_note_archived(db, &id, archived))
}

#[tauri::command]
pub(crate) fn update_note_pinned(
    id: String,
    pinned: bool,
    state: State<'_, AppState>,
) -> Result<Note, String> {
    state.with_db(|db| notes::update_note_pinned(db, &id, pinned))
}

#[tauri::command]
pub(crate) fn update_note_favorite(
    id: String,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<Note, String> {
    state.with_db(|db| notes::update_note_favorite(db, &id, favorite))
}

#[tauri::command]
pub(crate) fn delete_note(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.with_db(|db| notes::delete_note(db, &id))
}

#[tauri::command]
pub(crate) fn list_tasks(state: State<'_, AppState>) -> Result<Vec<Task>, String> {
    state.with_db(tasks::list_tasks)
}

#[tauri::command]
pub(crate) fn create_task(
    id: String,
    title: String,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Task, String> {
    state.with_db(|db| {
        tasks::create_task(
            db,
            &id,
            &title,
            status.as_deref().unwrap_or(tasks::DEFAULT_TASK_STATUS),
        )
    })
}

#[tauri::command]
pub(crate) fn update_task_title(
    id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<Task, String> {
    state.with_db(|db| tasks::update_task_title(db, &id, &title))
}

#[tauri::command]
pub(crate) fn update_task_status(
    id: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<Task, String> {
    state.with_db(|db| tasks::update_task_status(db, &id, &status))
}

#[tauri::command]
pub(crate) fn update_task_priority(
    id: String,
    priority: i64,
    state: State<'_, AppState>,
) -> Result<Task, String> {
    state.with_db(|db| tasks::update_task_priority(db, &id, priority))
}

#[tauri::command]
pub(crate) fn update_task_attached_note(
    id: String,
    note_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Task, String> {
    state.with_db(|db| tasks::update_task_attached_note(db, &id, note_id.as_deref()))
}

#[tauri::command]
pub(crate) fn delete_task(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.with_db(|db| tasks::delete_task(db, &id))
}

#[tauri::command]
pub(crate) fn list_note_types(state: State<'_, AppState>) -> Result<Vec<NoteType>, String> {
    state.with_db(note_types::list_note_types)
}

#[tauri::command]
pub(crate) fn create_note_type(
    id: String,
    name: String,
    icon: String,
    color: String,
    state: State<'_, AppState>,
) -> Result<NoteType, String> {
    state.with_db(|db| note_types::create_note_type(db, &id, &name, &icon, &color))
}

#[tauri::command]
pub(crate) fn update_note_type(
    id: String,
    name: String,
    icon: String,
    color: String,
    state: State<'_, AppState>,
) -> Result<NoteType, String> {
    state.with_db(|db| note_types::update_note_type(db, &id, &name, &icon, &color))
}

#[tauri::command]
pub(crate) fn reorder_note_types(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<NoteType>, String> {
    let mut vault_state = state.lock_vaults()?;

    note_types::reorder_note_types(&mut vault_state.db, &ids).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn delete_note_type(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.with_db(|db| note_types::delete_note_type(db, &id))
}

#[tauri::command]
pub(crate) fn save_attachment_image(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    original_filename: String,
    mime_type: String,
    data_base64: String,
) -> Result<AttachmentImage, String> {
    let app_dir = {
        let vault_state = state.lock_vaults()?;
        vaults::vault_root(
            &vault_state.app_data_dir,
            &vault_state.vault_state.active_vault_id,
        )?
    };

    sync_attachment_asset_scope(&app, &app_dir)?;
    attachments::save_attachment_image(
        &app_dir,
        &note_id,
        &original_filename,
        &mime_type,
        &data_base64,
    )
}
