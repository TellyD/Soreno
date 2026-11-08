use super::{
    duplicate_names, exists, import_names, io_error, not_file, split, symlink_error,
    ProjectFileKind,
};
use crate::project_files::{file_io_error, ProjectFileError};
use std::{
    ffi::{CStr, CString},
    fs::{self, File, OpenOptions},
    io,
    os::unix::{
        fs::OpenOptionsExt,
        io::{AsRawFd, FromRawFd},
    },
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

const DIRECTORY_FLAGS: i32 =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
const READ_FLAGS: i32 = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
const CREATE_FLAGS: i32 =
    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;

pub(super) fn create(
    root: &Path,
    path: &str,
    kind: ProjectFileKind,
) -> Result<(), ProjectFileError> {
    let (parent, name) = open_parent(root, path, true)?;
    match kind {
        ProjectFileKind::File => open_at(&parent, &name, CREATE_FLAGS, 0o666).map(drop),
        ProjectFileKind::Directory => make_directory(&parent, &name, 0o777),
    }
    .map_err(|error| io_error(path, error))
}

pub(super) fn rename(
    root: &Path,
    from: &str,
    to: &str,
) -> Result<ProjectFileKind, ProjectFileError> {
    let (source_parent, source_name) = open_parent(root, from, false)?;
    let source = existing(&source_parent, &source_name, from)?;
    let (target_parent, target_name) = open_parent(root, to, true)?;
    let same_file = match lstat(&target_parent, &target_name) {
        Ok(target) if target.st_dev == source.st_dev && target.st_ino == source.st_ino => true,
        Ok(_) => return Err(exists()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(io_error(to, error)),
    };
    if same_file {
        // `renameat` between links to one file is a no-op that would still report success, so only
        // an alias of the source entry itself (case or Unicode normalization variant on an
        // insensitive filesystem) is renamed; the probe tells it from a distinct hard link.
        if !same_directory(&source_parent, &target_parent).map_err(|error| io_error(to, error))? {
            return Err(exists());
        }
        probe_alias_rename(
            &SameDirectory {
                parent: &source_parent,
                directory: file_type(&source) == libc::S_IFDIR,
                path: to,
            },
            &source_name,
            &target_name,
            to,
        )?;
    } else {
        rename_no_replace(
            &source_parent,
            &source_name,
            &target_parent,
            &target_name,
            file_type(&source) == libc::S_IFDIR,
            to,
        )?;
    }
    Ok(kind_of(&source))
}

pub(super) fn delete(root: &Path, path: &str) -> Result<(), ProjectFileError> {
    let (parent, name) = open_parent(root, path, false)?;
    let target = existing(&parent, &name, path)?;
    if file_type(&target) == libc::S_IFDIR {
        remove_tree(&parent, &name, false)
    } else {
        check(unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) })
    }
    .map_err(|error| io_error(path, error))
}

pub(super) fn duplicate(
    root: &Path,
    path: &str,
) -> Result<(String, ProjectFileKind), ProjectFileError> {
    let (parent, name) = open_parent(root, path, false)?;
    let source = existing(&parent, &name, path)?;
    let base = split(path).1;
    match file_type(&source) {
        libc::S_IFDIR => {
            let source_directory = open_at(&parent, &name, DIRECTORY_FLAGS, 0)
                .map_err(|error| io_error(path, error))?;
            for candidate in duplicate_names(base, true) {
                let target_name = c_name(&candidate);
                match make_directory(&parent, &target_name, 0o700) {
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(io_error(path, error)),
                    Ok(()) => {}
                }
                let copied =
                    open_at(&parent, &target_name, DIRECTORY_FLAGS, 0).and_then(|target| {
                        copy_tree(&source_directory, &target)?;
                        set_mode(&target, source.st_mode)
                    });
                if let Err(error) = copied {
                    let _ = remove_tree(&parent, &target_name, true);
                    return Err(io_error(path, error));
                }
                return Ok((candidate, ProjectFileKind::Directory));
            }
        }
        libc::S_IFREG => {
            let mut source_file =
                open_at(&parent, &name, READ_FLAGS, 0).map_err(|error| io_error(path, error))?;
            if !source_file
                .metadata()
                .map_err(|error| file_io_error(path, error))?
                .is_file()
            {
                return Err(not_file());
            }
            for candidate in duplicate_names(base, false) {
                let target_name = c_name(&candidate);
                let target = match open_at(&parent, &target_name, CREATE_FLAGS, 0o600) {
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(io_error(path, error)),
                    Ok(target) => target,
                };
                if let Err(error) = copy_file(&mut source_file, target, source.st_mode) {
                    unsafe { libc::unlinkat(parent.as_raw_fd(), target_name.as_ptr(), 0) };
                    return Err(io_error(path, error));
                }
                return Ok((candidate, ProjectFileKind::File));
            }
        }
        _ => return Err(not_file()),
    }
    Err(exists())
}

