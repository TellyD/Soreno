use super::{
    codex_command, execution, expanded_agent_path, find_codex_binary, find_node_for_shim,
    find_optional_codex_binary, has_file_name, hidden_command, is_executable_file,
    is_windows_script_shim, native_codex_binary,
    process::{failed, run_command},
    windows_shim_target_path, CodexStatus, CODEX_UPDATE,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const UNSUPPORTED: &str = "CODEX_UPDATE_UNSUPPORTED";
const MAX_METADATA_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUpdateStatus {
    status: UpdateStatus,
    latest_version: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdateStatus {
    Available,
    UpToDate,
    Unsupported,
}

#[derive(Debug, PartialEq, Eq)]
enum UpdateSource {
    Npm,
    Homebrew,
}

impl UpdateSource {
    fn endpoint(&self) -> &'static str {
        match self {
            Self::Npm => "https://registry.npmjs.org/@openai/codex/latest",
            Self::Homebrew => "https://formulae.brew.sh/api/cask/codex.json",
        }
    }
}

pub async fn check_update() -> Result<CodexUpdateStatus, String> {
    let installation = tauri::async_runtime::spawn_blocking(|| {
        let Some(binary) = find_optional_codex_binary()? else {
            return Ok(None);
        };
        let node = resolve_node(&binary);
        let Some((_, source)) = update_command(&binary, std::env::consts::OS, &node) else {
            return Ok(None);
        };
        let native = native_codex_binary(&binary).map_err(failed)?;
        let output = run_command(
            codex_command(&native).arg("--version"),
            Duration::from_secs(15),
            true,
        )?;
        let installed = parse_installed_version(&output)?;
        Ok::<_, String>(Some((source, installed)))
    })
    .await
    .map_err(failed)??;
    let Some((source, installed)) = installation else {
        return Ok(CodexUpdateStatus {
            status: UpdateStatus::Unsupported,
            latest_version: None,
        });
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(failed)?;
    let mut response = client
        .get(source.endpoint())
        .send()
        .await
        .map_err(failed)?
        .error_for_status()
        .map_err(failed)?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_METADATA_BYTES as u64)
    {
        return Err(failed("update metadata too large"));
    }
    let mut payload = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        if chunk.len() > MAX_METADATA_BYTES - payload.len() {
            return Err(failed("update metadata too large"));
        }
        payload.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct Metadata {
        version: String,
    }
    let metadata: Metadata = serde_json::from_slice(&payload).map_err(failed)?;
    compare_versions(&installed, &metadata.version)
}

fn parse_installed_version(output: &str) -> Result<semver::Version, String> {
    let version = output.trim();
    let version = version.strip_prefix("codex-cli ").unwrap_or(version);
    semver::Version::parse(version).map_err(failed)
}

fn compare_versions(
    installed: &semver::Version,
    latest: &str,
) -> Result<CodexUpdateStatus, String> {
    let latest_version = semver::Version::parse(latest).map_err(failed)?;
    Ok(CodexUpdateStatus {
        // Build metadata has no bearing on SemVer precedence.
        status: if latest_version.cmp_precedence(installed).is_gt() {
            UpdateStatus::Available
        } else {
            UpdateStatus::UpToDate
        },
        latest_version: Some(latest.to_string()),
    })
}

pub fn update_cli() -> Result<CodexStatus, String> {
    let _update = CODEX_UPDATE
        .try_lock()
        .map_err(|_| "CODEX_UPDATE_BUSY".to_string())?;
    if execution::is_active() {
        return Err("CODEX_UPDATE_ACTIVE".into());
    }
    let binary = find_codex_binary().map_err(|_| UNSUPPORTED.to_string())?;
    let node = resolve_node(&binary);
    let (mut command, _) = update_command(&binary, std::env::consts::OS, &node)
        .ok_or_else(|| UNSUPPORTED.to_string())?;
    if let Some(path) = expanded_agent_path(&binary) {
        command.env("PATH", path);
    }
    run_command(&mut command, Duration::from_secs(300), false)?;

    // Verify this installation, not a different copy that happens to be on PATH.
    let verify = || {
        let native = native_codex_binary(&binary)?;
        let version = run_command(
            codex_command(&native).arg("--version"),
            Duration::from_secs(15),
            true,
        )?;
        if version.trim().is_empty() {
            return Err("empty version".into());
        }
        Ok(CodexStatus {
            installed: true,
            version: Some(version.trim().to_string()),
        })
    };
    verify().map_err(|_: String| "CODEX_UPDATE_VERIFY_FAILED".into())
}

fn resolve_node(binary: &Path) -> PathBuf {
    let node = find_node_for_shim(binary);
    if node.is_absolute() && node.is_file() {
        return node;
    }
    expanded_agent_path(binary)
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(&node))
        .find(|path| path.is_absolute() && is_executable_file(path))
        .unwrap_or(node)
}

