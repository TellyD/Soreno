export function isUsableCodexModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export const commitMessageStyles = [
  "imperative",
  "conventional",
  "detailed",
] as const;

export type CommitMessageStyle = (typeof commitMessageStyles)[number];

export function isCommitMessageStyle(
  value: unknown,
): value is CommitMessageStyle {
  return commitMessageStyles.some((style) => style === value);
}
