use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus},
    sync::Mutex,
    time::Duration,
};

mod commit_message;
mod execution;
pub(crate) mod process;
mod update;
mod usage;
pub(crate) use commit_message::generate as generate_commit_message;
use process::run_command;
pub use update::{check_update, update_cli, CodexUpdateStatus};
pub use usage::{local_app_server_command, read_usage, AppServerStop, CodexRateLimits, CodexUsage};

static CODEX_UPDATE: Mutex<()> = Mutex::new(());

struct CodexCommandTarget {
    program: PathBuf,
    first_arg: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexStatus {
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub display_name: String,
    pub id: String,
}

#[derive(Deserialize)]
struct CodexModelsCache {
    #[serde(default)]
    models: Vec<CachedCodexModel>,
}

#[derive(Deserialize)]
struct CachedCodexModel {
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    priority: i64,
}

pub fn check_cli() -> CodexStatus {
    match find_codex_binary() {
        Ok(binary) => CodexStatus {
            installed: true,
            version: version_for_binary(&binary),
        },
        Err(_) => CodexStatus {
            installed: false,
            version: None,
        },
    }
}

// Ordered like Codex, whose own default is the first listed model.
pub fn list_models() -> Vec<CodexModel> {
    codex_models_cache_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| models_from_cache(&contents).ok())
        .unwrap_or_default()
}

fn codex_models_cache_path() -> Option<PathBuf> {
    codex_home().map(|home| home.join("models_cache.json"))
}

fn codex_home() -> Option<PathBuf> {
    codex_home_from(
        std::env::var_os("CODEX_HOME").as_deref(),
        home_dir().as_deref(),
        cfg!(windows),
    )
}

fn codex_home_from(
    configured: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
    windows: bool,
) -> Option<PathBuf> {
    configured
        .filter(|path| !path.is_empty())
        .filter(|path| {
            let path = path.to_string_lossy();
            // WSLENV can pass a Linux CODEX_HOME unchanged to the native Windows CLI.
            // Keep native overrides (including UNC paths), not single-slash Unix paths.
            !windows || !path.starts_with('/') || path.starts_with("//")
        })
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".codex")))
}

fn models_from_cache(contents: &str) -> Result<Vec<CodexModel>, serde_json::Error> {
    let mut models = serde_json::from_str::<CodexModelsCache>(contents)?.models;
    models.sort_by_key(|model| model.priority);

    Ok(models
        .into_iter()
        .filter(|model| model.visibility == "list" && !model.slug.trim().is_empty())
        .map(|model| CodexModel {
            display_name: if model.display_name.trim().is_empty() {
                model.slug.clone()
            } else {
                model.display_name
            },
            id: model.slug,
        })
        .collect())
}

fn write_prompt(mut stdin: Option<impl Write>, prompt: &str) -> Result<(), String> {
    stdin
        .as_mut()
        .ok_or("Codex stdin was not available")?
        .write_all(prompt.as_bytes())
        .map_err(|_| "Failed to write Codex input".to_string())
    // Dropping stdin signals EOF, including on error.
}

