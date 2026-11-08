#[cfg(any(windows, test))]
use super::AgentProject;
use super::{text, AgentEnvironment, AgentEnvironments, AgentProjectDirectory, Result};
#[cfg(any(windows, test))]
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::{io::Read, thread};

pub(crate) fn validate_environment(environment: &AgentEnvironment) -> Result<()> {
    match environment.kind.as_str() {
        "local" if environment.distribution.is_none() && environment.ssh.is_none() => Ok(()),
        "local" => Err(
            "Un environnement local ne doit pas définir de distribution WSL ni de connexion SSH."
                .into(),
        ),
        "wsl" if environment.ssh.is_none() => {
            text(
                environment
                    .distribution
                    .as_deref()
                    .ok_or("Choisissez une distribution WSL.")?,
                "Distribution",
                256,
            )?;
            if cfg!(windows) {
                Ok(())
            } else {
                Err("WSL est disponible uniquement sous Windows.".into())
            }
        }
        "wsl" => Err("Un environnement WSL ne doit pas définir de connexion SSH.".into()),
        "ssh" if environment.distribution.is_none() => crate::ssh::validate(
            environment
                .ssh
                .as_ref()
                .ok_or("Choisissez une connexion SSH.")?,
        ),
        "ssh" => Err("Un environnement SSH ne doit pas définir de distribution WSL.".into()),
        _ => Err("Environnement inconnu.".into()),
    }
}

