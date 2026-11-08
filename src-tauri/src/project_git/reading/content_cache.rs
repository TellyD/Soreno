use super::{GitContent, SnapshotCacheKey};
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};

const GIT_CONTENT_CACHE_ENTRY_LIMIT: usize = 128;
const GIT_CONTENT_CACHE_TEXT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct GitContentCacheKey {
    pub(super) project: SnapshotCacheKey,
    pub(super) oid: String,
    pub(super) mode: String,
}

struct GitContentCacheEntry {
    key: GitContentCacheKey,
    content: GitContent,
    text_bytes: usize,
}

#[derive(Default)]
struct GitContentCacheState {
    entries: VecDeque<GitContentCacheEntry>,
    text_bytes: usize,
}

pub(super) struct GitContentCache {
    state: Mutex<GitContentCacheState>,
    entry_limit: usize,
    text_limit: usize,
}

impl Default for GitContentCache {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            entry_limit: GIT_CONTENT_CACHE_ENTRY_LIMIT,
            text_limit: GIT_CONTENT_CACHE_TEXT_LIMIT,
        }
    }
}

impl GitContentCache {
    pub(super) fn get(&self, key: &GitContentCacheKey) -> Option<GitContent> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = state.entries.iter().position(|entry| entry.key == *key)?;
        let entry = state.entries.remove(index)?;
        let content = entry.content.clone();
        state.entries.push_back(entry);
        Some(content)
    }

    pub(super) fn store(&self, key: GitContentCacheKey, content: GitContent) {
        let text_bytes = content.text.as_ref().map_or(0, String::len)
            + content.image_data_url.as_ref().map_or(0, String::len);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(index) = state.entries.iter().position(|entry| entry.key == key) {
            if let Some(entry) = state.entries.remove(index) {
                state.text_bytes -= entry.text_bytes;
            }
        }
        if self.entry_limit == 0 || text_bytes > self.text_limit {
            return;
        }
        while state.entries.len() >= self.entry_limit
            || state.text_bytes + text_bytes > self.text_limit
        {
            let Some(entry) = state.entries.pop_front() else {
                break;
            };
            state.text_bytes -= entry.text_bytes;
        }
        state.text_bytes += text_bytes;
        state.entries.push_back(GitContentCacheEntry {
            key,
            content,
            text_bytes,
        });
    }

    #[cfg(test)]
    pub(super) fn with_limits(entry_limit: usize, text_limit: usize) -> Self {
        Self {
            state: Mutex::default(),
            entry_limit,
            text_limit,
        }
    }

    #[cfg(test)]
    pub(super) fn usage(&self) -> (usize, usize) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (state.entries.len(), state.text_bytes)
    }
}

pub(super) fn git_content_cache() -> &'static GitContentCache {
    static CACHE: OnceLock<GitContentCache> = OnceLock::new();
    CACHE.get_or_init(GitContentCache::default)
}
