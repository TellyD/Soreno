//! What `soreno-relay`, `soreno-remote` and the mobile page agree on: the Noise parameters, the
//! key encoding, the frames of the server ↔ relay link, and the chunking of end-to-end messages.
//! `src/mobile/protocol.ts` mirrors it for the page.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

pub use snow::{Error, HandshakeState, TransportState};

pub const NOISE: &str = "Noise_IK_25519_AESGCM_SHA256";
/// Phone ↔ server, end to end.
pub const PHONE_PROLOGUE: &[u8] = b"soreno-mobile/1";
/// Server ↔ relay.
pub const RELAY_PROLOGUE: &[u8] = b"soreno-relay/1";
/// The server's first transport message on its relay link: the handshake's first message can be
/// replayed, so the relay only publishes a link once the server proves it holds the session keys.
pub const LINK_READY: &[u8] = br#"{"ready":true}"#;
pub const KEY_LENGTH: usize = 32;
pub const NOISE_MESSAGE_LIMIT: usize = 65535;
pub const TAG_LENGTH: usize = 16;
/// Application bytes per end-to-end chunk: with its flag and tag, a phone message still fits in
/// one relay frame, itself one Noise message on the server link.
pub const CHUNK_LIMIT: usize = 63 * 1024;
/// A whole application message once reassembled: room for a 4 MiB image in base64.
pub const MESSAGE_LIMIT: usize = 8 << 20;
/// The largest phone Noise message the relay forwards.
pub const PHONE_FRAME_LIMIT: usize = 1 + CHUNK_LIMIT + TAG_LENGTH;

const MORE: u8 = 1;
const LAST: u8 = 0;

pub type Key = [u8; KEY_LENGTH];

pub struct Keypair {
    pub private: Key,
    pub public: Key,
}

pub fn encode_key(key: &Key) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

pub fn decode_key(text: &str) -> Option<Key> {
    if text.len() != 43 {
        return None;
    }
    URL_SAFE_NO_PAD.decode(text).ok()?.try_into().ok()
}

/// What the server lists and revokes: the first 8 bytes of the phone's public key, in hex.
pub fn device_id(public: &Key) -> String {
    public[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn builder() -> snow::Builder<'static> {
    snow::Builder::new(NOISE.parse().expect("paramètres Noise valides"))
}

pub fn generate_keypair() -> Result<Keypair, Error> {
    let keypair = builder().generate_keypair()?;
    let key = |bytes: Vec<u8>| -> Result<Key, Error> { bytes.try_into().map_err(|_| Error::Input) };
    Ok(Keypair {
        private: key(keypair.private)?,
        public: key(keypair.public)?,
    })
}

/// The side that knows the other's static key: the phone towards a server, a server towards the relay.
pub fn initiator(local: &Key, remote: &Key, prologue: &[u8]) -> Result<HandshakeState, Error> {
    builder()
        .local_private_key(local)?
        .remote_public_key(remote)?
        .prologue(prologue)?
        .build_initiator()
}

pub fn responder(local: &Key, prologue: &[u8]) -> Result<HandshakeState, Error> {
    builder()
        .local_private_key(local)?
        .prologue(prologue)?
        .build_responder()
}

/// One Noise transport message.
pub fn seal(transport: &mut TransportState, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    let mut message = vec![0u8; plaintext.len() + TAG_LENGTH];
    let length = transport.write_message(plaintext, &mut message)?;
    message.truncate(length);
    Ok(message)
}

pub fn open(transport: &mut TransportState, message: &[u8]) -> Result<Vec<u8>, Error> {
    let mut plaintext = vec![0u8; message.len()];
    let length = transport.read_message(message, &mut plaintext)?;
    plaintext.truncate(length);
    Ok(plaintext)
}

/// One application message as the plaintexts of successive transport messages.
pub fn chunks(message: &[u8]) -> Vec<Vec<u8>> {
    let mut parts: Vec<&[u8]> = message.chunks(CHUNK_LIMIT).collect();
    if parts.is_empty() {
        parts.push(&[]);
    }
    let last = parts.len() - 1;
    parts
        .into_iter()
        .enumerate()
        .map(|(index, part)| {
            let mut chunk = Vec::with_capacity(part.len() + 1);
            chunk.push(if index == last { LAST } else { MORE });
            chunk.extend_from_slice(part);
            chunk
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum ChunkError {
    Malformed,
    TooLong,
}

/// Gathers chunks back into application messages.
#[derive(Default)]
pub struct Reassembly {
    pending: Vec<u8>,
}

impl Reassembly {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Option<Vec<u8>>, ChunkError> {
        let (&flag, part) = chunk.split_first().ok_or(ChunkError::Malformed)?;
        if part.len() > CHUNK_LIMIT || flag > MORE {
            return Err(ChunkError::Malformed);
        }
        if self.pending.len() + part.len() > MESSAGE_LIMIT {
            return Err(ChunkError::TooLong);
        }
        self.pending.extend_from_slice(part);
        Ok((flag == LAST).then(|| std::mem::take(&mut self.pending)))
    }
}

/// A message of the server ↔ relay link, inside its Noise transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// A phone asked for this server (relay → server).
    Open(u32),
    /// A phone Noise message, either way.
    Data(u32, Vec<u8>),
    /// Either side ends the channel.
    Close(u32),
}

impl Frame {
    pub fn encode(&self) -> Vec<u8> {
        let (kind, channel, payload): (u8, u32, &[u8]) = match self {
            Self::Open(channel) => (1, *channel, &[]),
            Self::Data(channel, payload) => (2, *channel, payload),
            Self::Close(channel) => (3, *channel, &[]),
        };
        let mut bytes = Vec::with_capacity(5 + payload.len());
        bytes.push(kind);
        bytes.extend_from_slice(&channel.to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let (&kind, rest) = bytes.split_first()?;
        let channel = u32::from_be_bytes(rest.get(..4)?.try_into().ok()?);
        let payload = &rest[4..];
        match (kind, payload.is_empty()) {
            (1, true) => Some(Self::Open(channel)),
            (2, _) if payload.len() <= PHONE_FRAME_LIMIT => {
                Some(Self::Data(channel, payload.to_vec()))
            }
            (3, true) => Some(Self::Close(channel)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests;
