// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { importAgentProjectIcon } from "../../data/agentProjectIcon";
import type {
  AgentProject,
  AgentProjectAppearance,
} from "../../domain/agentSessions";
import { clearNotifications, getNotifications } from "../../notifications";
import { deferred } from "../../testing/deferred";
import { AgentProjectAppearancePopover } from "./AgentProjectAppearancePopover";

vi.mock("../../i18n", () => ({
  useI18n: () => ({ locale: "fr-FR", t: (key: string) => key }),
}));
vi.mock("../../data/agentProjectIcon", () => ({
  importAgentProjectIcon: vi.fn(),
  PROJECT_ICON_ACCEPT: "image/png,image/jpeg,image/webp,image/gif",
}));

const project: AgentProject = {
  id: "p1",
  name: "Projet",
  path: "/fixed",
  environment: { kind: "local", distribution: null },
  icon: "rocket",
  color: "#37a3a5",
};
const image = "data:image/png;base64,aWNvbg==";
let container: HTMLDivElement;
let root: Root;
let onSave: Mock<
  (projectId: string, change: AgentProjectAppearance) => Promise<boolean>
>;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onSave = vi.fn(async () => true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearNotifications();
  container.remove();
});

async function render(value: AgentProject = project) {
  await act(async () =>
    root.render(
      <AgentProjectAppearancePopover
        project={value}
        x={0}
        y={0}
        disabled={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    ),
  );
}
function button(label: string) {
  const result = [...document.querySelectorAll("button")].find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function chooseFile(file?: File) {
  const picker =
    document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: file ? [file] : [],
    });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("saves an imported image in place of the catalog icon and ignores a cancelled or invalid pick", async () => {
  await render();
  const picker =
    document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const open = vi.spyOn(picker, "click").mockImplementation(() => {});
  await act(async () => button("Importer une image…").click());
  expect(open).toHaveBeenCalledOnce();

  await chooseFile();
  vi.mocked(importAgentProjectIcon).mockRejectedValueOnce(new Error("decode"));
  await chooseFile(new File(["bad"], "bad.png", { type: "image/png" }));
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message:
        "Impossible d’importer cette image. Choisissez un fichier PNG, JPEG, WebP ou GIF valide de 5 Mo maximum.",
    }),
  );
  expect(onSave).not.toHaveBeenCalled();

  vi.mocked(importAgentProjectIcon).mockResolvedValueOnce(image);
  await chooseFile(new File(["image"], "logo.png", { type: "image/png" }));
  expect(onSave).toHaveBeenCalledWith("p1", {
    iconDataUrl: image,
    icon: null,
  });
  expect(getNotifications()).toEqual([]);
});

it("resets the image, icon and color to the default folder", async () => {
  await render({ ...project, iconDataUrl: image });
  await act(async () => button("Réinitialiser").click());
  expect(onSave).toHaveBeenCalledWith("p1", {
    iconDataUrl: null,
    icon: null,
    color: null,
  });
});

it("drops an image whose conversion finishes after the popover closed", async () => {
  const pending = deferred<string>();
  vi.mocked(importAgentProjectIcon).mockReturnValueOnce(pending.promise);
  await render();
  await chooseFile(new File(["image"], "logo.png", { type: "image/png" }));
  expect(button("Import de l’image…").disabled).toBe(true);
  await act(async () => root.unmount());
  await act(async () => pending.resolve(image));
  expect(onSave).not.toHaveBeenCalled();
  root = createRoot(container);
});

it("focuses the icon search when opened", async () => {
  await render();
  expect(document.activeElement).toBe(
    document.querySelector('input[aria-label="appearance.iconSearch"]'),
  );
});

it("keeps a catalog icon picked while an image import is still converting", async () => {
  const pending = deferred<string>();
  vi.mocked(importAgentProjectIcon).mockReturnValueOnce(pending.promise);
  await render();
  await chooseFile(new File(["image"], "logo.png", { type: "image/png" }));
  await act(async () => button("Voyage").click());
  await act(async () => pending.resolve(image));
  expect(onSave).toHaveBeenLastCalledWith("p1", {
    icon: "plane",
    iconDataUrl: null,
  });
  expect(onSave).not.toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({ iconDataUrl: image }),
  );
  expect(button("Importer une image…").disabled).toBe(false);
});

it("sends each pick as its own delta and keeps showing the latest one until it settles", async () => {
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  onSave.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render();
  await act(async () => button("palette.blue").click());
  await act(async () => button("Voyage").click());
  expect(onSave.mock.calls).toEqual([
    ["p1", { color: "#608ef8" }],
    ["p1", { icon: "plane", iconDataUrl: null }],
  ]);
  await act(async () => first.resolve(true));
  expect(button("palette.blue").getAttribute("aria-pressed")).toBe("true");
  expect(button("Voyage").getAttribute("aria-pressed")).toBe("true");
  await act(async () => second.resolve(true));
  // Settled picks show the project as stored again.
  expect(button("Lancement").getAttribute("aria-pressed")).toBe("true");
});
