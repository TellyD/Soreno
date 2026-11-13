// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeAgentTerminal } from "../../data/agentSessionsApi";
import { writeClipboardText } from "../../data/clipboard";
import * as api from "../../data/projectFilesApi";
import {
  projectFileGitStatus,
  type ProjectFileContent,
  type ProjectFileListing,
} from "../../domain/projectFiles";
import { readRecentProjectFiles } from "../../domain/recentProjectFiles";
import { clearNotifications, getNotifications } from "../../notifications";
import { deferred } from "../../testing/deferred";
import { stubEditorGeometry } from "../markdown-editor/testGeometry";
import { stubModalSelector } from "../ui/testTopLayer";
import { setInputValue } from "../ui/testInput";
import { ProjectExplorer, type ProjectExplorerGuard } from "./ProjectExplorer";
import { localTestProject as project } from "./testProject";

const runtime = vi.hoisted(() => ({ theme: "light" }));
vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({ settings: { materialFileIconsEnabled: false } }),
}));
vi.mock("../../theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: runtime.theme }),
}));
vi.mock("../../data/projectFilesApi", () => ({
  listProjectFiles: vi.fn(),
  readProjectFile: vi.fn(),
  writeProjectFile: vi.fn(),
  createProjectFile: vi.fn(),
  renameProjectFile: vi.fn(),
  deleteProjectFile: vi.fn(),
  duplicateProjectFile: vi.fn(),
  pasteProjectFiles: vi.fn(),
}));
vi.mock("../../data/agentSessionsApi", () => ({
  writeAgentTerminal: vi.fn(),
}));
vi.mock("../../data/clipboard", () => ({ writeClipboardText: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
let restoreGeometry: () => void;

beforeEach(() => {
  runtime.theme = "light";
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  restoreGeometry = stubEditorGeometry();
  stubModalSelector();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(api.listProjectFiles).mockImplementation(
    async (_projectId, directory) =>
      directory === ""
        ? {
            entries: [
              { name: "src", path: "src", kind: "directory", editable: false },
              {
                name: "README.md",
                path: "README.md",
                kind: "file",
                editable: true,
              },
              {
                name: "image.png",
                path: "image.png",
                kind: "file",
                editable: false,
              },
            ],
            truncated: false,
          }
        : {
            entries: [
              {
                name: "App.tsx",
                path: "src/App.tsx",
                kind: "file",
                editable: true,
              },
            ],
            truncated: false,
          },
  );
  vi.mocked(api.readProjectFile).mockImplementation(
    async (_projectId, path) => ({ path, content: "hello\r\n", version: "v1" }),
  );
  vi.mocked(api.writeProjectFile).mockResolvedValue({ version: "v2" });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  clearNotifications();
  container.remove();
  restoreGeometry();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(
  registerGuard?: (guard: ProjectExplorerGuard) => () => void,
) {
  await act(async () =>
    root.render(
      <ProjectExplorer project={project} registerGuard={registerGuard} />,
    ),
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(api.listProjectFiles).toHaveBeenCalledWith(project.id, ""),
    ),
  );
}

function textButton(text: string, scope: ParentNode = document) {
  const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );
  if (!value) throw new Error(`Missing button: ${text}`);
  return value;
}

it("opens and acknowledges a file requested by quick navigation", async () => {
  const onOpenFileRequestHandled = vi.fn();
  await render();
  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        openFileRequest={{ id: 1, path: "src/App.tsx", projectId: project.id }}
        onOpenFileRequestHandled={onOpenFileRequestHandled}
      />,
    ),
  );

  await act(async () =>
    vi.waitFor(() =>
      expect(api.readProjectFile).toHaveBeenCalledWith(
        project.id,
        "src/App.tsx",
      ),
    ),
  );
  expect(onOpenFileRequestHandled).toHaveBeenCalledWith(1);
});

it("acknowledges a quick-open request cancelled by the discard guard", async () => {
  await render();
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  await act(async () =>
    editor.dispatch({ changes: { from: 0, insert: "changed " } }),
  );
  vi.mocked(api.readProjectFile).mockClear();
  const onOpenFileRequestHandled = vi.fn();

  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        openFileRequest={{ id: 2, path: "src/App.tsx", projectId: project.id }}
        onOpenFileRequestHandled={onOpenFileRequestHandled}
      />,
    ),
  );
  await act(async () => textButton("Annuler").click());

  expect(api.readProjectFile).not.toHaveBeenCalled();
  expect(onOpenFileRequestHandled).toHaveBeenCalledWith(2);
});

it("selects the requested range when opening a file from project search", async () => {
  vi.mocked(api.readProjectFile).mockImplementation(
    async (_projectId, path) => ({
      path,
      content: "first\nconst value = 1;\nlast\n",
      version: "v1",
    }),
  );
  await render();
  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        openFileRequest={{
          id: 1,
          path: "src/App.tsx",
          projectId: project.id,
          selection: { line: 2, start: 6, end: 11 },
        }}
      />,
    ),
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  let editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  let selection = editor.state.selection.main;
  expect(editor.state.sliceDoc(selection.from, selection.to)).toBe("value");
  expect(document.activeElement).toBe(editor.contentDOM);
  vi.mocked(api.readProjectFile).mockClear();

  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        openFileRequest={{
          id: 2,
          path: "src/App.tsx",
          projectId: project.id,
          selection: { line: 3, start: 0, end: 4 },
        }}
      />,
    ),
  );
  expect(api.readProjectFile).not.toHaveBeenCalled();
  editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  selection = editor.state.selection.main;
  expect(editor.state.sliceDoc(selection.from, selection.to)).toBe("last");
});

