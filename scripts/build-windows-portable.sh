#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cmd_exe="/mnt/c/Windows/System32/cmd.exe"
powershell_exe="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

if ! command -v wslpath >/dev/null 2>&1; then
  echo "Ce lanceur doit être exécuté depuis WSL." >&2
  exit 1
fi

windows_local_app_data=$(cd /mnt/c && "$cmd_exe" /d /c "echo %LOCALAPPDATA%" | tr -d '\r')
windows_user_profile=$(cd /mnt/c && "$cmd_exe" /d /c "echo %USERPROFILE%" | tr -d '\r')
destination="${SORENO_PORTABLE_DIR:-$(wslpath -u "$windows_user_profile")/Soreno}"
build_dir="$(wslpath -u "$windows_local_app_data")/Soreno/target/release"
source_exe="$build_dir/soreno.exe"
source_conpty="$build_dir/conpty"
source_dtach="$build_dir/dtach"
destination_exe="$destination/soreno.exe"

cd "$project_dir"
npm run build:windows

if [ ! -f "$source_exe" ]; then
  printf 'Erreur : artefact manquant : %s\n' "$source_exe" >&2
  exit 1
fi

for relative_path in \
  x64/conpty.dll x64/OpenConsole.exe \
  arm64/conpty.dll arm64/OpenConsole.exe \
  x86/conpty.dll x86/OpenConsole.exe \
  LICENSE SOURCE.md
do
  if [ ! -f "$source_conpty/$relative_path" ]; then
    printf 'Erreur : ressource ConPTY manquante : %s\n' "$source_conpty/$relative_path" >&2
    exit 1
  fi
done
for relative_path in LICENSE SOURCE.md source/dtach-0.9.tar.gz build.sh soreno-history.patch
do
  if [ ! -f "$source_dtach/$relative_path" ]; then
    printf 'Erreur : ressource dtach manquante : %s\n' "$source_dtach/$relative_path" >&2
    exit 1
  fi
done

staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/soreno-portable.XXXXXX")
trap 'rm -rf "$staging_dir"' EXIT
if ! cp "$source_exe" "$staging_dir/soreno.exe" \
  || ! cp -R "$source_conpty" "$staging_dir/conpty" \
  || ! cp -R "$source_dtach" "$staging_dir/dtach"
then
  printf 'Erreur : impossible de préparer le dossier portable temporaire. Relancez la commande.\n' >&2
  exit 1
fi

mkdir -p "$destination"

attempts=0
while ! cp "$staging_dir/soreno.exe" "$destination_exe" 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -eq 1 ]; then
    printf 'Copie impossible : fermez Soreno normalement pour libérer %s. Nouvelle tentative pendant 10 secondes…\n' \
      "$destination_exe" >&2
  fi
  if [ "$attempts" -ge 40 ]; then
    printf 'Erreur : impossible de remplacer %s. Fermez Soreno puis relancez la commande.\n' \
      "$destination_exe" >&2
    exit 1
  fi
  sleep 0.25
done

if ! cp -R "$staging_dir/conpty" "$staging_dir/dtach" "$destination/"; then
  printf 'Erreur : impossible de remplacer les ressources dans %s. Fermez Soreno puis relancez la commande.\n' \
    "$destination" >&2
  exit 1
fi

for resource in conpty dtach; do
  if [ ! -f "$destination/$resource/LICENSE" ]; then
    printf 'Erreur : dossier de ressources incomplet dans %s. Fermez Soreno puis relancez la commande.\n' \
      "$destination/$resource" >&2
    exit 1
  fi
done

destination_archive="$destination/soreno.zip"
temporary_archive="$destination/.soreno-portable.zip"
rm -f "$temporary_archive" "$destination_archive"
exe_path=$(printf '%s' "$(wslpath -w "$destination_exe")" | base64 | tr -d '\r\n')
conpty_path=$(printf '%s' "$(wslpath -w "$destination/conpty")" | base64 | tr -d '\r\n')
dtach_path=$(printf '%s' "$(wslpath -w "$destination/dtach")" | base64 | tr -d '\r\n')
archive_path=$(printf '%s' "$(wslpath -w "$temporary_archive")" | base64 | tr -d '\r\n')
if ! "$powershell_exe" -NoProfile -NonInteractive -Command \
  '& { $ErrorActionPreference = "Stop"; $decode = { param($value) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }; $exe = & $decode $args[0]; $conpty = & $decode $args[1]; $dtach = & $decode $args[2]; $output = & $decode $args[3]; Compress-Archive -LiteralPath @($exe, $conpty, $dtach) -DestinationPath $output -Force }' \
  "$exe_path" "$conpty_path" "$dtach_path" "$archive_path" \
  || [ ! -f "$temporary_archive" ] \
  || ! mv "$temporary_archive" "$destination_archive"
then
  rm -f "$temporary_archive"
  printf 'Erreur : impossible de créer l’archive portable %s.\n' "$destination_archive" >&2
  exit 1
fi

printf '\nBuild portable installé : %s\nArchive portable créée : %s\n' \
  "$(wslpath -w "$destination")" "$(wslpath -w "$destination_archive")"
