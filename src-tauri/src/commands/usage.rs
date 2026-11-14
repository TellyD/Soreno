use crate::{
    agent_sessions::{AgentEnvironment, AgentSessions},
    claude_code::ClaudeRateLimits,
    codex_cli::CodexRateLimits,
    subscription_usage::{self, UsageAccount},
};
use tauri::AppHandle;

const CODEX_USAGE_LOG_FILE: &str = "codex-usage.log";

async fn usage_environments(app: AppHandle) -> Result<Vec<AgentEnvironment>, String> {
    super::agents::blocking(app, AgentSessions::usage_environments).await
}

#[tauri::command]
pub(crate) async fn get_codex_usage(
    app: AppHandle,
) -> Result<Vec<UsageAccount<CodexRateLimits>>, String> {
    let log = crate::log_file::path(&app, CODEX_USAGE_LOG_FILE).ok();
    let environments = usage_environments(app).await?;
    tauri::async_runtime::spawn_blocking(move || {
        subscription_usage::codex_accounts(environments, log.as_deref())
    })
    .await
    .map_err(|e| format!("Codex usage task failed: {e}"))
}

#[tauri::command]
pub(crate) async fn get_claude_usage(
    app: AppHandle,
) -> Result<Vec<UsageAccount<ClaudeRateLimits>>, String> {
    let environments = usage_environments(app).await?;
    tauri::async_runtime::spawn_blocking(move || subscription_usage::claude_accounts(environments))
        .await
        .map_err(|e| format!("Claude usage task failed: {e}"))
}
