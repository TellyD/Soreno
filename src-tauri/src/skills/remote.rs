use super::{
    RawListing, RawSkillEntry, RemoteRoot, SkillDirectories, SkillScope, SkillsError, LOCK_LIMIT,
    SKILL_MD_LIMIT,
};
use crate::{
    codex_cli::process::CommandOutput,
    ssh::{quote, SshConnection},
};
use std::time::Duration;

pub(super) const LIST_LIMIT: usize = 8 * 1024 * 1024;
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const MISSING_ROOT_MARKER: &str = "SORENO_SKILLS_MISSING_ROOT";

pub(super) fn root_expression(root: &RemoteRoot) -> String {
    match root {
        RemoteRoot::Home => "\"$HOME\"".into(),
        RemoteRoot::Path(path) => quote(path),
    }
}

/// Mirrors the skills CLI: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (trimmed, relative to the
/// home directory where it runs, `.`/`..` resolved lexically like Node's `path.join`)
/// relocate those agents' skills. Prints the directory, relative to `$root` when inside it.
const AGENT_SKILLS_FUNCTION: &str = r#"normalize_path() {
  rest=$1; n=
  case $rest in /*) absolute=1 ;; *) absolute= ;; esac
  while [ -n "$rest" ]; do
    segment=${rest%%/*}
    case $rest in */*) rest=${rest#*/} ;; *) rest= ;; esac
    case $segment in
      ''|.) ;;
      ..)
        case $n in
          ''|..|*/..) if [ -z "$absolute" ]; then n=${n:+$n/}..; fi ;;
          */*) n=${n%/*} ;;
          *) n= ;;
        esac ;;
      *) n=${n:+$n/}$segment ;;
    esac
  done
  if [ -n "$absolute" ]; then n=/$n; elif [ -z "$n" ]; then n=.; fi
}
agent_skills() {
  v=$1
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  if [ -z "$v" ]; then printf '%s' "$2"; return; fi
  case $v in /*) ;; *) v=$root/$v ;; esac
  normalize_path "$root"; base=${n%/}
  normalize_path "$v/skills"; v=$n
  case $v in "$base"/*) v=${v#"$base"/} ;; esac
  printf '%s' "$v"
}"#;

/// Prints `L\0<lock>\0`, for global targets `G\0<claude dir>\0<codex dir>\0`, then one
/// `S\0<dir>\0<name>\0<SKILL.md>\0` per skill.
pub(super) fn list_script(scope: SkillScope, root: &RemoteRoot) -> String {
    let (lock, setup, directories) = match scope {
        SkillScope::Global => (
            r#"if [ -n "${XDG_STATE_HOME:-}" ]; then lock="$XDG_STATE_HOME/skills/.skill-lock.json"; else lock="$root/.agents/.skill-lock.json"; fi"#,
            format!(
                r#"{AGENT_SKILLS_FUNCTION}
claude=$(agent_skills "${{CLAUDE_CONFIG_DIR:-}}" {claude})
codex=$(agent_skills "${{CODEX_HOME:-}}" {codex})
printf 'G\000%s\000%s\000' "$claude" "$codex"
"#,
                claude = quote(super::DEFAULT_CLAUDE_DIRECTORY),
                codex = quote(super::DEFAULT_CODEX_DIRECTORY),
            ),
            [
                quote(super::AGENTS_DIRECTORY),
                "\"$claude\"".into(),
                "\"$codex\"".into(),
            ]
            .into_iter()
            .chain(super::OTHER_GLOBAL_DIRECTORIES.map(quote))
            .collect::<Vec<_>>(),
        ),
        SkillScope::Project => (
            r#"lock="$root/skills-lock.json""#,
            String::new(),
            SkillDirectories::project()
                .listed
                .iter()
                .map(|directory| quote(directory))
                .collect(),
        ),
    };
    format!(
        r#"root={root}
[ -d "$root" ] || {{ printf '%s\n' {MISSING_ROOT_MARKER} >&2; exit 3; }}
{lock}
if [ -f "$lock" ]; then printf 'L\000'; head -c {LOCK_LIMIT} "$lock" | tr -d '\000'; printf '\000'; fi
{setup}for dir in {directories}; do
  case $dir in /*) base=$dir ;; *) base=$root/$dir ;; esac
  for entry in "$base"/*; do
    [ -f "$entry/SKILL.md" ] || continue
    name=${{entry##*/}}
    case $name in .*) continue ;; esac
    printf 'S\000%s\000%s\000' "$dir" "$name"
    head -c {SKILL_MD_LIMIT} "$entry/SKILL.md" | tr -d '\000'
    printf '\000'
  done
done
"#,
        root = root_expression(root),
        directories = directories.join(" "),
    )
}

