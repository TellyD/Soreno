#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
sh -n scripts/build-windows-portable.sh
sh -n src-tauri/dtach/build.sh
bash -n scripts/tauri-wsl.sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Execute the actual root resolution and npm invocation from an unrelated cwd.
// Only npm is doubled: no Windows process, dev server or build is launched.
for (const file of ['scripts/tauri-wsl.sh', 'scripts/build-windows-portable.sh']) {
  const source = readFileSync(file, 'utf8');
  const result = spawnSync('bash', ['-eu', '-c', `
    ${source.match(/^project_dir=.*$/m)[0]}
    ${source.match(/^cd "\$project_dir"$/m)[0]}
    npm() { pwd -P; }
    ${source.match(/npm run (?:build:windows|build)\b/)[0]}
  `, resolve(file)], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.cwd(), file);
}

const launcher = readFileSync('scripts/tauri-wsl.sh', 'utf8');
// Resolve the fallback version/cache from .nvmrc without downloading Node or starting Windows.
const nodeDefaults = spawnSync('bash', ['-eu', '-c', `
  ${launcher.match(/^project_dir=.*$/m)[0]}
  ${launcher.match(/^node_(?:version|folder|cache)=.*$/gm).join('\n')}
  printf '%s\\n' "$node_version" "$node_folder" "$node_cache"
`, resolve('scripts/tauri-wsl.sh')], { cwd: tmpdir(), encoding: 'utf8' });
const pinnedNode = `v${readFileSync('.nvmrc', 'utf8').trim().replace(/^v/, '')}`;
assert.equal(nodeDefaults.status, 0, nodeDefaults.stderr);
assert.deepEqual(nodeDefaults.stdout.trim().split('\n'), [
  pinnedNode,
  `node-${pinnedNode}-linux-x64`,
  `${process.env.HOME}/.cache/soreno/node-${pinnedNode}-linux-x64`,
]);
// Exercise the real CMD bridge without Windows: preserve quotes/variables and clean up on failure.
const windowsCommand = launcher.slice(launcher.indexOf('run_windows_command()'), launcher.indexOf('install_windows_cli()'));
assert.ok(windowsCommand);
for (const status of [0, 7]) {
  const command = 'pushd "C:\\Project with spaces" && echo "%LOCALAPPDATA%"';
  const result = spawnSync('bash', ['-eu', '-c', `
    ${windowsCommand}
    wslpath() { printf '%s' "$2"; }
    mock_cmd() {
      [ "$#" -eq 3 ] && [ "$1" = /d ] && [ "$2" = /c ] || exit 99
      printf '%s\\n' "$3"
      cat "$3"
      return ${status}
    }
    cmd_exe=mock_cmd
    run_windows_command "$1"
  `, 'test', command], { encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr);
  const newline = result.stdout.indexOf('\n');
  const batchPath = result.stdout.slice(0, newline);
  assert.match(batchPath, /^\/tmp\/soreno-windows\.[\w]+\.cmd$/);
  assert.equal(result.stdout.slice(newline + 1), `@echo off\r\nchcp 65001 >nul\r\n${command}\r\nexit /b %errorlevel%\r\n`);
  assert.equal(existsSync(batchPath), false, 'Temporary batch must be removed');
}

const predicate = launcher.match(/node -e '([^']+)'/)[1];
for (const [version, expected] of [
  ['18.20.0', 1], ['20.18.9', 1], ['20.19.0', 0], ['20.99.0', 0],
  ['21.9.0', 1], ['22.0.0', 1], ['22.11.9', 1], ['22.12.0', 0],
  ['22.17.0', 0], ['23.0.0', 0], ['24.0.0', 0], ['30.0.0', 0],
]) {
  let status;
  runInNewContext(predicate, { process: { versions: { node: version }, exit: (code) => { status = code; } } });
  assert.equal(status, expected, version);
}

