// @vitest-environment jsdom
import { StrictMode, act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../data/projectFilesApi";
import { recentProjectFilesKey } from "../../domain/recentProjectFiles";
import { clearNotifications, getNotifications } from "../../notifications";
import { QuickOpenDialog } from "./QuickOpenDialog";
import { localTestProject as project } from "./testProject";
import { setInputValue } from "../ui/testInput";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({ settings: { materialFileIconsEnabled: false } }),
}));
vi.mock("../../data/projectFilesApi", () => ({
  searchProjectFiles: vi.fn(),
}));

const otherProject = {
  ...project,
  id: "p2",
  name: "Other",
  path: "/projects/other",
};
const rootsOf = (...projects: { id: string }[]) =>
  projects.map((item) => ({ projectId: item.id, label: "" }));
let container: HTMLDivElement;
let root: Root;
let originalScrollIntoView: PropertyDescriptor | undefined;
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  clearNotifications();
  localStorage.clear();
  container.remove();
  if (originalScrollIntoView) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  } else {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setQuery(value: string) {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => {
    setInputValue(input, value);
  });
  return input;
}

async function renderDialog(
  props: Partial<ComponentProps<typeof QuickOpenDialog>> = {},
) {
  await act(async () =>
    root.render(
      <QuickOpenDialog
        roots={rootsOf(project)}
        onClose={() => {}}
        onSelect={() => {}}
        {...props}
      />,
    ),
  );
}

it("prewarms immediately without showing a spinner for an empty query", async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchProjectFiles).mockImplementation(
    () => new Promise(() => {}),
  );
  await renderDialog();

  expect(document.querySelector(".app-loading-spinner")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(api.searchProjectFiles).toHaveBeenCalledOnce();
  expect(api.searchProjectFiles).toHaveBeenCalledWith(project.id, "", true, []);
  expect(document.querySelector(".app-loading-spinner")).toBeNull();
});

it("keeps a failed empty prewarm silent and refreshes the first query", async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchProjectFiles)
    .mockRejectedValueOnce(new Error("prewarm failed"))
    .mockResolvedValueOnce({ entries: [], truncated: false, recentCount: 0 });
  await renderDialog();

  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(getNotifications()).toEqual([]);
  await setQuery("retry");
  await act(async () => vi.advanceTimersByTimeAsync(120));
  expect(api.searchProjectFiles).toHaveBeenLastCalledWith(
    project.id,
    "retry",
    true,
    [],
  );
});

it("deduplicates the StrictMode prewarm and cancels it on unmount", async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchProjectFiles).mockResolvedValue({
    entries: [],
    truncated: false,
    recentCount: 0,
  });
  await act(async () =>
    root.render(
      <StrictMode>
        <QuickOpenDialog
          roots={rootsOf(project)}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </StrictMode>,
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(api.searchProjectFiles).toHaveBeenCalledTimes(1);

  vi.mocked(api.searchProjectFiles).mockClear();
  await renderDialog({ roots: rootsOf(otherProject) });
  await act(async () => root.render(<></>));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(api.searchProjectFiles).not.toHaveBeenCalled();
});

it("searches once per opening and opens the active keyboard result", async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchProjectFiles).mockResolvedValue({
    entries: [
      {
        name: "AgentForms.tsx",
        path: "src/components/AgentForms.tsx",
        kind: "file",
        editable: true,
      },
      {
        name: "agent_sessions.rs",
        path: "src-tauri/src/agent_sessions.rs",
        kind: "file",
        editable: true,
      },
    ],
    truncated: false,
    recentCount: 0,
  });
  const onClose = vi.fn();
  const onSelect = vi.fn();
  await renderDialog({ onClose, onSelect });

  const input = await setQuery("agtfrm");
  expect(api.searchProjectFiles).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(120));

  expect(api.searchProjectFiles).toHaveBeenCalledWith(
    project.id,
    "agtfrm",
    true,
    [],
  );
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
  expect(
    document.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toContain("AgentForms.tsx");

  scrollIntoView.mockClear();
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  expect(
    document.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toContain("AgentForms.tsx");

  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSelect).toHaveBeenCalledWith(
    project.id,
    "src-tauri/src/agent_sessions.rs",
  );
});

it("lists recently opened files first, with or without a query", async () => {
  vi.useFakeTimers();
  localStorage.setItem(
    recentProjectFilesKey,
    JSON.stringify({
      [project.id]: [".env.local", "src/App.tsx"],
      [otherProject.id]: ["other.ts"],
    }),
  );
  vi.mocked(api.searchProjectFiles).mockResolvedValue({
    entries: [
      { name: ".env.local", path: ".env.local", kind: "file", editable: true },
      { name: "env.ts", path: "src/env.ts", kind: "file", editable: true },
    ],
    truncated: false,
    recentCount: 1,
  });
  const onSelect = vi.fn();
  await renderDialog({ onSelect });
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    );

  expect(options()).toEqual([
    expect.stringContaining("Récemment ouvert"),
    expect.stringContaining("Récemment ouvert"),
  ]);
  expect(options()[1]).toContain("App.tsx");

  const input = await setQuery("env");
  await act(async () => vi.advanceTimersByTimeAsync(120));
  expect(api.searchProjectFiles).toHaveBeenLastCalledWith(
    project.id,
    "env",
    true,
    [".env.local", "src/App.tsx"],
  );
  expect(options()).toEqual([
    expect.stringContaining("Récemment ouvert"),
    expect.not.stringContaining("Récemment ouvert"),
  ]);

  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(onSelect).toHaveBeenCalledWith(project.id, ".env.local");
});

