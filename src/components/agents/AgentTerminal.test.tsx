// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../data/agentSessionsApi";
import * as clipboard from "../../data/clipboard";
import type { AgentGridFrame } from "../../domain/agentSessions";
import { clearNotifications, getNotifications } from "../../notifications";
import { deferred } from "../../testing/deferred";
import { GridMode } from "./agentGridKeys";
import { AgentTerminal, type AgentTerminalProps } from "./AgentTerminal";
import { stubModalSelector } from "../ui/testTopLayer";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "en-US" }) }));
vi.mock("../../theme/ThemeProvider", () => ({
  useTheme: () => ({ terminalTheme: "dark" }),
}));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({ settings: { terminalLogEnabled: false } }),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../data/agentSessionsApi", () => ({
  attachAgentFile: vi.fn(),
  subscribeAgentGrid: vi.fn(() => ({
    unsubscribe: vi.fn(),
    scroll: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    setVisible: vi.fn(async () => {}),
    text: vi.fn(async () => ""),
  })),
  sendAgentGridDiagnostic: vi.fn(async () => {}),
  writeAgentTerminal: vi.fn(async () => {}),
  uploadAgentClipboardImage: vi.fn(),
  resizeAgentTerminal: vi.fn(async () => {}),
}));
vi.mock("../../data/clipboard", () => ({
  readTerminalClipboard: vi.fn(),
  terminalClipboardImage: vi.fn(),
  writeClipboardText: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // jsdom lacks `:modal` and PointerEvent, which the context menu relies on.
  stubModalSelector();
  vi.stubGlobal("PointerEvent", MouseEvent);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearNotifications();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function drop(target: Element, type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"], dropEffect: "none" },
  });
  target.dispatchEvent(event);
  return event;
}

function openModal() {
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  return modal;
}

function messages() {
  return getNotifications().map((notification) => notification.message);
}

type Transition =
  "hidden" | "hidden-return" | "restart" | "session" | "stopped" | "unmount";

async function transition(change: Transition) {
  if (change === "hidden" || change === "hidden-return")
    await render("running", { visible: false });
  if (change === "hidden-return") await render();
  if (change === "restart") await render("running", { runRevision: 1 });
  if (change === "session")
    await render("running", { sessionId: "s2", name: "Other" });
  if (change === "stopped") await render("exited");
  if (change === "unmount") await act(async () => root.render(null));
}

async function render(
  state: "running" | "exited" = "running",
  props: Partial<AgentTerminalProps> = {},
) {
  await act(async () =>
    root.render(
      <AgentTerminal
        sessionId="s1"
        name="Pi"
        visible
        state={state}
        runRevision={0}
        focusRequest={0}
        {...props}
      />,
    ),
  );
  return container.querySelector<HTMLElement>(".agent-terminal-host")!;
}

it("uploads dropped files and pastes their paths into the running agent", async () => {
  vi.mocked(api.attachAgentFile)
    .mockResolvedValueOnce("'/tmp/a.txt'")
    .mockResolvedValueOnce("'/tmp/b.png'");
  const host = await render();
  const files = [new File(["a"], "a.txt"), new File(["b"], "b.png")];
  await act(async () => drop(host, "dragenter", files));
  expect(container.textContent).toContain("Drop files into the conversation");
  await act(async () => drop(host, "drop", files));
  expect(container.querySelector(".agent-terminal-file-drop")).toBeNull();
  expect(api.attachAgentFile).toHaveBeenCalledTimes(2);
  expect(api.writeAgentTerminal).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "'/tmp/a.txt' '/tmp/b.png' ",
  );
});

it("refuses drops on a stopped agent and oversized batches", async () => {
  const stopped = await render("exited");
  await act(async () => drop(stopped, "drop", [new File(["a"], "a.txt")]));
  expect(api.attachAgentFile).not.toHaveBeenCalled();

  const host = await render();
  const many = Array.from({ length: 17 }, (_, i) => new File([""], `${i}`));
  await act(async () => drop(host, "drop", many));
  expect(api.attachAgentFile).not.toHaveBeenCalled();
  expect(getNotifications()).toHaveLength(1);
});

