use super::{
    entry_value,
    errors::{
        exists, invalid_path, not_directory, not_file, paste_too_large, pasted_directory,
        symlink_error,
    },
    file_io_error, filesystem_root, invalidate_search_cache,
    remote::{remote_guard, remote_run, remote_run_with_timeout},
    validate_relative_path, AgentProject, ProjectFileEntry, ProjectFileError, WRITE_LOCK,
};
use serde::Deserialize;
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[cfg(not(any(unix, windows)))]
use portable as local;
#[cfg(unix)]
use unix as local;
#[cfg(windows)]
use windows as local;

const DUPLICATE_LIMIT: usize = 100;
/// Input cap of the SSH relay, which receives each pasted file whole.
const REMOTE_IMPORT_LIMIT: u64 = 32 * 1024 * 1024;
const REMOTE_IMPORT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectFileKind {
    File,
    Directory,
}

impl ProjectFileKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }
}

pub fn create(
    project: &AgentProject,
    path: &str,
    kind: ProjectFileKind,
) -> Result<ProjectFileEntry, ProjectFileError> {
    validate_relative_path(path, false)?;
    mutate(project, || {
        if project.environment.kind == "ssh" {
            remote_run(
                project,
                &remote_create_script(&project.path, path, kind),
                None,
                1024,
            )
            .map(drop)
        } else {
            local::create(&local_root(project, &[path])?, path, kind)
        }
    })?;
    Ok(entry(path, kind))
}

pub fn rename(
    project: &AgentProject,
    from: &str,
    to: &str,
) -> Result<ProjectFileEntry, ProjectFileError> {
    validate_relative_path(from, false)?;
    validate_relative_path(to, false)?;
    if from == to || to.starts_with(&format!("{from}/")) {
        return Err(invalid_path());
    }
    let kind = mutate(project, || {
        if project.environment.kind == "ssh" {
            let output = remote_run(
                project,
                &remote_rename_script(&project.path, from, to),
                None,
                1024,
            )?;
            match output.as_slice() {
                b"d" => Ok(ProjectFileKind::Directory),
                b"f" => Ok(ProjectFileKind::File),
                _ => Err(unexpected_remote_output()),
            }
        } else {
            local::rename(&local_root(project, &[from, to])?, from, to)
        }
    })?;
    Ok(entry(to, kind))
}

pub fn delete(project: &AgentProject, path: &str) -> Result<(), ProjectFileError> {
    validate_relative_path(path, false)?;
    mutate(project, || {
        if project.environment.kind == "ssh" {
            remote_run(
                project,
                &remote_delete_script(&project.path, path),
                None,
                1024,
            )
            .map(drop)
        } else {
            local::delete(&local_root(project, &[path])?, path)
        }
    })
}

pub fn duplicate(project: &AgentProject, path: &str) -> Result<ProjectFileEntry, ProjectFileError> {
    validate_relative_path(path, false)?;
    let (directory, name) = split(path);
    let (copy, kind) = mutate(project, || {
        if project.environment.kind == "ssh" {
            let output = remote_run(
                project,
                &remote_duplicate_script(&project.path, path),
                None,
                64 * 1024,
            )?;
            parse_remote_duplicate(&output, name)
        } else {
            local::duplicate(&local_root(project, &[path])?, path)
        }
    })?;
    Ok(entry_value(directory, copy, kind.as_str()))
}

/// Copies files from outside the project into `directory`; a taken name gets the duplicate suffixes.
/// Every source is checked before anything is copied.
pub fn import_files(
    project: &AgentProject,
    directory: &str,
    sources: &[PathBuf],
) -> Result<Vec<ProjectFileEntry>, ProjectFileError> {
    validate_relative_path(directory, true)?;
    let remote = project.environment.kind == "ssh";
    let mut files = sources
        .iter()
        .map(|source| {
            let (name, file) = import_source(source, remote)?;
            let path = if directory.is_empty() {
                name.clone()
            } else {
                format!("{directory}/{name}")
            };
            validate_relative_path(&path, false)?;
            if !remote && !plain_components(&path, cfg!(windows)) {
                return Err(invalid_path());
            }
            Ok((name, path, file))
        })
        .collect::<Result<Vec<_>, _>>()?;
    mutate(project, || {
        files
            .iter_mut()
            .map(|(name, path, file)| {
                let copy = if remote {
                    let mut bytes = Vec::new();
                    file.take(REMOTE_IMPORT_LIMIT + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|error| file_io_error(name, error))?;
                    if bytes.len() as u64 > REMOTE_IMPORT_LIMIT {
                        return Err(paste_too_large());
                    }
                    let output = remote_run_with_timeout(
                        project,
                        &remote_import_script(&project.path, path),
                        Some(&bytes),
                        64 * 1024,
                        REMOTE_IMPORT_TIMEOUT,
                    )?;
                    parse_remote_import(&output, name)?
                } else {
                    local::import(&filesystem_root(project)?, path, file)?
                };
                Ok(entry_value(directory, copy, "file"))
            })
            .collect()
    })
}

