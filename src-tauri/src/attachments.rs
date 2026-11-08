use base64::Engine;
use chrono::Utc;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const ATTACHMENTS_DIR_NAME: &str = "attachments";
const IMAGES_DIR_NAME: &str = "images";
const FALLBACK_IMAGE_STEM: &str = "image";
const MAX_STEM_LENGTH: usize = 56;
const MAX_STORED_IMAGE_SIZE_BYTES: usize = 15 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImage {
    pub filename: String,
    pub path: String,
}

pub fn attachments_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(ATTACHMENTS_DIR_NAME)
}

pub fn attachment_images_root(app_data_dir: &Path) -> PathBuf {
    attachments_root(app_data_dir).join(IMAGES_DIR_NAME)
}

pub fn save_attachment_image(
    app_data_dir: &Path,
    note_id: &str,
    original_filename: &str,
    mime_type: &str,
    data_base64: &str,
) -> Result<AttachmentImage, String> {
    let extension = extension_for_mime_type(mime_type)?;
    let bytes = decode_base64_payload(data_base64)?;

    if bytes.len() > MAX_STORED_IMAGE_SIZE_BYTES {
        return Err("Optimized image is too large".to_string());
    }

    let images_dir = attachment_images_root(app_data_dir);
    fs::create_dir_all(&images_dir).map_err(|error| error.to_string())?;

    let filename_stem = build_attachment_stem(note_id, original_filename);
    let target_path = write_unique_attachment(&images_dir, &filename_stem, extension, &bytes)?;

    let filename = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(FALLBACK_IMAGE_STEM)
        .to_string();

    Ok(AttachmentImage {
        filename,
        path: target_path.to_string_lossy().into_owned(),
    })
}

pub fn save_encrypted_attachment(
    vault_root: &Path,
    name: &str,
    data_base64: &str,
) -> Result<(), String> {
    if !is_encrypted_attachment_name(name) {
        return Err("Invalid encrypted attachment name".to_string());
    }
    let bytes = decode_base64_payload(data_base64)?;
    // Allows for the encryption envelope around an image at the plaintext size limit.
    if bytes.len() > MAX_STORED_IMAGE_SIZE_BYTES + 1024 {
        return Err("Encrypted image is too large".to_string());
    }

    let images_dir = attachment_images_root(vault_root);
    fs::create_dir_all(&images_dir).map_err(|error| error.to_string())?;
    write_file_exclusively(&images_dir.join(name), &bytes).map_err(|error| error.to_string())
}

pub fn read_attachment_image(vault_root: &Path, name: &str) -> Result<Vec<u8>, String> {
    validate_attachment_name(name)?;
    fs::read(attachment_images_root(vault_root).join(name)).map_err(|error| error.to_string())
}

pub fn delete_attachment_image(vault_root: &Path, name: &str) -> Result<(), String> {
    delete_image_in(&attachment_images_root(vault_root), name)
}

pub(crate) fn delete_image_in(images_dir: &Path, name: &str) -> Result<(), String> {
    validate_attachment_name(name)?;
    match fs::remove_file(images_dir.join(name)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

fn validate_attachment_name(name: &str) -> Result<(), String> {
    let is_plain =
        !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':', '\0']);
    if is_plain {
        Ok(())
    } else {
        Err("Invalid attachment name".to_string())
    }
}

pub(crate) fn is_encrypted_attachment_name(name: &str) -> bool {
    let Some(uuid) = name.strip_suffix(".enc") else {
        return false;
    };
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
}

fn decode_base64_payload(data_base64: &str) -> Result<Vec<u8>, String> {
    let payload = data_base64
        .strip_prefix("data:")
        .and_then(|data_url| data_url.split_once(',').map(|(_, data)| data))
        .unwrap_or(data_base64);

    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("Invalid base64 image data: {error}"))
}

fn extension_for_mime_type(mime_type: &str) -> Result<&'static str, String> {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/gif" => Ok("gif"),
        "image/jpeg" | "image/jpg" => Ok("jpg"),
        "image/png" => Ok("png"),
        "image/webp" => Ok("webp"),
        _ => Err("Unsupported image type".to_string()),
    }
}

fn build_attachment_stem(note_id: &str, original_filename: &str) -> String {
    let timestamp = Utc::now().format("%Y-%m-%d_%H-%M").to_string();
    let note_segment = short_note_id(note_id);
    let image_segment = original_file_stem(original_filename);

    format!("{timestamp}-note-{note_segment}-{image_segment}")
}

fn short_note_id(note_id: &str) -> String {
    let short_id: String = note_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect();

    if short_id.is_empty() {
        "unknown".to_string()
    } else {
        short_id
    }
}

fn original_file_stem(original_filename: &str) -> String {
    let raw_stem = Path::new(original_filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(FALLBACK_IMAGE_STEM);
    let sanitized_stem = sanitize_filename_stem(raw_stem);

    if sanitized_stem.is_empty() {
        FALLBACK_IMAGE_STEM.to_string()
    } else {
        sanitized_stem
    }
}

fn sanitize_filename_stem(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_separator = false;

    for character in value.chars() {
        if output.len() >= MAX_STEM_LENGTH {
            break;
        }

        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
            last_was_separator = false;
        } else if matches!(character, '-' | '_' | '.' | ' ') {
            if !last_was_separator && !output.is_empty() {
                output.push('-');
                last_was_separator = true;
            }
        }
    }

    output.trim_matches('-').to_string()
}

