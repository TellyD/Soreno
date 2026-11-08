// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../data/agentConversationApi";
import { attachAgentFile } from "../../data/agentSessionsApi";
import { searchProjectFiles } from "../../data/projectFilesApi";
import type { AgentConversationRecord } from "../../domain/agentConversation";
import { agentConversationPrompt } from "../../domain/agentConversationAttachments";
import { readChatCommandCatalog } from "../../domain/agentConversationCommands";
import { deferred } from "../../testing/deferred";
import { setInputValue } from "../ui/testInput";
import { stubModalSelector } from "../ui/testTopLayer";
import { AgentConversation } from "./AgentConversation";
import { agentStringsForLocale } from "./agentStrings";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark" }),
}));
vi.mock("../../data/agentConversationApi", () => ({
  subscribeAgentConversation: vi.fn(),
  sendAgentConversationCommand: vi.fn(),
}));
vi.mock("../../data/projectFilesApi", () => ({ searchProjectFiles: vi.fn() }));
vi.mock("../../data/agentSessionsApi", () => ({ attachAgentFile: vi.fn() }));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({
    settings: {
      materialFileIconsEnabled: false,
      hiddenChatCommands: ["skill:release-notes"],
    },
  }),
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

it("stays starting until OMP answers once its plugins are loaded", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  const composer = container.querySelector("textarea")!;
  const status = () => container.querySelector('[role="status"]')?.textContent;
  expect(composer.disabled).toBe(true);
  expect(status()).toBe(s.starting);
  expect(container.textContent).not.toContain(s.emptyTitle);

  // A plugin notice arrives before OMP answers: still starting.
  await act(async () =>
    emit({
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "Ponytail loaded",
    }),
  );
  expect(composer.disabled).toBe(true);

  // An OMP older than 18.5 leaves `get_btw_history` unanswered.
  await act(async () => {
    for (const [, record] of vi.mocked(api.sendAgentConversationCommand).mock
      .calls)
      if (record.type !== "get_btw_history")
        emit({
          type: "response",
          id: record.id,
          command: record.type,
          success: true,
          data: {},
        });
  });
  expect(composer.disabled).toBe(false);
  expect(status()).toBeUndefined();
  expect(container.textContent).toContain(s.emptyTitle);
});

it("sends other files by path, showing each until done and dropping a cancelled one", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  const upload = deferred<string>();
  vi.mocked(attachAgentFile).mockReturnValueOnce(upload.promise);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  await act(async () => {
    for (const [, record] of vi.mocked(api.sendAgentConversationCommand).mock
      .calls)
      emit({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data: {},
      });
  });
  const composer = container.querySelector("textarea")!;
  const picker =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const video = new File([new Uint8Array(300 * 1024)], "screen.mov", {
    type: "video/quicktime",
  });
  const binary = new File([new Uint8Array(300 * 1024)], "notes.bin");
  const choose = async (files: File[]) => {
    Object.defineProperty(picker, "files", {
      value: files,
      configurable: true,
    });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  await choose([video, binary]);
  const status = (name: string) =>
    container.querySelector(`[aria-label="${s.attachmentSending(name)}"]`);
  expect(status("screen.mov")).not.toBeNull();
  expect(status("notes.bin")).not.toBeNull();

  // Both cancelled mid-transfer: nothing is attached, so the message can go at once.
  for (const name of ["screen.mov", "notes.bin"])
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          `[aria-label="${s.cancelAttachment(name)}"]`,
        )!
        .click(),
    );
  expect(status("notes.bin")).toBeNull();
  await act(async () => setInputValue(composer, "bonjour"));
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(
    vi
      .mocked(api.sendAgentConversationCommand)
      .mock.calls.some(([, record]) => record.type === "prompt"),
  ).toBe(true);

  // The cancelled path never reaches the draft, and the other file never goes.
  await act(async () => upload.resolve("'/tmp/a/screen.mov'"));
  expect(attachAgentFile).toHaveBeenCalledTimes(1);
  expect(composer.value).toBe("");
  expect(
    container.querySelectorAll(`[aria-label="${s.attachments}"] li`),
  ).toHaveLength(0);

  vi.mocked(attachAgentFile).mockResolvedValueOnce("'/tmp/a/report.pdf'");
  await choose([new File([new Uint8Array(300 * 1024)], "report.pdf")]);
  expect(composer.value).toBe("'/tmp/a/report.pdf' ");

  // Paths read on separate turns, focus elsewhere: both land at the caret, in order.
  await act(async () => setInputValue(composer, "avant après"));
  composer.setSelectionRange(6, 6);
  composer.blur();
  const first = deferred<string>();
  const second = deferred<string>();
  vi.mocked(attachAgentFile)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await choose([
    new File([new Uint8Array(300 * 1024)], "a.pdf"),
    new File([new Uint8Array(300 * 1024)], "b.pdf"),
  ]);
  await act(async () => first.resolve("'/tmp/a/a.pdf'"));
  await act(async () => second.resolve("'/tmp/a/b.pdf'"));
  expect(composer.value).toBe("avant '/tmp/a/a.pdf' '/tmp/a/b.pdf' après");

  // /goal takes no attachment: refused, nothing is lost.
  await act(async () => setInputValue(composer, "/goal "));
  const text = new File(["abc"], "notes.txt", { type: "text/plain" });
  // jsdom's File has no arrayBuffer().
  text.arrayBuffer = async () => new TextEncoder().encode("abc").buffer;
  await choose([text]);
  const sends = vi.mocked(api.sendAgentConversationCommand).mock.calls.length;
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(api.sendAgentConversationCommand).toHaveBeenCalledTimes(sends);
  expect(container.textContent).toContain(s.commandAttachments("/goal"));
  expect(composer.value).toBe("/goal ");
  expect(
    container.querySelectorAll(`[aria-label="${s.attachments}"] li`),
  ).toHaveLength(1);
});