// Execute the packaged native CLI, not its Node launcher: Child::kill must own
// the actual provider process on Windows and macOS as well as Linux.
fn native_codex_binary(binary: &Path) -> Result<PathBuf, String> {
    let target = if is_windows_script_shim(binary) {
        windows_shim_target_path(binary)
            .ok_or("Cannot resolve Codex shim; install the native Codex CLI")?
    } else {
        binary.to_path_buf()
    };
    let target = std::fs::canonicalize(target).map_err(|_| "Cannot resolve Codex executable")?;
    if is_native_binary(&target) {
        return Ok(target);
    }
    let package = target
        .parent()
        .and_then(Path::parent)
        .filter(|_| has_file_name(&target, "codex.js"))
        .ok_or("Unsupported Codex launcher; install the native Codex CLI")?;
    let manifest: serde_json::Value = std::fs::read_to_string(package.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or("Cannot read Codex package manifest")?;
    if manifest["name"] != "@openai/codex" {
        return Err("Unsupported Codex launcher package".into());
    }
    packaged_native_codex_binary(package, std::env::consts::OS, std::env::consts::ARCH)
}

fn packaged_native_codex_binary(package: &Path, os: &str, arch: &str) -> Result<PathBuf, String> {
    let (triple, platform) =
        codex_native_platform(os, arch).ok_or("Unsupported Codex native platform")?;
    // Match Node resolution: nearest optional platform package first, legacy
    // bundled vendor directory last. Both current and older layouts exist.
    let mut roots = package
        .ancestors()
        .map(|ancestor| {
            ancestor
                .join("node_modules/@openai")
                .join(format!("codex-{platform}"))
        })
        .collect::<Vec<_>>();
    roots.push(package.to_path_buf());
    let executable = if os == "windows" {
        "codex.exe"
    } else {
        "codex"
    };
    roots
        .into_iter()
        .flat_map(|root| {
            ["bin", "codex"].map(|directory| {
                root.join("vendor")
                    .join(triple)
                    .join(directory)
                    .join(executable)
            })
        })
        .find(|path| is_native_binary(path) && is_executable_file(path))
        .ok_or("Codex native binary not found; reinstall Codex for this platform".into())
}

fn codex_native_platform(os: &str, arch: &str) -> Option<(&'static str, &'static str)> {
    match (os, arch) {
        ("linux", "x86_64") => Some(("x86_64-unknown-linux-musl", "linux-x64")),
        ("linux", "aarch64") => Some(("aarch64-unknown-linux-musl", "linux-arm64")),
        ("macos", "x86_64") => Some(("x86_64-apple-darwin", "darwin-x64")),
        ("macos", "aarch64") => Some(("aarch64-apple-darwin", "darwin-arm64")),
        ("windows", "x86_64") => Some(("x86_64-pc-windows-msvc", "win32-x64")),
        ("windows", "aarch64") => Some(("aarch64-pc-windows-msvc", "win32-arm64")),
        _ => None,
    }
}

fn is_native_binary(path: &Path) -> bool {
    let mut magic = [0; 4];
    if std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_err()
    {
        return false;
    }
    magic.starts_with(b"MZ")
        || magic == *b"\x7fELF"
        || matches!(
            magic,
            [0xcf, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xce, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xce]
                | [0xca, 0xfe, 0xba, 0xbe]
                | [0xbe, 0xba, 0xfe, 0xca]
                | [0xca, 0xfe, 0xba, 0xbf]
                | [0xbf, 0xba, 0xfe, 0xca]
        )
}

fn find_codex_binary() -> Result<PathBuf, String> {
    find_optional_codex_binary()?.ok_or_else(|| "Codex CLI not found".into())
}

pub(crate) fn cli_missing() -> bool {
    matches!(find_optional_codex_binary(), Ok(None))
}

fn find_optional_codex_binary() -> Result<Option<PathBuf>, String> {
    find_codex_binary_with(shell_candidates(), codex_binary_candidates(), run_command)
}

fn find_codex_binary_with(
    shells: Vec<PathBuf>,
    candidates: Vec<PathBuf>,
    mut run_lookup: impl FnMut(&mut Command, Duration, bool) -> Result<String, String>,
) -> Result<Option<PathBuf>, String> {
    let lookup = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = run_lookup(
        hidden_command(lookup).arg("codex"),
        Duration::from_secs(15),
        true,
    ) {
        if let Some(binary) = first_existing_path(&output) {
            return Ok(Some(binary));
        }
    }
    for shell in shells.into_iter().filter(|shell| shell.exists()) {
        if let Ok(output) = run_lookup(
            hidden_command(shell).args(["-lc", "command -v codex"]),
            Duration::from_secs(15),
            true,
        ) {
            if let Some(binary) = first_existing_path(&output) {
                return Ok(Some(binary));
            }
        }
    }
    find_executable_binary_candidate(candidates)
}

pub(crate) fn shell_candidates() -> Vec<PathBuf> {
    let mut shells = Vec::new();

    if let Some(shell) = std::env::var_os("SHELL") {
        if !shell.is_empty() {
            shells.push(PathBuf::from(shell));
        }
    }

    shells.push(PathBuf::from("/bin/zsh"));
    shells.push(PathBuf::from("/bin/bash"));
    shells
}

fn first_existing_path(stdout: &str) -> Option<PathBuf> {
    first_existing_path_for_platform(stdout, cfg!(windows))
}

fn first_existing_path_for_platform(stdout: &str, windows: bool) -> Option<PathBuf> {
    let paths = stdout.lines().filter_map(existing_path);

    if windows {
        return paths
            .into_iter()
            .find(|path| is_native_windows_executable(path) || is_windows_script_shim(path));
    }

    paths.into_iter().next()
}

fn existing_path(line: &str) -> Option<PathBuf> {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return None;
    }

    let path = PathBuf::from(trimmed);
    path.exists().then_some(path)
}

