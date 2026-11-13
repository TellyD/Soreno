#!/bin/sh
# Serves the mobile page from source with Vite, in front of a local soreno-relay and of a
# soreno-remote built from the repository, next to the installed service. Run it on the machine
# that hosts the sessions, then open the printed pairing link in a browser of this machine.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

fail() {
  printf 'dev-mobile: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js not found."
command -v curl >/dev/null 2>&1 || fail "curl not found."
[ -d "$HOME/.cache/soreno/sessions" ] || [ -d "$HOME/.cache/soreno/conversations" ] || fail "no Soreno session on this machine."

cargo build --manifest-path src-tauri/Cargo.toml -p soreno-relay -p soreno-remote
relay=src-tauri/target/debug/soreno-relay
remote=src-tauri/target/debug/soreno-remote

free_port() {
  node -e 'const server = require("net").createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); })'
}
phones_port=$(free_port)
servers_port=$(free_port)
vite_port=$(free_port)
while [ "$servers_port" = "$phones_port" ]; do servers_port=$(free_port); done
while [ "$vite_port" = "$phones_port" ] || [ "$vite_port" = "$servers_port" ]; do
  vite_port=$(free_port)
done
origin=http://127.0.0.1:$vite_port

# Own HOME: the real sessions, but not the identity, devices and state.json of the installed service.
home=$(mktemp -d)
pids=
cleanup() {
  for pid in $pids; do kill "$pid" 2>/dev/null || :; done
  rm -rf -- "$home"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir -p "$home/.cache/soreno"
for shared in sessions conversations dtach; do
  # Dangling is fine: soreno-remote sees the directory once it is created.
  ln -s "$HOME/.cache/soreno/$shared" "$home/.cache/soreno/$shared"
done

relay_key=$("$relay" keygen "$home/relay.key")
"$relay" serve --phones "127.0.0.1:$phones_port" --servers "127.0.0.1:$servers_port" \
  --origin "$origin" --key "$home/relay.key" &
pids="$pids $!"
HOME=$home "$remote" serve --relay "ws://127.0.0.1:$servers_port" --relay-key "$relay_key" &
pids="$pids $!"
SORENO_RELAY_DEV="http://127.0.0.1:$phones_port" ./node_modules/.bin/vite \
  --config vite.mobile.config.ts --host 127.0.0.1 --port "$vite_port" --strictPort \
  --logLevel warn --clearScreen false &
vite_pid=$!
pids="$pids $vite_pid"

tries=0
until curl -fso /dev/null "$origin/"; do
  tries=$((tries + 1))
  [ "$tries" -lt 150 ] || fail "Vite is not responding on port $vite_port."
  sleep 0.2
done
state=$home/.cache/soreno/remote/state.json
tries=0
until [ -f "$state" ] && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).connected ? 0 : 1)' "$state" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 50 ] || fail "soreno-remote cannot connect to the local relay."
  sleep 0.2
done

pairing=$(HOME=$home "$remote" pair) || fail "soreno-remote pair failed."
link=$(printf '%s' "$pairing" | node -e 'const pairing = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(`${process.argv[1]}/#p=${pairing.server}.${pairing.secret}`)' "$origin")

printf '\nDevelopment mobile page: %s/\nPairing link (10 minutes): %s\nCtrl+C to stop everything.\n\n' "$origin" "$link"
wait "$vite_pid"
