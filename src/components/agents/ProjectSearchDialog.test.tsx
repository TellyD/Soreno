// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../data/projectFilesApi";
import type { ProjectTextSearchResult } from "../../domain/projectFiles";
import { clearNotifications, getNotifications } from "../../notifications";
import { ProjectSearchDialog } from "./ProjectSearchDialog";
import { localTestProject as project } from "./testProject";
import { setInputValue } from "../ui/testInput";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({ settings: { materialFileIconsEnabled: false } }),
}));
vi.mock("../../data/projectFilesApi", () => ({
  searchProjectText: vi.fn(),
}));

const noOptions = { caseSensitive: false, wholeWord: false, regex: false };
const result: ProjectTextSearchResult = {
  files: [
    {
      path: "src/App.tsx",
      lines: [
        {
          line: 3,
          preview: "const value = load();",
          ranges: [[6, 11]],
          selection: [8, 13],
        },
        {
          line: 9,
          preview: "return value;",
          ranges: [[7, 12]],
          selection: null,
        },
      ],
    },
    {
      path: "README.md",
      lines: [
        {
          line: 1,
          preview: "value and value",
          ranges: [
            [0, 5],
            [10, 15],
          ],
          selection: [0, 5],
        },
      ],
    },
  ],
  lineCount: 3,
  truncated: true,
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.mocked(api.searchProjectText).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  clearNotifications();
  container.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderDialog(
  props: Partial<Parameters<typeof ProjectSearchDialog>[0]> = {},
) {
  await act(async () =>
    root.render(
      <ProjectSearchDialog
        roots={[{ projectId: project.id, label: "" }]}
        initialQuery=""
        initialOptions={noOptions}
        onClose={() => {}}
        onSelect={() => {}}
        onStateChange={() => {}}
        {...props}
      />,
    ),
  );
  return document.querySelector<HTMLInputElement>('[role="combobox"]')!;
}

async function setQuery(value: string) {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => {
    setInputValue(input, value);
  });
}

async function press(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
) {
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    ),
  );
}

it("sends nothing for an empty query", async () => {
  await renderDialog();
  await act(async () => vi.advanceTimersByTimeAsync(500));

  expect(api.searchProjectText).not.toHaveBeenCalled();
});

it("groups highlighted results by file and opens the active line", async () => {
  vi.mocked(api.searchProjectText).mockResolvedValue(result);
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const onStateChange = vi.fn();
  const input = await renderDialog({
    initialQuery: "value",
    onClose,
    onSelect,
    onStateChange,
  });
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(5);
  await act(async () => vi.advanceTimersByTimeAsync(150));

  expect(api.searchProjectText).toHaveBeenCalledWith(
    project.id,
    "value",
    noOptions,
    true,
  );
  const groups = document.querySelectorAll('[role="group"]');
  expect([...groups].map((group) => group.getAttribute("aria-label"))).toEqual([
    "src/App.tsx",
    "README.md",
  ]);
  expect(groups[0].querySelectorAll('[role="option"]')).toHaveLength(2);
  expect(
    [...groups[1].querySelectorAll("mark")].map((mark) => mark.textContent),
  ).toEqual(["value", "value"]);
  expect(document.body.textContent).toContain("3 résultats dans 2 fichiers");
  expect(document.body.textContent).toContain(
    "Seuls les 1 000 premiers résultats sont affichés.",
  );
  expect(onStateChange).toHaveBeenLastCalledWith({
    query: "value",
    options: noOptions,
  });

  await press(input, "ArrowDown");
  await press(input, "ArrowDown");
  await press(input, "ArrowDown");
  await press(input, "ArrowUp");
  expect(
    document.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toContain("value and value");
  await press(input, "Home");
  await press(input, "ArrowDown");
  await press(input, "Enter");

  expect(onClose).toHaveBeenCalledOnce();
  expect(onSelect).toHaveBeenCalledWith({
    projectId: project.id,
    path: "src/App.tsx",
    line: 9,
    start: 0,
    end: 0,
  });
});

it("searches again with the toggled options", async () => {
  vi.mocked(api.searchProjectText).mockResolvedValue(result);
  const onStateChange = vi.fn();
  const input = await renderDialog({ initialQuery: "value", onStateChange });
  await act(async () => vi.advanceTimersByTimeAsync(150));

  const caseButton = document.querySelector<HTMLButtonElement>(
    '[aria-label="Respecter la casse"]',
  )!;
  expect(caseButton.getAttribute("aria-pressed")).toBe("false");
  await act(async () => caseButton.click());
  expect(caseButton.getAttribute("aria-pressed")).toBe("true");
  await press(input, "®", { altKey: true, code: "KeyR" });
  await act(async () => vi.advanceTimersByTimeAsync(150));

  const options = { caseSensitive: true, wholeWord: false, regex: true };
  expect(api.searchProjectText).toHaveBeenCalledTimes(2);
  expect(api.searchProjectText).toHaveBeenLastCalledWith(
    project.id,
    "value",
    options,
    false,
  );
  expect(onStateChange).toHaveBeenLastCalledWith({ query: "value", options });
});

it("ignores a late response from an older query", async () => {
  const resolvers = new Map<string, (value: ProjectTextSearchResult) => void>();
  vi.mocked(api.searchProjectText).mockImplementation(
    (_projectId, query) =>
      new Promise((resolve) => resolvers.set(query, resolve)),
  );
  await renderDialog({ initialQuery: "old" });
  await act(async () => vi.advanceTimersByTimeAsync(150));
  await setQuery("new");
  await act(async () => vi.advanceTimersByTimeAsync(150));

  await act(async () =>
    resolvers.get("new")!({
      files: [
        {
          path: "new.ts",
          lines: [
            { line: 1, preview: "new", ranges: [[0, 3]], selection: [0, 3] },
          ],
        },
      ],
      lineCount: 1,
      truncated: false,
    }),
  );
  await act(async () => resolvers.get("old")!(result));

  const groups = document.querySelectorAll('[role="group"]');
  expect(groups).toHaveLength(1);
  expect(groups[0].getAttribute("aria-label")).toBe("new.ts");
});

it("shows an invalid regular expression inline without a notification", async () => {
  vi.mocked(api.searchProjectText).mockRejectedValue({
    code: "invalidQuery",
    message: "regex parse error",
  });
  await renderDialog({
    initialQuery: "(",
    initialOptions: { ...noOptions, regex: true },
  });
  await act(async () => vi.advanceTimersByTimeAsync(150));

  expect(document.body.textContent).toContain("Expression régulière invalide.");
  expect(getNotifications()).toEqual([]);
});
