use crate::files;
use serde::{Deserialize, Serialize};
use soreno_mobile_protocol::{decode_key, encode_key, generate_keypair, Key};
use std::{io, path::Path};

const FILE: &str = "identity.json";

#[derive(Serialize, Deserialize)]
struct Stored {
    private: String,
    public: String,
}

/// The server's static Noise key pair: what phones and the relay know it by.
pub struct Identity {
    pub private: Key,
    pub public: Key,
}

impl Identity {
    /// The server id of the pairing links and of the relay.
    pub fn id(&self) -> String {
        encode_key(&self.public)
    }
}

/// Created on first need; an unreadable file is an error rather than a silent new identity.
pub fn load_or_create(directory: &Path) -> io::Result<Identity> {
    let _lock = files::lock(directory)?;
    if let Some(stored) = files::read_json::<Stored>(&directory.join(FILE))? {
        return match (decode_key(&stored.private), decode_key(&stored.public)) {
            (Some(private), Some(public)) => Ok(Identity { private, public }),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "identity.json illisible",
            )),
        };
    }
    let keypair = generate_keypair()
        .map_err(|error| io::Error::other(format!("génération de la clé : {error}")))?;
    let stored = Stored {
        private: encode_key(&keypair.private),
        public: encode_key(&keypair.public),
    };
    let json = serde_json::to_vec(&stored).expect("identité sérialisable");
    files::write_atomically(directory, FILE, &json)?;
    Ok(Identity {
        private: keypair.private,
        public: keypair.public,
    })
}
