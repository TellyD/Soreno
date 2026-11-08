use crate::{agent_sessions::AgentProject, ssh::SshConnection};
use serde::Serialize;
use std::{collections::HashSet, path::PathBuf};

mod local;
mod remote;

const SKILL_MD_LIMIT: u64 = 16 * 1024;
const LOCK_LIMIT: u64 = 512 * 1024;
const AGENTS_DIRECTORY: &str = ".agents/skills";
const DEFAULT_CLAUDE_DIRECTORY: &str = ".claude/skills";
const DEFAULT_CODEX_DIRECTORY: &str = ".codex/skills";
const OTHER_GLOBAL_DIRECTORIES: [&str; 2] = [".pi/agent/skills", ".omp/agent/skills"];
const PROJECT_DIRECTORIES: [&str; 4] = [
    AGENTS_DIRECTORY,
    DEFAULT_CLAUDE_DIRECTORY,
    ".pi/skills",
    ".omp/skills",
];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInventory {
    pub skills: Vec<InstalledSkill>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub source: Option<SkillSource>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub lock_name: String,
    pub source: String,
    pub source_type: String,
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillsError {
    pub code: String,
    pub message: String,
}

impl SkillsError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SkillScope {
    Global,
    Project,
}

impl SkillScope {
    pub(crate) fn parse(value: &str) -> Result<Self, SkillsError> {
        match value {
            "global" => Ok(Self::Global),
            "project" => Ok(Self::Project),
            _ => Err(SkillsError::new(
                "invalidTarget",
                "Portée de skills inconnue.",
            )),
        }
    }
}

/// Skill directories of a target in display order, relative to its root except for a
/// global agent directory relocated outside the home directory, which stays absolute.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SkillDirectories {
    pub listed: Vec<String>,
}

impl SkillDirectories {
    fn new(directories: impl IntoIterator<Item = String>) -> Self {
        let mut listed: Vec<String> = Vec::new();
        for directory in directories {
            if !listed.contains(&directory) {
                listed.push(directory);
            }
        }
        Self { listed }
    }

    pub(crate) fn project() -> Self {
        Self::new(PROJECT_DIRECTORIES.map(str::to_owned))
    }

    /// `claude` and `codex` are the resolved Claude Code and Codex skill directories.
    pub(crate) fn global(claude: String, codex: String) -> Self {
        Self::new(
            [AGENTS_DIRECTORY.into(), claude, codex]
                .into_iter()
                .chain(OTHER_GLOBAL_DIRECTORIES.map(str::to_owned)),
        )
    }

