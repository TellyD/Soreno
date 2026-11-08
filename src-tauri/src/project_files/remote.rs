use super::{
    entry_value,
    errors::{
        conflict, download_too_large, exists, invalid_path, not_directory, not_file, symlink_error,
        too_large,
    },
    link_entry_value, search_entry, sort_entries, sort_search_entries, validate_relative_path,
    AgentProject, ProjectFileError, ProjectFileListing, DIRECTORY_LIMIT,
    FALLBACK_SEARCH_SCAN_LIMIT, FILE_LIMIT, SEARCH_DEPTH_LIMIT, SEARCH_RESULT_LIMIT,
};

fn remote_connection(
    project: &AgentProject,
) -> Result<&crate::ssh::SshConnection, ProjectFileError> {
    project
        .environment
        .ssh
        .as_ref()
        .ok_or_else(|| ProjectFileError::new("project", "Connexion SSH du projet indisponible."))
}

pub(super) fn remote_target(root: &str, relative: &str) -> String {
    if relative.is_empty() {
        root.to_owned()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), relative)
    }
}

pub(super) fn remote_guard(root: &str, relative: &str) -> String {
    let mut current = root.trim_end_matches('/').to_owned();
    let mut guard = String::new();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        current.push('/');
        current.push_str(part);
        guard.push_str(&format!(
            "[ ! -L {} ] || {{ printf 'SORENO_FILE_SYMLINK\\n' >&2; exit 42; }}; ",
            crate::ssh::quote(&current)
        ));
    }
    guard
}

pub(super) fn list_remote(
    project: &AgentProject,
    directory: &str,
) -> Result<ProjectFileListing, ProjectFileError> {
    let output = remote_run(
        project,
        &remote_list_script(&project.path, directory),
        None,
        FILE_LIMIT as usize,
    )?;
    parse_remote_listing(&output, directory)
}

pub(super) fn remote_list_script(root: &str, directory: &str) -> String {
    format!(
        "set -eu; {}target={}; [ -d \"$target\" ] || {{ printf 'SORENO_FILE_NOT_DIRECTORY\\n' >&2; exit 43; }}; count=0; for entry in \"$target\"/.[!.]* \"$target\"/..?* \"$target\"/*; do [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue; name=${{entry##*/}}; case \"$name\" in .[gG][iI][tT]) continue;; esac; if [ -L \"$entry\" ]; then if [ -d \"$entry\" ]; then kind=ld; else kind=lf; fi; elif [ -d \"$entry\" ]; then kind=d; elif [ -f \"$entry\" ]; then kind=f; else continue; fi; count=$((count + 1)); if [ \"$count\" -gt {} ]; then printf 't\\000\\000'; break; fi; printf '%s\\000%s\\000' \"$kind\" \"$name\"; done",
        remote_guard(root, directory),
        crate::ssh::quote(&remote_target(root, directory)),
        DIRECTORY_LIMIT,
    )
}

pub(super) fn parse_remote_listing(
    output: &[u8],
    directory: &str,
) -> Result<ProjectFileListing, ProjectFileError> {
    let mut fields = output.split(|byte| *byte == 0);
    let mut entries = Vec::new();
    let mut truncated = false;
    loop {
        let Some(kind) = fields.next() else { break };
        if kind.is_empty() {
            break;
        }
        let name = fields.next().ok_or_else(|| {
            ProjectFileError::new("malformed", "Réponse SSH de l’explorateur invalide.")
        })?;
        if kind == b"t" {
            truncated = true;
            continue;
        }
        let name = std::str::from_utf8(name).map_err(|_| {
            ProjectFileError::new("encoding", "Un nom de fichier distant n’est pas en UTF-8.")
        })?;
        if name.eq_ignore_ascii_case(".git") || name.is_empty() || name.contains(['/', '\\']) {
            continue;
        }
        let entry = match kind {
            b"d" => entry_value(directory, name.to_owned(), "directory"),
            b"f" => entry_value(directory, name.to_owned(), "file"),
            b"ld" => link_entry_value(directory, name.to_owned(), "directory"),
            b"lf" => link_entry_value(directory, name.to_owned(), "file"),
            _ => {
                return Err(ProjectFileError::new(
                    "malformed",
                    "Réponse SSH de l’explorateur invalide.",
                ))
            }
        };
        entries.push(entry);
    }
    sort_entries(&mut entries);
    Ok(ProjectFileListing { entries, truncated })
}

pub(super) fn search_remote(
    project: &AgentProject,
    query: &str,
) -> Result<ProjectFileListing, ProjectFileError> {
    let script = remote_search_script(&project.path, query);
    let output = remote_run(project, &script, None, FILE_LIMIT as usize)?;
    parse_remote_search(&output)
}