fn write_unique_attachment(
    images_dir: &Path,
    filename_stem: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    for attempt in 1..=999 {
        let target_path =
            attachment_path_for_attempt(images_dir, filename_stem, extension, attempt);

        match write_file_exclusively(&target_path, bytes) {
            Ok(()) => return Ok(target_path),
            Err(AttachmentWriteError::AlreadyExists) => continue,
            Err(AttachmentWriteError::Io(error)) => return Err(error.to_string()),
        }
    }

    let fallback_suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    let target_path = images_dir.join(format!("{filename_stem}-{fallback_suffix}.{extension}"));
    write_file_exclusively(&target_path, bytes).map_err(|error| error.to_string())?;

    Ok(target_path)
}

fn attachment_path_for_attempt(
    images_dir: &Path,
    filename_stem: &str,
    extension: &str,
    attempt: usize,
) -> PathBuf {
    let filename = if attempt == 1 {
        format!("{filename_stem}.{extension}")
    } else {
        format!("{filename_stem}-{attempt}.{extension}")
    };

    images_dir.join(filename)
}

#[derive(Debug)]
enum AttachmentWriteError {
    AlreadyExists,
    Io(io::Error),
}

impl std::fmt::Display for AttachmentWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttachmentWriteError::AlreadyExists => write!(formatter, "Attachment already exists"),
            AttachmentWriteError::Io(error) => write!(formatter, "{error}"),
        }
    }
}

fn write_file_exclusively(path: &Path, bytes: &[u8]) -> Result<(), AttachmentWriteError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                AttachmentWriteError::AlreadyExists
            } else {
                AttachmentWriteError::Io(error)
            }
        })?;

    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(path);
        return Err(AttachmentWriteError::Io(error));
    }
    // The front deletes the original image right after this returns.
    crate::vaults::best_effort_sync_parent_directory(path);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn temp_attachments_dir() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();

        std::env::temp_dir().join(format!("soreno-attachments-test-{id}"))
    }

    fn encode(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn save_attachment_image_creates_images_directory() {
        let dir = temp_attachments_dir();
        let result = save_attachment_image(
            &dir,
            "note-1234567890",
            "Capture 01.png",
            "image/webp",
            &encode(b"webp-bytes"),
        )
        .expect("save attachment");

        assert!(Path::new(&result.path).exists());
        assert!(Path::new(&result.path).starts_with(attachments_root(&dir).join(IMAGES_DIR_NAME)));
        assert!(result.filename.contains("note-note1234-capture-01"));
        assert!(result.filename.ends_with(".webp"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_attachment_image_avoids_filename_collisions() {
        let dir = temp_attachments_dir();
        let first = save_attachment_image(
            &dir,
            "note-abc",
            "photo.png",
            "image/webp",
            &encode(b"first"),
        )
        .expect("save first");
        let second = save_attachment_image(
            &dir,
            "note-abc",
            "photo.png",
            "image/webp",
            &encode(b"second"),
        )
        .expect("save second");

        assert_ne!(first.filename, second.filename);
        assert!(second.filename.ends_with("-2.webp"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_attachment_image_rejects_invalid_base64() {
        let dir = temp_attachments_dir();
        let error = save_attachment_image(&dir, "note-1", "photo.png", "image/webp", "not-base64")
            .unwrap_err();

        assert!(error.contains("Invalid base64"));
    }

    #[test]
    fn save_attachment_image_rejects_non_image_types() {
        let dir = temp_attachments_dir();
        let error =
            save_attachment_image(&dir, "note-1", "photo.txt", "text/plain", &encode(b"text"))
                .unwrap_err();

        assert!(error.contains("Unsupported image type"));
    }

    #[test]
    fn save_attachment_image_sanitizes_dangerous_names() {
        let dir = temp_attachments_dir();
        let result = save_attachment_image(
            &dir,
            "../",
            "../My Photo (Final).png",
            "image/webp",
            &encode(b"webp-bytes"),
        )
        .expect("save attachment");

        assert!(result.filename.contains("note-unknown-my-photo-final"));
        assert!(!result.filename.contains(".."));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn attachment_names_reject_path_traversal() {
        for name in ["../x", "a/b", "a\\b", "..", ".", "", "C:x"] {
            assert!(validate_attachment_name(name).is_err(), "{name:?}");
        }
        for name in ["0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b.enc", "photo-2.webp"] {
            assert!(validate_attachment_name(name).is_ok(), "{name:?}");
        }
    }

    #[test]
    fn encrypted_attachment_round_trips_and_rejects_bad_names() {
        let dir = temp_attachments_dir();
        let name = "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b.enc";
        for bad in [
            "../0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b.enc",
            "0F8E2C1A-3B4D-4E5F-8A9B-0C1D2E3F4A5B.enc",
            "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b.png",
            "photo.enc",
        ] {
            assert!(
                save_encrypted_attachment(&dir, bad, &encode(b"x")).is_err(),
                "{bad:?}"
            );
        }

        save_encrypted_attachment(&dir, name, &encode(b"cipher")).expect("save");
        assert!(save_encrypted_attachment(&dir, name, &encode(b"other")).is_err());
        assert_eq!(read_attachment_image(&dir, name).unwrap(), b"cipher");
        delete_attachment_image(&dir, name).expect("delete");
        delete_attachment_image(&dir, name).expect("delete missing");
        assert!(read_attachment_image(&dir, name).is_err());

        let _ = fs::remove_dir_all(dir);
    }
}
