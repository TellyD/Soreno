use std::{os::windows::ffi::OsStrExt, path::Path, sync::OnceLock};
use windows_sys::Win32::{
    Foundation::FreeLibrary,
    System::LibraryLoader::{
        GetModuleHandleW, GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
    },
};

#[cfg(target_arch = "x86_64")]
const ARCH: &str = "x64";
#[cfg(target_arch = "aarch64")]
const ARCH: &str = "arm64";
#[cfg(target_arch = "x86")]
const ARCH: &str = "x86";
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "x86")))]
compile_error!("Packaged ConPTY is unavailable for this Windows architecture");

static CONPTY: OnceLock<Result<usize, String>> = OnceLock::new();

pub(super) fn ensure_loaded() -> Result<(), String> {
    CONPTY
        .get_or_init(|| {
            let executable = std::env::current_exe()
                .map_err(|error| format!("Impossible de localiser l’exécutable : {error}"))?;
            let directory = executable
                .parent()
                .ok_or("L’exécutable n’a pas de dossier parent.")?
                .join("conpty")
                .join(ARCH);
            load_from(&directory)
        })
        .as_ref()
        .map(|_| ())
        .map_err(Clone::clone)
}

pub(super) fn load_from(directory: &Path) -> Result<usize, String> {
    if !directory.is_absolute() {
        return Err(format!(
            "Le dossier ConPTY doit être absolu : {}",
            directory.display()
        ));
    }
    let dll = directory.join("conpty.dll");
    let host = directory.join("OpenConsole.exe");
    if !dll.is_file() {
        return Err(format!(
            "Ressource ConPTY absente ou invalide : {}",
            dll.display()
        ));
    }
    if !host.is_file() {
        return Err(format!(
            "Hôte ConPTY absent ou invalide : {}",
            host.display()
        ));
    }

    let dll_wide: Vec<u16> = dll.as_os_str().encode_wide().chain([0]).collect();
    let module_name: Vec<u16> = "conpty.dll".encode_utf16().chain([0]).collect();
    // The successful handle is intentionally retained for the process lifetime:
    // portable-pty resolves conpty.dll by name and must reuse this exact module.
    unsafe {
        let handle = LoadLibraryExW(
            dll_wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        );
        if handle.is_null() {
            return Err(format!(
                "Impossible de charger la ressource ConPTY {} : {}",
                dll.display(),
                std::io::Error::last_os_error()
            ));
        }
        for export in [
            &b"CreatePseudoConsole\0"[..],
            &b"ResizePseudoConsole\0"[..],
            &b"ClosePseudoConsole\0"[..],
        ] {
            if GetProcAddress(handle, export.as_ptr()).is_none() {
                FreeLibrary(handle);
                return Err(format!(
                    "Ressource ConPTY invalide : export {} absent de {}",
                    String::from_utf8_lossy(&export[..export.len() - 1]),
                    dll.display()
                ));
            }
        }
        let named_handle = GetModuleHandleW(module_name.as_ptr());
        if named_handle.is_null() || named_handle != handle {
            FreeLibrary(handle);
            return Err(format!(
                "Conflit de chargement ConPTY : {} n’est pas le module résolu par nom.",
                dll.display()
            ));
        }
        Ok(handle as usize)
    }
}