pub(super) fn remote_search_script(root: &str, query: &str) -> String {
    format!(
        "set -eu; root={}; query={}; [ -d \"$root\" ] || {{ printf 'SORENO_FILE_NOT_DIRECTORY\\n' >&2; exit 43; }}; scanned=0; matches=0; truncated=0; stopped=0; walk() {{ for entry in \"$1\"/.[!.]* \"$1\"/..?* \"$1\"/*; do [ \"$stopped\" -eq 0 ] || return 0; [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue; scanned=$((scanned + 1)); if [ \"$scanned\" -gt {} ]; then truncated=1; stopped=1; return 0; fi; name=${{entry##*/}}; case \"$name\" in .[gG][iI][tT]) continue;; esac; [ -L \"$entry\" ] && continue; if [ -z \"$2\" ]; then next=$name; else next=$2/$name; fi; if [ -d \"$entry\" ]; then if [ \"$3\" -ge {} ]; then truncated=1; else walk \"$entry\" \"$next\" $(($3 + 1)); fi; elif [ -f \"$entry\" ]; then folded=$(printf '%s' \"$next\" | tr '[:upper:]' '[:lower:]'); case \"$folded\" in *\"$query\"*) matches=$((matches + 1)); if [ \"$matches\" -gt {} ]; then truncated=1; stopped=1; return 0; fi; printf 'f\\000%s\\000' \"$next\";; esac; fi; done; }}; walk \"$root\" '' 0; [ \"$truncated\" -eq 0 ] || printf 't\\000\\000'",
        crate::ssh::quote(root),
        crate::ssh::quote(&query.to_lowercase()),
        FALLBACK_SEARCH_SCAN_LIMIT,
        SEARCH_DEPTH_LIMIT,
        SEARCH_RESULT_LIMIT,
    )
}

pub(super) fn parse_remote_search(output: &[u8]) -> Result<ProjectFileListing, ProjectFileError> {
    let mut fields = output.split(|byte| *byte == 0);
    let mut entries = Vec::new();
    let mut truncated = false;
    loop {
        let Some(kind) = fields.next() else { break };
        if kind.is_empty() {
            break;
        }
        let path = fields.next().ok_or_else(|| {
            ProjectFileError::new("malformed", "Réponse SSH de recherche invalide.")
        })?;
        if kind == b"t" {
            truncated = true;
            continue;
        }
        if kind != b"f" {
            return Err(ProjectFileError::new(
                "malformed",
                "Réponse SSH de recherche invalide.",
            ));
        }
        let path = std::str::from_utf8(path).map_err(|_| {
            ProjectFileError::new("encoding", "Un chemin distant n’est pas en UTF-8.")
        })?;
        if validate_relative_path(path, false).is_err() {
            continue;
        }
        entries.push(search_entry(path.to_owned()));
    }
    sort_search_entries(&mut entries);
    Ok(ProjectFileListing { entries, truncated })
}

pub(super) fn remote_read_script(root: &str, path: &str, limit: u64) -> String {
    let target = remote_target(root, path);
    format!(
        "set -eu; {}target={}; [ -e \"$target\" ] || {{ printf 'SORENO_FILE_NOT_FOUND\\n' >&2; exit 47; }}; [ -f \"$target\" ] || {{ printf 'SORENO_FILE_NOT_FILE\\n' >&2; exit 44; }}; size=$(wc -c < \"$target\"); [ \"$size\" -le {} ] || {{ printf 'SORENO_FILE_TOO_LARGE\\n' >&2; exit 45; }}; cat \"$target\"",
        remote_guard(root, path),
        crate::ssh::quote(&target),
        limit,
    )
}

pub(super) fn read_remote(project: &AgentProject, path: &str) -> Result<Vec<u8>, ProjectFileError> {
    remote_run(
        project,
        &remote_read_script(&project.path, path, FILE_LIMIT),
        None,
        FILE_LIMIT as usize + 1,
    )
}

/// The relay rejects requests whose output limit (cap + 1 byte) exceeds its 8 MiB output limit.
const REMOTE_DOWNLOAD_LIMIT: u64 = 8 * 1024 * 1024 - 1;

pub(super) fn download_remote(
    project: &AgentProject,
    path: &str,
) -> Result<Vec<u8>, ProjectFileError> {
    remote_run_with_timeout(
        project,
        &remote_read_script(&project.path, path, REMOTE_DOWNLOAD_LIMIT),
        None,
        REMOTE_DOWNLOAD_LIMIT as usize + 1,
        std::time::Duration::from_secs(120),
    )
    .map_err(|error| {
        if error.code == "tooLarge" {
            download_too_large()
        } else {
            error
        }
    })
}

pub(super) fn write_remote(
    project: &AgentProject,
    path: &str,
    content: &[u8],
    expected_version: &str,
) -> Result<(), ProjectFileError> {
    let script = remote_write_script(&project.path, path, expected_version);
    remote_run(project, &script, Some(content), 1024).map(|_| ())
}