pub(super) fn import(
    root: &Path,
    path: &str,
    source: &mut File,
) -> Result<String, ProjectFileError> {
    let (parent, _) = open_parent(root, path, false)?;
    for candidate in import_names(split(path).1) {
        let target_name = c_name(&candidate);
        let target = match open_at(&parent, &target_name, CREATE_FLAGS, 0o666) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(path, error)),
            Ok(target) => target,
        };
        if let Err(error) = io::copy(source, &mut &target) {
            unsafe { libc::unlinkat(parent.as_raw_fd(), target_name.as_ptr(), 0) };
            return Err(io_error(path, error));
        }
        return Ok(candidate);
    }
    Err(exists())
}

pub(in crate::project_files) fn c_name(name: &str) -> CString {
    CString::new(name).expect("validated names contain no NUL byte")
}

fn check(result: libc::c_int) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(in crate::project_files) fn open_at(
    parent: &File,
    name: &CStr,
    flags: i32,
    mode: libc::c_uint,
) -> io::Result<File> {
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, mode) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn make_directory(parent: &File, name: &CStr, mode: libc::mode_t) -> io::Result<()> {
    check(unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), mode) })
}

fn lstat(parent: &File, name: &CStr) -> io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    check(unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    })?;
    Ok(unsafe { stat.assume_init() })
}

fn file_type(stat: &libc::stat) -> libc::mode_t {
    stat.st_mode & libc::S_IFMT
}

fn kind_of(stat: &libc::stat) -> ProjectFileKind {
    if file_type(stat) == libc::S_IFDIR {
        ProjectFileKind::Directory
    } else {
        ProjectFileKind::File
    }
}

fn set_mode(file: &File, mode: libc::mode_t) -> io::Result<()> {
    check(unsafe { libc::fchmod(file.as_raw_fd(), mode & 0o7777) })
}

fn same_directory(first: &File, second: &File) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let (first, second) = (first.metadata()?, second.metadata()?);
    Ok(first.dev() == second.dev() && first.ino() == second.ino())
}

pub(in crate::project_files) fn open_root(root: &Path) -> Result<File, ProjectFileError> {
    let canonical_root = fs::canonicalize(root).map_err(|error| file_io_error("projet", error))?;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&canonical_root)
        .map_err(|error| file_io_error("projet", error))
}

fn open_parent(root: &Path, path: &str, create: bool) -> Result<(File, CString), ProjectFileError> {
    let mut parent = open_root(root)?;
    let (directory, name) = split(path);
    for part in directory.split('/').filter(|part| !part.is_empty()) {
        parent = enter(&parent, &c_name(part), create).map_err(|error| io_error(path, error))?;
    }
    Ok((parent, c_name(name)))
}

fn enter(parent: &File, name: &CStr, create: bool) -> io::Result<File> {
    match lstat(parent, name) {
        Ok(stat) => ensure_directory(&stat)?,
        Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
            match make_directory(parent, name, 0o777) {
                Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error),
                _ => ensure_directory(&lstat(parent, name)?)?,
            }
        }
        Err(error) => return Err(error),
    }
    open_at(parent, name, DIRECTORY_FLAGS, 0)
}

fn ensure_directory(stat: &libc::stat) -> io::Result<()> {
    match file_type(stat) {
        libc::S_IFDIR => Ok(()),
        libc::S_IFLNK => Err(io::Error::from_raw_os_error(libc::ELOOP)),
        _ => Err(io::Error::from_raw_os_error(libc::ENOTDIR)),
    }
}

fn existing(parent: &File, name: &CStr, path: &str) -> Result<libc::stat, ProjectFileError> {
    let stat = lstat(parent, name).map_err(|error| io_error(path, error))?;
    if file_type(&stat) == libc::S_IFLNK {
        return Err(symlink_error());
    }
    Ok(stat)
}

