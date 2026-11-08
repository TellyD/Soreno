use super::{
    branches, execute, mutations, oid_output, repository_state, validate_ref_name, GitError,
    GitMutationResult, GitOperation, GitRemote, GitRepository,
};
use crate::agent_sessions::{AgentProject, AgentSessions};
use reqwest::Url;
use std::{collections::HashSet, path::Path};

const URL_LIMIT: usize = 4096;
const REBASE_PATH_LIMIT: usize = 10_000;
const REBASE_PATH_BYTES_LIMIT: usize = 64 * 1024;
pub(crate) const NETWORK_CONFIG: &[&str] = &[
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ssh.allow=always",
    "-c",
    "protocol.file.allow=always",
];

struct ResolvedRemote {
    fetch: Vec<String>,
    push: Vec<String>,
}

#[derive(PartialEq)]
struct LocalState {
    head: String,
    branch: Vec<u8>,
    index: Vec<u8>,
    worktree: Vec<u8>,
}

pub(crate) fn remotes(project: &AgentProject) -> Result<Vec<GitRemote>, GitError> {
    super::version(project)?;
    remote_names(project)?
        .into_iter()
        .map(|name| {
            let resolved = resolved_remote(project, &name)?;
            let url = resolved
                .fetch
                .first()
                .ok_or_else(|| GitError::new("malformed", "URL distante absente."))?;
            let push = resolved
                .push
                .first()
                .ok_or_else(|| GitError::new("malformed", "URL d’envoi distante absente."))?;
            let url = display_url(url);
            let push = display_url(push);
            let ambiguous = resolved.fetch.len() != 1 || resolved.push.len() != 1;
            Ok(GitRemote {
                name,
                push_url: (push != url).then_some(push),
                url,
                ambiguous: ambiguous.then_some(true),
            })
        })
        .collect()
}

/// Name and display fetch URL of the first existing remote among `names`, without reading the others.
pub(crate) fn first_remote_url(
    project: &AgentProject,
    names: &[&str],
) -> Result<Option<(String, String)>, GitError> {
    super::version(project)?;
    // Unused remotes may carry names Git accepts but `validate_remote_name` refuses.
    let existing = raw_remote_names(project)?;
    let Some(name) = names
        .iter()
        .find(|name| existing.iter().any(|remote| remote == *name))
    else {
        return Ok(None);
    };
    validate_remote_name(name)?;
    let urls = remote_urls(project, name, false)?;
    Ok(Some(((*name).to_owned(), display_url(&urls[0]))))
}

pub(crate) fn fetch(
    sessions: &AgentSessions,
    project_id: &str,
    remote: String,
    expected_url: String,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    validate_remote_name(&remote)?;
    validate_confirmation(&expected_url)?;
    mutations::with_mutation(sessions, project_id, version, move |project, snapshot| {
        require_no_operation(snapshot)?;
        fetch_remote(project, &remote, &expected_url)?;
        Ok(result("Dépôt distant actualisé.", snapshot.head.clone()))
    })
}

