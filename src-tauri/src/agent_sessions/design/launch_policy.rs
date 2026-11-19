use super::super::{codex_overrides, conversations::Provider, Result};

const RESTRICTION_FAILED: &str = "Impossible de restreindre l’agent Design à son dossier privé : le chemin de ce dossier contient un caractère non pris en charge.";

/// Confines a design agent: it reads anything, writes only in its private `directory`, runs no
/// command but copy, move and list, and is never stopped by a permission prompt.
pub(in crate::agent_sessions) fn restrict_launch(
    args: &mut Vec<String>,
    provider: Provider,
    directory: &str,
    windows_local: bool,
) -> Result<()> {
    let restrictions = match provider {
        Provider::Claude => {
            // Claude matches absolute paths as `//path`, Windows ones as `//c/Users/…`.
            let path = match directory.as_bytes() {
                [drive, b':', b'\\' | b'/', ..] if windows_local => format!(
                    "{}/{}",
                    (*drive as char).to_ascii_lowercase(),
                    directory[3..].replace('\\', "/")
                ),
                _ => directory.trim_start_matches('/').to_owned(),
            };
            // Its rule list splits on commas and spaces outside parentheses only.
            if path.contains(['(', ')']) {
                return Err(RESTRICTION_FAILED.into());
            }
            // Rules match gitignore-style patterns: the folder's own name is taken literally.
            let path = path
                .trim_end_matches('/')
                .split('/')
                .map(|segment| {
                    segment
                        .chars()
                        .enumerate()
                        .fold(String::new(), |mut escaped, (index, ch)| {
                            if matches!(ch, '[' | ']' | '*' | '?' | '\\')
                                || (index == 0 && ch == '!')
                            {
                                escaped.push('\\');
                            }
                            escaped.push(ch);
                            escaped
                        })
                })
                .collect::<Vec<_>>()
                .join("/");
            vec![
                // shortcut: allow rules from the user's own Claude settings still apply; isolate
                // permissions without dropping their auth and env if users need a stricter designer.
                "--permission-mode".into(),
                "dontAsk".into(),
                format!("--allowedTools=Read,Glob,Grep,Edit(//{path}/**),Write(//{path}/**),Bash(cp *),Bash(mv *),Bash(ls *)"),
            ]
        }
        Provider::Codex => {
            let encode = |text: &str| {
                codex_overrides::toml_string(text, windows_local)
                    .ok_or_else(|| RESTRICTION_FAILED.to_owned())
            };
            vec![
                "--ask-for-approval".into(),
                "never".into(),
                "-c".into(),
                format!("default_permissions={}", encode("soreno_design")?),
                "-c".into(),
                format!(
                    "permissions.soreno_design.filesystem={{{}={},{}={}}}",
                    encode(":root")?,
                    encode("read")?,
                    encode(directory)?,
                    encode("write")?
                ),
            ]
        }
        Provider::Omp => vec![
            "--tools=read,grep,glob,edit,write".into(),
            "--approval-mode=yolo".into(),
        ],
        Provider::Pi => vec!["--tools".into(), "read,grep,find,ls,edit,write".into()],
    };
    args.splice(0..0, restrictions);
    Ok(())
}
