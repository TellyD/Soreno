#!/bin/sh
# Opt-in integration test: disposable SSH server, no access to the user's SSH keys.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
work=$(mktemp -d)
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
ssh-keygen -q -t ed25519 -N '' -f "$work/key"
docker build -q -t soreno-ssh-test scripts/ssh-fixture >/dev/null
container=$(docker run -d -p 127.0.0.1::22 soreno-ssh-test)
docker cp "$work/key.pub" "$container:/home/soreno/.ssh/authorized_keys" >/dev/null
docker exec "$container" sh -c 'chown soreno:soreno /home/soreno/.ssh/authorized_keys; chmod 600 /home/soreno/.ssh/authorized_keys'
port=$(docker port "$container" 22/tcp | sed 's/.*://')
host_key=$(docker exec "$container" cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d ' ' -f 1,2)
export SORENO_SSH_TEST_KEY="$work/key" SORENO_SSH_TEST_PORT="$port" SORENO_SSH_TEST_HOST_KEY="$host_key"
cargo test --manifest-path "$root/src-tauri/Cargo.toml" ssh::live_tests --lib -- --ignored --test-threads=1 --nocapture
