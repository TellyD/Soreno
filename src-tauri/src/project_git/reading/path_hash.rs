use super::super::{check_read_deadline, execute, validate_oid, GitError, GitOperation};
use super::HASH_PATHS_INPUT_LIMIT;
use crate::agent_sessions::AgentProject;

pub(super) fn hash_regular_paths(
    project: &AgentProject,
    paths: &[&[u8]],
) -> Result<Vec<String>, GitError> {
    let mut input = Vec::new();
    let mut count = 0;
    let mut oids = Vec::with_capacity(paths.len());
    for path in paths {
        check_read_deadline()?;
        let encoded = git_quoted_path(path);
        if encoded.len() > HASH_PATHS_INPUT_LIMIT {
            return Err(GitError::new(
                "invalidPath",
                "Un chemin Git dépasse la limite d’empreinte.",
            ));
        }
        if !input.is_empty() && input.len() + encoded.len() > HASH_PATHS_INPUT_LIMIT {
            oids.extend(hash_regular_chunk(project, &input, count)?);
            input.clear();
            count = 0;
        }
        input.extend_from_slice(&encoded);
        count += 1;
    }
    if count > 0 {
        oids.extend(hash_regular_chunk(project, &input, count)?);
    }
    Ok(oids)
}

pub(super) fn git_quoted_path(path: &[u8]) -> Vec<u8> {
    let mut quoted = Vec::with_capacity(path.len() + 3);
    quoted.push(b'"');
    for &byte in path {
        if byte == b'"' || byte == b'\\' || !(b' '..=b'~').contains(&byte) {
            quoted.extend_from_slice(&[
                b'\\',
                b'0' + (byte >> 6),
                b'0' + ((byte >> 3) & 7),
                b'0' + (byte & 7),
            ]);
        } else {
            quoted.push(byte);
        }
    }
    quoted.extend_from_slice(b"\"\n");
    quoted
}

fn hash_regular_chunk(
    project: &AgentProject,
    input: &[u8],
    expected: usize,
) -> Result<Vec<String>, GitError> {
    let output = execute(
        project,
        &["hash-object", "--no-filters", "--stdin-paths"],
        GitOperation::Read,
        Some(input),
    )?
    .stdout;
    let output = output
        .strip_suffix(b"\n")
        .ok_or_else(malformed_hash_paths)?;
    let records = output.split(|byte| *byte == b'\n').collect::<Vec<_>>();
    if records.len() != expected {
        return Err(malformed_hash_paths());
    }
    records
        .into_iter()
        .map(|record| {
            let oid = std::str::from_utf8(record)
                .map_err(|_| malformed_hash_paths())?
                .to_owned();
            validate_oid(&oid).map_err(|_| malformed_hash_paths())?;
            Ok(oid)
        })
        .collect()
}

fn malformed_hash_paths() -> GitError {
    GitError::new(
        "malformed",
        "Git a retourné des empreintes de fichiers invalides.",
    )
}
