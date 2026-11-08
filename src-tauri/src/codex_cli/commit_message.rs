use super::{execution, format_codex_error};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(55);
const OUTPUT_LIMIT: usize = 8 * 1024;

pub(crate) fn generate(
    prompt: &str,
    model: Option<&str>,
    fast_mode: bool,
) -> Result<String, String> {
    let result = execution::run(model, fast_mode, prompt, TIMEOUT, OUTPUT_LIMIT)
        .map_err(execution::format_execution_error)?;

    if !result.status.success() {
        return Err(format_codex_error(&result.stderr, result.status));
    }
    match result.last_message {
        Ok(Some(message)) => Ok(message),
        Ok(None) => Err("Codex a retourné un message de commit vide.".into()),
        Err(execution::CodexOutputError::Read(error)) => {
            Err(format!("Impossible de lire le message Codex : {error}"))
        }
        Err(execution::CodexOutputError::TooLong) => {
            Err("Le message généré par Codex est trop long.".into())
        }
        Err(execution::CodexOutputError::InvalidUtf8) => {
            Err("Le message généré par Codex n’est pas UTF-8.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "soreno-codex-commit-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn command_uses_the_given_model_and_is_ephemeral_read_only_offline_and_low_effort() {
        let output = path("command");
        let command = execution::build_command(Path::new("codex"), Some("gpt-5.5"), true, &output);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for pair in [
            ["--model", "gpt-5.5"],
            ["--sandbox", "read-only"],
            ["--ask-for-approval", "never"],
            ["-c", "features.shell_tool=false"],
            ["-c", "features.unified_exec=false"],
            ["-c", "features.multi_agent=false"],
            ["-c", "features.view_image=false"],
            ["-c", "project_doc_max_bytes=0"],
            ["-c", "web_search=\"disabled\""],
            ["-c", "model_reasoning_effort=\"low\""],
        ] {
            assert!(args.windows(2).any(|window| window == pair));
        }
        assert!(args.iter().any(|arg| arg == "--ephemeral"));
        assert!(args.iter().any(|arg| arg == "--ignore-user-config"));
        assert!(args.iter().any(|arg| arg == "--skip-git-repo-check"));
        assert!(args.iter().any(|arg| arg == "--json"));
        assert_eq!(
            command.get_current_dir(),
            Some(std::env::temp_dir().as_path())
        );
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn command_lets_codex_choose_the_model_by_default() {
        let output = path("default-model");
        let command = execution::build_command(Path::new("codex"), None, true, &output);
        assert!(!command.get_args().any(|arg| arg == "--model"));
    }

    #[test]
    fn command_enables_codex_fast_mode_only_when_requested() {
        let output = path("fast");
        let fast_args = |fast_mode| {
            let args = execution::build_command(Path::new("codex"), None, fast_mode, &output)
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            [
                ["-c", "features.fast_mode=true"],
                ["-c", "service_tier=\"fast\""],
            ]
            .map(|pair| args.windows(2).any(|window| window == pair))
        };
        assert_eq!(fast_args(true), [true, true]);
        assert_eq!(fast_args(false), [false, false]);
    }

    #[test]
    #[ignore = "Calls the installed Codex CLI with synthetic data; requires authentication and network"]
    fn native_commit_message_smoke() {
        let message = generate(
            "Return only a short imperative Git commit message for this synthetic staged diff. Do not use tools.\n\
             diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-Helo\n+Hello\n",
            None,
            true,
        )
        .unwrap();
        assert!(!message.trim().is_empty());
        println!("Generated commit message: {message}");
    }
}