it("keeps focus in an open modal when a delayed search result is revealed", async () => {
  const resolveRead = deferred<ProjectFileContent>();
  vi.mocked(api.readProjectFile).mockReturnValue(resolveRead.promise);
  await render();
  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        openFileRequest={{
          id: 1,
          path: "src/App.tsx",
          projectId: project.id,
          selection: { line: 2, start: 6, end: 11 },
        }}
      />,
    ),
  );
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  const input = document.createElement("input");
  modal.append(input);
  document.body.append(modal);
  try {
    input.focus();
    await act(async () =>
      resolveRead.resolve({
        path: "src/App.tsx",
        content: "first\nconst value = 1;\nlast\n",
        version: "v1",
      }),
    );
    await act(async () =>
      vi.waitFor(() =>
        expect(container.querySelector(".cm-editor")).not.toBeNull(),
      ),
    );
    const editor = EditorView.findFromDOM(
      container.querySelector(".cm-editor")!,
    )!;
    const selection = editor.state.selection.main;
    expect(editor.state.sliceDoc(selection.from, selection.to)).toBe("value");
    expect(document.activeElement).toBe(input);
  } finally {
    modal.remove();
  }
});

it("loads directories lazily and disables unsupported files", async () => {
  await render();
  const unsupported = textButton("image.png", container);
  expect(unsupported.getAttribute("aria-disabled")).toBe("true");
  await act(async () => unsupported.click());
  expect(api.readProjectFile).not.toHaveBeenCalled();
  expect(api.listProjectFiles).toHaveBeenCalledTimes(1);

  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(api.listProjectFiles).toHaveBeenCalledWith(project.id, "src"),
    ),
  );
  expect(textButton("App.tsx", container)).toBeTruthy();
});

it("marks symbolic links without following or mutating them", async () => {
  vi.mocked(api.listProjectFiles).mockResolvedValueOnce({
    entries: [
      {
        name: "linked",
        path: "linked",
        kind: "directory",
        editable: false,
        symlink: true,
      },
    ],
    truncated: false,
  });
  await render();
  const link = textButton("linked", container);
  expect(link.hasAttribute("aria-expanded")).toBe(false);
  expect(link.getAttribute("aria-disabled")).toBe("true");
  await act(async () => link.click());
  expect(api.listProjectFiles).toHaveBeenCalledTimes(1);

  await openRowMenu("linked");
  for (const label of ["Renommer ou déplacer…", "Dupliquer", "Supprimer…"])
    expect(menuItem(label).hasAttribute("data-disabled")).toBe(true);
  expect(
    menuItem("Copier le chemin relatif").hasAttribute("data-disabled"),
  ).toBe(false);
});

it("previews a supported image without opening the text editor", async () => {
  vi.mocked(api.listProjectFiles).mockResolvedValueOnce({
    entries: [
      {
        name: "image.webp",
        path: "image.webp",
        kind: "file",
        editable: false,
        previewable: true,
      },
    ],
    truncated: false,
  });
  vi.mocked(api.readProjectFile).mockResolvedValueOnce({
    path: "image.webp",
    content: "data:image/webp;base64,UklGRg==",
    version: "v-image",
    mediaType: "image/webp",
  });

  await render();
  await act(async () => textButton("image.webp", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(
        container.querySelector<HTMLImageElement>(
          '.project-file-image-preview img[alt="image.webp"]',
        )?.src,
      ).toBe("data:image/webp;base64,UklGRg=="),
    ),
  );
  expect(container.querySelector(".cm-editor")).toBeNull();
});

it("revalidates expanded directories while keeping the tree visible", async () => {
  await render();
  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
  );

  const refresh = new Map<
    string,
    (listing: Awaited<ReturnType<typeof api.listProjectFiles>>) => void
  >();
  vi.mocked(api.listProjectFiles).mockImplementation(
    (_projectId, directory) =>
      new Promise((resolve) => {
        refresh.set(directory, resolve);
      }),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Actualiser les fichiers"]',
      )!
      .click(),
  );

  expect(refresh.has("src")).toBe(true);
  expect(textButton("README.md", container)).toBeTruthy();
  expect(textButton("App.tsx", container)).toBeTruthy();
  expect(textButton("src", container).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(
    container.querySelector(".project-explorer")?.getAttribute("aria-busy"),
  ).toBe("true");

  await act(async () => {
    refresh.get("")!({
      entries: [
        { name: "src", path: "src", kind: "directory", editable: false },
        { name: "fresh.ts", path: "fresh.ts", kind: "file", editable: true },
      ],
      truncated: false,
    });
    refresh.get("src")!({
      entries: [
        {
          name: "NewApp.tsx",
          path: "src/NewApp.tsx",
          kind: "file",
          editable: true,
        },
      ],
      truncated: false,
    });
  });

  expect(textButton("fresh.ts", container)).toBeTruthy();
  expect(textButton("NewApp.tsx", container)).toBeTruthy();
  expect(
    [...container.querySelectorAll("button")].some((button) =>
      ["README.md", "App.tsx"].includes(button.textContent ?? ""),
    ),
  ).toBe(false);
  expect(
    container.querySelector(".project-explorer")?.getAttribute("aria-busy"),
  ).toBe("false");
});

