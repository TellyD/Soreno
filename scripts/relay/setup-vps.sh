#!/bin/sh
# Installs the Soreno relay on the VPS, once: `sudo sh scripts/relay/setup-vps.sh [binary]` after
# `npm run build:relay`. Safe to run again. Then scripts/relay/deploy.sh updates the relay.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/scripts/relay/common.sh"

caddy_version=2.11.7
caddy_bin=/usr/local/bin/caddy
case $(uname -m) in
  x86_64)
    caddy_arch=amd64
    caddy_sha256=727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b
    ;;
  aarch64)
    caddy_arch=arm64
    caddy_sha256=d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42
    ;;
esac

command -v systemctl >/dev/null 2>&1 || fail "systemd not found."
command -v curl >/dev/null 2>&1 || fail "curl not found (apt install curl)."

system_user() {
  id -u "$1" >/dev/null 2>&1 ||
    useradd --system --user-group --home-dir "$2" --no-create-home --shell /usr/sbin/nologin "$1"
}

# Writes stdin to $1 and sets changed=yes when its content differs.
write_file() {
  tmp=$(mktemp)
  cat >"$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then
    rm -f "$tmp"
  else
    install -m 0644 "$tmp" "$1"
    rm -f "$tmp"
    changed=yes
  fi
}

echo "Relay: user, state directory and binary…"
system_user "$relay_user" "$relay_state"
install -d -m 0700 -o "$relay_user" -g "$relay_user" "$relay_state"
install_relay_binary
if [ ! -f "$relay_key" ]; then
  runuser -u "$relay_user" -- "$relay_bin" keygen "$relay_key" >/dev/null
  echo "Relay key created: $relay_key"
fi

echo "Caddy $caddy_version…"
case $([ -x "$caddy_bin" ] && "$caddy_bin" version) in
  "v$caddy_version" | "v$caddy_version "*) caddy_current=yes ;;
  *) caddy_current=no ;;
esac
if [ "$caddy_current" = no ]; then
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  archive=caddy_${caddy_version}_linux_$caddy_arch.tar.gz
  curl -fsSL -o "$work/$archive" \
    "https://github.com/caddyserver/caddy/releases/download/v$caddy_version/$archive"
  printf '%s  %s\n' "$caddy_sha256" "$work/$archive" | sha256sum -c --quiet - ||
    fail "unexpected Caddy SHA-256 checksum: installation aborted."
  tar -xzf "$work/$archive" -C "$work" caddy
  install -m 0755 "$work/caddy" "$caddy_bin.new"
  mv -f "$caddy_bin.new" "$caddy_bin"
  caddy_changed=yes
else
  caddy_changed=no
fi
system_user caddy /var/lib/caddy
install -d -m 0700 -o caddy -g caddy /var/lib/caddy
install -d -m 0755 /etc/caddy

changed=$caddy_changed
write_file /etc/caddy/Caddyfile <<EOF
# No admin API: any local process could reconfigure Caddy through it to intercept the phones' socket.
{
	admin off
}

$relay_host {
	# WebSockets included; X-Forwarded-For carries the phone's address, never the incoming value.
	reverse_proxy unix//run/soreno-relay/phones.sock
}
EOF
write_file /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy, HTTPS for the Soreno mobile relay
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
# Reaches the relay's socket, whose directory only the relay's group may enter.
SupplementaryGroups=$relay_user
Environment=HOME=/var/lib/caddy
ExecStart=$caddy_bin run --environ --config /etc/caddy/Caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/caddy
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
runuser -u caddy -- env HOME=/var/lib/caddy "$caddy_bin" validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 ||
  fail "invalid Caddyfile: $caddy_bin validate --config /etc/caddy/Caddyfile"
systemctl daemon-reload
systemctl enable caddy.service >/dev/null
if [ "$changed" = yes ] || ! systemctl is-active --quiet caddy.service; then
  systemctl restart caddy.service
fi

# After Caddy, which thus never proxies to the port an older relay just freed.
echo "Relay: service…"
changed=$relay_changed
write_file /etc/systemd/system/soreno-relay.service <<EOF
[Unit]
Description=Soreno mobile relay
After=network-online.target
Wants=network-online.target

[Service]
User=$relay_user
Group=$relay_user
# Only the relay and Caddy, a member of its group, may enter it.
RuntimeDirectory=soreno-relay
RuntimeDirectoryMode=0750
ExecStart=$relay_bin serve --phones unix:/run/soreno-relay/phones.sock --servers 0.0.0.0:8790 --origin $page_origin --key $relay_key
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=$relay_state
LimitNOFILE=65536
TasksMax=8192

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable soreno-relay.service >/dev/null
if [ "$changed" = yes ] || ! systemctl is-active --quiet soreno-relay.service; then
  systemctl restart soreno-relay.service
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  for port in 80 443 8790; do
    ufw allow "$port/tcp" >/dev/null
  done
  echo "ufw firewall: ports 80, 443 and 8790 opened."
fi

sleep 2
systemctl is-active --quiet soreno-relay.service || fail "soreno-relay is not running: journalctl -u soreno-relay"
systemctl is-active --quiet caddy.service || fail "Caddy is not running: journalctl -u caddy"

printf '\nRelay installed: phones on wss://%s, servers on ws://%s:8790/relay/server\n' "$relay_host" "$relay_host"
printf 'Relay public key (RELAY_PUBLIC_KEY): %s\n' \
  "$(runuser -u "$relay_user" -- "$relay_bin" public-key "$relay_key")"
echo "Ports 80, 443 and 8790 must also be open in the hosting provider's firewall."
