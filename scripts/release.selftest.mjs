import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  compareVersions,
  createNpmInvocation,
  parsePorcelainPaths,
  readVersions,
  syncVersionFiles,
} from "./release.mjs";

test("préserve le statut porcelain en extrayant les chemins", () => {
  assert.deepEqual(parsePorcelainPaths(" M package-lock.json\n"), [
    "package-lock.json",
  ]);
});

test("construit une invocation npm portable", () => {
  assert.deepEqual(createNpmInvocation("/node", "/npm-cli.js"), {
    command: "/node",
    args: ["/npm-cli.js"],
  });
  assert.throws(() => createNpmInvocation("/node"), /npm_execpath/);
});

test("synchronise uniquement les versions de release", () => {
  const root = mkdtempSync(resolve(tmpdir(), "soreno-release-"));
  mkdirSync(resolve(root, "src-tauri"));
  writeFileSync(
    resolve(root, "package.json"),
    `${JSON.stringify({ name: "soreno", version: "0.1.1" }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(root, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "soreno",
        version: "0.1.1",
        packages: { "": { name: "soreno", version: "0.1.1" } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    resolve(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "soreno"\nversion = "0.1.1"\n\n[dependencies]\nexample = "0.1.1"\n',
  );
  writeFileSync(
    resolve(root, "src-tauri/Cargo.lock"),
    '[[package]]\nname = "example"\nversion = "0.1.1"\n\n[[package]]\nname = "soreno"\nversion = "0.1.1"\n',
  );
  writeFileSync(
    resolve(root, "src-tauri/tauri.conf.json"),
    `${JSON.stringify({ productName: "Soreno", version: "0.1.1" }, null, 2)}\n`,
  );

  try {
    assert.deepEqual(
      new Set(Object.values(readVersions(root))),
      new Set(["0.1.1"]),
    );
    assert.ok(compareVersions("0.1.2", "0.1.1") > 0);
    assert.ok(compareVersions("0.2.0", "0.10.0") < 0);
    assert.ok(
      compareVersions("9007199254740992.0.2", "9007199254740993.0.1") < 0,
    );
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);

    syncVersionFiles(root, "0.1.2");

    assert.deepEqual(
      new Set(Object.values(readVersions(root))),
      new Set(["0.1.2"]),
    );
    assert.match(
      readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
      /example = "0\.1\.1"/,
    );
    assert.match(
      readFileSync(resolve(root, "src-tauri/Cargo.lock"), "utf8"),
      /name = "example"\nversion = "0\.1\.1"/,
    );
    assert.throws(() => syncVersionFiles(root, "v0.1.3"), /format X\.Y\.Z/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