it("revalidates an expanded directory whose first load is still pending", async () => {
  await render();

  type Listing = Awaited<ReturnType<typeof api.listProjectFiles>>;
  let resolveInitialSrc!: (listing: Listing) => void;
  const refresh = new Map<string, (listing: Listing) => void>();
  vi.mocked(api.listProjectFiles).mockImplementation(
    (_projectId, directory) =>
      new Promise((resolve) => {
        if (directory === "src" && !resolveInitialSrc) {
          resolveInitialSrc = resolve;
        } else {
          refresh.set(directory, resolve);
        }
      }),
  );

  await act(async () => textButton("src", container).click());
  expect(resolveInitialSrc).toBeTypeOf("function");

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Actualiser les fichiers"]',
      )!
      .click(),
  );
  expect(refresh.has("")).toBe(true);
  expect(refresh.has("src")).toBe(true);

  await act(async () =>
    resolveInitialSrc({
      entries: [
        {
          name: "Stale.tsx",
          path: "src/Stale.tsx",
          kind: "file",
          editable: true,
        },
      ],
      truncated: false,
    }),
  );
  expect(
    container.querySelector(".project-explorer")?.getAttribute("aria-busy"),
  ).toBe("true");

  await act(async () => {
    refresh.get("")!({
      entries: [
        { name: "src", path: "src", kind: "directory", editable: false },
      ],
      truncated: false,
    });
    refresh.get("src")!({
      entries: [
        {
          name: "Fresh.tsx",
          path: "src/Fresh.tsx",
          kind: "file",
          editable: true,
        },
      ],
      truncated: false,
    });
  });

  expect(textButton("Fresh.tsx", container)).toBeTruthy();
  expect(textButton("src", container).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(
    container.querySelector(".project-explorer")?.getAttribute("aria-busy"),
  ).toBe("false");
});

it("keeps a loaded directory when its refresh fails", async () => {
  await render();
  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
  );

  let rejectSubdirectory!: (reason?: unknown) => void;
  vi.mocked(api.listProjectFiles).mockImplementation((_projectId, directory) =>
    directory === ""
      ? Promise.resolve({
          entries: [
            { name: "src", path: "src", kind: "directory", editable: false },
            {
              name: "README.md",
              path: "README.md",
              kind: "file",
              editable: true,
            },
          ],
          truncated: false,
        })
      : new Promise((_resolve, reject) => {
          rejectSubdirectory = reject;
        }),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Actualiser les fichiers"]',
      )!
      .click(),
  );
  expect(rejectSubdirectory).toBeTypeOf("function");
  expect(textButton("README.md", container)).toBeTruthy();
  expect(textButton("App.tsx", container)).toBeTruthy();

  await act(async () => rejectSubdirectory(new Error("refresh failed")));

  expect(textButton("README.md", container)).toBeTruthy();
  expect(textButton("App.tsx", container)).toBeTruthy();
  expect(textButton("src", container).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(getNotifications()).toEqual([
    expect.objectContaining({
      message: "L’opération a échoué. Réessayez.",
      tone: "error",
    }),
  ]);
  expect(
    container.querySelector(".project-explorer")?.getAttribute("aria-busy"),
  ).toBe("false");
});

it("drops an expanded directory deleted outside the explorer without an error on refresh", async () => {
  await render();
  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
  );

  vi.mocked(api.listProjectFiles).mockImplementation((_projectId, directory) =>
    directory === ""
      ? Promise.resolve({
          entries: [
            {
              name: "README.md",
              path: "README.md",
              kind: "file",
              editable: true,
            },
          ],
          truncated: false,
        })
      : Promise.reject({ code: "notDirectory", message: "gone" }),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Actualiser les fichiers"]',
      )!
      .click(),
  );

  expect(textButton("README.md", container)).toBeTruthy();
  expect(container.textContent).not.toContain("App.tsx");
  expect(getNotifications()).toEqual([]);
  expect(
    container.querySelector(".project-explorer")?.getAttribute("aria-busy"),
  ).toBe("false");
});

it("preserves mixed line endings at unchanged boundaries when saving", async () => {
  vi.mocked(api.readProjectFile).mockResolvedValueOnce({
    path: "README.md",
    content: "one\r\ntwo\nthree\r\n",
    version: "v1",
  });
  await render();
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Enregistrer",
    ),
  ).toBe(false);

  await act(async () =>
    editor.dispatch({ changes: { from: 0, to: 3, insert: "ONE" } }),
  );
  expect(container.textContent).toContain("Non enregistré");
  await act(async () =>
    editor.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(api.writeProjectFile).toHaveBeenCalledWith(
    project.id,
    "README.md",
    "ONE\r\ntwo\nthree\r\n",
    "v1",
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(container.textContent).not.toContain("Non enregistré"),
    ),
  );
});

it("offers a reload through the notification after a save conflict", async () => {
  vi.mocked(api.writeProjectFile).mockRejectedValueOnce({
    code: "conflict",
    message: "changed on disk",
  });
  await render();
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  await act(async () =>
    editor.dispatch({ changes: { from: 0, insert: "mine " } }),
  );
  await act(async () =>
    editor.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () =>
    vi.waitFor(() => expect(getNotifications()).toHaveLength(1)),
  );
  const [conflict] = getNotifications();
  expect(conflict).toMatchObject({
    tone: "error",
    action: { label: "Recharger le fichier" },
  });
  vi.mocked(api.readProjectFile).mockClear();

  await act(async () => conflict.action!.onAction());
  await act(async () => textButton("Abandonner").click());

  expect(api.readProjectFile).toHaveBeenCalledExactlyOnceWith(
    project.id,
    "README.md",
  );
  expect(getNotifications()).toEqual([]);
});

it("notifies Git after a successful save only", async () => {
  const onFilesChanged = vi.fn();
  await act(async () =>
    root.render(
      <ProjectExplorer project={project} onFilesChanged={onFilesChanged} />,
    ),
  );
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  vi.mocked(api.writeProjectFile).mockRejectedValueOnce(new Error("disk full"));
  await act(async () =>
    editor.dispatch({ changes: { from: 0, insert: "mine " } }),
  );
  await act(async () =>
    editor.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () =>
    vi.waitFor(() => expect(getNotifications()).toHaveLength(1)),
  );
  expect(api.writeProjectFile).toHaveBeenCalledTimes(1);
  expect(onFilesChanged).not.toHaveBeenCalled();

  await act(async () =>
    editor.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(container.textContent).not.toContain("Non enregistré"),
    ),
  );
  expect(api.writeProjectFile).toHaveBeenCalledTimes(2);
  expect(onFilesChanged).toHaveBeenCalledTimes(1);
});