it("lets a newer drop invalidate an older file transfer", async () => {
  const finishOld = deferred<string>();
  vi.mocked(api.attachAgentFile)
    .mockReturnValueOnce(finishOld.promise)
    .mockResolvedValueOnce("'/tmp/new.txt'");
  const host = await render();
  await act(async () => drop(host, "drop", [new File(["old"], "old.txt")]));
  await act(async () => drop(host, "drop", [new File(["new"], "new.txt")]));
  expect(api.writeAgentTerminal).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "'/tmp/new.txt' ",
  );
  await act(async () => finishOld.resolve("'/tmp/old.txt'"));
  expect(api.writeAgentTerminal).toHaveBeenCalledTimes(1);
});

it("ignores file drops before a modal and completions after one opens", async () => {
  const upload = deferred<string>();
  vi.mocked(api.attachAgentFile).mockReturnValueOnce(upload.promise);
  const host = await render();
  const modal = openModal();
  let blocked!: Event;
  await act(async () => {
    blocked = drop(host, "drop", [new File(["blocked"], "blocked.txt")]);
  });
  expect(blocked.defaultPrevented).toBe(true);
  expect(api.attachAgentFile).not.toHaveBeenCalled();

  modal.remove();
  await act(async () => drop(host, "drop", [new File(["late"], "late.txt")]));
  expect(api.attachAgentFile).toHaveBeenCalledOnce();
  document.body.append(modal);
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await act(async () => upload.resolve("'/tmp/late.txt'"));
  expect(api.writeAgentTerminal).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  modal.remove();
});

it.each<Transition>([
  "hidden",
  "hidden-return",
  "restart",
  "session",
  "stopped",
  "unmount",
])("invalidates a file transfer after becoming %s", async (change) => {
  const upload = deferred<string>();
  vi.mocked(api.attachAgentFile).mockReturnValueOnce(upload.promise);
  const host = await render();
  await act(async () => drop(host, "drop", [new File(["stale"], "stale.txt")]));
  expect(api.attachAgentFile).toHaveBeenCalledOnce();
  await transition(change);
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await act(async () => upload.resolve("'/tmp/stale.txt'"));
  expect(api.writeAgentTerminal).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(messages()).toEqual([]);
});

it("moves keyboard focus from the covered terminal to the notice actions", async () => {
  await render();
  const textarea = container.querySelector("textarea")!;
  textarea.focus();
  await render("exited", { notice: <button type="button">Retry</button> });
  const retry = container.querySelector("button")!;
  expect(document.activeElement).toBe(retry);
  // jsdom ignores `inert` when focusing, so assert the attribute browsers honor.
  expect(textarea.closest("[inert]")).not.toBeNull();
  expect(retry.closest("[inert]")).toBeNull();
});

async function pasteShortcut() {
  await act(async () =>
    container.querySelector("textarea")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "v",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

it("sends the configured CLI image shortcut raw when the clipboard holds an image", async () => {
  vi.mocked(clipboard.readTerminalClipboard).mockResolvedValue({
    type: "image",
  });
  await render();
  await paint();
  await pasteShortcut();
  expect(api.writeAgentTerminal).toHaveBeenLastCalledWith("s1", "\x16");

  await render("running", { imagePasteSequence: "\x1bv" });
  await pasteShortcut();
  expect(api.writeAgentTerminal).toHaveBeenLastCalledWith("s1", "\x1bv");
  expect(api.uploadAgentClipboardImage).not.toHaveBeenCalled();
});

it("uploads clipboard images over SSH and pastes their remote path while preserving text paste", async () => {
  vi.mocked(clipboard.readTerminalClipboard).mockResolvedValueOnce({
    type: "image",
    mimeType: "image/png",
    dataBase64: "aW1hZ2U=",
  });
  vi.mocked(api.uploadAgentClipboardImage).mockResolvedValue(
    "/tmp/soreno-1000/clipboard.png",
  );
  await render("running", { remote: true });
  await paint();
  await pasteShortcut();
  expect(clipboard.readTerminalClipboard).toHaveBeenCalledExactlyOnceWith(true);
  expect(api.uploadAgentClipboardImage).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "image/png",
    "aW1hZ2U=",
  );
  expect(api.writeAgentTerminal).toHaveBeenLastCalledWith(
    "s1",
    "/tmp/soreno-1000/clipboard.png",
  );

  vi.mocked(clipboard.readTerminalClipboard).mockResolvedValueOnce({
    type: "text",
    text: "remote text",
  });
  await pasteShortcut();
  expect(api.writeAgentTerminal).toHaveBeenLastCalledWith("s1", "remote text");
  expect(getNotifications()).toEqual([]);
});

it.each<Transition | "modal">([
  "hidden",
  "hidden-return",
  "restart",
  "session",
  "stopped",
  "modal",
  "unmount",
])("ignores late image clipboard completions after %s", async (change) => {
  const read = deferred<clipboard.TerminalClipboard>();
  vi.mocked(clipboard.readTerminalClipboard).mockReturnValueOnce(read.promise);
  await render();
  await pasteShortcut();
  expect(clipboard.readTerminalClipboard).toHaveBeenCalledOnce();
  const modal = change === "modal" ? openModal() : undefined;
  if (change !== "modal") await transition(change);
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await act(async () => read.resolve({ type: "image" }));
  expect(api.writeAgentTerminal).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  modal?.remove();
});

it("reports denied clipboard access and ignores a late failure from the previous run", async () => {
  vi.mocked(clipboard.readTerminalClipboard).mockRejectedValueOnce(
    new Error("Denied"),
  );
  await render();
  await pasteShortcut();
  expect(messages()).toEqual(["The clipboard is unavailable."]);
  clearNotifications();

  const read = deferred<clipboard.TerminalClipboard>();
  vi.mocked(clipboard.readTerminalClipboard).mockReturnValueOnce(read.promise);
  await pasteShortcut();
  await render("running", { runRevision: 1 });
  await act(async () => read.reject(new Error("stale error")));
  expect(getNotifications()).toEqual([]);
});

function nativePaste(clipboardData: Partial<DataTransfer>) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  container.querySelector("textarea")!.dispatchEvent(event);
  return event;
}