it("completes @ mentions and / commands instead of sending", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  const files = {
    entries: [
      {
        name: "AgentForms.tsx",
        path: "src/Agent Forms.tsx",
        kind: "file" as const,
        editable: true,
      },
    ],
    truncated: false,
    recentCount: 0,
  };
  let refreshed = () => {};
  const refresh = new Promise<typeof files>((resolve) => {
    refreshed = () => resolve(files);
  });
  vi.mocked(searchProjectFiles).mockImplementation(async (_p, _q, isRefresh) =>
    isRefresh ? refresh : files,
  );
  const render = (visible: boolean) =>
    act(async () =>
      root.render(
        <AgentConversation
          sessionId="s1"
          projectId="p1"
          name="Chat"
          state="running"
          resumable={false}
          starting={false}
          visible={visible}
          runRevision={1}
          focusRequest={null}
          onStart={() => {}}
          onRestart={() => {}}
        />,
      ),
    );
  await render(true);
  await act(async () => {
    for (const [, record] of vi.mocked(api.sendAgentConversationCommand).mock
      .calls)
      emit({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data: {},
      });
  });
  const composer = container.querySelector("textarea")!;
  const type = (value: string, caret: number) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(composer, value);
      composer.setSelectionRange(caret, caret);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
  vi.useFakeTimers();
  await type("voir @agfo", 10);
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(searchProjectFiles).toHaveBeenCalledTimes(1);
  expect(searchProjectFiles).toHaveBeenLastCalledWith("p1", "", true);
  await act(async () => refreshed());
  expect(searchProjectFiles).toHaveBeenLastCalledWith("p1", "agfo", false, []);

  const sent = vi.mocked(api.sendAgentConversationCommand).mock.calls.length;
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(composer.value).toBe('voir @"src/Agent Forms.tsx" ');
  expect(composer.selectionStart).toBe(composer.value.length);
  expect(vi.mocked(api.sendAgentConversationCommand).mock.calls).toHaveLength(
    sent,
  );
  expect(container.querySelector('[role="listbox"]')).toBeNull();

  // A completion before a pasted delimiter must not reopen on the caret it sets.
  files.entries[0].path = "src/AgentForms.tsx";
  composer.focus();
  await type("(@agfo)", 6);
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(container.querySelector('[role="listbox"]')).not.toBeNull();
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(composer.value).toBe("(@src/AgentForms.tsx)");
  expect(composer.selectionStart).toBe(20);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    composer.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", bubbles: true }),
    );
  });
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(vi.mocked(api.sendAgentConversationCommand).mock.calls).toHaveLength(
    sent + 1,
  );

  // Retyping the completed text is new input: the mention opens again.
  await type("(@src/AgentForms.tsx)", 20);
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(container.querySelector('[role="listbox"]')).not.toBeNull();

  // Completing a path already written in full still moves the caret past it.
  await act(async () => {
    composer.setSelectionRange(10, 10);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await act(async () => vi.advanceTimersByTimeAsync(100));
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(composer.value).toBe("(@src/AgentForms.tsx)");
  expect(composer.selectionStart).toBe(20);
  await act(async () => composer.blur());

  // Escape before the results arrive closes the mention for good.
  await type("@agf", 4);
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(container.querySelector('[role="listbox"]')).toBeNull();

  // `/` in prose lists OMP's skills, except those hidden in settings; choosing one writes its token.
  // A hidden chat leaves the settings' catalog to the one on screen until it is shown again.
  await render(false);
  localStorage.clear();
  await act(async () =>
    emit({
      type: "available_commands_update",
      commands: [
        { name: "compact", source: "builtin" },
        { name: "skill:release-notes", source: "skill" },
        { name: "skill:soreno-release", source: "skill" },
      ],
    }),
  );
  expect(readChatCommandCatalog()).toEqual([]);
  await render(true);
  // Settings still list the hidden skill, so it can be shown again.
  expect(readChatCommandCatalog().map(({ name }) => name)).toContain(
    "skill:release-notes",
  );
  await type("Lance /rel", 10);
  expect(
    container.querySelector('[role="listbox"]')?.getAttribute("aria-label"),
  ).toBe(s.commands);
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(composer.value).toBe("Lance /skill:soreno-release ");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
});

