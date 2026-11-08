use super::super::{
    check_read_deadline,
    command_builder::posix_git_environment,
    execute,
    object_hash::{blob_oid, snapshot_version, ObjectFormat},
    oid_output, validate_oid, validate_relative_path, GitContent, GitError, GitIdentity,
    GitOperation,
};
use super::{
    content_format::{content_from_bytes, empty_content, unreadable_content},
    display_path,
    memo::{FileStamp, SETTLE_NANOS},
    posix_read, requires_posix_file_reads, GitContentCache, GitContentCacheKey, SnapshotCacheKey,
    WorktreeFingerprint, FILE_LIMIT,
};
use crate::agent_sessions::{project_filesystem_directory, AgentProject};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) fn hash_worktree_path(project: &AgentProject, path: &[u8]) -> Result<String, GitError> {
    let path = std::str::from_utf8(path).map_err(|_| {
        GitError::new(
            "unsupportedPath",
            "Un fichier volumineux au nom non Unicode ne peut pas être condensé.",
        )
    })?;
    let output = execute(
        project,
        &["hash-object", "--no-filters", "--", path],
        GitOperation::Read,
        None,
    )?;
    oid_output(&output.stdout, "Git a retourné un OID")
}

fn tree_object(
    project: &AgentProject,
    revision: &str,
    path: &[u8],
) -> Result<Option<(String, String)>, GitError> {
    validate_oid(revision)?;
    let path = std::str::from_utf8(path)
        .map_err(|_| GitError::new("invalidPath", "Chemin Git non Unicode."))?;
    validate_relative_path(path)?;
    let pathspec = literal_pathspec(path);
    let output = execute(
        project,
        &["ls-tree", "-z", revision, "--", &pathspec],
        GitOperation::Read,
        None,
    )?;
    parse_tree_entry(&output.stdout, path.as_bytes())
}

pub(super) fn staged_contents(
    project: &AgentProject,
    project_key: &SnapshotCacheKey,
    head: Option<&str>,
    before_path: &[u8],
    index: &[u8],
    after_path: &[u8],
    cache: &GitContentCache,
) -> Result<(GitContent, GitContent), GitError> {
    let before = head
        .map(|head| tree_object(project, head, before_path))
        .transpose()?
        .flatten();
    let after = parse_index_entry(index, after_path, 0)?;
    let [before, after] = object_content_pair(project, project_key, [&before, &after], cache)?;
    Ok((before, after))
}

pub(super) fn index_content(
    project: &AgentProject,
    project_key: &SnapshotCacheKey,
    index: &[u8],
    path: &[u8],
    stage: u8,
    cached: bool,
    cache: &GitContentCache,
) -> Result<GitContent, GitError> {
    match parse_index_entry(index, path, stage)? {
        Some((mode, oid)) => object_content(project, project_key, mode, oid, cached, cache),
        None => Ok(empty_content()),
    }
}

pub(super) fn remote_unstaged_contents(
    project: &AgentProject,
    project_key: &SnapshotCacheKey,
    index: &[u8],
    before_path: &[u8],
    identity: &GitIdentity,
    path: &str,
    expected: &WorktreeFingerprint,
    cache: &GitContentCache,
) -> Result<Option<(GitContent, GitContent)>, GitError> {
    let object = parse_index_entry(index, before_path, 0)?;
    let (before, file) = match object {
        None => (empty_content(), remote_file(project, &identity.root, path)?),
        Some((mode, oid)) => {
            validate_oid(&oid)?;
            validate_object_mode(&mode)?;
            let key = GitContentCacheKey {
                project: project_key.clone(),
                oid: oid.clone(),
                mode: mode.clone(),
            };
            if let Some(content) = cache.get(&key) {
                (content, remote_file(project, &identity.root, path)?)
            } else if mode == "160000" {
                (
                    unreadable_content(Some(oid), 0, mode, "submodule"),
                    remote_file(project, &identity.root, path)?,
                )
            } else {
                let (content, file) =
                    remote_object_and_file(project, &identity.root, path, mode, oid)?;
                cache.store(key, content.clone());
                (content, file)
            }
        }
    };
    let Some(after) = remote_file_content_checked(identity, file, Some(expected))? else {
        return Ok(None);
    };
    Ok(Some((before, after)))
}