    pub(crate) fn default_for(scope: SkillScope) -> Self {
        match scope {
            SkillScope::Global => Self::global(
                DEFAULT_CLAUDE_DIRECTORY.into(),
                DEFAULT_CODEX_DIRECTORY.into(),
            ),
            SkillScope::Project => Self::project(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RemoteRoot {
    Home,
    Path(String),
}

pub(crate) enum SkillHost {
    Local(PathBuf),
    Ssh(SshConnection, RemoteRoot),
    Wsl(String, RemoteRoot),
}

pub(crate) struct SkillTarget {
    scope: SkillScope,
    host: SkillHost,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct RawSkillEntry {
    pub directory: String,
    pub name: String,
    pub skill_md: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RawListing {
    pub directories: SkillDirectories,
    pub entries: Vec<RawSkillEntry>,
    pub lock: Option<String>,
}

pub(crate) fn resolve_target(
    scope: SkillScope,
    project: Option<&AgentProject>,
) -> Result<SkillTarget, SkillsError> {
    let host =
        match project {
            None if scope == SkillScope::Project => {
                return Err(SkillsError::new(
                    "invalidTarget",
                    "Aucun projet n’est sélectionné.",
                ))
            }
            None => SkillHost::Local(local_home()?),
            Some(project) => {
                let remote_root = match scope {
                    SkillScope::Global => RemoteRoot::Home,
                    SkillScope::Project => RemoteRoot::Path(project.path.clone()),
                };
                match project.environment.kind.as_str() {
                    "local" => SkillHost::Local(match scope {
                        SkillScope::Global => local_home()?,
                        SkillScope::Project => PathBuf::from(&project.path),
                    }),
                    "wsl" => SkillHost::Wsl(
                        project.environment.distribution.clone().ok_or_else(|| {
                            SkillsError::new("wsl", "Distribution WSL manquante.")
                        })?,
                        remote_root,
                    ),
                    "ssh" => SkillHost::Ssh(
                        project
                            .environment
                            .ssh
                            .clone()
                            .ok_or_else(|| SkillsError::new("ssh", "Connexion SSH absente."))?,
                        remote_root,
                    ),
                    _ => {
                        return Err(SkillsError::new(
                            "invalidTarget",
                            "Environnement de projet inconnu.",
                        ))
                    }
                }
            }
        };
    Ok(SkillTarget { scope, host })
}

fn local_home() -> Result<PathBuf, SkillsError> {
    crate::codex_cli::home_dir()
        .ok_or_else(|| SkillsError::new("io", "Dossier personnel introuvable."))
}

pub(crate) fn list(target: &SkillTarget) -> Result<SkillInventory, SkillsError> {
    let listing = match &target.host {
        SkillHost::Local(root) => local::list(target.scope, root)?,
        SkillHost::Ssh(connection, root) => remote::list_ssh(target.scope, connection, root)?,
        SkillHost::Wsl(distribution, root) => remote::list_wsl(target.scope, distribution, root)?,
    };
    Ok(build_inventory(listing))
}

pub(crate) fn build_inventory(listing: RawListing) -> SkillInventory {
    let sources = lock_sources(listing.lock.as_deref());
    let directories = &listing.directories;
    let mut entries = listing.entries;
    entries.sort_by_key(|entry| {
        directories
            .listed
            .iter()
            .position(|directory| *directory == entry.directory)
            .unwrap_or(usize::MAX)
    });
    let mut skills: Vec<InstalledSkill> = Vec::new();
    let mut names: HashSet<String> = HashSet::new();
    for entry in entries {
        if !names.insert(entry.name.clone()) {
            continue;
        }
        let (title, description) = frontmatter_fields(&entry.skill_md);
        let source = sources
            .iter()
            .find(|source| source.lock_name == entry.name)
            .or_else(|| {
                sources
                    .iter()
                    .find(|source| sanitize_skill_name(&source.lock_name) == entry.name)
            })
            .cloned();
        skills.push(InstalledSkill {
            title: title.unwrap_or_else(|| entry.name.clone()),
            name: entry.name,
            description,
            source,
        });
    }
    skills.sort_by(|left, right| {
        left.title
            .to_lowercase()
            .cmp(&right.title.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    SkillInventory { skills }
}

fn lock_sources(lock: Option<&str>) -> Vec<SkillSource> {
    let Some(lock) = lock.and_then(|lock| serde_json::from_str::<serde_json::Value>(lock).ok())
    else {
        return Vec::new();
    };
    let Some(skills) = lock.get("skills").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    skills
        .iter()
        .filter_map(|(lock_name, entry)| {
            Some(SkillSource {
                lock_name: lock_name.clone(),
                source: entry.get("source")?.as_str()?.to_owned(),
                source_type: entry.get("sourceType")?.as_str()?.to_owned(),
                source_url: lock_text(entry, "sourceUrl"),
            })
        })
        .collect()
}

fn lock_text(entry: &serde_json::Value, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

/// Mirrors the directory name the skills CLI derives from a skill name.
fn sanitize_skill_name(name: &str) -> String {
    let mut sanitized = String::with_capacity(name.len());
    let mut in_separator = false;
    for character in name.to_lowercase().chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == '.'
            || character == '_'
        {
            sanitized.push(character);
            in_separator = false;
        } else if !in_separator {
            sanitized.push('-');
            in_separator = true;
        }
    }
    let sanitized: String = sanitized
        .trim_matches(['.', '-'])
        .chars()
        .take(255)
        .collect();
    if sanitized.is_empty() {
        "unnamed-skill".into()
    } else {
        sanitized
    }
}

fn frontmatter_fields(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (None, None);
    }
    let mut body = Vec::new();
    for line in lines {
        if matches!(line.trim_end(), "---" | "...") {
            return (
                frontmatter_value(&body, "name"),
                frontmatter_value(&body, "description"),
            );
        }
        body.push(line);
    }
    (None, None)
}

fn frontmatter_value(lines: &[&str], key: &str) -> Option<String> {
    let index = lines.iter().position(|line| {
        line.strip_prefix(key)
            .is_some_and(|rest| rest.starts_with(':'))
    })?;
    let inline = lines[index][key.len() + 1..].trim();
    let block = inline.starts_with(['>', '|']);
    let continuation = lines[index + 1..]
        .iter()
        .take_while(|line| line.trim().is_empty() || line.starts_with([' ', '\t']))
        .map(|line| line.trim())
        .filter(|line| !line.is_empty());
    let joined = (!block && !inline.is_empty())
        .then_some(inline)
        .into_iter()
        .chain(continuation)
        .collect::<Vec<_>>()
        .join(" ");
    let value = if block { joined } else { unquote(&joined) };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn unquote(value: &str) -> String {
    if value.len() >= 2 {
        if let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
            return inner.replace("\\\"", "\"").replace("\\\\", "\\");
        }
        if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
            return inner.replace("''", "'");
        }
    }
    value.to_owned()
}

pub(crate) fn strip_ansi(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            output.push(character);
            continue;
        }
        match characters.next() {
            Some('[') => {
                for character in characters.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&character) {
                        break;
                    }
                }
            }
            Some(']') => loop {
                match characters.next() {
                    None | Some('\u{7}') => break,
                    Some('\u{1b}') => {
                        characters.next();
                        break;
                    }
                    Some(_) => {}
                }
            },
            _ => {}
        }
    }
    output
}

#[cfg(test)]
#[path = "skills_tests.rs"]
mod tests;
