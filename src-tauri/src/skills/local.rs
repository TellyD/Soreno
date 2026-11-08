use super::{
    RawListing, RawSkillEntry, SkillDirectories, SkillScope, SkillsError, LOCK_LIMIT,
    SKILL_MD_LIMIT,
};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub(super) fn list(scope: SkillScope, root: &Path) -> Result<RawListing, SkillsError> {
    let directories = match scope {
        SkillScope::Global => global_directories(
            root,
            std::env::var_os("CLAUDE_CONFIG_DIR").as_deref(),
            std::env::var_os("CODEX_HOME").as_deref(),
        ),
        SkillScope::Project => SkillDirectories::project(),
    };
    read_listing(scope, root, directories)
}

pub(super) fn read_listing(
    scope: SkillScope,
    root: &Path,
    directories: SkillDirectories,
) -> Result<RawListing, SkillsError> {
    if !root.is_dir() {
        return Err(SkillsError::new(
            "missingDirectory",
            format!("Le dossier {} est introuvable.", root.display()),
        ));
    }
    let mut entries = Vec::new();
    for directory in &directories.listed {
        let Ok(children) = std::fs::read_dir(root.join(directory)) else {
            continue;
        };
        let mut children: Vec<_> = children.filter_map(Result::ok).collect();
        children.sort_by_key(|child| child.file_name());
        for child in children {
            let Ok(name) = child.file_name().into_string() else {
                continue;
            };
            let skill_md = child.path().join("SKILL.md");
            if name.starts_with('.') || !skill_md.is_file() {
                continue;
            }
            let Ok(skill_md) = read_bounded(&skill_md, SKILL_MD_LIMIT) else {
                continue;
            };
            entries.push(RawSkillEntry {
                directory: directory.clone(),
                name,
                skill_md,
            });
        }
    }
    let lock = read_bounded(&lock_path(scope, root), LOCK_LIMIT).ok();
    Ok(RawListing {
        directories,
        entries,
        lock,
    })
}

/// Mirrors the skills CLI, which reads `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (run from `home`)
/// and resolves them with Node's lexical `path.join`.
pub(super) fn global_directories(
    home: &Path,
    claude: Option<&OsStr>,
    codex: Option<&OsStr>,
) -> SkillDirectories {
    SkillDirectories::global(
        agent_directory(home, claude, super::DEFAULT_CLAUDE_DIRECTORY),
        agent_directory(home, codex, super::DEFAULT_CODEX_DIRECTORY),
    )
}

fn agent_directory(home: &Path, configured: Option<&OsStr>, default: &str) -> String {
    let configured = configured.map(OsStr::to_string_lossy);
    let configured = configured.as_deref().map(str::trim).unwrap_or_default();
    if configured.is_empty() {
        return default.into();
    }
    let home = normalize_lexically(home);
    let path = normalize_lexically(&home.join(configured).join("skills"));
    let relative = path.strip_prefix(&home).ok().and_then(|relative| {
        relative
            .components()
            .map(|component| match component {
                Component::Normal(part) => Some(part.to_string_lossy()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
    });
    match relative {
        Some(parts) => parts.join("/"),
        None => path.display().to_string(),
    }
}

/// Resolves `.` and `..` segments without touching the filesystem, like Node's `path.join`.
/// A `..` is dropped only at a root; a drive-relative prefix (`C:..`) keeps it.
pub(super) fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match normalized.components().next_back() {
                Some(Component::Normal(_)) => {
                    normalized.pop();
                }
                Some(Component::RootDir) => {}
                _ => normalized.push(Component::ParentDir),
            },
            component => normalized.push(component),
        }
    }
    normalized
}

fn lock_path(scope: SkillScope, root: &Path) -> PathBuf {
    match scope {
        SkillScope::Global => std::env::var_os("XDG_STATE_HOME")
            .filter(|state| !state.is_empty())
            .map(|state| PathBuf::from(state).join("skills").join(".skill-lock.json"))
            .unwrap_or_else(|| root.join(".agents").join(".skill-lock.json")),
        SkillScope::Project => root.join("skills-lock.json"),
    }
}

fn read_bounded(path: &Path, limit: u64) -> std::io::Result<String> {
    let mut content = Vec::new();
    std::fs::File::open(path)?
        .take(limit)
        .read_to_end(&mut content)?;
    Ok(String::from_utf8_lossy(&content).into_owned())
}
