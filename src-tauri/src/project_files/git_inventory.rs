use super::{
    validate_relative_path, validate_wsl_git_inventory, ProjectFileError, SEARCH_DEPTH_LIMIT,
};
use crate::agent_sessions::AgentProject;
use std::sync::{Arc, Mutex};

pub(super) static SEARCH_CACHE: Mutex<SearchCacheState> = Mutex::new(SearchCacheState::new());

/// Group overviews search every member at once; beyond this many projects the
/// least recently used inventory is evicted.
const SEARCH_CACHE_CAPACITY: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SearchCacheKey {
    project_id: String,
    environment_kind: String,
    distribution: Option<String>,
    path: String,
    ssh: Option<crate::ssh::SshConnection>,
}

pub(super) struct GitInventoryPath {
    pub(super) original: String,
    pub(super) normalized: String,
}

impl GitInventoryPath {
    pub(super) fn new(original: String) -> Self {
        let normalized = original.to_lowercase();
        Self {
            original,
            normalized,
        }
    }
}

pub(super) struct CachedGitInventory {
    pub(super) paths: Arc<Vec<GitInventoryPath>>,
    pub(super) truncated: bool,
}

struct SearchCacheEntry {
    key: SearchCacheKey,
    /// Latest acquisition or discard token for this key; only it may publish.
    token: u64,
    inventory: Option<CachedGitInventory>,
}

/// Entries are ordered from least to most recently used.
pub(super) struct SearchCacheState {
    generation: u64,
    entries: Vec<SearchCacheEntry>,
}

impl SearchCacheState {
    pub(super) const fn new() -> Self {
        Self {
            generation: 0,
            entries: Vec::new(),
        }
    }

    fn position(&self, key: &SearchCacheKey) -> Option<usize> {
        self.entries.iter().position(|entry| &entry.key == key)
    }

    pub(super) fn get(&mut self, key: &SearchCacheKey) -> Option<&CachedGitInventory> {
        let index = self.position(key)?;
        let entry = self.entries.remove(index);
        self.entries.push(entry);
        self.entries.last()?.inventory.as_ref()
    }

    pub(super) fn begin_acquisition(&mut self, key: &SearchCacheKey) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        let entry = match self.position(key) {
            Some(index) => SearchCacheEntry {
                token: self.generation,
                ..self.entries.remove(index)
            },
            None => SearchCacheEntry {
                key: key.clone(),
                token: self.generation,
                inventory: None,
            },
        };
        self.entries.push(entry);
        if self.entries.len() > SEARCH_CACHE_CAPACITY {
            // An evicted in-flight acquisition simply fails to publish.
            self.entries.remove(0);
        }
        self.generation
    }

    pub(super) fn publish(
        &mut self,
        key: &SearchCacheKey,
        token: u64,
        inventory: CachedGitInventory,
    ) {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| &entry.key == key && entry.token == token)
        {
            entry.inventory = Some(inventory);
        }
    }

    /// Clears the cached inventory for `key` regardless of in-flight
    /// acquisitions: dropping an entry can only cost an extra read, whereas
    /// keeping a stale one would serve outdated results.
    pub(super) fn invalidate(&mut self, key: &SearchCacheKey) {
        if let Some(index) = self.position(key) {
            self.entries[index].inventory = None;
        }
    }

    /// Invalidates `key` and renews its token so an acquisition started
    /// before a mutation cannot publish its pre-mutation inventory.
    pub(super) fn discard(&mut self, key: &SearchCacheKey) {
        if let Some(index) = self.position(key) {
            self.generation = self.generation.wrapping_add(1);
            let entry = &mut self.entries[index];
            entry.token = self.generation;
            entry.inventory = None;
        }
    }
}

pub(super) fn git_inventory(
    project: &AgentProject,
    refresh: bool,
) -> Result<Option<(Arc<Vec<GitInventoryPath>>, bool)>, ProjectFileError> {
    let key = search_cache_key(project);
    if !refresh {
        let mut cache = SEARCH_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = cache.get(&key) {
            return Ok(Some((Arc::clone(&cached.paths), cached.truncated)));
        }
    }

    let token = SEARCH_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .begin_acquisition(&key);
    let inventory = crate::project_git::unignored_files(project)
        .map_err(|error| ProjectFileError::new("gitIgnore", error.message))?;
    let Some(inventory) = inventory else {
        SEARCH_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .invalidate(&key);
        return Ok(None);
    };
    let parsed = parse_git_inventory(&inventory);
    let (paths, truncated) = if project.environment.kind == "wsl" {
        validate_wsl_git_inventory(project, parsed)?
    } else {
        parsed
    };
    let paths = Arc::new(paths);
    SEARCH_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .publish(
            &key,
            token,
            CachedGitInventory {
                paths: Arc::clone(&paths),
                truncated,
            },
        );
    Ok(Some((paths, truncated)))
}

pub(super) fn search_cache_key(project: &AgentProject) -> SearchCacheKey {
    SearchCacheKey {
        project_id: project.id.clone(),
        environment_kind: project.environment.kind.clone(),
        distribution: project.environment.distribution.clone(),
        path: project.path.clone(),
        ssh: project.environment.ssh.clone(),
    }
}

pub(super) fn invalidate_search_cache(project: &AgentProject) {
    let key = search_cache_key(project);
    SEARCH_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .discard(&key);
}

pub(super) fn parse_git_inventory(inventory: &[u8]) -> (Vec<GitInventoryPath>, bool) {
    let mut paths = Vec::new();
    let mut truncated = false;
    for path in inventory
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let Ok(path) = std::str::from_utf8(path) else {
            truncated = true;
            continue;
        };
        if validate_relative_path(path, false).is_err() {
            truncated = true;
            continue;
        }
        if path.matches('/').count() > SEARCH_DEPTH_LIMIT {
            truncated = true;
            continue;
        }
        paths.push(GitInventoryPath::new(path.to_owned()));
    }
    (paths, truncated)
}
