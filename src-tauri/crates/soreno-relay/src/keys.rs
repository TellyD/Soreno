use soreno_mobile_protocol::{decode_key, encode_key, generate_keypair, Key};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

/// The public half of an X25519 private key.
pub fn public_key(private: &Key) -> Key {
    curve25519_dalek::MontgomeryPoint::mul_base_clamped(*private).to_bytes()
}

/// Writes a new private key to `path`, which must not exist yet, and returns its public key.
pub fn generate(path: &Path) -> io::Result<Key> {
    let keypair = generate_keypair().map_err(|_| io::Error::other("génération impossible"))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(format!("{}\n", encode_key(&keypair.private)).as_bytes())?;
    file.sync_all()?;
    Ok(keypair.public)
}

pub fn read(path: &Path) -> io::Result<Key> {
    let text = fs::read_to_string(path)?;
    decode_key(text.trim())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "clé illisible"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_key_matches_noise() {
        let keypair = generate_keypair().unwrap();
        assert_eq!(public_key(&keypair.private), keypair.public);
    }

    #[test]
    fn key_file_round_trip() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("soreno-relay-key-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        let public = generate(&path).unwrap();
        assert!(generate(&path).is_err());
        assert_eq!(public_key(&read(&path).unwrap()), public);
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        fs::remove_file(&path).unwrap();
    }
}