it("keeps the current editor value when the theme changes", async () => {
  await render();
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  await act(async () =>
    editor.dispatch({ changes: { from: 0, insert: "changed " } }),
  );

  runtime.theme = "dark";
  await act(async () => root.render(<ProjectExplorer project={project} />));

  expect(
    EditorView.findFromDOM(
      container.querySelector(".cm-editor")!,
    )!.state.doc.toString(),
  ).toBe("changed hello\r\n");
  expect(container.textContent).toContain("Non enregistré");
});

it("previews unsaved Markdown and returns to the source for a search reveal", async () => {
  const previewButton = () =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Afficher le rendu Markdown"]',
    );
  await render();
  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
  );
  await act(async () => textButton("App.tsx", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  expect(previewButton()).toBeNull();

  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() => expect(previewButton()).not.toBeNull()),
  );
  await act(async () =>
    EditorView.findFromDOM(container.querySelector(".cm-editor")!)!.dispatch({
      changes: { from: 0, insert: "# Title\n\n**bold** " },
    }),
  );
  await act(async () => previewButton()!.click());

  expect(previewButton()!.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector(".cm-editor")).toBeNull();
  const preview = container.querySelector(".project-file-markdown")!;
  expect(preview.querySelector("h3")?.textContent).toBe("Title");
  expect(preview.querySelector("strong")?.textContent).toBe("bold");

  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        openFileRequest={{
          id: 1,
          path: "README.md",
          projectId: project.id,
          selection: { line: 3, start: 0, end: 8 },
        }}
      />,
    ),
  );

  expect(previewButton()!.getAttribute("aria-pressed")).toBe("false");
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  expect(editor.state.doc.toString()).toBe("# Title\n\n**bold** hello\r\n");
  const selection = editor.state.selection.main;
  expect(editor.state.sliceDoc(selection.from, selection.to)).toBe("**bold**");
});

it("searches inside the open file with Ctrl+F from the tree, even from the preview", async () => {
  vi.mocked(api.readProjectFile).mockResolvedValue({
    path: "README.md",
    content: "alpha beta\nAlpha gamma\nalpha\n",
    version: "v1",
  });
  const searchInput = () =>
    container.querySelector<HTMLInputElement>(
      '[aria-label="Rechercher dans le fichier"]',
    );
  const status = () =>
    container.querySelector(".project-file-search-status")?.textContent;
  const selected = () => {
    const editor = EditorView.findFromDOM(
      container.querySelector(".cm-editor")!,
    )!;
    const { from, to } = editor.state.selection.main;
    return [from, to];
  };
  const press = (target: Element, init: KeyboardEventInit) =>
    act(async () =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      ),
    );
  await render();
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Afficher le rendu Markdown"]',
      )!
      .click(),
  );
  expect(container.querySelector(".cm-editor")).toBeNull();

  await press(textButton("README.md", container), { key: "f", ctrlKey: true });

  expect(document.activeElement).toBe(searchInput());
  await act(async () => setInputValue(searchInput()!, "alpha"));
  expect(selected()).toEqual([0, 5]);
  expect(status()).toBe("1 sur 3");

  await press(searchInput()!, { key: "Enter" });
  expect(selected()).toEqual([11, 16]);
  expect(status()).toBe("2 sur 3");

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Respecter la casse"]')!
      .click(),
  );
  expect(selected()).toEqual([23, 28]);
  expect(status()).toBe("2 sur 2");

  await act(async () => setInputValue(searchInput()!, "delta"));
  expect(status()).toBe("Aucun résultat");
  expect(selected()).toEqual([23, 28]);

  await press(searchInput()!, { key: "Escape" });
  expect(searchInput()).toBeNull();
  expect(document.activeElement).toBe(container.querySelector(".cm-content"));
});