it("searches every group member under its name, despite a failing one", async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchProjectFiles).mockImplementation(async (projectId) => {
    if (projectId === otherProject.id) throw new Error("offline");
    return {
      entries: [
        { name: "a.ts", path: "src/a.ts", kind: "file", editable: true },
      ],
      truncated: false,
      recentCount: 0,
    };
  });
  const onSelect = vi.fn();
  await renderDialog({
    roots: [
      { projectId: project.id, label: "Soreno" },
      { projectId: otherProject.id, label: "Other" },
    ],
    onSelect,
  });

  const input = await setQuery("a");
  await act(async () => vi.advanceTimersByTimeAsync(120));
  const options = document.querySelectorAll('[role="option"]');
  expect(options).toHaveLength(1);
  expect(options[0].textContent).toContain("Soreno/src");
  expect(getNotifications()).toEqual([]);

  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(onSelect).toHaveBeenCalledWith(project.id, "src/a.ts");
});

it("keeps the initial refresh when typing again before the debounce", async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchProjectFiles).mockResolvedValue({
    entries: [],
    truncated: false,
    recentCount: 0,
  });
  await renderDialog();

  await setQuery("first");
  await setQuery("second");
  await act(async () => vi.advanceTimersByTimeAsync(0));

  expect(api.searchProjectFiles).toHaveBeenCalledTimes(1);
  expect(api.searchProjectFiles).toHaveBeenCalledWith(
    project.id,
    "second",
    true,
    [],
  );
});

it("queues only the latest query while the initial refresh is pending", async () => {
  vi.useFakeTimers();
  let resolveRefresh!: (
    value: Awaited<ReturnType<typeof api.searchProjectFiles>>,
  ) => void;
  vi.mocked(api.searchProjectFiles).mockImplementation(
    (_projectId, query, shouldRefresh) =>
      shouldRefresh
        ? new Promise((resolve) => {
            resolveRefresh = resolve;
          })
        : Promise.resolve({
            entries: [
              {
                name: `${query}.ts`,
                path: `${query}.ts`,
                kind: "file",
                editable: true,
              },
            ],
            truncated: false,
            recentCount: 0,
          }),
  );
  await renderDialog();

  await act(async () => vi.advanceTimersByTimeAsync(0));
  await setQuery("first");
  await setQuery("second");
  await setQuery("latest");
  await act(async () => vi.advanceTimersByTimeAsync(120));

  expect(api.searchProjectFiles).toHaveBeenCalledTimes(1);
  expect(api.searchProjectFiles).toHaveBeenCalledWith(project.id, "", true, []);

  await act(async () => {
    resolveRefresh({ entries: [], truncated: false, recentCount: 0 });
    await Promise.resolve();
  });

  expect(api.searchProjectFiles).toHaveBeenCalledTimes(2);
  expect(api.searchProjectFiles).toHaveBeenLastCalledWith(
    project.id,
    "latest",
    false,
    [],
  );
  expect(document.body.textContent).toContain("latest.ts");
});

it("starts a fresh project refresh and ignores the previous project response", async () => {
  vi.useFakeTimers();
  let resolveFirstProject!: (
    value: Awaited<ReturnType<typeof api.searchProjectFiles>>,
  ) => void;
  let resolveOtherProject!: (
    value: Awaited<ReturnType<typeof api.searchProjectFiles>>,
  ) => void;
  vi.mocked(api.searchProjectFiles).mockImplementation((projectId) => {
    return new Promise((resolve) => {
      if (projectId === project.id) resolveFirstProject = resolve;
      else resolveOtherProject = resolve;
    });
  });
  await renderDialog();

  await setQuery("first");
  await act(async () => vi.advanceTimersByTimeAsync(120));
  await setQuery("current");
  await renderDialog({ roots: rootsOf(otherProject) });
  await act(async () => {
    resolveFirstProject({
      entries: [
        { name: "old-a.ts", path: "old-a.ts", kind: "file", editable: true },
      ],
      truncated: false,
      recentCount: 0,
    });
    await Promise.resolve();
  });

  expect(api.searchProjectFiles).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("old-a.ts");

  await act(async () => vi.advanceTimersByTimeAsync(120));
  expect(api.searchProjectFiles).toHaveBeenCalledTimes(2);
  expect(api.searchProjectFiles).toHaveBeenLastCalledWith(
    otherProject.id,
    "current",
    true,
    [],
  );
  await act(async () =>
    resolveOtherProject({
      entries: [
        { name: "from-b.ts", path: "from-b.ts", kind: "file", editable: true },
      ],
      truncated: false,
      recentCount: 0,
    }),
  );
  expect(document.body.textContent).toContain("from-b.ts");
});