it("accepts native text paste exactly once and supersedes an outstanding clipboard read", async () => {
  const read = deferred<clipboard.TerminalClipboard>();
  vi.mocked(clipboard.readTerminalClipboard).mockReturnValueOnce(read.promise);
  await render();
  const textarea = container.querySelector("textarea")!;
  const browserPaste = vi.fn();
  textarea.addEventListener("paste", browserPaste);
  await pasteShortcut();
  const text = { types: ["text/plain"], getData: () => "native text" };
  let event!: Event;
  await act(async () => {
    event = nativePaste(text);
  });
  expect(event.defaultPrevented).toBe(true);
  await act(async () => read.resolve({ type: "text", text: "duplicate" }));
  expect(api.writeAgentTerminal).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "native text",
  );
  expect(browserPaste).not.toHaveBeenCalled();

  await render("exited");
  await act(async () => void nativePaste(text));
  await act(async () =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "v",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(api.writeAgentTerminal).toHaveBeenCalledOnce();
  expect(clipboard.readTerminalClipboard).toHaveBeenCalledOnce();
});

it("prioritizes native image files over text without another clipboard read", async () => {
  await render();
  const browserPaste = vi.fn();
  container.querySelector("textarea")!.addEventListener("paste", browserPaste);
  let event!: Event;
  await act(async () => {
    event = nativePaste({
      types: ["text/plain"],
      files: [{ type: "image/png" } as File] as unknown as FileList,
      getData: () => "ignored text",
    });
  });
  expect(event.defaultPrevented).toBe(true);
  expect(browserPaste).not.toHaveBeenCalled();
  expect(clipboard.readTerminalClipboard).not.toHaveBeenCalled();
  expect(clipboard.terminalClipboardImage).not.toHaveBeenCalled();
  expect(api.writeAgentTerminal).toHaveBeenCalledExactlyOnceWith("s1", "\x16");
});

async function paint(
  modes = 0,
  selection: AgentGridFrame["selection"] = null,
  selectCount = 0,
): Promise<api.AgentGridSubscription> {
  const frame: AgentGridFrame = {
    cols: 20,
    rows: 2,
    full: true,
    shift: 0,
    lines: [
      [0, [{ t: "hello", c: 5, fg: 256, bg: 257, f: 0 }], false],
      [1, [], false],
    ],
    cursor: { row: 1, col: 0, shape: "block" },
    displayOffset: 0,
    historySize: 40,
    selection,
    selectCount,
    modes,
    title: null,
    clipboard: null,
    state: "running",
    parsedBytes: 0,
    parseMicros: 0,
  };
  const { calls, results } = vi.mocked(api.subscribeAgentGrid).mock;
  const onFrame = calls[calls.length - 1][3];
  // The renderer applies on the next animation frame: run it now. The renderer stores the
  // returned id after the callback ran, so 0 keeps it free to schedule the next frame.
  vi.spyOn(window, "requestAnimationFrame").mockImplementationOnce(
    (callback) => {
      callback(0);
      return 0;
    },
  );
  await act(async () => void (await onFrame(frame)));
  return results[results.length - 1].value;
}

