use super::{
    command_builder::git_command, execute, object_hash, run_command,
    ssh_transport::ssh_git_execute, AgentProject, GitError, GitIdentity, GitOperation,
    GitRepository, READ_TIMEOUT,
};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

#[cfg(windows)]
use super::wsl_read;
#[cfg(not(windows))]
use super::GitOutput;
#[cfg(test)]
use super::TEST_GIT_COMMANDS;

#[cfg(test)]
pub(crate) fn reset_test_git_version(project: &AgentProject) {
    invalidate_version(project);
}

const MINIMUM_GIT: (u32, u32, u32) = (2, 35, 0);

pub(super) fn read_text(project: &AgentProject, args: &[&str]) -> Result<String, GitError> {
    let output = execute(project, args, GitOperation::Read, None)?;
    String::from_utf8(output.stdout)
        .map(|text| text.trim_end_matches(['\r', '\n']).to_owned())
        .map_err(|_| GitError::new("malformed", "Git a retourné un texte non UTF-8."))
}

fn read_path(project: &AgentProject, args: &[&str]) -> Result<String, GitError> {
    let output = execute(project, args, GitOperation::Read, None)?;
    String::from_utf8(output.stdout)
        .map(|text| text.strip_suffix('\n').unwrap_or(&text).to_owned())
        .map_err(|_| GitError::new("malformed", "Git a retourné un chemin non UTF-8."))
}

pub(super) fn version_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn environment_key(project: &AgentProject) -> String {
    match project.environment.kind.as_str() {
        "wsl" => format!(
            "wsl:{}",
            project
                .environment
                .distribution
                .as_deref()
                .unwrap_or_default()
                .to_ascii_lowercase()
        ),
        "ssh" => format!(
            "ssh:{}",
            project
                .environment
                .ssh
                .as_ref()
                .and_then(|connection| serde_json::to_string(connection).ok())
                .unwrap_or_default()
        ),
        _ => "local".into(),
    }
}

pub(super) fn invalidate_version(project: &AgentProject) {
    version_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&environment_key(project));
}

pub(super) fn version(project: &AgentProject) -> Result<String, GitError> {
    let key = environment_key(project);
    if let Some(version) = version_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .cloned()
    {
        return Ok(version);
    }

    #[cfg(test)]
    TEST_GIT_COMMANDS.with(|count| count.set(count.get() + 1));
    let result: Result<String, GitError> = (|| {
        #[cfg(windows)]
        let accelerated = wsl_read::execute_if_enabled(
            project,
            &["--version"],
            None,
            READ_TIMEOUT,
            false,
            || {
                run_command(
                    git_command(project, &["--version"])?,
                    READ_TIMEOUT,
                    false,
                    None,
                )
            },
        );
        #[cfg(not(windows))]
        let accelerated: Option<Result<GitOutput, GitError>> = None;
        let output = if project.environment.kind == "ssh" {
            ssh_git_execute(project, &["--version"], READ_TIMEOUT, false, None)
        } else {
            accelerated.unwrap_or_else(|| {
                run_command(
                    git_command(project, &["--version"])?,
                    READ_TIMEOUT,
                    false,
                    None,
                )
            })
        }?;
        let text = String::from_utf8(output.stdout)
            .map_err(|_| GitError::new("malformed", "Version Git non UTF-8."))?;
        let version = text
            .trim()
            .strip_prefix("git version ")
            .ok_or_else(|| GitError::new("malformed", "Réponse de version Git invalide."))?;
        let parsed = parse_version(version)
            .ok_or_else(|| GitError::new("malformed", "Version Git invalide."))?;
        if parsed < MINIMUM_GIT {
            return Err(GitError::new(
                "old",
                format!("Git 2.35 ou plus récent est requis (version détectée : {version})."),
            ));
        }
        Ok(version.into())
    })();

    if let Ok(version) = &result {
        version_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, version.clone());
    }
    result
}

pub(super) fn parse_version(value: &str) -> Option<(u32, u32, u32)> {
    let mut parts = value.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts
            .next()?
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .ok()?,
    ))
}

fn canonical_identity_path(project: &AgentProject, value: String) -> Result<String, GitError> {
    if value.is_empty() || value.contains('\0') {
        return Err(GitError::new("malformed", "Chemin Git invalide."));
    }
    if matches!(project.environment.kind.as_str(), "wsl" | "ssh") {
        if !value.starts_with('/') {
            return Err(GitError::new(
                "malformed",
                "Git n’a pas retourné un chemin distant absolu.",
            ));
        }
        if project.environment.kind == "ssh" {
            crate::ssh::validate_path(&value)
                .map_err(|message| GitError::new("malformed", message))?;
        }
        return Ok(value);
    }
    std::fs::canonicalize(&value)
        .map_err(|error| {
            GitError::new("inaccessible", format!("Chemin Git inaccessible : {error}"))
        })?
        .into_os_string()
        .into_string()
        .map_err(|_| GitError::new("malformed", "Chemin Git non Unicode."))
}

