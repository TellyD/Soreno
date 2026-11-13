# Shared by setup-vps.sh and deploy.sh: sourced, not run.

relay_host=relay.soreno.dev
page_origin=https://mobile.soreno.dev
relay_user=soreno-relay
relay_state=/var/lib/soreno-relay
relay_key=$relay_state/relay.key
relay_dir=/usr/local/lib/soreno-relay
relay_bin=$relay_dir/soreno-relay

fail() {
  printf 'relay: %s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "run with sudo."

case $(uname -m) in
  x86_64) built_target=x86_64-unknown-linux-musl ;;
  aarch64) built_target=aarch64-unknown-linux-musl ;;
  *) fail "unsupported architecture: $(uname -m)." ;;
esac
# The caller's first argument, if any, is a binary built elsewhere.
built=${1:-$root/src-tauri/target/$built_target/release/soreno-relay}
[ -x "$built" ] ||
  fail "missing binary: $built (first run \"npm run build:relay\" without sudo, or pass the binary path)."

# Sets relay_changed to yes when the installed binary was replaced.
install_relay_binary() {
  install -d -m 0755 "$relay_dir"
  relay_changed=no
  if [ -x "$relay_bin" ] && cmp -s "$built" "$relay_bin"; then
    return 0
  fi
  install -m 0755 "$built" "$relay_bin.new"
  mv -f "$relay_bin.new" "$relay_bin"
  relay_changed=yes
}
