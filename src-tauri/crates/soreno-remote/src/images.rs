//! Images sent from the phone, saved where the agent of the session can read them.
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

/// The limit of Soreno desktop for a pasted image.
pub const IMAGE_LIMIT: usize = 4 << 20;
/// The base64 text of the largest image.
pub const ENCODED_LIMIT: usize = IMAGE_LIMIT.div_ceil(3) * 4;
const NAME_ATTEMPTS: usize = 16;
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

fn extension(mime_type: &str, bytes: &[u8]) -> Option<&'static str> {
    match mime_type {
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some("png"),
        "image/jpeg" if bytes.starts_with(b"\xff\xd8\xff") => Some("jpg"),
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Some("gif"),
        "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            Some("webp")
        }
        _ => None,
    }
}

/// `<session>/clipboard/image-<token>/image.<ext>`, where Soreno desktop puts a pasted image:
/// the session directory goes away with the session.
pub fn save(session: &Path, mime_type: &str, data: &str) -> Option<PathBuf> {
    if data.len() > ENCODED_LIMIT {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    if bytes.len() > IMAGE_LIMIT {
        return None;
    }
    let extension = extension(mime_type, &bytes)?;
    let clipboard = session.join("clipboard");
    if !private_directory(&clipboard) {
        return None;
    }
    let directory = unique_directory(&clipboard)?;
    let path = directory.join(format!("image.{extension}"));
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .and_then(|mut file| file.write_all(&bytes));
    if written.is_err() {
        let _ = fs::remove_dir_all(&directory);
        return None;
    }
    Some(path)
}

/// Created when missing; a link or another user's directory is refused.
fn private_directory(path: &Path) -> bool {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return false,
    }
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() })
}

fn unique_directory(parent: &Path) -> Option<PathBuf> {
    let mut random = File::open("/dev/urandom").ok()?;
    for _ in 0..NAME_ATTEMPTS {
        let mut bytes = [0u8; 10];
        random.read_exact(&mut bytes).ok()?;
        let token: String = bytes
            .iter()
            .map(|byte| char::from(ALPHABET[usize::from(*byte) % ALPHABET.len()]))
            .collect();
        let directory = parent.join(format!("image-{token}"));
        match DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => return Some(directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;
    use std::os::unix::fs::{symlink, PermissionsExt};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn an_image_is_saved_privately_under_the_session_clipboard() {
        let temp = TempDir::new();
        let path = save(temp.path(), "image/png", &STANDARD.encode(PNG)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), PNG);
        assert_eq!(path.file_name().unwrap(), "image.png");
        let directory = path.parent().unwrap();
        let token = directory
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix("image-")
            .unwrap();
        assert!(token.len() == 10 && token.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        assert_eq!(directory.parent().unwrap(), temp.path().join("clipboard"));
        assert_eq!(
            [
                mode(&path),
                mode(directory),
                mode(directory.parent().unwrap())
            ],
            [0o600, 0o700, 0o700]
        );
        let other = save(temp.path(), "image/png", &STANDARD.encode(PNG)).unwrap();
        assert_ne!(other.parent(), path.parent());
    }

    #[test]
    fn only_a_real_image_within_the_limit_is_saved() {
        let temp = TempDir::new();
        assert!(save(temp.path(), "image/jpeg", &STANDARD.encode(PNG)).is_none());
        assert!(save(temp.path(), "text/plain", &STANDARD.encode(PNG)).is_none());
        assert!(save(temp.path(), "image/png", "pas du base64").is_none());
        let mut large = PNG.to_vec();
        large.resize(IMAGE_LIMIT, 0);
        assert!(save(temp.path(), "image/png", &STANDARD.encode(&large)).is_some());
        large.push(0);
        assert!(save(temp.path(), "image/png", &STANDARD.encode(&large)).is_none());
    }

    #[test]
    fn a_clipboard_link_is_not_followed() {
        let temp = TempDir::new();
        let elsewhere = temp.path().join("ailleurs");
        fs::create_dir(&elsewhere).unwrap();
        let session = temp.path().join("session");
        fs::create_dir(&session).unwrap();
        symlink(&elsewhere, session.join("clipboard")).unwrap();
        assert!(save(&session, "image/png", &STANDARD.encode(PNG)).is_none());
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    }
}
