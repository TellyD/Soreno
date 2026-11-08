use super::{
    appearance, conversation, conversations, id, text, validate_environment, validate_linux_path,
    AgentProject, AgentSession, RemoteHost, Result,
};
use std::path::Path;

pub(crate) fn validate_project(project: &AgentProject) -> Result<()> {
    id(&project.id)?;
    text(&project.name, "Nom du projet", 256)?;
    text(&project.path, "Dossier", 4096)?;
    validate_environment(&project.environment)?;
    appearance::validate_appearance(
        project.icon.as_deref(),
        project.color.as_deref(),
        project.icon_data_url.as_deref(),
    )?;
    match project.environment.kind.as_str() {
        "local" if Path::new(&project.path).is_absolute() => Ok(()),
        "local" => Err("Un projet local exige un chemin absolu.".into()),
        "wsl" => validate_linux_path(&project.path),
        "ssh" => crate::ssh::validate_path(&project.path),
        _ => Err("Environnement inconnu.".into()),
    }
}

pub(super) fn validate_session(session: &AgentSession) -> Result<()> {
    id(&session.id)?;
    id(&session.project_id)?;
    text(&session.name, "Nom de session", 256)?;
    if (session.kind == conversation::KIND) != (session.executable == conversation::EXECUTABLE) {
        return Err("Seule une conversation OMP lance omp-conversation.".into());
    }
    if let Some(custom_name) = &session.custom_name {
        text(custom_name, "Nom de session", 256)?;
    }
    if session.design && session.kind != "terminal" {
        return Err("Seule une session terminal peut porter un tableau Design.".into());
    }
    match session.kind.as_str() {
        "terminal" if session.service_id.is_none() && session.working_directory.is_none() => {}
        "terminal" => {
            return Err(
                "Une session terminal ne peut pas définir de service ni de dossier de travail."
                    .into(),
            )
        }
        "service" => {
            id(session
                .service_id
                .as_deref()
                .ok_or("Identifiant de service manquant.")?)?;
            text(
                session
                    .working_directory
                    .as_deref()
                    .ok_or("Dossier de travail du service manquant.")?,
                "Dossier de travail du service",
                4096,
            )?;
            if session.executable.is_empty() {
                return Err("Un service exige un exécutable.".into());
            }
        }
        conversation::KIND
            if session.args.is_empty()
                && session.service_id.is_none()
                && session.working_directory.is_none() => {}
        conversation::KIND => {
            return Err(
                "Une conversation OMP n’accepte ni argument, ni service, ni dossier de travail."
                    .into(),
            )
        }
        _ => return Err("Type de session inconnu.".into()),
    }
    if session.executable.is_empty() {
        if !session.args.is_empty() {
            return Err("Le terminal par défaut n’accepte pas d’arguments.".into());
        }
    } else {
        text(&session.executable, "Exécutable", 4096)?;
        if session.executable.starts_with('-') || session.executable.contains(['\r', '\n']) {
            return Err("Indiquez un seul nom ou chemin d’exécutable, sans options.".into());
        }
    }
    validate_launch_args(session.args.iter().map(String::as_str))?;
    text(&session.created_at, "Date de création", 64)?;
    chrono::DateTime::parse_from_rfc3339(&session.created_at)
        .map_err(|_| "Date de création invalide (RFC3339 attendu).")?;
    Ok(())
}
pub(super) fn validate_launch_args<'a>(args: impl IntoIterator<Item = &'a str>) -> Result<()> {
    let (mut count, mut bytes) = (0, 0);
    for arg in args {
        count += 1;
        bytes += arg.len();
        if count > 256 || bytes > 64 * 1024 || arg.contains('\0') {
            return Err(
                "Arguments invalides (256 arguments et 64 Kio maximum, sans caractère nul).".into(),
            );
        }
    }
    Ok(())
}
pub(super) fn validate_initial_prompt(
    session: &AgentSession,
    prompt: &str,
    remote_host: Option<RemoteHost>,
) -> Result<()> {
    if session.kind == "service"
        || remote_host == Some(RemoteHost::Live)
        || conversations::provider(&session.executable).is_none()
    {
        return Err(conversations::INITIAL_PROMPT_MESSAGE.into());
    }
    validate_launch_args(
        session
            .args
            .iter()
            .map(String::as_str)
            .chain(["--", prompt]),
    )
}