fn literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

fn matching_entries<'a>(
    bytes: &'a [u8],
    expected_path: &'a [u8],
    invalid: &'static str,
) -> impl Iterator<Item = Result<[&'a [u8]; 3], GitError>> + 'a {
    bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(move |record| {
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
                return Some(Err(GitError::new("malformed", invalid)));
            };
            (&record[tab + 1..] == expected_path).then(|| {
                <[&[u8]; 3]>::try_from(
                    record[..tab]
                        .split(|byte| *byte == b' ')
                        .collect::<Vec<_>>(),
                )
                .map_err(|_| GitError::new("malformed", invalid))
            })
        })
}

fn parse_tree_entry(
    bytes: &[u8],
    expected_path: &[u8],
) -> Result<Option<(String, String)>, GitError> {
    match matching_entries(bytes, expected_path, "Entrée ls-tree invalide.").next() {
        Some(fields) => {
            let [mode, _, oid] = fields?;
            Ok(Some((ascii(mode)?, ascii(oid)?)))
        }
        None => Ok(None),
    }
}

fn parse_index_entry(
    bytes: &[u8],
    expected_path: &[u8],
    expected_stage: u8,
) -> Result<Option<(String, String)>, GitError> {
    for fields in matching_entries(bytes, expected_path, "Entrée ls-files invalide.") {
        let [mode, oid, stage] = fields?;
        if stage == expected_stage.to_string().as_bytes() {
            return Ok(Some((ascii(mode)?, ascii(oid)?)));
        }
    }
    Ok(None)
}

pub(super) fn ascii(value: &[u8]) -> Result<String, GitError> {
    std::str::from_utf8(value)
        .map(str::to_owned)
        .map_err(|_| GitError::new("malformed", "Métadonnée Git non ASCII."))
}

pub(super) fn object_content_pair(
    project: &AgentProject,
    project_key: &SnapshotCacheKey,
    objects: [&Option<(String, String)>; 2],
    cache: &GitContentCache,
) -> Result<[GitContent; 2], GitError> {
    let mut contents: [Option<GitContent>; 2] = [None, None];
    let mut keys: [Option<GitContentCacheKey>; 2] = [None, None];
    let mut blobs = Vec::new();
    for (index, object) in objects.into_iter().enumerate() {
        let Some((mode, oid)) = object else {
            contents[index] = Some(empty_content());
            continue;
        };
        check_read_deadline()?;
        validate_oid(oid)?;
        validate_object_mode(mode)?;
        let key = GitContentCacheKey {
            project: project_key.clone(),
            oid: oid.clone(),
            mode: mode.clone(),
        };
        if let Some(content) = cache.get(&key) {
            contents[index] = Some(content);
            continue;
        }
        keys[index] = Some(key);
        if mode == "160000" {
            contents[index] = Some(unreadable_content(
                Some(oid.clone()),
                0,
                mode.clone(),
                "submodule",
            ));
        } else {
            blobs.push(index);
        }
    }

    if project.environment.kind == "ssh" && !blobs.is_empty() {
        let requested = blobs
            .iter()
            .map(|index| objects[*index].as_ref().expect("objet Git présent").clone())
            .collect::<Vec<_>>();
        for (index, content) in blobs
            .into_iter()
            .zip(remote_object_contents(project, &requested)?)
        {
            contents[index] = Some(content);
        }
    } else if blobs.len() != 2 {
        for index in blobs {
            let (mode, oid) = objects[index].as_ref().expect("objet Git présent");
            contents[index] = Some(object_content(
                project,
                project_key,
                mode.clone(),
                oid.clone(),
                true,
                cache,
            )?);
            keys[index] = None;
        }
    } else {
        let input = format!(
            "{}\n{}\n",
            objects[blobs[0]].as_ref().unwrap().1,
            objects[blobs[1]].as_ref().unwrap().1
        );
        let checked = execute(
            project,
            &["cat-file", "--batch-check"],
            GitOperation::Read,
            Some(input.as_bytes()),
        )?;
        let expected = blobs
            .iter()
            .map(|index| objects[*index].as_ref().unwrap().1.as_str())
            .collect::<Vec<_>>();
        let sizes = parse_batch_check(&checked.stdout, &expected)?;
        let readable = blobs
            .iter()
            .zip(&sizes)
            .filter(|(_, size)| **size <= FILE_LIMIT)
            .map(|(index, size)| (*index, *size))
            .collect::<Vec<_>>();
        let bodies = if readable.is_empty() {
            Vec::new()
        } else {
            let input = readable
                .iter()
                .map(|(index, _)| objects[*index].as_ref().unwrap().1.as_str())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            let output = execute(
                project,
                &["cat-file", "--batch"],
                GitOperation::Read,
                Some(input.as_bytes()),
            )?;
            let expected = readable
                .iter()
                .map(|(index, size)| (objects[*index].as_ref().unwrap().1.as_str(), *size))
                .collect::<Vec<_>>();
            parse_batch_output(output.stdout, &expected)?
        };
        let mut body = bodies.into_iter();
        for (position, index) in blobs.into_iter().enumerate() {
            let (mode, oid) = objects[index].as_ref().unwrap();
            contents[index] = Some(if sizes[position] > FILE_LIMIT {
                unreadable_content(Some(oid.clone()), sizes[position], mode.clone(), "tooLarge")
            } else {
                object_content_from_bytes(
                    body.next().unwrap(),
                    oid.clone(),
                    sizes[position],
                    mode.clone(),
                )?
            });
        }
    }

    let contents = contents.map(|content| content.expect("contenu Git préparé"));
    for (key, content) in keys.into_iter().zip(&contents) {
        if let Some(key) = key {
            cache.store(key, content.clone());
        }
    }
    Ok(contents)
}

