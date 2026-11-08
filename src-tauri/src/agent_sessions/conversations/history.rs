use super::{
    absolute_for_environment, AgentConversation, AgentProject, Provider, Result, PREFIX_LIMIT,
};
#[cfg(windows)]
use super::{probe_output, wsl_command};
use std::{io::Read, path::Path, time::SystemTime};

/// The largest page served: its SSH or WSL output stays below `HISTORY_OUTPUT_LIMIT`.
pub(super) const HISTORY_PAGE_LIMIT: usize = 200;
/// OMP reads the same span to summarize a history.
pub(super) const HISTORY_HEAD: u64 = 4096;
const HISTORY_OUTPUT_LIMIT: usize = 1024 * 1024;

/// One OMP history file: absolute path in its environment, modification time in
/// milliseconds, first bytes.
pub(in crate::agent_sessions) struct HistoryFile {
    pub(in crate::agent_sessions) path: String,
    pub(in crate::agent_sessions) modified: u64,
    pub(in crate::agent_sessions) head: Vec<u8>,
}

/// The `.jsonl` regular files of `directory`, newest first, from `offset` for at most `limit`
/// (capped at `HISTORY_PAGE_LIMIT`), and whether more follow; none when it is missing.
pub(in crate::agent_sessions) fn history_files(
    project: &AgentProject,
    directory: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<HistoryFile>, bool)> {
    let limit = limit.min(HISTORY_PAGE_LIMIT);
    if project.environment.kind == "ssh" {
        crate::ssh::validate_path(directory)?;
        let output = crate::ssh::run(
            project
                .environment
                .ssh
                .as_ref()
                .ok_or("Connexion SSH manquante.")?,
            &history_files_script(directory, offset, limit),
            None,
            HISTORY_OUTPUT_LIMIT,
        )?;
        return Ok(parse_history_files(directory, &output));
    }
    if project.environment.kind == "wsl" {
        crate::ssh::validate_path(directory)?;
        #[cfg(windows)]
        return Ok(parse_history_files(
            directory,
            &super::super::environment::probe_output_limited(
                wsl_command(
                    project.environment.distribution.as_deref().unwrap(),
                    "sh",
                    &["-c", &history_files_script(directory, offset, limit)],
                ),
                HISTORY_OUTPUT_LIMIT as u64,
            )?,
        ));
        #[cfg(not(windows))]
        return Err("WSL est disponible uniquement sous Windows.".into());
    }
    local_history_files(Path::new(directory), offset, limit)
}

fn local_history_files(
    directory: &Path,
    offset: usize,
    limit: usize,
) -> Result<(Vec<HistoryFile>, bool)> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), false))
        }
        Err(error) => {
            return Err(format!(
                "Impossible de lister les conversations OMP : {error}"
            ))
        }
    };
    // An entry's metadata does not follow symbolic links: those are skipped.
    let mut files: Vec<(SystemTime, String)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            let metadata = entry.metadata().ok()?;
            if !name.ends_with(".jsonl") || !metadata.is_file() {
                return None;
            }
            Some((metadata.modified().ok()?, name))
        })
        .collect();
    files.sort_by(|left, right| right.cmp(left));
    let more = files.len() > offset.saturating_add(limit);
    let files = files
        .into_iter()
        .skip(offset)
        .take(limit)
        .filter_map(|(modified, name)| {
            let path = directory.join(&name);
            let mut head = Vec::new();
            std::fs::File::open(&path)
                .ok()?
                .take(HISTORY_HEAD)
                .read_to_end(&mut head)
                .ok()?;
            Some(HistoryFile {
                path: path.to_string_lossy().into_owned(),
                modified: modified
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as u64),
                head,
            })
        })
        .collect();
    Ok((files, more))
}

/// `name\0seconds\0head\0` per file of the page, newest first, then `+` when more follow;
/// `stat -f` is the macOS form.
pub(super) fn history_files_script(directory: &str, offset: usize, limit: usize) -> String {
    let end = offset.saturating_add(limit);
    format!(
        "cd -- {} 2>/dev/null || exit 0; n=0; ls -t | while IFS= read -r f; do case $f in *.jsonl) ;; *) continue;; esac; [ -f \"$f\" ] && [ ! -L \"$f\" ] || continue; n=$((n+1)); [ \"$n\" -gt {offset} ] || continue; [ \"$n\" -le {end} ] || {{ printf +; break; }}; m=$(stat -c %Y -- \"$f\" 2>/dev/null || stat -f %m -- \"$f\") || continue; printf '%s\\0%s\\0' \"$f\" \"$m\"; head -c {HISTORY_HEAD} -- \"$f\"; printf '\\0'; done",
        crate::ssh::quote(directory)
    )
}

