// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getLastSeenVersion,
  loadChangelog,
  markVersionSeen,
} from "../data/releaseNotesApi";
import { I18nProvider } from "../i18n";
import { deferred } from "../testing/deferred";
import { ReleaseNotes } from "./ReleaseNotes";

vi.mock("../data/releaseNotesApi", () => ({
  changelogVersions: ["0.4.6", "0.4.7", "0.4.8"],
  getLastSeenVersion: vi.fn(),
  loadChangelog: vi.fn(),
  markVersionSeen: vi.fn(),
}));
vi.mock("../data/tauriRuntime", () => ({ hasTauriRuntime: () => true }));
vi.mock("../settings", () => ({
  useAppSettings: () => ({
    settings: { languagePreference: "fr" },
    updateSettings: vi.fn(),
  }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(loadChangelog).mockImplementation(
    async (version) => `# Soreno ${version}\n\n- Changement ${version}`,
  );
  vi.mocked(markVersionSeen).mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

async function render(version: string) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <ReleaseNotes version={version} />
      </I18nProvider>,
    ),
  );
}

function dialog() {
  return document.body.querySelector<HTMLElement>(".release-notes-dialog");
}

async function click(button: HTMLElement | null | undefined) {
  expect(button).toBeTruthy();
  await act(async () =>
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

it("opens every unseen changelog after an update and records the version once dismissed", async () => {
  vi.mocked(getLastSeenVersion).mockResolvedValue("0.4.6");
  await render("0.4.8");

  expect(dialog()!.querySelector("h2")?.textContent).toBe("Soreno 0.4.8");
  const headings = [...dialog()!.querySelectorAll("h3")].map(
    (heading) => heading.textContent,
  );
  expect(headings).toEqual(["Soreno 0.4.7"]);
  expect(markVersionSeen).not.toHaveBeenCalled();

  await click(
    [...dialog()!.querySelectorAll("button")].find(
      (button) => button.textContent === "Fermer",
    ),
  );
  expect(dialog()).toBeNull();
  expect(markVersionSeen).toHaveBeenCalledOnce();
});

it("reopens the current changelog from the version without recording it again", async () => {
  vi.mocked(getLastSeenVersion).mockResolvedValue("0.4.8");
  await render("0.4.8");
  expect(dialog()).toBeNull();

  await click(container.querySelector<HTMLElement>(".release-notes-trigger"));
  expect(dialog()?.textContent).toContain("Changement 0.4.8");
  expect(dialog()?.textContent).not.toContain("0.4.7");

  await click(
    dialog()!.querySelector<HTMLElement>(
      '[aria-label="Fermer les nouveautés"]',
    ),
  );
  expect(dialog()).toBeNull();
  expect(markVersionSeen).not.toHaveBeenCalled();
});

it("does not record the version when the changelogs failed to load", async () => {
  vi.mocked(getLastSeenVersion).mockResolvedValue("0.4.6");
  vi.mocked(loadChangelog).mockRejectedValue(new Error("missing"));
  await render("0.4.8");
  expect(dialog()?.textContent).toContain(
    "Impossible de charger les nouveautés.",
  );

  await click(
    [...dialog()!.querySelectorAll("button")].find(
      (button) => button.textContent === "Fermer",
    ),
  );
  expect(dialog()).toBeNull();
  expect(markVersionSeen).not.toHaveBeenCalled();
});

it("does not record the version when the update changelogs replace a manual dialog before loading", async () => {
  const resolveLastSeen = deferred<string>();
  vi.mocked(getLastSeenVersion).mockReturnValue(resolveLastSeen.promise);
  await render("0.4.8");

  await click(container.querySelector<HTMLElement>(".release-notes-trigger"));
  expect(dialog()?.textContent).toContain("Changement 0.4.8");
  expect(dialog()?.textContent).not.toContain("0.4.7");

  vi.mocked(loadChangelog).mockReturnValue(new Promise(() => undefined));
  await act(async () => resolveLastSeen.resolve("0.4.6"));
  expect(dialog()?.textContent).toContain("Chargement");
  expect(dialog()?.textContent).not.toContain("Changement 0.4.8");

  await click(
    [...dialog()!.querySelectorAll("button")].find(
      (button) => button.textContent === "Fermer",
    ),
  );
  expect(dialog()).toBeNull();
  expect(markVersionSeen).not.toHaveBeenCalled();
});

it("records an update without changelog silently", async () => {
  vi.mocked(getLastSeenVersion).mockResolvedValue("0.4.8");
  await render("0.4.9");
  expect(dialog()).toBeNull();
  expect(markVersionSeen).toHaveBeenCalledOnce();
});