pub(crate) fn pull(
    sessions: &AgentSessions,
    project_id: &str,
    remote: String,
    expected_url: String,
    version: &str,
    rebase: bool,
) -> Result<GitMutationResult, GitError> {
    validate_remote_name(&remote)?;
    validate_confirmation(&expected_url)?;
    mutations::with_mutation(sessions, project_id, version, move |project, snapshot| {
        require_no_operation(snapshot)?;
        if rebase {
            if !snapshot.files.is_empty() {
                return Err(GitError::new(
                    "dirty",
                    "Commitez ou remisez les changements avant un pull avec rebase.",
                ));
            }
            require_safe_rebase_index(project)?;
        }
        if snapshot.files.iter().any(|file| file.conflict) {
            return Err(GitError::new(
                "conflict",
                "Résolvez tous les conflits avant de tirer.",
            ));
        }
        let branch = snapshot.branch.as_deref().ok_or_else(|| {
            GitError::new(
                "detached",
                "Une branche locale doit être active pour tirer.",
            )
        })?;
        let upstream = snapshot.upstream.as_deref().ok_or_else(|| {
            GitError::new("noUpstream", "La branche active n’a pas de branche amont.")
        })?;
        validate_ref_name(branch)?;
        let configured_remote = unique_config_value(
            project,
            &format!("branch.{branch}.remote"),
            "La branche active doit avoir un seul dépôt distant amont.",
        )?;
        if configured_remote != remote {
            return Err(GitError::new(
                "wrongUpstream",
                "La branche amont n’appartient pas au dépôt distant confirmé.",
            ));
        }
        let merge = unique_config_value(
            project,
            &format!("branch.{branch}.merge"),
            "La branche active doit avoir une seule source amont.",
        )?;
        let destination = merge.strip_prefix("refs/heads/").ok_or_else(|| {
            GitError::new(
                "wrongUpstream",
                "La source amont doit être une branche distante canonique.",
            )
        })?;
        validate_ref_name(destination)?;
        let canonical_upstream = format!("{remote}/{destination}");
        if upstream != canonical_upstream {
            return Err(GitError::new(
                "wrongUpstream",
                "Le suivi de la branche amont utilise un mapping non canonique.",
            ));
        }
        let upstream_ref = format!("refs/remotes/{canonical_upstream}");
        if snapshot.head.is_none() {
            return Err(GitError::new(
                "unborn",
                "Créez un premier commit avant de tirer.",
            ));
        }
        let before = local_state(project)?;
        fetch_remote(project, &remote, &expected_url)?;
        if local_state(project)? != before {
            return Err(GitError::new(
                "stale",
                "HEAD, l’index ou la copie de travail a changé pendant le fetch.",
            ));
        }
        oid_output(
            &execute(
                project,
                &[
                    "rev-parse",
                    "--verify",
                    &format!("{upstream_ref}^{{commit}}"),
                ],
                GitOperation::Read,
                None,
            )?
            .stdout,
            "OID de la branche amont",
        )?;
        if rebase {
            require_no_untracked_upstream_collisions(project, &upstream_ref)?;
            rebase_onto(project, &upstream_ref, &before)?;
        } else {
            // A failed --ff-only merge is reported as an uncertain mutation; divergence is known beforehand.
            // shortcut: is_ancestor reads any generic Git failure (corrupt object) as "not ancestor", so such a repository reports `diverged`; distinguish exit 1 if it misleads users.
            if !branches::is_ancestor(project, "HEAD", &upstream_ref)?
                && !branches::is_ancestor(project, &upstream_ref, "HEAD")?
            {
                return Err(GitError::new(
                    "diverged",
                    "La branche locale et sa branche amont ont divergé : utilisez Pull avec rebase.",
                ));
            }
            let mut args = NETWORK_CONFIG.to_vec();
            args.extend([
                "-c",
                "submodule.recurse=false",
                "merge",
                "--ff-only",
                "--no-autostash",
                "--no-overwrite-ignore",
                &upstream_ref,
            ]);
            network_execute(project, &args)?;
        }
        let oid = oid_output(
            &execute(
                project,
                &["rev-parse", "--verify", "HEAD^{commit}"],
                GitOperation::Read,
                None,
            )?
            .stdout,
            "OID de HEAD",
        )?;
        Ok(result("Branche synchronisée.", Some(oid)))
    })
}

