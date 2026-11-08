use super::{
    appearance::validate_appearance,
    apply_connection_changes,
    codex_overrides::{add_developer_instructions, add_writable_roots},
    conversations::Provider,
    delete_projects_locked, get, id, lock, project_disconnected, require_project,
    same_agent_environment, text, validate_project, AgentEnvironment, AgentProject,
    AgentProjectAppearanceChange, AgentSessions, Result, SessionEnd,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

const GROUP_NAME_LIMIT: usize = 100;
const GROUP_MEMBER_LIMIT: usize = 1024;
const GROUP_DIRECTORY_SCRIPT: &str = "mkdir -p -- \"$dir\" && cd -- \"$dir\" && pwd -P";
// Arguments: the group folder, then name/target pairs. Keeps wanted links, drops other links.
const GROUP_LINKS_SCRIPT: &str = r#"cd -- "$1" || exit 1; shift; wanted() { name=$1; target=$2; shift 2; while [ $# -gt 1 ]; do [ "$1" = "$name" ] && [ "$2" = "$target" ] && return 0; shift 2; done; return 1; }; for link in * .[!.]* ..?*; do [ -L "$link" ] && ! wanted "$link" "$(readlink -- "$link")" "$@" && rm -f -- "$link"; done; while [ $# -gt 1 ]; do [ -e "$1" ] || [ -L "$1" ] || ln -s -- "$2" "$1"; shift 2; done; exit 0"#;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectGroup {
    pub id: String,
    pub name: String,
    pub project_ids: Vec<String>,
    pub group_project_id: Option<String>,
    #[serde(flatten)]
    pub appearance: AgentProjectGroupAppearance,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectGroupAppearance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProjectGroupInput {
    pub id: String,
    pub name: String,
    pub project_ids: Vec<String>,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectGroupImport {
    pub ungrouped_project_ids: Vec<String>,
    pub group_ids: Vec<String>,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectGroupDeletion {
    pub retained_folder: Option<String>,
}
#[derive(Deserialize, Serialize)]
struct GroupData {
    name: String,
    #[serde(flatten)]
    appearance: AgentProjectGroupAppearance,
}

fn valid_group_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
fn require_group_id(value: &str) -> Result<()> {
    if valid_group_id(value) {
        Ok(())
    } else {
        Err("Identifiant de groupe invalide.".into())
    }
}
fn import_group_id(value: &str) -> String {
    if valid_group_id(value) {
        return value.into();
    }
    let digest = Sha256::digest(value.as_bytes());
    let hex: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("legacy-{hex}")
}
fn group_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > GROUP_NAME_LIMIT {
        return Err("Nommez le groupe (100 caractères au plus).".into());
    }
    text(name, "Nom du groupe", 256)?;
    Ok(name.into())
}
fn group_project_id(group_id: &str) -> String {
    format!("group-{group_id}")
}

fn member_ids(db: &Connection, group_id: &str) -> Result<Vec<String>> {
    let mut stmt = db
        .prepare("SELECT project_id FROM agent_project_group_members WHERE group_id=?1 ORDER BY position")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([group_id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())
}
fn query_groups(
    db: &Connection,
    condition: &str,
    parameter: Option<&str>,
) -> Result<Vec<AgentProjectGroup>> {
    // Conditions are internal constants, never IPC data.
    let mut stmt = db
        .prepare(&format!(
            "SELECT id,group_project_id,data FROM agent_project_groups {condition} ORDER BY rowid"
        ))
        .map_err(|e| e.to_string())?;
    let map = |row: &rusqlite::Row<'_>| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    };
    let rows = match parameter {
        Some(parameter) => stmt.query_map([parameter], map),
        None => stmt.query_map([], map),
    }
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|(id, group_project_id, data)| {
            let data: GroupData = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            Ok(AgentProjectGroup {
                project_ids: member_ids(db, &id)?,
                id,
                name: data.name,
                group_project_id,
                appearance: data.appearance,
            })
        })
        .collect()
}
fn get_group(db: &Connection, group_id: &str) -> Result<Option<AgentProjectGroup>> {
    Ok(query_groups(db, "WHERE id=?1", Some(group_id))?.pop())
}
pub(super) fn list_groups(db: &Connection) -> Result<Vec<AgentProjectGroup>> {
    query_groups(db, "", None)
}
/// Overview projects Soreno manages itself, the Design project included.
pub(super) fn group_project_ids(db: &Connection) -> Result<HashSet<String>> {
    let mut stmt = db
        .prepare(
            "SELECT group_project_id FROM agent_project_groups WHERE group_project_id IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut ids = rows
        .collect::<rusqlite::Result<HashSet<String>>>()
        .map_err(|e| e.to_string())?;
    ids.insert(super::design::PROJECT_ID.into());
    Ok(ids)
}
pub(super) fn group_of_project_member(db: &Connection, project_id: &str) -> Result<Option<String>> {
    db.query_row(
        "SELECT group_id FROM agent_project_group_members WHERE project_id=?1",
        [project_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}
pub(super) fn group_by_group_project(
    db: &Connection,
    project_id: &str,
) -> Result<Option<AgentProjectGroup>> {
    Ok(query_groups(db, "WHERE group_project_id=?1", Some(project_id))?.pop())
}
pub(super) fn group_members(
    db: &Connection,
    group: &AgentProjectGroup,
) -> Result<Vec<(String, String)>> {
    group
        .project_ids
        .iter()
        .map(|project_id| {
            let project: AgentProject =
                get(db, "agent_projects", project_id)?.ok_or("Projet introuvable.")?;
            Ok((project.name, project.path))
        })
        .collect()
}

pub(super) fn add_launch_args(
    args: &mut Vec<String>,
    provider: Provider,
    group_name: &str,
    members: &[(String, String)],
    windows_local: bool,
) {
    if members.is_empty() {
        return;
    }
    let directories = members.iter().map(|(_, path)| path.clone());
    // Codex takes it as a TOML literal string on Windows, which cannot hold a line break.
    let separator = if matches!(provider, Provider::Codex) && windows_local {
        " "
    } else {
        "\n"
    };
    let prompt = std::iter::once(format!(
        "You are the agent of the Soreno project group “{group_name}”. You can read and edit its repositories directly:"
    ))
    .chain(members.iter().map(|(name, path)| format!("- {name}: {path}")))
    .collect::<Vec<_>>()
    .join(separator);
    match provider {
        Provider::Claude | Provider::Omp => {
            let directories = directories.flat_map(|path| ["--add-dir".to_owned(), path]);
            let prompt_args = ["--append-system-prompt".to_owned(), prompt];
            args.splice(0..0, prompt_args.into_iter().chain(directories));
        }
        Provider::Pi => {
            args.splice(0..0, ["--append-system-prompt".to_owned(), prompt]);
        }
        Provider::Codex => {
            add_developer_instructions(args, &prompt, windows_local);
            add_writable_roots(args, directories, windows_local);
        }
    }
}

fn ssh_connection(environment: &AgentEnvironment) -> Result<&crate::ssh::SshConnection> {
    environment
        .ssh
        .as_ref()
        .ok_or_else(|| "Connexion SSH manquante.".into())
}
#[cfg(windows)]
fn wsl_output(environment: &AgentEnvironment, command: &[&str]) -> Result<Vec<u8>> {
    let distribution = environment
        .distribution
        .as_deref()
        .ok_or("Distribution WSL manquante.")?;
    let mut probe = std::process::Command::new("wsl.exe");
    probe
        .args(["--distribution", distribution, "--exec"])
        .args(command);
    super::probe_output(probe)
}
#[cfg(not(windows))]
fn wsl_output(_environment: &AgentEnvironment, _command: &[&str]) -> Result<Vec<u8>> {
    Err("WSL est disponible uniquement sous Windows.".into())
}

pub(super) fn resolve_group_directory(
    environment: &AgentEnvironment,
    group_id: &str,
) -> Result<String> {
    require_group_id(group_id)?;
    match environment.kind.as_str() {
        "local" => {
            let path = std::env::home_dir()
                .ok_or("Dossier personnel introuvable.")?
                .join(".soreno")
                .join("groups")
                .join(group_id);
            std::fs::create_dir_all(&path)
                .map_err(|error| format!("Impossible de créer le dossier du groupe : {error}"))?;
            path.into_os_string()
                .into_string()
                .map_err(|_| "Chemin du dossier de groupe invalide.".into())
        }
        "wsl" => {
            #[cfg(windows)]
            {
                let script = format!("dir=\"$HOME/.soreno/groups/$1\"; {GROUP_DIRECTORY_SCRIPT}");
                super::environment::parse_wsl_path_output(wsl_output(
                    environment,
                    &["sh", "-c", &script, "soreno", group_id],
                )?)
            }
            #[cfg(not(windows))]
            Err("WSL est disponible uniquement sous Windows.".into())
        }
        "ssh" => {
            let script = format!(
                "dir=\"$HOME/.soreno/groups/\"{}; {GROUP_DIRECTORY_SCRIPT}",
                crate::ssh::quote(group_id)
            );
            let output = crate::ssh::run(ssh_connection(environment)?, &script, None, 4096)?;
            let path = String::from_utf8(output)
                .map_err(|_| "Chemin du dossier de groupe invalide.".to_string())?
                .trim()
                .to_owned();
            crate::ssh::validate_path(&path)?;
            Ok(path)
        }
        _ => Err("Environnement inconnu.".into()),
    }
}
pub(super) fn create_group_directory(environment: &AgentEnvironment, path: &str) -> Result<()> {
    match environment.kind.as_str() {
        "local" => std::fs::create_dir_all(path)
            .map_err(|error| format!("Impossible de créer le dossier du groupe : {error}")),
        "wsl" => wsl_output(environment, &["mkdir", "-p", "--", path]).map(|_| ()),
        "ssh" => crate::ssh::run(
            ssh_connection(environment)?,
            &format!("mkdir -p -- {}", crate::ssh::quote(path)),
            None,
            1024,
        )
        .map(|_| ()),
        _ => Err("Environnement inconnu.".into()),
    }
}
/// Links each member under its folder name in the group folder: agents complete `@` from their working folder only.
// Best effort: a missing link costs the completion, never the launch.
pub(super) fn link_members(
    environment: &AgentEnvironment,
    path: &str,
    members: &[(String, String)],
) {
    let links = member_links(members);
    let _ = match environment.kind.as_str() {
        "local" => link_local(Path::new(path), &links).map_err(|error| error.to_string()),
        "wsl" => {
            let mut command = vec!["sh", "-c", GROUP_LINKS_SCRIPT, "soreno", path];
            command.extend(links.iter().flat_map(|&(name, target)| [name, target]));
            wsl_output(environment, &command).map(|_| ())
        }
        "ssh" => ssh_connection(environment).and_then(|connection| {
            let arguments = std::iter::once(path)
                .chain(links.iter().flat_map(|&(name, target)| [name, target]))
                .map(crate::ssh::quote)
                .collect::<Vec<_>>()
                .join(" ");
            crate::ssh::run(
                connection,
                &format!("set -- {arguments}; {GROUP_LINKS_SCRIPT}"),
                None,
                1024,
            )
            .map(|_| ())
        }),
        _ => Ok(()),
    };
}
// Same rule as `groupMentionRoots` in the front end. Case-insensitive: Windows and macOS folders are.
fn member_links(members: &[(String, String)]) -> Vec<(&str, &str)> {
    let mut seen = HashSet::new();
    members
        .iter()
        .filter_map(|(_, path)| {
            let name = path
                .trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .next()?;
            (!matches!(name, "" | "." | "..") && seen.insert(name.to_lowercase()))
                .then_some((name, path.as_str()))
        })
        .collect()
}
fn link_local(directory: &Path, links: &[(&str, &str)]) -> std::io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_symlink() {
            continue;
        }
        let link = entry.path();
        let wanted = links.iter().any(|&(name, target)| {
            entry.file_name() == name
                && matches!(
                    (std::fs::canonicalize(&link), std::fs::canonicalize(target)),
                    (Ok(left), Ok(right)) if left == right
                )
        });
        if !wanted {
            // A Windows junction is a directory.
            let _ = std::fs::remove_file(&link).or_else(|_| std::fs::remove_dir(&link));
        }
    }
    for &(name, target) in links {
        let link = directory.join(name);
        if link.symlink_metadata().is_err() {
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(target, &link);
            #[cfg(windows)]
            let _ = create_junction(Path::new(target), &link);
        }
    }
    Ok(())
}
/// A junction, unlike a directory symlink, needs neither administrator rights nor Developer Mode.
#[cfg(windows)]
fn create_junction(target: &Path, link: &Path) -> std::io::Result<()> {
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::{
        Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT},
        System::IO::DeviceIoControl,
    };
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    let target = std::fs::canonicalize(target)?;
    // `canonicalize` gives `\\?\C:\…`; a junction cannot point to a network share.
    let Some(local) = target.to_str().and_then(|path| path.strip_prefix(r"\\?\")) else {
        return Err(std::io::ErrorKind::Unsupported.into());
    };
    if local.starts_with(r"UNC\") {
        return Err(std::io::ErrorKind::Unsupported.into());
    }
    let wide = |text: &str| {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .collect::<Vec<u16>>()
    };
    let substitute = wide(&format!(r"\??\{local}"));
    let print = wide(local);
    let bytes = |units: &[u16]| (units.len() * 2) as u16;
    let data_length = 8 + bytes(&substitute) + 2 + bytes(&print) + 2;
    let mut buffer = Vec::with_capacity(8 + data_length as usize);
    buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    for value in [
        data_length,
        0,
        0,
        bytes(&substitute),
        bytes(&substitute) + 2,
        bytes(&print),
    ] {
        buffer.extend(value.to_le_bytes());
    }
    for unit in substitute.iter().chain([&0]).chain(&print).chain([&0]) {
        buffer.extend(unit.to_le_bytes());
    }
    std::fs::create_dir(link)?;
    let result = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(link)
        .and_then(|directory| {
            let mut returned = 0;
            // SAFETY: `buffer` is a complete mount point reparse buffer of the given length.
            let done = unsafe {
                DeviceIoControl(
                    directory.as_raw_handle(),
                    FSCTL_SET_REPARSE_POINT,
                    buffer.as_ptr().cast(),
                    buffer.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            if done == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    if result.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    result
}
pub(super) fn remove_empty_group_directory(environment: &AgentEnvironment, path: &str) -> bool {
    link_members(environment, path, &[]);
    match environment.kind.as_str() {
        "local" => match std::fs::remove_dir(path) {
            Ok(()) => true,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        },
        "wsl" => wsl_output(environment, &["rmdir", "--", path]).is_ok(),
        "ssh" => ssh_connection(environment).is_ok_and(|connection| {
            crate::ssh::run(
                connection,
                &format!("rmdir -- {}", crate::ssh::quote(path)),
                None,
                1024,
            )
            .is_ok()
        }),
        _ => false,
    }
}

impl AgentSessions {
    pub fn save_group(&self, input: AgentProjectGroupInput) -> Result<()> {
        require_group_id(&input.id)?;
        let name = group_name(&input.name)?;
        if input.project_ids.len() > GROUP_MEMBER_LIMIT {
            return Err("Un groupe ne peut pas contenir plus de 1024 projets.".into());
        }
        let mut unique = HashSet::with_capacity(input.project_ids.len());
        for project_id in &input.project_ids {
            id(project_id)?;
            if !unique.insert(project_id.as_str()) {
                return Err("Un projet apparaît deux fois dans le groupe.".into());
            }
        }
        let mut store = lock(&self.store)?;
        let existing = get_group(&store.db, &input.id)?;
        if existing.is_none() && input.project_ids.is_empty() {
            return Err("Choisissez au moins un projet.".into());
        }
        let group_projects = group_project_ids(&store.db)?;
        let mut environments = Vec::with_capacity(input.project_ids.len() + 1);
        let mut members = Vec::with_capacity(input.project_ids.len());
        for project_id in &input.project_ids {
            let project = require_project(&store, project_id)?;
            if group_projects.contains(project_id) {
                return Err("Un projet de groupe ne peut pas être membre d'un groupe.".into());
            }
            environments.push(project.environment);
            members.push((project.name, project.path));
        }
        let (group_project_id, appearance) = existing
            .map(|group| (group.group_project_id, group.appearance))
            .unwrap_or_default();
        let group_project = group_project_id
            .map(|project_id| require_project(&store, &project_id))
            .transpose()?;
        if let Some(project) = &group_project {
            environments.push(project.environment.clone());
        }
        if let Some((anchor, others)) = environments.split_first() {
            if others
                .iter()
                .any(|environment| !same_agent_environment(anchor, environment))
            {
                return Err("Les projets d'un groupe doivent être sur la même machine.".into());
            }
        }
        // Running group agents see the new membership at once: their links must follow it.
        // shortcut: a group losing a member by a move or a project deletion keeps its links until its next launch or save; with two members of one folder name, `@<folder>/…` then points to the departed one. Resync affected groups if that shows up.
        let folder = match &group_project {
            Some(project) if !project_disconnected(&store.db, &project.id)? => {
                Some((project.environment.clone(), project.path.clone()))
            }
            _ => None,
        };
        let data = serde_json::to_string(&GroupData {
            name: name.clone(),
            appearance,
        })
        .map_err(|e| e.to_string())?;
        let tx = store.db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO agent_project_groups(id,data) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![input.id, data],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM agent_project_group_members WHERE group_id=?1",
            [&input.id],
        )
        .map_err(|e| e.to_string())?;
        for (position, project_id) in input.project_ids.iter().enumerate() {
            tx.execute(
                "DELETE FROM agent_project_group_members WHERE project_id=?1",
                [project_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO agent_project_group_members(group_id,project_id,position) VALUES (?1,?2,?3)",
                params![input.id, project_id, position as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(mut project) = group_project {
            project.name = name;
            tx.execute(
                "UPDATE agent_projects SET data=?1 WHERE id=?2",
                params![
                    serde_json::to_string(&project).map_err(|e| e.to_string())?,
                    project.id
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        if let Some((environment, path)) = folder {
            link_members(&environment, &path, &members);
        }
        Ok(())
    }

    pub fn import_groups(
        &self,
        groups: Vec<AgentProjectGroupInput>,
    ) -> Result<AgentProjectGroupImport> {
        let mut store = lock(&self.store)?;
        let tx = store.db.transaction().map_err(|e| e.to_string())?;
        let group_projects = group_project_ids(&tx)?;
        let mut ungrouped_project_ids = Vec::new();
        let mut group_ids = Vec::with_capacity(groups.len());
        for input in groups {
            let group_id = import_group_id(&input.id);
            group_ids.push(group_id.clone());
            if get_group(&tx, &group_id)?.is_some() {
                continue;
            }
            let Ok(name) = group_name(&input.name) else {
                continue;
            };
            let mut seen = HashSet::new();
            let mut batches: Vec<Vec<AgentProject>> = Vec::new();
            for project_id in input.project_ids {
                if group_projects.contains(&project_id) || !seen.insert(project_id.clone()) {
                    continue;
                }
                let Some(project) = get::<AgentProject>(&tx, "agent_projects", &project_id)? else {
                    continue;
                };
                if group_of_project_member(&tx, &project_id)?.is_some() {
                    continue;
                }
                match batches.iter_mut().find(|batch| {
                    same_agent_environment(&batch[0].environment, &project.environment)
                }) {
                    Some(batch) => batch.push(project),
                    None => batches.push(vec![project]),
                }
            }
            let mut kept = 0;
            for (index, batch) in batches.iter().enumerate() {
                if batch.len() > batches[kept].len() {
                    kept = index;
                }
            }
            if batches.is_empty() {
                continue;
            }
            let members = batches.swap_remove(kept);
            ungrouped_project_ids.extend(batches.into_iter().flatten().map(|project| project.id));
            tx.execute(
                "INSERT INTO agent_project_groups(id,data) VALUES (?1,?2)",
                params![
                    group_id,
                    serde_json::to_string(&GroupData {
                        name,
                        appearance: AgentProjectGroupAppearance::default(),
                    })
                    .map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
            for (position, project) in members.iter().enumerate() {
                tx.execute(
                    "INSERT INTO agent_project_group_members(group_id,project_id,position) VALUES (?1,?2,?3)",
                    params![group_id, project.id, position as i64],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        let mut regrouped = HashSet::new();
        for project_id in &ungrouped_project_ids {
            if group_of_project_member(&tx, project_id)?.is_some() {
                regrouped.insert(project_id.clone());
            }
        }
        ungrouped_project_ids.retain(|project_id| !regrouped.contains(project_id));
        tx.commit().map_err(|e| e.to_string())?;
        Ok(AgentProjectGroupImport {
            ungrouped_project_ids,
            group_ids,
        })
    }

    pub fn update_group_appearance(
        &self,
        group_id: &str,
        change: AgentProjectAppearanceChange,
    ) -> Result<AgentProjectGroupAppearance> {
        require_group_id(group_id)?;
        let store = lock(&self.store)?;
        let AgentProjectGroup {
            name,
            mut appearance,
            ..
        } = get_group(&store.db, group_id)?.ok_or("Groupe introuvable.")?;
        change.apply(
            &mut appearance.icon,
            &mut appearance.color,
            &mut appearance.icon_data_url,
        );
        validate_appearance(
            appearance.icon.as_deref(),
            appearance.color.as_deref(),
            appearance.icon_data_url.as_deref(),
        )?;
        let data = GroupData { name, appearance };
        store
            .db
            .execute(
                "UPDATE agent_project_groups SET data=?1 WHERE id=?2",
                params![
                    serde_json::to_string(&data).map_err(|e| e.to_string())?,
                    group_id
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(data.appearance)
    }

    pub fn prepare_group_project(&self, group_id: &str) -> Result<AgentProject> {
        self.prepare_group_project_with(group_id, resolve_group_directory)
    }
    pub(crate) fn prepare_group_project_with(
        &self,
        group_id: &str,
        resolve: impl FnOnce(&AgentEnvironment, &str) -> Result<String>,
    ) -> Result<AgentProject> {
        require_group_id(group_id)?;
        let environment = {
            let store = lock(&self.store)?;
            let group = get_group(&store.db, group_id)?.ok_or("Groupe introuvable.")?;
            if let Some(project_id) = &group.group_project_id {
                return require_project(&store, project_id);
            }
            let first = group
                .project_ids
                .first()
                .ok_or("Ajoutez un projet au groupe.")?;
            if project_disconnected(&store.db, first)? {
                return Err(
                    "Ce projet SSH est déconnecté. Reconnectez-le avant cette opération.".into(),
                );
            }
            require_project(&store, first)?.environment
        };
        // The home directory may be remote: resolve it without blocking other operations.
        let path = resolve(&environment, group_id)?;
        let _connection_change = lock(&self.connection_changes)?;
        let mut store = lock(&self.store)?;
        let group = get_group(&store.db, group_id)?.ok_or("Groupe introuvable.")?;
        if let Some(project_id) = &group.group_project_id {
            return require_project(&store, project_id);
        }
        let first = match group.project_ids.first() {
            Some(first)
                if same_agent_environment(
                    &require_project(&store, first)?.environment,
                    &environment,
                ) =>
            {
                first
            }
            _ => return Err("Le groupe a changé, réessayez.".into()),
        };
        if project_disconnected(&store.db, first)? {
            return Err(
                "Ce projet SSH est déconnecté. Reconnectez-le avant cette opération.".into(),
            );
        }
        let project = AgentProject {
            id: group_project_id(group_id),
            name: group.name,
            path,
            environment,
            icon_data_url: None,
            icon: None,
            color: None,
        };
        validate_project(&project)?;
        let tx = store.db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
            params![
                project.id,
                serde_json::to_string(&project).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE agent_project_groups SET group_project_id=?1 WHERE id=?2",
            params![project.id, group_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(project)
    }

    pub fn delete_group(
        &self,
        group_id: &str,
        delete_projects: bool,
    ) -> Result<AgentProjectGroupDeletion> {
        require_group_id(group_id)?;
        let _connection_change = lock(&self.connection_changes)?;
        let mut store = lock(&self.store)?;
        if store.git_busy {
            return Err("Une opération Git est en cours.".into());
        }
        let group = get_group(&store.db, group_id)?.ok_or("Groupe introuvable.")?;
        let mut project_ids = if delete_projects {
            group.project_ids
        } else {
            Vec::new()
        };
        let mut folder = None;
        if let Some(project_id) = group.group_project_id {
            let project = require_project(&store, &project_id)?;
            let reachable = !project_disconnected(&store.db, &project_id)?;
            folder = Some((project, reachable));
            project_ids.push(project_id);
        }
        // One call: every session is checked before anything is deleted.
        let changes = delete_projects_locked(&mut store, &project_ids, SessionEnd::Project)?;
        store
            .db
            .execute("DELETE FROM agent_project_groups WHERE id=?1", [group_id])
            .map_err(|e| e.to_string())?;
        drop(store);
        // Before closing orphaned SSH connections, and never through a disconnected server.
        let retained_folder = folder.and_then(|(project, reachable)| {
            (!reachable || !remove_empty_group_directory(&project.environment, &project.path))
                .then_some(project.path)
        });
        let (blocked, unblocked, orphaned) = changes;
        apply_connection_changes(blocked, unblocked, orphaned);
        Ok(AgentProjectGroupDeletion { retained_folder })
    }
}
