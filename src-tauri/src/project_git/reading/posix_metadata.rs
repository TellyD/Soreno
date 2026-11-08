use super::{memo, posix_read, FileStamp, GitError, FILE_LIMIT, HASH_PATHS_INPUT_LIMIT};
use crate::{
    agent_sessions::AgentProject,
    project_git::{command_builder::posix_git_environment, validate_oid, validate_relative_path},
};

const POSIX_METADATA_BATCH: usize = 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RemoteMetadata {
    Missing,
    Regular {
        mode: String,
        size: u64,
        oid: Option<String>,
        stamp: Option<FileStamp>,
    },
    Symlink(Vec<u8>),
}

/// Octal-escapes every byte a shell or Git quoting could reinterpret; plain names stay readable.
/// Digits are escaped too: `printf '%b'` would read a digit after `\0oo` as a fourth octal digit.
pub(super) fn remote_path_record(path: &[u8]) -> Result<Vec<u8>, GitError> {
    let display = std::str::from_utf8(path)
        .map_err(|_| GitError::new("unsupportedPath", "Chemin SSH non Unicode."))?;
    validate_relative_path(display)?;
    let mut encoded = Vec::with_capacity(path.len() * 4);
    for byte in path {
        if byte.is_ascii_alphabetic() || matches!(byte, b'.' | b'_' | b'-' | b'/') {
            encoded.push(*byte);
        } else {
            encoded.extend_from_slice(&[
                b'\\',
                b'0' + (byte >> 6),
                b'0' + ((byte >> 3) & 7),
                b'0' + (byte & 7),
            ]);
        }
    }
    Ok(encoded)
}

/// A size line is either `size` (no usable `stat`) or `size:mtime:ctime:inode` in whole seconds,
/// times negative before 1970; a stamp is settled once older than any write sharing its second.
pub(super) fn remote_size_line(
    line: &[u8],
    now: i64,
) -> Result<(u64, Option<FileStamp>), GitError> {
    let malformed = || GitError::new("malformed", "Taille SSH invalide.");
    let line = std::str::from_utf8(line).map_err(|_| malformed())?;
    if !line.contains(':') {
        return Ok((line.trim().parse().map_err(|_| malformed())?, None));
    }
    let fields = line.split(':').collect::<Vec<_>>();
    if line.len() > 128 || fields.len() != 4 {
        return Err(malformed());
    }
    let digits = |field: &str| !field.is_empty() && field.bytes().all(|byte| byte.is_ascii_digit());
    let unsigned = |field: &str| {
        digits(field)
            .then(|| field.parse::<u64>().ok())
            .flatten()
            .ok_or_else(malformed)
    };
    let signed = |field: &str| {
        digits(field.strip_prefix('-').unwrap_or(field))
            .then(|| field.parse::<i64>().ok())
            .flatten()
            .ok_or_else(malformed)
    };
    let size = unsigned(fields[0])?;
    let newest = i128::from(signed(fields[1])?.max(signed(fields[2])?));
    unsigned(fields[3])?;
    Ok((
        size,
        Some(FileStamp {
            key: line.into(),
            settled: (i128::from(now) - newest) * 1_000_000_000 > memo::SETTLE_NANOS,
        }),
    ))
}