async function openMenu(options: { key?: string; shiftKey?: boolean } = {}) {
  const trigger = container.querySelector<HTMLElement>(
    ".agent-terminal-context",
  )!;
  const event = options.key
    ? new KeyboardEvent("keydown", {
        key: options.key,
        shiftKey: options.key === "F10",
        bubbles: true,
        cancelable: true,
      })
    : new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        shiftKey: options.shiftKey,
        clientX: 50,
        clientY: 40,
      });
  await act(async () => trigger.dispatchEvent(event));
  return document.querySelector<HTMLElement>('[role="menu"]');
}

function item(label: string) {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="menu"] [role="menuitem"]',
    ),
  ].find((node) => node.textContent === label)!;
}

async function choose(label: string) {
  await act(async () => item(label).click());
}

async function copyShortcut(target: Element) {
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "c",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

it("copies the engine selection, selects all from the menu or keyboard, and lets typing end the selection", async () => {
  vi.mocked(clipboard.writeClipboardText).mockResolvedValue();
  vi.mocked(clipboard.readTerminalClipboard).mockResolvedValue({
    type: "text",
    text: "pasted",
  });
  await render();
  const subscription = await paint();
  vi.mocked(subscription.text).mockResolvedValue("history\nhello");

  expect(await openMenu()).not.toBeNull();
  expect(item("Copy").getAttribute("aria-disabled")).toBe("true");
  await choose("Paste");
  expect(api.writeAgentTerminal).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "pasted",
  );
  await openMenu({ key: "F10" });
  await choose("Select all");
  expect(subscription.select).toHaveBeenLastCalledWith({ kind: "all" });
  // Ctrl+C copies before the selection frame lands, instead of interrupting.
  const textarea = container.querySelector("textarea")!;
  await copyShortcut(textarea);
  await vi.waitFor(() =>
    expect(clipboard.writeClipboardText).toHaveBeenLastCalledWith(
      "history\nhello",
    ),
  );
  await paint(0, { startRow: -40, startCol: 0, endRow: 1, endCol: 19 }, 1);
  expect(await openMenu({ key: "ContextMenu" })).not.toBeNull();
  expect(item("Copy").getAttribute("aria-disabled")).not.toBe("true");
  await choose("Copy");
  expect(clipboard.writeClipboardText).toHaveBeenCalledTimes(2);

  await copyShortcut(textarea);
  expect(clipboard.writeClipboardText).toHaveBeenCalledTimes(3);
  // Typing ends the selection, so Ctrl+C interrupts again, even before or despite a stale frame.
  textarea.value = "x";
  await act(async () => textarea.dispatchEvent(new Event("input")));
  expect(subscription.select).toHaveBeenLastCalledWith({ kind: "clear" });
  await paint(0, { startRow: -40, startCol: 0, endRow: 1, endCol: 19 }, 1);
  await copyShortcut(textarea);
  await vi.waitFor(() =>
    expect(api.writeAgentTerminal).toHaveBeenLastCalledWith("s1", "\x03"),
  );
  expect(clipboard.writeClipboardText).toHaveBeenCalledTimes(3);
  // A double-click selects a word at once, so Ctrl+C copies before its frame too.
  const writes = vi.mocked(api.writeAgentTerminal).mock.calls.length;
  const screen = container.querySelector(".agent-grid-screen")!;
  for (const type of ["mousedown", "mouseup"])
    await act(async () =>
      screen.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 2,
          clientX: 13,
          clientY: 5,
        }),
      ),
    );
  expect(subscription.select).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "start", mode: "word" }),
  );
  await copyShortcut(textarea);
  await vi.waitFor(() =>
    expect(clipboard.writeClipboardText).toHaveBeenCalledTimes(4),
  );
  expect(api.writeAgentTerminal).toHaveBeenCalledTimes(writes);
  await act(async () =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(subscription.select).toHaveBeenLastCalledWith({ kind: "all" });
});

