use super::GitError;
use crate::agent_sessions::AgentProject;
use std::cell::{Cell, RefCell};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PoolPolicy {
    Foreground,
    Background,
}

thread_local! {
    pub(super) static DISPLAY_SCOPE: RefCell<Option<ScopeKey>> = const { RefCell::new(None) };
    pub(super) static POOL_POLICY: Cell<PoolPolicy> = const { Cell::new(PoolPolicy::Foreground) };
}

struct DisplayGuard {
    scope: Option<ScopeKey>,
    policy: PoolPolicy,
}

impl Drop for DisplayGuard {
    fn drop(&mut self) {
        DISPLAY_SCOPE.with(|scope| *scope.borrow_mut() = self.scope.take());
        POOL_POLICY.with(|policy| policy.set(self.policy));
    }
}

pub(super) fn with_display_scope<T>(
    project: &AgentProject,
    policy: PoolPolicy,
    read: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    let previous_scope = DISPLAY_SCOPE.with(|scope| scope.replace(Some(ScopeKey::from(project))));
    let previous_policy = POOL_POLICY.with(|current| current.replace(policy));
    let _guard = DisplayGuard {
        scope: previous_scope,
        policy: previous_policy,
    };
    read()
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct ScopeKey {
    pub(super) id: String,
    path: String,
    pub(super) environment: String,
    pub(super) distribution: Option<String>,
}

impl From<&AgentProject> for ScopeKey {
    fn from(project: &AgentProject) -> Self {
        Self {
            id: project.id.clone(),
            path: project.path.clone(),
            environment: project.environment.kind.clone(),
            distribution: project.environment.distribution.clone(),
        }
    }
}
