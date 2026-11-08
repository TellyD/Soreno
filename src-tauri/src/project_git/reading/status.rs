use super::{BranchState, Counts, StatusEntry};
use crate::{
    agent_sessions::AgentProject,
    project_git::{execute, GitError, GitOperation},
};
use std::collections::HashMap;

pub(super) fn parse_status(bytes: &[u8]) -> Result<(BranchState, Vec<StatusEntry>), GitError> {
    let mut branch = BranchState::default();
    let mut entries = Vec::new();
    let records = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        if record.starts_with(b"# ") {
            parse_branch(record, &mut branch)?;
            continue;
        }
        let kind = record[0];
        let fields = record.split(|byte| *byte == b' ').collect::<Vec<_>>();
        let (xy, submodule, mode, path, old_path, conflict, objects) = match kind {
            b'1' if fields.len() >= 9 => (
                fields[1],
                fields[2],
                choose_mode(fields[1], fields[3], fields[4], fields[5]),
                join_fields(&fields[8..]),
                None,
                false,
                Some(join_fields(&fields[3..8])),
            ),
            b'2' if fields.len() >= 10 => {
                let old = records.get(index).ok_or_else(malformed_status)?;
                index += 1;
                (
                    fields[1],
                    fields[2],
                    choose_mode(fields[1], fields[3], fields[4], fields[5]),
                    join_fields(&fields[9..]),
                    Some((*old).to_vec()),
                    false,
                    Some(join_fields(&fields[3..8])),
                )
            }
            b'u' if fields.len() >= 11 => (
                fields[1],
                fields[2],
                choose_mode(fields[1], fields[3], fields[4], fields[6]),
                join_fields(&fields[10..]),
                None,
                true,
                None,
            ),
            b'?' if record.starts_with(b"? ") => (
                b"??".as_slice(),
                b"N...".as_slice(),
                "100644".into(),
                record[2..].to_vec(),
                None,
                false,
                None,
            ),
            _ => return Err(malformed_status()),
        };
        if xy.len() != 2 || path.is_empty() {
            return Err(malformed_status());
        }
        let representable = std::str::from_utf8(&path).is_ok()
            && old_path
                .as_ref()
                .is_none_or(|value| std::str::from_utf8(value).is_ok());
        let submodule = submodule.first() == Some(&b'S') || mode == "160000";
        entries.push(StatusEntry {
            path,
            old_path,
            index_status: xy[0],
            worktree_status: xy[1],
            conflict,
            submodule,
            mode,
            representable,
            objects,
        });
    }
    branch.tracking_known = branch.tracking_known && branch.upstream.is_some();
    Ok((branch, entries))
}

fn join_fields(fields: &[&[u8]]) -> Vec<u8> {
    let mut value = Vec::new();
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            value.push(b' ');
        }
        value.extend_from_slice(field);
    }
    value
}

fn malformed_status() -> GitError {
    GitError::new(
        "malformed",
        "Git a retourné un statut porcelain v2 invalide.",
    )
}

fn parse_branch(record: &[u8], branch: &mut BranchState) -> Result<(), GitError> {
    let text = std::str::from_utf8(record).map_err(|_| malformed_status())?;
    if let Some(value) = text.strip_prefix("# branch.oid ") {
        branch.head = (value != "(initial)").then(|| value.into());
    } else if let Some(value) = text.strip_prefix("# branch.head ") {
        branch.branch = (value != "(detached)").then(|| value.into());
    } else if let Some(value) = text.strip_prefix("# branch.upstream ") {
        branch.upstream = Some(value.into());
    } else if let Some(value) = text.strip_prefix("# branch.ab +") {
        let (ahead, behind) = value.split_once(" -").ok_or_else(malformed_status)?;
        branch.ahead = ahead.parse().map_err(|_| malformed_status())?;
        branch.behind = behind.parse().map_err(|_| malformed_status())?;
        branch.tracking_known = true;
    }
    Ok(())
}

fn choose_mode(xy: &[u8], head: &[u8], index: &[u8], worktree: &[u8]) -> String {
    let selected = if xy.get(1).is_some_and(|status| *status != b'.') && worktree != b"000000" {
        worktree
    } else if index != b"000000" {
        index
    } else {
        head
    };
    String::from_utf8_lossy(selected).into_owned()
}

pub(super) fn display_path(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(value) => (value.into(), true),
        Err(_) => {
            let mut escaped = String::new();
            let mut rest = bytes;
            while !rest.is_empty() {
                match std::str::from_utf8(rest) {
                    Ok(value) => {
                        escaped.push_str(value);
                        break;
                    }
                    Err(error) => {
                        let valid = error.valid_up_to();
                        escaped.push_str(&String::from_utf8_lossy(&rest[..valid]));
                        let invalid = error.error_len().unwrap_or(rest.len() - valid);
                        for byte in &rest[valid..valid + invalid] {
                            escaped.push_str(&format!("\\x{byte:02X}"));
                        }
                        rest = &rest[valid + invalid..];
                    }
                }
            }
            (escaped, false)
        }
    }
}

pub(super) fn read_numstat(
    project: &AgentProject,
    staged: bool,
    pathspecs: &[String],
) -> Result<HashMap<Vec<u8>, Counts>, GitError> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--numstat", "-z", "--"]);
    args.extend(pathspecs.iter().map(String::as_str));
    parse_numstat(&execute(project, &args, GitOperation::Read, None)?.stdout)
}

pub(super) fn parse_numstat(bytes: &[u8]) -> Result<HashMap<Vec<u8>, Counts>, GitError> {
    let records = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut result = HashMap::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let added = parse_count(fields.next().ok_or_else(malformed_numstat)?)?;
        let deleted = parse_count(fields.next().ok_or_else(malformed_numstat)?)?;
        let mut path = fields.next().ok_or_else(malformed_numstat)?.to_vec();
        if path.is_empty() {
            let _old_path = records.get(index).ok_or_else(malformed_numstat)?;
            path = records
                .get(index + 1)
                .ok_or_else(malformed_numstat)?
                .to_vec();
            index += 2;
        }
        result.insert(path, Counts { added, deleted });
    }
    Ok(result)
}

fn malformed_numstat() -> GitError {
    GitError::new(
        "malformed",
        "Git a retourné des compteurs numstat invalides.",
    )
}

fn parse_count(value: &[u8]) -> Result<Option<u64>, GitError> {
    if value == b"-" {
        Ok(None)
    } else {
        std::str::from_utf8(value)
            .ok()
            .and_then(|value| value.parse().ok())
            .map(Some)
            .ok_or_else(malformed_numstat)
    }
}

pub(super) fn merge_counts(
    target: &mut HashMap<Vec<u8>, Counts>,
    source: HashMap<Vec<u8>, Counts>,
) {
    for (path, counts) in source {
        target
            .entry(path)
            .and_modify(|current| {
                current.added = current
                    .added
                    .zip(counts.added)
                    .map(|(left, right)| left + right);
                current.deleted = current
                    .deleted
                    .zip(counts.deleted)
                    .map(|(left, right)| left + right);
            })
            .or_insert(counts);
    }
}
