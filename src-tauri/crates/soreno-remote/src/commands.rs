//! What the desktop runs over SSH besides the service.
use crate::{access, files, identity, relay::Endpoint, USAGE};
use std::{io, path::Path};

pub fn parse_serve(args: &[String]) -> Result<Endpoint, &'static str> {
    let (mut relay, mut key) = (None, None);
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let slot = match arg.as_str() {
            "--relay" => &mut relay,
            "--relay-key" => &mut key,
            _ => return Err(USAGE),
        };
        match rest.next() {
            Some(value) if !value.is_empty() && slot.is_none() => *slot = Some(value.clone()),
            _ => return Err(USAGE),
        }
    }
    let (Some(relay), Some(key)) = (relay, key) else {
        return Err(USAGE);
    };
    Endpoint::parse(&relay, &key)
        .ok_or("soreno-remote : --relay attend ws://<hôte>:<port> et --relay-key une clé base64url de 32 octets.")
}

/// One JSON line: the server id, the pairing id, its one-time secret, its expiry and the time
/// left, which the desktop trusts over this server's clock.
pub fn pair(home: &Path) -> io::Result<String> {
    let directory = files::remote_dir(home);
    let identity = identity::load_or_create(&directory)?;
    let pairing = access::pair(&directory)?;
    Ok(serde_json::json!({
        "server": identity.id(),
        "id": pairing.id,
        "secret": pairing.secret,
        "expiresAt": pairing.expires_at,
        "expiresInMs": pairing.expires_at.saturating_sub(files::now_ms()),
    })
    .to_string())
}

/// The exit code: 0 whether the device was there or not, 2 for an invalid id.
pub fn revoke(home: &Path, id: &str) -> io::Result<i32> {
    if !access::valid_device_id(id) {
        return Ok(2);
    }
    access::revoke(&files::remote_dir(home), id)?;
    Ok(0)
}

/// The paired devices, the pending pairings and the spent ones, secrets and keys left out.
pub fn access(home: &Path) -> io::Result<String> {
    let directory = files::remote_dir(home);
    let identity = identity::load_or_create(&directory)?;
    let now = files::now_ms();
    let access = access::read(&directory)?;
    let devices: Vec<_> = access
        .devices
        .iter()
        .map(|device| {
            serde_json::json!({
                "id": device.id, "label": device.label,
                "pairedAt": device.paired_at, "lastSeenAt": device.last_seen_at,
            })
        })
        .collect();
    let pairings: Vec<_> = access
        .pairings
        .iter()
        .filter(|pairing| pairing.expires_at > now)
        .map(|pairing| serde_json::json!({ "id": pairing.id, "expiresAt": pairing.expires_at }))
        .collect();
    let used: Vec<_> = access
        .used
        .iter()
        .filter(|used| used.expires_at > now)
        .map(|used| used.id.as_str())
        .collect();
    Ok(serde_json::json!({
        "server": identity.id(),
        "devices": devices,
        "pairings": pairings,
        "used": used,
    })
    .to_string())
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
