import manifest from "material-icon-theme/dist/material-icons.json";

const keys = [
  "fileNames",
  "fileExtensions",
  "folderNames",
  "folderNamesExpanded",
] as const;
type Associations = Record<(typeof keys)[number], Record<string, string>>;

// Maps avoid inherited keys (`constructor`, `toString`); VS Code matches names case-insensitively.
function lowercaseMaps(associations: Associations) {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      new Map(
        Object.entries(associations[key]).map(([n, icon]) => [
          n.toLowerCase(),
          icon,
        ]),
      ),
    ]),
  ) as Record<(typeof keys)[number], Map<string, string>>;
}

// JSON imports infer literal key sets; the lookups need plain string maps.
const dark = lowercaseMaps(manifest as unknown as Associations);
const light = lowercaseMaps(manifest.light as unknown as Associations);
const iconPaths = new Map(
  Object.entries(
    manifest.iconDefinitions as Record<string, { iconPath: string }>,
  ),
);

function lookup(
  key: (typeof keys)[number],
  name: string,
  isLight: boolean,
): string | undefined {
  const lower = name.toLowerCase();
  return (isLight ? light[key].get(lower) : undefined) ?? dark[key].get(lower);
}

// Mirrors VS Code icon themes: full file name first, then the longest dotted extension.
function fileIconName(name: string, isLight: boolean): string {
  const byName = lookup("fileNames", name, isLight);
  if (byName) return byName;
  for (
    let dot = name.indexOf(".");
    dot !== -1;
    dot = name.indexOf(".", dot + 1)
  ) {
    const byExtension = lookup("fileExtensions", name.slice(dot + 1), isLight);
    if (byExtension) return byExtension;
  }
  return manifest.file;
}

function folderIconName(
  name: string,
  expanded: boolean,
  isLight: boolean,
): string {
  return expanded
    ? (lookup("folderNamesExpanded", name, isLight) ?? manifest.folderExpanded)
    : (lookup("folderNames", name, isLight) ?? manifest.folder);
}

export function materialIconFile(
  name: string,
  kind: "file" | "directory",
  { expanded = false, isLight = false } = {},
): string {
  const icon =
    kind === "directory"
      ? folderIconName(name, expanded, isLight)
      : fileIconName(name, isLight);
  return (iconPaths.get(icon) ?? iconPaths.get(manifest.file)!).iconPath
    .split("/")
    .pop()!;
}