it("completes @ mentions of a group overview from its members, under their folder", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  vi.mocked(searchProjectFiles).mockImplementation(async (projectId) => ({
    entries: [
      {
        name: "main.rs",
        path: `${projectId}/main.rs`,
        kind: "file" as const,
        editable: true,
      },
    ],
    truncated: false,
    recentCount: 0,
  }));
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="group-g1"
        mentionRoots={[
          { projectId: "p1", folder: "api" },
          { projectId: "p2", folder: "web" },
        ]}
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  await act(async () => {
    for (const [, record] of vi.mocked(api.sendAgentConversationCommand).mock
      .calls)
      emit({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data: {},
      });
  });
  const composer = container.querySelector("textarea")!;
  const type = (value: string) =>
    act(async () => setInputValue(composer, value));
  const options = () =>
    [...container.querySelectorAll('[role="option"]')].map((option) =>
      option.getAttribute("title"),
    );
  vi.useFakeTimers();
  await type("@main");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(options()).toEqual(["api/p1/main.rs", "web/p2/main.rs"]);

  // `@folder/…` narrows the search to that member.
  vi.mocked(searchProjectFiles).mockClear();
  await type("@web/mai");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(searchProjectFiles).not.toHaveBeenCalledWith(
    "p1",
    expect.anything(),
    false,
    expect.anything(),
  );
  expect(searchProjectFiles).toHaveBeenLastCalledWith("p2", "mai", false, []);
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(composer.value).toBe("@web/p2/main.rs ");

  // A member whose search fails does not hide the other members' results.
  vi.mocked(searchProjectFiles).mockImplementation(async (projectId) => {
    if (projectId === "p1") throw new Error("missing folder");
    return {
      entries: [
        {
          name: "main.rs",
          path: `${projectId}/main.rs`,
          kind: "file" as const,
          editable: true,
        },
      ],
      truncated: false,
      recentCount: 0,
    };
  });
  await type("@mai");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(options()).toEqual(["web/p2/main.rs"]);
});

it("shows OMP's goal beside the context while it runs", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  const indicator = s.goalIndicator(s.goalStatuses.active);
  const goal = { objective: "Fais un schéma", status: "active" };
  await act(async () => emit({ type: "goal_updated", goal }));
  expect(
    container.querySelector(`[title="${goal.objective}"]`)?.textContent,
  ).toBe(indicator);
  await act(async () =>
    emit({ type: "goal_updated", goal: { ...goal, status: "dropped" } }),
  );
  expect(container.textContent).not.toContain(indicator);
});