const build = readFileSync('scripts/build-windows-portable.sh', 'utf8');
const buildDirectory = spawnSync('sh', ['-eu', '-c', `
  windows_local_app_data='C:\\\\Users\\\\Test User\\\\AppData\\\\Local'
  wslpath() { printf '%s' '/mnt/c/Users/Test User/AppData/Local'; }
  ${build.match(/^build_dir=.*$/m)[0]}
  printf '%s' "$build_dir"
`], { encoding: 'utf8' });
assert.equal(buildDirectory.status, 0, buildDirectory.stderr);
assert.equal(buildDirectory.stdout, '/mnt/c/Users/Test User/AppData/Local/Soreno/target/release');
const destination = build.match(/^destination=.*$/m)[0];
for (const [override, expected] of [
  ['', '/mnt/c/Users/Test User/Soreno'],
  ['/mnt/c/Users/Test User/Soreno portable', '/mnt/c/Users/Test User/Soreno portable'],
]) {
  const result = spawnSync('sh', ['-eu', '-c', `
    wslpath() {
      [ "$#" -eq 2 ] && [ "$1" = -u ] && [ "$2" = "$windows_user_profile" ] || exit 99
      printf '%s' '/mnt/c/Users/Test User'
    }
    ${destination}
    printf '%s' "$destination"
  `], {
    encoding: 'utf8', env: { ...process.env, windows_user_profile: 'C:\\Users\\Test User', SORENO_PORTABLE_DIR: override },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected);
}

const conptyFiles = [
  'x64/conpty.dll', 'x64/OpenConsole.exe',
  'arm64/conpty.dll', 'arm64/OpenConsole.exe',
  'x86/conpty.dll', 'x86/OpenConsole.exe',
  'LICENSE', 'SOURCE.md',
];
const dtachResourceFiles = ['LICENSE', 'SOURCE.md', 'source/dtach-0.9.tar.gz', 'build.sh', 'soreno-history.patch'];
const dtachFiles = [
  'bin/linux-x86_64/dtach', 'bin/linux-aarch64/dtach',
  'bin/macos-x86_64/dtach', 'bin/macos-arm64/dtach',
  ...dtachResourceFiles,
];
for (const file of conptyFiles) assert.ok(existsSync(resolve('src-tauri/conpty', file)), file);
for (const file of dtachFiles) assert.ok(existsSync(resolve('src-tauri/dtach', file)), file);
const portableBody = build.slice(build.indexOf('if [ ! -f "$source_exe" ]'));
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'soreno launchers '));
const sourceRoot = resolve(fixtureRoot, 'build with spaces');
const sourceConpty = resolve(sourceRoot, 'conpty');
const sourceDtach = resolve(sourceRoot, 'dtach');
mkdirSync(sourceConpty, { recursive: true });
writeFileSync(resolve(sourceRoot, 'soreno.exe'), 'Soreno');
for (const [directory, files] of [[sourceConpty, conptyFiles], [sourceDtach, dtachResourceFiles]]) {
  for (const file of files) {
    mkdirSync(resolve(directory, file, '..'), { recursive: true });
    writeFileSync(resolve(directory, file), file);
  }
}

function runPortableCopy({ failures = 0, mode = 'exe', source = sourceRoot, destinationName = 'portable with spaces' } = {}) {
  const destinationPath = resolve(fixtureRoot, destinationName);
  const callsFile = resolve(fixtureRoot, `${destinationName}.calls`);
  const result = spawnSync('sh', ['-eu', '-c', `
    source_exe="$SOURCE/soreno.exe"
    source_conpty="$SOURCE/conpty"
    source_dtach="$SOURCE/dtach"
    destination="$DESTINATION"
    destination_exe="$destination/soreno.exe"
    calls=0
    cp() {
      printf 'x' >> "$CALLS_FILE"
      if [ "$MODE" = exe ] && [ "$#" -eq 2 ] && [ "$2" = "$destination_exe" ]; then
        calls=$((calls + 1))
        [ "$calls" -le "$FAILURES" ] && return 1
      fi
      if [ "$MODE" = resource ] && [ "$#" -eq 4 ] \
        && [ "$1" = -R ] && [ "$2" = "$staging_dir/conpty" ] \
        && [ "$3" = "$staging_dir/dtach" ] && [ "$4" = "$destination/" ]; then
        return 1
      fi
      command cp "$@"
    }
    sleep() { :; }
    decode() { printf '%s' "$1" | base64 -d; }
    mock_powershell() {
      [ "$#" -eq 8 ] && [ "$1" = -NoProfile ] && [ "$2" = -NonInteractive ] && [ "$3" = -Command ] || exit 99
      [ "$MODE" = archive ] && return 1
      exe=$(decode "$5")
      conpty=$(decode "$6")
      dtach=$(decode "$7")
      output=$(decode "$8")
      [ "$exe" = "$destination_exe" ] && [ "$conpty" = "$destination/conpty" ] \
        && [ "$dtach" = "$destination/dtach" ] || exit 99
      {
        printf 'soreno.exe\n'
        (cd "$destination" && find conpty dtach -type f | sort)
      } > "$output"
    }
    powershell_exe=mock_powershell
    wslpath() {
      [ "$#" -eq 2 ] && [ "$1" = -w ] || exit 99
      if [ "$2" = "$destination" ]; then
        printf '%s\n' 'C:\\portable with spaces'
      else
        printf '%s\n' "$2"
      fi
    }
    ${portableBody}
  `], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SOURCE: source,
      DESTINATION: destinationPath,
      CALLS_FILE: callsFile,
      FAILURES: String(failures),
      MODE: mode,
    },
  });
  return { result, destinationPath, callsFile };
}