pub(crate) fn push(
    sessions: &AgentSessions,
    project_id: &str,
    remote: String,
    branch: String,
    expected_url: String,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    validate_remote_name(&remote)?;
    validate_ref_name(&branch)?;
    validate_confirmation(&expected_url)?;
    mutations::with_mutation(sessions, project_id, version, move |project, snapshot| {
        require_no_operation(snapshot)?;
        let current = snapshot.branch.as_deref().ok_or_else(|| {
            GitError::new(
                "detached",
                "Une branche locale doit être active pour publier.",
            )
        })?;
        validate_ref_name(current)?;
        confirm_remote(project, &remote, &expected_url, true)?;
        let source = format!("refs/heads/{current}");
        let refspec = format!("{source}:refs/heads/{branch}");
        let mirror_config = format!("remote.{remote}.mirror=false");
        let mut args = NETWORK_CONFIG.to_vec();
        args.extend([
            "-c",
            &mirror_config,
            "-c",
            "push.followTags=false",
            "-c",
            "push.recurseSubmodules=no",
            "push",
            "--porcelain",
            "--no-force",
            "--no-mirror",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "--set-upstream",
            &remote,
            &refspec,
        ]);
        network_execute(project, &args)?;
        Ok(result("Branche publiée.", snapshot.head.clone()))
    })
}

fn fetch_remote(project: &AgentProject, remote: &str, expected_url: &str) -> Result<(), GitError> {
    confirm_remote(project, remote, expected_url, false)?;
    fetch_explicit(
        project,
        remote,
        &[&format!("+refs/heads/*:refs/remotes/{remote}/*")],
    )
}

/// Fetches explicit refspecs (pull request heads, commits) from a remote whose URL the caller did not confirm.
pub(crate) fn fetch_refspecs(
    project: &AgentProject,
    remote: &str,
    refspecs: &[&str],
) -> Result<(), GitError> {
    validate_remote_name(remote)?;
    require_safe_remote_config(project, remote)?;
    let resolved = resolved_remote(project, remote)?;
    require_unambiguous(&resolved)?;
    validate_remote_url(&resolved.fetch[0])?;
    fetch_explicit(project, remote, refspecs)
}

fn fetch_explicit(project: &AgentProject, remote: &str, refspecs: &[&str]) -> Result<(), GitError> {
    let prune_config = format!("remote.{remote}.prune=false");
    let prune_tags_config = format!("remote.{remote}.pruneTags=false");
    let mut args = NETWORK_CONFIG.to_vec();
    args.extend([
        "-c",
        "fetch.prune=false",
        "-c",
        "fetch.pruneTags=false",
        "-c",
        &prune_config,
        "-c",
        &prune_tags_config,
        "-c",
        "submodule.recurse=false",
        "fetch",
        "--no-prune",
        "--no-prune-tags",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--refmap=",
        remote,
    ]);
    args.extend(refspecs);
    network_execute(project, &args)
}

fn config_values(project: &AgentProject, key: &str) -> Result<Vec<String>, GitError> {
    const MARKER: &str = "__SORENO_CONFIG_PROBE__";
    let override_value = format!("{key}={MARKER}");
    let output = execute(
        project,
        &["-c", &override_value, "config", "--null", "--get-all", key],
        GitOperation::Read,
        None,
    )?;
    let text = String::from_utf8(output.stdout)
        .map_err(|_| GitError::new("malformed", "Configuration Git non UTF-8."))?;
    let mut values = text
        .strip_suffix('\0')
        .unwrap_or(&text)
        .split('\0')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if values.pop().as_deref() != Some(MARKER) {
        return Err(GitError::new(
            "malformed",
            "Impossible de vérifier la configuration Git.",
        ));
    }
    Ok(values)
}

fn unique_config_value(
    project: &AgentProject,
    key: &str,
    message: &str,
) -> Result<String, GitError> {
    let values = config_values(project, key)?;
    if values.len() != 1 {
        return Err(GitError::new("wrongUpstream", message));
    }
    Ok(values.into_iter().next().unwrap())
}

fn require_safe_remote_config(project: &AgentProject, remote: &str) -> Result<(), GitError> {
    if config_values(project, &format!("remote.{remote}.vcs"))?.is_empty() {
        Ok(())
    } else {
        Err(GitError::new(
            "unsafeRemote",
            "La configuration remote.vcs personnalisée est interdite.",
        ))
    }
}