fn rename_no_replace(
    source_parent: &File,
    source: &CStr,
    target_parent: &File,
    target: &CStr,
    directory: bool,
    path: &str,
) -> Result<(), ProjectFileError> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent.as_raw_fd(),
            source.as_ptr(),
            target_parent.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE as libc::c_uint,
        ) as libc::c_int
    };
    #[cfg(target_vendor = "apple")]
    let result = unsafe {
        libc::renameatx_np(
            source_parent.as_raw_fd(),
            source.as_ptr(),
            target_parent.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    {
        let error = match check(result) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        let unsupported = error.raw_os_error().is_some_and(|code| {
            code == libc::EINVAL
                || code == libc::ENOSYS
                || code == libc::ENOTSUP
                || code == libc::EOPNOTSUPP
        });
        if !unsupported {
            return Err(io_error(path, error));
        }
    }
    fallback_rename(
        &RenameAt {
            source_parent,
            source,
            target_parent,
            target,
        },
        directory,
        path,
    )
}

/// Primitives of the rename fallback for kernels or filesystems lacking an atomic no-replace rename.
pub(super) trait RenamePrimitives {
    fn link(&self) -> io::Result<()>;
    fn unlink_source(&self) -> io::Result<()>;
    fn unlink_target(&self);
    fn target_exists(&self) -> io::Result<bool>;
    fn rename(&self) -> io::Result<()>;
}

struct RenameAt<'a> {
    source_parent: &'a File,
    source: &'a CStr,
    target_parent: &'a File,
    target: &'a CStr,
}

impl RenamePrimitives for RenameAt<'_> {
    fn link(&self) -> io::Result<()> {
        check(unsafe {
            libc::linkat(
                self.source_parent.as_raw_fd(),
                self.source.as_ptr(),
                self.target_parent.as_raw_fd(),
                self.target.as_ptr(),
                0,
            )
        })
    }

    fn unlink_source(&self) -> io::Result<()> {
        check(unsafe { libc::unlinkat(self.source_parent.as_raw_fd(), self.source.as_ptr(), 0) })
    }

    fn unlink_target(&self) {
        unsafe { libc::unlinkat(self.target_parent.as_raw_fd(), self.target.as_ptr(), 0) };
    }

    fn target_exists(&self) -> io::Result<bool> {
        resolves(self.target_parent, self.target)
    }

    fn rename(&self) -> io::Result<()> {
        check(unsafe {
            libc::renameat(
                self.source_parent.as_raw_fd(),
                self.source.as_ptr(),
                self.target_parent.as_raw_fd(),
                self.target.as_ptr(),
            )
        })
    }
}

pub(super) fn fallback_rename(
    at: &impl RenamePrimitives,
    directory: bool,
    path: &str,
) -> Result<(), ProjectFileError> {
    if !directory {
        // `linkat` fails atomically on an existing target; without it no rename of a file is
        // safe from a destination created concurrently, so refuse instead of replacing it.
        return match at.link() {
            Ok(()) => at.unlink_source().map_err(|error| {
                at.unlink_target();
                io_error(path, error)
            }),
            Err(error)
                if error.raw_os_error().is_some_and(|code| {
                    code == libc::EPERM || code == libc::ENOTSUP || code == libc::EOPNOTSUPP
                }) =>
            {
                Err(ProjectFileError::new(
                    "io",
                    "Ce système de fichiers ne permet pas de renommer sans risquer d’écraser la destination.",
                ))
            }
            Err(error) => Err(io_error(path, error)),
        };
    }
    // Check-then-rename: a directory rename can at worst replace an empty directory,
    // never a file (ENOTDIR) or a non-empty directory (ENOTEMPTY).
    match at.target_exists() {
        Ok(true) => Err(exists()),
        Ok(false) => at.rename().map_err(|error| io_error(path, error)),
        Err(error) => Err(io_error(path, error)),
    }
}

fn entries(directory: &File) -> io::Result<Vec<CString>> {
    // fdopendir owns its descriptor, so iterate a duplicate and keep `directory` usable.
    let fd = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe { libc::close(fd) };
        return Err(error);
    }
    let mut names = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name != c"." && name != c".." {
            names.push(name.to_owned());
        }
    }
    unsafe { libc::closedir(stream) };
    Ok(names)
}

fn resolves(parent: &File, name: &CStr) -> io::Result<bool> {
    match lstat(parent, name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Primitives of the same-inode rename probe, all within one directory.
pub(super) trait AliasPrimitives {
    /// Renames `from` to `to` without ever replacing an entry resolving as `to`.
    fn move_entry(&self, from: &CStr, to: &CStr) -> Result<(), ProjectFileError>;
    fn resolves(&self, name: &CStr) -> io::Result<bool>;
}

struct SameDirectory<'a> {
    parent: &'a File,
    directory: bool,
    path: &'a str,
}

impl AliasPrimitives for SameDirectory<'_> {
    fn move_entry(&self, from: &CStr, to: &CStr) -> Result<(), ProjectFileError> {
        rename_no_replace(
            self.parent,
            from,
            self.parent,
            to,
            self.directory,
            self.path,
        )
    }

    fn resolves(&self, name: &CStr) -> io::Result<bool> {
        resolves(self.parent, name)
    }
}

