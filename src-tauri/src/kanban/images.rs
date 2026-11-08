use super::{new_id, sql, Result};
use crate::project_files::media::valid_image_signature;
use rusqlite::{params, Connection};
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use tauri::Manager;

pub(crate) const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
pub(crate) const IMAGE_TOO_LARGE_MESSAGE: &str =
    "[Kanban/imageTooLarge] Les images sont limitées à 25 Mo.";
pub(crate) const IMAGE_TYPE_MESSAGE: &str =
    "[Kanban/imageType] Seules les images PNG, JPEG, GIF ou WebP peuvent être ajoutées.";
pub(crate) const IMAGE_NOT_FOUND_MESSAGE: &str = "[Kanban/imageNotFound] Image introuvable.";
// Mirrors KANBAN_PROMPT_IMAGE_LIMIT in src/domain/kanbanAgent.ts.
pub(crate) const MAX_PROMPT_IMAGES: usize = 6;
const DIRECTORY: &str = "kanban-images";
const INVALID_NAME_MESSAGE: &str = "[Kanban/invalidImageName] Nom d’image invalide.";
const EXTENSIONS: [&str; 4] = ["png", "jpg", "gif", "webp"];
const ABANDON_DELAY: Duration = Duration::from_secs(24 * 60 * 60);

pub(crate) fn directory(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DIRECTORY)
}

pub(crate) fn allow_asset_scope(app: &tauri::AppHandle, app_data_dir: &Path) -> Result<()> {
    let directory = directory(app_data_dir);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&directory, true)
        .map_err(|error| error.to_string())
}

/// The extension and media type the signature of `bytes` gives, if a supported image.
pub(crate) fn image_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("gif", "image/gif"),
        ("webp", "image/webp"),
    ]
    .into_iter()
    .find(|(_, media_type)| valid_image_signature(media_type, bytes))
}

/// `<32 lowercase hex>.<extension>`, the only names Soreno gives Kanban images.
fn name_extension(name: &str) -> Option<&str> {
    let (stem, extension) = name.split_once('.')?;
    (stem.len() == 32
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && EXTENSIONS.contains(&extension))
    .then_some(extension)
}

/// Stores an uploaded image, not yet owned by an issue; returns its absolute path.
pub(crate) fn save_upload(db: &Connection, directory: &Path, bytes: &[u8]) -> Result<PathBuf> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(IMAGE_TOO_LARGE_MESSAGE.into());
    }
    let (extension, content_type) = image_type(bytes).ok_or(IMAGE_TYPE_MESSAGE)?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let file_name = format!("{}.{extension}", new_id(db)?);
    let path = directory.join(&file_name);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|error| {
            let _ = std::fs::remove_file(&path);
            error.to_string()
        })?;
    db.execute(
        "INSERT INTO kanban_images(id, issue_id, file_name, content_type, size, created_at)
        VALUES (lower(hex(randomblob(16))), NULL, ?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![file_name, content_type, bytes.len() as i64],
    )
    .map_err(|error| {
        let _ = std::fs::remove_file(&path);
        sql(error)
    })?;
    Ok(path)
}

/// Drops uploads no issue claimed within a day: the delay spares a create dialog still open.
/// Also reclaims files whose row never committed (failed commit, crash after the write).
pub(crate) fn purge_abandoned_uploads(db: &mut Connection, directory: &Path) -> Result<()> {
    let tx = db.transaction().map_err(sql)?;
    let files = tx
        .prepare(
            "DELETE FROM kanban_images
            WHERE issue_id IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
            RETURNING file_name",
        )
        .map_err(sql)?
        .query_map([], |row| row.get(0))
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(sql)?;
    let known = tx
        .prepare("SELECT file_name FROM kanban_images")
        .map_err(sql)?
        .query_map([], |row| row.get(0))
        .map_err(sql)?
        .collect::<rusqlite::Result<HashSet<String>>>()
        .map_err(sql)?;
    tx.commit().map_err(sql)?;
    remove_files(directory, &files);
    remove_orphan_files(directory, &known);
    Ok(())
}

/// Best effort, and only past the grace delay so an upload awaiting its row is never touched.
fn remove_orphan_files(directory: &Path, known: &HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let Some(cutoff) = SystemTime::now().checked_sub(ABANDON_DELAY) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name_extension(&name).is_none() || known.contains(&name) {
            continue;
        }
        let stale = entry.metadata().is_ok_and(|metadata| {
            metadata.is_file() && metadata.modified().is_ok_and(|modified| modified < cutoff)
        });
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub(crate) fn image_path(directory: &Path, name: &str) -> Result<PathBuf> {
    name_extension(name).ok_or(INVALID_NAME_MESSAGE)?;
    Ok(directory.join(name))
}

/// Reads the image to attach to an agent prompt, with the extension its name gives.
pub(crate) fn read_prompt_image(directory: &Path, name: &str) -> Result<(String, Vec<u8>)> {
    let extension = name_extension(name).ok_or(INVALID_NAME_MESSAGE)?;
    let bytes = std::fs::read(directory.join(name)).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(IMAGE_TOO_LARGE_MESSAGE.into());
    }
    Ok((extension.to_owned(), bytes))
}

/// Best effort: a file left behind is only wasted space.
pub(crate) fn remove_files(directory: &Path, names: &[String]) {
    for name in names {
        if name_extension(name).is_some() {
            let _ = std::fs::remove_file(directory.join(name));
        }
    }
}

#[cfg(test)]
#[path = "images_tests.rs"]
mod tests;