fn find_executable_binary_candidate(candidates: Vec<PathBuf>) -> Result<Option<PathBuf>, String> {
    let mut first_unusable_candidate = None;
    let mut executable_candidates = Vec::new();

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }

        if is_executable_file(&candidate) {
            executable_candidates.push(candidate);
            continue;
        }

        if first_unusable_candidate.is_none() {
            first_unusable_candidate = Some(candidate);
        }
    }

    if cfg!(windows) {
        if let Some(candidate) = executable_candidates
            .iter()
            .find(|candidate| is_native_windows_executable(candidate))
            .cloned()
        {
            return Ok(Some(candidate));
        }
    }

    if let Some(candidate) = executable_candidates.into_iter().next() {
        return Ok(Some(candidate));
    }

    match first_unusable_candidate {
        Some(candidate) => Err(format!(
            "Codex CLI binary found at {} but it is not executable",
            candidate.display()
        )),
        None => Ok(None),
    }
}

fn codex_binary_candidates() -> Vec<PathBuf> {
    home_dir()
        .map(|home| codex_binary_candidates_for_home(&home))
        .unwrap_or_default()
}

fn codex_binary_candidates_for_home(home: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        home.join(".local/bin/codex"),
        home.join(".local/bin/codex.exe"),
        home.join(".local/bin/codex.cmd"),
        home.join(".codex/bin/codex"),
        home.join(".codex/bin/codex.exe"),
        home.join(".codex/bin/codex.cmd"),
        home.join(".npm-global/bin/codex"),
        home.join(".npm-global/bin/codex.cmd"),
        home.join(".npm-global/bin/codex.exe"),
        home.join(".npm/bin/codex"),
        home.join(".npm/bin/codex.cmd"),
        home.join(".npm/bin/codex.exe"),
        home.join(".bun/bin/codex"),
        home.join(".bun/bin/codex.exe"),
        home.join(".bun/bin/codex.cmd"),
        home.join("AppData/Roaming/npm/codex.cmd"),
        home.join("AppData/Roaming/npm/codex.exe"),
        home.join("AppData/Local/pnpm/codex.cmd"),
        home.join("AppData/Local/pnpm/codex.exe"),
        home.join("scoop/shims/codex.cmd"),
        home.join("scoop/shims/codex.exe"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
    ];

    candidates.extend(nvm_codex_binary_candidates_for_home(home));
    candidates
}

fn nvm_codex_binary_candidates_for_home(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) else {
        return Vec::new();
    };

    let mut candidates = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .map(|path| path.join("bin").join("codex"))
        .collect::<Vec<_>>();
    candidates.sort();
    candidates
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        return std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }

    #[cfg(windows)]
    {
        return path.is_file() && has_extension(path, &["bat", "cmd", "com", "exe"]);
    }

    #[cfg(all(not(unix), not(windows)))]
    {
        path.is_file()
    }
}

fn version_for_binary(binary: &Path) -> Option<String> {
    let output = run_command(
        codex_command(binary).arg("--version"),
        Duration::from_secs(15),
        true,
    )
    .ok()?;

    Some(output.trim().to_string()).filter(|version| !version.is_empty())
}

fn codex_command(binary: &Path) -> Command {
    let mut command = cli_command(binary);
    if let Some(home) = codex_home() {
        command.env("CODEX_HOME", home);
    } else {
        command.env_remove("CODEX_HOME");
    }
    command
}

pub(crate) fn cli_command(binary: &Path) -> Command {
    let target = command_target_avoiding_windows_shim(binary);
    let mut command = hidden_command(&target.program);
    if let Some(path) = expanded_agent_path(binary) {
        command.env("PATH", path);
    }
    if let Some(first_arg) = target.first_arg {
        command.arg(first_arg);
    }
    command
}