/// Follows links: the source is whatever the user copied, outside the project.
fn import_source(source: &Path, remote: bool) -> Result<(String, File), ProjectFileError> {
    let name = source
        .file_name()
        .ok_or_else(invalid_path)?
        .to_str()
        .ok_or_else(|| {
            ProjectFileError::new("encoding", "Ce nom de fichier n’est pas encodé en UTF-8.")
        })?
        .to_owned();
    let label = source.to_string_lossy();
    if fs::metadata(source)
        .map_err(|error| file_io_error(&label, error))?
        .is_dir()
    {
        return Err(pasted_directory());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    // A FIFO swapped in after the check must not block the open.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let file = options
        .open(source)
        .map_err(|error| file_io_error(&label, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| file_io_error(&label, error))?;
    if !metadata.is_file() {
        return Err(not_file());
    }
    if remote && metadata.len() > REMOTE_IMPORT_LIMIT {
        return Err(paste_too_large());
    }
    Ok((name, file))
}

fn mutate<T>(
    project: &AgentProject,
    action: impl FnOnce() -> Result<T, ProjectFileError>,
) -> Result<T, ProjectFileError> {
    let _write_guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let result = action();
    invalidate_search_cache(project);
    result
}

fn split(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

fn local_root(project: &AgentProject, paths: &[&str]) -> Result<PathBuf, ProjectFileError> {
    if !paths
        .iter()
        .all(|path| plain_components(path, cfg!(windows)))
    {
        return Err(invalid_path());
    }
    filesystem_root(project)
}

/// Each component must stay one plain name: a Windows `C:x` component would make `join`
/// replace the validated parent, and `name:stream` would address an alternate data stream.
fn plain_components(path: &str, windows: bool) -> bool {
    path.split('/').all(|part| {
        let mut components = Path::new(part).components();
        matches!(
            (components.next(), components.next()),
            (Some(Component::Normal(name)), None) if name == OsStr::new(part)
        ) && !(windows && part.contains(':'))
    })
}

fn entry(path: &str, kind: ProjectFileKind) -> ProjectFileEntry {
    let (directory, name) = split(path);
    entry_value(directory, name.to_owned(), kind.as_str())
}

/// Finder-style sibling names: `stem copy.ext`, `stem copy 2.ext`, … (directories keep dots).
fn duplicate_names(name: &str, directory: bool) -> impl Iterator<Item = String> + '_ {
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 && !directory => name.split_at(index),
        _ => (name, ""),
    };
    (1..=DUPLICATE_LIMIT).map(move |index| {
        if index == 1 {
            format!("{stem} copy{extension}")
        } else {
            format!("{stem} copy {index}{extension}")
        }
    })
}

fn import_names(name: &str) -> impl Iterator<Item = String> + '_ {
    std::iter::once(name.to_owned()).chain(duplicate_names(name, false))
}

#[cfg(any(not(any(unix, windows)), test))]
fn case_only_rename(from: &str, to: &str) -> bool {
    from != to && from.to_lowercase() == to.to_lowercase()
}

fn unexpected_remote_output() -> ProjectFileError {
    ProjectFileError::new("ssh", "Réponse SSH inattendue.")
}

fn io_error(path: &str, error: io::Error) -> ProjectFileError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        return exists();
    }
    if error.kind() == io::ErrorKind::NotADirectory {
        return not_directory();
    }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ELOOP) {
        return symlink_error();
    }
    file_io_error(path, error)
}

const REMOTE_EXISTS: &str = "{ printf 'SORENO_FILE_EXISTS\\n' >&2; exit 48; }";
const REMOTE_NOT_FOUND: &str = "{ printf 'SORENO_FILE_NOT_FOUND\\n' >&2; exit 47; }";
const REMOTE_SYMLINK: &str = "{ printf 'SORENO_FILE_SYMLINK\\n' >&2; exit 42; }";