it("asks a side question during a turn, streams it apart, stops it and follows it up", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  const sent = () =>
    vi
      .mocked(api.sendAgentConversationCommand)
      .mock.calls.map(([, record]) => record);
  await act(async () => {
    for (const record of sent())
      emit({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data: {},
      });
    emit({ type: "agent_start" });
  });
  const composer = container.querySelector("textarea")!;
  await act(async () => setInputValue(composer, "/btw Pourquoi ?"));
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(sent().pop()).toMatchObject({ type: "btw", question: "Pourquoi ?" });
  const record = {
    id: "b1",
    question: "Pourquoi ?",
    answer: "",
    status: "running",
    createdAt: 1,
  };
  await act(async () => {
    emit({ type: "btw_record", record });
    emit({ type: "btw_delta", recordId: "b1", delta: "Parce que." });
  });
  const panel = container.querySelector(
    `[role="region"][aria-label="${s.btw}"]`,
  )!;
  expect(panel.textContent).toContain("Parce que.");
  expect(
    container.querySelector(".agent-conversation-history")!.textContent,
  ).not.toContain("Parce que.");

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`[aria-label="${s.btwStop}"]`)!
      .click(),
  );
  expect(sent().pop()).toMatchObject({ type: "btw_cancel", recordId: "b1" });
  await act(async () =>
    emit({
      type: "btw_record",
      record: { ...record, answer: "Parce que.", status: "cancelled" },
    }),
  );
  const followUp = container.querySelector<HTMLInputElement>(
    `input[aria-label="${s.btwFollowUp}"]`,
  )!;
  await act(async () => setInputValue(followUp, "Et ensuite ?"));
  await act(async () => followUp.form!.requestSubmit());
  expect(sent().pop()).toMatchObject({
    type: "btw",
    question: "Et ensuite ?",
    recordId: "b1",
  });

  // A new conversation brings back its own side questions, listed from the panel.
  vi.stubGlobal("PointerEvent", MouseEvent);
  stubModalSelector();
  await act(async () => emit({ type: "session_settled" }));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`[aria-label="${s.moreActions}"]`)!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === s.newConversation)!
      .click(),
  );
  const switched = sent().pop()!;
  expect(switched).toMatchObject({ type: "new_session" });
  const before = sent().length;
  await act(async () =>
    emit({
      type: "response",
      id: switched.id,
      command: "new_session",
      success: true,
      data: { cancelled: false },
    }),
  );
  const reload = sent().slice(before);
  expect(reload.map(({ type }) => type)).toContain("get_btw_history");
  await act(async () => {
    for (const { id, type } of reload)
      emit({
        type: "response",
        id,
        command: type,
        success: true,
        data:
          type === "get_btw_history"
            ? { records: [{ ...record, id: "b0", question: "Avant ?" }] }
            : {},
      });
  });
  await act(async () => setInputValue(composer, "/btw Encore ?"));
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  await act(async () =>
    emit({
      type: "btw_record",
      record: { ...record, id: "b2", question: "Encore ?", createdAt: 2 },
    }),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`[aria-label="${s.btwOpenHistory}"]`)!
      .click(),
  );
  const topics = [
    ...container.querySelectorAll(".agent-conversation-btw-topics button"),
  ].map((topic) => topic.querySelector("span")!.textContent);
  expect(topics).toEqual(expect.arrayContaining(["Avant ?", "Encore ?"]));
  expect(topics).not.toContain("Pourquoi ?");
});

