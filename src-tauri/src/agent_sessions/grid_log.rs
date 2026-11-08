//! Grid engine diagnostics: one append-only file shared by every session.
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

static ENABLED: AtomicBool = AtomicBool::new(false);

pub(crate) fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub(crate) fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Best effort: diagnostics never fail the terminal.
pub(crate) fn append(path: &Path, session_id: &str, message: &str) {
    if enabled() {
        crate::log_file::append(path, &format!("session={session_id} {message}"));
    }
}
