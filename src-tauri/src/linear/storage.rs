use super::{parse_stored_workspaces, request_failed, Result, StoredWorkspace};
use std::sync::{Mutex, MutexGuard, PoisonError};

#[cfg(windows)]
const KEYRING_TARGET: &str = "soreno.linear_api_key";
const KEYRING_SERVICE: &str = "soreno";
const KEYRING_ACCOUNT: &str = "linear_api_key";
// A keychain read can prompt on macOS, so the keys are read at most once per session;
// holding the lock across that read keeps concurrent first calls to a single prompt.
static WORKSPACES: Mutex<Option<Vec<StoredWorkspace>>> = Mutex::new(None);

pub(super) fn stored_workspaces() -> Result<Vec<StoredWorkspace>> {
    load_workspaces(&mut cached_workspaces())
}

pub(super) fn load_workspaces(
    cached: &mut Option<Vec<StoredWorkspace>>,
) -> Result<Vec<StoredWorkspace>> {
    if let Some(workspaces) = cached.as_ref() {
        return Ok(workspaces.clone());
    }
    let workspaces = read_stored_workspaces()?;
    *cached = Some(workspaces.clone());
    Ok(workspaces)
}

pub(super) fn cached_workspaces() -> MutexGuard<'static, Option<Vec<StoredWorkspace>>> {
    WORKSPACES.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read_stored_workspaces() -> Result<Vec<StoredWorkspace>> {
    match keyring_entry()?.get_password() {
        Ok(stored) => Ok(parse_stored_workspaces(&stored)),
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(error) => Err(request_failed(format!(
            "Impossible de lire la clé d’API Linear ({}).",
            storage_detail(&error)
        ))),
    }
}

// shortcut: all keys share one keychain entry (a single unlock prompt), which Windows caps at 1280 characters, about 9 workspaces; split it per workspace if users reach that.
pub(super) fn store_workspaces(
    cached: &mut Option<Vec<StoredWorkspace>>,
    workspaces: Vec<StoredWorkspace>,
) -> Result<()> {
    *cached = None;
    let entry = keyring_entry()?;
    if workspaces.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(request_failed(format!(
                    "Impossible de supprimer la clé d’API Linear ({}).",
                    storage_detail(&error)
                )))
            }
        }
    } else {
        let stored = serde_json::to_string(&workspaces).map_err(request_failed)?;
        entry.set_password(&stored).map_err(|error| {
            request_failed(format!(
                "Impossible d’enregistrer la clé d’API Linear ({}).",
                storage_detail(&error)
            ))
        })?;
        if read_stored_workspaces()? != workspaces {
            return Err(request_failed(
                "La clé d’API Linear enregistrée n’a pas pu être vérifiée.",
            ));
        }
    }
    *cached = Some(workspaces);
    Ok(())
}

fn keyring_entry() -> Result<keyring::Entry> {
    // macOS reads `target` as a keychain domain (User/System/…) and the Secret Service as a
    // collection to create: only the Windows credential manager takes it as a name.
    #[cfg(not(windows))]
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT);
    #[cfg(windows)]
    let entry = keyring::Entry::new_with_target(KEYRING_TARGET, KEYRING_SERVICE, KEYRING_ACCOUNT);
    entry.map_err(|error| {
        request_failed(format!(
            "Impossible d’ouvrir le stockage sécurisé ({error})."
        ))
    })
}

fn storage_detail(error: &keyring::Error) -> String {
    #[cfg(target_os = "linux")]
    if matches!(
        error,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    ) {
        return format!(
            "aucun trousseau Secret Service accessible : installez ou déverrouillez GNOME Keyring ou KWallet. {error}"
        );
    }
    error.to_string()
}
