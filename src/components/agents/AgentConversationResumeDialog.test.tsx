// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../data/agentConversationApi";
import { setInputValue } from "../ui/testInput";
import { AgentConversationResumeDialog } from "./AgentConversationResumeDialog";
import { agentStringsForLocale } from "./agentStrings";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../data/agentConversationApi", () => ({
  readAgentConversationHistory: vi.fn(),
}));

const s = agentStringsForLocale("fr-FR").conversation;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render(onClose = vi.fn(), onSelect = vi.fn()) {
  await act(async () =>
    root.render(
      <AgentConversationResumeDialog
        sessionId="s1"
        onClose={onClose}
        onSelect={onSelect}
        s={s}
      />,
    ),
  );
  return document.querySelector<HTMLInputElement>('[role="combobox"]')!;
}

function key(input: HTMLInputElement, name: string) {
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  );
}

it("filters the conversations and opens the one chosen with the keyboard", async () => {
  vi.mocked(api.readAgentConversationHistory).mockResolvedValue({
    entries: [
      { path: "/s/3.jsonl", title: "Current work", modified: 3, current: true },
      { path: "/s/2.jsonl", title: null, modified: 2, current: false },
      { path: "/s/1.jsonl", title: "Fix the bug", modified: 1, current: false },
    ],
    more: false,
  });
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const input = await render(onClose, onSelect);
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    );
  expect(options()).toEqual([
    expect.stringContaining(`Current work`),
    expect.stringContaining(s.resumeUntitled),
    expect.stringContaining("Fix the bug"),
  ]);
  expect(options()[0]).toContain(s.resumeCurrent);

  await act(async () => setInputValue(input, "sans"));
  expect(options()).toEqual([expect.stringContaining(s.resumeUntitled)]);
  await act(async () => setInputValue(input, "zzz"));
  expect(document.body.textContent).toContain(s.resumeNoMatch);

  await act(async () => setInputValue(input, ""));
  await act(async () => key(input, "ArrowUp"));
  await act(async () => key(input, "Enter"));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSelect).toHaveBeenCalledWith("/s/1.jsonl");
});

it("closes without switching on the current conversation or Escape", async () => {
  vi.mocked(api.readAgentConversationHistory).mockResolvedValue({
    entries: [
      { path: "/s/3.jsonl", title: "Current", modified: 3, current: true },
    ],
    more: false,
  });
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const input = await render(onClose, onSelect);
  await act(async () => key(input, "Enter"));
  await act(async () => key(input, "Escape"));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(onSelect).not.toHaveBeenCalled();
});

it("shows the empty list and errors", async () => {
  vi.mocked(api.readAgentConversationHistory).mockResolvedValue({
    entries: [],
    more: false,
  });
  await render();
  expect(document.body.textContent).toContain(s.resumeEmpty);
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.mocked(api.readAgentConversationHistory).mockRejectedValue(
    "Connexion SSH manquante.",
  );
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Connexion SSH manquante.",
  );
});

it("loads the next page from its option, including when the search finds nothing", async () => {
  const read = vi.mocked(api.readAgentConversationHistory);
  read.mockResolvedValueOnce({
    entries: [
      { path: "/s/3.jsonl", title: "Recent", modified: 3, current: true },
    ],
    more: true,
  });
  read.mockResolvedValueOnce({
    entries: [
      { path: "/s/2.jsonl", title: "Older", modified: 2, current: false },
    ],
    more: true,
  });
  read.mockResolvedValueOnce({
    entries: [
      { path: "/s/1.jsonl", title: "Oldest", modified: 1, current: false },
    ],
    more: false,
  });
  const onSelect = vi.fn();
  const input = await render(vi.fn(), onSelect);
  expect(read).toHaveBeenLastCalledWith("s1", 0, 20);
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    );
  expect(options()).toEqual([expect.stringContaining("Recent"), s.resumeMore]);

  await act(async () => key(input, "ArrowDown"));
  await act(async () => key(input, "Enter"));
  expect(read).toHaveBeenLastCalledWith("s1", 20, 20);
  expect(options()).toEqual([
    expect.stringContaining("Recent"),
    expect.stringContaining("Older"),
    s.resumeMore,
  ]);

  await act(async () => setInputValue(input, "oldest"));
  expect(options()).toEqual([s.resumeMore]);
  await act(async () =>
    document.querySelector<HTMLElement>('[role="option"]')!.click(),
  );
  expect(read).toHaveBeenLastCalledWith("s1", 40, 20);
  expect(options()).toEqual([expect.stringContaining("Oldest")]);
  await act(async () => key(input, "Enter"));
  expect(onSelect).toHaveBeenCalledWith("/s/1.jsonl");
});
