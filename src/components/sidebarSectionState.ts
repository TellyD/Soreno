export type SidebarSectionId = "types";

export type SidebarSectionState = Record<SidebarSectionId, boolean>;

const defaultSidebarSectionState: SidebarSectionState = {
  types: true,
};

export function normalizeSidebarSectionState(
  savedState: unknown,
): SidebarSectionState {
  const types =
    typeof savedState === "object" &&
    savedState !== null &&
    "types" in savedState
      ? savedState.types
      : undefined;

  return {
    types:
      typeof types === "boolean" ? types : defaultSidebarSectionState.types,
  };
}
