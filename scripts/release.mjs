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
  if (!match) throw new Error(`Version not found in ${path}`);
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
      "npm_execpath is missing; run the release with npm run release",
    );
  }
  return { command: execPath, args: [npmExecPath] };
}

function replaceVersion(root, path, pattern, version) {
  const absolutePath = resolve(root, path);
  const source = readFileSync(absolutePath, "utf8");
  if (!pattern.test(source))
    throw new Error(`Version not found in ${path}`);
  writeFileSync(absolutePath, source.replace(pattern, `$1${version}$2`));
}

export function syncVersionFiles(root, version) {
  if (!stableVersion.test(version)) {
    throw new Error(
      "The version must follow the format X.Y.Z, for example 0.1.2",
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
    throw new Error("Root entry not found in package-lock.json");
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
    throw new Error(`Command failed: ${commandName} ${args.join(" ")}`);
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
  throw new Error("Cannot check the tags of the origin repository");
}

// One page serves phones of every Soreno version: it must already read what this release's server sends.
async function checkMobilePage(npm) {
  const origin = readFileSync(
    resolve(projectDir, "src-tauri/src/agent_sessions/remote_mobile.rs"),
    "utf8",
  ).match(/RELAY_ORIGIN: &str = "([^"]+)"/)?.[1];
  if (!origin) throw new Error("Mobile page address not found");
  command(npm.command, [...npm.args, "run", "build:mobile"]);
  const built = readFileSync(resolve(projectDir, "dist/mobile/index.html"), "utf8");
  const response = await fetch(`${origin}/`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Mobile page unreachable: HTTP ${response.status}`);
  }
  if ((await response.text()) !== built) {
    throw new Error(
      "The mobile page served by Vercel is not this repository's: wait for the soreno-mobile project to deploy from main (or redeploy it), then run the release again",
    );
  }
}

async function main() {
  const [version, ...extraArguments] = process.argv.slice(2);
  if (!version || extraArguments.length > 0 || !stableVersion.test(version)) {
    throw new Error("Usage: npm run release -- X.Y.Z");
  }

  const branch = command("git", ["branch", "--show-current"], {
    capture: true,
  });
  if (!branch)
    throw new Error("A release cannot start from a detached HEAD");
  if (command("git", ["status", "--porcelain"], { capture: true })) {
    throw new Error("The repository must be clean before preparing a release");
  }

  const versions = readVersions(projectDir);
  const currentVersions = new Set(Object.values(versions));
  if (currentVersions.size !== 1) {
    throw new Error(`Versions out of sync: ${JSON.stringify(versions)}`);
  }
  const currentVersion = versions.packageJson;
  if (!stableVersion.test(currentVersion)) {
    throw new Error(`Unsupported current version: ${currentVersion}`);
  }
  if (compareVersions(version, currentVersion) <= 0) {
    throw new Error(
      `The new version must be greater than ${currentVersion}`,
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
    throw new Error(`Tag ${tag} already exists`);
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
    throw new Error("The checks modified the repository");
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
      `Unexpected files modified: ${unexpectedPaths.join(", ")}`,
    );
  }
  for (const path of versionFiles) {
    if (!changedPaths.includes(path)) {
      throw new Error(`The version was not updated in ${path}`);
    }
  }

  command("git", ["add", ...versionFiles]);
  command("git", ["commit", "-m", `Release ${version}`]);
  command("git", ["tag", tag]);

  console.log(`\nRelease ${version} ready. Publish explicitly:`);
  console.log(`git push origin ${branch} ${tag}`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
