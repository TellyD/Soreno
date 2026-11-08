use super::Snapshot;
use crate::agent_sessions::AgentProject;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SnapshotCacheKey {
    project_id: String,
    path: String,
    environment: String,
    distribution: Option<String>,
    ssh: Option<String>,
}

#[derive(Default)]
pub(super) struct SnapshotCache(Mutex<Option<(SnapshotCacheKey, Arc<Snapshot>)>>);

impl SnapshotCache {
    pub(super) fn store(&self, key: SnapshotCacheKey, snapshot: Arc<Snapshot>) {
        // ponytail: one snapshot bounds memory; cache more projects only if cross-project misses matter.
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((key, snapshot));
    }

    pub(super) fn get(&self, key: &SnapshotCacheKey, version: &str) -> Option<Arc<Snapshot>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|(cached_key, snapshot)| {
                cached_key == key && snapshot.repository.version == version
            })
            .map(|(_, snapshot)| Arc::clone(snapshot))
    }
}

pub(super) fn snapshot_cache() -> &'static SnapshotCache {
    static CACHE: OnceLock<SnapshotCache> = OnceLock::new();
    CACHE.get_or_init(SnapshotCache::default)
}

pub(super) fn snapshot_cache_key(project: &AgentProject) -> SnapshotCacheKey {
    SnapshotCacheKey {
        project_id: project.id.clone(),
        path: project.path.clone(),
        environment: project.environment.kind.clone(),
        distribution: project.environment.distribution.clone(),
        ssh: project
            .environment
            .ssh
            .as_ref()
            .and_then(|connection| serde_json::to_string(connection).ok()),
    }
}

pub(super) fn cached_snapshot(
    cache: &SnapshotCache,
    project: &AgentProject,
    version: Option<&str>,
) -> Option<Arc<Snapshot>> {
    version.and_then(|version| cache.get(&snapshot_cache_key(project), version))
}
