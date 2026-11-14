#[cfg(windows)]
use super::resolve_wsl_host_path;
use super::{
    lock, remote_host, AgentEnvironment, PromptAttachment, Result, Runtime, AGENT_ATTACHMENT_LIMIT,
};
use crate::project_files::media::valid_image_signature;
use crate::ssh::SshConnection;
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const INVALID_CLIPBOARD_IMAGE: &str =
    "Le presse-papiers ne contient pas une image PNG, JPEG, GIF ou WebP valide.";

pub(super) fn clipboard_image_extension(mime_type: &str, bytes: &[u8]) -> Result<&'static str> {
    let (media_type, extension) = match mime_type {
        "image/png" => ("image/png", "png"),
        "image/jpeg" | "image/jpg" => ("image/jpeg", "jpg"),
        "image/gif" => ("image/gif", "gif"),
        "image/webp" => ("image/webp", "webp"),
        _ => return Err(INVALID_CLIPBOARD_IMAGE.into()),
    };
    if valid_image_signature(media_type, bytes) {
        Ok(extension)
    } else {
        Err(INVALID_CLIPBOARD_IMAGE.into())
    }
}
const REMOTE_CLIPBOARD_DIRECTORY_PREFIX: &str = "/tmp/soreno-agent-";

pub(super) fn remote_clipboard_directory_script() -> &'static str {
    "set -eu; umask 077; dir=$(mktemp -d /tmp/soreno-agent-XXXXXXXXXX); printf '%s' \"$dir\""
}
pub(super) fn remote_clipboard_directory(output: Vec<u8>) -> Result<String> {
    let path = String::from_utf8(output)
        .map_err(|_| "Chemin temporaire distant non UTF-8.".to_string())?;
    let suffix = path
        .strip_prefix(REMOTE_CLIPBOARD_DIRECTORY_PREFIX)
        .ok_or("Chemin temporaire distant invalide.")?;
    if !is_mktemp_token(suffix) {
        return Err("Chemin temporaire distant invalide.".into());
    }
    Ok(path)
}
fn is_mktemp_token(token: &str) -> bool {
    token.len() == 10
        && token
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}
fn has_mktemp_token_between(path: &str, prefix: &str, suffix: &str) -> bool {
    path.strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
        .is_some_and(is_mktemp_token)
}
pub(super) fn uploaded_image_path(
    output: Vec<u8>,
    directory: &str,
    extension: &str,
) -> Result<String> {
    let path = String::from_utf8(output)
        .map_err(|_| "Chemin de l’image distante non UTF-8.".to_string())?;
    if !has_mktemp_token_between(
        &path,
        &format!("{directory}/image-"),
        &format!("/image.{extension}"),
    ) {
        return Err("Chemin de l’image distante invalide.".into());
    }
    Ok(path)
}
pub(super) fn clipboard_image_upload_script(directory: &str, extension: &str) -> String {
    let directory = crate::ssh::quote(directory);
    format!(
        "set -eu; umask 077; dir={directory}; test -d \"$dir\" && test ! -L \"$dir\"; image_dir=$(mktemp -d \"$dir/image-XXXXXXXXXX\"); trap 'rm -rf \"$image_dir\"' 0; path=\"$image_dir/image.{extension}\"; cat > \"$path\"; trap - 0; printf '%s' \"$path\""
    )
}
pub(super) fn attachment_upload_script(directory: &str, filename: &str) -> String {
    let directory = crate::ssh::quote(directory);
    let filename = crate::ssh::quote(filename);
    format!(
        "set -eu; umask 077; dir={directory}; test -d \"$dir\" && test ! -L \"$dir\"; file_dir=$(mktemp -d \"$dir/file-XXXXXXXXXX\"); trap 'rm -rf \"$file_dir\"' 0; path=\"$file_dir\"/{filename}; cat > \"$path\"; trap - 0; printf '%s' \"$path\""
    )
}
pub(super) fn prompt_attachment_upload_script(directory: &str, filename: &str) -> String {
    let directory = crate::ssh::quote(directory);
    let filename = crate::ssh::quote(filename);
    format!(
        "set -eu; umask 077; set -C; dir={directory}; test -d \"$dir\" && test ! -L \"$dir\"; cat > \"$dir\"/{filename}"
    )
}
pub(super) fn uploaded_attachment_path(
    output: Vec<u8>,
    directory: &str,
    filename: &str,
) -> Result<String> {
    let path = String::from_utf8(output)
        .map_err(|_| "Chemin de la pièce jointe distante non UTF-8.".to_string())?;
    if !has_mktemp_token_between(
        &path,
        &format!("{directory}/file-"),
        &format!("/{filename}"),
    ) {
        return Err("Chemin de la pièce jointe distante invalide.".into());
    }
    Ok(path)
}
/// A design session's frame mirror sits beside its private directory, out of its agent's reach.
pub(super) const MIRROR_SUFFIX: &str = "-frames";
pub(super) fn mirror_directory(directory: &Path) -> PathBuf {
    let mut mirror = directory.as_os_str().to_owned();
    mirror.push(MIRROR_SUFFIX);
    PathBuf::from(mirror)
}
pub(super) fn remote_clipboard_cleanup_script(directory: &str) -> String {
    format!(
        "rm -rf -- {} {}",
        crate::ssh::quote(directory),
        crate::ssh::quote(&format!("{directory}{MIRROR_SUFFIX}"))
    )
}
pub(super) fn attachment_filename(filename: &str) -> Result<()> {
    if filename.is_empty()
        || filename.len() > 255
        || filename.chars().any(char::is_control)
        || filename.contains(['/', '\\'])
        || matches!(filename, "." | "..")
    {
        return Err("Nom de pièce jointe invalide.".into());
    }
    Ok(())
}
#[cfg(any(windows, test))]
pub(super) fn windows_attachment_filename(filename: &str) -> Result<()> {
    if filename.contains(':') {
        return Err("Nom de pièce jointe invalide sous Windows.".into());
    }
    Ok(())
}
pub(super) fn attachment_root(links_dir: &Path) -> PathBuf {
    links_dir
        .parent()
        .unwrap_or(links_dir)
        .join("agent-attachments")
}
pub(super) fn attachment_directory(instance_directory: &Path, session_id: &str) -> PathBuf {
    instance_directory.join(remote_host::key(session_id))
}
pub(super) fn create_unique_attachment_directory(parent: &Path, prefix: &str) -> Result<PathBuf> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    loop {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let directory = parent.join(format!(
            "{prefix}-{}-{timestamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match std::fs::create_dir(&directory) {
            Ok(()) => {
                #[cfg(unix)]
                if let Err(error) = std::fs::set_permissions(
                    &directory,
                    std::os::unix::fs::PermissionsExt::from_mode(0o700),
                ) {
                    let _ = std::fs::remove_dir(&directory);
                    return Err(format!("Impossible de protéger la pièce jointe : {error}"));
                }
                return Ok(directory);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Impossible de préparer la pièce jointe : {error}")),
        }
    }
}
pub(super) fn write_local_attachment(
    directory: &Path,
    filename: &str,
    bytes: &[u8],
) -> Result<String> {
    if bytes.len() > AGENT_ATTACHMENT_LIMIT {
        return Err("Pièce jointe locale limitée à 32 Mio.".into());
    }
    let transfer_directory = create_unique_attachment_directory(directory, "file")?;
    let path = transfer_directory.join(filename);
    let result = write_private_file(&path, bytes).and_then(|()| utf8_path(path));
    if result.is_err() {
        let _ = std::fs::remove_dir_all(transfer_directory);
    }
    result
}
pub(super) fn write_local_prompt_attachments<'a>(
    directory: &Path,
    files: impl IntoIterator<Item = &'a PromptAttachment>,
) -> Result<String> {
    let prompt_directory = create_unique_attachment_directory(directory, "prompt")?;
    let result = files
        .into_iter()
        .try_for_each(|file| {
            write_private_file(&prompt_directory.join(&file.filename), &file.bytes)
        })
        .and_then(|()| utf8_path(prompt_directory.clone()));
    if result.is_err() {
        let _ = std::fs::remove_dir_all(prompt_directory);
    }
    result
}
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Impossible d’enregistrer la pièce jointe : {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Impossible d’enregistrer la pièce jointe : {error}"))?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .map_err(|error| format!("Impossible de protéger la pièce jointe : {error}"))?;
    Ok(())
}
fn utf8_path(path: PathBuf) -> Result<String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| "Chemin temporaire local non UTF-8.".into())
}
/// Starts each launch with an empty private directory for the session.
pub(super) fn reset_session_attachment_directory(directory: &Path) -> Result<()> {
    cleanup_attachment_directory(directory)?;
    std::fs::create_dir(directory)
        .map_err(|error| format!("Impossible de préparer la pièce jointe : {error}"))?;
    #[cfg(unix)]
    std::fs::set_permissions(
        directory,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .map_err(|error| format!("Impossible de protéger la pièce jointe : {error}"))?;
    Ok(())
}
pub(super) fn cleanup_attachment_directory(directory: &Path) -> Result<()> {
    for directory in [directory.to_owned(), mirror_directory(directory)] {
        match std::fs::remove_dir_all(&directory) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!(
                    "Impossible de supprimer les pièces jointes : {error}"
                ))
            }
            _ => {}
        }
    }
    Ok(())
}

