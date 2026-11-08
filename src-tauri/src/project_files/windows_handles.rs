use super::{file_io_error, invalid_path, ProjectFileError, TEMP_COUNTER};
use std::{
    fs::{self, File, OpenOptions},
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle},
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};

pub(super) fn open_windows_root(root: &Path) -> Result<(File, PathBuf), ProjectFileError> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

    let canonical = fs::canonicalize(root).map_err(|error| file_io_error("projet", error))?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(&canonical)
        .map_err(|error| file_io_error("projet", error))?;
    if !file
        .metadata()
        .map_err(|error| file_io_error("projet", error))?
        .is_dir()
    {
        return Err(ProjectFileError::new(
            "notDirectory",
            "Le dossier du projet n’est pas un dossier.",
        ));
    }
    let final_path = windows_final_path(&file).map_err(|error| file_io_error("projet", error))?;
    if final_path != canonical {
        return Err(invalid_path());
    }
    Ok((file, final_path))
}

pub(super) fn open_windows_parent<'a>(
    root: &File,
    root_path: &Path,
    relative: &'a str,
) -> Result<(File, &'a str), ProjectFileError> {
    let mut parts = relative.split('/').peekable();
    let mut parent = root
        .try_clone()
        .map_err(|error| file_io_error("projet", error))?;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((parent, part));
        }
        let next = open_windows_relative(&parent, part, true, false)
            .map_err(|error| file_io_error(relative, error))?;
        reject_windows_reparse_point(&next)?;
        ensure_windows_handle_in_root(&next, root_path)?;
        parent = next;
    }
    Err(invalid_path())
}

pub(super) fn open_windows_relative(
    parent: &File,
    name: &str,
    directory: bool,
    create: bool,
) -> std::io::Result<File> {
    use windows_sys::{
        Wdk::Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
        },
        Win32::{
            Foundation::{GENERIC_READ, GENERIC_WRITE},
            Storage::FileSystem::{DELETE, SYNCHRONIZE},
        },
    };

    let access = if create {
        GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE
    } else {
        GENERIC_READ | SYNCHRONIZE
    };
    open_windows_at(
        parent,
        std::ffi::OsStr::new(name),
        access,
        if create { FILE_CREATE } else { FILE_OPEN },
        if directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        },
    )
}

/// Opens `name` relative to `parent`; a final reparse point is opened itself, never followed.
pub(super) fn open_windows_at(
    parent: &File,
    name: &std::ffi::OsStr,
    access: u32,
    disposition: u32,
    options: u32,
) -> std::io::Result<File> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::{
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                NtCreateFile, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
            },
        },
        Win32::{
            Foundation::{RtlNtStatusToDosError, OBJ_CASE_INSENSITIVE, UNICODE_STRING},
            Storage::FileSystem::{
                FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };

    let mut name: Vec<u16> = name.encode_wide().collect();
    let unicode_name = UNICODE_STRING {
        Length: (name.len() * size_of::<u16>()) as u16,
        MaximumLength: (name.len() * size_of::<u16>()) as u16,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &unicode_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle = std::ptr::null_mut();
    let mut status_block = IO_STATUS_BLOCK::default();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut status_block,
            std::ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        Err(std::io::Error::from_raw_os_error(unsafe {
            RtlNtStatusToDosError(status) as i32
        }))
    } else {
        Ok(unsafe { File::from_raw_handle(handle) })
    }
}

pub(super) fn create_windows_temp(parent: &File, path: &str) -> Result<File, ProjectFileError> {
    for _ in 0..128 {
        let name = format!(
            ".soreno-{}-{}.tmp",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        match open_windows_relative(parent, &name, false, true) {
            Ok(file) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(file_io_error(path, error)),
        }
    }
    Err(file_io_error(
        path,
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "impossible de créer un fichier temporaire unique",
        ),
    ))
}

pub(super) fn reject_windows_reparse_point(file: &File) -> Result<(), ProjectFileError> {
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ATTRIBUTE_TAG_INFO,
    };

    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(file_io_error("chemin", std::io::Error::last_os_error()));
    }
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Err(ProjectFileError::new(
            "symlink",
            "Les liens symboliques et jonctions ne sont pas accessibles depuis l’explorateur.",
        ))
    } else {
        Ok(())
    }
}

fn windows_final_path(file: &File) -> std::io::Result<PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        if length == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if (length as usize) < buffer.len() {
            buffer.truncate(length as usize);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(length as usize + 1, 0);
    }
}

pub(super) fn ensure_windows_handle_in_root(
    file: &File,
    root: &Path,
) -> Result<(), ProjectFileError> {
    let path = windows_final_path(file).map_err(|error| file_io_error("chemin", error))?;
    if path.starts_with(root) {
        Ok(())
    } else {
        Err(invalid_path())
    }
}

pub(super) fn rename_windows_file(
    file: &File,
    parent: &File,
    name: &str,
    replace: bool,
) -> std::io::Result<()> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::{
        Wdk::Storage::FileSystem::{
            FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
        },
        Win32::{Foundation::RtlNtStatusToDosError, System::IO::IO_STATUS_BLOCK},
    };

    let name: Vec<u16> = OsStr::new(name).encode_wide().collect();
    let byte_len = size_of::<FILE_RENAME_INFORMATION>() + name.len() * size_of::<u16>();
    let mut buffer = vec![0usize; byte_len.div_ceil(size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = replace;
        (*info).RootDirectory = parent.as_raw_handle();
        (*info).FileNameLength = (name.len() * size_of::<u16>()) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            name.len(),
        );
    }
    let mut status_block = IO_STATUS_BLOCK::default();
    let status = unsafe {
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut status_block,
            info.cast(),
            byte_len as u32,
            FileRenameInformation,
        )
    };
    if status < 0 {
        Err(std::io::Error::from_raw_os_error(unsafe {
            RtlNtStatusToDosError(status) as i32
        }))
    } else {
        Ok(())
    }
}

pub(super) fn delete_windows_file(file: &File) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };

    if let Ok(metadata) = file.metadata() {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        let _ = file.set_permissions(permissions);
    }
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
