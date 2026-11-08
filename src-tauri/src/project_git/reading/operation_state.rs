use super::super::{GitError, GitIdentity};
use super::{file_error, filesystem_root, remote_read, FILE_LIMIT};
use crate::agent_sessions::AgentProject;
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

pub(super) fn operation_state(
    project: &AgentProject,
    identity: &GitIdentity,
) -> Result<(Option<String>, Option<String>), GitError> {
    if project.environment.kind == "ssh" {
        return remote_operation_state(project, identity);
    }
    let git_dir = filesystem_root(project, &identity.git_dir)?;
    let common_dir = filesystem_root(project, &identity.common_dir)?;
    let operation = if path_exists(&git_dir.join("MERGE_HEAD"))? {
        Some("merge")
    } else if path_exists(&git_dir.join("rebase-merge"))?
        || path_exists(&git_dir.join("rebase-apply"))?
    {
        Some("rebase")
    } else if path_exists(&git_dir.join("CHERRY_PICK_HEAD"))? {
        Some("cherry-pick")
    } else if path_exists(&git_dir.join("REVERT_HEAD"))? {
        Some("revert")
    } else if path_exists(&git_dir.join("BISECT_LOG"))?
        || path_exists(&common_dir.join("BISECT_LOG"))?
    {
        Some("bisect")
    } else {
        None
    };
    let merge_message = if operation.as_deref() == Some("merge") {
        read_small_text(&git_dir.join("MERGE_MSG"))?
    } else {
        None
    };
    Ok((operation.map(str::to_owned), merge_message))
}

fn remote_operation_state(
    project: &AgentProject,
    identity: &GitIdentity,
) -> Result<(Option<String>, Option<String>), GitError> {
    for path in [&identity.git_dir, &identity.common_dir] {
        crate::ssh::validate_path(path).map_err(|message| GitError::new("invalidPath", message))?;
    }
    let script = format!(
        "git={}; common={}; operation=; \
         if [ -e \"$git/MERGE_HEAD\" ] || [ -L \"$git/MERGE_HEAD\" ]; then operation=merge; \
         elif [ -e \"$git/rebase-merge\" ] || [ -L \"$git/rebase-merge\" ] || [ -e \"$git/rebase-apply\" ] || [ -L \"$git/rebase-apply\" ]; then operation=rebase; \
         elif [ -e \"$git/CHERRY_PICK_HEAD\" ] || [ -L \"$git/CHERRY_PICK_HEAD\" ]; then operation=cherry-pick; \
         elif [ -e \"$git/REVERT_HEAD\" ] || [ -L \"$git/REVERT_HEAD\" ]; then operation=revert; \
         elif [ -e \"$git/BISECT_LOG\" ] || [ -L \"$git/BISECT_LOG\" ] || [ -e \"$common/BISECT_LOG\" ] || [ -L \"$common/BISECT_LOG\" ]; then operation=bisect; fi; \
         printf '%s\\0' \"$operation\"; if [ \"$operation\" = merge ]; then \
         if [ -L \"$git/MERGE_MSG\" ]; then exit 1; elif [ -f \"$git/MERGE_MSG\" ]; then printf '1\\0'; dd if=\"$git/MERGE_MSG\" bs={} count=1 2>/dev/null; else printf '0\\0'; fi; else printf '0\\0'; fi",
        crate::ssh::quote(&identity.git_dir),
        crate::ssh::quote(&identity.common_dir),
        FILE_LIMIT,
    );
    let output = remote_read(project, &script, None)?;
    let mut fields = output.splitn(3, |byte| *byte == 0);
    let operation = match fields.next().unwrap_or_default() {
        b"" => None,
        b"merge" => Some("merge".into()),
        b"rebase" => Some("rebase".into()),
        b"cherry-pick" => Some("cherry-pick".into()),
        b"revert" => Some("revert".into()),
        b"bisect" => Some("bisect".into()),
        _ => return Err(GitError::new("malformed", "État Git SSH invalide.")),
    };
    let merge_message = match fields.next().unwrap_or_default() {
        b"0" => None,
        b"1" if operation.as_deref() == Some("merge") => {
            Some(String::from_utf8_lossy(fields.next().unwrap_or_default()).into_owned())
        }
        _ => return Err(GitError::new("malformed", "Message Git SSH invalide.")),
    };
    Ok((operation, merge_message))
}

fn path_exists(path: &Path) -> Result<bool, GitError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(file_error(&path.to_string_lossy(), error)),
    }
}

fn read_small_text(path: &Path) -> Result<Option<String>, GitError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(file_error(&path.to_string_lossy(), error)),
    };
    let mut bytes = Vec::new();
    (&mut file)
        .take(FILE_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|error| file_error(&path.to_string_lossy(), error))?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}
