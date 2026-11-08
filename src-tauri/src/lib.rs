mod agent_sessions;
mod app_state;
mod attachments;
mod claude_code;
mod codex_cli;
mod commands;
mod desktop_attention;
mod forge;
mod kanban;
mod linear;
mod log_file;
mod note_encryption;
mod note_types;
mod notes;
mod process_owner;
mod project_files;
mod project_git;
mod release_notes;
mod settings;
mod skills;
mod sqlite;
mod ssh;
mod subscription_usage;
mod tasks;
mod vaults;

use app_state::{init_app_state, sync_attachment_asset_scope};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                desktop_attention::init(app.handle());
                // The default macOS menu starts with the app submenu: About, separator, …
                if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) = app
                    .menu()
                    .and_then(|menu| menu.items().ok()?.into_iter().next())
                {
                    app_menu.insert_items(
                        &[
                            &tauri::menu::MenuItem::with_id(
                                app,
                                "settings",
                                "Settings…",
                                true,
                                Some("CmdOrCtrl+,"),
                            )?,
                            &tauri::menu::PredefinedMenuItem::separator(app)?,
                        ],
                        2,
                    )?;
                    app.on_menu_event(|app, event| match event.id().as_ref() {
                        "settings" => {
                            let _ = tauri::Emitter::emit(app, "open-settings", ());
                        }
                        "close-tab" => {
                            let _ = tauri::Emitter::emit(app, "close-tab", ());
                        }
                        _ => {}
                    });
                }
                // Cmd+W must close a session tab, not the single window and with it the app.
                for item in app.menu().map_or(Ok(Vec::new()), |menu| menu.items())? {
                    let tauri::menu::MenuItemKind::Submenu(submenu) = item else {
                        continue;
                    };
                    for (position, child) in submenu.items()?.into_iter().enumerate() {
                        if let tauri::menu::MenuItemKind::Predefined(close) = &child {
                            if close.text()? == "Close Window" {
                                submenu.remove(close)?;
                                submenu.insert(
                                    &tauri::menu::MenuItem::with_id(
                                        app,
                                        "close-tab",
                                        "Close Tab",
                                        true,
                                        Some("CmdOrCtrl+W"),
                                    )?,
                                    position,
                                )?;
                            }
                        }
                    }
                }
            }
            // Best effort: on failure a fresh install shows the current changelog once.
            let _ = release_notes::record_fresh_install(
                &app.path().app_data_dir()?,
                &app.package_info().version.to_string(),
            );
            let state = init_app_state(app).map_err(std::io::Error::other)?;
            let (app_data_dir, active_vault_root) = {
                let vault_state = state
                    .vaults
                    .lock()
                    .expect("failed to read active vault state");
                (
                    vault_state.app_data_dir.clone(),
                    vaults::vault_root(
                        &vault_state.app_data_dir,
                        &vault_state.vault_state.active_vault_id,
                    )
                    .expect("failed to resolve active vault directory"),
                )
            };
            sync_attachment_asset_scope(app.handle(), &app_data_dir)
                .expect("failed to initialize legacy attachments asset scope");
            kanban::images::allow_asset_scope(app.handle(), &app_data_dir)
                .expect("failed to initialize Kanban images asset scope");
            sync_attachment_asset_scope(app.handle(), &active_vault_root)
                .expect("failed to initialize attachments asset scope");
            ssh::initialize(&app_data_dir).expect("failed to initialize SSH trust directory");
            agent_sessions::set_grid_log_enabled(
                settings::read_settings(&app_data_dir)
                    .is_ok_and(|settings| settings.terminal_log_enabled),
            );
            app.manage(
                agent_sessions::AgentSessions::open(&app_data_dir)
                    .map_err(std::io::Error::other)?,
            );
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::agents::agent_workspace,
            commands::agents::agent_environments,
            commands::agents::agent_ssh_scan,
            commands::agents::agent_ssh_browse,
            commands::agents::agent_ssh_forward_list,
            commands::agents::agent_ssh_forward_start,
            commands::agents::agent_ssh_forward_stop,
            commands::agents::agent_omp_update_available,
            commands::agents::agent_update_omp,
            commands::agents::agent_ssh_mobile_status,
            commands::agents::agent_ssh_mobile_enable,
            commands::agents::agent_ssh_mobile_disable,
            commands::agents::agent_ssh_mobile_pair,
            commands::agents::agent_ssh_mobile_revoke,
            commands::agents::agent_ssh_pick_identity,
            commands::agents::agent_pick_project_directory,
            commands::agents::agent_save_project,
            commands::agents::agent_update_project_appearance,
            commands::agents::agent_delete_project,
            commands::agents::agent_save_project_group,
            commands::agents::agent_import_project_groups,
            commands::agents::agent_update_project_group_appearance,
            commands::agents::agent_prepare_group_project,
            commands::agents::agent_delete_project_group,
            commands::agents::agent_set_project_connected,
            commands::agents::agent_link_session_kanban_issue,
            commands::agents::agent_link_session_linear_issue,
            commands::agents::agent_unlink_session_issue,
            commands::agents::agent_set_project_linear_link,
            commands::agents::agent_set_session_closed,
            commands::agents::agent_complete_kanban_issue,
            commands::agents::agent_save_session,
            commands::agents::agent_delete_session,
            commands::agents::agent_automations,
            commands::agents::agent_save_automation,
            commands::agents::agent_delete_automation,
            commands::agents::agent_run_automation,
            commands::agents::agent_refresh_automations,
            commands::agents::agent_mark_automation_seen,
            commands::agents::agent_start,
            commands::agents::agent_stop,
            commands::agents::agent_conversation_subscribe,
            commands::agents::agent_conversation_send,
            commands::agents::agent_conversation_history,
            commands::agents::agent_statuses,
            commands::agents::agent_branches,
            commands::agents::agent_service_branches,
            commands::agents::agent_worktrees,
            commands::agents::agent_grid_subscribe,
            commands::agents::agent_grid_ack,
            commands::agents::agent_grid_unsubscribe,
            commands::agents::agent_grid_configure,
            commands::agents::agent_grid_scroll,
            commands::agents::agent_grid_select,
            commands::agents::agent_grid_visibility,
            commands::agents::agent_grid_text,
            commands::agents::agent_grid_log_path,
            commands::agents::agent_grid_diagnostic,
            commands::agents::agent_write,
            commands::agents::agent_session_messages,
            commands::agents::agent_send_message,
            commands::agents::agent_upload_clipboard_image,
            commands::agents::agent_attach_command,
            commands::agents::agent_set_remote_label,
            commands::agents::agent_attach_file,
            commands::agents::agent_resize,
            commands::project_git::project_git_init,
            commands::project_git::project_git_clone,
            commands::project_git::project_git_repository,
            commands::project_git::project_git_history,
            commands::project_git::project_git_path_prefix,
            commands::project_git::project_git_commit_detail,
            commands::project_git::project_git_commit_comparison,
            commands::project_git::project_git_branches,
            commands::project_git::project_git_worktrees,
            commands::project_git::project_git_create_worktree,
            commands::project_git::project_git_remove_worktree,
            commands::project_git::project_git_merge_worktree,
            commands::project_git::project_git_remotes,
            commands::project_git::project_git_fetch,
            commands::project_git::project_git_pull,
            commands::project_git::project_git_push,
            commands::project_git::project_git_create_branch,
            commands::project_git::project_git_remove_branch,
            commands::project_git::project_git_switch_branch,
            commands::project_git::project_git_comparison,
            commands::project_git::project_git_stage,
            commands::project_git::project_git_resolve,
            commands::project_git::project_git_unstage,
            commands::project_git::project_git_generate_commit_message,
            commands::project_git::project_git_commit,
            commands::project_git::project_git_quick_commit,
            commands::project_git::project_git_set_identity,
            commands::project_git::project_git_restore,
            commands::forge::project_forge_remote,
            commands::forge::project_forge_requests,
            commands::forge::project_forge_request,
            commands::forge::project_forge_changes,
            commands::forge::project_forge_comparison,
            commands::forge::project_forge_merge,
            commands::forge::project_forge_update,
            commands::forge::project_forge_checkout,
            commands::project_files::project_files_list,
            commands::project_files::project_files_search,
            commands::project_files::project_files_search_text,
            commands::project_files::project_files_read,
            commands::project_files::project_files_write,
            commands::project_files::project_files_create,
            commands::project_files::project_files_rename,
            commands::project_files::project_files_delete,
            commands::project_files::project_files_duplicate,
            commands::project_files::project_files_paste,
            commands::project_files::project_files_download,
            commands::library::list_notes,
            commands::library::create_note,
            commands::library::update_note,
            commands::library::update_note_kind,
            commands::library::update_note_archived,
            commands::library::update_note_pinned,
            commands::library::update_note_favorite,
            commands::library::delete_note,
            commands::library::list_tasks,
            commands::library::create_task,
            commands::library::update_task_title,
            commands::library::update_task_status,
            commands::library::update_task_priority,
            commands::library::update_task_attached_note,
            commands::library::delete_task,
            commands::library::list_note_types,
            commands::library::create_note_type,
            commands::library::update_note_type,
            commands::library::reorder_note_types,
            commands::library::delete_note_type,
            commands::vaults::list_vaults,
            commands::vaults::get_active_vault,
            commands::vaults::create_vault,
            commands::vaults::rename_vault,
            commands::vaults::select_vault,
            commands::vaults::delete_vault,
            commands::settings::get_app_settings,
            commands::settings::update_app_settings,
            commands::settings::reset_window_sizes,
            commands::release_notes::last_seen_version,
            commands::release_notes::mark_version_seen,
            commands::diagnostics::log_webview_error,
            commands::diagnostics::open_log_directory,
            commands::library::save_attachment_image,
            commands::note_encryption::get_note_encryption_key,
            commands::note_encryption::store_note_encryption_key,
            commands::note_encryption::replace_note_encryption_key,
            commands::note_encryption::reset_note_encryption_key,
            commands::note_encryption::save_encrypted_attachment,
            commands::note_encryption::read_attachment_image,
            commands::note_encryption::delete_attachment_image,
            commands::note_encryption::compact_vault_database,
            commands::codex::get_codex_status,
            commands::usage::get_codex_usage,
            commands::usage::get_claude_usage,
            commands::codex::check_codex_update,
            commands::codex::update_codex_cli,
            commands::codex::list_codex_models,
            commands::design::design_boards,
            commands::design::design_create_board,
            commands::design::design_rename_board,
            commands::design::design_delete_board,
            commands::design::design_frames,
            commands::design::design_update_frame,
            commands::design::design_duplicate_frame,
            commands::design::design_delete_frame,
            commands::design::design_restore_frame,
            commands::design::design_link_session,
            commands::design::design_unlink_session,
            commands::design::design_send_to_session,
            commands::kanban::load_kanban_board,
            commands::kanban::load_kanban_issue,
            commands::kanban::create_kanban_issue,
            commands::kanban::update_kanban_issue,
            commands::kanban::update_kanban_issue_description,
            commands::kanban::create_kanban_comment,
            commands::kanban::delete_kanban_comment,
            commands::kanban::delete_kanban_issue,
            commands::kanban::create_kanban_label,
            commands::kanban::upload_kanban_image,
            commands::kanban::open_kanban_image,
            commands::linear::has_linear_api_key,
            commands::linear::set_linear_api_key,
            commands::linear::clear_linear_api_key,
            commands::linear::load_linear_board,
            commands::linear::load_linear_issue,
            commands::linear::load_linear_image,
            commands::linear::create_linear_issue,
            commands::linear::transfer_kanban_issue_to_linear,
            commands::linear::update_linear_issue,
            commands::linear::update_linear_issue_description,
            commands::linear::create_linear_comment,
            commands::linear::delete_linear_comment,
            commands::linear::delete_linear_issue,
            commands::linear::create_linear_label,
            commands::linear::list_linear_projects,
            commands::skills::skills_list,
            commands::attention::show_agent_notification,
            commands::attention::set_agent_attention_badge,
            commands::attention::take_agent_notification_activation
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    // Installed before run: tauri builds the configured windows ahead of the user setup.
    if let Ok(path) = log_file::path(app.handle(), log_file::CRASH_LOG_FILE) {
        log_file::record_panics(path, app.package_info().version.to_string());
    }
    app.run(|app, event| {
        let closing = match event {
            tauri::RunEvent::Exit => true,
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => label == "main",
            _ => false,
        };
        if closing {
            app.state::<agent_sessions::AgentSessions>().shutdown();
            ssh::shutdown();
        }
    });
}
