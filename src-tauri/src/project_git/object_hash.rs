use sha1::{Digest, Sha1};
use sha2::Sha256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ObjectFormat {
    Sha1,
    Sha256,
}

impl ObjectFormat {
    pub(super) fn parse(value: &str) -> Result<Self, super::GitError> {
        match value {
            "sha1" => Ok(Self::Sha1),
            "sha256" => Ok(Self::Sha256),
            _ => Err(super::GitError::new(
                "malformed",
                "Format d’objet Git non pris en charge.",
            )),
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Sha1 => "sha1",
            Self::Sha256 => "sha256",
        }
    }
}

pub(crate) fn blob_oid(format: ObjectFormat, bytes: &[u8]) -> String {
    object_oid(format, "blob", bytes)
}

fn object_oid(format: ObjectFormat, kind: &str, bytes: &[u8]) -> String {
    let header = format!("{kind} {}\0", bytes.len());
    match format {
        ObjectFormat::Sha1 => {
            let mut hash = Sha1::new();
            hash.update(header.as_bytes());
            hash.update(bytes);
            format!("{:x}", hash.finalize())
        }
        ObjectFormat::Sha256 => {
            let mut hash = Sha256::new();
            hash.update(header.as_bytes());
            hash.update(bytes);
            format!("{:x}", hash.finalize())
        }
    }
}

pub(super) fn snapshot_version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Write,
        process::{Command, Stdio},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn git_oid(format: ObjectFormat, kind: &str, bytes: &[u8]) -> String {
        let directory = std::env::temp_dir().join(format!(
            "soreno-object-hash-{}-{}-{}",
            format.as_str(),
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let command = || {
            let mut command = Command::new("git");
            super::super::command_builder::clear_git_overrides(&mut command);
            command
                .env("HOME", &directory)
                .env("GIT_CONFIG_GLOBAL", directory.join("global-config"))
                .env("GIT_CONFIG_NOSYSTEM", "1");
            command
        };
        let init = command()
            .args(["init", "-q", "--object-format", format.as_str()])
            .arg(&directory)
            .output()
            .unwrap();
        assert!(
            init.status.success(),
            "{}",
            String::from_utf8_lossy(&init.stderr)
        );
        let mut child = command()
            .args(["-C"])
            .arg(&directory)
            .args(["hash-object", "-t", kind, "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        let _ = fs::remove_dir_all(&directory);
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    #[test]
    fn blob_oids_match_git_for_supported_formats_and_raw_contents() {
        let contents: [&[u8]; 3] = [b"", b"line\r\n", b"binary\0\xff\n"];
        for format in [ObjectFormat::Sha1, ObjectFormat::Sha256] {
            for bytes in contents {
                assert_eq!(blob_oid(format, bytes), git_oid(format, "blob", bytes));
            }
        }
    }

    #[test]
    fn snapshot_versions_are_opaque_sha256_values() {
        let version = snapshot_version(b"ready\0state");
        assert_eq!(version.len(), 64);
        assert!(super::super::validate_oid(&version).is_ok());
        assert_ne!(version, snapshot_version(b"ready\0changed"));
    }
}
