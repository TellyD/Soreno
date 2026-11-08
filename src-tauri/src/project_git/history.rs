use super::{
    execute, oid_output, reading, validate_oid, validate_relative_path, GitCommit, GitCommitDetail,
    GitCommitReference, GitCommitReferenceKind, GitComparison, GitError, GitHistory, GitOperation,
};
use crate::agent_sessions::AgentProject;
use std::collections::HashSet;

const PAGE_SIZE: usize = 50;

pub(crate) fn history(
    project: &AgentProject,
    roots: Option<&[String]>,
    offset: usize,
    path: Option<&str>,
) -> Result<GitHistory, GitError> {
    if let Some(path) = path {
        validate_relative_path(path)?;
    }
    super::version(project)?;
    let roots = match roots {
        Some(roots) => validate_roots(roots)?,
        None => history_roots(project)?,
    };
    if roots.is_empty() {
        return Ok(GitHistory {
            roots,
            commits: Vec::new(),
            has_more: false,
        });
    }
    let count = (PAGE_SIZE + 1).to_string();
    let skip = offset.to_string();
    let input = format!("{}\n", roots.join("\n"));
    let pathspec = path.map(|path| format!(":(literal){path}"));
    let mut args = vec![
        "log",
        "--decorate=full",
        "--decorate-refs=HEAD",
        "--decorate-refs=refs/heads/*",
        "--decorate-refs=refs/remotes/*",
        "--decorate-refs=refs/tags/*",
        "--topo-order",
        "--no-show-signature",
        "-z",
        "--format=%H%x00%P%x00%an%x00%cI%x00%s%x00%D",
        "--max-count",
        &count,
        "--skip",
        &skip,
        "--stdin",
    ];
    if let Some(pathspec) = &pathspec {
        // Parent rewriting keeps the graph connected across commits that skip the path.
        args.extend(["--parents", "--", pathspec.as_str()]);
    }
    let output = execute(project, &args, GitOperation::Read, Some(input.as_bytes()))?;
    let mut fields = output.stdout.split(|byte| *byte == 0);
    let mut commits = Vec::new();
    loop {
        let Some(oid) = fields.next() else { break };
        if oid.is_empty() {
            break;
        }
        let parents = fields.next().ok_or_else(malformed_history)?;
        let author = fields.next().ok_or_else(malformed_history)?;
        let date = fields.next().ok_or_else(malformed_history)?;
        let subject = fields.next().ok_or_else(malformed_history)?;
        let references = fields.next().ok_or_else(malformed_history)?;
        let oid = text(oid, "OID de commit")?;
        validate_oid(&oid)?;
        commits.push(GitCommit {
            oid,
            parents: parse_parents(parents)?,
            references: parse_references(references)?,
            author: text(author, "auteur de commit")?,
            date: text(date, "date de commit")?,
            subject: text(subject, "sujet de commit")?,
        });
    }
    let has_more = commits.len() > PAGE_SIZE;
    commits.truncate(PAGE_SIZE);
    Ok(GitHistory {
        roots,
        commits,
        has_more,
    })
}

pub(crate) fn commit_detail(
    project: &AgentProject,
    oid: &str,
) -> Result<GitCommitDetail, GitError> {
    validate_oid(oid)?;
    super::version(project)?;
    reading::commit_detail(project, oid)
}

pub(crate) fn commit_comparison(
    project: &AgentProject,
    oid: &str,
    path: &str,
) -> Result<GitComparison, GitError> {
    validate_relative_path(path)?;
    validate_oid(oid)?;
    super::version(project)?;
    reading::commit_comparison(project, oid, path)?.ok_or_else(|| {
        GitError::new(
            "stalePath",
            "Ce chemin ne figure pas dans les changements de ce commit.",
        )
    })
}