it("selects by dragging and keeps scrolling while the pointer is held past an edge", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await render();
  const subscription = await paint();
  const screen = container.querySelector(".agent-grid-screen")!;
  const mouse = (type: string, target: EventTarget, clientY: number) =>
    act(
      async () =>
        void target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            detail: 1,
            clientX: 13,
            clientY,
          }),
        ),
    );
  await mouse("mousedown", screen, 5);
  await mouse("mousemove", document, 60);
  await act(async () => void vi.runOnlyPendingTimers());
  await mouse("mouseup", document, 60);
  await act(async () => void vi.runOnlyPendingTimers());
  const point = { row: 3, col: 1, right: true };
  expect(vi.mocked(subscription.select).mock.calls).toEqual([
    [{ kind: "start", row: 0, col: 1, right: true, mode: "simple" }],
    [{ kind: "extend", ...point }],
    [{ kind: "extend", ...point }],
  ]);
  vi.useRealTimers();
});

it("keeps each drag's selection requests in order and copies once they reach the engine", async () => {
  vi.mocked(clipboard.writeClipboardText).mockResolvedValue();
  await render();
  const subscription = await paint();
  vi.mocked(subscription.text).mockResolvedValue("hello");
  const sent = deferred<void>();
  vi.mocked(subscription.select).mockReturnValueOnce(sent.promise);
  const screen = container.querySelector(".agent-grid-screen")!;
  const mouse = (type: string, target: EventTarget, clientX: number) =>
    act(
      async () =>
        void target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            detail: 1,
            clientX,
            clientY: 5,
          }),
        ),
    );
  for (const [from, to] of [
    [3, 13],
    [23, 33],
  ]) {
    await mouse("mousedown", screen, from);
    await mouse("mousemove", document, to);
    await mouse("mouseup", document, to);
  }
  await copyShortcut(container.querySelector("textarea")!);
  expect(subscription.text).not.toHaveBeenCalled();
  await act(async () => sent.resolve());
  await vi.waitFor(() =>
    expect(clipboard.writeClipboardText).toHaveBeenCalledWith("hello"),
  );
  const select = vi.mocked(subscription.select).mock;
  expect(select.calls).toEqual([
    [{ kind: "start", row: 0, col: 0, right: false, mode: "simple" }],
    [{ kind: "extend", row: 0, col: 1, right: true }],
    [{ kind: "start", row: 0, col: 2, right: true, mode: "simple" }],
    [{ kind: "extend", row: 0, col: 4, right: false }],
  ]);
  expect(
    vi.mocked(subscription.text).mock.invocationCallOrder[0],
  ).toBeGreaterThan(select.invocationCallOrder[3]);
  expect(api.writeAgentTerminal).not.toHaveBeenCalled();
});

it("disables paste on a stopped agent and leaves right clicks to a mouse-reporting app unless Shift is held", async () => {
  await render("exited");
  await openMenu();
  expect(item("Paste").getAttribute("aria-disabled")).toBe("true");
  await act(async () =>
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );

  await render();
  await paint(4);
  expect(await openMenu()).toBeNull();
  expect(await openMenu({ shiftKey: true })).not.toBeNull();
  await act(async () =>
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(await openMenu({ key: "F10" })).not.toBeNull();
});

it("keeps a Shift-drag selection while an any-motion app receives hover reports", async () => {
  vi.mocked(clipboard.writeClipboardText).mockResolvedValue();
  await render();
  const subscription = await paint(GridMode.mouseMotion | GridMode.sgrMouse, {
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 4,
  });
  vi.mocked(subscription.text).mockResolvedValue("hello");
  await act(
    async () =>
      void container.querySelector(".agent-grid-screen")!.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 13,
          clientY: 5,
        }),
      ),
  );
  expect(api.writeAgentTerminal).toHaveBeenCalledExactlyOnceWith(
    "s1",
    expect.stringMatching(/^\x1b\[<35;/),
  );
  expect(subscription.select).not.toHaveBeenCalled();
  await copyShortcut(container.querySelector("textarea")!);
  await vi.waitFor(() =>
    expect(clipboard.writeClipboardText).toHaveBeenCalledWith("hello"),
  );
  expect(api.writeAgentTerminal).toHaveBeenCalledOnce();
});