pub(super) struct RemoteClipboardState {
    pub(super) connection: SshConnection,
    pub(super) directory: Option<String>,
    /// The dtach session whose directory holds the files, under its root.
    persistent: Option<(&'static str, String)>,
    pub(super) prompt_directory: Option<String>,
    pub(super) closed: bool,
}
pub(super) struct RemoteClipboard {
    pub(super) state: Mutex<RemoteClipboardState>,
}
impl RemoteClipboard {
    pub(super) fn new(
        connection: SshConnection,
        persistent: Option<(&'static str, String)>,
    ) -> Self {
        Self {
            state: Mutex::new(RemoteClipboardState {
                connection,
                directory: None,
                persistent,
                prompt_directory: None,
                closed: false,
            }),
        }
    }
    pub(super) fn replace_connection(&self, connection: SshConnection) -> Result<()> {
        lock(&self.state)?.connection = connection;
        Ok(())
    }
    /// Runs `action` in the session's directory once a dtach launch has recreated it.
    fn run_in_directory(&self, action: &str, stdin: Option<&[u8]>) -> Result<()> {
        let mut state = lock(&self.state)?;
        let directory = Self::directory(&mut state)?;
        // A dtach launch recreates its directory before creating its socket.
        // shortcut: a socket left by a SIGKILLed master can pass this test before the new launch purges the directory, losing the first mirror; check a per-launch marker if agents miss frames after a crash.
        let launched = if state.persistent.is_some() {
            "test -S ../socket; "
        } else {
            ""
        };
        crate::ssh::run(
            &state.connection,
            &format!(
                "set -eu; umask 077; cd -- {}; {launched}{action}",
                crate::ssh::quote(&directory)
            ),
            stdin,
            1024,
        )
        .map(|_| ())
    }
    /// Writes, or removes without `content`, `name` in the session's directory, or with `mirror`
    /// in its frame mirror beside it; `mktemp` then a rename never follows a planted link.
    pub(super) fn write_private(
        &self,
        mirror: bool,
        name: &str,
        content: Option<&[u8]>,
    ) -> Result<()> {
        let parent = if mirror {
            crate::ssh::quote(&format!("{}{MIRROR_SUFFIX}", self.ensure_directory()?))
        } else {
            ".".into()
        };
        let path = format!("\"$d\"/{}", crate::ssh::quote(name));
        let action = match content {
            Some(_) => format!(
                "d={parent}; [ -e \"$d\" ] || [ -L \"$d\" ] || mkdir -- \"$d\"; test ! -L \"$d\"; test -d \"$d\"; test -O \"$d\"; t=$(mktemp \"$d/.soreno-XXXXXXXXXX\"); trap 'rm -f -- \"$t\"' 0; cat > \"$t\"; f={path}; if [ -L \"$f\" ]; then rm -f -- \"$f\"; fi; test ! -d \"$f\"; mv -f -- \"$t\" \"$f\"; trap - 0"
            ),
            None => format!(
                "d={parent}; if [ -d \"$d\" ] && [ ! -L \"$d\" ]; then rm -f -- {path}; fi"
            ),
        };
        self.run_in_directory(&action, content)
    }
    /// Removes every mirrored frame, hidden ones included, never through a linked folder.
    pub(super) fn clear_design_mirror(&self) -> Result<()> {
        let mirror = crate::ssh::quote(&format!("{}{MIRROR_SUFFIX}", self.ensure_directory()?));
        self.run_in_directory(
            &format!("d={mirror}; if [ -d \"$d\" ] && [ ! -L \"$d\" ]; then find \"$d\" -maxdepth 1 \\( -type f -o -type l \\) -name '*.html' -exec rm -f -- {{}} +; fi"),
            None,
        )
    }
    pub(super) fn directory(state: &mut RemoteClipboardState) -> Result<String> {
        if state.closed {
            return Err("Cette session est terminée.".into());
        }
        if let Some(directory) = &state.directory {
            return Ok(directory.clone());
        }
        let directory = match &state.persistent {
            Some((root, session_id)) => remote_host::clipboard_directory(
                crate::ssh::run(
                    &state.connection,
                    &remote_host::clipboard_directory_script(root, session_id),
                    None,
                    4096,
                )?,
                root,
                session_id,
            )?,
            None => remote_clipboard_directory(crate::ssh::run(
                &state.connection,
                remote_clipboard_directory_script(),
                None,
                4096,
            )?)?,
        };
        state.directory = Some(directory.clone());
        Ok(directory)
    }
    pub(super) fn upload(&self, extension: &str, bytes: &[u8]) -> Result<String> {
        let mut state = lock(&self.state)?;
        let directory = Self::directory(&mut state)?;
        let output = crate::ssh::run(
            &state.connection,
            &clipboard_image_upload_script(&directory, extension),
            Some(bytes),
            4096,
        )?;
        uploaded_image_path(output, &directory, extension)
    }
    pub(super) fn upload_file(&self, filename: &str, bytes: &[u8]) -> Result<String> {
        let mut state = lock(&self.state)?;
        let directory = Self::directory(&mut state)?;
        let output = crate::ssh::run(
            &state.connection,
            &attachment_upload_script(&directory, filename),
            Some(bytes),
            4096,
        )?;
        uploaded_attachment_path(output, &directory, filename)
    }
    pub(super) fn upload_prompt_files<'a>(
        &self,
        files: impl IntoIterator<Item = &'a PromptAttachment>,
    ) -> Result<String> {
        let mut state = lock(&self.state)?;
        if state.closed {
            return Err("Cette session est terminée.".into());
        }
        // Launching a dtach session recreates its persistent directory, so these files get their own.
        let directory = remote_clipboard_directory(crate::ssh::run(
            &state.connection,
            remote_clipboard_directory_script(),
            None,
            4096,
        )?)?;
        state.prompt_directory = Some(directory.clone());
        for file in files {
            crate::ssh::run(
                &state.connection,
                &prompt_attachment_upload_script(&directory, &file.filename),
                Some(&file.bytes),
                4096,
            )?;
        }
        Ok(directory)
    }
    /// The prompt directory a dtach launch script records for its run.
    pub(super) fn prompt_directory(&self) -> Result<Option<String>> {
        Ok(lock(&self.state)?.prompt_directory.clone())
    }
    /// Once launched, the dtach run removes its prompt directory when it ends, even unattached.
    // shortcut: a local ssh client that starts but never reaches the server (new auth refused while
    // the relay still works) leaves this directory in /tmp; confirm the remote spawn if it recurs.
    pub(super) fn hand_over_prompt_directory(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.prompt_directory = None;
        }
    }
    /// Creates the session's remote directory now so a launch argument can name it.
    pub(super) fn ensure_directory(&self) -> Result<String> {
        Self::directory(&mut *lock(&self.state)?)
    }
    pub(super) fn close(&self) -> Result<()> {
        self.close_with(|connection, directory| {
            crate::ssh::run(
                connection,
                &remote_clipboard_cleanup_script(directory),
                None,
                4096,
            )
            .map(|_| ())
        })
    }
    pub(super) fn close_with(
        &self,
        cleanup: impl Fn(&SshConnection, &str) -> Result<()>,
    ) -> Result<()> {
        let (connection, directories) = {
            let mut state = lock(&self.state)?;
            if state.closed {
                return Ok(());
            }
            state.closed = true;
            let directory = state.directory.take();
            // A persistent directory belongs to the remote dtach session, which removes it.
            let owned = directory.filter(|_| state.persistent.is_none());
            let prompt_directory = state.prompt_directory.take();
            (
                state.connection.clone(),
                owned
                    .into_iter()
                    .chain(prompt_directory)
                    .collect::<Vec<_>>(),
            )
        };
        directories
            .iter()
            .map(|directory| cleanup(&connection, directory))
            .fold(Ok(()), Result::and)
    }
}
impl Drop for RemoteClipboard {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
pub(super) fn powershell_literal(value: &str) -> String {
    format!(
        "'{}'",
        value
            .replace('\'', "''")
            .replace('‘', "‘‘")
            .replace('’', "’’")
            .replace('‚', "‚‚")
            .replace('‛', "‛‛")
    )
}
pub(super) fn terminal_attachment_path(environment: &AgentEnvironment, path: &str) -> String {
    if cfg!(windows) && environment.kind == "local" {
        powershell_literal(path)
    } else {
        crate::ssh::quote(path)
    }
}
/// Path of a Soreno-written local file as the agent's environment sees it.
pub(super) fn agent_local_path(environment: &AgentEnvironment, path: String) -> Result<String> {
    if environment.kind == "local" {
        return Ok(path);
    }
    #[cfg(windows)]
    {
        resolve_wsl_host_path(environment, &path)
    }
    #[cfg(not(windows))]
    {
        Err("WSL est disponible uniquement sous Windows.".into())
    }
}
/// Writes `bytes` where this run's agent can read them and returns its quoted terminal path.
pub(super) fn attach_file_to(
    runtime: &Runtime,
    environment: &AgentEnvironment,
    filename: &str,
    bytes: &[u8],
) -> Result<String> {
    if lock(&runtime.output)?.exited {
        return Err("Cette session est terminée.".into());
    }
    attach_file_in(
        &runtime.local_attachment_directory,
        runtime.remote_clipboard.as_ref(),
        environment,
        filename,
        bytes,
    )
}
pub(super) fn attach_file_in(
    local_directory: &Mutex<Option<PathBuf>>,
    remote_clipboard: Option<&RemoteClipboard>,
    environment: &AgentEnvironment,
    filename: &str,
    bytes: &[u8],
) -> Result<String> {
    let resolved = match environment.kind.as_str() {
        "local" | "wsl" => {
            #[cfg(windows)]
            windows_attachment_filename(filename)?;
            let directory = lock(local_directory)?;
            let directory = directory
                .as_deref()
                .ok_or("Dossier temporaire local indisponible.")?;
            agent_local_path(
                environment,
                write_local_attachment(directory, filename, bytes)?,
            )?
        }
        "ssh" => {
            if bytes.len() > AGENT_ATTACHMENT_LIMIT {
                return Err("Pièce jointe SSH limitée à 32 Mio.".into());
            }
            remote_clipboard
                .ok_or("Transfert SSH indisponible pour cette session.")?
                .upload_file(filename, bytes)?
        }
        _ => return Err("Environnement inconnu.".into()),
    };
    Ok(terminal_attachment_path(environment, &resolved))
}
pub(super) fn validate_prompt_attachments(
    environment: &AgentEnvironment,
    attachments: &[PromptAttachment],
) -> Result<()> {
    for attachment in attachments {
        attachment_filename(&attachment.filename)?;
        if attachment.bytes.len() > AGENT_ATTACHMENT_LIMIT {
            return Err("Pièce jointe limitée à 32 Mio.".into());
        }
        #[cfg(windows)]
        if environment.kind != "ssh" {
            windows_attachment_filename(&attachment.filename)?;
        }
    }
    #[cfg(not(windows))]
    let _ = environment;
    Ok(())
}
pub(super) fn write_prompt_attachments(
    environment: &AgentEnvironment,
    local_directory: Option<&Path>,
    remote_clipboard: Option<&RemoteClipboard>,
    attachments: &[PromptAttachment],
) -> Result<String> {
    validate_prompt_attachments(environment, attachments)?;
    match environment.kind.as_str() {
        "local" | "wsl" => {
            let directory = local_directory.ok_or("Dossier temporaire local indisponible.")?;
            agent_local_path(
                environment,
                write_local_prompt_attachments(directory, attachments)?,
            )
        }
        "ssh" => remote_clipboard
            .ok_or("Transfert SSH indisponible pour cette session.")?
            .upload_prompt_files(attachments),
        _ => Err("Environnement inconnu.".into()),
    }
}
// src/domain/kanbanAgent.ts reserves launch budget for this suffix; design frames get one
// constant-size entry, src/domain/design.ts budgets it: a Windows launch line is bounded.
pub(super) fn prompt_with_attachments(
    prompt: &str,
    directory: &str,
    attachments: &[PromptAttachment],
) -> String {
    let (frames, files): (Vec<_>, Vec<_>) = attachments
        .iter()
        .map(|attachment| attachment.filename.as_str())
        .partition(|name| name.starts_with("design-") && name.ends_with(".html"));
    let frames = match frames.len() {
        0 => None,
        1 => Some("1 design-*.html file".into()),
        count => Some(format!("{count} design-*.html files")),
    };
    let names = files
        .into_iter()
        .map(str::to_owned)
        .chain(frames)
        .collect::<Vec<_>>()
        .join(", ");
    format!("{prompt}\n\nAttached files in {directory}: {names}")
}