/// Defines `enter CREATE PART...`: walks from the root one physical component at a time,
/// refusing links and anything outside the root, and leaves the parent as cwd and `$here`.
fn remote_prelude(root: &str, paths: &[&str]) -> String {
    let guards: String = paths.iter().map(|path| remote_guard(root, path)).collect();
    let root = crate::ssh::quote(root);
    // The `x` sentinel keeps trailing newlines that `$(...)` would strip from directory names.
    format!(
        "set -eu; {guards}root_real=$(cd -P -- {root} && pwd -P && printf x); root_real=${{root_real%?x}}; \
         locate() {{ here=$(pwd -P && printf x); here=${{here%?x}}; [ \"$root_real\" = / ] || case \"$here/\" in \"$root_real\"/*) ;; *) printf 'SORENO_FILE_OUTSIDE\\n' >&2; exit 49;; esac; }}; \
         enter() {{ create=$1; shift; cd -P -- {root}; locate; for part do [ ! -L \"./$part\" ] || {REMOTE_SYMLINK}; if [ ! -d \"./$part\" ]; then if [ -e \"./$part\" ]; then printf 'SORENO_FILE_NOT_DIRECTORY\\n' >&2; exit 43; elif [ \"$create\" = 1 ]; then mkdir -- \"./$part\"; else {REMOTE_NOT_FOUND}; fi; fi; cd -P -- \"./$part\"; locate; done; }}; "
    )
}

fn remote_enter(path: &str, create: bool) -> String {
    let parts: String = split(path)
        .0
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| format!(" {}", crate::ssh::quote(part)))
        .collect();
    format!("enter {}{parts}; ", u8::from(create))
}

fn remote_create_script(root: &str, path: &str, kind: ProjectFileKind) -> String {
    // Noclobber is not exclusive for existing non-regular targets (a link to a device is opened
    // through), so a reservation only counts when a plain regular file is left at the name.
    let create = match kind {
        ProjectFileKind::File => format!(
            "( set -C; exec 3> \"$target\" || exit 93; [ -f \"$target\" ] && [ ! -L \"$target\" ] || exit 92 ) || {{ if [ -e \"$target\" ] || [ -L \"$target\" ]; then {REMOTE_EXISTS}; fi; exit 1; }}"
        ),
        ProjectFileKind::Directory => "mkdir -- \"$target\"".to_owned(),
    };
    format!(
        "{}{}target=./{}; if [ -e \"$target\" ] || [ -L \"$target\" ]; then {REMOTE_EXISTS}; fi; {create}",
        remote_prelude(root, &[path]),
        remote_enter(path, true),
        crate::ssh::quote(split(path).1),
    )
}