it("keeps the old editor read-only while an approved file load is pending", async () => {
  vi.mocked(api.listProjectFiles).mockResolvedValue({
    entries: [
      { name: "README.md", path: "README.md", kind: "file", editable: true },
      { name: "next.txt", path: "next.txt", kind: "file", editable: true },
    ],
    truncated: false,
  });
  let finish!: (value: {
    path: string;
    content: string;
    version: string;
  }) => void;
  vi.mocked(api.readProjectFile)
    .mockResolvedValueOnce({
      path: "README.md",
      content: "hello\n",
      version: "v1",
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  await render();
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  let editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  await act(async () =>
    editor.dispatch({ changes: { from: 0, insert: "changed " } }),
  );

  await act(async () => textButton("next.txt", container).click());
  await act(async () => textButton("Abandonner").click());
  await act(async () =>
    vi.waitFor(() =>
      expect(api.readProjectFile).toHaveBeenCalledWith(project.id, "next.txt"),
    ),
  );
  editor = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  expect(editor.contentDOM.getAttribute("contenteditable")).toBe("false");
  expect(editor.state.readOnly).toBe(true);
  await act(async () =>
    editor.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(api.writeProjectFile).not.toHaveBeenCalled();

  await act(async () =>
    finish({ path: "next.txt", content: "next\n", version: "v2" }),
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(
        EditorView.findFromDOM(
          container.querySelector(".cm-editor")!,
        )?.state.doc.toString(),
      ).toBe("next\n"),
    ),
  );
});

it("loads directories whose names match Object prototype properties", async () => {
  const names = ["constructor", "toString", "__proto__"];
  vi.mocked(api.listProjectFiles).mockImplementation(
    async (_projectId, directory) => ({
      entries:
        directory === ""
          ? names.map((name) => ({
              name,
              path: name,
              kind: "directory" as const,
              editable: false,
            }))
          : [],
      truncated: false,
    }),
  );
  await render();

  for (const name of names) {
    await act(async () => textButton(name, container).click());
    await act(async () =>
      vi.waitFor(() =>
        expect(api.listProjectFiles).toHaveBeenCalledWith(project.id, name),
      ),
    );
  }
});

it("exposes an asynchronous discard guard for unsaved edits", async () => {
  let guard: ProjectExplorerGuard | undefined;
  await render((value) => {
    guard = value;
    return () => {};
  });
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  await act(async () =>
    editor.dispatch({ changes: { from: 0, insert: "changed " } }),
  );
  expect(guard?.hasPendingWork()).toBe(true);

  let result!: boolean;
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = guard!.prepare();
  });
  await act(async () => {
    textButton("Annuler").click();
    result = await pending;
  });
  expect(result).toBe(false);

  await act(async () => {
    pending = guard!.prepare();
  });
  await act(async () => {
    textButton("Abandonner").click();
    result = await pending;
  });
  expect(result).toBe(true);
  await act(async () => guard!.discard());
  expect(guard?.hasPendingWork()).toBe(false);
  expect(
    EditorView.findFromDOM(
      container.querySelector(".cm-editor")!,
    )!.state.doc.toString(),
  ).toBe("hello\r\n");

  await act(async () => guard!.lock());
  expect(
    EditorView.findFromDOM(
      container.querySelector(".cm-editor")!,
    )!.contentDOM.getAttribute("contenteditable"),
  ).toBe("false");
  await act(async () => guard!.cancel());
  expect(
    EditorView.findFromDOM(
      container.querySelector(".cm-editor")!,
    )!.contentDOM.getAttribute("contenteditable"),
  ).toBe("true");
});

async function openRowMenu(text: string) {
  const row = textButton(text, container);
  row.focus();
  await act(async () =>
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

function menuItem(label: string) {
  const item = [
    ...document.querySelectorAll<HTMLButtonElement>(".app-menu-item"),
  ].find((candidate) => candidate.textContent === label);
  if (!item) throw new Error(`Missing menu item: ${label}`);
  return item;
}

async function submitPathDialog(value: string) {
  const field = document.querySelector<HTMLInputElement>(
    ".project-file-path-dialog input",
  )!;
  await act(async () => {
    setInputValue(field, value);
  });
  await act(async () => field.form!.requestSubmit());
}

async function openReadme() {
  await act(async () => textButton("README.md", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
}

it("opens the file menu from the keyboard and copies both path forms", async () => {
  await render();
  await openRowMenu("README.md");
  await act(async () => menuItem("Copier le chemin relatif").click());
  expect(writeClipboardText).toHaveBeenLastCalledWith("README.md");

  await openRowMenu("image.png");
  await act(async () => menuItem("Copier le chemin absolu").click());
  expect(writeClipboardText).toHaveBeenLastCalledWith(
    "/projects/soreno/image.png",
  );
});

it("targets the row touched by a long press, not the previous menu target", async () => {
  await render();
  await act(async () =>
    textButton("README.md", container).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    ),
  );
  await act(async () => menuItem("Copier le chemin relatif").click());
  expect(writeClipboardText).toHaveBeenLastCalledWith("README.md");

  vi.useFakeTimers();
  const touch = new Event("touchstart", { bubbles: true, cancelable: true });
  Object.defineProperty(touch, "touches", {
    value: [{ clientX: 0, clientY: 0 }],
  });
  await act(async () =>
    textButton("image.png", container).dispatchEvent(touch),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  vi.useRealTimers();
  await act(async () =>
    vi.waitFor(() => expect(menuItem("Copier le chemin relatif")).toBeTruthy()),
  );
  await act(async () => menuItem("Copier le chemin relatif").click());
  expect(writeClipboardText).toHaveBeenLastCalledWith("image.png");
});

it("types a file path into the active agent and shows it", async () => {
  vi.mocked(api.listProjectFiles).mockImplementation(
    async (_projectId, directory) =>
      directory === ""
        ? {
            entries: [
              { name: "src", path: "src", kind: "directory", editable: false },
            ],
            truncated: false,
          }
        : {
            entries: [
              {
                name: "My File.ts",
                path: "src/My File.ts",
                kind: "file",
                editable: true,
              },
            ],
            truncated: false,
          },
  );
  const onAgentInput = vi.fn();
  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        agentTarget={{
          sessionId: "s1",
          projectId: project.id,
          name: "Claude",
          executable: "claude",
        }}
        onAgentInput={onAgentInput}
      />,
    ),
  );
  await act(async () =>
    vi.waitFor(() => expect(textButton("src", container)).toBeTruthy()),
  );
  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("My File.ts", container)).toBeTruthy()),
  );
  await openRowMenu("My File.ts");
  await act(async () =>
    menuItem("Insérer le chemin dans l’agent actif").click(),
  );
  expect(writeAgentTerminal).toHaveBeenCalledWith("s1", "'src/My File.ts' ");
  expect(onAgentInput).toHaveBeenCalledWith("s1");
});