pub(super) fn parse_remote_metadata(
    mut bytes: &[u8],
    known: &[Option<&str>],
    hash_all_regular_files: bool,
) -> Result<Vec<RemoteMetadata>, GitError> {
    fn field<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8], GitError> {
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| GitError::new("malformed", "Métadonnées SSH incomplètes."))?;
        let value = &bytes[..end];
        *bytes = &bytes[end + 1..];
        Ok(value)
    }

    if field(&mut bytes)? != b"T" {
        return Err(GitError::new("malformed", "Horloge SSH absente."));
    }
    let now = std::str::from_utf8(field(&mut bytes)?)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .ok_or_else(|| GitError::new("malformed", "Horloge SSH invalide."))?;
    let mut metadata = Vec::with_capacity(known.len());
    let mut regular = Vec::new();
    for known in known {
        match field(&mut bytes)? {
            b"M" => metadata.push(RemoteMetadata::Missing),
            b"F" => {
                let mode = std::str::from_utf8(field(&mut bytes)?)
                    .map_err(|_| GitError::new("malformed", "Mode SSH invalide."))?;
                if !matches!(mode, "100644" | "100755") {
                    return Err(GitError::new("malformed", "Mode SSH invalide."));
                }
                regular.push((metadata.len(), *known));
                metadata.push(RemoteMetadata::Regular {
                    mode: mode.into(),
                    size: 0,
                    oid: None,
                    stamp: None,
                });
            }
            b"L" => {
                let target = field(&mut bytes)?;
                let target = target
                    .strip_suffix(b"\n")
                    .ok_or_else(|| GitError::new("malformed", "Cible de lien SSH incomplète."))?;
                metadata.push(RemoteMetadata::Symlink(target.to_vec()));
            }
            b"U" => {
                return Err(GitError::new(
                    "invalidPath",
                    "Un parent symbolique sort de la racine Git distante.",
                ));
            }
            b"E" => {
                return Err(GitError::new(
                    "inaccessible",
                    "Un chemin Git distant n’est pas un fichier lisible.",
                ));
            }
            _ => return Err(GitError::new("malformed", "Métadonnées SSH invalides.")),
        }
    }
    if field(&mut bytes)? != b"S" {
        return Err(GitError::new("malformed", "Tailles SSH absentes."));
    }
    let mut hashed = Vec::new();
    for (index, known) in regular {
        let end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| GitError::new("malformed", "Tailles SSH incomplètes."))?;
        let (size, stamp) = remote_size_line(&bytes[..end], now)?;
        bytes = &bytes[end + 1..];
        // Mirrors the script: an unchanged stamp skips hashing, the memo supplies the OID.
        let unchanged = stamp
            .as_ref()
            .is_some_and(|stamp| Some(stamp.key.as_str()) == known);
        if !unchanged && (hash_all_regular_files || size <= FILE_LIMIT) {
            hashed.push(index);
        }
        let RemoteMetadata::Regular {
            size: metadata_size,
            stamp: metadata_stamp,
            ..
        } = &mut metadata[index]
        else {
            unreachable!("métadonnée régulière attendue")
        };
        (*metadata_size, *metadata_stamp) = (size, stamp);
    }
    if field(&mut bytes)? != b"H" {
        return Err(GitError::new("malformed", "Empreintes SSH absentes."));
    }
    let hashes = if bytes.is_empty() {
        Vec::new()
    } else {
        bytes
            .strip_suffix(b"\n")
            .ok_or_else(|| GitError::new("malformed", "Empreintes SSH incomplètes."))?
            .split(|byte| *byte == b'\n')
            .collect::<Vec<_>>()
    };
    if hashes.len() != hashed.len() {
        return Err(GitError::new(
            "malformed",
            "Nombre d’empreintes SSH invalide.",
        ));
    }
    for (index, oid) in hashed.into_iter().zip(hashes) {
        let oid = std::str::from_utf8(oid)
            .map_err(|_| GitError::new("malformed", "OID SSH invalide."))?
            .to_owned();
        validate_oid(&oid)?;
        let RemoteMetadata::Regular {
            oid: metadata_oid, ..
        } = &mut metadata[index]
        else {
            unreachable!("métadonnée régulière attendue")
        };
        *metadata_oid = Some(oid);
    }
    Ok(metadata)
}

pub(super) fn posix_metadata(
    project: &AgentProject,
    root: &str,
    paths: &[&[u8]],
    known: &[Option<&str>],
) -> Result<Vec<RemoteMetadata>, GitError> {
    crate::ssh::validate_path(root).map_err(|message| GitError::new("invalidPath", message))?;
    let hash_all_regular_files = project.environment.kind == "wsl";
    let script = posix_metadata_script(root, hash_all_regular_files);
    let mut result = Vec::with_capacity(paths.len());
    let mut offset = 0;
    while offset < paths.len() {
        let mut input = Vec::new();
        let mut count = 0;
        while offset + count < paths.len() && count < POSIX_METADATA_BATCH {
            let mut record = remote_path_record(paths[offset + count])?;
            record.push(b' ');
            record.extend_from_slice(known[offset + count].unwrap_or("-").as_bytes());
            record.push(b'\n');
            if count > 0 && input.len() + record.len() > HASH_PATHS_INPUT_LIMIT {
                break;
            }
            if record.len() > HASH_PATHS_INPUT_LIMIT {
                return Err(GitError::new("invalidPath", "Un chemin SSH est trop long."));
            }
            input.extend_from_slice(&record);
            count += 1;
        }
        let output = posix_read(project, &script, Some(&input))?;
        result.extend(parse_remote_metadata(
            &output,
            &known[offset..offset + count],
            hash_all_regular_files,
        )?);
        offset += count;
    }
    Ok(result)
}

