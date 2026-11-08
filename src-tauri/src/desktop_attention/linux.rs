use std::collections::HashMap;
use std::ffi::CString;
use std::sync::{Arc, Mutex, PoisonError};

use gdk::glib::prelude::*;
use gdk::glib::translate::from_glib;
use tauri::AppHandle;
use zbus::blocking::{Connection, Proxy};
use zbus::message::Message;
use zbus::zvariant::Value;

use super::{xml_escape, AgentNotification};

const DEFAULT_ACTION: &str = "default";

/// Called off the main thread with the session id and the xdg-activation token of the click.
pub(super) type ClickHandler = Box<dyn Fn(String, Option<String>) + Send>;

/// Notification still shown by the server.
pub(super) struct Shown {
    pub(super) session_id: String,
    pub(super) activation_token: Option<String>,
}

struct Notifier {
    proxy: Proxy<'static>,
    body_markup: bool,
    sessions: Mutex<HashMap<u32, Shown>>,
}

static NOTIFIER: Mutex<Option<Arc<Notifier>>> = Mutex::new(None);
static SESSION_BUS: Mutex<Option<Connection>> = Mutex::new(None);

/// Docks forget a launcher entry when its sender leaves the bus: the connection is kept.
fn session_bus() -> zbus::Result<Connection> {
    let mut slot = SESSION_BUS.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(connection) = slot.as_ref() {
        return Ok(connection.clone());
    }
    let connection = Connection::session()?;
    *slot = Some(connection.clone());
    Ok(connection)
}

/// Unity launcher API, read by KDE Plasma, Ubuntu Dock and Dash to Dock; tao only drives it
/// through libunity when the Unity shell itself runs.
pub(super) fn set_badge(app_name: &str, count: u32) -> Result<(), String> {
    let properties = HashMap::from([
        ("count", Value::from(i64::from(count))),
        ("count-visible", Value::from(count > 0)),
    ]);
    session_bus()
        .and_then(|connection| {
            connection.emit_signal(
                None::<&str>,
                "/com/soreno/notes/LauncherEntry",
                "com.canonical.Unity.LauncherEntry",
                "Update",
                &(format!("application://{app_name}.desktop"), properties),
            )
        })
        .map_err(|error| error.to_string())
}

/// `app_name` is also the desktop entry (`<productName>.desktop`) the bundler installs.
pub(super) fn show(
    app_name: &str,
    notification: &AgentNotification,
    on_click: impl FnOnce() -> ClickHandler,
) -> Result<(), String> {
    let notifier = notifier(on_click)
        .map_err(|error| format!("Service de notifications du bureau indisponible ({error})."))?;
    let body = if notifier.body_markup {
        xml_escape(&notification.body)
    } else {
        notification.body.clone()
    };
    let hints = HashMap::from([("desktop-entry", Value::from(app_name))]);
    // Held across the call so a close or click signal cannot be handled before the id is known.
    let mut sessions = notifier
        .sessions
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let id: u32 = notifier
        .proxy
        .call(
            "Notify",
            &(
                app_name,
                0u32,
                "",
                notification.title.as_str(),
                body.as_str(),
                [DEFAULT_ACTION, "Ouvrir"].as_slice(),
                hints,
                -1i32,
            ),
        )
        .map_err(|error| format!("Impossible d’afficher la notification ({error})."))?;
    sessions.insert(
        id,
        Shown {
            session_id: notification.session_id.clone(),
            activation_token: None,
        },
    );
    Ok(())
}

fn notifier(on_click: impl FnOnce() -> ClickHandler) -> zbus::Result<Arc<Notifier>> {
    let mut slot = NOTIFIER.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(notifier) = slot.as_ref() {
        return Ok(notifier.clone());
    }
    let proxy = Proxy::new(
        &session_bus()?,
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
    )?;
    let capabilities: Vec<String> = proxy.call("GetCapabilities", &())?;
    let signals = proxy.receive_all_signals()?;
    let notifier = Arc::new(Notifier {
        proxy,
        body_markup: capabilities.iter().any(|name| name == "body-markup"),
        sessions: Mutex::new(HashMap::new()),
    });
    let listener = notifier.clone();
    let on_click = on_click();
    std::thread::Builder::new()
        .name("soreno-notifications".into())
        .spawn(move || {
            for message in signals {
                if let Some((session_id, token)) = clicked_session(&listener.sessions, &message) {
                    on_click(session_id, token);
                }
            }
        })
        .map_err(|error| zbus::Error::Failure(error.to_string()))?;
    *slot = Some(notifier.clone());
    Ok(notifier)
}

/// Returns the session (and its activation token) when the signal is a click on one of our
/// notifications; servers send `ActivationToken` just before `ActionInvoked`.
pub(super) fn clicked_session(
    sessions: &Mutex<HashMap<u32, Shown>>,
    message: &Message,
) -> Option<(String, Option<String>)> {
    let header = message.header();
    let body = message.body();
    let mut sessions = sessions.lock().unwrap_or_else(PoisonError::into_inner);
    match header.member()?.as_str() {
        "ActivationToken" => {
            let (id, token): (u32, String) = body.deserialize().ok()?;
            if let Some(shown) = sessions.get_mut(&id) {
                shown.activation_token = Some(token);
            }
            None
        }
        "ActionInvoked" => {
            let (id, action): (u32, String) = body.deserialize().ok()?;
            let shown = sessions.remove(&id)?;
            (action == DEFAULT_ACTION).then_some((shown.session_id, shown.activation_token))
        }
        "NotificationClosed" => {
            sessions.remove(&body.deserialize::<(u32, u32)>().ok()?.0);
            None
        }
        _ => None,
    }
}

/// Hands the token to GDK (Wayland or X11) so the next `set_focus` activates the window; queued
/// on the main thread ahead of it.
pub(super) fn use_activation_token(app: &AppHandle, token: String) {
    let Ok(token) = CString::new(token) else {
        return;
    };
    let _ = app.run_on_main_thread(move || {
        let Some(display) = gdk::Display::default() else {
            return;
        };
        let wayland = unsafe { from_glib(gdk_wayland_sys::gdk_wayland_display_get_type()) };
        let x11 = unsafe { from_glib(gdk_x11_sys::gdk_x11_display_get_type()) };
        // SAFETY: each call matches the display's checked type and runs on the GTK main thread.
        if display.type_().is_a(wayland) {
            unsafe {
                gdk_wayland_sys::gdk_wayland_display_set_startup_notification_id(
                    display.as_ptr().cast(),
                    token.as_ptr(),
                );
            }
        } else if display.type_().is_a(x11) {
            // The `_TIME` suffix updates the display user time used by `present_with_time`.
            unsafe {
                gdk_x11_sys::gdk_x11_display_set_startup_notification_id(
                    display.as_ptr().cast(),
                    token.as_ptr(),
                );
            }
        }
    });
}