pub(super) fn parse_batch_check(bytes: &[u8], expected: &[&str]) -> Result<Vec<u64>, GitError> {
    let mut bytes = bytes;
    let mut sizes = Vec::with_capacity(expected.len());
    for oid in expected {
        let end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(malformed_batch)?;
        let fields = bytes[..end].split(|byte| *byte == b' ').collect::<Vec<_>>();
        if fields.len() != 3 || fields[0] != oid.as_bytes() || fields[1] != b"blob" {
            return Err(malformed_batch());
        }
        sizes.push(
            std::str::from_utf8(fields[2])
                .ok()
                .and_then(|size| size.parse::<u64>().ok())
                .ok_or_else(malformed_batch)?,
        );
        bytes = &bytes[end + 1..];
    }
    if !bytes.is_empty() {
        return Err(malformed_batch());
    }
    Ok(sizes)
}

pub(super) fn parse_batch_output(
    mut bytes: Vec<u8>,
    expected: &[(&str, u64)],
) -> Result<Vec<Vec<u8>>, GitError> {
    let mut bodies = Vec::with_capacity(expected.len());
    for (oid, expected_size) in expected {
        let end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(malformed_batch)?;
        let fields = bytes[..end].split(|byte| *byte == b' ').collect::<Vec<_>>();
        let size = fields
            .get(2)
            .and_then(|size| std::str::from_utf8(size).ok())
            .and_then(|size| size.parse::<u64>().ok());
        if fields.len() != 3
            || fields[0] != oid.as_bytes()
            || fields[1] != b"blob"
            || size != Some(*expected_size)
        {
            return Err(malformed_batch());
        }
        let size = usize::try_from(*expected_size).map_err(|_| malformed_batch())?;
        let start = end + 1;
        let separator = start.checked_add(size).ok_or_else(malformed_batch)?;
        if bytes.get(separator) != Some(&b'\n') {
            return Err(malformed_batch());
        }
        bodies.push(bytes[start..separator].to_vec());
        bytes.drain(..=separator);
    }
    if !bytes.is_empty() {
        return Err(malformed_batch());
    }
    Ok(bodies)
}

fn malformed_batch() -> GitError {
    GitError::new("malformed", "Réponse cat-file groupée invalide.")
}

