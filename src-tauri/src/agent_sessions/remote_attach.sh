#!/bin/sh
# Installed by Soreno: attaches one of its SSH agent sessions from another terminal.
set -u
base="$HOME/.cache/soreno"
sessions="$base/sessions"

fail() {
  printf 'soreno-attach : %s\n' "$1" >&2
  exit 1
}

[ "$#" -le 1 ] || fail "usage : soreno-attach [session]"
[ -t 0 ] && [ -t 1 ] || fail "un terminal est nécessaire (ssh -t)."
dtach=
for candidate in "$base"/dtach/*/dtach; do
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then
    dtach=$candidate
    break
  fi
done
[ -n "$dtach" ] || fail "dtach introuvable dans $base/dtach."
own=$(tty) || own=

# Skips the session this helper runs in: attaching it to itself would loop.
live() {
  [ -S "$1/socket" ] || return 1
  pid=
  read -r pid _ 2>/dev/null < "$1/pid" || return 1
  case $pid in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ "$(cat "$1/tty" 2>/dev/null)" != "$own" ]
}

label() {
  name=$(LC_ALL=C tr -d '\000-\037\177' 2>/dev/null < "$1/label") || name=
  [ -n "$name" ] || name=${1##*/}
  if [ -x "$1/socket" ]; then
    printf '%s · rattachée' "$name"
  else
    printf '%s' "$name"
  fi
}

# The last attached client sets the PTY size: give the previous size back on exit so the
# Soreno window does not keep this terminal's layout, unless someone resized it since.
restore() {
  case $saved in [0-9]*' '[0-9]*) ;; *) return 0 ;; esac
  current=$(stty size 2>/dev/null < "$tty") || return 0
  [ "$current" != "$saved" ] || return 0
  # After a hangup this terminal is gone: its size at attach time stands in.
  mine=$(stty size 2>/dev/null) || mine=$applied
  [ "$current" = "$mine" ] || return 0
  set -- $saved
  stty rows "$1" cols "$2" 2>/dev/null < "$tty" || :
}

attach() {
  tty=$(cat "$1/tty" 2>/dev/null) || tty=
  saved=
  applied=$(stty size 2>/dev/null) || applied=
  case $tty in /dev/*) saved=$(stty size 2>/dev/null < "$tty") || saved= ;; esac
  trap 'restore; exit 129' HUP
  trap 'restore; exit 143' TERM
  printf 'Ctrl+\\ pour se détacher sans arrêter la session.\n'
  "$dtach" -a "$1/socket" -z -r winch
  code=$?
  restore
  exit "$code"
}

if [ "$#" -eq 1 ]; then
  case $1 in ???????????????????????????????? ) ;; *) fail "session invalide." ;; esac
  case $1 in *[!0-9a-f]*) fail "session invalide." ;; esac
  live "$sessions/$1" || fail "session introuvable ou arrêtée."
  attach "$sessions/$1"
fi

count=0
for dir in "$sessions"/*; do
  [ -d "$dir" ] && live "$dir" || continue
  count=$((count + 1))
  eval "session_$count=\$dir"
  printf '%2d  %s\n' "$count" "$(label "$dir")"
done
[ "$count" -gt 0 ] || fail "aucune session Soreno active sur ce serveur."
# Some mobile clients send CR LF: an empty line re-prompts instead of quitting.
while :; do
  printf 'Session à rattacher (1-%d, q pour quitter) : ' "$count"
  read -r choice || exit 0
  [ "$choice" != q ] || exit 0
  case $choice in '' | *[!0-9]*) continue ;; esac
  # `01` would otherwise look up an undefined `session_01`.
  choice=${choice#"${choice%%[!0]*}"}
  [ -n "$choice" ] && [ "$choice" -le "$count" ] || continue
  eval "attach \"\$session_$choice\""
done
