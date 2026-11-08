#!/bin/sh
set -eu

dtach_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_archive="$dtach_dir/source/dtach-0.9.tar.gz"
output_dir=${OUTPUT_DIR:-"$dtach_dir/bin"}
zig=${ZIG:-zig}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[ "$($zig version)" = 0.14.1 ] || {
  echo "Zig 0.14.1 est requis pour reconstruire dtach." >&2
  exit 1
}
[ "$(sha256 "$source_archive")" = 32e9fd6923c553c443fab4ec9c1f95d83fa47b771e6e1dafb018c567291492f3 ] || {
  echo "Archive source dtach altérée." >&2
  exit 1
}

work=$(mktemp -d "${TMPDIR:-/tmp}/soreno-dtach.XXXXXX")
trap 'rm -rf "$work"' EXIT
tar -xzf "$source_archive" -C "$work"
src="$work/dtach-0.9"
patch -s -d "$src" -p1 < "$dtach_dir/soreno-history.patch"
cat > "$src/config.h" <<'EOF'
#define HAVE_FORKPTY 1
#define HAVE_OPENPTY 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_RESOURCE_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_UNISTD_H 1
#define TIME_WITH_SYS_TIME 1
#define PACKAGE_BUGREPORT ""
#define PACKAGE_VERSION "0.9"
#define RETSIGTYPE void
EOF
cat > "$src/darwin-pty.h" <<'EOF'
#include <termios.h>
#include <sys/ioctl.h>
int forkpty(int *, char *, const struct termios *, const struct winsize *);
EOF

rm -rf "$output_dir"
mkdir -p "$output_dir/linux-x86_64" "$output_dir/linux-aarch64" \
  "$output_dir/macos-x86_64" "$output_dir/macos-arm64"
common="-Os -Wno-date-time -Wno-builtin-macro-redefined -D__DATE__=\"2016-11-28\" -D__TIME__=\"00:00:00\""

printf '#define HAVE_PTY_H 1\n' >> "$src/config.h"
# shellcheck disable=SC2086
$zig cc -target x86_64-linux-musl -static $common -I"$src" "$src/attach.c" "$src/master.c" "$src/main.c" -lutil -o "$output_dir/linux-x86_64/dtach"
# shellcheck disable=SC2086
$zig cc -target aarch64-linux-musl -static $common -I"$src" "$src/attach.c" "$src/master.c" "$src/main.c" -lutil -o "$output_dir/linux-aarch64/dtach"
sed -i.bak '$d' "$src/config.h" && rm "$src/config.h.bak"

for target in x86_64:macos-x86_64 aarch64:macos-arm64; do
  architecture=${target%%:*}
  destination=${target#*:}
  # shellcheck disable=SC2086
  $zig cc -target "$architecture-macos.11.0-none" $common \
    -include "$src/darwin-pty.h" -I"$src" "$src/attach.c" "$src/master.c" \
    "$src/main.c" -o "$output_dir/$destination/dtach"
done

chmod 0644 "$output_dir"/*/dtach
for binary in "$output_dir"/*/dtach; do
  printf '%s  %s\n' "$(sha256 "$binary")" "$binary"
done