fn confirm_remote(
    project: &AgentProject,
    remote: &str,
    expected_url: &str,
    pushing: bool,
) -> Result<(), GitError> {
    require_safe_remote_config(project, remote)?;
    let resolved = resolved_remote(project, remote)?;
    require_unambiguous(&resolved)?;
    let current = if pushing {
        &resolved.push[0]
    } else {
        &resolved.fetch[0]
    };
    validate_remote_url(current)?;
    if display_url(current) != expected_url {
        return Err(stale_url());
    }
    Ok(())
}

fn resolved_remote(project: &AgentProject, name: &str) -> Result<ResolvedRemote, GitError> {
    validate_remote_name(name)?;
    Ok(ResolvedRemote {
        fetch: remote_urls(project, name, false)?,
        push: remote_urls(project, name, true)?,
    })
}

fn remote_names(project: &AgentProject) -> Result<Vec<String>, GitError> {
    let names = raw_remote_names(project)?;
    for name in &names {
        validate_remote_name(name)?;
    }
    Ok(names)
}

fn raw_remote_names(project: &AgentProject) -> Result<Vec<String>, GitError> {
    let output = execute(project, &["remote"], GitOperation::Read, None)?;
    let text = String::from_utf8(output.stdout)
        .map_err(|_| GitError::new("malformed", "Liste de dépôts distants non UTF-8."))?;
    Ok(text
        .lines()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect())
}

fn remote_urls(project: &AgentProject, name: &str, pushing: bool) -> Result<Vec<String>, GitError> {
    let output = if pushing {
        execute(
            project,
            &["remote", "get-url", "--push", "--all", name],
            GitOperation::Read,
            None,
        )?
    } else {
        execute(
            project,
            &["remote", "get-url", "--all", name],
            GitOperation::Read,
            None,
        )?
    };
    let text = String::from_utf8(output.stdout)
        .map_err(|_| GitError::new("malformed", "URL distante non UTF-8."))?;
    let urls = text
        .lines()
        .map(|url| {
            validate_plain_value(url, "URL distante invalide.")?;
            Ok(url.to_owned())
        })
        .collect::<Result<Vec<_>, GitError>>()?;
    if urls.is_empty() {
        return Err(GitError::new("malformed", "URL distante absente."));
    }
    Ok(urls)
}

pub(crate) fn resolve_candidate(project: &AgentProject, url: &str) -> Result<String, GitError> {
    let output = execute(
        project,
        &["ls-remote", "--get-url", url],
        GitOperation::Read,
        None,
    )
    .map_err(redact_error)?;
    let resolved = String::from_utf8(output.stdout)
        .map_err(|_| GitError::new("malformed", "URL distante résolue non UTF-8."))?;
    let resolved = resolved.trim_end_matches(['\r', '\n']);
    validate_plain_value(resolved, "URL distante résolue invalide.")?;
    Ok(resolved.to_owned())
}

fn require_unambiguous(remote: &ResolvedRemote) -> Result<(), GitError> {
    if remote.fetch.len() != 1 || remote.push.len() != 1 {
        return Err(GitError::new(
            "ambiguousRemote",
            "Ce dépôt distant possède plusieurs URL de lecture ou d’envoi.",
        ));
    }
    Ok(())
}

fn validate_remote_name(value: &str) -> Result<(), GitError> {
    validate_ref_name(value)?;
    if value.contains('/')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(GitError::new(
            "invalidRemote",
            "Nom de dépôt distant invalide.",
        ));
    }
    Ok(())
}

fn validate_confirmation(value: &str) -> Result<(), GitError> {
    validate_plain_value(value, "Confirmation d’URL invalide.")
}

fn validate_plain_value(value: &str, message: &str) -> Result<(), GitError> {
    if value.is_empty()
        || value.len() > URL_LIMIT
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        return Err(GitError::new("invalidUrl", message));
    }
    Ok(())
}