/// Project directory relative to the worktree root (`""` or `dir/`); `None` outside a repository.
pub(crate) fn path_prefix(project: &AgentProject) -> Result<Option<String>, GitError> {
    super::version(project)?;
    let output = match execute(
        project,
        &["rev-parse", "--show-prefix"],
        GitOperation::Read,
        None,
    ) {
        Ok(output) => output,
        Err(error) if error.code == "notRepo" => return Ok(None),
        Err(error) => return Err(error),
    };
    let prefix = text(&output.stdout, "préfixe Git")?;
    let prefix = prefix.strip_suffix('\n').unwrap_or(&prefix);
    if let Some(directory) = prefix.strip_suffix('/') {
        validate_relative_path(directory)?;
    } else if !prefix.is_empty() {
        return Err(GitError::new("malformed", "Préfixe Git invalide."));
    }
    Ok(Some(prefix.to_owned()))
}

fn optional_head(project: &AgentProject) -> Result<Option<String>, GitError> {
    match execute(
        project,
        &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
        GitOperation::Read,
        None,
    ) {
        Ok(output) => oid_output(&output.stdout, "OID de HEAD").map(Some),
        Err(error) if error.code == "failed" => Ok(None),
        Err(error) => Err(error),
    }
}

fn history_roots(project: &AgentProject) -> Result<Vec<String>, GitError> {
    let mut roots = optional_head(project)?.into_iter().collect::<Vec<_>>();
    let mut seen = roots.iter().cloned().collect::<HashSet<_>>();
    let output = execute(
        project,
        &[
            "rev-list",
            "--branches",
            "--remotes",
            "--tags",
            "--no-walk=unsorted",
        ],
        GitOperation::Read,
        None,
    )?;
    for line in output.stdout.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let oid = text(line, "racine d’historique")?;
        validate_oid(&oid)?;
        if seen.insert(oid.clone()) {
            roots.push(oid);
        }
    }
    Ok(roots)
}

fn validate_roots(roots: &[String]) -> Result<Vec<String>, GitError> {
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for root in roots {
        validate_oid(root)?;
        if seen.insert(root) {
            validated.push(root.clone());
        }
    }
    Ok(validated)
}

fn parse_parents(bytes: &[u8]) -> Result<Vec<String>, GitError> {
    text(bytes, "parents de commit")?
        .split_whitespace()
        .map(|parent| {
            validate_oid(parent)?;
            Ok(parent.to_owned())
        })
        .collect()
}

fn parse_references(bytes: &[u8]) -> Result<Vec<GitCommitReference>, GitError> {
    let mut references = Vec::new();
    for decoration in text(bytes, "références de commit")?
        .split(", ")
        .filter(|value| !value.is_empty())
    {
        for value in decoration.split(" -> ") {
            let parsed = if value == "HEAD" {
                Some(GitCommitReference {
                    name: "HEAD".into(),
                    kind: GitCommitReferenceKind::Head,
                })
            } else {
                [
                    ("refs/heads/", GitCommitReferenceKind::LocalBranch),
                    ("refs/remotes/", GitCommitReferenceKind::RemoteBranch),
                    ("tag: refs/tags/", GitCommitReferenceKind::Tag),
                ]
                .into_iter()
                .find_map(|(prefix, kind)| value.strip_prefix(prefix).map(|name| (name, kind)))
                .map(|(name, kind)| {
                    if name.is_empty()
                        || name.chars().any(|character| {
                            character.is_ascii_control() || character.is_ascii_whitespace()
                        })
                    {
                        return Err(malformed_history());
                    }
                    Ok(GitCommitReference {
                        name: name.into(),
                        kind,
                    })
                })
                .transpose()?
            };
            if let Some(reference) = parsed {
                if !references.contains(&reference) {
                    references.push(reference);
                }
            }
        }
    }
    Ok(references)
}

fn malformed_history() -> GitError {
    GitError::new("malformed", "Git a retourné un historique incomplet.")
}

fn text(bytes: &[u8], label: &str) -> Result<String, GitError> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| GitError::new("malformed", format!("{label} non UTF-8.")))
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