/// The `.telaoi.lock` is also taken so clients released before the Soreno rename stay serialized.
/// Locks are noclobber files, not `mkdir`: uutils mkdir can exit 0 when a racing writer created it.
// shortcut: a FIFO planted at a lock name blocks `exec 3>` until the SSH timeout, and the killed save leaves `.soreno.lock` behind; refuse existing entries first if that shows up.
pub(super) fn remote_write_script(root: &str, path: &str, expected_version: &str) -> String {
    let (directory, name) = path.rsplit_once('/').unwrap_or(("", path));
    let parent = remote_target(root, directory);
    let target = format!("./{name}");
    format!(
        "set -eu; {}parent={}; cd -P \"$parent\"; target={}; [ -f \"$target\" ] && [ ! -L \"$target\" ] || {{ printf 'SORENO_FILE_NOT_FILE\\n' >&2; exit 44; }}; lock=\"${{target}}.soreno.lock\"; legacy_lock=\"${{target}}.telaoi.lock\"; tmp=; locked=; legacy_locked=; cleanup() {{ [ -z \"$tmp\" ] || rm -f \"$tmp\"; [ -z \"$legacy_locked\" ] || rm -f \"$legacy_lock\"; [ -z \"$locked\" ] || rm -f \"$lock\"; }}; trap cleanup 0; trap 'exit 1' 1 2 15; reserve() {{ ( set -C; exec 3> \"$1\" && [ -f \"$1\" ] && [ ! -L \"$1\" ] ) 2>/dev/null; }}; reserve \"$lock\" || {{ printf 'SORENO_FILE_CONFLICT\\n' >&2; exit 46; }}; locked=1; reserve \"$legacy_lock\" || {{ printf 'SORENO_FILE_CONFLICT\\n' >&2; exit 46; }}; legacy_locked=1; tmp=$(mktemp \"${{target}}.soreno.XXXXXX\"); cp -p \"$target\" \"$tmp\"; cat > \"$tmp\"; [ -f \"$target\" ] && [ ! -L \"$target\" ] || {{ printf 'SORENO_FILE_NOT_FILE\\n' >&2; exit 44; }}; if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum \"$target\"); else actual=$(shasum -a 256 \"$target\"); fi; actual=${{actual%% *}}; [ \"$actual\" = {} ] || {{ printf 'SORENO_FILE_CONFLICT\\n' >&2; exit 46; }}; mv -f \"$tmp\" \"$target\"",
        remote_guard(root, path),
        crate::ssh::quote(&parent),
        crate::ssh::quote(&target),
        crate::ssh::quote(expected_version),
    )
}

pub(super) fn remote_run(
    project: &AgentProject,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<u8>, ProjectFileError> {
    remote_run_with_timeout(project, script, input, limit, crate::ssh::TIMEOUT)
}

pub(super) fn remote_run_with_timeout(
    project: &AgentProject,
    script: &str,
    input: Option<&[u8]>,
    limit: usize,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, ProjectFileError> {
    let response = crate::ssh::run_output_with_timeout(
        remote_connection(project)?,
        script,
        input,
        limit,
        timeout,
    )
    .map_err(|message| ProjectFileError::new("ssh", message))?;
    if response.status == 0 {
        return Ok(response.stdout);
    }
    Err(remote_error(response.status, &response.stderr))
}

/// Exit status of a rename whose entry is left under its temporary name, reported on stderr as
/// `STRANDED_MARKER` followed by the project-relative temporary path and a NUL byte.
const STRANDED_STATUS: u8 = 50;
const STRANDED_MARKER: &[u8] = b"SORENO_FILE_STRANDED\0";

/// Maps the stderr markers of a failed remote script to a project file error.
pub(super) fn remote_error(status: u8, stderr: &[u8]) -> ProjectFileError {
    if status == STRANDED_STATUS {
        if let Some(path) = stranded_path(stderr) {
            return ProjectFileError::new("stranded", path.to_owned());
        }
    }
    let detail = String::from_utf8_lossy(stderr);
    if detail.contains("SORENO_FILE_SYMLINK") {
        symlink_error()
    } else if detail.contains("SORENO_FILE_NOT_DIRECTORY") {
        not_directory()
    } else if detail.contains("SORENO_FILE_NOT_FOUND") {
        ProjectFileError::new("notFound", "Le fichier demandé est introuvable.")
    } else if detail.contains("SORENO_FILE_NOT_FILE") {
        not_file()
    } else if detail.contains("SORENO_FILE_TOO_LARGE") {
        too_large()
    } else if detail.contains("SORENO_FILE_CONFLICT") {
        conflict()
    } else if detail.contains("SORENO_FILE_EXISTS") {
        exists()
    } else if detail.contains("SORENO_FILE_OUTSIDE") {
        invalid_path()
    } else {
        let detail = detail.trim();
        ProjectFileError::new(
            "ssh",
            if detail.is_empty() {
                format!("exit status {status}")
            } else {
                detail.to_owned()
            },
        )
    }
}

/// The path of the last NUL-framed stranded record, which cannot be forged by a path (no NUL byte).
fn stranded_path(stderr: &[u8]) -> Option<&str> {
    let start = stderr
        .windows(STRANDED_MARKER.len())
        .rposition(|window| window == STRANDED_MARKER)?
        + STRANDED_MARKER.len();
    let record = &stderr[start..];
    let end = record.iter().position(|&byte| byte == 0)?;
    std::str::from_utf8(&record[..end])
        .ok()
        .filter(|path| !path.is_empty())
}