pub(super) fn parse_history_files(directory: &str, output: &[u8]) -> (Vec<HistoryFile>, bool) {
    // Every entry ends with a NUL: a trailing `+` can only be the marker.
    let (output, more) = match output.strip_suffix(b"+") {
        Some(output) => (output, true),
        None => (output, false),
    };
    let mut fields = output.split(|byte| *byte == 0);
    let mut files = Vec::new();
    while let (Some(name), Some(modified), Some(head)) =
        (fields.next(), fields.next(), fields.next())
    {
        let name = std::str::from_utf8(name)
            .ok()
            .filter(|name| !name.contains('/'));
        let modified = std::str::from_utf8(modified)
            .ok()
            .and_then(|seconds| seconds.trim().parse::<u64>().ok());
        if let (Some(name), Some(modified)) = (name, modified) {
            files.push(HistoryFile {
                path: format!("{directory}/{name}"),
                modified: modified.saturating_mul(1000),
                head: head.to_vec(),
            });
        }
    }
    (files, more)
}

pub(super) fn history_exists(project: &AgentProject, path: &str) -> Result<bool> {
    let parse = |output: Vec<u8>| match output.as_slice() {
        b"1" => Ok(true),
        b"0" => Ok(false),
        _ => Err("Réponse invalide lors de la vérification de l’historique Pi/OMP.".into()),
    };
    let script = || {
        format!(
            "if [ -f {} ]; then printf 1; else printf 0; fi",
            crate::ssh::quote(path)
        )
    };
    if project.environment.kind == "ssh" {
        return parse(crate::ssh::run(
            project
                .environment
                .ssh
                .as_ref()
                .ok_or("Connexion SSH manquante.")?,
            &script(),
            None,
            1,
        )?);
    }
    if project.environment.kind == "wsl" {
        #[cfg(windows)]
        return parse(probe_output(wsl_command(
            project.environment.distribution.as_deref().unwrap(),
            "sh",
            &["-c", &script()],
        ))?);
        #[cfg(not(windows))]
        return Err("WSL est disponible uniquement sous Windows.".into());
    }
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Impossible de vérifier l’historique Pi/OMP : {error}"
        )),
    }
}

fn history_prefix(project: &AgentProject, path: &str) -> Result<Vec<u8>> {
    if project.environment.kind == "ssh" {
        crate::ssh::validate_path(path)?;
        return crate::ssh::run(
            project
                .environment
                .ssh
                .as_ref()
                .ok_or("Connexion SSH manquante.")?,
            &format!("head -c 65536 -- {}", crate::ssh::quote(path)),
            None,
            PREFIX_LIMIT as usize,
        );
    }
    if project.environment.kind == "wsl" {
        #[cfg(windows)]
        return probe_output(wsl_command(
            project.environment.distribution.as_deref().unwrap(),
            "head",
            &["-c", "65536", "--", path],
        ));
        #[cfg(not(windows))]
        return Err("WSL est disponible uniquement sous Windows.".into());
    }
    let mut data = Vec::new();
    std::fs::File::open(path)
        .map_err(|error| format!("Historique Pi/OMP introuvable : {error}"))?
        .take(PREFIX_LIMIT)
        .read_to_end(&mut data)
        .map_err(|error| format!("Historique Pi/OMP illisible : {error}"))?;
    Ok(data)
}

fn valid_omp_title(value: &serde_json::Value) -> bool {
    let Some(title) = value.as_object() else {
        return false;
    };
    title.get("type").and_then(|value| value.as_str()) == Some("title")
        && title.get("v").and_then(|value| value.as_u64()) == Some(1)
        && title.get("title").is_some_and(serde_json::Value::is_string)
        && title
            .get("updatedAt")
            .is_some_and(serde_json::Value::is_string)
        && title.get("pad").is_some_and(serde_json::Value::is_string)
        && title
            .get("source")
            .is_none_or(|source| matches!(source.as_str(), Some("auto") | Some("user")))
}

pub(super) fn verify_history(
    project: &AgentProject,
    conversation: &AgentConversation,
) -> Result<()> {
    let session_file = conversation
        .session_file
        .as_deref()
        .ok_or("Le fichier d’historique Pi/OMP lié est absent.")?;
    if !absolute_for_environment(session_file, project) {
        return Err("Le fichier d’historique Pi/OMP lié n’est pas un chemin absolu valide.".into());
    }
    let data = history_prefix(project, session_file)?;
    let mut lines = data.split(|byte| *byte == b'\n');
    let first = lines
        .next()
        .ok_or("En-tête de l’historique Pi/OMP manquant.")?;
    let mut header: serde_json::Value = serde_json::from_slice(first)
        .map_err(|_| "En-tête de l’historique Pi/OMP invalide.".to_string())?;
    if conversation.provider == Provider::Omp.as_str()
        && header.get("type").and_then(|value| value.as_str()) != Some("session")
    {
        if !valid_omp_title(&header) {
            return Err("Titre initial de l’historique OMP invalide.".into());
        }
        header = serde_json::from_slice(
            lines
                .next()
                .ok_or("En-tête de l’historique OMP manquant après son titre.")?,
        )
        .map_err(|_| "En-tête de l’historique OMP invalide.".to_string())?;
    }
    if header.get("type").and_then(|value| value.as_str()) != Some("session") {
        return Err("En-tête de l’historique Pi/OMP manquant ou de type incorrect.".into());
    }
    if header.get("id").and_then(|value| value.as_str()) != Some(conversation.session_id.as_str()) {
        return Err(
            "L’identité de l’historique Pi/OMP ne correspond pas à la conversation liée.".into(),
        );
    }
    Ok(())
}
