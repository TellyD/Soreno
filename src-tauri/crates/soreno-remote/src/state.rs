use crate::{
    files,
    mailbox::Mailbox,
    stop::{self, Stop},
};
use serde::Serialize;
use std::{
    io,
    path::PathBuf,
    sync::{Mutex, PoisonError},
    time::Duration,
};

const VERSION: u32 = 4;
const INTERVAL: Duration = Duration::from_secs(10);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Written<'a> {
    version: u32,
    server: &'a str,
    host: &'a str,
    relay: &'a str,
    connected: bool,
    connected_at: Option<u64>,
    updated_at: u64,
}

/// What `state.json` tells the desktop: written at each change and every few seconds.
pub struct State {
    directory: PathBuf,
    pub server: String,
    pub host: String,
    relay: String,
    connected_at: Mutex<Option<u64>>,
    changes: Mailbox<()>,
}

impl State {
    pub fn new(
        directory: PathBuf,
        server: String,
        host: String,
        relay: String,
    ) -> io::Result<Self> {
        Ok(Self {
            directory,
            server,
            host,
            relay,
            connected_at: Mutex::default(),
            changes: Mailbox::new()?,
        })
    }

    pub fn set_connected(&self, connected: bool) {
        let mut connected_at = self
            .connected_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if connected_at.is_some() != connected {
            *connected_at = connected.then(files::now_ms);
            drop(connected_at);
            self.changes.push(());
        }
    }

    pub fn json(&self, now: u64) -> String {
        let connected_at = *self
            .connected_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        serde_json::to_string(&Written {
            version: VERSION,
            server: &self.server,
            host: &self.host,
            relay: &self.relay,
            connected: connected_at.is_some(),
            connected_at,
            updated_at: now,
        })
        .expect("état sérialisable")
    }

    fn write(&self) {
        let json = self.json(files::now_ms());
        if let Err(error) = files::write_atomically(&self.directory, "state.json", json.as_bytes())
        {
            eprintln!("soreno-remote : écriture de state.json : {error}");
        }
    }

    /// Until `stop`, then once more as disconnected.
    pub fn keep(&self, stop: &Stop) {
        loop {
            self.changes.take();
            self.write();
            stop::poll(
                &[(self.changes.fd(), false), (stop.fd(), false)],
                INTERVAL.as_millis() as i32,
            );
            if stop.requested() {
                break;
            }
        }
        self.set_connected(false);
        self.write();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_json_says_whether_the_relay_link_is_up() {
        let state = State::new(
            PathBuf::from("/nulle-part"),
            "S".repeat(43),
            "vps".into(),
            "ws://relais:8790/relay/server".into(),
        )
        .unwrap();
        let read =
            |state: &State| serde_json::from_str::<serde_json::Value>(&state.json(7)).unwrap();
        assert_eq!(
            read(&state),
            serde_json::json!({
                "version": 4, "server": "S".repeat(43), "host": "vps",
                "relay": "ws://relais:8790/relay/server", "connected": false,
                "connectedAt": null, "updatedAt": 7,
            })
        );
        state.set_connected(true);
        let connected = read(&state);
        assert_eq!(connected["connected"], true);
        assert!(connected["connectedAt"].as_u64().unwrap() > 0);
        state.set_connected(false);
        assert_eq!(read(&state)["connectedAt"], serde_json::Value::Null);
    }
}
