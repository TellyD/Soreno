use crate::{
    agent_sessions::AgentSessions,
    skills::{self, SkillInventory, SkillScope, SkillsError},
};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub(crate) async fn skills_list(
    app: AppHandle,
    scope: String,
    project_id: Option<String>,
) -> Result<SkillInventory, SkillsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let scope = SkillScope::parse(&scope)?;
        let project = project_id
            .map(|project_id| {
                app.state::<AgentSessions>()
                    .project(&project_id)
                    .map_err(|message| SkillsError::new("project", message))
            })
            .transpose()?;
        skills::list(&skills::resolve_target(scope, project.as_ref())?)
    })
    .await
    .map_err(|error| SkillsError::new("io", error.to_string()))?
}
