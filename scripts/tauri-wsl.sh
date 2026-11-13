#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

if ! command -v wslpath >/dev/null 2>&1; then
  echo "This launcher must be run from WSL." >&2
  exit 1
fi

if [[ ! -e /proc/sys/fs/binfmt_misc/WSLInterop ]]; then
  cat >&2 <<'EOF'
WSL Windows interop is disabled: no Windows executable can start.
Close this session, open PowerShell on the Windows side and run:

  wsl --shutdown

Then reopen WSL and run sh scripts/tauri-wsl.sh again.
EOF
  exit 1
fi

action="${1:-dev}"
case "$action" in
  dev|build) ;;
  *) echo "Usage: $0 [dev|build]" >&2; exit 2 ;;
esac
dev_port=1422

node_version="$(tr -d '\r\n' < "$project_dir/.nvmrc")"
node_version="v${node_version#v}"
node_folder="node-${node_version}-linux-x64"
node_cache="$HOME/.cache/soreno/$node_folder"

node_is_recent() {
  command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20 && b>=19) || (a===22 && b>=12) || a>22 ? 0 : 1)'
}

if node_is_recent; then
  node_bin="$(command -v node)"
else
  node_bin="$node_cache/bin/node"
  if [[ ! -x "$node_bin" ]]; then
    echo "Soreno: installing Node ${node_version} locally in ~/.cache/soreno…"
    mkdir -p "$HOME/.cache/soreno"
    archive="$HOME/.cache/soreno/$node_folder.tar.xz"
    curl --fail --location --output "$archive" "https://nodejs.org/dist/${node_version}/${node_folder}.tar.xz"
    tar -xJf "$archive" -C "$HOME/.cache/soreno"
    rm -f "$archive"
  fi
fi

node_path="$(dirname "$node_bin")"
tauri_cli_version="$("$node_bin" -p "require('./node_modules/@tauri-apps/cli/package.json').version")"
project_windows="$(wslpath -w "$project_dir")"
cmd_exe="/mnt/c/Windows/System32/cmd.exe"
tooling_windows="%LOCALAPPDATA%\\Soreno\\tooling-$tauri_cli_version"
tauri_cli_windows="$tooling_windows\\node_modules\\@tauri-apps\\cli\\tauri.js"
# Keep Cargo's generated files outside Windows Temp, which may be cleaned independently.
windows_cargo_env="pushd \"$project_windows\" && set \"CARGO_INCREMENTAL=0\"&& set \"CARGO_TARGET_DIR=%LOCALAPPDATA%\\Soreno\\target\"&& set \"PATH=%USERPROFILE%\\.cargo\\bin;C:\\Program Files\\nodejs;%PATH%\"&&"

# WSL escapes embedded quotes in /c arguments; a batch file preserves CMD syntax.
run_windows_command() (
  local batch_file
  batch_file="$(mktemp /tmp/soreno-windows.XXXXXX.cmd)"
  trap 'rm -f "$batch_file"' EXIT
  printf '%s\r\n' '@echo off' 'chcp 65001 >nul' "$1" 'exit /b %errorlevel%' > "$batch_file"
  "$cmd_exe" /d /c "$(wslpath -w "$batch_file")"
)

install_windows_cli() {
  (
    cd /mnt/c
    run_windows_command "pushd \"$project_windows\" && if not exist \"$tauri_cli_windows\" (npm.cmd install --prefix \"$tooling_windows\" @tauri-apps/cli@$tauri_cli_version --no-save --no-audit --no-fund)"
  )
}

run_windows_tauri() {
  local build_args=""
  local tauri_config="src-tauri\\tauri.wsl.dev.conf.json"
  if [[ "$action" == "build" ]]; then
    build_args=" --no-bundle"
    tauri_config="src-tauri\\tauri.wsl.conf.json"
  fi

  (
    cd /mnt/c
    run_windows_command "$windows_cargo_env node.exe \"$tauri_cli_windows\" $action --config $tauri_config$build_args"
  )
}

build_windows_remote() {
  (
    cd /mnt/c
    run_windows_command "$windows_cargo_env node.exe scripts\\build-remote.mjs"
  )
}

echo "Soreno: preparing the Windows Tauri CLI…"
install_windows_cli

# The Windows-side configs drop the before* commands: the embedded binaries are built here.
echo "Soreno: building the soreno-remote binaries…"
build_windows_remote

if [[ "$action" == "build" ]]; then
  env PATH="$node_path:$PATH" TAURI_ENV_PLATFORM=windows npm run build
  run_windows_tauri
  exit $?
fi

echo "Soreno: starting Vite in WSL with $("$node_bin" --version)…"
vite_pid=""
cleanup() {
  if [[ -n "$vite_pid" ]]; then
    kill -- "-$vite_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

existing_page="$(curl --silent --fail --max-time 1 "http://127.0.0.1:$dev_port" 2>/dev/null || true)"
if [[ -n "$existing_page" ]]; then
  existing_is_current=false
  if command -v fuser >/dev/null 2>&1; then
    listener_pids="$(fuser -n tcp "$dev_port" 2>/dev/null || true)"
    if [[ -n "$listener_pids" ]]; then
      existing_is_current=true
      project_linux="$(pwd -P)"
      for pid in $listener_pids; do
        listener_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
        if [[ "$listener_cwd" != "$project_linux" ]]; then
          existing_is_current=false
          break
        fi
      done
    fi
  fi

  if [[ "$existing_is_current" != true ]]; then
    echo "Port $dev_port is used by another process or another clone." >&2
    exit 1
  fi

  echo "Soreno: restarting this project's Vite server on port $dev_port."
  kill $listener_pids 2>/dev/null || true
  for _ in {1..40}; do
    if ! curl --silent --fail --max-time 1 "http://127.0.0.1:$dev_port" >/dev/null 2>&1; then
      break
    fi
    sleep .1
  done
  if curl --silent --fail --max-time 1 "http://127.0.0.1:$dev_port" >/dev/null 2>&1; then
    echo "The existing Vite server on port $dev_port could not be stopped." >&2
    exit 1
  fi
fi

# Own process group: killing npm alone leaves the Vite node child holding the port.
# Vite runs outside the Tauri CLI here, so it must be told the frontend targets Windows.
setsid env PATH="$node_path:$PATH" TAURI_ENV_PLATFORM=windows npm run dev -- --host 0.0.0.0 --port "$dev_port" &
vite_pid=$!
vite_ready=false
for _ in {1..80}; do
  if curl --silent --fail "http://127.0.0.1:$dev_port" >/dev/null; then
    vite_ready=true
    break
  fi
  if ! kill -0 "$vite_pid" 2>/dev/null; then
    echo "Vite stopped before Tauri was launched." >&2
    exit 1
  fi
  sleep .25
done

if [[ "$vite_ready" != true ]]; then
  echo "Vite did not respond on port $dev_port in time." >&2
  exit 1
fi

echo "Soreno: launching the Windows app…"
run_windows_tauri
