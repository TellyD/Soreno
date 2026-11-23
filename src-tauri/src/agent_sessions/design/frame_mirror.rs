use super::super::{attachments::mirror_directory, lock, RemoteClipboard, Result};
use std::{path::PathBuf, sync::Mutex};

// shortcut: an id that Windows reserves (con, aux, nul…) cannot be mirrored there and is skipped;
// prefix the mirror names if users create such frames.
pub(super) fn mirror_name(frame_id: &str) -> String {
    format!("{frame_id}.html")
}

pub(super) fn windows_reserved(frame_id: &str) -> bool {
    let stem = frame_id
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

/// Writes, or removes without `content`, `name` in a run's private directory, or with `mirror`
/// in its frame mirror beside it, which its confined agent cannot write. A temporary file created
/// exclusively then renamed into place never follows a planted link, and the agent never copies
/// a half-written file.
pub(in crate::agent_sessions) fn write_private(
    local: &Mutex<Option<PathBuf>>,
    remote: Option<&RemoteClipboard>,
    mirror: bool,
    name: &str,
    content: Option<&[u8]>,
) -> Result<()> {
    let Some(directory) = lock(local)?.clone() else {
        return match remote {
            Some(remote) => remote.write_private(mirror, name, content),
            None => Ok(()),
        };
    };
    let parent = if mirror {
        let parent = mirror_directory(&directory);
        match std::fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err("Le miroir des cadres n’est pas un dossier.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if content.is_none() {
                    return Ok(());
                }
                std::fs::create_dir(&parent).map_err(|error| error.to_string())?;
                #[cfg(unix)]
                std::fs::set_permissions(
                    &parent,
                    std::os::unix::fs::PermissionsExt::from_mode(0o700),
                )
                .map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        parent
    } else {
        directory
    };
    let path = parent.join(name);
    let Some(content) = content else {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    };
    let (draft, mut file) = (0..)
        .find_map(|attempt| {
            let draft = parent.join(format!(".soreno-{}-{attempt}.tmp", std::process::id()));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            match options.open(&draft) {
                Ok(file) => Some(Ok((draft, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error.to_string())),
            }
        })
        .expect("unbounded attempts")?;
    let written = std::io::Write::write_all(&mut file, content)
        .map_err(|error| error.to_string())
        .and_then(|()| {
            drop(file);
            std::fs::rename(&draft, &path).map_err(|error| error.to_string())
        });
    if written.is_err() {
        let _ = std::fs::remove_file(&draft);
    }
    written
}

pub(super) fn clear_mirror(
    local: &Mutex<Option<PathBuf>>,
    remote: Option<&RemoteClipboard>,
) -> Result<()> {
    let Some(directory) = lock(local)?.clone() else {
        return match remote {
            Some(remote) => remote.clear_design_mirror(),
            None => Ok(()),
        };
    };
    let frames = mirror_directory(&directory);
    if !std::fs::symlink_metadata(&frames).is_ok_and(|metadata| metadata.file_type().is_dir()) {
        return Ok(());
    }
    for entry in std::fs::read_dir(&frames).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().ends_with(".html")
            && !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            std::fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