// Detection only: never execute a package manager to guess the installation owner.
fn update_command(binary: &Path, os: &str, node: &Path) -> Option<(Command, UpdateSource)> {
    let target = if is_windows_script_shim(binary) {
        windows_shim_target_path(binary)?
    } else {
        binary.to_path_buf()
    };
    let target = std::fs::canonicalize(target).ok()?;
    if os == "macos" {
        for cask in target
            .ancestors()
            .filter(|path| has_file_name(path, "codex"))
        {
            let caskroom = cask.parent()?;
            if has_file_name(caskroom, "Caskroom") {
                let prefix = caskroom.parent()?;
                let brew = prefix.join("bin/brew");
                if brew.is_file() && target != cask {
                    let mut command = hidden_command(brew);
                    command
                        .args(["upgrade", "--cask", "codex"])
                        .env("NONINTERACTIVE", "1");
                    return Some((command, UpdateSource::Homebrew));
                }
            }
        }
    }
    if !["windows", "macos", "linux"].contains(&os) || !has_file_name(&target, "codex.js") {
        return None;
    }
    let package = target.parent()?.parent()?;
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(package.join("package.json")).ok()?).ok()?;
    if manifest["name"] != "@openai/codex" {
        return None;
    }
    let modules = package.parent()?.parent()?;
    if package != modules.join("@openai/codex") || !has_file_name(modules, "node_modules") {
        return None;
    }
    let windows = os == "windows";
    let prefix = if windows {
        modules.parent()?
    } else {
        let lib = modules.parent()?;
        if !has_file_name(lib, "lib") {
            return None;
        }
        lib.parent()?
    };
    if target != package.join("bin/codex.js") {
        return None;
    }
    let bin = if windows {
        prefix.to_path_buf()
    } else {
        prefix.join("bin")
    };
    // A local .bin shim, linked package, pnpm store or Bun launcher must not
    // turn into a new global installation elsewhere.
    if std::fs::canonicalize(binary.parent()?).ok()? != std::fs::canonicalize(&bin).ok()?
        || !(has_file_name(binary, "codex") || (windows && has_file_name(binary, "codex.cmd")))
    {
        return None;
    }
    if !node.is_absolute() || !node.is_file() {
        return None;
    }
    let npm_launcher = bin.join(if windows { "npm.cmd" } else { "npm" });
    let mut npm_candidates = Vec::new();
    if windows {
        npm_candidates.extend(windows_shim_target_path(&npm_launcher));
    } else {
        npm_candidates.extend(std::fs::canonicalize(npm_launcher).ok());
    }
    npm_candidates.push(modules.join("npm/bin/npm-cli.js"));
    if windows {
        // npm's global prefix is commonly Roaming/npm, while npm itself lives
        // beside node.exe in Program Files/nodejs (or an nvm installation).
        npm_candidates.push(node.parent()?.join("node_modules/npm/bin/npm-cli.js"));
    }
    let npm = npm_candidates.into_iter().find_map(|candidate| {
        let npm = std::fs::canonicalize(candidate).ok()?;
        let package = npm.parent()?.parent()?;
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(package.join("package.json")).ok()?)
                .ok()?;
        (npm == package.join("bin/npm-cli.js") && manifest["name"] == "npm").then_some(npm)
    })?;
    let mut command = hidden_command(node);
    command
        .arg(npm_path_argument(&npm, os))
        .args(["install", "--global", "--prefix"])
        .arg(npm_path_argument(prefix, os))
        .args(["@openai/codex@latest", "--no-audit", "--no-fund"]);
    Some((command, UpdateSource::Npm))
}

// Rust canonicalizes Windows paths to \\?\ paths. Node's script loader can
// fail on that namespace (EISDIR on "C:"), so normalize only npm arguments,
// after canonical paths have been used to validate the installation owner.
fn npm_path_argument(path: &Path, os: &str) -> PathBuf {
    if os == "windows" {
        if let Some(text) = path.to_str() {
            if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
            if let Some(drive) = text.strip_prefix(r"\\?\") {
                let bytes = drive.as_bytes();
                if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\" {
                    return PathBuf::from(drive);
                }
            }
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