fn local_directory_name(path: &Path) -> Result<Option<String>> {
    path.file_name()
        .map(|name| {
            name.to_str()
                .map(str::to_owned)
                .ok_or("Le nom du dossier n’est pas un texte Unicode valide.".into())
        })
        .transpose()
}
pub(super) fn validate_local_directory(path: &str) -> Result<Option<String>> {
    text(path, "Dossier", 4096)?;
    #[cfg(windows)]
    if parse_wsl_unc(path).is_some() {
        return Err("Un dossier WSL doit utiliser l’environnement WSL correspondant.".into());
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("Le dossier local doit utiliser un chemin absolu.".into());
    }
    let metadata = std::fs::metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "Le dossier sélectionné n’existe plus.".into(),
        std::io::ErrorKind::PermissionDenied => {
            "Permission refusée pour lire le dossier sélectionné.".into()
        }
        _ => format!("Impossible de vérifier le dossier sélectionné : {error}"),
    })?;
    if !metadata.is_dir() {
        return Err("Le chemin sélectionné est un fichier, pas un dossier.".into());
    }
    std::fs::read_dir(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::PermissionDenied => {
            "Permission refusée pour parcourir le dossier sélectionné.".into()
        }
        _ => format!("Impossible de parcourir le dossier sélectionné : {error}"),
    })?;
    local_directory_name(path)
}
pub(super) fn posix_directory_name(path: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    (!path.is_empty()).then(|| path.rsplit('/').next().unwrap().to_owned())
}
pub(super) fn validate_linux_path(path: &str) -> Result<()> {
    text(path, "Dossier WSL", 4096)?;
    if !path.starts_with('/') {
        return Err("WSL exige un chemin Linux absolu (ex. /home/vous/projet).".into());
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn parse_wsl_unc(path: &str) -> Option<(&str, String)> {
    let parts: Vec<_> = path.split(['\\', '/']).collect();
    if parts.get(..2)? != ["", ""] {
        return None;
    }
    let server_index = if parts.get(2)? == &"?" && parts.get(3)?.eq_ignore_ascii_case("UNC") {
        4
    } else {
        2
    };
    let server = *parts.get(server_index)?;
    if !server.eq_ignore_ascii_case("wsl.localhost") && !server.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let distribution = *parts.get(server_index + 1)?;
    Some((
        distribution,
        format!("/{}", parts[server_index + 2..].join("/")),
    ))
}
#[cfg(any(windows, test))]
pub(super) fn normalize_wsl_unc_environment(
    environment: &AgentEnvironment,
    path: &str,
) -> Result<(AgentEnvironment, String)> {
    match environment.kind.as_str() {
        "local" if environment.distribution.is_none() && environment.ssh.is_none() => {}
        "local" => return Err(
            "Un environnement local ne doit pas définir de distribution WSL ni de connexion SSH."
                .into(),
        ),
        "wsl" if environment.ssh.is_none() => text(
            environment
                .distribution
                .as_deref()
                .ok_or("Choisissez une distribution WSL.")?,
            "Distribution",
            256,
        )?,
        "ssh" if environment.distribution.is_none() && environment.ssh.is_some() => {
            return Ok((environment.clone(), path.to_owned()))
        }
        _ => return Err("Environnement inconnu ou paramètres incompatibles.".into()),
    }
    let Some((distribution, path)) = parse_wsl_unc(path) else {
        return Ok((environment.clone(), path.to_owned()));
    };
    text(distribution, "Distribution", 256)?;
    if environment.kind == "wsl"
        && !distribution.eq_ignore_ascii_case(environment.distribution.as_deref().unwrap())
    {
        return Err("Ce dossier appartient à une autre distribution WSL. Sélectionnez un dossier dans la bonne distribution.".into());
    }
    Ok((
        if environment.kind == "wsl" {
            environment.clone()
        } else {
            AgentEnvironment {
                kind: "wsl".into(),
                distribution: Some(distribution.into()),
                ssh: None,
            }
        },
        path,
    ))
}
#[cfg(any(windows, test))]
pub(super) fn migrate_local_wsl_unc_projects(db: &mut Connection) -> Result<()> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let updates = {
        let mut stmt = tx
            .prepare("SELECT id,data FROM agent_projects ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut updates = Vec::new();
        for row in rows {
            let (id, data) = row.map_err(|e| e.to_string())?;
            let mut project: AgentProject =
                serde_json::from_str(&data).map_err(|e| e.to_string())?;
            if project.environment.kind == "local" && parse_wsl_unc(&project.path).is_some() {
                (project.environment, project.path) =
                    normalize_wsl_unc_environment(&project.environment, &project.path)?;
                updates.push((
                    id,
                    serde_json::to_string(&project).map_err(|e| e.to_string())?,
                ));
            }
        }
        updates
    };
    for (id, data) in updates {
        tx.execute(
            "UPDATE agent_projects SET data=?1 WHERE id=?2",
            params![data, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
#[cfg(any(windows, test))]
pub(super) fn parse_wsl_path_output(bytes: Vec<u8>) -> Result<String> {
    let mut path = String::from_utf8(bytes).map_err(|_| "Réponse WSL non UTF-8.".to_string())?;
    if path.ends_with('\n') {
        path.pop();
    }
    validate_linux_path(&path)?;
    Ok(path)
}

#[cfg(windows)]
pub(super) fn require_wsl_distribution(distribution: &str) -> Result<()> {
    if discover_wsl()?
        .iter()
        .any(|name| name.eq_ignore_ascii_case(distribution))
    {
        Ok(())
    } else {
        Err("Distribution WSL introuvable. Actualisez les environnements.".into())
    }
}
#[cfg(windows)]
fn probe_wsl_directory(distribution: &str, path: &str) -> Result<()> {
    let mut probe = std::process::Command::new("wsl.exe");
    probe.args([
        "--distribution", distribution, "--cd", path, "--exec", "sh", "-c",
        "test -d \"$1\" || { printf 'Le dossier WSL n’existe pas.\\n' >&2; exit 10; }; test -r \"$1\" || { printf 'Le dossier WSL n’est pas lisible.\\n' >&2; exit 11; }; test -x \"$1\" || { printf 'Le dossier WSL n’est pas accessible.\\n' >&2; exit 12; }; test \"$(pwd -P)\" = \"$(cd -- \"$1\" && pwd -P)\" || { printf 'Le dossier de travail WSL est incorrect.\\n' >&2; exit 13; }",
        "soreno", path,
    ]);
    probe_output(probe).map(|_| ())
}
#[cfg(windows)]
fn validate_wsl_directory(environment: &AgentEnvironment, path: &str) -> Result<Option<String>> {
    validate_linux_path(path)?;
    let distribution = environment.distribution.as_deref().unwrap();
    require_wsl_distribution(distribution)?;
    probe_wsl_directory(distribution, path)?;
    Ok(posix_directory_name(path))
}
#[cfg(not(windows))]
fn validate_wsl_directory(_environment: &AgentEnvironment, _path: &str) -> Result<Option<String>> {
    Err("WSL est disponible uniquement sous Windows.".into())
}
fn validate_ssh_directory(environment: &AgentEnvironment, path: &str) -> Result<Option<String>> {
    text(path, "Dossier SSH", 4096)?;
    crate::ssh::validate_path(path)?;
    let quoted = crate::ssh::quote(path);
    crate::ssh::run(
        environment.ssh.as_ref().ok_or("Connexion SSH manquante.")?,
        &format!(
            "test -d {quoted} || {{ printf 'Le dossier SSH n’existe pas.\\n' >&2; exit 10; }}; test -r {quoted} || {{ printf 'Le dossier SSH n’est pas lisible.\\n' >&2; exit 11; }}; test -x {quoted} || {{ printf 'Le dossier SSH n’est pas accessible.\\n' >&2; exit 12; }}"
        ),
        None,
        4096,
    )?;
    Ok(posix_directory_name(path))
}
pub(crate) fn validate_project_directory(
    environment: &AgentEnvironment,
    path: &str,
) -> Result<Option<String>> {
    validate_environment(environment)?;
    match environment.kind.as_str() {
        "local" => validate_local_directory(path),
        "wsl" => validate_wsl_directory(environment, path),
        "ssh" => validate_ssh_directory(environment, path),
        _ => Err("Environnement inconnu.".into()),
    }
}
#[cfg(any(windows, test))]
pub(super) fn wsl_picker_directory(distribution: &str, current_path: Option<&str>) -> PathBuf {
    let path = current_path
        .filter(|path| path.starts_with('/'))
        .unwrap_or("/");
    PathBuf::from(format!(
        "\\\\wsl.localhost\\{}{}",
        distribution,
        path.replace('/', "\\")
    ))
}
pub(crate) fn project_filesystem_directory(
    environment: &AgentEnvironment,
    path: Option<&str>,
) -> Result<Option<PathBuf>> {
    validate_environment(environment)?;
    if let Some(path) = path {
        if path.len() > 4096 || path.contains('\0') {
            return Err("Dossier trop long ou contenant un caractère nul.".into());
        }
    }
    match environment.kind.as_str() {
        "local" => Ok(path
            .filter(|path| Path::new(path).is_absolute())
            .map(PathBuf::from)),
        "wsl" => {
            #[cfg(windows)]
            return Ok(Some(wsl_picker_directory(
                environment.distribution.as_deref().unwrap(),
                path,
            )));
            #[cfg(not(windows))]
            return Err("WSL est disponible uniquement sous Windows.".into());
        }
        "ssh" => Err("Un dossier SSH ne peut pas être converti en chemin local ni ouvert par le sélecteur natif.".into()),
        _ => Err("Environnement inconnu.".into()),
    }
}
pub(crate) fn picker_default_directory(
    environment: &AgentEnvironment,
    current_path: Option<&str>,
) -> Result<Option<PathBuf>> {
    let directory = project_filesystem_directory(environment, current_path)?;
    #[cfg(windows)]
    if environment.kind == "wsl" {
        require_wsl_distribution(environment.distribution.as_deref().unwrap())?;
    }
    Ok(directory)
}
#[cfg(windows)]
pub(super) fn resolve_wsl_host_path(
    environment: &AgentEnvironment,
    selected: &str,
) -> Result<String> {
    let (environment, selected) = normalize_wsl_unc_environment(environment, selected)?;
    let distribution = environment
        .distribution
        .as_deref()
        .ok_or("Choisissez une distribution WSL.")?;
    require_wsl_distribution(distribution)?;
    if selected.starts_with('/') {
        return Ok(selected);
    }
    if !Path::new(&selected).is_absolute() {
        return Err("Sélectionnez un chemin absolu Windows ou WSL.".into());
    }
    let mut command = std::process::Command::new("wsl.exe");
    command.args([
        "--distribution",
        distribution,
        "--cd",
        "/",
        "--exec",
        "wslpath",
        "-a",
        "-u",
        &selected,
    ]);
    parse_wsl_path_output(probe_output(command)?)
}

pub(crate) fn resolve_picked_project_directory(
    environment: &AgentEnvironment,
    selected: PathBuf,
) -> Result<AgentProjectDirectory> {
    validate_environment(environment)?;
    if environment.kind == "ssh" {
        return Err("Le sélecteur de dossier natif ne prend pas en charge les chemins SSH.".into());
    }
    let selected = selected
        .into_os_string()
        .into_string()
        .map_err(|_| "Le chemin sélectionné n’est pas un texte Unicode valide.")?;
    text(&selected, "Dossier", 4096)?;
    #[cfg(windows)]
    let (environment, selected) = normalize_wsl_unc_environment(environment, &selected)?;
    #[cfg(not(windows))]
    let environment = environment.clone();
    let path = match environment.kind.as_str() {
        "local" => selected,
        "wsl" => {
            #[cfg(windows)]
            {
                resolve_wsl_host_path(&environment, &selected)?
            }
            #[cfg(not(windows))]
            unreachable!()
        }
        _ => unreachable!(),
    };
    let suggested_name = match environment.kind.as_str() {
        "local" => validate_local_directory(&path)?,
        "wsl" => {
            #[cfg(windows)]
            {
                validate_linux_path(&path)?;
                probe_wsl_directory(environment.distribution.as_deref().unwrap(), &path)?;
                posix_directory_name(&path)
            }
            #[cfg(not(windows))]
            unreachable!()
        }
        _ => unreachable!(),
    };
    Ok(AgentProjectDirectory {
        path,
        suggested_name,
        environment,
    })
}

// WSL emits UTF-16LE on Windows, including CRLF and sometimes a BOM.
#[cfg(any(windows, test))]
pub(super) fn parse_wsl(bytes: &[u8]) -> Result<Vec<String>> {
    if bytes.len() % 2 != 0 {
        return Err("Réponse WSL UTF-16LE invalide.".into());
    }
    let words: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let decoded = String::from_utf16(&words).map_err(|_| "Réponse WSL UTF-16LE invalide.")?;
    let mut names = Vec::new();
    for line in decoded.trim_start_matches('\u{feff}').lines() {
        let name = line.trim().trim_matches('\0').trim();
        if name.is_empty() {
            continue;
        }
        if name.len() > 256 || name.chars().any(char::is_control) {
            return Err("Nom de distribution WSL invalide.".into());
        }
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}
#[cfg(any(windows, test))]
pub(super) fn filtered_wslenv(value: &str) -> String {
    // WSL must choose its own Linux paths. Keep flags and unrelated entries
    // (including credentials) exactly as configured, without mutating the host.
    value
        .split(':')
        .filter(|entry| {
            let name = entry.split('/').next().unwrap_or("");
            !["PATH", "HOME", "TEMP", "TMP", "TMPDIR"]
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
        })
        .collect::<Vec<_>>()
        .join(":")
}
#[cfg(any(windows, test))]
pub(crate) fn host_wslenv() -> String {
    filtered_wslenv(&std::env::var("WSLENV").unwrap_or_default())
}
#[cfg(any(windows, test))]
pub(crate) fn wsl_root_script<'a>(
    command: &'a mut std::process::Command,
    distribution: &str,
    script: &str,
) -> &'a mut std::process::Command {
    command
        .current_dir(std::env::temp_dir())
        .args([
            "--distribution",
            distribution,
            "--cd",
            "/",
            "--exec",
            "sh",
            "-c",
            script,
        ])
        .env("WSLENV", host_wslenv())
}
#[cfg(windows)]
pub(crate) fn probe_output(command: std::process::Command) -> Result<Vec<u8>> {
    probe_output_limited(command, 64 * 1024)
}
/// Output beyond `limit` is never read: the command then stalls until the deadline.
#[cfg(windows)]
pub(crate) fn probe_output_limited(
    mut command: std::process::Command,
    limit: u64,
) -> Result<Vec<u8>> {
    use std::{
        process::Stdio,
        sync::mpsc,
        time::{Duration, Instant},
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command
            .env("WSLENV", host_wslenv())
            .env_remove("WSL_UTF8") // --list is parsed as UTF-16LE, regardless of host settings.
            .creation_flags(0x08000000);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Commande indisponible : {e}. Vérifiez qu’elle est installée."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Sortie de commande indisponible.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Sortie de commande indisponible.")?;
    let (sender, receiver) = mpsc::channel();
    for (is_stdout, stream) in [
        (true, Box::new(stdout) as Box<dyn Read + Send>),
        (false, Box::new(stderr) as Box<dyn Read + Send>),
    ] {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut data = Vec::new();
            let result = stream.take(limit).read_to_end(&mut data);
            let _ = sender.send((is_stdout, result.map(|_| data)));
        });
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("La commande ne répond pas : {result:?}."));
            }
        }
    };
    let mut output = Vec::new();
    let mut errors = Vec::new();
    for _ in 0..2 {
        let (is_stdout, data) = receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "Délai de commande dépassé.")?;
        let data = data.map_err(|e| e.to_string())?;
        if is_stdout {
            output = data;
        } else {
            errors = data;
        }
    }
    if !status.success() {
        let detail = if errors.is_empty() { &output } else { &errors };
        let detail = if detail.contains(&0) {
            String::from_utf16_lossy(
                &detail
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect::<Vec<_>>(),
            )
        } else {
            String::from_utf8_lossy(detail).into_owned()
        };
        return Err(format!(
            "La commande a échoué ({status}) : {}",
            detail.trim()
        ));
    }
    Ok(output)
}
#[cfg(windows)]
fn discover_wsl() -> Result<Vec<String>> {
    let mut command = std::process::Command::new("wsl.exe");
    command.args(["--list", "--quiet"]);
    parse_wsl(&probe_output(command)?)
}
pub fn environments() -> AgentEnvironments {
    #[cfg(windows)]
    let (distributions, wsl_error) = match discover_wsl() {
        Ok(names) => (names, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    #[cfg(not(windows))]
    let (distributions, wsl_error) = (Vec::new(), None);
    AgentEnvironments {
        local_label: if cfg!(windows) {
            "Windows"
        } else if cfg!(target_os = "macos") {
            "macOS"
        } else {
            "Linux"
        }
        .into(),
        distributions,
        wsl_error,
    }
}