it("never types a path containing control characters into an agent", async () => {
  vi.mocked(writeAgentTerminal).mockClear();
  vi.mocked(api.listProjectFiles).mockResolvedValue({
    entries: [
      { name: "note\r.txt", path: "note\r.txt", kind: "file", editable: true },
    ],
    truncated: false,
  });
  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        agentTarget={{
          sessionId: "s1",
          projectId: project.id,
          name: "Claude",
          executable: "claude",
        }}
      />,
    ),
  );
  await act(async () =>
    vi.waitFor(() => expect(textButton("note\r.txt", container)).toBeTruthy()),
  );
  await openRowMenu("note\r.txt");
  const insert = menuItem("Insérer le chemin dans l’agent actif");
  expect(insert.hasAttribute("data-disabled")).toBe(true);
  await act(async () => insert.click());
  expect(writeAgentTerminal).not.toHaveBeenCalled();
});

it("never types a path when the active pane has no running agent", async () => {
  vi.mocked(writeAgentTerminal).mockClear();
  await render();
  await openRowMenu("README.md");
  const unavailable = menuItem("Aucun agent lancé dans le volet actif");
  expect(unavailable.hasAttribute("data-disabled")).toBe(true);
  await act(async () => unavailable.click());
  expect(writeAgentTerminal).not.toHaveBeenCalled();
});

it("shows Git badges, marks changed folders and forwards Git actions", async () => {
  const onShowChanges = vi.fn();
  const onShowHistory = vi.fn();
  const gitStatus = projectFileGitStatus(
    [
      {
        path: "app/README.md",
        oldPath: null,
        indexStatus: ".",
        worktreeStatus: "M",
        conflict: false,
        submodule: false,
        actionable: true,
        mode: "100644",
        added: 1,
        deleted: 1,
      },
      {
        path: "app/src/new.ts",
        oldPath: null,
        indexStatus: "?",
        worktreeStatus: "?",
        conflict: false,
        submodule: false,
        actionable: true,
        mode: "100644",
        added: null,
        deleted: null,
      },
    ],
    "app/",
  );
  await act(async () =>
    root.render(
      <ProjectExplorer
        project={project}
        gitStatus={gitStatus}
        historyAvailable
        onShowChanges={onShowChanges}
        onShowHistory={onShowHistory}
      />,
    ),
  );
  await act(async () =>
    vi.waitFor(() => expect(textButton("README.mdM", container)).toBeTruthy()),
  );
  expect(
    textButton("src", container).querySelector(".project-file-git-changes"),
  ).not.toBeNull();

  await openRowMenu("README.mdM");
  await act(async () => menuItem("Voir les changements").click());
  expect(onShowChanges).toHaveBeenCalledWith({
    badge: "M",
    gitPath: "app/README.md",
    side: "unstaged",
  });
  await openRowMenu("src");
  expect(() => menuItem("Voir les changements")).toThrow();
  await act(async () => menuItem("Voir l’historique").click());
  expect(onShowHistory).toHaveBeenCalledWith("src");
});

it("creates a file in the targeted folder, reveals it and opens it", async () => {
  const created = {
    name: "new.ts",
    path: "src/new.ts",
    kind: "file" as const,
    editable: true,
  };
  vi.mocked(api.createProjectFile)
    .mockRejectedValueOnce({
      code: "exists",
      message: "Un fichier ou un dossier porte déjà ce nom.",
    })
    .mockResolvedValueOnce(created);
  const onFilesChanged = vi.fn();
  await act(async () =>
    root.render(
      <ProjectExplorer project={project} onFilesChanged={onFilesChanged} />,
    ),
  );
  await act(async () =>
    vi.waitFor(() => expect(textButton("src", container)).toBeTruthy()),
  );
  await openRowMenu("src");
  await act(async () => menuItem("Nouveau fichier…").click());
  const field = document.querySelector<HTMLInputElement>(
    ".project-file-path-dialog input",
  )!;
  expect(field.value).toBe("src/");

  await submitPathDialog("src/App.tsx");
  expect(api.createProjectFile).toHaveBeenLastCalledWith(
    project.id,
    "src/App.tsx",
    "file",
  );
  expect(document.querySelector(".project-file-path-dialog")).not.toBeNull();
  expect(getNotifications().map((item) => item.message)).toContain(
    "Un fichier ou un dossier porte déjà ce nom.",
  );

  vi.mocked(api.listProjectFiles).mockImplementation(async (_id, directory) =>
    directory === ""
      ? {
          entries: [
            { name: "src", path: "src", kind: "directory", editable: false },
          ],
          truncated: false,
        }
      : { entries: [created], truncated: false },
  );
  await submitPathDialog("src/new.ts");
  await act(async () =>
    vi.waitFor(() =>
      expect(api.readProjectFile).toHaveBeenCalledWith(
        project.id,
        "src/new.ts",
      ),
    ),
  );
  expect(document.querySelector(".project-file-path-dialog")).toBeNull();
  expect(onFilesChanged).toHaveBeenCalledTimes(1);
  expect(api.listProjectFiles).toHaveBeenCalledWith(project.id, "src");
  await act(async () =>
    vi.waitFor(() =>
      expect(document.activeElement).toBe(textButton("new.ts", container)),
    ),
  );
});

it("creates the first entry of an empty project from the keyboard", async () => {
  vi.mocked(api.listProjectFiles).mockResolvedValue({
    entries: [],
    truncated: false,
  });
  await render();
  const tree = await vi.waitFor(() => {
    const scroll = container.querySelector<HTMLElement>(
      ".project-explorer-tree-scroll",
    )!;
    scroll.focus();
    expect(document.activeElement).toBe(scroll);
    return scroll;
  });
  await act(async () =>
    tree.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () => menuItem("Nouveau fichier…").click());
  expect(document.querySelector(".project-file-path-dialog")).not.toBeNull();
});

