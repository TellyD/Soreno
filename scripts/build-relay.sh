#!/bin/sh
# Builds the static Linux binary of soreno-relay for the VPS
# (x86_64 by default, `aarch64` as first argument). scripts/relay/deploy.sh installs it.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

case ${1:-x86_64} in
  x86_64) target=x86_64-unknown-linux-musl ;;
  aarch64) target=aarch64-unknown-linux-musl ;;
  *)
    echo "Unknown architecture: ${1} (x86_64 or aarch64)" >&2
    exit 2
    ;;
esac
rustup target list --installed | grep -qx "$target" || {
  echo "Missing Rust target: rustup target add $target" >&2
  exit 1
}

# musl targets are self-contained: rust-lld links them without a cross toolchain on any host.
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
  CARGO_PROFILE_RELEASE_STRIP=symbols \
  cargo build --manifest-path src-tauri/Cargo.toml --release --locked \
  -p soreno-relay --target "$target"

printf 'Relay built: %s\n' "src-tauri/target/$target/release/soreno-relay"
