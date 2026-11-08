# Shared by setup-vps.sh and deploy.sh: sourced, not run.

relay_host=relay.soreno.dev
page_origin=https://mobile.soreno.dev
relay_user=soreno-relay
relay_state=/var/lib/soreno-relay
relay_key=$relay_state/relay.key
relay_dir=/usr/local/lib/soreno-relay
relay_bin=$relay_dir/soreno-relay

fail() {
  printf 'relais : %s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "à lancer avec sudo."

case $(uname -m) in
  x86_64) built_target=x86_64-unknown-linux-musl ;;
  aarch64) built_target=aarch64-unknown-linux-musl ;;
  *) fail "architecture non prise en charge : $(uname -m)." ;;
esac
# The caller's first argument, if any, is a binary built elsewhere.
built=${1:-$root/src-tauri/target/$built_target/release/soreno-relay}
[ -x "$built" ] ||
  fail "binaire absent : $built (lancer d’abord « npm run build:relay » sans sudo, ou passer le chemin du binaire)."

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
