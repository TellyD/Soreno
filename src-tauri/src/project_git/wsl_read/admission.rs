use super::{pool_state, MAX_REQUESTS_PER_SCOPE};
use std::{
    sync::{Arc, Condvar, Mutex},
    time::Instant,
};

#[derive(Default)]
pub(super) struct Admission {
    count: Mutex<usize>,
    available: Condvar,
}

impl Admission {
    pub(super) fn acquire(self: &Arc<Self>, deadline: Instant) -> Option<AdmissionPermit> {
        let mut count = self
            .count
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if *count < MAX_REQUESTS_PER_SCOPE {
                *count += 1;
                return Some(AdmissionPermit(Arc::clone(self)));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let waited = self
                .available
                .wait_timeout(count, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            count = waited.0;
            if waited.1.timed_out() && *count >= MAX_REQUESTS_PER_SCOPE {
                return None;
            }
        }
    }

    pub(super) fn idle(&self) -> bool {
        *self
            .count
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            == 0
    }
}

pub(super) struct AdmissionPermit(Arc<Admission>);

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        let mut count = self
            .0
            .count
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *count -= 1;
        self.0.available.notify_one();
        pool_state().available.notify_all();
    }
}