it("answers an ask round in the dock", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  const sent = () =>
    vi
      .mocked(api.sendAgentConversationCommand)
      .mock.calls.map(([, record]) => record);
  const acknowledge = () =>
    act(async () => {
      for (const record of sent())
        emit({
          type: "response",
          id: record.id,
          command: record.type,
          success: true,
          data: {},
        });
    });
  await acknowledge();
  // In a round, picking an option only selects it; a cleared question leaves blank without losing the others.
  const question = {
    id: "db",
    question: "Base de données ?",
    options: [
      {
        label: "SQLite",
        description: "Fichier **portable**, voir [la doc](https://sqlite.org)",
      },
      { label: "Postgres" },
    ],
    recommended: 0,
  };
  const sync = {
    id: "sync",
    question: "Sync ?",
    options: [{ label: "Non" }, { label: "Oui" }],
    recommended: 1,
  };
  await act(async () =>
    emit({
      type: "extension_ui_request",
      id: "ui-round",
      method: "ask",
      questions: [question, sync],
    }),
  );
  const dock = container.querySelector(".agent-conversation-dock")!;
  const sqlite = [...dock.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("SQLite"),
  )!;
  expect(sqlite.textContent).toContain("Fichier portable, voir la doc");
  expect(sqlite.querySelector("a")).toBeNull();
  const before = sent().length;
  await act(async () =>
    [...dock.querySelectorAll("button")]
      .find((button) => button.textContent?.startsWith("Oui"))!
      .click(),
  );
  expect(sent()).toHaveLength(before);
  await act(async () =>
    [...dock.querySelectorAll("button")]
      .find((button) => button.textContent === s.askSubmit)!
      .click(),
  );
  expect(sent().pop()).toEqual({
    type: "extension_ui_response",
    id: "ui-round",
    answers: [
      { id: "db", selectedOptions: ["SQLite"] },
      { id: "sync", selectedOptions: [] },
    ],
  });
});

it("recalls sent messages with ↑ and ↓ from the edge lines, then the draft", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  await act(async () => {
    for (const [, record] of vi.mocked(api.sendAgentConversationCommand).mock
      .calls)
      emit({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data: {},
      });
    for (const content of ["Un", "Deux"])
      emit({ type: "message_start", message: { role: "user", content } });
  });
  const composer = container.querySelector("textarea")!;
  const press = (key: string) =>
    act(async () =>
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      ),
    );
  await act(async () => setInputValue(composer, "brouillon\nfin"));

  composer.setSelectionRange(12, 12);
  await press("ArrowUp");
  expect(composer.value).toBe("brouillon\nfin");

  composer.setSelectionRange(3, 3);
  await press("ArrowUp");
  expect(composer.value).toBe("Deux");
  await press("ArrowUp");
  expect(composer.value).toBe("Un");
  await press("ArrowDown");
  expect(composer.value).toBe("Deux");
  await press("ArrowDown");
  expect(composer.value).toBe("brouillon\nfin");
});

it("stays at the bottom when content grows before a late scroll event, not after scrolling up", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  const history = container.querySelector<HTMLElement>(
    ".agent-conversation-history",
  )!;
  let scrollHeight = 1000;
  let scrollTop = 0;
  Object.defineProperties(history, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(value, scrollHeight - 100);
      },
    },
  });
  const scroll = (top: number) =>
    act(async () => {
      scrollTop = top;
      history.dispatchEvent(new Event("scroll"));
    });
  await scroll(900);
  // An image decoded after the programmatic scroll, before its event fired.
  scrollHeight = 1200;
  await scroll(900);
  await act(async () =>
    emit({ type: "message_start", message: { role: "user", content: "Un" } }),
  );
  expect(scrollTop).toBe(1100);

  await scroll(600);
  scrollHeight = 1400;
  await act(async () =>
    emit({ type: "message_start", message: { role: "user", content: "Deux" } }),
  );
  expect(scrollTop).toBe(600);
});