fn remote_rename_script(root: &str, from: &str, to: &str) -> String {
    // A target resolving to the source in the same directory is an alias of its entry (case or
    // Unicode normalization variant on an insensitive filesystem) unless both exact names are listed
    // as separate entries (hard links), which cannot be merged.
    let same_file = "{ [ ! -L \"$target\" ] && [ \"$source\" -ef \"$target\" ] && [ \"$source_dir\" -ef . ] && { found=0; for e in * .[!.]* ..?*; do case $e in \"$name\"|\"${target#./}\") found=$((found + 1));; esac; done; [ \"$found\" -lt 2 ]; }; }";
    // `mv -n` never clobbers a destination that appears after the check; a source left behind means it did.
    // `-T` keeps a directory appearing at the target from receiving the source. Where `mv` lacks it, the
    // plain `mv -n` fallback is checked by kind (inodes change across devices): a file that ends up as a
    // directory, or a directory whose own name newly appears inside the target, was moved into one.
    // Same-file aliases go through a temporary sibling without `-T`, so the exact name is kept; an entry
    // that cannot reach the target is moved back only while its original name is free (a directory there
    // would receive it), and one left under the temporary name is reported.
    format!(
        "{}{}source_dir=$here; source=\"$here\"/{}; name={}; [ -e \"$source\" ] || [ -L \"$source\" ] || {REMOTE_NOT_FOUND}; [ ! -L \"$source\" ] || {REMOTE_SYMLINK}; {}target=./{}; if [ -e \"$target\" ] || [ -L \"$target\" ]; then {same_file} || {REMOTE_EXISTS}; if ! mv -T -- \"$source\" \"$target\" 2>/dev/null; then tmp=./.soreno-rename.$$; if [ -e \"$tmp\" ] || [ -L \"$tmp\" ]; then {REMOTE_EXISTS}; fi; mv -n -- \"$source\" \"$tmp\"; if [ -e \"$source\" ] || [ -L \"$source\" ]; then {REMOTE_EXISTS}; fi; if [ ! -e \"$target\" ] && [ ! -L \"$target\" ] && mv -n -- \"$tmp\" \"$target\"; then :; fi; if [ -e \"$tmp\" ] || [ -L \"$tmp\" ]; then if [ ! -e \"$source\" ] && [ ! -L \"$source\" ] && mv -n -- \"$tmp\" \"$source\"; then :; fi; if [ -e \"$tmp\" ] || [ -L \"$tmp\" ]; then printf 'SORENO_FILE_STRANDED\\0%s%s\\0' {} \"${{tmp#./}}\" >&2; exit 50; fi; if [ -e \"$target\" ] || [ -L \"$target\" ]; then {REMOTE_EXISTS}; fi; exit 1; fi; fi; else if ! mv -n -T -- \"$source\" \"$target\" 2>/dev/null; then if [ -e \"$target\" ] || [ -L \"$target\" ]; then {REMOTE_EXISTS}; fi; dir=0; self_child=0; if [ -d \"$source\" ]; then dir=1; if [ -e \"$source/$name\" ] || [ -L \"$source/$name\" ]; then self_child=1; fi; fi; if ! mv -n -- \"$source\" \"$target\"; then if [ -e \"$target\" ] || [ -L \"$target\" ]; then {REMOTE_EXISTS}; fi; exit 1; fi; if [ \"$dir\" = 0 ]; then [ ! -d \"$target\" ] || {REMOTE_EXISTS}; elif [ \"$self_child\" = 0 ] && {{ [ -e \"$target/$name\" ] || [ -L \"$target/$name\" ]; }}; then {REMOTE_EXISTS}; fi; fi; if [ -e \"$source\" ] || [ -L \"$source\" ]; then {REMOTE_EXISTS}; fi; fi; if [ -d \"$target\" ]; then printf d; else printf f; fi",
        remote_prelude(root, &[from, to]),
        remote_enter(from, false),
        crate::ssh::quote(split(from).1),
        crate::ssh::quote(split(from).1),
        remote_enter(to, true),
        crate::ssh::quote(split(to).1),
        crate::ssh::quote(&match split(to).0 {
            "" => String::new(),
            directory => format!("{directory}/"),
        }),
    )
}

fn remote_delete_script(root: &str, path: &str) -> String {
    format!(
        "{}{}target=./{}; [ -e \"$target\" ] || [ -L \"$target\" ] || {REMOTE_NOT_FOUND}; [ ! -L \"$target\" ] || {REMOTE_SYMLINK}; rm -rf -- \"$target\"",
        remote_prelude(root, &[path]),
        remote_enter(path, false),
        crate::ssh::quote(split(path).1),
    )
}

fn remote_duplicate_script(root: &str, path: &str) -> String {
    let name = split(path).1;
    let candidates = |directory| {
        duplicate_names(name, directory)
            .map(|candidate| crate::ssh::quote(&candidate))
            .collect::<Vec<_>>()
            .join(" ")
    };
    // Each copy target is reserved atomically (`mkdir` / noclobber `O_EXCL`) before anything is copied
    // into it; a noclobber open that did not leave a plain regular file hit an existing non-regular name
    // and is reported before anything is written through it. Files are written through the reserving
    // descriptor; directories are filled from inside the reserved one once its physical path is confirmed,
    // so a swapped name cannot redirect the copy. A failed directory copy is made owner-writable (links not
    // followed) so it can be removed. Only `chmod` goes by path: a name swapped after the write can at worst
    // receive these bits.
    format!(
        "{}{}source=./{}; [ -e \"$source\" ] || [ -L \"$source\" ] || {REMOTE_NOT_FOUND}; [ ! -L \"$source\" ] || {REMOTE_SYMLINK}; if [ -d \"$source\" ]; then kind=d; set -- {}; elif [ -f \"$source\" ]; then kind=f; set -- {}; else printf 'SORENO_FILE_NOT_FILE\\n' >&2; exit 44; fi; bits() {{ case $1 in r*) printf r;; esac; case $1 in ?w?) printf w;; esac; case $1 in ??[xst]) printf x;; esac; }}; for name do target=\"./$name\"; if [ -e \"$target\" ] || [ -L \"$target\" ]; then continue; fi; if [ \"$kind\" = d ]; then if ! mkdir -- \"$target\"; then if [ -e \"$target\" ] || [ -L \"$target\" ]; then continue; fi; exit 1; fi; [ ! -L \"$target\" ] || {REMOTE_SYMLINK}; cd -P -- \"$target\"; copy=$(pwd -P && printf x); [ \"${{copy%?x}}\" = \"${{here%/}}/$name\" ] || {REMOTE_SYMLINK}; if ! cp -pRP -- \"../${{source#./}}/.\" .; then cd -P ..; find \"$target\" -type d -exec chmod u+rwx {{}} \\; || :; rm -rf -- \"$target\"; exit 1; fi; cd -P ..; else status=0; ( set -C; exec 3> \"$target\" || exit 93; [ -f \"$target\" ] && [ ! -L \"$target\" ] || exit 92; cat -- \"$source\" >&3 || exit 91 ) || status=$?; if [ \"$status\" = 92 ]; then {REMOTE_EXISTS}; elif [ \"$status\" = 91 ]; then rm -f -- \"$target\"; exit 1; elif [ \"$status\" != 0 ]; then if [ -e \"$target\" ] || [ -L \"$target\" ]; then continue; fi; exit 1; fi; perms=$(ls -ld -- \"$source\"); u=${{perms#?}}; g=${{u#???}}; o=${{g#???}}; u=${{u%\"$g\"}}; g=${{g%\"$o\"}}; o=${{o%\"${{o#???}}\"}}; [ -L \"$target\" ] || chmod -- \"u=$(bits \"$u\"),g=$(bits \"$g\"),o=$(bits \"$o\")\" \"$target\"; fi; printf '%s\\n%s' \"$kind\" \"$name\"; exit 0; done; {REMOTE_EXISTS}",
        remote_prelude(root, &[path]),
        remote_enter(path, false),
        crate::ssh::quote(name),
        candidates(true),
        candidates(false),
    )
}

