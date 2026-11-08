#[cfg(windows)]
use super::probe_output;
use super::{retention, AgentProject, Result};
use rusqlite::Connection;
use std::path::Path;

#[cfg(any(windows, test))]
pub(super) fn wsl_command(
    distribution: &str,
    program: &str,
    args: &[&str],
) -> std::process::Command {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .args(["--distribution", distribution, "--exec", program])
        .args(args);
    command
}

#[cfg(windows)]
fn wsl_path(distribution: &str, path: &Path) -> Result<String> {
    let path = path
        .to_str()
        .ok_or("Le chemin des fichiers de conversation n’est pas Unicode.")?;
    let output = probe_output(wsl_command(distribution, "wslpath", &["-a", "-u", path]))?;
    let path = String::from_utf8(output)
        .map_err(|_| "Réponse wslpath non UTF-8.".to_string())?
        .trim_end_matches(['\r', '\n'])
        .to_owned();
    if !path.starts_with('/') || path.len() > 4096 || path.contains('\0') {
        return Err("wslpath a retourné un chemin de conversation invalide.".into());
    }
    Ok(path)
}

pub(super) fn execution_path(project: &AgentProject, path: &Path) -> Result<String> {
    if project.environment.kind == "ssh" {
        return Err("Un chemin local ne peut pas être utilisé dans un environnement SSH.".into());
    }
    if project.environment.kind == "wsl" {
        #[cfg(windows)]
        return wsl_path(project.environment.distribution.as_deref().unwrap(), path);
        #[cfg(not(windows))]
        return Err("WSL est disponible uniquement sous Windows.".into());
    }
    let path = path
        .to_str()
        .ok_or("Le chemin des fichiers de conversation n’est pas Unicode.")?;
    if !Path::new(path).is_absolute() {
        return Err("Le chemin des fichiers de conversation doit être absolu.".into());
    }
    Ok(path.into())
}

pub(super) fn remote_run_directory(db: &Connection, project: &AgentProject) -> Result<String> {
    let output = crate::ssh::run(
        project
            .environment
            .ssh
            .as_ref()
            .ok_or("Connexion SSH manquante.")?,
        &retention::remote_run_directory_script(db),
        None,
        4096,
    )?;
    let path = String::from_utf8(output)
        .map_err(|_| {
            "Réponse SSH non UTF-8 lors de la création du dossier de conversation distant."
                .to_string()
        })?
        .trim_end_matches(['\r', '\n'])
        .to_owned();
    crate::ssh::validate_path(&path)?;
    Ok(path)
}

pub(super) fn upload_remote(project: &AgentProject, path: &str, data: &[u8]) -> Result<()> {
    crate::ssh::validate_path(path)?;
    crate::ssh::run(
        project
            .environment
            .ssh
            .as_ref()
            .ok_or("Connexion SSH manquante.")?,
        &format!("umask 077; cat > {}", crate::ssh::quote(path)),
        Some(data),
        4096,
    )?;
    Ok(())
}
