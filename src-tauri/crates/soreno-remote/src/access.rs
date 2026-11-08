use crate::files;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use soreno_mobile_protocol::{device_id, encode_key, Key};
use std::{
    fs, io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const FILE: &str = "access.json";
pub const PAIRING_LIFETIME_MS: u64 = 10 * 60 * 1000;
pub const PENDING_PAIRINGS: usize = 8;
const LABEL_LIMIT: usize = 40;
const DEFAULT_LABEL: &str = "Appareil";
/// `lastSeenAt` moves at most this often, so that channel openings rarely rewrite the file.
const LAST_SEEN_STEP_MS: u64 = 60 * 1000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Access {
    #[serde(default)]
    pub devices: Vec<Device>,
    #[serde(default)]
    pub pairings: Vec<Pairing>,
    /// Spent pairings, kept until their secret would have expired so the desktop can tell
    /// a phone pairing from an eviction.
    #[serde(default)]
    pub used: Vec<UsedPairing>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub public: String,
    pub label: String,
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub id: String,
    pub hash: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedPairing {
    pub id: String,
    pub used_at: u64,
    pub expires_at: u64,
}

/// What `soreno-remote pair` hands to the desktop: the secret is never stored.
#[derive(Debug)]
pub struct NewPairing {
    pub id: String,
    pub secret: String,
    pub expires_at: u64,
}

/// Why a phone is refused, as message 2 says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Unpaired,
    Pairing,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unpaired => "unpaired",
            Self::Pairing => "pairing",
        }
    }
}

fn path(directory: &Path) -> PathBuf {
    directory.join(FILE)
}

pub fn read(directory: &Path) -> io::Result<Access> {
    Ok(files::read_json(&path(directory))?.unwrap_or_default())
}

/// Reads, changes and writes back under the lock, dropping expired pairings and spent ones past
/// their expiry; written only if something changed.
pub fn update<T>(directory: &Path, change: impl FnOnce(&mut Access) -> T) -> io::Result<T> {
    let _lock = files::lock(directory)?;
    let before = read(directory)?;
    let mut access = before.clone();
    let now = files::now_ms();
    access.pairings.retain(|pairing| pairing.expires_at > now);
    access.used.retain(|used| used.expires_at > now);
    let result = change(&mut access);
    if access != before {
        let json = serde_json::to_vec(&access).expect("accès sérialisable");
        files::write_atomically(directory, FILE, &json)?;
    }
    Ok(result)
}

/// The index of the pending pairing whose secret hashes to `wanted`.
fn find_pairing(access: &Access, wanted: &str) -> Option<usize> {
    let found = access
        .pairings
        .iter()
        .map(|pairing| files::same_secret(pairing.hash.as_bytes(), wanted.as_bytes()))
        .collect::<Vec<_>>();
    found.iter().position(|&same| same)
}

fn spend(access: &mut Access, index: usize, now: u64) {
    let pairing = access.pairings.remove(index);
    access.used.push(UsedPairing {
        id: pairing.id,
        used_at: now,
        expires_at: pairing.expires_at,
    });
}

pub fn hash(secret: &str) -> String {
    files::hex(&Sha256::digest(secret.as_bytes()))
}

/// A new one-time secret, valid ten minutes; the oldest pending one goes past eight.
pub fn pair(directory: &Path) -> io::Result<NewPairing> {
    let secret = URL_SAFE_NO_PAD.encode(files::random::<32>()?);
    let id = files::hex(&files::random::<8>()?);
    let pairing = Pairing {
        id: id.clone(),
        hash: hash(&secret),
        expires_at: files::now_ms() + PAIRING_LIFETIME_MS,
    };
    let expires_at = pairing.expires_at;
    update(directory, |access| {
        access.pairings.sort_by_key(|pairing| pairing.expires_at);
        let excess = (access.pairings.len() + 1).saturating_sub(PENDING_PAIRINGS);
        access.pairings.drain(..excess);
        access.pairings.push(pairing);
    })?;
    Ok(NewPairing {
        id,
        secret,
        expires_at,
    })
}

pub fn valid_device_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `true` when the device was there.
pub fn revoke(directory: &Path, id: &str) -> io::Result<bool> {
    update(directory, |access| {
        let before = access.devices.len();
        access.devices.retain(|device| device.id != id);
        access.devices.len() != before
    })
}

pub fn clean_label(label: &str) -> String {
    let printable: String = label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let label: String = printable.chars().take(LABEL_LIMIT).collect();
    let label = label.trim();
    if label.is_empty() {
        DEFAULT_LABEL.into()
    } else {
        label.into()
    }
}

/// Lets a known device in, or pairs it with a valid secret; a valid secret is spent either way.
pub fn admit(
    directory: &Path,
    public: &Key,
    label: &str,
    secret: Option<&str>,
) -> io::Result<Result<(), Refusal>> {
    let encoded = encode_key(public);
    let now = files::now_ms();
    update(directory, |access| {
        if let Some(device) = access
            .devices
            .iter_mut()
            .find(|device| files::same_secret(device.public.as_bytes(), encoded.as_bytes()))
        {
            if device
                .last_seen_at
                .is_none_or(|seen| now.saturating_sub(seen) >= LAST_SEEN_STEP_MS)
            {
                device.last_seen_at = Some(now);
            }
            if let Some(index) = secret.and_then(|secret| find_pairing(access, &hash(secret))) {
                spend(access, index, now);
            }
            return Ok(());
        }
        let Some(secret) = secret else {
            return Err(Refusal::Unpaired);
        };
        // No throttle: the secret is 256 random bits, and each attempt already costs a Noise handshake.
        let Some(index) = find_pairing(access, &hash(secret)) else {
            return Err(Refusal::Pairing);
        };
        spend(access, index, now);
        let id = device_id(public);
        access.devices.retain(|device| device.id != id);
        access.devices.push(Device {
            id,
            public: encoded,
            label: clean_label(label),
            paired_at: now,
            last_seen_at: Some(now),
        });
        Ok(())
    })
}

/// Follows `access.json` for one device, re-reading it only when it was replaced.
pub struct Watch {
    directory: PathBuf,
    public: String,
    stamp: Option<(u64, i64, i64, u64)>,
    allowed: bool,
}

impl Watch {
    pub fn new(directory: &Path, public: &Key) -> Self {
        Self {
            directory: directory.to_owned(),
            public: encode_key(public),
            stamp: None,
            allowed: true,
        }
    }

    /// A file gone or unreadable revokes everyone.
    pub fn allowed(&mut self) -> bool {
        let stamp = fs::metadata(path(&self.directory)).ok().map(|metadata| {
            (
                metadata.ino(),
                metadata.mtime(),
                metadata.mtime_nsec(),
                metadata.len(),
            )
        });
        if stamp.is_none() || stamp != self.stamp {
            self.stamp = stamp;
            self.allowed = read(&self.directory).is_ok_and(|access| {
                access
                    .devices
                    .iter()
                    .any(|device| device.public == self.public)
            });
        }
        self.allowed
    }
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