it("renames the open file without losing its unsaved buffer or version", async () => {
  vi.mocked(api.renameProjectFile).mockResolvedValue({
    name: "README.md",
    path: "docs/README.md",
    kind: "file",
    editable: true,
  });
  await render();
  await openReadme();
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  await act(async () =>
    editor.dispatch({ changes: { from: 0, insert: "draft " } }),
  );

  await openRowMenu("README.md");
  await act(async () => menuItem("Renommer ou déplacer…").click());
  await submitPathDialog("docs/README.md");
  expect(api.renameProjectFile).toHaveBeenCalledWith(
    project.id,
    "README.md",
    "docs/README.md",
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(
        container.querySelector(".project-file-editor-path")?.textContent,
      ).toBe("docs/README.md"),
    ),
  );
  expect(container.textContent).toContain("Non enregistré");

  const renamed = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  await act(async () =>
    renamed.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(api.writeProjectFile).toHaveBeenCalledWith(
    project.id,
    "docs/README.md",
    "draft hello\r\n",
    "v1",
  );
});

it("reports and reveals the temporary entry left by an interrupted rename", async () => {
  vi.mocked(api.renameProjectFile).mockRejectedValueOnce({
    code: "stranded",
    message: "src/.soreno-rename-1-0",
  });
  await render();
  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
  );
  vi.mocked(api.listProjectFiles).mockClear();
  vi.mocked(api.listProjectFiles).mockImplementation(async (_id, directory) =>
    directory === ""
      ? {
          entries: [
            { name: "src", path: "src", kind: "directory", editable: false },
          ],
          truncated: false,
        }
      : {
          entries: [
            {
              name: ".soreno-rename-1-0",
              path: "src/.soreno-rename-1-0",
              kind: "file",
              editable: true,
            },
          ],
          truncated: false,
        },
  );

  await openRowMenu("App.tsx");
  await act(async () => menuItem("Renommer ou déplacer…").click());
  await submitPathDialog("src/app.tsx");
  expect(api.renameProjectFile).toHaveBeenCalledWith(
    project.id,
    "src/App.tsx",
    "src/app.tsx",
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(document.activeElement).toBe(
        textButton(".soreno-rename-1-0", container),
      ),
    ),
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(getNotifications()).toMatchObject([
        {
          message:
            "Le renommage a été interrompu : l’élément est resté sous « src/.soreno-rename-1-0 ».",
          tone: "error",
        },
      ]),
    ),
  );
  expect(api.listProjectFiles).toHaveBeenCalledWith(project.id, "src");
  expect(() => textButton("App.tsx", container)).toThrow();
});

it("deletes the open file after an explicit permanent-deletion confirmation", async () => {
  vi.mocked(api.deleteProjectFile).mockResolvedValue(undefined);
  await render();
  await openReadme();
  const editor = EditorView.findFromDOM(
    container.querySelector(".cm-editor")!,
  )!;
  await act(async () =>
    editor.dispatch({ changes: { from: 0, insert: "draft " } }),
  );

  await openRowMenu("README.md");
  await act(async () => menuItem("Supprimer…").click());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain(
    "README.md sera supprimé définitivement, sans passer par la corbeille.",
  );
  expect(dialog.textContent).toContain(
    "Les modifications non enregistrées du fichier ouvert seront perdues.",
  );
  expect(api.deleteProjectFile).not.toHaveBeenCalled();

  await act(async () => textButton("Supprimer définitivement").click());
  expect(api.deleteProjectFile).toHaveBeenCalledWith(project.id, "README.md");
  await act(async () =>
    vi.waitFor(() => expect(container.querySelector(".cm-editor")).toBeNull()),
  );
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () =>
    vi.waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('[aria-label="Actualiser les fichiers"]'),
      ),
    ),
  );

  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
  );
  vi.mocked(api.listProjectFiles).mockImplementation(async (_id, directory) =>
    directory === ""
      ? {
          entries: [
            { name: "src", path: "src", kind: "directory", editable: false },
          ],
          truncated: false,
        }
      : { entries: [], truncated: false },
  );
  await openRowMenu("App.tsx");
  await act(async () => menuItem("Supprimer…").click());
  await act(async () => textButton("Supprimer définitivement").click());
  expect(api.deleteProjectFile).toHaveBeenCalledWith(project.id, "src/App.tsx");
  await act(async () =>
    vi.waitFor(() => expect(() => textButton("App.tsx", container)).toThrow()),
  );
  expect(document.activeElement).toBe(textButton("src", container));
});

it.each(["delete", "rename"] as const)(
  "drops a pending file read when its file is affected by a %s",
  async (operation) => {
    vi.mocked(api.deleteProjectFile).mockResolvedValue(undefined);
    vi.mocked(api.renameProjectFile).mockResolvedValue({
      name: "Main.tsx",
      path: "src/Main.tsx",
      kind: "file",
      editable: true,
    });
    await render();
    await act(async () => textButton("src", container).click());
    await act(async () =>
      vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
    );
    const resolveRead = deferred<ProjectFileContent>();
    vi.mocked(api.readProjectFile).mockReturnValue(resolveRead.promise);
    await act(async () => textButton("App.tsx", container).click());
    expect(api.readProjectFile).toHaveBeenCalledWith(project.id, "src/App.tsx");

    if (operation === "delete") {
      await openRowMenu("src");
      await act(async () => menuItem("Supprimer…").click());
      await act(async () => textButton("Supprimer définitivement").click());
      expect(api.deleteProjectFile).toHaveBeenCalledWith(project.id, "src");
    } else {
      await openRowMenu("App.tsx");
      await act(async () => menuItem("Renommer ou déplacer…").click());
      await submitPathDialog("src/Main.tsx");
      expect(api.renameProjectFile).toHaveBeenCalledWith(
        project.id,
        "src/App.tsx",
        "src/Main.tsx",
      );
    }
    await act(async () =>
      resolveRead.resolve({
        path: "src/App.tsx",
        content: "old\n",
        version: "v1",
      }),
    );

    expect(container.querySelector(".cm-editor")).toBeNull();
    expect(container.querySelector(".project-file-editor-path")).toBeNull();
    expect(
      container.querySelector(".project-explorer")?.getAttribute("aria-busy"),
    ).toBe("false");
    expect(readRecentProjectFiles(project.id)).not.toContain("src/App.tsx");
  },
);