it("does not coalesce another search after unmounting during refresh", async () => {
  vi.useFakeTimers();
  let resolveRefresh!: (
    value: Awaited<ReturnType<typeof api.searchProjectFiles>>,
  ) => void;
  vi.mocked(api.searchProjectFiles).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
  );
  await renderDialog();

  await setQuery("first");
  await act(async () => vi.advanceTimersByTimeAsync(120));
  await setQuery("queued");
  await act(async () => root.render(<></>));
  await act(async () => {
    resolveRefresh({ entries: [], truncated: false, recentCount: 0 });
    await Promise.resolve();
  });

  expect(api.searchProjectFiles).toHaveBeenCalledTimes(1);
});

it("keeps refresh required after an initial failure", async () => {
  vi.useFakeTimers();
  let rejectRefresh!: (reason: unknown) => void;
  vi.mocked(api.searchProjectFiles)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    )
    .mockResolvedValue({ entries: [], truncated: false, recentCount: 0 });
  await renderDialog();

  await setQuery("first");
  await act(async () => vi.advanceTimersByTimeAsync(120));
  const input = await setQuery("current");
  await act(async () => rejectRefresh(new Error("refresh failed")));

  expect(input.value).toBe("current");
  expect(getNotifications()).toEqual([
    expect.objectContaining({
      message: "L’opération a échoué. Réessayez.",
      tone: "error",
    }),
  ]);
  expect(api.searchProjectFiles).toHaveBeenCalledTimes(1);

  await setQuery("retry");
  expect(getNotifications()).toEqual([]);
  await act(async () => vi.advanceTimersByTimeAsync(120));
  expect(api.searchProjectFiles).toHaveBeenLastCalledWith(
    project.id,
    "retry",
    true,
    [],
  );
});

it("does not open stale results while a newer search loads or fails", async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchProjectFiles)
    .mockResolvedValueOnce({
      entries: [
        { name: "old.ts", path: "old.ts", kind: "file", editable: true },
      ],
      truncated: false,
      recentCount: 0,
    })
    .mockRejectedValueOnce(new Error("search failed"));
  const onSelect = vi.fn();
  await renderDialog({ onSelect });

  const input = await setQuery("old");
  await act(async () => vi.advanceTimersByTimeAsync(120));
  expect(document.body.textContent).toContain("old.ts");

  await setQuery("new");
  const staleOption = document.querySelector<HTMLElement>('[role="option"]')!;
  expect(document.body.textContent).toContain("old.ts");
  expect(staleOption.getAttribute("aria-disabled")).toBe("true");
  expect(staleOption.hasAttribute("aria-selected")).toBe(false);
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  await act(async () => {
    staleOption.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onSelect).not.toHaveBeenCalled();

  await act(async () => vi.advanceTimersByTimeAsync(35));
  expect(getNotifications()).toHaveLength(1);
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(onSelect).not.toHaveBeenCalled();
});

it("ignores a late response from an older warm query", async () => {
  vi.useFakeTimers();
  const resolvers = new Map<
    string,
    (value: Awaited<ReturnType<typeof api.searchProjectFiles>>) => void
  >();
  vi.mocked(api.searchProjectFiles)
    .mockResolvedValueOnce({ entries: [], truncated: false, recentCount: 0 })
    .mockImplementation(
      (_projectId, query) =>
        new Promise((resolve) => {
          resolvers.set(query, resolve);
        }),
    );
  await renderDialog();

  await setQuery("seed");
  await act(async () => vi.advanceTimersByTimeAsync(120));
  await setQuery("old");
  await act(async () => vi.advanceTimersByTimeAsync(35));
  await setQuery("new");
  await act(async () => vi.advanceTimersByTimeAsync(35));
  expect(api.searchProjectFiles).toHaveBeenNthCalledWith(
    2,
    project.id,
    "old",
    false,
    [],
  );
  expect(api.searchProjectFiles).toHaveBeenNthCalledWith(
    3,
    project.id,
    "new",
    false,
    [],
  );
  await act(async () =>
    resolvers.get("new")!({
      entries: [
        { name: "new.ts", path: "new.ts", kind: "file", editable: true },
      ],
      truncated: false,
      recentCount: 0,
    }),
  );
  await act(async () =>
    resolvers.get("old")!({
      entries: [
        { name: "old.ts", path: "old.ts", kind: "file", editable: true },
      ],
      truncated: false,
      recentCount: 0,
    }),
  );

  expect(document.body.textContent).toContain("new.ts");
  expect(document.body.textContent).not.toContain("old.ts");
});