pub(super) fn object_content(
    project: &AgentProject,
    project_key: &SnapshotCacheKey,
    mode: String,
    oid: String,
    cached: bool,
    cache: &GitContentCache,
) -> Result<GitContent, GitError> {
    check_read_deadline()?;
    validate_oid(&oid)?;
    validate_object_mode(&mode)?;
    let key = GitContentCacheKey {
        project: project_key.clone(),
        oid: oid.clone(),
        mode: mode.clone(),
    };
    if cached {
        if let Some(content) = cache.get(&key) {
            return Ok(content);
        }
    }
    let content = if mode == "160000" {
        unreadable_content(Some(oid), 0, mode, "submodule")
    } else {
        let size_output = execute(project, &["cat-file", "-s", &oid], GitOperation::Read, None)?;
        let size = std::str::from_utf8(&size_output.stdout)
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .ok_or_else(|| GitError::new("malformed", "Taille d’objet Git invalide."))?;
        if size > FILE_LIMIT {
            unreadable_content(Some(oid), size, mode, "tooLarge")
        } else {
            let bytes = execute(
                project,
                &["cat-file", "blob", &oid],
                GitOperation::Read,
                None,
            )?
            .stdout;
            object_content_from_bytes(bytes, oid, size, mode)?
        }
    };
    if cached {
        cache.store(key, content.clone());
    }
    Ok(content)
}

fn object_content_from_bytes(
    bytes: Vec<u8>,
    oid: String,
    size: u64,
    mode: String,
) -> Result<GitContent, GitError> {
    if mode == "120000" {
        let mut content = unreadable_content(Some(oid), size, mode, "symlink");
        content.text = Some(String::from_utf8_lossy(&bytes).into_owned());
        Ok(content)
    } else {
        content_from_bytes(bytes, Some(oid), mode)
    }
}

pub(super) fn validate_object_mode(mode: &str) -> Result<(), GitError> {
    if mode.len() == 6 && mode.bytes().all(|byte| matches!(byte, b'0'..=b'7')) {
        Ok(())
    } else {
        Err(GitError::new("malformed", "Mode d’objet Git invalide."))
    }
}

pub(super) fn disk_content_checked(
    project: &AgentProject,
    identity: &GitIdentity,
    path: &str,
    expected: Option<&WorktreeFingerprint>,
) -> Result<Option<GitContent>, GitError> {
    if requires_posix_file_reads(project) {
        return remote_disk_content_checked(project, identity, path, expected);
    }
    let Some(DiskEntry {
        mode,
        size,
        path: filesystem_path,
        ..
    }) = disk_metadata(project, identity, path.as_bytes())?
    else {
        return Ok(expected.is_none().then(empty_content));
    };
    if mode == "120000" {
        let bytes = read_link_bytes(&filesystem_path)?;
        if !fingerprint_matches(expected, &mode, &bytes, identity.object_format) {
            return Ok(None);
        }
        let oid = blob_oid(identity.object_format, &bytes);
        let mut content = unreadable_content(Some(oid), bytes.len() as u64, mode, "symlink");
        content.text = Some(String::from_utf8_lossy(&bytes).into_owned());
        return Ok(Some(content));
    }
    match read_file_bounded(&filesystem_path, path)? {
        BoundedRead::Complete(bytes) => {
            if !fingerprint_matches(expected, &mode, &bytes, identity.object_format) {
                return Ok(None);
            }
            let oid = blob_oid(identity.object_format, &bytes);
            content_from_bytes(bytes, Some(oid), mode).map(Some)
        }
        BoundedRead::TooLarge if expected.is_some() => Ok(None),
        BoundedRead::TooLarge => Ok(Some(unreadable_content(
            Some(hash_worktree_path(project, path.as_bytes())?),
            size.max(FILE_LIMIT + 1),
            mode,
            "tooLarge",
        ))),
    }
}

