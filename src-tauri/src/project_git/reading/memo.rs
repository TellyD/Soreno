use super::{Counts, GitIdentity, SnapshotCacheKey, WorktreeFingerprint};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

const READ_MEMO_PROJECT_LIMIT: usize = 16;
/// Inputs outside the memo keys (attributes, diff configuration, timestamp-preserving writes) converge within this age.
pub(super) const READ_MEMO_TTL: Duration = Duration::from_secs(60);
/// A stamp younger than this may share its timestamp tick with a later write (racy Git).
pub(super) const SETTLE_NANOS: i128 = 2_000_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FileStamp {
    pub(super) key: String,
    pub(super) settled: bool,
}

#[derive(Default)]
pub(super) struct FingerprintMemo(HashMap<Vec<u8>, (String, WorktreeFingerprint)>);

impl FingerprintMemo {
    pub(super) fn stamp(&self, path: &[u8]) -> Option<&str> {
        self.0.get(path).map(|(stamp, _)| stamp.as_str())
    }

    pub(super) fn get(&self, path: &[u8], stamp: &str, mode: &str) -> Option<&WorktreeFingerprint> {
        self.0
            .get(path)
            .filter(|(known, fingerprint)| {
                known == stamp
                    && matches!(fingerprint, WorktreeFingerprint::Present { mode: known, .. } if known == mode)
            })
            .map(|(_, fingerprint)| fingerprint)
    }

    pub(super) fn remember(
        &mut self,
        path: &[u8],
        stamp: &FileStamp,
        fingerprint: &WorktreeFingerprint,
    ) {
        if stamp.settled
            && matches!(
                fingerprint,
                WorktreeFingerprint::Present {
                    kind: "sha256" | "gitOid",
                    ..
                }
            )
        {
            self.0
                .insert(path.to_vec(), (stamp.key.clone(), fingerprint.clone()));
        }
    }
}

#[derive(Clone, Default)]
pub(super) struct CountsMemo(HashMap<Vec<u8>, Option<Counts>>);

impl CountsMemo {
    pub(super) fn get(&self, key: &[u8]) -> Option<Option<Counts>> {
        self.0.get(key).copied()
    }

    pub(super) fn remember(&mut self, key: Vec<u8>, counts: Option<Counts>) {
        self.0.insert(key, counts);
    }
}

/// Inputs-keyed results of earlier snapshots, all recomputed once their epoch is older than `READ_MEMO_TTL`.
#[derive(Default)]
pub(super) struct ReadMemo {
    identity: Option<GitIdentity>,
    /// When the oldest entry carried by this memo was computed; `None` for an empty memo.
    pub(super) epoch: Option<Instant>,
    pub(super) fingerprints: FingerprintMemo,
    pub(super) counts: CountsMemo,
}

impl ReadMemo {
    pub(super) fn new(identity: &GitIdentity) -> Self {
        Self {
            identity: Some(identity.clone()),
            epoch: Some(Instant::now()),
            ..Self::default()
        }
    }

    /// An empty successor that inherits this memo's epoch, or starts one when this memo is empty.
    pub(super) fn successor(&self, identity: &GitIdentity) -> Self {
        let next = Self::new(identity);
        Self {
            epoch: self.epoch.or(next.epoch),
            ..next
        }
    }
}

#[derive(Default)]
pub(super) struct ReadMemoStore(Mutex<VecDeque<(SnapshotCacheKey, Arc<ReadMemo>)>>);

impl ReadMemoStore {
    pub(super) fn get(&self, key: &SnapshotCacheKey, identity: &GitIdentity) -> Arc<ReadMemo> {
        let mut memos = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(position) = memos.iter().position(|(known, _)| known == key) else {
            return Arc::default();
        };
        let entry = memos.remove(position).expect("position trouvée");
        let memo = Arc::clone(&entry.1);
        memos.push_back(entry);
        let fresh = memo
            .epoch
            .is_some_and(|epoch| epoch.elapsed() < READ_MEMO_TTL);
        if fresh && memo.identity.as_ref() == Some(identity) {
            memo
        } else {
            Arc::default()
        }
    }

    pub(super) fn store(&self, key: SnapshotCacheKey, memo: ReadMemo) {
        let mut memos = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        memos.retain(|(known, _)| *known != key);
        if memos.len() >= READ_MEMO_PROJECT_LIMIT {
            memos.pop_front();
        }
        memos.push_back((key, Arc::new(memo)));
    }
}

pub(super) static READ_MEMOS: ReadMemoStore = ReadMemoStore(Mutex::new(VecDeque::new()));
