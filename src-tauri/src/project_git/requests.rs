//! Local Git side of forge pull/merge requests: their commits, changes and checkout branch.
use super::{
    execute, mutations, oid_output, remotes, validate_oid, validate_ref_name, GitError, GitFile,
    GitOperation,
};
use crate::agent_sessions::{AgentProject, AgentSessions};
use serde::Serialize;

static FETCHING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A request as the listed remote exposes it.
pub(crate) struct RequestSource<'a> {
    pub remote: &'a str,
    /// Ref the forge keeps on the target repository, e.g. `refs/pull/12/head`.
    pub head_ref: &'a str,
    /// Same-repository source branch, fetched when the forge has deleted `head_ref`.
    pub fallback_ref: Option<&'a str>,
    pub head_oid: &'a str,
    pub base_oid: &'a str,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRangeChanges {
    pub base: String,
    pub head: String,
    pub files: Vec<GitFile>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutBranch {
    pub name: String,
    pub remote: bool,
    pub oid: String,
}

/// Changes of a request against its merge base; fetches its missing commits without updating any ref.
pub(crate) fn request_changes(
    sessions: &AgentSessions,
    project_id: &str,
    source: &RequestSource,
) -> Result<GitRangeChanges, GitError> {
    validate_oid(source.head_oid)?;
    validate_oid(source.base_oid)?;
    validate_ref_name(source.head_ref)?;
    if let Some(fallback_ref) = source.fallback_ref {
        validate_ref_name(fallback_ref)?;
    }
    let project = sessions
        .project(project_id)
        .map_err(|message| GitError::new("project", message))?;
    super::version(&project)?;
    // shortcut: a shallow clone keeps its shallow roots, so merge-base can find nothing; deepen the history if shallow clones are reported.
    let missing_refspecs = || -> Result<Vec<&str>, GitError> {
        let mut missing = Vec::new();
        for (oid, refspec) in [
            (source.head_oid, source.head_ref),
            (source.base_oid, source.base_oid),
        ] {
            if !has_commit(&project, oid)? {
                missing.push(refspec);
            }
        }
        Ok(missing)
    };
    let mut missing = missing_refspecs()?;
    // Requests opened back to back would otherwise get `busy` from the lease held by the previous fetch.
    let mut fetching = (!missing.is_empty()).then(|| {
        FETCHING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    });
    if fetching.is_some() {
        missing = missing_refspecs()?;
        if missing.is_empty() {
            // Another request fetched the commits meanwhile; don't hold the global lock during the diff.
            fetching = None;
        }
    }
    if !missing.is_empty() {
        let lease = sessions
            .begin_git_operation(project_id)
            .map_err(|message| GitError::new("busy", message))?;
        // GitLab deletes `refs/merge-requests/<n>/head` 14 days after merge/close; the branch may remain,
        // and the forge keeps the head commit fetchable by OID.
        let mut head = source.head_ref;
        let mut fetched = remotes::fetch_refspecs(&lease.project, source.remote, &missing);
        for replacement in source.fallback_ref.into_iter().chain([source.head_oid]) {
            if !missing.contains(&head) {
                break;
            }
            // A surviving branch may have been rewritten without the head, so a successful fetch can still miss it.
            let advance = match &fetched {
                Err(error) => {
                    error.code == "failed" && error.message.contains("couldn't find remote ref")
                }
                Ok(_) => !has_commit(&lease.project, source.head_oid)?,
            };
            if !advance {
                break;
            }
            for refspec in &mut missing {
                if *refspec == head {
                    *refspec = replacement;
                }
            }
            head = replacement;
            fetched = remotes::fetch_refspecs(&lease.project, source.remote, &missing);
        }
        fetched?;
        drop(lease);
        drop(fetching);
        for oid in [source.head_oid, source.base_oid] {
            if !has_commit(&project, oid)? {
                return Err(GitError::new(
                    "stale",
                    "La demande a changé sur la forge. Actualisez-la avant de réessayer.",
                ));
            }
        }
    }
    let base = super::facade::display_read(&project, || {
        oid_output(
            &execute(
                &project,
                &["merge-base", source.base_oid, source.head_oid],
                GitOperation::Read,
                None,
            )?
            .stdout,
            "Base de fusion",
        )
    })?;
    let files = super::facade::range_files(&project, &base, source.head_oid)?;
    Ok(GitRangeChanges {
        base,
        head: source.head_oid.into(),
        files,
    })
}

/// Fetches `head_ref` into `refs/remotes/<remote>/<local>`; returns the existing local branch `local`
/// when there is one, the remote-tracking branch otherwise.
// shortcut: a `--single-branch` clone's fetch refspec does not cover that ref, so `--track` refuses it; add the refspec if such clones are reported.
pub(crate) fn request_checkout(
    sessions: &AgentSessions,
    project_id: &str,
    version: &str,
    remote: &str,
    head_ref: &str,
    local: &str,
) -> Result<GitCheckoutBranch, GitError> {
    validate_ref_name(head_ref)?;
    validate_ref_name(local)?;
    mutations::with_mutation(sessions, project_id, version, |project, _| {
        let tracking = format!("refs/remotes/{remote}/{local}");
        remotes::fetch_refspecs(project, remote, &[&format!("+{head_ref}:{tracking}")])?;
        if let Some(oid) = commit_of(project, &format!("refs/heads/{local}"))? {
            return Ok(GitCheckoutBranch {
                name: local.into(),
                remote: false,
                oid,
            });
        }
        let oid = commit_of(project, &tracking)?.ok_or_else(|| {
            GitError::new("missingBranch", "La branche de la demande est introuvable.")
        })?;
        Ok(GitCheckoutBranch {
            name: format!("{remote}/{local}"),
            remote: true,
            oid,
        })
    })
}

// Commit OIDs are immutable, so the warm display relay may answer these probes, even around a fetch.
fn has_commit(project: &AgentProject, oid: &str) -> Result<bool, GitError> {
    super::facade::display_read(project, || commit_of(project, oid)).map(|commit| commit.is_some())
}

fn commit_of(project: &AgentProject, revision: &str) -> Result<Option<String>, GitError> {
    match execute(
        project,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{revision}^{{commit}}"),
        ],
        GitOperation::Read,
        None,
    ) {
        Ok(output) => oid_output(&output.stdout, "Commit").map(Some),
        Err(error) if error.code == "failed" => Ok(None),
        Err(error) => Err(error),
    }
}