pub(crate) fn validate_remote_url(value: &str) -> Result<(), GitError> {
    validate_plain_value(value, "URL distante invalide.")?;
    if value.contains("::") {
        return Err(GitError::new(
            "unsafeUrl",
            "Les assistants de transport Git personnalisés sont interdits.",
        ));
    }
    if is_windows_path(value) {
        return Ok(());
    }
    if value.contains("://") {
        let url =
            Url::parse(value).map_err(|_| GitError::new("invalidUrl", "URL distante invalide."))?;
        if url.query().is_some() || url.fragment().is_some() || contains_encoded_control(value) {
            return Err(GitError::new(
                "unsafeUrl",
                "Les paramètres et fragments d’URL distante sont interdits.",
            ));
        }
        return match url.scheme() {
            "https" => {
                if url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    Err(GitError::new(
                        "unsafeUrl",
                        "Une URL HTTPS distante ne doit pas contenir d’identifiants.",
                    ))
                } else {
                    validate_host(url.host_str().unwrap())
                }
            }
            "ssh" => {
                validate_host(url.host_str().unwrap_or(""))?;
                if url.password().is_some()
                    || url.username().starts_with('-')
                    || url.username().contains('%')
                {
                    Err(GitError::new(
                        "unsafeUrl",
                        "Les identifiants SSH distants sont invalides.",
                    ))
                } else {
                    Ok(())
                }
            }
            "file" => {
                if (!url.username().is_empty() || url.password().is_some())
                    || url.host_str().is_some_and(|host| host != "localhost")
                    || !url.path().starts_with('/')
                {
                    Err(GitError::new("unsafeUrl", "URL file distante invalide."))
                } else {
                    Ok(())
                }
            }
            _ => Err(GitError::new(
                "unsafeUrl",
                "Seuls HTTPS, SSH, file et les chemins locaux sont autorisés.",
            )),
        };
    }
    if Path::new(value).is_absolute() {
        return Ok(());
    }
    if let Some((authority, path)) = value.split_once(':') {
        if authority.contains(['/', '\\']) {
            return Ok(());
        }
        if let Some(host) = authority.strip_prefix("git@") {
            validate_host(host)?;
            if path.is_empty() || path.starts_with('-') {
                return Err(GitError::new("unsafeUrl", "URL SCP distante invalide."));
            }
            return Ok(());
        }
        return Err(GitError::new(
            "unsafeUrl",
            "Seules les URL SCP de forme git@hôte:chemin sont autorisées.",
        ));
    }
    Ok(())
}

fn validate_host(host: &str) -> Result<(), GitError> {
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".:-[]".contains(&byte))
    {
        Err(GitError::new("unsafeUrl", "Hôte Git distant invalide."))
    } else {
        Ok(())
    }
}

fn contains_encoded_control(value: &str) -> bool {
    value.as_bytes().windows(3).any(|bytes| {
        bytes[0] == b'%'
            && std::str::from_utf8(&bytes[1..])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                .is_some_and(|byte| byte.is_ascii_control())
    })
}

fn is_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\'))
        || value.starts_with("\\\\")
}

fn display_url(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return value.to_owned();
    };
    if url.scheme() != "ssh" && !url.username().is_empty() {
        let _ = url.set_username("***");
    }
    if url.password().is_some() {
        let _ = url.set_password(Some("***"));
    }
    if url.query().is_some() {
        url.set_query(Some("***"));
    }
    if url.fragment().is_some() {
        url.set_fragment(Some("***"));
    }
    url.to_string()
}

fn local_state(project: &AgentProject) -> Result<LocalState, GitError> {
    Ok(LocalState {
        head: oid_output(
            &execute(
                project,
                &["rev-parse", "--verify", "HEAD^{commit}"],
                GitOperation::Read,
                None,
            )?
            .stdout,
            "OID de HEAD",
        )?,
        branch: execute(
            project,
            &["branch", "--show-current"],
            GitOperation::Read,
            None,
        )?
        .stdout,
        index: execute(
            project,
            &["ls-files", "--stage", "-z"],
            GitOperation::Read,
            None,
        )?
        .stdout,
        worktree: execute(
            project,
            &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
            GitOperation::Read,
            None,
        )?
        .stdout,
    })
}