pub(super) fn empty_repository(availability: &str, version: String) -> GitRepository {
    GitRepository {
        availability: availability.into(),
        identity: None,
        version,
        head: None,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        tracking_known: false,
        operation: None,
        merge_message: None,
        files: Vec::new(),
        limited: false,
        truncated: false,
    }
}

pub(super) fn parse_fast_metadata(
    output: &[u8],
) -> Result<Option<(String, String, String, object_hash::ObjectFormat)>, GitError> {
    let output = output.strip_suffix(b"\n").unwrap_or(output);
    let fields = output.split(|byte| *byte == b'\n').collect::<Vec<_>>();
    if fields.len() > 5 {
        return Ok(None);
    }
    if fields.len() != 5
        || fields[0] != b"false"
        || fields[1..4].iter().any(|field| field.is_empty())
    {
        return Err(GitError::new(
            "malformed",
            "Git a retourné des métadonnées de dépôt invalides.",
        ));
    }
    let path = |bytes: &[u8]| {
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| GitError::new("malformed", "Chemin Git non UTF-8."))
    };
    let format = std::str::from_utf8(fields[4])
        .map_err(|_| GitError::new("malformed", "Format d’objet Git non UTF-8."))?;
    Ok(Some((
        path(fields[1])?,
        path(fields[2])?,
        path(fields[3])?,
        object_hash::ObjectFormat::parse(format)?,
    )))
}

fn identified_repository(
    project: &AgentProject,
    version: String,
    bare: bool,
    git_dir: String,
    common_dir: String,
    root: Option<String>,
    object_format: object_hash::ObjectFormat,
) -> Result<GitRepository, GitError> {
    let git_dir = canonical_identity_path(project, git_dir)?;
    let common_dir = canonical_identity_path(project, common_dir)?;
    let root = if bare {
        git_dir.clone()
    } else {
        canonical_identity_path(
            project,
            root.ok_or_else(|| GitError::new("malformed", "Racine Git absente."))?,
        )?
    };
    let mut repository = empty_repository(if bare { "bare" } else { "ready" }, version);
    repository.identity = Some(GitIdentity {
        root,
        git_dir,
        common_dir,
        object_format,
    });
    Ok(repository)
}

fn discover_repository_slow(
    project: &AgentProject,
    version: String,
) -> Result<GitRepository, GitError> {
    let bare = match read_text(project, &["rev-parse", "--is-bare-repository"]) {
        Ok(value) if value == "true" => true,
        Ok(value) if value == "false" => false,
        Ok(_) => return Err(GitError::new("malformed", "Type de dépôt Git invalide.")),
        Err(error) if error.code == "notRepo" => {
            return Ok(empty_repository("notRepository", version));
        }
        Err(error) => return Err(error),
    };
    let git_dir = read_path(project, &["rev-parse", "--absolute-git-dir"])?;
    let common_dir = read_path(
        project,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let root = if bare {
        None
    } else {
        Some(read_path(
            project,
            &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        )?)
    };
    let object_format = object_hash::ObjectFormat::parse(&read_text(
        project,
        &["rev-parse", "--show-object-format=storage"],
    )?)?;
    identified_repository(
        project,
        version,
        bare,
        git_dir,
        common_dir,
        root,
        object_format,
    )
}

pub(crate) fn discover_repository(project: &AgentProject) -> Result<GitRepository, GitError> {
    let version = version(project)?;
    match execute(
        project,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--is-bare-repository",
            "--absolute-git-dir",
            "--git-common-dir",
            "--show-toplevel",
            "--show-object-format=storage",
        ],
        GitOperation::Read,
        None,
    ) {
        Ok(output) => {
            if let Some((git_dir, common_dir, root, object_format)) =
                parse_fast_metadata(&output.stdout)?
            {
                return identified_repository(
                    project,
                    version,
                    false,
                    git_dir,
                    common_dir,
                    Some(root),
                    object_format,
                );
            }
        }
        Err(error) if error.code == "notRepo" => {
            return Ok(empty_repository("notRepository", version));
        }
        Err(error) if error.code == "failed" => {}
        Err(error) => return Err(error),
    }
    discover_repository_slow(project, version)
}
