import { expect, it } from "vitest";
import { materialIconFile } from "./fileIcons";

it.each([
  ["package.json", "file", {}, "nodejs.svg"],
  ["README.md", "file", {}, "readme.svg"],
  ["index.d.ts", "file", {}, "typescript-def.svg"],
  ["lib.rs", "file", {}, "rust.svg"],
  [".env", "file", {}, "tune.svg"],
  ["no-extension", "file", {}, "file.svg"],
  ["Cargo.toml", "file", {}, "toml.svg"],
  ["Cargo.toml", "file", { isLight: true }, "toml_light.svg"],
  ["src", "directory", {}, "folder-src.svg"],
  ["src", "directory", { expanded: true }, "folder-src-open.svg"],
  ["whatever", "directory", { expanded: true }, "folder-open.svg"],
  ["claude.md", "file", {}, "claude.svg"],
  ["meta-inf", "directory", {}, "folder-config.svg"],
  ["constructor", "directory", {}, "folder.svg"],
  ["toString", "file", {}, "file.svg"],
] as const)("%s (%s, %o) → %s", (name, kind, options, icon) => {
  expect(materialIconFile(name, kind, options)).toBe(icon);
});