fn require_safe_rebase_index(project: &AgentProject) -> Result<(), GitError> {
    let output = execute(project, &["ls-files", "-v", "-z"], GitOperation::Read, None)?.stdout;
    if output.is_empty() {
        return Ok(());
    }
    if !output.ends_with(&[0]) {
        return Err(GitError::new(
            "malformed",
            "Impossible de vérifier les marqueurs de l’index Git.",
        ));
    }
    for entry in output[..output.len() - 1].split(|byte| *byte == 0) {
        if entry.len() < 3 || entry[1] != b' ' {
            return Err(GitError::new(
                "malformed",
                "Impossible de vérifier les marqueurs de l’index Git.",
            ));
        }
        if entry[0] == b'S' || entry[0].is_ascii_lowercase() {
            return Err(GitError::new(
                "dirty",
                "Retirez les marqueurs assume-unchanged et skip-worktree avant un pull avec rebase.",
            ));
        }
    }
    Ok(())
}

fn require_no_untracked_upstream_collisions(
    project: &AgentProject,
    upstream_ref: &str,
) -> Result<(), GitError> {
    let range = format!("{upstream_ref}..HEAD");
    let mut replayed_paths = HashSet::new();
    let mut replayed_path_bytes = 0;
    for output in [
        execute(
            project,
            &[
                "diff",
                "--name-only",
                "--diff-filter=ACDMRTUXB",
                "-z",
                "HEAD",
                upstream_ref,
                "--",
            ],
            GitOperation::Read,
            None,
        )?
        .stdout,
        execute(
            project,
            &[
                "log",
                "--root",
                "--format=",
                "--name-only",
                "-z",
                &range,
                "--",
            ],
            GitOperation::Read,
            None,
        )?
        .stdout,
    ] {
        for path in bounded_rebase_paths(output)? {
            let bytes = path.len() + 1;
            if replayed_paths.insert(path) {
                replayed_path_bytes += bytes;
                if replayed_paths.len() > REBASE_PATH_LIMIT
                    || replayed_path_bytes > REBASE_PATH_BYTES_LIMIT
                {
                    return Err(too_many_rebase_paths());
                }
            }
        }
    }
    if replayed_paths.is_empty() {
        return Ok(());
    }

    let untracked = execute(
        project,
        &[
            "ls-files",
            "--others",
            "--directory",
            "--no-empty-directory",
            "-z",
        ],
        GitOperation::Read,
        None,
    )?
    .stdout;
    let mut untracked_paths = HashSet::new();
    for mut path in bounded_rebase_paths(untracked)? {
        if path.last() == Some(&b'/') {
            path.pop();
            if path.is_empty() {
                return Err(malformed_rebase_paths());
            }
        }
        untracked_paths.insert(path);
    }
    if untracked_paths.iter().any(|untracked| {
        replayed_paths
            .iter()
            .any(|replayed| paths_overlap(untracked, replayed))
    }) {
        return Err(GitError::new(
            "dirty",
            "Un fichier local non suivi ou ignoré serait écrasé par le rebase.",
        ));
    }
    Ok(())
}

fn bounded_rebase_paths(output: Vec<u8>) -> Result<Vec<Vec<u8>>, GitError> {
    if output.is_empty() {
        return Ok(Vec::new());
    }
    if !output.ends_with(&[0])
        || output[..output.len() - 1]
            .split(|byte| *byte == 0)
            .any(|path| path.is_empty())
    {
        return Err(malformed_rebase_paths());
    }
    if output.len() > REBASE_PATH_BYTES_LIMIT {
        return Err(too_many_rebase_paths());
    }
    let paths = output[..output.len() - 1]
        .split(|byte| *byte == 0)
        .map(<[u8]>::to_vec)
        .collect::<Vec<_>>();
    if paths.len() > REBASE_PATH_LIMIT {
        return Err(too_many_rebase_paths());
    }
    Ok(paths)
}

