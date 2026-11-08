use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs,
    iter::once,
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, PoisonError,
    },
};

use ::windows::{
    core::HSTRING,
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};
use windows_sys::Win32::{
    Foundation::ERROR_SUCCESS,
    System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    },
};

use super::{toast_xml, AgentNotification, ClickHandler};

const NOTIFICATION_ICON: &[u8] = include_bytes!("../../icons/128x128.png");
const MAX_TAG_LENGTH: usize = 64;

/// Toasts dropped from memory no longer raise `Activated`: keep each session's latest one alive.
static LIVE_TOASTS: Mutex<BTreeMap<String, ToastNotification>> = Mutex::new(BTreeMap::new());
static APP_ID_REGISTERED: AtomicBool = AtomicBool::new(false);

pub(super) struct AppIdentity<'a> {
    pub(super) id: &'a str,
    pub(super) name: &'a str,
    pub(super) data_dir: &'a Path,
}

pub(super) fn show(
    app: &AppIdentity,
    notification: &AgentNotification,
    on_click: ClickHandler,
) -> Result<(), String> {
    if !APP_ID_REGISTERED.load(Ordering::Acquire) {
        register_app_id(app)?;
        APP_ID_REGISTERED.store(true, Ordering::Release);
    }

    let document = XmlDocument::new().map_err(toast_error)?;
    document
        .LoadXml(&HSTRING::from(toast_xml(notification)))
        .map_err(toast_error)?;
    let toast = ToastNotification::CreateToastNotification(&document).map_err(toast_error)?;
    if notification.session_id.encode_utf16().count() <= MAX_TAG_LENGTH {
        toast
            .SetTag(&HSTRING::from(notification.session_id.as_str()))
            .map_err(toast_error)?;
    }
    let session_id = notification.session_id.clone();
    toast
        .Activated(&TypedEventHandler::new(move |_, _| {
            on_click(session_id.clone());
            Ok(())
        }))
        .map_err(toast_error)?;
    // Same-session toasts share a tag: show and keep under one lock so the live one is retained.
    let mut live = LIVE_TOASTS.lock().unwrap_or_else(PoisonError::into_inner);
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app.id))
        .and_then(|notifier| notifier.Show(&toast))
        .map_err(toast_error)?;
    live.insert(notification.session_id.clone(), toast);
    Ok(())
}

fn toast_error(error: ::windows::core::Error) -> String {
    format!("Notification Windows impossible : {}", error.message())
}

// Portable and `tauri dev` builds have no Start menu shortcut carrying the AUMID: without this
// per-user registration Windows silently drops their toasts.
fn register_app_id(app: &AppIdentity) -> Result<(), String> {
    let icon = app.data_dir.join("notification-icon.png");
    if fs::read(&icon).ok().as_deref() != Some(NOTIFICATION_ICON) {
        fs::create_dir_all(app.data_dir)
            .and_then(|()| fs::write(&icon, NOTIFICATION_ICON))
            .map_err(|error| format!("Icône de notification impossible à écrire : {error}"))?;
    }

    let key_path = wide(format!(r"Software\Classes\AppUserModelId\{}", app.id));
    let mut key: HKEY = null_mut();
    // SAFETY: valid NUL-terminated wide strings and out pointer; the key is closed below.
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            key_path.as_ptr(),
            0,
            null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            null(),
            &mut key,
            null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(registration_error(status));
    }
    let result = set_string_value(key, "DisplayName", OsStr::new(app.name))
        .and_then(|()| set_string_value(key, "IconUri", icon.as_os_str()));
    // SAFETY: `key` was opened by RegCreateKeyExW above.
    unsafe { RegCloseKey(key) };
    result
}

fn set_string_value(key: HKEY, name: &str, value: &OsStr) -> Result<(), String> {
    let name = wide(name);
    let data = wide(value);
    // SAFETY: `key` is open with KEY_SET_VALUE; `data` is a NUL-terminated REG_SZ buffer.
    let status = unsafe {
        RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * size_of::<u16>()) as u32,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(registration_error(status))
    }
}

fn registration_error(status: u32) -> String {
    format!("Enregistrement de Soreno pour les notifications impossible (code {status}).")
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(once(0)).collect()
}
