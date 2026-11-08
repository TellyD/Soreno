use super::Result;
use crate::ssh::SshConnection;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

const DETECT: &str = "set -eu; printf '%s\\0%s\\0' \"$(uname -s)\" \"$(uname -m)\"";
pub(super) const HASH_FILE: &str = r#"hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else return 1
  fi
}"#;
// A CRLF checkout would deploy `#!/bin/sh\r`, which the server cannot execute.
static ATTACH_HELPER: LazyLock<String> =
    LazyLock::new(|| unix_lines(include_str!("remote_attach.sh")));
pub(super) const ATTACH_HELPER_PATH: &str = ".cache/soreno/bin/soreno-attach";

fn unix_lines(script: &str) -> String {
    script.replace("\r\n", "\n")
}

struct Binary {
    bytes: &'static [u8],
    hash: &'static str,
}

const LINUX_X86_64: &str = "a6b972cd858daf760401d76abb16c8cd11a65b32e15f2b3bb30533a8943943ab";
const LINUX_AARCH64: &str = "4da19a3b2b3b13459e833b21377e5abd3f2c4ea1c7ee3118a0ba831364345465";

fn binary(platform: &[u8]) -> Result<Binary> {
    let binary = match platform {
        b"Linux\0x86_64\0" => Binary {
            bytes: include_bytes!("../../dtach/bin/linux-x86_64/dtach"),
            hash: LINUX_X86_64,
        },
        b"Linux\0aarch64\0" => Binary {
            bytes: include_bytes!("../../dtach/bin/linux-aarch64/dtach"),
            hash: LINUX_AARCH64,
        },
        b"Darwin\0x86_64\0" => Binary {
            bytes: include_bytes!("../../dtach/bin/macos-x86_64/dtach"),
            hash: "f6e73b5196cb0177090a97223dd719221a9e7f96024fc3091da9e96d06ef71ba",
        },
        b"Darwin\0arm64\0" => Binary {
            bytes: include_bytes!("../../dtach/bin/macos-arm64/dtach"),
            hash: "6e83f66653dc9e47d2d9137bc17ee49a47db9ba5f44b8a4c629c509d8ce6ef74",
        },
        _ => {
            let label = String::from_utf8_lossy(platform).replace('\0', " / ");
            return Err(format!(
                "Serveur SSH incompatible avec dtach embarqué : {}.",
                label.trim_end_matches(" / ")
            ));
        }
    };
    let actual = format!("{:x}", Sha256::digest(binary.bytes));
    if actual != binary.hash {
        return Err("Le binaire dtach embarqué est altéré.".into());
    }
    Ok(binary)
}

fn target_suffix(hash: &str) -> String {
    format!("/.cache/soreno/dtach/{hash}/dtach")
}

/// Whether `path`, from `ensure`, runs Linux dtach: a lone client's output is never cut there,
/// unlike macOS, whose small socket buffers let dtach drop what the client could not take.
pub(super) fn linux(path: &str) -> bool {
    [LINUX_X86_64, LINUX_AARCH64]
        .iter()
        .any(|hash| path.ends_with(&target_suffix(hash)))
}

fn parse_path(output: &[u8], hash: &str) -> Result<String> {
    let path = output
        .strip_suffix(&[0])
        .ok_or("Réponse dtach distante incomplète.")?;
    let path = String::from_utf8(path.to_vec())
        .map_err(|_| "Chemin dtach distant non UTF-8.".to_string())?;
    crate::ssh::validate_path(&path)?;
    if !path.ends_with(&target_suffix(hash)) {
        return Err("Chemin dtach distant inattendu.".into());
    }
    Ok(path)
}

// Also refreshes `soreno-attach`, best effort: it must never block the dtach lookup.
fn cache_script(hash: &str) -> String {
    let helper = crate::ssh::quote(ATTACH_HELPER.trim_end());
    format!(
        r#"{HASH_FILE}
base="$HOME/.cache/soreno"
helper={helper}
(h="$base/bin" t="$base/bin/.soreno-attach.$$"
umask 077 && mkdir -p -- "$h" && [ ! -L "$base" ] && [ ! -L "$h" ] || exit
[ "$(cat -- "$h/soreno-attach" 2>/dev/null)" != "$helper" ] || exit
printf '%s\n' "$helper" > "$t" && chmod 700 "$t" && mv -f -- "$t" "$h/soreno-attach" || rm -f -- "$t") 2>/dev/null || :
versions="$base/dtach"
dir="$versions/{hash}"
t="$dir/dtach"
if [ -d "$base" ] && [ ! -L "$base" ] && [ -d "$versions" ] && [ ! -L "$versions" ] && [ -d "$dir" ] && [ ! -L "$dir" ] && [ -f "$t" ] && [ ! -L "$t" ] && [ -x "$t" ] && [ "$(hash_file "$t" 2>/dev/null || :)" = {hash} ]; then
  printf 'f%s\0' "$t"
else
  printf m
fi"#
    )
}

