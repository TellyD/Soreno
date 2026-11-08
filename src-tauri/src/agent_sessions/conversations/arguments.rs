use super::{Provider, Result};

fn conflicting_option(provider: Provider, option: &str) -> bool {
    const PI_OMP: &[&str] = &[
        "--continue",
        "-c",
        "--resume",
        "-r",
        "--no-session",
        "--no-extensions",
        "-ne",
        "--trusted-extension",
        "--mode",
        "--rpc",
        "--print",
        "-p",
        "--fork",
    ];
    match provider {
        Provider::Pi => PI_OMP.contains(&option) || ["--session", "--session-id"].contains(&option),
        Provider::Omp => {
            PI_OMP.contains(&option) || ["--from-claude", "--from-codex"].contains(&option)
        }
        Provider::Claude => [
            "--continue",
            "-c",
            "--resume",
            "-r",
            "--session-id",
            "--fork-session",
            "--from-pr",
            "--settings",
            "--no-session-persistence",
        ]
        .contains(&option),
        Provider::Codex => ["--last", "--dangerously-bypass-hook-trust"].contains(&option),
    }
}

fn value_option(provider: Provider, option: &str) -> bool {
    const PI: &[&str] = &[
        "--provider",
        "--model",
        "-m",
        "--api-key",
        "--system-prompt",
        "--append-system-prompt",
        "--session-dir",
        "--name",
        "-n",
        "--models",
        "--tools",
        "-t",
        "--exclude-tools",
        "-xt",
        "--thinking",
        "--extension",
        "-e",
        "--skill",
        "--prompt-template",
        "--theme",
        "--use-theme",
        "--export",
        "--tui-mode",
        "--subagents-workflow-file",
        "--mcp-config",
    ];
    const OMP: &[&str] = &[
        "--model",
        "--smol",
        "--slow",
        "--plan",
        "--prewalk-into",
        "--plan-yolo-into",
        "--provider",
        "--api-key",
        "--system-prompt",
        "--append-system-prompt",
        "--profile",
        "--alias",
        "--cwd",
        "--config",
        "--add-dir",
        "--session-dir",
        "--models",
        "--tools",
        "--thinking",
        "--service-tier",
        "--hook",
        "--extension",
        "-e",
        "--skills",
        "--export",
        "--max-time",
        "--approval-mode",
        "--plugin-dir",
    ];
    match provider {
        Provider::Pi => PI.contains(&option),
        Provider::Omp => OMP.contains(&option),
        Provider::Claude | Provider::Codex => false,
    }
}

fn value_can_start_with_dash(provider: Provider, option: &str) -> bool {
    provider == Provider::Pi && !matches!(option, "--use-theme" | "--tui-mode")
}

fn flag_option(provider: Provider, option: &str) -> bool {
    const PI: &[&str] = &[
        "--no-tools",
        "-nt",
        "--no-builtin-tools",
        "-nbt",
        "--no-skills",
        "-ns",
        "--no-prompt-templates",
        "-np",
        "--no-themes",
        "--no-context-files",
        "-nc",
        "--list-models",
        "--verbose",
        "--approve",
        "-a",
        "--no-approve",
        "-na",
        "--offline",
        "--help",
        "-h",
        "--version",
        "-v",
        "--plan",
        "--list-sessions",
        "--fast",
    ];
    const OMP: &[&str] = &[
        "--prewalk",
        "--no-prewalk",
        "--plan-yolo",
        "--allow-home",
        "--no-tools",
        "--no-lsp",
        "--no-pty",
        "--hide-thinking",
        "--advisor",
        "--external-thinking",
        "--no-skills",
        "--no-rules",
        "--no-title",
        "--print-thoughts",
        "--auto-approve",
        "--help",
        "-h",
        "--version",
        "-v",
    ];
    match provider {
        Provider::Pi => PI.contains(&option),
        Provider::Omp => OMP.contains(&option),
        Provider::Claude | Provider::Codex => false,
    }
}

fn hook_value_option(provider: Provider, option: &str) -> bool {
    match provider {
        Provider::Claude => [
            "--agent",
            "--agents",
            "--append-system-prompt",
            "--autocompact",
            "--debug-file",
            "--effort",
            "--fallback-model",
            "--input-format",
            "--json-schema",
            "--max-budget-usd",
            "--model",
            "-n",
            "--name",
            "--output-format",
            "--permission-mode",
            "--permission-prompts",
            "--plugin-dir",
            "--plugin-url",
            "--setting-sources",
            "--system-prompt",
            "--system-prompt-file",
            "--append-system-prompt-file",
        ]
        .contains(&option),
        Provider::Codex => [
            "-c",
            "--config",
            "--enable",
            "--disable",
            "--remote",
            "--remote-auth-token-env",
            "-i",
            "--image",
            "-m",
            "--model",
            "--local-provider",
            "-p",
            "--profile",
            "-s",
            "--sandbox",
            "-C",
            "--cd",
            "--add-dir",
            "-a",
            "--ask-for-approval",
        ]
        .contains(&option),
        Provider::Pi | Provider::Omp => false,
    }
}

