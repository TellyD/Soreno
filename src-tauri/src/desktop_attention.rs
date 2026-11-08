#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use std::sync::Arc;
use std::sync::{Mutex, PoisonError};

use serde::Deserialize;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use tauri::{AppHandle, Emitter, Manager};
use tauri::{UserAttentionType, WebviewWindow};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    not(any(windows, target_os = "macos", target_os = "linux")),
    allow(dead_code)
)]
pub(crate) struct AgentNotification {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) session_id: String,
}

pub(crate) const MAIN_WINDOW: &str = "main";

/// Session of the last clicked notification: a click can precede the frontend's listener.
static PENDING_ACTIVATION: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn take_activation() -> Option<String> {
    PENDING_ACTIVATION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
}

/// Called with the session id when the user clicks a notification, possibly off the main thread.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
type ClickHandler = Arc<dyn Fn(String) + Send + Sync>;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn click_handler(app: &AppHandle) -> ClickHandler {
    let app = app.clone();
    Arc::new(move |session_id| {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        *PENDING_ACTIVATION
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(session_id.clone());
        let _ = app.emit("agent-notification-activated", session_id);
    })
}

/// Must run during app setup: macOS only delivers clicks to a delegate set before launch completes.
#[cfg(target_os = "macos")]
pub(crate) fn init(app: &AppHandle) {
    macos::install_delegate(click_handler(app));
}

#[cfg(windows)]
pub(crate) fn show_notification(
    app: &AppHandle,
    notification: &AgentNotification,
) -> Result<(), String> {
    let identity = windows::AppIdentity {
        id: &app.config().identifier,
        name: &app.package_info().name,
        data_dir: &crate::app_state::app_data_dir(app)?,
    };
    windows::show(&identity, notification, click_handler(app))
}

#[cfg(target_os = "macos")]
pub(crate) fn show_notification(
    _app: &AppHandle,
    notification: &AgentNotification,
) -> Result<(), String> {
    macos::show(notification)
}

#[cfg(target_os = "linux")]
pub(crate) fn show_notification(
    app: &AppHandle,
    notification: &AgentNotification,
) -> Result<(), String> {
    linux::show(&app.package_info().name, notification, || {
        let app = app.clone();
        let open = click_handler(&app);
        Box::new(move |session_id, token| {
            if let Some(token) = token {
                linux::use_activation_token(&app, token);
            }
            open(session_id);
        })
    })
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) fn show_notification(
    _app: &tauri::AppHandle,
    _notification: &AgentNotification,
) -> Result<(), String> {
    Err("Notifications système indisponibles sur cette plateforme.".to_string())
}

/// Flashes the taskbar entry / bounces the dock icon once when Soreno is in the background.
pub(crate) fn request_attention(window: &WebviewWindow) -> Result<(), String> {
    let background =
        !window.is_focused().unwrap_or(false) || window.is_minimized().unwrap_or(false);
    if !background {
        return Ok(());
    }
    window
        .request_user_attention(Some(UserAttentionType::Informational))
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
pub(crate) fn set_badge(window: &WebviewWindow, count: u32) -> Result<(), String> {
    let icon = badge_label(count).map(|label| {
        tauri::image::Image::new_owned(badge_rgba(&label), BADGE_SIZE as u32, BADGE_SIZE as u32)
    });
    window
        .set_overlay_icon(icon)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
pub(crate) fn set_badge(window: &WebviewWindow, count: u32) -> Result<(), String> {
    linux::set_badge(&window.package_info().name, count)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_badge(window: &WebviewWindow, count: u32) -> Result<(), String> {
    window
        .set_badge_count((count > 0).then(|| i64::from(count)))
        .map_err(|error| error.to_string())
}

#[cfg(any(windows, test))]
fn toast_xml(notification: &AgentNotification) -> String {
    format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        xml_escape(&notification.title),
        xml_escape(&notification.body),
    )
}

#[cfg(any(windows, target_os = "linux", test))]
fn xml_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(any(windows, test))]
const BADGE_SIZE: usize = 32;

#[cfg(any(windows, test))]
fn badge_label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// 3x5 bitmap glyphs, one row per byte, most significant of the 3 bits on the left.
#[cfg(any(windows, test))]
fn badge_glyph(character: char) -> [u8; 5] {
    match character {
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0b111, 0b101, 0b101, 0b101, 0b111],
    }
}

/// Square RGBA overlay: anti-aliased red disc with the label drawn in white.
#[cfg(any(windows, test))]
fn badge_rgba(label: &str) -> Vec<u8> {
    const RED: [u8; 3] = [0xE5, 0x48, 0x4D];
    const SAMPLES: usize = 4;
    let mut rgba = vec![0; BADGE_SIZE * BADGE_SIZE * 4];
    let center = BADGE_SIZE as f32 / 2.0;
    for y in 0..BADGE_SIZE {
        for x in 0..BADGE_SIZE {
            let mut covered = 0;
            for sample_y in 0..SAMPLES {
                for sample_x in 0..SAMPLES {
                    let dx = x as f32 + (sample_x as f32 + 0.5) / SAMPLES as f32 - center;
                    let dy = y as f32 + (sample_y as f32 + 0.5) / SAMPLES as f32 - center;
                    if dx * dx + dy * dy <= center * center {
                        covered += 1;
                    }
                }
            }
            let pixel = (y * BADGE_SIZE + x) * 4;
            rgba[pixel..pixel + 3].copy_from_slice(&RED);
            rgba[pixel + 3] = (covered * 255 / (SAMPLES * SAMPLES)) as u8;
        }
    }

    let characters: Vec<char> = label.chars().collect();
    let scale = if characters.len() == 1 { 4 } else { 3 };
    let gap = scale;
    let width = characters.len() * 3 * scale + (characters.len() - 1) * gap;
    let left = (BADGE_SIZE - width) / 2;
    let top = (BADGE_SIZE - 5 * scale) / 2;
    for (index, character) in characters.into_iter().enumerate() {
        let glyph_left = left + index * (3 * scale + gap);
        for (row, bits) in badge_glyph(character).into_iter().enumerate() {
            for column in 0..3 {
                if bits & (0b100 >> column) == 0 {
                    continue;
                }
                for y in top + row * scale..top + (row + 1) * scale {
                    for x in glyph_left + column * scale..glyph_left + (column + 1) * scale {
                        let pixel = (y * BADGE_SIZE + x) * 4;
                        rgba[pixel..pixel + 4].copy_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
                    }
                }
            }
        }
    }
    rgba
}

#[cfg(test)]
#[path = "desktop_attention_tests.rs"]
mod tests;
