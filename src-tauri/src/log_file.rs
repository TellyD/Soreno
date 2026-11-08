//! Append-only diagnostic files under the app log directory, rotated once.
use chrono::{SecondsFormat, Utc};
use std::{
    backtrace::Backtrace,
    fs::{self, OpenOptions},
    io::Write,
    panic,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
    thread,
};
use tauri::{AppHandle, Manager};

pub(crate) const CRASH_LOG_FILE: &str = "crash.log";
const LOG_LIMIT: u64 = 5 * 1024 * 1024;
static LOG: Mutex<()> = Mutex::new(());

pub(crate) fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

pub(crate) fn path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    directory(app).map(|directory| directory.join(name))
}

/// Release builds on Windows have no console: without this file a panic leaves no trace.
pub(crate) fn record_panics(path: PathBuf, version: String) {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let thread = thread::current();
        append(
            &path,
            &format!(
                "panic version={version} thread={} {info}\n{}",
                thread.name().unwrap_or("unnamed"),
                Backtrace::force_capture()
            ),
        );
        default_hook(info);
    }));
}

/// Best effort: diagnostics never fail the caller.
pub(crate) fn append(path: &Path, message: &str) {
    let line = format!(
        "{} {message}\n",
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    );
    let _guard = LOG.lock().unwrap_or_else(PoisonError::into_inner);
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() > LOG_LIMIT) {
        let rotated = path.with_extension("log.1");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(path, &rotated);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}