pub(super) fn fingerprint_matches(
    expected: Option<&WorktreeFingerprint>,
    mode: &str,
    bytes: &[u8],
    object_format: ObjectFormat,
) -> bool {
    expected.is_none_or(|expected| match expected {
        WorktreeFingerprint::Present {
            mode: expected_mode,
            kind,
            hash,
        } if expected_mode == mode => match *kind {
            "sha256" => *hash == snapshot_version(bytes),
            "gitOid" => *hash == blob_oid(object_format, bytes),
            _ => false,
        },
        _ => false,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RemoteFile {
    Missing,
    Symlink(Vec<u8>),
    Regular {
        mode: String,
        size: u64,
        bytes: Vec<u8>,
    },
}

pub(super) fn parse_remote_file(bytes: Vec<u8>) -> Result<RemoteFile, GitError> {
    let malformed = || GitError::new("malformed", "Contenu de fichier SSH invalide.");
    if bytes == b"M\0" {
        return Ok(RemoteFile::Missing);
    }
    if let Some(target) = bytes.strip_prefix(b"L\0") {
        let target = target.strip_suffix(b"\n").ok_or_else(malformed)?;
        return Ok(RemoteFile::Symlink(target.to_vec()));
    }
    if matches!(bytes.as_slice(), b"U\0" | b"E\0") {
        return Err(GitError::new(
            if bytes[0] == b'U' {
                "invalidPath"
            } else {
                "inaccessible"
            },
            if bytes[0] == b'U' {
                "Un parent symbolique sort de la racine Git distante."
            } else {
                "Un chemin Git distant n’est pas un fichier lisible."
            },
        ));
    }
    let Some(rest) = bytes.strip_prefix(b"F\0") else {
        return Err(malformed());
    };
    let mut fields = rest.splitn(3, |byte| *byte == 0);
    let mode =
        std::str::from_utf8(fields.next().ok_or_else(malformed)?).map_err(|_| malformed())?;
    if !matches!(mode, "100644" | "100755") {
        return Err(malformed());
    }
    let size = std::str::from_utf8(fields.next().ok_or_else(malformed)?)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(malformed)?;
    let body = fields.next().ok_or_else(malformed)?.to_vec();
    Ok(RemoteFile::Regular {
        mode: mode.into(),
        size,
        bytes: body,
    })
}

fn remote_file_script(root: &str, path: &str) -> Result<String, GitError> {
    crate::ssh::validate_path(root).map_err(|message| GitError::new("invalidPath", message))?;
    validate_relative_path(path)?;
    Ok(format!(
        "root={}; relative={}; canonical_root=$(cd -P -- \"$root\" 2>/dev/null && pwd -P && printf .) || exit 1; \
         canonical_root=${{canonical_root%.}}; canonical_root=${{canonical_root%?}}; \
         parent=${{relative%/*}}; [ \"$parent\" = \"$relative\" ] && parent=.; \
         if ! canonical_parent=$(cd -P -- \"$canonical_root/$parent\" 2>/dev/null && pwd -P && printf .); then \
         if [ ! -e \"$canonical_root/$parent\" ] && [ ! -L \"$canonical_root/$parent\" ]; then printf 'M\\0'; else printf 'E\\0'; fi; exit; fi; \
         canonical_parent=${{canonical_parent%.}}; canonical_parent=${{canonical_parent%?}}; \
         if [ \"$canonical_root\" != / ]; then case \"$canonical_parent/\" in \"$canonical_root/\"*) ;; *) printf 'U\\0'; exit;; esac; fi; \
         target=\"$canonical_root/$relative\"; if [ -L \"$target\" ]; then printf 'L\\0'; readlink \"$target\" || exit 1; \
         elif [ -f \"$target\" ]; then if [ -x \"$target\" ]; then mode=100755; else mode=100644; fi; \
         size=$(wc -c < \"$target\") || exit 1; printf 'F\\0%s\\0%s\\0' \"$mode\" \"$size\"; \
         if [ \"$size\" -le {} ]; then dd if=\"$target\" bs={} count=1 2>/dev/null; fi; \
         elif [ -e \"$target\" ]; then printf 'E\\0'; else printf 'M\\0'; fi",
        crate::ssh::quote(root),
        crate::ssh::quote(path),
        FILE_LIMIT,
        FILE_LIMIT + 1,
    ))
}

fn remote_file(project: &AgentProject, root: &str, path: &str) -> Result<RemoteFile, GitError> {
    parse_remote_file(posix_read(project, &remote_file_script(root, path)?, None)?)
}

fn remote_object_script(root: &str, oid: &str) -> String {
    format!(
        "root={}; oid={}; {} \
         size=$(git --no-replace-objects --no-pager --no-optional-locks -c color.ui=false -c core.pager=cat -c diff.external= -C \"$root\" cat-file -s \"$oid\") || exit 1; \
         printf 'G\\0%s\\0' \"$size\"; if [ \"$size\" -le {} ]; then \
         git --no-replace-objects --no-pager --no-optional-locks -c color.ui=false -c core.pager=cat -c diff.external= -C \"$root\" cat-file blob \"$oid\" || exit 1; fi; ",
        crate::ssh::quote(root),
        crate::ssh::quote(oid),
        posix_git_environment(),
        FILE_LIMIT,
    )
}

fn remote_object_and_file(
    project: &AgentProject,
    root: &str,
    path: &str,
    mode: String,
    oid: String,
) -> Result<(GitContent, RemoteFile), GitError> {
    let script = remote_object_script(root, &oid) + &remote_file_script(root, path)?;
    parse_remote_object_and_file(posix_read(project, &script, None)?, mode, oid)
}

fn remote_object_contents(
    project: &AgentProject,
    objects: &[(String, String)],
) -> Result<Vec<GitContent>, GitError> {
    crate::ssh::validate_path(&project.path)
        .map_err(|message| GitError::new("invalidPath", message))?;
    let mut script = String::new();
    for (mode, oid) in objects {
        validate_object_mode(mode)?;
        validate_oid(oid)?;
        script.push_str(&remote_object_script(&project.path, oid));
    }
    let output = posix_read(project, &script, None)?;
    let mut bytes = output.as_slice();
    let mut contents = Vec::with_capacity(objects.len());
    for (mode, oid) in objects {
        let (content, remaining) = parse_remote_object(bytes, mode.clone(), oid.clone())?;
        contents.push(content);
        bytes = remaining;
    }
    if !bytes.is_empty() {
        return Err(malformed_remote_object());
    }
    Ok(contents)
}

fn malformed_remote_object() -> GitError {
    GitError::new("malformed", "Contenu Git SSH groupé invalide.")
}

fn parse_remote_object(
    bytes: &[u8],
    mode: String,
    oid: String,
) -> Result<(GitContent, &[u8]), GitError> {
    let rest = bytes
        .strip_prefix(b"G\0")
        .ok_or_else(malformed_remote_object)?;
    let size_end = rest
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(malformed_remote_object)?;
    let size = std::str::from_utf8(&rest[..size_end])
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .ok_or_else(malformed_remote_object)?;
    let body = &rest[size_end + 1..];
    let body_size = if size <= FILE_LIMIT {
        usize::try_from(size).map_err(|_| malformed_remote_object())?
    } else {
        0
    };
    let (body, remaining) = body
        .split_at_checked(body_size)
        .ok_or_else(malformed_remote_object)?;
    let content = if size > FILE_LIMIT {
        unreadable_content(Some(oid), size, mode, "tooLarge")
    } else {
        object_content_from_bytes(body.to_vec(), oid, size, mode)?
    };
    Ok((content, remaining))
}

pub(super) fn parse_remote_object_and_file(
    bytes: Vec<u8>,
    mode: String,
    oid: String,
) -> Result<(GitContent, RemoteFile), GitError> {
    let (content, file) = parse_remote_object(&bytes, mode, oid)?;
    Ok((content, parse_remote_file(file.to_vec())?))
}

fn remote_disk_content_checked(
    project: &AgentProject,
    identity: &GitIdentity,
    path: &str,
    expected: Option<&WorktreeFingerprint>,
) -> Result<Option<GitContent>, GitError> {
    remote_file_content_checked(
        identity,
        remote_file(project, &identity.root, path)?,
        expected,
    )
}

pub(super) fn remote_file_content_checked(
    identity: &GitIdentity,
    file: RemoteFile,
    expected: Option<&WorktreeFingerprint>,
) -> Result<Option<GitContent>, GitError> {
    match file {
        RemoteFile::Missing => Ok(expected.is_none().then(empty_content)),
        RemoteFile::Symlink(bytes) => {
            if !fingerprint_matches(expected, "120000", &bytes, identity.object_format) {
                return Ok(None);
            }
            let oid = blob_oid(identity.object_format, &bytes);
            let mut content =
                unreadable_content(Some(oid), bytes.len() as u64, "120000".into(), "symlink");
            content.text = Some(String::from_utf8_lossy(&bytes).into_owned());
            Ok(Some(content))
        }
        RemoteFile::Regular { mode, size, bytes } if size <= FILE_LIMIT => {
            if bytes.len() as u64 > FILE_LIMIT
                || !fingerprint_matches(expected, &mode, &bytes, identity.object_format)
            {
                return Ok(None);
            }
            let oid = blob_oid(identity.object_format, &bytes);
            content_from_bytes(bytes, Some(oid), mode).map(Some)
        }
        RemoteFile::Regular { mode, size, .. } => {
            let matches = expected.is_none_or(|expected| {
                matches!(
                    expected,
                    WorktreeFingerprint::Present {
                        mode: expected_mode,
                        kind: "size",
                        hash,
                    } if expected_mode == &mode && hash == &size.to_string()
                )
            });
            Ok(matches.then(|| unreadable_content(None, size, mode, "tooLarge")))
        }
    }
}

pub(super) enum BoundedRead {
    Complete(Vec<u8>),
    TooLarge,
}

pub(super) fn read_file_chunks(
    path: &Path,
    display_path: &str,
    mut consume: impl FnMut(&[u8]),
) -> Result<bool, GitError> {
    let mut file = File::open(path).map_err(|error| file_error(display_path, error))?;
    let mut total = 0;
    let mut block = [0; 64 * 1024];
    while total <= FILE_LIMIT as usize {
        check_read_deadline()?;
        let remaining = FILE_LIMIT as usize + 1 - total;
        let block_limit = remaining.min(block.len());
        let read = file
            .read(&mut block[..block_limit])
            .map_err(|error| file_error(display_path, error))?;
        if read == 0 {
            break;
        }
        consume(&block[..read]);
        total += read;
    }
    Ok(total as u64 <= FILE_LIMIT)
}

pub(super) fn read_file_bounded(path: &Path, display_path: &str) -> Result<BoundedRead, GitError> {
    let mut bytes = Vec::new();
    if read_file_chunks(path, display_path, |block| bytes.extend_from_slice(block))? {
        Ok(BoundedRead::Complete(bytes))
    } else {
        Ok(BoundedRead::TooLarge)
    }
}

pub(super) fn hash_file_bounded(
    path: &Path,
    display_path: &str,
) -> Result<Option<String>, GitError> {
    let mut hash = Sha256::new();
    if read_file_chunks(path, display_path, |block| hash.update(block))? {
        Ok(Some(format!("{:x}", hash.finalize())))
    } else {
        Ok(None)
    }
}

fn disk_metadata(
    project: &AgentProject,
    identity: &GitIdentity,
    raw_path: &[u8],
) -> Result<Option<DiskEntry>, GitError> {
    DiskRoot::new(project, identity)?.metadata(raw_path)
}

pub(super) struct DiskEntry {
    pub(super) mode: String,
    pub(super) size: u64,
    pub(super) path: PathBuf,
    pub(super) stamp: Option<FileStamp>,
}

pub(super) struct DiskRoot {
    path: PathBuf,
    canonical: PathBuf,
}

impl DiskRoot {
    pub(super) fn new(project: &AgentProject, identity: &GitIdentity) -> Result<Self, GitError> {
        let path = filesystem_root(project, &identity.root)?;
        let canonical = fs::canonicalize(&path).map_err(|error| {
            GitError::new("inaccessible", format!("Racine Git inaccessible : {error}"))
        })?;
        Ok(Self { path, canonical })
    }

    pub(super) fn metadata(&self, raw_path: &[u8]) -> Result<Option<DiskEntry>, GitError> {
        let (path, representable) = display_path(raw_path);
        if representable {
            validate_relative_path(&path)?;
        }
        let target = self.path.join(raw_path_component(raw_path)?);
        let parent = target
            .parent()
            .ok_or_else(|| GitError::new("invalidPath", "Parent Git invalide."))?;
        let canonical_parent = match fs::canonicalize(parent) {
            Ok(parent) => parent,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(file_error(&path, error)),
        };
        if !canonical_parent.starts_with(&self.canonical) {
            return Err(GitError::new(
                "invalidPath",
                "Un parent symbolique sort de la racine Git.",
            ));
        }
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(file_error(&path, error)),
        };
        let file_type = metadata.file_type();
        let mode = if file_type.is_symlink() {
            "120000".into()
        } else if file_type.is_file() {
            regular_mode(&metadata)
        } else {
            return Err(GitError::new(
                "inaccessible",
                format!("Le chemin Git n’est pas un fichier lisible : {path}"),
            ));
        };
        let (size, stamp) = if file_type.is_symlink() {
            (read_link_bytes(&target)?.len() as u64, None)
        } else {
            (metadata.len(), file_stamp(&metadata))
        };
        Ok(Some(DiskEntry {
            mode,
            size,
            path: target,
            stamp,
        }))
    }
}

fn file_stamp(metadata: &fs::Metadata) -> Option<FileStamp> {
    let nanos = |time: SystemTime| {
        time.duration_since(UNIX_EPOCH)
            .ok()
            .map(|elapsed| elapsed.as_nanos() as i128)
    };
    let (key, changed) = stamp_identity(metadata);
    let modified = nanos(metadata.modified().ok()?)?;
    let newest = changed.map_or(modified, |changed| changed.max(modified));
    let now = nanos(SystemTime::now())?;
    Some(FileStamp {
        key: format!("{}:{modified}:{key}", metadata.len()),
        settled: now - newest >= SETTLE_NANOS,
    })
}

#[cfg(unix)]
fn stamp_identity(metadata: &fs::Metadata) -> (String, Option<i128>) {
    use std::os::unix::fs::MetadataExt;
    let changed = i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec());
    (
        format!("{changed}:{}:{}", metadata.dev(), metadata.ino()),
        Some(changed),
    )
}

#[cfg(windows)]
fn stamp_identity(metadata: &fs::Metadata) -> (String, Option<i128>) {
    use std::os::windows::fs::MetadataExt;
    (format!("{}", metadata.creation_time()), None)
}

#[cfg(not(any(unix, windows)))]
fn stamp_identity(_metadata: &fs::Metadata) -> (String, Option<i128>) {
    (String::new(), None)
}

#[cfg(unix)]
pub(super) fn raw_path_component(path: &[u8]) -> Result<&Path, GitError> {
    use std::os::unix::ffi::OsStrExt;
    Ok(Path::new(std::ffi::OsStr::from_bytes(path)))
}

#[cfg(not(unix))]
pub(super) fn raw_path_component(path: &[u8]) -> Result<&Path, GitError> {
    std::str::from_utf8(path)
        .map(Path::new)
        .map_err(|_| GitError::new("invalidPath", "Chemin Git non Unicode."))
}

pub(super) fn filesystem_root(project: &AgentProject, root: &str) -> Result<PathBuf, GitError> {
    project_filesystem_directory(&project.environment, Some(root))
        .map_err(|message| GitError::new("inaccessible", message))?
        .ok_or_else(|| GitError::new("inaccessible", "Racine Git locale invalide."))
}

#[cfg(unix)]
fn regular_mode(metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o111 == 0 {
        "100644".into()
    } else {
        "100755".into()
    }
}

#[cfg(not(unix))]
fn regular_mode(_: &fs::Metadata) -> String {
    "100644".into()
}

#[cfg(unix)]
pub(super) fn read_link_bytes(path: &Path) -> Result<Vec<u8>, GitError> {
    use std::os::unix::ffi::OsStrExt;
    fs::read_link(path)
        .map(|target| target.as_os_str().as_bytes().to_vec())
        .map_err(|error| file_error(&path.to_string_lossy(), error))
}

#[cfg(not(unix))]
pub(super) fn read_link_bytes(path: &Path) -> Result<Vec<u8>, GitError> {
    fs::read_link(path)
        .map(|target| target.to_string_lossy().into_owned().into_bytes())
        .map_err(|error| file_error(&path.to_string_lossy(), error))
}

pub(super) fn file_error(path: &str, error: std::io::Error) -> GitError {
    GitError::new(
        "inaccessible",
        format!("Impossible de lire le fichier Git {path} : {error}"),
    )
}