it("keeps a deleted file absent when an older refresh resolves late", async () => {
  vi.mocked(api.deleteProjectFile).mockResolvedValue(undefined);
  await render();
  await act(async () =>
    vi.waitFor(() => expect(textButton("README.md", container)).toBeTruthy()),
  );
  const resolveRefresh = deferred<ProjectFileListing>();
  const withoutReadme: ProjectFileListing = {
    entries: [{ name: "src", path: "src", kind: "directory", editable: false }],
    truncated: false,
  };
  vi.mocked(api.listProjectFiles)
    .mockReturnValueOnce(resolveRefresh.promise)
    .mockResolvedValue(withoutReadme);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Actualiser les fichiers"]',
      )!
      .click(),
  );

  await openRowMenu("README.md");
  await act(async () => menuItem("Supprimer…").click());
  await act(async () => textButton("Supprimer définitivement").click());
  await act(async () =>
    vi.waitFor(() =>
      expect(() => textButton("README.md", container)).toThrow(),
    ),
  );

  await act(async () =>
    resolveRefresh.resolve({
      entries: [
        ...withoutReadme.entries,
        { name: "README.md", path: "README.md", kind: "file", editable: true },
      ],
      truncated: false,
    }),
  );
  expect(() => textButton("README.md", container)).toThrow();
  expect(
    container.querySelector(".project-explorer")?.getAttribute("aria-busy"),
  ).toBe("false");
});

it("duplicates an entry and collapses the tree from the toolbar", async () => {
  vi.mocked(api.duplicateProjectFile).mockResolvedValue({
    name: "App copy.tsx",
    path: "src/App copy.tsx",
    kind: "file",
    editable: true,
  });
  await render();
  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
  );
  await openRowMenu("App.tsx");
  await act(async () => menuItem("Dupliquer").click());
  expect(api.duplicateProjectFile).toHaveBeenCalledWith(
    project.id,
    "src/App.tsx",
  );

  await act(async () => textButton("App.tsx", container).click());
  await act(async () =>
    vi.waitFor(() =>
      expect(container.querySelector(".cm-editor")).not.toBeNull(),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Tout replier"]')!
      .click(),
  );
  expect(() => textButton("App.tsx", container)).toThrow();
});

it("pastes clipboard files into the folder of the focused row", async () => {
  const onFilesChanged = vi.fn();
  vi.mocked(api.pasteProjectFiles)
    .mockResolvedValueOnce([
      {
        name: "photo.png",
        path: "src/photo.png",
        kind: "file",
        editable: false,
      },
    ])
    .mockRejectedValueOnce({
      code: "clipboardEmpty",
      message: "Le presse-papiers ne contient aucun fichier.",
    });
  await act(async () =>
    root.render(
      <ProjectExplorer project={project} onFilesChanged={onFilesChanged} />,
    ),
  );
  await act(async () => textButton("src", container).click());
  await act(async () =>
    vi.waitFor(() => expect(textButton("App.tsx", container)).toBeTruthy()),
  );
  vi.mocked(api.listProjectFiles).mockClear();

  const row = textButton("App.tsx", container);
  row.focus();
  await act(async () =>
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }),
    ),
  );
  expect(api.pasteProjectFiles).toHaveBeenLastCalledWith(project.id, "src");
  expect(onFilesChanged).toHaveBeenCalledTimes(1);
  expect(api.listProjectFiles).toHaveBeenCalledWith(project.id, "src");

  await openRowMenu("README.md");
  await act(async () => menuItem("Coller").click());
  expect(api.pasteProjectFiles).toHaveBeenLastCalledWith(project.id, "");
  await act(async () =>
    vi.waitFor(() =>
      expect(getNotifications().map((item) => item.message)).toEqual([
        "Le presse-papiers ne contient aucun fichier.",
      ]),
    ),
  );
});

it("creates a nested file and lists each uncached ancestor once", async () => {
  const deep = {
    name: "deep.ts",
    path: "src/lib/deep.ts",
    kind: "file" as const,
    editable: true,
  };
  vi.mocked(api.createProjectFile).mockResolvedValueOnce(deep);
  await render();
  await act(async () =>
    vi.waitFor(() => expect(textButton("src", container)).toBeTruthy()),
  );
  const rootListing = await api.listProjectFiles(project.id, "");
  vi.mocked(api.listProjectFiles).mockClear();
  vi.mocked(api.listProjectFiles).mockImplementation(
    async (_projectId, directory) => {
      if (directory === "") return rootListing;
      if (directory === "src")
        return {
          entries: [
            {
              name: "lib",
              path: "src/lib",
              kind: "directory",
              editable: false,
            },
          ],
          truncated: false,
        };
      return { entries: [deep], truncated: false };
    },
  );

  await openRowMenu("README.md");
  await act(async () => menuItem("Nouveau fichier…").click());
  await submitPathDialog("src/lib/deep.ts");
  expect(api.createProjectFile).toHaveBeenCalledWith(
    project.id,
    "src/lib/deep.ts",
    "file",
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(document.activeElement).toBe(textButton("deep.ts", container)),
    ),
  );
  const calls = vi
    .mocked(api.listProjectFiles)
    .mock.calls.map(([, directory]) => directory);
  expect(calls.filter((directory) => directory === "src")).toHaveLength(1);
  expect(calls.filter((directory) => directory === "src/lib")).toHaveLength(1);
});