fn command_target_avoiding_windows_shim(binary: &Path) -> CodexCommandTarget {
    if !cfg!(windows) || !is_windows_script_shim(binary) {
        return CodexCommandTarget {
            program: binary.to_path_buf(),
            first_arg: None,
        };
    }

    let Some(target) = windows_shim_target_path(binary) else {
        return CodexCommandTarget {
            program: binary.to_path_buf(),
            first_arg: None,
        };
    };

    if is_node_script(&target) {
        return CodexCommandTarget {
            program: find_node_for_shim(binary),
            first_arg: Some(target),
        };
    }

    CodexCommandTarget {
        program: target,
        first_arg: None,
    }
}

fn windows_shim_target_path(binary: &Path) -> Option<PathBuf> {
    let contents = std::fs::read_to_string(binary).ok()?;

    contents
        .split('"')
        .skip(1)
        .step_by(2)
        .find_map(|token| resolve_windows_shim_target(binary, token))
}

fn resolve_windows_shim_target(binary: &Path, token: &str) -> Option<PathBuf> {
    let relative = token
        .strip_prefix("%dp0%")
        .or_else(|| token.strip_prefix("%~dp0"))?
        .trim_start_matches(['\\', '/']);
    let mut target = binary.parent()?.to_path_buf();

    for part in relative.split(['\\', '/']).filter(|part| !part.is_empty()) {
        target.push(part);
    }

    is_supported_windows_shim_target(&target)
        .then_some(target)
        .filter(|target| target.is_file())
}

fn is_supported_windows_shim_target(path: &Path) -> bool {
    is_node_script(path) || is_native_windows_executable(path)
}

fn is_node_script(path: &Path) -> bool {
    has_extension(path, &["js", "mjs", "cjs"])
}

fn is_native_windows_executable(path: &Path) -> bool {
    has_extension(path, &["exe", "com"]) && !has_file_name(path, "node.exe")
}

fn is_windows_script_shim(path: &Path) -> bool {
    has_extension(path, &["cmd", "bat", "ps1"])
}

fn has_extension(path: &Path, expected_extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            expected_extensions
                .iter()
                .any(|expected| extension.eq_ignore_ascii_case(expected))
        })
}

fn has_file_name(path: &Path, expected_name: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(expected_name))
}

fn find_node_for_shim(binary: &Path) -> PathBuf {
    binary
        .parent()
        .map(|parent| parent.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .filter(|node| node.is_file())
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }))
}

pub(crate) fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[cfg(windows)]
    let mut command = Command::new(program);
    #[cfg(not(windows))]
    let command = Command::new(program);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

fn expanded_agent_path(binary: &Path) -> Option<std::ffi::OsString> {
    let mut paths = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();

    for candidate in agent_path_candidates(binary) {
        if !paths.iter().any(|path| path == &candidate) {
            paths.push(candidate);
        }
    }

    std::env::join_paths(paths).ok()
}

fn agent_path_candidates(binary: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(parent) = binary
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        candidates.push(parent.to_path_buf());
        if let Some(arch_root) = parent.parent() {
            let packaged_path = arch_root.join("path");
            if packaged_path.is_dir() {
                candidates.push(packaged_path);
            }
        }
    }

    if let Some(home) = home_dir() {
        candidates.extend([
            home.join(".local/bin"),
            home.join(".codex/bin"),
            home.join(".npm-global/bin"),
            home.join(".npm/bin"),
            home.join(".bun/bin"),
            home.join("AppData/Roaming/npm"),
            home.join("AppData/Local/pnpm"),
            home.join("scoop/shims"),
        ]);
    }

    candidates.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);

    candidates
}

fn read_stderr_async(
    stderr: Option<std::process::ChildStderr>,
) -> Option<std::thread::JoinHandle<String>> {
    stderr.map(|stderr| std::thread::spawn(move || execution::read_bounded(stderr, 8 * 1024)))
}

fn read_stderr(stderr_reader: Option<std::thread::JoinHandle<String>>) -> String {
    stderr_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default()
}

fn format_codex_error(stderr_output: &str, status: ExitStatus) -> String {
    let lower = stderr_output.to_ascii_lowercase();

    if ["auth", "login", "sign in"]
        .iter()
        .any(|pattern| lower.contains(pattern))
    {
        return "Codex CLI is not authenticated. Run `codex login` in a terminal.".into();
    }

    if stderr_output.trim().is_empty() {
        format!("Codex exited with status {status}")
    } else {
        stderr_output.lines().take(3).collect::<Vec<_>>().join("\n")
    }
}

#[cfg(test)]
#[path = "codex_cli_tests.rs"]
mod tests;