// The loop uses only builtins (plus one `cd` per directory and a decode per escaped name):
// sizes and stamps come from one batched `stat` through `xargs -0`, since one exec per file
// costs seconds on large change sets. Without both tools, `wc -c` per file keeps the old path.
pub(super) fn posix_metadata_script(root: &str, hash_all_regular_files: bool) -> String {
    format!(
        "{} \
         root={}; canonical_root=$(cd -P -- \"$root\" 2>/dev/null && pwd -P && printf .) || exit 1; \
         canonical_root=${{canonical_root%.}}; canonical_root=${{canonical_root%?}}; \
         work=$(mktemp -d \"${{TMPDIR:-/tmp}}/soreno-hash.XXXXXX\") || exit 1; trap 'rm -rf \"$work\"' 0 HUP INT TERM; \
         : > \"$work/files\" && : > \"$work/targets\" && : > \"$work/sizes\" && : > \"$work/paths\" || exit 1; \
         stat_format=; if printf 'x\\0' | xargs -0 true >/dev/null 2>&1; then \
         if stat -c %s:%Y:%Z:%i / >/dev/null 2>&1; then stat_format='-c %s:%Y:%Z:%i'; \
         elif stat -f %z:%m:%c:%i / >/dev/null 2>&1; then stat_format='-f %z:%m:%c:%i'; fi; fi; \
         printf 'T\\0%s\\0' \"$(date +%s)\"; resolved_parent=; \
         while IFS=' ' read -r encoded known; do \
         case $encoded in *\\\\*) relative=$(printf '%b.' \"$encoded\") || exit 1; relative=${{relative%.}};; *) relative=$encoded;; esac; \
         parent=${{relative%/*}}; [ \"$parent\" = \"$relative\" ] && parent=.; \
         if [ \"$parent/\" != \"$resolved_parent\" ]; then resolved_parent=; \
         if ! canonical_parent=$(cd -P -- \"$canonical_root/$parent\" 2>/dev/null && pwd -P && printf .); then \
         if [ ! -e \"$canonical_root/$parent\" ] && [ ! -L \"$canonical_root/$parent\" ]; then printf 'M\\0'; else printf 'E\\0'; fi; continue; fi; \
         canonical_parent=${{canonical_parent%.}}; canonical_parent=${{canonical_parent%?}}; \
         if [ \"$canonical_root\" != / ]; then case \"$canonical_parent/\" in \"$canonical_root/\"*) ;; *) printf 'U\\0'; continue;; esac; fi; \
         resolved_parent=\"$parent/\"; fi; \
         target=\"$canonical_root/$relative\"; if [ -L \"$target\" ]; then printf 'L\\0'; readlink \"$target\" || exit 1; printf '\\0'; \
         elif [ -f \"$target\" ]; then if [ -x \"$target\" ]; then mode=100755; else mode=100644; fi; printf 'F\\0%s\\0' \"$mode\"; \
         printf '%s %s\\n' \"$encoded\" \"$known\" >> \"$work/files\" || exit 1; \
         if [ -n \"$stat_format\" ]; then printf '%s\\0' \"$target\" >> \"$work/targets\" || exit 1; \
         else size=$(wc -c < \"$target\") || exit 1; printf '%s\\n' \"$size\" >> \"$work/sizes\" || exit 1; fi; \
         elif [ -e \"$target\" ]; then printf 'E\\0'; else printf 'M\\0'; fi; done; \
         if [ -s \"$work/targets\" ]; then xargs -0 stat $stat_format < \"$work/targets\" > \"$work/sizes\" || exit 1; fi; \
         printf 'S\\0'; exec 3< \"$work/sizes\"; \
         while IFS=' ' read -r encoded known; do IFS= read -r stamp <&3 || exit 1; printf '%s\\n' \"$stamp\"; size=${{stamp%%:*}}; \
         if [ \"$stamp\" != \"$size\" ] && [ \"$stamp\" = \"$known\" ]; then :; \
         elif {} || [ \"$size\" -le {} ]; then printf '\"%s\"\\n' \"$encoded\" >> \"$work/paths\" || exit 1; fi; \
         done < \"$work/files\"; exec 3<&-; \
         printf 'H\\0'; git --no-replace-objects --no-pager --no-optional-locks -c color.ui=false -c core.pager=cat -c diff.external= -C \"$canonical_root\" hash-object --no-filters --stdin-paths < \"$work/paths\"",
        posix_git_environment(),
        crate::ssh::quote(root),
        hash_all_regular_files,
        FILE_LIMIT
    )
}
