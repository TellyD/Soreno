#!/usr/bin/env node
// Builds the static Linux binaries of soreno-remote that Soreno embeds.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  ["x86_64-unknown-linux-musl", "linux-x86_64"],
  ["aarch64-unknown-linux-musl", "linux-aarch64"],
];

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

const installed = capture("rustup", ["target", "list", "--installed"]);
const missing = targets
  .map(([target]) => target)
  .filter((target) => !installed.split(/\r?\n/).includes(target));
if (missing.length > 0) run("rustup", ["target", "add", ...missing]);

// Honors CARGO_TARGET_DIR and .cargo/config build.target-dir.
const { target_directory: targetDir } = JSON.parse(
  capture("cargo", [
    "metadata",
    "--format-version",
    "1",
    "--no-deps",
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ]),
);

for (const [target, dir] of targets) {
  run(
    "cargo",
    [
      "build",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--release",
      "--locked",
      "-p",
      "soreno-remote",
      "--target",
      target,
    ],
    {
      ...process.env,
      // musl targets are self-contained: rust-lld links them without a cross toolchain on any host.
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: "rust-lld",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: "rust-lld",
      CARGO_PROFILE_RELEASE_STRIP: "symbols",
    },
  );
  const built = resolve(targetDir, target, "release/soreno-remote");
  const embedded = resolve(projectDir, "src-tauri/remote/bin", dir, "soreno-remote");
  // An unchanged copy keeps its date: rewriting it would make Cargo rebuild Soreno.
  if (
    existsSync(embedded) &&
    readFileSync(embedded).equals(readFileSync(built))
  )
    continue;
  mkdirSync(dirname(embedded), { recursive: true });
  copyFileSync(built, embedded);
}
