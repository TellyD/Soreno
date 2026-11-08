#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionFiles = [
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJson(root, path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function readMatch(root, path, pattern) {
  const match = readFileSync(resolve(root, path), "utf8").match(pattern);
  if (!match) throw new Error(`Version introuvable dans ${path}`);
  return match[1];
}

export function readVersions(root) {
  const packageJson = readJson(root, "package.json");
  const packageLock = readJson(root, "package-lock.json");
  const tauriConfig = readJson(root, "src-tauri/tauri.conf.json");
  return {
    packageJson: packageJson.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.[""]?.version,
    cargoToml: readMatch(
      root,
      "src-tauri/Cargo.toml",
      /\[package\][\s\S]*?\nversion = "([^"]+)"/,
    ),
    cargoLock: readMatch(
      root,
      "src-tauri/Cargo.lock",
      /\[\[package\]\]\r?\nname = "soreno"\r?\nversion = "([^"]+)"/,
    ),
    tauriConfig: tauriConfig.version,
  };
}

export function compareVersions(left, right) {
  const a = left.split(".").map((component) => BigInt(component));
  const b = right.split(".").map((component) => BigInt(component));
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

export function parsePorcelainPaths(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
}

export function createNpmInvocation(execPath, npmExecPath) {
  if (!npmExecPath) {
    throw new Error(
      "npm_execpath est absent ; lancez la release avec npm run release",
    );
  }
  return { command: execPath, args: [npmExecPath] };
}

function replaceVersion(root, path, pattern, version) {
  const absolutePath = resolve(root, path);
  const source = readFileSync(absolutePath, "utf8");
  if (!pattern.test(source))
    throw new Error(`Version introuvable dans ${path}`);
  writeFileSync(absolutePath, source.replace(pattern, `$1${version}$2`));
}

export function syncVersionFiles(root, version) {
  if (!stableVersion.test(version)) {
    throw new Error(
      "La version doit respecter le format X.Y.Z, par exemple 0.1.2",
    );
  }

  const packageJson = readJson(root, "package.json");
  packageJson.version = version;
  writeFileSync(
    resolve(root, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

  const packageLock = readJson(root, "package-lock.json");
  packageLock.version = version;
  if (!packageLock.packages?.[""]) {
    throw new Error("Entrée racine introuvable dans package-lock.json");
  }
  packageLock.packages[""].version = version;
  writeFileSync(
    resolve(root, "package-lock.json"),
    `${JSON.stringify(packageLock, null, 2)}\n`,
  );

  const tauriConfig = readJson(root, "src-tauri/tauri.conf.json");
  tauriConfig.version = version;
  writeFileSync(
    resolve(root, "src-tauri/tauri.conf.json"),
    `${JSON.stringify(tauriConfig, null, 2)}\n`,
  );

  replaceVersion(
    root,
    "src-tauri/Cargo.toml",
    /(\[package\][\s\S]*?\nversion = ")[^"]+("\r?\n)/,
    version,
  );
  replaceVersion(
    root,
    "src-tauri/Cargo.lock",
    /(\[\[package\]\]\r?\nname = "soreno"\r?\nversion = ")[^"]+("\r?\n)/,
    version,
  );
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: projectDir,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Commande échouée : ${commandName} ${args.join(" ")}`);
  }
  return options.capture ? result.stdout.trimEnd() : "";
}

function tagExistsOnOrigin(tag) {
  const result = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    { cwd: projectDir, stdio: "ignore" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw new Error("Impossible de vérifier les tags du dépôt origin");
}

// One page serves phones of every Soreno version: it must already read what this release's server sends.
async function checkMobilePage(npm) {
  const origin = readFileSync(
    resolve(projectDir, "src-tauri/src/agent_sessions/remote_mobile.rs"),
    "utf8",
  ).match(/RELAY_ORIGIN: &str = "([^"]+)"/)?.[1];
  if (!origin) throw new Error("Adresse de la page mobile introuvable");
  command(npm.command, [...npm.args, "run", "build:mobile"]);
  const built = readFileSync(resolve(projectDir, "dist/mobile/index.html"), "utf8");
  const response = await fetch(`${origin}/`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Page mobile injoignable : HTTP ${response.status}`);
  }
  if ((await response.text()) !== built) {
    throw new Error(
      "La page mobile servie par Vercel n’est pas celle de ce dépôt : attendre le déploiement du projet soreno-mobile depuis main (ou le relancer), puis relancer la release",
    );
  }
}

async function main() {
  const [version, ...extraArguments] = process.argv.slice(2);
  if (!version || extraArguments.length > 0 || !stableVersion.test(version)) {
    throw new Error("Usage : npm run release -- X.Y.Z");
  }

  const branch = command("git", ["branch", "--show-current"], {
    capture: true,
  });
  if (!branch)
    throw new Error("Une release ne peut pas partir d’une HEAD détachée");
  if (command("git", ["status", "--porcelain"], { capture: true })) {
    throw new Error("Le dépôt doit être propre avant de préparer une release");
  }

  const versions = readVersions(projectDir);
  const currentVersions = new Set(Object.values(versions));
  if (currentVersions.size !== 1) {
    throw new Error(`Versions désynchronisées : ${JSON.stringify(versions)}`);
  }
  const currentVersion = versions.packageJson;
  if (!stableVersion.test(currentVersion)) {
    throw new Error(`Version actuelle non prise en charge : ${currentVersion}`);
  }
  if (compareVersions(version, currentVersion) <= 0) {
    throw new Error(
      `La nouvelle version doit être supérieure à ${currentVersion}`,
    );
  }

  const tag = `v${version}`;
  const localTag = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`],
    { cwd: projectDir, stdio: "ignore" },
  );
  if (localTag.error) throw localTag.error;
  if (localTag.status === 0 || tagExistsOnOrigin(tag)) {
    throw new Error(`Le tag ${tag} existe déjà`);
  }

  const npm = createNpmInvocation(process.execPath, process.env.npm_execpath);
  await checkMobilePage(npm);
  command(npm.command, [...npm.args, "test"]);
  command(npm.command, [...npm.args, "run", "test:scripts"]);
  command(npm.command, [...npm.args, "run", "build"]);
  command("cargo", [
    "fmt",
    "--check",
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ]);
  command("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]);
  if (command("git", ["status", "--porcelain"], { capture: true })) {
    throw new Error("Les vérifications ont modifié le dépôt");
  }

  syncVersionFiles(projectDir, version);
  command("git", ["diff", "--check"]);

  const changedPaths = parsePorcelainPaths(
    command("git", ["status", "--porcelain"], { capture: true }),
  );
  const unexpectedPaths = changedPaths.filter(
    (path) => !versionFiles.includes(path),
  );
  if (unexpectedPaths.length > 0) {
    throw new Error(
      `Fichiers inattendus modifiés : ${unexpectedPaths.join(", ")}`,
    );
  }
  for (const path of versionFiles) {
    if (!changedPaths.includes(path)) {
      throw new Error(`La version n’a pas été modifiée dans ${path}`);
    }
  }

  command("git", ["add", ...versionFiles]);
  command("git", ["commit", "-m", `Release ${version}`]);
  command("git", ["tag", tag]);

  console.log(`\nRelease ${version} prête. Publication explicite :`);
  console.log(`git push origin ${branch} ${tag}`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    console.error(`Erreur : ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