fn remote_import_script(root: &str, path: &str) -> String {
    let candidates = import_names(split(path).1)
        .map(|candidate| crate::ssh::quote(&candidate))
        .collect::<Vec<_>>()
        .join(" ");
    // Same reservation as a duplicated file: stdin is written through the noclobber descriptor.
    // The relay runs under umask 077; a pasted file gets the usual 644 instead.
    format!(
        "{}{}set -- {candidates}; for name do target=\"./$name\"; if [ -e \"$target\" ] || [ -L \"$target\" ]; then continue; fi; status=0; ( set -C; exec 3> \"$target\" || exit 93; [ -f \"$target\" ] && [ ! -L \"$target\" ] || exit 92; cat >&3 || exit 91 ) || status=$?; if [ \"$status\" = 92 ]; then {REMOTE_EXISTS}; elif [ \"$status\" = 91 ]; then rm -f -- \"$target\"; exit 1; elif [ \"$status\" != 0 ]; then if [ -e \"$target\" ] || [ -L \"$target\" ]; then continue; fi; exit 1; fi; [ -L \"$target\" ] || chmod -- 644 \"$target\"; printf '%s' \"$name\"; exit 0; done; {REMOTE_EXISTS}",
        remote_prelude(root, &[split(path).0]),
        remote_enter(path, false),
    )
}

fn parse_remote_import(output: &[u8], name: &str) -> Result<String, ProjectFileError> {
    let output = std::str::from_utf8(output).map_err(|_| unexpected_remote_output())?;
    import_names(name)
        .find(|candidate| candidate == output)
        .ok_or_else(unexpected_remote_output)
}

fn parse_remote_duplicate(
    output: &[u8],
    name: &str,
) -> Result<(String, ProjectFileKind), ProjectFileError> {
    let output = std::str::from_utf8(output).map_err(|_| unexpected_remote_output())?;
    let (kind, copy) = match output.split_once('\n') {
        Some(("d", copy)) => (ProjectFileKind::Directory, copy),
        Some(("f", copy)) => (ProjectFileKind::File, copy),
        _ => return Err(unexpected_remote_output()),
    };
    if !duplicate_names(name, kind == ProjectFileKind::Directory).any(|candidate| candidate == copy)
    {
        return Err(unexpected_remote_output());
    }
    Ok((copy.to_owned(), kind))
}

/// Descriptor-based so swapped path components cannot redirect an operation outside the root.
#[cfg(unix)]
#[path = "operations/unix.rs"]
pub(super) mod unix;

/// Handle-based: every component is opened relative to its parent handle without following
/// reparse points, so a component swapped for a junction cannot redirect an operation.
#[cfg(windows)]
#[path = "operations/windows.rs"]
mod windows;

/// Path-based fallback for targets with neither directory descriptors nor Windows handles.
#[cfg(any(not(any(unix, windows)), test))]
#[path = "operations/portable.rs"]
mod portable;

#[cfg(test)]
#[path = "operations_tests.rs"]
mod tests;