fn claude_variadic_option(option: &str) -> bool {
    [
        "--add-dir",
        "--allowedTools",
        "--allowed-tools",
        "--betas",
        "--disallowedTools",
        "--disallowed-tools",
        "--file",
        "--mcp-config",
        "--tools",
    ]
    .contains(&option)
}

fn codex_config_conflicts(value: &str) -> bool {
    let value = value.trim_start_matches('=');
    let key = value.split_once('=').map_or(value, |(key, _)| key);
    let key = key
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '\'' | '"'))
        .collect::<String>();
    key == "hooks"
        || key.starts_with("hooks.")
        || key == "features"
        || key.starts_with("features.hooks")
}

fn validate_hook_args(
    args: &[String],
    provider: Provider,
    resuming: bool,
) -> Result<Option<usize>> {
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            return if resuming {
                Err("Les prompts positionnels sont refusés lors d’une reprise afin de ne pas rejouer une demande.".into())
            } else {
                Ok(Some(index))
            };
        }
        if !arg.starts_with('-') {
            if provider == Provider::Codex && matches!(arg.as_str(), "resume" | "fork") {
                return Err("Les sous-commandes de session Codex sont gérées par Soreno.".into());
            }
            if resuming {
                return Err("Les prompts positionnels sont refusés lors d’une reprise afin de ne pas rejouer une demande.".into());
            }
            index += 1;
            continue;
        }
        if provider == Provider::Claude
            && arg.strip_prefix('-').is_some_and(|group| {
                !group.starts_with('-')
                    && group.len() > 1
                    && group
                        .chars()
                        .take_while(|option| !matches!(option, 'n' | 'd'))
                        .any(|option| matches!(option, 'r' | 'c'))
            })
        {
            return Err("Les options de session/reprise sont gérées par Soreno et ne peuvent pas être remplacées.".into());
        }
        if provider == Provider::Codex && arg.starts_with("-c") && arg != "-c" {
            if codex_config_conflicts(&arg[2..]) {
                return Err(
                    "La configuration des hooks de conversation est gérée par Soreno.".into(),
                );
            }
            index += 1;
            continue;
        }
        let (option, inline_value) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(option, value)| {
                (option, Some(value))
            });
        if conflicting_option(provider, option) {
            return Err("Les options de session/reprise sont gérées par Soreno et ne peuvent pas être remplacées.".into());
        }
        if provider == Provider::Claude && claude_variadic_option(option) {
            let mut next = index + 1;
            while next < args.len() && !args[next].starts_with('-') {
                next += 1;
            }
            if inline_value.is_none() && next == index + 1 {
                return Err("Une option du CLI attend une valeur.".into());
            }
            index = next;
            continue;
        }
        if hook_value_option(provider, option) {
            let value = if let Some(value) = inline_value {
                value
            } else {
                index += 1;
                args.get(index)
                    .ok_or("Une option du CLI attend une valeur.")?
            };
            if provider == Provider::Codex
                && ((matches!(option, "-c" | "--config") && codex_config_conflicts(value))
                    || option == "--disable" && value == "hooks")
            {
                return Err(
                    "La configuration des hooks de conversation est gérée par Soreno.".into(),
                );
            }
        }
        index += 1;
    }
    Ok(None)
}

pub(super) fn validate_args(
    args: &[String],
    provider: Provider,
    resuming: bool,
) -> Result<Option<usize>> {
    if provider.uses_hooks() {
        return validate_hook_args(args, provider, resuming);
    }
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            if resuming {
                return Err("Les prompts positionnels sont refusés lors d’une reprise Pi/OMP afin de ne pas rejouer une demande.".into());
            }
            return Ok(Some(index));
        }
        if !arg.starts_with('-') {
            if resuming {
                return Err("Les prompts positionnels sont refusés lors d’une reprise Pi/OMP afin de ne pas rejouer une demande.".into());
            }
            index += 1;
            continue;
        }
        let (option, inline_value) = arg
            .split_once('=')
            .map_or((arg.as_str(), false), |(option, _)| (option, true));
        if conflicting_option(provider, option) {
            return Err("Les options de session/reprise Pi/OMP sont gérées par Soreno et ne peuvent pas être remplacées.".into());
        }
        if value_option(provider, option) {
            if inline_value {
                index += 1;
            } else if index + 1 == args.len()
                || args[index + 1].starts_with('-') && !value_can_start_with_dash(provider, option)
            {
                return Err("Une option Pi/OMP attend une valeur.".into());
            } else {
                index += 2;
            }
            continue;
        }
        if flag_option(provider, option) && !inline_value {
            index += 1;
            continue;
        }
        return Err(format!(
            "Option {arg} non prise en charge pour cette session Pi/OMP."
        ));
    }
    Ok(None)
}

pub(in crate::agent_sessions) fn validate_group_args(args: &[String]) -> Result<()> {
    let managed = args.iter().take_while(|arg| *arg != "--").any(|arg| {
        arg == "--add-dir"
            || arg == "--append-system-prompt"
            || arg.starts_with("--add-dir=")
            || arg.starts_with("--append-system-prompt=")
    });
    if managed {
        return Err(
            "Les dossiers et la consigne de l’agent de groupe sont gérés par Soreno.".into(),
        );
    }
    Ok(())
}