try {
  for (const failures of [0, 2, 40]) {
    const destinationName = `portable ${failures}`;
    if (failures === 40) {
      mkdirSync(resolve(fixtureRoot, destinationName, 'conpty'), { recursive: true });
      writeFileSync(resolve(fixtureRoot, destinationName, 'soreno.exe'), 'ancienne version');
      writeFileSync(resolve(fixtureRoot, destinationName, 'conpty/sentinel'), 'ressources actives');
    }
    const run = runPortableCopy({ failures, destinationName });
    assert.equal(run.result.status, failures === 40 ? 1 : 0, run.result.stderr);
    if (failures) assert.match(run.result.stderr, /fermez Soreno normalement/);
    if (failures === 40) {
      assert.match(run.result.stderr, /Erreur : impossible de remplacer/);
      assert.equal(readFileSync(resolve(run.destinationPath, 'soreno.exe'), 'utf8'), 'ancienne version');
      assert.equal(readFileSync(resolve(run.destinationPath, 'conpty/sentinel'), 'utf8'), 'ressources actives');
      assert.equal(existsSync(resolve(run.destinationPath, 'conpty/x64/conpty.dll')), false);
      assert.doesNotMatch(run.result.stdout, /Build portable installé/);
    } else {
      assert.equal(readFileSync(resolve(run.destinationPath, 'soreno.exe'), 'utf8'), 'Soreno');
      for (const file of conptyFiles) assert.ok(existsSync(resolve(run.destinationPath, 'conpty', file)), file);
      for (const file of dtachResourceFiles) assert.ok(existsSync(resolve(run.destinationPath, 'dtach', file)), file);
      const archiveManifest = readFileSync(resolve(run.destinationPath, 'soreno.zip'), 'utf8');
      assert.match(archiveManifest, /^soreno\.exe$/m);
      for (const file of conptyFiles) assert.match(archiveManifest, new RegExp('^conpty/' + file.replaceAll('.', '\\.') + '$', 'm'), file);
      for (const file of dtachResourceFiles) assert.match(archiveManifest, new RegExp('^dtach/' + file.replaceAll('.', '\\.') + '$', 'm'), file);
      assert.ok(run.result.stdout.includes('installé : C:\\portable with spaces'));
    }
  }

  const incompleteSource = resolve(fixtureRoot, 'incomplete build');
  mkdirSync(resolve(incompleteSource, 'conpty'), { recursive: true });
  writeFileSync(resolve(incompleteSource, 'soreno.exe'), 'Soreno');
  const missing = runPortableCopy({ source: incompleteSource, destinationName: 'missing resource' });
  assert.equal(missing.result.status, 1, missing.result.stderr);
  assert.match(missing.result.stderr, /ressource ConPTY manquante/);
  assert.equal(existsSync(missing.callsFile), false);
  assert.equal(existsSync(missing.destinationPath), false);
  assert.doesNotMatch(missing.result.stdout, /Build portable installé/);

  const locked = runPortableCopy({ mode: 'resource', destinationName: 'locked resource' });
  assert.equal(locked.result.status, 1, locked.result.stderr);
  assert.match(locked.result.stderr, /impossible de remplacer les ressources/);
  assert.match(locked.result.stderr, /Fermez Soreno puis relancez/);
  assert.doesNotMatch(locked.result.stdout, /Build portable installé/);

  const archiveFailure = runPortableCopy({ mode: 'archive', destinationName: 'archive failure' });
  assert.equal(archiveFailure.result.status, 1, archiveFailure.result.stderr);
  assert.match(archiveFailure.result.stderr, /impossible de créer l’archive portable/);
  assert.equal(existsSync(resolve(archiveFailure.destinationPath, 'soreno.zip')), false);
  assert.doesNotMatch(archiveFailure.result.stdout, /Build portable installé/);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log('Lanceurs : racine hors cwd, commandes npm/Windows, ressources, copies et archive validées.');
NODE
