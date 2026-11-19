//! Per-project history for local bash and zsh terminals.
use std::ffi::OsStr;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

// Startup files of a ZDOTDIR wrapper forwarding to the user's own: a system zshrc (macOS)
// assigns HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history, so .zshrc puts back the value it replaced.
// shortcut: a user file running `unsetopt rcs` skips .zshrc, leaving ZDOTDIR on the wrapper; restore it after each file if reported.
const ZSH_WRAPPER: [(&str, &str); 3] = [
    (
        ".zshenv",
        r#"_soreno_zdotdir=$ZDOTDIR
[[ ${SORENO_ZDOTDIR-} == "$ZDOTDIR" ]] && unset SORENO_ZDOTDIR
if [[ -n ${SORENO_ZDOTDIR-} ]]; then ZDOTDIR=$SORENO_ZDOTDIR; else unset ZDOTDIR; fi
[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && source "${ZDOTDIR:-$HOME}/.zshenv"
SORENO_ZDOTDIR=${ZDOTDIR-}
ZDOTDIR=$_soreno_zdotdir
"#,
    ),
    (
        ".zprofile",
        r#"if [[ -n ${SORENO_ZDOTDIR-} ]]; then ZDOTDIR=$SORENO_ZDOTDIR; else unset ZDOTDIR; fi
[[ -r ${ZDOTDIR:-$HOME}/.zprofile ]] && source "${ZDOTDIR:-$HOME}/.zprofile"
SORENO_ZDOTDIR=${ZDOTDIR-}
ZDOTDIR=$_soreno_zdotdir
_soreno_histfile=${HISTFILE-}
"#,
    ),
    (
        ".zshrc",
        r#"[[ ${HISTFILE-} == "$ZDOTDIR/.zsh_history" ]] && HISTFILE=$_soreno_histfile
if [[ -n ${SORENO_ZDOTDIR-} ]]; then ZDOTDIR=$SORENO_ZDOTDIR; else unset ZDOTDIR; fi
unset SORENO_ZDOTDIR _soreno_zdotdir _soreno_histfile
[[ -r ${ZDOTDIR:-$HOME}/.zshrc ]] && source "${ZDOTDIR:-$HOME}/.zshrc"
"#,
    ),
];

pub(super) fn root(links_dir: &Path) -> PathBuf {
    links_dir
        .parent()
        .unwrap_or(links_dir)
        .join("terminal-history")
}

fn project_directory(root: &Path, project_id: &str) -> PathBuf {
    root.join(super::remote_host::key(project_id))
}

/// Variables for the interactive shell of a local terminal; none when the user's
/// environment already sets HISTFILE, or for shells without one (fish, sh).
pub(super) fn environment(root: &Path, project_id: &str, shell: &OsStr) -> Vec<(String, String)> {
    let shell = Path::new(shell)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    let zsh = shell.starts_with("zsh");
    if !zsh && !shell.starts_with("bash") {
        return Vec::new();
    }
    // A HISTFILE inherited from a Soreno terminal (nested launch) belongs to that project.
    if std::env::var_os("HISTFILE").is_some() && std::env::var_os("SORENO_AGENT_RUN").is_none() {
        return Vec::new();
    }
    match prepare(root, project_id, zsh) {
        Ok(environment) => environment,
        Err(error) => {
            eprintln!("Historique du terminal : {error}");
            Vec::new()
        }
    }
}

pub(super) fn prepare(
    root: &Path,
    project_id: &str,
    zsh: bool,
) -> std::io::Result<Vec<(String, String)>> {
    let directory = project_directory(root, project_id);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)?;
    let text = |path: &Path| {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "chemin non UTF-8"))
    };
    let file = directory.join(if zsh { "zsh_history" } else { "bash_history" });
    let mut environment = vec![("HISTFILE".to_owned(), text(&file)?)];
    if zsh {
        let wrapper = root.join("zsh");
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&wrapper)?;
        for (name, content) in ZSH_WRAPPER {
            let path = wrapper.join(name);
            // Rewriting a file a starting shell is reading would truncate it.
            if std::fs::read(&path).ok().as_deref() != Some(content.as_bytes()) {
                std::fs::write(&path, content)?;
            }
        }
        environment.push(("ZDOTDIR".to_owned(), text(&wrapper)?));
    }
    Ok(environment)
}

pub(super) fn remove(root: &Path, project_id: &str) {
    match std::fs::remove_dir_all(project_directory(root, project_id)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            eprintln!("Suppression de l’historique du terminal : {error}");
        }
        _ => {}
    }
}
