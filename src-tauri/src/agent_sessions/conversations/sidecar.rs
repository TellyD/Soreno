use super::{AgentTurn, Provider, Result, PREFIX_LIMIT, SIDECAR_TOO_LARGE};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Sidecar {
    pub version: u8,
    pub run_id: String,
    pub provider: String,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub name: Option<String>,
    pub error: Option<String>,
    pub working: Option<bool>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default = "default_true")]
    pub materialized: bool,
    /// Read by the mobile service only.
    #[serde(default, rename = "deleted")]
    _deleted: serde::de::IgnoredAny,
    #[serde(default)]
    pub turn: Option<AgentTurn>,
    #[serde(default)]
    pub awaiting: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookSidecar {
    version: u8,
    run_id: String,
    provider: String,
    payload: HookPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookActivitySidecar {
    version: u8,
    run_id: String,
    provider: String,
    working: bool,
    #[serde(default)]
    awaiting: bool,
    identity: HookSidecar,
    #[serde(default)]
    turn: Option<HookTurn>,
}

#[derive(Deserialize)]
struct HookTurn {
    id: String,
    payload: StopPayload,
}

#[derive(Deserialize)]
struct StopPayload {
    hook_event_name: String,
    #[serde(default)]
    last_assistant_message: Option<String>,
}

#[derive(Deserialize)]
struct HookPayload {
    hook_event_name: String,
    session_id: String,
    #[serde(default)]
    transcript_path: Option<String>,
    cwd: String,
    #[serde(default)]
    source: Option<String>,
}

fn default_true() -> bool {
    true
}

pub(super) fn parse_sidecar(data: &[u8]) -> std::result::Result<Sidecar, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_slice(data)?;
    if value
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .and_then(Provider::from_name)
        .is_some_and(Provider::uses_hooks)
    {
        let (hook, working, awaiting, valid_identity, turn) = if value.get("identity").is_some() {
            let activity: HookActivitySidecar = serde_json::from_value(value)?;
            let valid_identity = activity.version == activity.identity.version
                && activity.run_id == activity.identity.run_id
                && activity.provider == activity.identity.provider;
            (
                activity.identity,
                Some(activity.working),
                activity.awaiting,
                valid_identity,
                activity.turn,
            )
        } else {
            (serde_json::from_value(value)?, None, false, true, None)
        };
        let event = hook.payload.hook_event_name;
        // Without a saved identity, the awaiting hook writes its raw event.
        let awaiting_event = matches!(
            event.as_str(),
            "PermissionRequest" | "PreToolUse" | "Notification"
        );
        return Ok(Sidecar {
            version: hook.version,
            run_id: hook.run_id,
            provider: hook.provider,
            session_id: Some(hook.payload.session_id),
            session_file: hook.payload.transcript_path,
            name: None,
            error: None,
            working: working.or(match event.as_str() {
                "UserPromptSubmit" => Some(true),
                "Stop" | "StopFailure" => Some(false),
                _ if awaiting_event => Some(true),
                _ => None,
            }),
            awaiting: awaiting || working.is_none() && awaiting_event,
            source: if !valid_identity {
                Some("invalid".into())
            } else {
                match (event.as_str(), hook.payload.source) {
                    ("SessionStart", Some(source)) => Some(source),
                    ("SessionEnd" | "UserPromptSubmit" | "Stop" | "StopFailure", _) => None,
                    _ if awaiting_event => None,
                    _ => Some("invalid".into()),
                }
            },
            cwd: Some(hook.payload.cwd),
            materialized: true,
            _deleted: serde::de::IgnoredAny,
            turn: turn
                .filter(|turn| turn.payload.hook_event_name == "Stop")
                .map(|turn| AgentTurn {
                    id: turn.id,
                    message: turn.payload.last_assistant_message,
                }),
        });
    }
    serde_json::from_value(value)
}

pub(super) fn read_sidecar(path: &Path) -> Result<Option<Vec<u8>>> {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Impossible de lire les métadonnées de conversation : {error}"
            ))
        }
    };
    let mut data = Vec::new();
    file.by_ref()
        .take(PREFIX_LIMIT + 1)
        .read_to_end(&mut data)
        .map_err(|error| format!("Impossible de lire les métadonnées de conversation : {error}"))?;
    if data.len() as u64 > PREFIX_LIMIT {
        return Err(SIDECAR_TOO_LARGE.into());
    }
    Ok(Some(data))
}

pub(super) fn store_sidecar(
    metadata_path: &Path,
    run_id: &str,
    provider: Option<&str>,
    data: &[u8],
) -> Result<()> {
    use std::io::Write;
    if data.len() as u64 > PREFIX_LIMIT {
        return Err(SIDECAR_TOO_LARGE.into());
    }
    let sidecar = parse_sidecar(data)
        .map_err(|error| format!("Métadonnées de conversation invalides : {error}"))?;
    if sidecar.version != 1
        || sidecar.run_id != run_id
        || provider.is_some_and(|provider| sidecar.provider != provider)
    {
        return Err(
            "Métadonnées de conversation incompatibles (version, exécution ou fournisseur).".into(),
        );
    }
    let mut tmp_path = metadata_path.as_os_str().to_owned();
    tmp_path.push(".tmp");
    let tmp_path = PathBuf::from(tmp_path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp_path).map_err(|error| {
        format!("Impossible d’écrire les métadonnées de conversation : {error}")
    })?;
    file.write_all(data).map_err(|error| {
        format!("Impossible d’écrire les métadonnées de conversation : {error}")
    })?;
    std::fs::rename(tmp_path, metadata_path).map_err(|error| {
        format!("Impossible d’installer les métadonnées de conversation : {error}")
    })
}