it("cancels a queued message and brings the others back into the composer on stop", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  const sent = () =>
    vi.mocked(api.sendAgentConversationCommand).mock.calls.map(([, r]) => r);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  await act(async () => {
    for (const record of sent())
      emit({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data:
          record.type === "get_state"
            ? {
                isStreaming: true,
                model: { provider: "p", id: "m", input: ["text", "image"] },
              }
            : {},
      });
  });
  const withFile = agentConversationPrompt(
    "Relis",
    Array.from({ length: 9 }, (_, n) => ({
      name: `notes${n}.txt`,
      content: "abc",
    })),
  );
  await act(async () =>
    emit({
      type: "queue_update",
      steering: ["déjà transmis", withFile],
      followUp: ["plus tard"],
      liveSteered: 1,
    }),
  );
  const queue = container.querySelector(`[aria-label="${s.queued}"]`)!;
  const removals = queue.querySelectorAll("button");
  // OMP can no longer take back the message already steered into the reply.
  expect(removals).toHaveLength(2);
  await act(async () => removals[1].click());
  expect(sent()).toContainEqual({
    type: "remove_queued_message",
    message: "plus tard",
    queue: "followUp",
  });

  const composer = container.querySelector("textarea")!;
  await act(async () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  const abort = sent().find(({ type }) => type === "abort_and_restore_queue")!;
  await act(async () =>
    emit({
      type: "response",
      id: abort.id,
      command: abort.type,
      success: true,
      data: {
        steering: [{ text: withFile }],
        followUp: [
          {
            text: "[Image]",
            images: Array.from({ length: 9 }, () => ({
              type: "image",
              data: "AAAA",
              mimeType: "image/png",
            })),
          },
        ],
        imagesDropped: true,
      },
    }),
  );
  expect(composer.value).toBe("Relis");
  // Beyond the 16 a composer accepts: they are out of OMP's queue already.
  expect(
    container.querySelectorAll(`[aria-label="${s.attachments}"] li`),
  ).toHaveLength(18);
  expect(container.textContent).toContain(s.restoreIncomplete);
  expect(sent().some(({ type }) => type === "abort")).toBe(false);
});

it("falls back to a plain abort when OMP cannot restore its queue", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  const sent = () =>
    vi.mocked(api.sendAgentConversationCommand).mock.calls.map(([, r]) => r);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  await act(async () => {
    for (const record of sent())
      emit({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data: record.type === "get_state" ? { isStreaming: true } : {},
      });
  });
  await act(async () =>
    container
      .querySelector("textarea")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  const abort = sent().find(({ type }) => type === "abort_and_restore_queue")!;
  const error = "Unknown command: abort_and_restore_queue";
  await act(async () =>
    emit({
      // OMP before 18.5 answers an unknown command without its id.
      type: "response",
      command: abort.type,
      success: false,
      error,
    }),
  );
  expect(sent().some(({ type }) => type === "abort")).toBe(true);
  expect(container.textContent).not.toContain(error);
});

it("stops the background jobs once only they keep OMP busy", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  const sent = () =>
    vi.mocked(api.sendAgentConversationCommand).mock.calls.map(([, r]) => r);
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="running"
        resumable={false}
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  await act(async () => {
    for (const record of sent())
      emit({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data:
          record.type === "get_state"
            ? {
                isSettled: false,
                isStreaming: false,
                hasPendingAsyncWork: true,
              }
            : {},
      });
  });
  expect(container.textContent).toContain(s.background);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${s.stopBackground}"]`,
      )!
      .click(),
  );
  expect(sent()).toContainEqual(
    expect.objectContaining({ type: "prompt", message: "/jobs kill all" }),
  );
  expect(
    sent().some(
      ({ type }) => type === "abort" || type === "abort_and_restore_queue",
    ),
  ).toBe(false);
});

