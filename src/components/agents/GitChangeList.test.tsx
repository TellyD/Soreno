// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitChange, GitFile, GitSide } from "../../domain/projectGit";
import { GitBulkChangeActions } from "./GitChangeList";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));

const file = (path: string, overrides: Partial<GitFile> = {}): GitFile => ({
  path,
  oldPath: null,
  indexStatus: ".",
  worktreeStatus: "M",
  conflict: false,
  submodule: false,
  actionable: true,
  mode: "100644",
  added: 1,
  deleted: 0,
  ...overrides,
});
const changes = (side: GitSide, files: GitFile[]): GitChange[] =>
  files.map((current) => ({ file: current, side }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function button(label: string) {
  return host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
}

it("offers no bulk discard for staged changes", async () => {
  await act(async () =>
    root.render(
      <GitBulkChangeActions
        changes={changes("staged", [file("staged.ts")])}
        side="staged"
        snapshotVersion="v8"
        blocked={false}
        restoreBlocked={false}
        onAction={vi.fn()}
        onRestore={vi.fn()}
      />,
    ),
  );

  expect(button("Annuler toutes les modifications…")).toBeNull();
  expect(button("Tout retirer").disabled).toBe(false);
});

it("disables bulk actions for unavailable files and external blocks", async () => {
  const render = async (
    items: GitChange[],
    blocked: boolean,
    restoreBlocked: boolean,
  ) =>
    act(async () =>
      root.render(
        <GitBulkChangeActions
          changes={items}
          side="unstaged"
          snapshotVersion="v9"
          blocked={blocked}
          restoreBlocked={restoreBlocked}
          onAction={vi.fn()}
          onRestore={vi.fn()}
        />,
      ),
    );

  await render(
    changes("unstaged", [file("blocked.ts", { actionable: false })]),
    false,
    false,
  );
  for (const label of ["Tout préparer", "Annuler toutes les modifications…"]) {
    expect(button(label).disabled).toBe(true);
  }

  await render(changes("unstaged", [file("busy.ts")]), true, true);
  expect(button("Tout préparer").disabled).toBe(true);
  expect(button("Annuler toutes les modifications…").disabled).toBe(true);
});
