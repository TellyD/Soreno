#!/bin/sh
# Replaces the installed relay by the one `npm run build:relay` built (or the binary given), then
# restarts it: `sudo sh scripts/relay/deploy.sh [binaire]`. Requires scripts/relay/setup-vps.sh.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/scripts/relay/common.sh"

[ -f /etc/systemd/system/soreno-relay.service ] ||
  fail "relais non installé : lancer d’abord sudo sh scripts/relay/setup-vps.sh."

install_relay_binary
if [ "$relay_changed" = no ]; then
  echo "Binaire déjà à jour : redémarrage quand même."
fi
systemctl restart soreno-relay.service
sleep 2
systemctl is-active --quiet soreno-relay.service ||
  fail "soreno-relay ne tourne pas : journalctl -u soreno-relay -n 50"
printf 'Relais déployé : %s\n' "$("$relay_bin" --version)"