it("hides tools and reasoning in every open conversation and remembers it", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  stubModalSelector();
  const emits = new Map<string, (record: AgentConversationRecord) => void>();
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (sessionId, onRecord) => {
      emits.set(sessionId, onRecord);
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  const conversation = (sessionId: string) => (
    <AgentConversation
      sessionId={sessionId}
      projectId="p1"
      name={sessionId}
      state="running"
      resumable={false}
      starting={false}
      visible
      runRevision={1}
      focusRequest={null}
      onStart={() => {}}
      onRestart={() => {}}
    />
  );
  await act(async () =>
    root.render(
      <>
        {conversation("s1")}
        {conversation("s2")}
      </>,
    ),
  );
  await act(async () => {
    for (const [sessionId, record] of [
      ...vi.mocked(api.sendAgentConversationCommand).mock.calls,
    ])
      emits.get(sessionId)!({
        type: "response",
        id: record.id,
        command: record.type,
        success: true,
        data: {},
      });
    for (const emit of emits.values())
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Je réfléchis" },
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "npm test" },
            },
            { type: "text", text: "Tests verts." },
          ],
        },
      });
  });
  const panes = [...container.querySelectorAll("section")];
  expect(panes).toHaveLength(2);
  for (const pane of panes) {
    expect(pane.textContent).toContain("npm test");
    expect(pane.textContent).toContain(s.reasoning);
  }

  const toggle = panes[0].querySelector<HTMLButtonElement>(
    `[aria-label="${s.hideTools}"]`,
  )!;
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await act(async () => toggle.click());

  for (const pane of panes) {
    expect(pane.textContent).not.toContain("npm test");
    expect(pane.textContent).not.toContain(s.reasoning);
    expect(pane.textContent).toContain("Tests verts.");
  }
  expect(localStorage.getItem("soreno.agents.hide-tools.v1")).toBe("true");

  // A hidden running tool must not hide that OMP is still working.
  await act(async () => {
    const emit = emits.get("s1")!;
    emit({ type: "agent_start" });
    emit({
      type: "message_start",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-2",
            name: "bash",
            arguments: { command: "npm run build" },
          },
        ],
      },
    });
    emit({ type: "tool_execution_start", toolCallId: "call-2" });
  });
  expect(panes[0].textContent).not.toContain("npm run build");
  expect(panes[0].querySelector('[role="status"]')?.textContent).toContain(
    s.working,
  );

  // Text already streamed must not hide that a hidden tool call is being prepared.
  await act(async () => {
    const emit = emits.get("s2")!;
    const update = (event: Record<string, unknown>) =>
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: event,
      } as AgentConversationRecord);
    emit({ type: "agent_start" });
    emit({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    update({ type: "text_start", contentIndex: 0 });
    update({ type: "text_delta", contentIndex: 0, delta: "Je lance." });
    update({ type: "toolcall_start", contentIndex: 1 });
  });
  expect(panes[1].textContent).toContain("Je lance.");
  expect(panes[1].querySelector('[role="status"]')?.textContent).toContain(
    s.working,
  );

  await act(async () => toggle.click());
  expect(panes[1].textContent).toContain("npm test");
  expect(localStorage.getItem("soreno.agents.hide-tools.v1")).toBe("false");
});

it("reports a dropped SSH connection as such, not as an OMP crash", async () => {
  let emit = (_record: AgentConversationRecord) => {};
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      emit = onRecord;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockResolvedValue(undefined);
  const props = {
    sessionId: "s1",
    projectId: "p1",
    name: "Chat",
    state: "exited",
    resumable: true,
    starting: false,
    visible: true,
    runRevision: 1,
    focusRequest: null,
    onStart: () => {},
    onRestart: () => {},
  } as const;
  await act(async () => root.render(<AgentConversation {...props} remote />));
  const stderr = "client_loop: send disconnect: Connection reset";
  await act(async () => emit({ type: "soreno_exited", exitCode: 255, stderr }));
  expect(container.textContent).toContain(s.connectionLost);
  expect(container.textContent).not.toContain(stderr);

  // A local OMP exiting 255 did crash.
  await act(async () =>
    root.render(<AgentConversation {...props} remote={false} />),
  );
  expect(container.textContent).toContain(s.crashed(255));
  expect(container.textContent).toContain(stderr);
});

it("asks nothing of a run that exited before the view subscribed", async () => {
  vi.mocked(api.subscribeAgentConversation).mockImplementation(
    async (_sessionId, onRecord) => {
      onRecord({ type: "soreno_exited", exitCode: 0 });
      return () => {};
    },
  );
  vi.mocked(api.sendAgentConversationCommand).mockRejectedValue(
    new Error("Conversation OMP arrêtée."),
  );
  await act(async () =>
    root.render(
      <AgentConversation
        sessionId="s1"
        projectId="p1"
        name="Chat"
        state="exited"
        resumable
        starting={false}
        visible
        runRevision={1}
        focusRequest={null}
        onStart={() => {}}
        onRestart={() => {}}
      />,
    ),
  );
  expect(api.sendAgentConversationCommand).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Conversation OMP arrêtée.");
});