pub(super) fn parse_listing(scope: SkillScope, output: &[u8]) -> Result<RawListing, SkillsError> {
    let malformed = || SkillsError::new("io", "Réponse de listage des skills invalide.");
    let mut listing = RawListing {
        directories: SkillDirectories::default_for(scope),
        entries: Vec::new(),
        lock: None,
    };
    if output.is_empty() {
        return Ok(listing);
    }
    let body = output.strip_suffix(b"\0").ok_or_else(malformed)?;
    let text = |field: &[u8]| String::from_utf8_lossy(field).into_owned();
    let mut fields = body.split(|byte| *byte == 0);
    while let Some(tag) = fields.next() {
        match tag {
            b"L" => listing.lock = Some(text(fields.next().ok_or_else(malformed)?)),
            b"G" if scope == SkillScope::Global && listing.entries.is_empty() => {
                let mut next = || fields.next().map(text).ok_or_else(malformed);
                let claude = next()?;
                let codex = next()?;
                if claude.is_empty() || codex.is_empty() {
                    return Err(malformed());
                }
                listing.directories = SkillDirectories::global(claude, codex);
            }
            b"S" => {
                let mut next = || fields.next().map(text).ok_or_else(malformed);
                let directory = next()?;
                let name = next()?;
                let skill_md = next()?;
                if !listing.directories.listed.contains(&directory)
                    || name.is_empty()
                    || name.contains('/')
                {
                    return Err(malformed());
                }
                listing.entries.push(RawSkillEntry {
                    directory,
                    name,
                    skill_md,
                });
            }
            _ => return Err(malformed()),
        }
    }
    Ok(listing)
}

fn listing_output(
    scope: SkillScope,
    root: &RemoteRoot,
    host_code: &str,
    success: bool,
    stdout: &[u8],
    stderr: &str,
) -> Result<RawListing, SkillsError> {
    if success {
        return parse_listing(scope, stdout);
    }
    if stderr.contains(MISSING_ROOT_MARKER) {
        return Err(SkillsError::new(
            "missingDirectory",
            match root {
                RemoteRoot::Home => "Le dossier personnel distant est introuvable.".into(),
                RemoteRoot::Path(path) => format!("Le dossier {path} est introuvable."),
            },
        ));
    }
    Err(SkillsError::new(
        host_code,
        format!("Lecture des skills impossible : {}", stderr.trim()),
    ))
}

fn ssh_error(message: String) -> SkillsError {
    if message.contains("Délai SSH") {
        SkillsError::new("timeout", message)
    } else {
        SkillsError::new("ssh", message)
    }
}

pub(super) fn list_ssh(
    scope: SkillScope,
    connection: &SshConnection,
    root: &RemoteRoot,
) -> Result<RawListing, SkillsError> {
    let output = crate::ssh::run_read_output_with_timeout(
        connection,
        &list_script(scope, root),
        None,
        LIST_LIMIT,
        LIST_TIMEOUT,
    )
    .map_err(ssh_error)?;
    listing_output(
        scope,
        root,
        "ssh",
        output.status == 0,
        &output.stdout,
        &String::from_utf8_lossy(&output.stderr),
    )
}

pub(super) fn list_wsl(
    scope: SkillScope,
    distribution: &str,
    root: &RemoteRoot,
) -> Result<RawListing, SkillsError> {
    let output = run_wsl(
        distribution,
        &list_script(scope, root),
        LIST_TIMEOUT,
        LIST_LIMIT as u64,
    )?;
    listing_output(
        scope,
        root,
        "wsl",
        output.status.success(),
        output.stdout.as_bytes(),
        &output.stderr,
    )
}

#[cfg(windows)]
pub(super) fn run_wsl(
    distribution: &str,
    script: &str,
    timeout: Duration,
    stdout_limit: u64,
) -> Result<CommandOutput, SkillsError> {
    use crate::codex_cli::process::{run_command_output, CommandFailure};

    let mut command = crate::codex_cli::hidden_command("wsl.exe");
    crate::agent_sessions::wsl_root_script(&mut command, distribution, script)
        .env_remove("WSL_UTF8");
    run_command_output(&mut command, timeout, true, stdout_limit).map_err(|failure| match failure {
        CommandFailure::Timeout => SkillsError::new(
            "timeout",
            "L’opération sur les skills a dépassé le délai imparti.",
        ),
        CommandFailure::Io(error) => {
            SkillsError::new("wsl", format!("Impossible de lancer WSL : {error}"))
        }
    })
}

#[cfg(not(windows))]
pub(super) fn run_wsl(
    _distribution: &str,
    _script: &str,
    _timeout: Duration,
    _stdout_limit: u64,
) -> Result<CommandOutput, SkillsError> {
    Err(SkillsError::new(
        "wsl",
        "WSL est disponible uniquement sous Windows.",
    ))
}