fn paths_overlap(left: &[u8], right: &[u8]) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with(b"/"))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with(b"/"))
}

fn malformed_rebase_paths() -> GitError {
    GitError::new(
        "malformed",
        "Impossible de vérifier les collisions de chemins du rebase.",
    )
}

fn too_many_rebase_paths() -> GitError {
    GitError::new(
        "tooManyFiles",
        "Trop de chemins ont changé pour vérifier le rebase de façon sûre.",
    )
}

fn rebase_onto(
    project: &AgentProject,
    upstream_ref: &str,
    before: &LocalState,
) -> Result<(), GitError> {
    let result = execute(
        project,
        &[
            "-c",
            "submodule.recurse=false",
            "-c",
            "merge.directoryRenames=false",
            "-c",
            "rebase.autoStash=false",
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "rebase.instructionFormat=%s",
            "-c",
            "rebase.abbreviateCommands=false",
            "-c",
            "core.hooksPath=",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "sequence.editor=true",
            "rebase",
            "--no-autostash",
            "--no-fork-point",
            "--no-rebase-merges",
            "--no-stat",
            upstream_ref,
        ],
        GitOperation::LocalMutation,
        None,
    );
    let Err(mut error) = result else {
        return Ok(());
    };
    if repository_state(project).is_ok_and(|state| state.operation.as_deref() == Some("rebase")) {
        let conflicts = execute(
            project,
            &["ls-files", "--unmerged", "-z"],
            GitOperation::Read,
            None,
        )
        .map(|output| !output.stdout.is_empty());
        let restored = execute(
            project,
            &[
                "-c",
                "core.hooksPath=",
                "-c",
                "submodule.recurse=false",
                "-c",
                "merge.directoryRenames=false",
                "rebase",
                "--abort",
            ],
            GitOperation::LocalMutation,
            None,
        )
        .is_ok()
            && local_state(project).is_ok_and(|state| state == *before)
            && repository_state(project).is_ok_and(|state| state.operation.is_none());
        if restored {
            if conflicts == Ok(true) {
                return Err(GitError::new(
                    "rebaseConflict",
                    "Le rebase a rencontré un conflit et a été automatiquement abandonné.",
                ));
            }
            if conflicts == Ok(false) {
                error.uncertain = None;
                return Err(error);
            }
        }
        error.uncertain = Some(true);
    }
    Err(error)
}

fn network_execute(project: &AgentProject, args: &[&str]) -> Result<(), GitError> {
    execute(project, args, GitOperation::RemoteMutation, None)
        .map(|_| ())
        .map_err(redact_error)
}

pub(crate) fn redact_error(mut error: GitError) -> GitError {
    error.message = error
        .message
        .split_whitespace()
        .map(|word| {
            let trimmed = word.trim_matches(|character: char| {
                matches!(character, '\'' | '"' | '(' | ')' | '[' | ']' | ',' | ';')
            });
            if trimmed.contains("://") {
                word.replace(trimmed, &display_url(trimmed))
            } else {
                word.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    error
}

fn require_no_operation(snapshot: &GitRepository) -> Result<(), GitError> {
    if snapshot.operation.is_some() {
        Err(GitError::new(
            "operation",
            "Terminez ou annulez l’opération Git en cours avant cette mutation distante.",
        ))
    } else {
        Ok(())
    }
}

fn stale_url() -> GitError {
    GitError::new(
        "staleUrl",
        "L’URL distante a changé. Actualisez le panneau avant de réessayer.",
    )
}

fn result(message: &str, oid: Option<String>) -> GitMutationResult {
    GitMutationResult {
        oid,
        message: message.into(),
        warning: None,
    }
}

#[cfg(test)]
#[path = "remotes_tests.rs"]
mod tests;
