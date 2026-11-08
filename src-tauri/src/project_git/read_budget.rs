use super::GitError;
use std::{
    cell::Cell,
    time::{Duration, Instant},
};

thread_local! {
    pub(super) static READ_DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

struct ReadDeadlineGuard(Option<Instant>);

impl Drop for ReadDeadlineGuard {
    fn drop(&mut self) {
        READ_DEADLINE.with(|deadline| deadline.set(self.0));
    }
}

pub(super) fn read_timeout_error() -> GitError {
    GitError::new(
        "timeout",
        "La lecture Git complète a dépassé son délai global de 30 secondes.",
    )
}

pub(super) fn read_deadline() -> Option<Instant> {
    READ_DEADLINE.with(Cell::get)
}

pub(super) fn bounded_by_read_deadline(
    read_deadline: Option<Instant>,
    command_deadline: Instant,
) -> (Instant, bool) {
    match read_deadline {
        Some(deadline) if deadline <= command_deadline => (deadline, true),
        _ => (command_deadline, false),
    }
}

pub(super) fn check_read_deadline() -> Result<(), GitError> {
    if read_deadline().is_some_and(|deadline| Instant::now() >= deadline) {
        Err(read_timeout_error())
    } else {
        Ok(())
    }
}

pub(super) fn with_read_budget<T>(
    duration: Duration,
    read: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    let deadline = Instant::now() + duration;
    let deadline = read_deadline().map_or(deadline, |existing| existing.min(deadline));
    with_read_deadline(deadline, read)
}

pub(super) fn with_read_deadline<T>(
    deadline: Instant,
    read: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    let previous = READ_DEADLINE.with(|current| current.replace(Some(deadline)));
    let _guard = ReadDeadlineGuard(previous);
    check_read_deadline()?;
    let value = read()?;
    check_read_deadline()?;
    Ok(value)
}
