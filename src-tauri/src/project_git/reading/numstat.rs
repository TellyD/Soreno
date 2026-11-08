use super::{
    read_numstat, AgentProject, Counts, CountsMemo, GitError, NumstatRead, StatusEntry,
    WorktreeFingerprint,
};
use std::collections::HashMap;

const NUMSTAT_PATHSPEC_LIMIT: usize = 16 * 1024;

pub(super) struct NumstatInput {
    path: Vec<u8>,
    old_path: Option<Vec<u8>>,
    /// `None`: no stable inputs (conflict, dirty submodule), so the line is always reread.
    key: Option<Vec<u8>>,
    /// A worktree rename pairs with a path outside the entry, so only a full diff is exact.
    paired: bool,
}

pub(super) fn numstat_plan(
    staged: bool,
    entries: &[StatusEntry],
    fingerprints: &[WorktreeFingerprint],
) -> Vec<NumstatInput> {
    entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            if staged {
                !matches!(entry.index_status, b'.' | b'?')
            } else {
                entry.index_status != b'?' && entry.worktree_status != b'.'
            }
        })
        .map(|(index, entry)| NumstatInput {
            path: entry.path.clone(),
            old_path: entry.old_path.clone(),
            key: numstat_key(staged, entry, fingerprints.get(index)),
            paired: !staged && matches!(entry.worktree_status, b'R' | b'C'),
        })
        .collect()
}

/// Every input of a numstat line: object ids and modes from status, plus worktree bytes when unstaged.
fn numstat_key(
    staged: bool,
    entry: &StatusEntry,
    fingerprint: Option<&WorktreeFingerprint>,
) -> Option<Vec<u8>> {
    let objects = entry.objects.as_ref()?;
    if !staged && (entry.submodule || matches!(entry.worktree_status, b'R' | b'C')) {
        return None;
    }
    let mut key = vec![if staged { b'S' } else { b'W' }, 0];
    for part in [Some(&entry.path), Some(objects), entry.old_path.as_ref()] {
        key.extend_from_slice(part.map_or(&[][..], Vec::as_slice));
        key.push(0);
    }
    if !staged {
        match (entry.worktree_status, fingerprint?) {
            (b'D', _) | (_, WorktreeFingerprint::Missing) => key.extend_from_slice(b"missing"),
            (
                _,
                WorktreeFingerprint::Present {
                    mode,
                    kind: kind @ ("sha256" | "gitOid"),
                    hash,
                },
            ) => key.extend_from_slice(format!("{mode}:{kind}:{hash}").as_bytes()),
            _ => return None,
        }
    }
    Some(key)
}

pub(super) fn memo_numstat(
    project: &AgentProject,
    plan: &[NumstatInput],
    staged: bool,
    previous: &CountsMemo,
    next: &mut CountsMemo,
) -> Result<(HashMap<Vec<u8>, Counts>, NumstatRead), GitError> {
    let mut counts = HashMap::new();
    let mut misses = Vec::new();
    for input in plan {
        match input
            .key
            .as_ref()
            .and_then(|key| Some((key, previous.get(key)?)))
        {
            Some((key, known)) => {
                if let Some(known) = known {
                    counts.insert(input.path.clone(), known);
                }
                next.remember(key.clone(), known);
            }
            None => misses.push(input),
        }
    }
    if misses.is_empty() {
        return Ok((counts, NumstatRead::Cached));
    }
    let pathspecs = plan
        .iter()
        .all(|input| !input.paired)
        .then(|| literal_pathspecs(&misses))
        .flatten();
    let fresh = read_numstat(project, staged, pathspecs.as_deref().unwrap_or_default())?;
    for input in &misses {
        if let Some(key) = &input.key {
            next.remember(key.clone(), fresh.get(&input.path).copied());
        }
    }
    Ok(match pathspecs {
        Some(_) => {
            counts.extend(fresh);
            (counts, NumstatRead::Partial(misses.len()))
        }
        None => (fresh, NumstatRead::Full),
    })
}

/// Literal pathspecs for the given entries, or `None` when one full diff is the cheaper read.
fn literal_pathspecs(inputs: &[&NumstatInput]) -> Option<Vec<String>> {
    let mut pathspecs = Vec::new();
    let mut bytes = 0;
    for path in inputs
        .iter()
        .flat_map(|input| std::iter::once(&input.path).chain(&input.old_path))
    {
        let pathspec = format!(":(literal){}", std::str::from_utf8(path).ok()?);
        bytes += pathspec.len();
        if bytes > NUMSTAT_PATHSPEC_LIMIT {
            return None;
        }
        pathspecs.push(pathspec);
    }
    Some(pathspecs)
}