fn install_script(hash: &str) -> String {
    format!(
        r#"set -eu
{HASH_FILE}
umask 077
base="$HOME/.cache/soreno"
mkdir -p "$base"
[ -d "$base" ] && [ ! -L "$base" ] || exit 20
versions="$base/dtach"
mkdir -p "$versions"
[ -d "$versions" ] && [ ! -L "$versions" ] || exit 21
dir="$versions/{hash}"
mkdir -p "$dir"
[ -d "$dir" ] && [ ! -L "$dir" ] || exit 22
t="$dir/dtach"
tmp="$dir/.dtach.$$"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat > "$tmp"
chmod 700 "$tmp"
[ "$(hash_file "$tmp")" = {hash} ] || exit 23
"$tmp" --help >/dev/null 2>&1 || exit 24
mv -f "$tmp" "$t"
trap - EXIT HUP INT TERM
printf '%s\0' "$t""#
    )
}

pub(super) fn ensure(connection: &SshConnection) -> Result<String> {
    let platform = crate::ssh::run(connection, DETECT, None, 128)?;
    let binary = binary(&platform)?;
    let cached = crate::ssh::run(connection, &cache_script(binary.hash), None, 4096)?;
    if let Some(path) = cached.strip_prefix(b"f") {
        return parse_path(path, binary.hash);
    }
    if cached != b"m" {
        return Err("Réponse inattendue lors de la recherche de dtach.".into());
    }
    let installed = crate::ssh::run(
        connection,
        &install_script(binary.hash),
        Some(binary.bytes),
        4096,
    )?;
    parse_path(&installed, binary.hash)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::unix::fs::PermissionsExt,
        process::{Command, Stdio},
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn run(script: &str, home: &std::path::Path, input: Option<&[u8]>) -> Vec<u8> {
        let mut child = Command::new("sh")
            .args(["-c", script])
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child.stdin.take().unwrap().write_all(input).unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    #[test]
    fn embedded_binaries_match_supported_targets_and_hashes() {
        for platform in [
            b"Linux\0x86_64\0".as_slice(),
            b"Linux\0aarch64\0",
            b"Darwin\0x86_64\0",
            b"Darwin\0arm64\0",
        ] {
            assert!(!binary(platform).unwrap().bytes.is_empty());
        }
        assert!(binary(b"FreeBSD\0x86_64\0").is_err());
        assert!(binary(b"Linux\0x86_64\0extra").is_err());
    }

    #[test]
    fn installation_is_atomic_private_and_reused() {
        let home = std::env::temp_dir().join(format!(
            "soreno-dtach-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&home).unwrap();
        let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => b"Linux\0x86_64\0".as_slice(),
            ("linux", "aarch64") => b"Linux\0aarch64\0".as_slice(),
            ("macos", "x86_64") => b"Darwin\0x86_64\0".as_slice(),
            ("macos", "aarch64") => b"Darwin\0arm64\0".as_slice(),
            platform => panic!("unsupported test platform: {platform:?}"),
        };
        let binary = binary(platform).unwrap();
        let installed = run(&install_script(binary.hash), &home, Some(binary.bytes));
        let path = parse_path(&installed, binary.hash).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let cached = run(&cache_script(binary.hash), &home, None);
        assert_eq!(parse_path(&cached[1..], binary.hash).unwrap(), path);
        std::fs::write(&path, b"corrompu").unwrap();
        assert_eq!(run(&cache_script(binary.hash), &home, None), b"m");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn lookup_keeps_a_private_current_attach_helper_outside_links() {
        let home = std::env::temp_dir().join(format!(
            "soreno-attach-helper-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&home).unwrap();
        let helper = home.join(ATTACH_HELPER_PATH);
        assert_eq!(run(&cache_script("0"), &home, None), b"m");
        assert_eq!(std::fs::read_to_string(&helper).unwrap(), *ATTACH_HELPER);
        assert_eq!(
            std::fs::metadata(&helper).unwrap().permissions().mode() & 0o777,
            0o700
        );

        std::fs::write(&helper, "ancien").unwrap();
        assert_eq!(run(&cache_script("0"), &home, None), b"m");
        assert_eq!(std::fs::read_to_string(&helper).unwrap(), *ATTACH_HELPER);

        let bin = helper.parent().unwrap();
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::remove_dir_all(bin).unwrap();
        std::os::unix::fs::symlink(&elsewhere, bin).unwrap();
        assert_eq!(run(&cache_script("0"), &home, None), b"m");
        assert!(!elsewhere.join("soreno-attach").exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn crlf_scripts_are_deployed_with_unix_line_endings() {
        assert_eq!(
            unix_lines("#!/bin/sh\r\nprintf 'a\\r'\r\nexit 0\r\n"),
            "#!/bin/sh\nprintf 'a\\r'\nexit 0\n"
        );
        assert!(!ATTACH_HELPER.contains('\r'));
    }
}
