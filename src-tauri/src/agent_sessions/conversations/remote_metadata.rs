use super::{parse_sidecar, store_sidecar, AgentProject, Result, PREFIX_LIMIT};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub(super) const OSC_PREFIX: &[u8] = b"\x1b]777;soreno;";
// Emitted by dtach sessions launched before the Telaoi → Soreno rename.
pub(super) const LEGACY_OSC_PREFIX: &[u8] = b"\x1b]777;telaoi;";
const OSC_PREFIXES: [&[u8]; 2] = [OSC_PREFIX, LEGACY_OSC_PREFIX];
pub(super) const OSC_PAYLOAD_LIMIT: usize = 96 * 1024;

#[derive(Debug)]
pub(in crate::agent_sessions) struct RemoteMetadataParser {
    run_id: String,
    metadata_path: PathBuf,
    generation: Arc<Mutex<u64>>,
    prefix: Vec<u8>,
    payload: Vec<u8>,
    private: bool,
    overflow: bool,
}

impl RemoteMetadataParser {
    pub(super) fn new(run_id: String, metadata_path: PathBuf, generation: Arc<Mutex<u64>>) -> Self {
        Self {
            run_id,
            metadata_path,
            generation,
            prefix: Vec::new(),
            payload: Vec::new(),
            private: false,
            overflow: false,
        }
    }

    pub(in crate::agent_sessions) fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.filter(bytes, true)
    }

    /// Hides frames replayed by dtach without applying them: the remote sidecar already
    /// reflects them, and an older frame must never overwrite a newer state.
    pub(in crate::agent_sessions) fn push_history(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.filter(bytes, false)
    }

    fn filter(&mut self, bytes: &[u8], apply: bool) -> Vec<u8> {
        let mut visible = Vec::with_capacity(bytes.len());
        for &byte in bytes {
            if self.private {
                if byte == 7 {
                    if apply && !self.overflow {
                        self.publish();
                    }
                    self.payload.clear();
                    self.private = false;
                    self.overflow = false;
                } else if self.payload.len() < OSC_PAYLOAD_LIMIT {
                    self.payload.push(byte);
                } else {
                    self.payload.clear();
                    self.overflow = true;
                }
                continue;
            }
            self.prefix.push(byte);
            while !OSC_PREFIXES
                .iter()
                .any(|prefix| prefix.starts_with(&self.prefix))
            {
                visible.push(self.prefix.remove(0));
            }
            if OSC_PREFIXES.contains(&self.prefix.as_slice()) {
                self.prefix.clear();
                self.private = true;
            }
        }
        visible
    }

    pub(in crate::agent_sessions) fn finish(&mut self) -> Vec<u8> {
        self.payload.clear();
        self.private = false;
        self.overflow = false;
        std::mem::take(&mut self.prefix)
    }

    fn publish(&self) {
        let Some(separator) = self.payload.iter().position(|byte| *byte == b';') else {
            return;
        };
        if &self.payload[..separator] != self.run_id.as_bytes() {
            return;
        }
        let Ok(data) = STANDARD.decode(&self.payload[separator + 1..]) else {
            return;
        };
        let Ok(mut generation) = self.generation.lock() else {
            return;
        };
        if store_sidecar(&self.metadata_path, &self.run_id, None, &data).is_ok() {
            *generation = generation.wrapping_add(1);
        }
    }
}

pub(super) fn remote_sidecar_script(path: &str) -> String {
    format!(
        "p={}; parent=${{p%/*}}; if [ -f \"$p\" ] && [ ! -L \"$p\" ]; then printf f; cat -- \"$p\"; elif [ -e \"$p\" ] || [ -L \"$p\" ]; then printf i; elif [ -d \"$parent\" ] && [ -x \"$parent\" ]; then printf m; else exit 3; fi",
        crate::ssh::quote(path)
    )
}

#[derive(Debug)]
pub(in crate::agent_sessions) struct RemoteSidecarSync {
    connection: crate::ssh::SshConnection,
    provider: String,
    run_id: String,
    local_path: PathBuf,
    remote_path: String,
    pub(super) generation: Arc<Mutex<u64>>,
}

impl RemoteSidecarSync {
    fn new(
        project: &AgentProject,
        provider: String,
        run_id: String,
        local_path: PathBuf,
        remote_path: String,
        generation: Arc<Mutex<u64>>,
    ) -> Result<Self> {
        crate::ssh::validate_path(&remote_path)?;
        Ok(Self {
            connection: project
                .environment
                .ssh
                .clone()
                .ok_or("Connexion SSH manquante.")?,
            provider,
            run_id,
            local_path,
            remote_path,
            generation,
        })
    }

    pub(super) fn capture_generation_if_working(&self) -> Result<Option<u64>> {
        let generation = self
            .generation
            .lock()
            .map_err(|_| "État des métadonnées distant indisponible (verrou empoisonné).")?;
        Ok((std::fs::read(&self.local_path)
            .ok()
            .and_then(|data| parse_sidecar(&data).ok())
            .and_then(|sidecar| sidecar.working)
            == Some(true))
        .then_some(*generation))
    }

    pub(super) fn install_if_generation(&self, generation: u64, data: &[u8]) -> Result<()> {
        let current = self
            .generation
            .lock()
            .map_err(|_| "État des métadonnées distant indisponible (verrou empoisonné).")?;
        // A refresh that changes nothing is not a new report: keep the sidecar's mtime.
        if *current == generation && std::fs::read(&self.local_path).ok().as_deref() != Some(data) {
            store_sidecar(&self.local_path, &self.run_id, Some(&self.provider), data)?;
        }
        Ok(())
    }

    pub(in crate::agent_sessions) fn refresh_if_working(&self) -> Result<()> {
        let Some(generation) = self.capture_generation_if_working()? else {
            return Ok(());
        };
        if let Some(data) = parse_remote_sidecar(crate::ssh::run(
            &self.connection,
            &remote_sidecar_script(&self.remote_path),
            None,
            PREFIX_LIMIT as usize + 1,
        )?)? {
            self.install_if_generation(generation, &data)?;
        }
        Ok(())
    }
}

pub(super) fn parse_remote_sidecar(output: Vec<u8>) -> Result<Option<Vec<u8>>> {
    match output.split_first() {
        Some((b'm', [])) => Ok(None),
        Some((b'f', data)) if data.len() as u64 <= PREFIX_LIMIT => Ok(Some(data.to_vec())),
        Some((b'i', [])) => Err("Le sidecar distant n’est pas un fichier ordinaire.".into()),
        _ => Err("Réponse SSH inattendue lors de la lecture du sidecar distant.".into()),
    }
}

pub(super) fn remote_channels(
    project: &AgentProject,
    provider: String,
    run_id: String,
    local_path: PathBuf,
    remote_path: String,
    generation: Arc<Mutex<u64>>,
) -> Result<(RemoteMetadataParser, RemoteSidecarSync)> {
    let parser =
        RemoteMetadataParser::new(run_id.clone(), local_path.clone(), Arc::clone(&generation));
    let sync = RemoteSidecarSync::new(
        project,
        provider,
        run_id,
        local_path,
        remote_path,
        generation,
    )?;
    Ok((parser, sync))
}