static PROBE_COUNTER: AtomicU64 = AtomicU64::new(0);
const PROBE_ATTEMPTS: usize = 100;

/// Renames `source` to `target` when both names resolve to one inode in the same directory:
/// the source is moved aside under a fresh temporary name, then `target` still resolving means a
/// distinct entry (hard link), so the source is restored and `exists` returned; otherwise
/// `target` was an alias of the source entry and the temporary takes the target name.
pub(super) fn probe_alias_rename(
    at: &impl AliasPrimitives,
    source: &CStr,
    target: &CStr,
    path: &str,
) -> Result<(), ProjectFileError> {
    let (temporary_name, temporary) = move_aside(at, source)?;
    let (destination, outcome) = match at.resolves(target) {
        Ok(false) => (target, Ok(())),
        Ok(true) => (source, Err(exists())),
        Err(error) => (source, Err(io_error(path, error))),
    };
    at.move_entry(&temporary, destination).map_err(|_| {
        let temporary_path = match split(path).0 {
            "" => temporary_name,
            directory => format!("{directory}/{temporary_name}"),
        };
        ProjectFileError::new("stranded", temporary_path)
    })?;
    outcome
}

fn move_aside(
    at: &impl AliasPrimitives,
    source: &CStr,
) -> Result<(String, CString), ProjectFileError> {
    for _ in 0..PROBE_ATTEMPTS {
        let name = format!(
            ".soreno-rename-{}-{}",
            std::process::id(),
            PROBE_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let temporary = c_name(&name);
        match at.move_entry(source, &temporary) {
            Ok(()) => return Ok((name, temporary)),
            Err(error) if error.code == "exists" => continue,
            Err(error) => return Err(error),
        }
    }
    Err(exists())
}

/// `unlock` first gives each directory back owner rwx (before opening it, so a mode without owner
/// read cannot block enumeration), so a copy that took restrictive modes from its source can still
/// be rolled back. Only used inside our own freshly created copy.
pub(super) fn remove_tree(parent: &File, name: &CStr, unlock: bool) -> io::Result<()> {
    {
        if unlock && file_type(&lstat(parent, name)?) == libc::S_IFDIR {
            check(unsafe { libc::fchmodat(parent.as_raw_fd(), name.as_ptr(), 0o700, 0) })?;
        }
        let directory = open_at(parent, name, DIRECTORY_FLAGS, 0)?;
        for entry in entries(&directory)? {
            if file_type(&lstat(&directory, &entry)?) == libc::S_IFDIR {
                remove_tree(&directory, &entry, unlock)?;
            } else {
                check(unsafe { libc::unlinkat(directory.as_raw_fd(), entry.as_ptr(), 0) })?;
            }
        }
    }
    check(unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) })
}

fn copy_file(source: &mut File, mut target: File, mode: libc::mode_t) -> io::Result<()> {
    io::copy(source, &mut target)?;
    set_mode(&target, mode)
}

fn copy_tree(source: &File, target: &File) -> io::Result<()> {
    for entry in entries(source)? {
        let stat = lstat(source, &entry)?;
        match file_type(&stat) {
            libc::S_IFDIR => {
                make_directory(target, &entry, 0o700)?;
                let source_directory = open_at(source, &entry, DIRECTORY_FLAGS, 0)?;
                let target_directory = open_at(target, &entry, DIRECTORY_FLAGS, 0)?;
                copy_tree(&source_directory, &target_directory)?;
                set_mode(&target_directory, stat.st_mode)?;
            }
            libc::S_IFREG => {
                let mut source_file = open_at(source, &entry, READ_FLAGS, 0)?;
                let target_file = open_at(target, &entry, CREATE_FLAGS, 0o600)?;
                copy_file(&mut source_file, target_file, stat.st_mode)?;
            }
            libc::S_IFLNK => {
                let link = read_link(source, &entry)?;
                check(unsafe {
                    libc::symlinkat(link.as_ptr(), target.as_raw_fd(), entry.as_ptr())
                })?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn read_link(parent: &File, name: &CStr) -> io::Result<CString> {
    let mut buffer = vec![0_u8; 256];
    loop {
        let length = unsafe {
            libc::readlinkat(
                parent.as_raw_fd(),
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
            )
        };
        if length < 0 {
            return Err(io::Error::last_os_error());
        }
        let length = length as usize;
        if length < buffer.len() {
            buffer.truncate(length);
            return CString::new(buffer)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        }
        buffer.resize(buffer.len() * 2, 0);
    }
}
