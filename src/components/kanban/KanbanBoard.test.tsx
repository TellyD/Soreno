// @vitest-environment jsdom
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import * as api from "../../data/kanbanApi";
import type {
  AgentProject,
  AgentSession,
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionKanbanIssue,
  AgentProjectLinearLink,
} from "../../domain/agentSessions";
import type {
  KanbanBoard as KanbanBoardData,
  KanbanComment,
  KanbanIssue,
  KanbanIssueCompletion,
  KanbanIssueDescriptionUpdate,
  KanbanIssueDetail,
  KanbanLabel,
  KanbanIssueSelection,
  KanbanIssueRequestEvent,
  KanbanIssueUpdate,
  LinearKanbanBoard,
} from "../../domain/kanban";
import type { KanbanIssueAgentRequest } from "../../domain/kanbanAgent";
import { I18nProvider } from "../../i18n";
import { notifyError } from "../../notifications";
import { deferred } from "../../testing/deferred";
import * as agentApi from "../../data/agentSessionsApi";
import { KanbanControllerProvider } from "../../hooks/useKanbanController";
import { KanbanBoard } from "./KanbanBoard";
import { KanbanIssuePanel } from "./KanbanIssuePanel";
import { stubEditorGeometry } from "../markdown-editor/testGeometry";
import { stubModalSelector } from "../ui/testTopLayer";
import { setInputValue } from "../ui/testInput";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../notifications", () => ({ notifyError: vi.fn() }));
vi.mock("../../data/kanbanApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  loadKanbanBoard: vi.fn(),
  loadLinearKanbanBoard: vi.fn(),
  hasLinearApiKey: vi.fn(),
  setLinearApiKey: vi.fn(),
  clearLinearApiKey: vi.fn(),
  createKanbanComment: vi.fn(),
  deleteKanbanComment: vi.fn(),
  createKanbanIssue: vi.fn(),
  createKanbanLabel: vi.fn(),
  deleteKanbanIssue: vi.fn(),
  transferKanbanIssueToLinear: vi.fn(),
  loadKanbanIssue: vi.fn(),
  listenKanbanIssueRequests: vi.fn(),
  openKanbanImage: vi.fn(),
  updateKanbanIssue: vi.fn(),
  updateKanbanIssueDescription: vi.fn(),
  uploadKanbanImage: vi.fn(),
}));
vi.mock("../../data/agentSessionsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof agentApi>()),
  completeAgentKanbanIssue: vi.fn(),
  sendAgentSessionMessage: vi.fn(),
  listAgentSessionMessages: vi.fn(async () => []),
  listenAgentSessionMessages: vi.fn(async () => () => {}),
}));
vi.mock("../../settings", () => ({
  useAppSettings: () => ({
    settings: { languagePreference: "en", hiddenAgentPresets: [] },
    updateSettings: vi.fn(),
  }),
}));
vi.mock("../../theme", () => ({ useTheme: () => ({ theme: "light" }) }));

const board: KanbanBoardData = {
  source: "local",
  team: { id: "t1", key: "ACM", name: "Acme" },
  states: [
    { id: "todo", name: "Todo", type: "unstarted", color: "#888", position: 0 },
    {
      id: "doing",
      name: "In Progress",
      type: "started",
      color: "#888",
      position: 1,
    },
    { id: "done", name: "Done", type: "completed", color: "#888", position: 2 },
  ],
  labels: [
    { id: "l1", name: "Bug", color: "#e5484d" },
    { id: "l2", name: "Feature", color: "#30a46c" },
  ],
  issues: [
    {
      source: "local",
      id: "i1",
      identifier: "ACM-1",
      title: "Ship the detail view",
      priority: 0,
      stateId: "todo",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      project: null,
      labels: [],
      pullRequests: [],
    },
  ],
};

function issueUpdate(fields: Partial<KanbanIssueUpdate>): KanbanIssueUpdate {
  return {
    id: "i1",
    title: "Ship the detail view",
    stateId: "todo",
    priority: 0,
    project: null,
    labels: [],
    updatedAt: "2026-09-27T10:00:00.000Z",
    ...fields,
  };
}

const sorenoProjects: AgentProject[] = [
  {
    id: "sp1",
    name: "Soreno app",
    path: "/work/soreno",
    environment: { kind: "local", distribution: null },
  },
  {
    id: "sp2",
    name: "Website",
    path: "/work/website",
    environment: { kind: "local", distribution: null },
  },
];

type BoardProps = {
  issueRequest?: { issue: KanbanIssueSelection };
  issueSessions?: AgentSessionKanbanIssue[];
  kanbanProjects?: AgentProject[];
  linearProjectLinks?: AgentProjectLinearLink[];
  onOpenSession?: (sessionId: string) => void;
  onStartIssueAgent?: (request: KanbanIssueAgentRequest) => Promise<void>;
  overviewProjectIds?: ReadonlySet<string>;
  projects?: AgentProject[];
  sessions?: AgentSession[];
  statuses?: AgentSessionStatus[];
  closedSessionIds?: ReadonlySet<string>;
  // An agents' side panel for session panelSessionId (default s1) of project sp1; null while the session has no issue.
  panelIssue?: KanbanIssueSelection | null;
  panelSessionId?: string;
  onLinkSessionIssue?: (
    sessionId: string,
    issue: KanbanIssueSelection,
  ) => Promise<void>;
  onUnlinkSessionIssue?: (sessionId: string) => Promise<void>;
  // Set by the workspace's panel shortcut.
  panelHidden?: boolean;
};

const linkedSession: AgentSession = {
  id: "s1",
  projectId: "sp1",
  name: "ACM-1 · Codex",
  executable: "codex",
  args: [],
  createdAt: "2026-09-27T10:00:00.000Z",
};

function issueLink(
  overrides: Partial<AgentSessionKanbanIssue> = {},
): AgentSessionKanbanIssue {
  return {
    sessionId: "s1",
    issueId: "i1",
    issueIdentifier: "ACM-1",
    sessionName: "ACM-1 · Codex",
    executable: "codex",
    projectName: "Website",
    startedAt: "2026-09-27T10:00:00.000Z",
    endedAt: null,
    endReason: null,
    mergedInto: null,
    source: "local",
    ...overrides,
  };
}

async function renderBoard(props: BoardProps = {}) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <KanbanControllerProvider
          enabled
          issueSessions={props.issueSessions ?? []}
          kanbanProjects={props.kanbanProjects ?? []}
          linearProjectLinks={props.linearProjectLinks ?? []}
          onOpenProject={vi.fn()}
          onOpenSession={props.onOpenSession ?? vi.fn()}
          onStartIssueAgent={props.onStartIssueAgent ?? vi.fn()}
          onLinkSessionIssue={props.onLinkSessionIssue ?? vi.fn()}
          onUnlinkSessionIssue={props.onUnlinkSessionIssue ?? vi.fn()}
          overviewProjectIds={props.overviewProjectIds ?? new Set()}
          projects={props.projects ?? []}
          sessions={props.sessions ?? []}
          statuses={props.statuses ?? []}
          closedSessionIds={props.closedSessionIds ?? new Set()}
          terminalTitles={{}}
          visible
        >
          <KanbanBoard
            issueRequest={props.issueRequest}
            panel={{
              container: panelHost,
              visible: true,
              hidden: props.panelHidden ?? false,
              onShow: vi.fn(),
              expanded: false,
              onExpandedChange: vi.fn(),
            }}
          />
          {props.panelIssue !== undefined ? (
            <aside data-testid="issue-panel">
              <KanbanIssuePanel
                expanded={false}
                onClose={vi.fn()}
                onDeleted={vi.fn()}
                onExpandedChange={vi.fn()}
                onOpenInKanban={vi.fn()}
                projectId="sp1"
                selection={props.panelIssue}
                sessionId={props.panelSessionId ?? "s1"}
              />
            </aside>
          ) : null}
        </KanbanControllerProvider>
      </I18nProvider>,
    ),
  );
}

// Remounts so the board loads again with the currently mocked data.
async function remountBoard(props: BoardProps) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await renderBoard(props);
}

let root: Root;
let container: HTMLDivElement;
// The workspace's right panel, where the board opens its issues.
let panelHost: HTMLDivElement;
let restoreEditorGeometry: () => void;
let issueRequestListeners: ((event: KanbanIssueRequestEvent) => void)[];
// Backend copy of the shown issue: comments and descriptions saved meanwhile persist into it.
let storedIssue: KanbanIssueDetail;

function storeComment(comment: KanbanComment) {
  const known = storedIssue.comments.some(({ id }) => id === comment.id);
  storedIssue = {
    ...storedIssue,
    comments: known
      ? storedIssue.comments.map((stored) =>
          stored.id === comment.id ? comment : stored,
        )
      : [...storedIssue.comments, comment],
  };
  return comment;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("PointerEvent", MouseEvent);
  stubModalSelector();
  restoreEditorGeometry = stubEditorGeometry();
  Object.assign(HTMLElement.prototype, {
    hasPointerCapture: () => false,
    releasePointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
  });
  issueRequestListeners = [];
  vi.mocked(api.listenKanbanIssueRequests).mockImplementation(
    async (listener) => {
      issueRequestListeners.push(listener);
      return () => {};
    },
  );
  vi.mocked(api.loadKanbanBoard).mockResolvedValue(structuredClone(board));
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(false);
  storedIssue = {
    ...structuredClone(board.issues[0]),
    description: "Rendered **markdown**",
    branchName: "acm-1-ship-the-detail-view",
    labels: [],
    children: [],
    comments: [
      {
        id: "c1",
        body: "Looks good",
        createdAt: "2026-08-02T10:00:00.000Z",
      },
    ],
  };
  vi.mocked(api.loadKanbanIssue).mockImplementation(async () =>
    structuredClone(storedIssue),
  );
  container = document.createElement("div");
  panelHost = document.createElement("div");
  document.body.append(container, panelHost);
  root = createRoot(container);
  await renderBoard();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  panelHost.remove();
  restoreEditorGeometry();
  vi.useRealTimers();
  localStorage.clear();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function detailView() {
  return panelHost.querySelector<HTMLElement>(".kanban-issue-view");
}

function cardButton() {
  return container.querySelector<HTMLButtonElement>(
    '[data-kanban-issue="i1"]',
  )!;
}

async function tapCard() {
  const title = cardButton().querySelector(".kanban-card-title")!;
  await act(async () => {
    title.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    title.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  });
}

it("reloads the board when an agent session created an issue", async () => {
  expect(api.loadKanbanBoard).toHaveBeenCalledTimes(1);
  const request = {
    sessionId: "s1",
    sessionName: "ACM-1 · Codex",
    title: "Agent issue",
    updated: false,
  };
  await act(async () =>
    issueRequestListeners.forEach((listener) =>
      listener({ ...request, issue: null, error: "Titre vide." }),
    ),
  );
  expect(api.loadKanbanBoard).toHaveBeenCalledTimes(1);

  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [
      ...structuredClone(board.issues),
      {
        ...structuredClone(board.issues[0]),
        id: "i2",
        identifier: "ACM-2",
        title: "Agent issue",
      },
    ],
  });
  await act(async () =>
    issueRequestListeners.forEach((listener) =>
      listener({
        ...request,
        issue: { id: "i2", identifier: "ACM-2", source: "local" },
        error: null,
      }),
    ),
  );
  expect(api.loadKanbanBoard).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-kanban-issue="i2"]')).not.toBeNull();
  expect(notifyError).not.toHaveBeenCalled();
});

it("reloads the shown issue once its agent session edited it", async () => {
  await tapCard();
  vi.mocked(api.loadKanbanIssue).mockClear();
  await act(async () =>
    issueRequestListeners.forEach((listener) =>
      listener({
        sessionId: "s1",
        sessionName: "ACM-1 · Codex",
        title: "Renamed",
        updated: true,
        issue: { id: "i1", identifier: "ACM-1", source: "local" },
        error: null,
      }),
    ),
  );
  expect(api.loadKanbanIssue).toHaveBeenCalledWith("local", "i1");
  expect(api.loadKanbanBoard).toHaveBeenCalledTimes(2);
});

it("opens a tapped card in the side panel beside the board, then closes it", async () => {
  await tapCard();

  expect(api.loadKanbanIssue).toHaveBeenCalledWith("local", "i1");
  expect(openUrl).not.toHaveBeenCalled();
  const view = detailView()!;
  expect(view.querySelector("h1")?.textContent).toBe("Ship the detail view");
  expect(descriptionEditor().state.sliceDoc()).toBe("Rendered **markdown**");
  expect(
    container.querySelector(".kanban-board-pane")?.hasAttribute("inert"),
  ).toBe(false);

  // Hiding the panel keeps the issue and gives the focus back to its card.
  await renderBoard({ panelHidden: true });
  expect(detailView()!.closest("[hidden]")).not.toBeNull();
  expect(document.activeElement).toBe(cardButton());
  await renderBoard();

  await act(async () =>
    view
      .querySelector<HTMLButtonElement>('[aria-label="Close issue"]')!
      .click(),
  );
  expect(detailView()).toBeNull();
  expect(document.activeElement).toBe(cardButton());
});

it("opens the issue of each new request once, then lets it close", async () => {
  const issueRequest = {
    issue: { id: "i1", identifier: "ACM-1", source: "local" as const },
  };
  await renderBoard({ issueRequest });

  expect(api.loadKanbanIssue).toHaveBeenCalledWith("local", "i1");
  expect(detailView()?.querySelector("h1")?.textContent).toBe(
    "Ship the detail view",
  );
  await act(async () =>
    detailView()!
      .querySelector<HTMLButtonElement>('[aria-label="Close issue"]')!
      .click(),
  );
  expect(detailView()).toBeNull();

  await renderBoard({ issueRequest });
  expect(detailView()).toBeNull();

  await renderBoard({ issueRequest: { ...issueRequest } });
  expect(detailView()).not.toBeNull();
});

it("closes the create dialog for a requested issue and focuses its detail", async () => {
  await openColumnDialog("Todo");

  await renderBoard({
    issueRequest: { issue: { id: "i1", identifier: "ACM-1", source: "local" } },
  });

  expect(createDialog()).toBeNull();
  expect(detailView()?.contains(document.activeElement)).toBe(true);
});

it("keeps a pending creation open over a requested issue, then focuses the issue", async () => {
  const creation = deferred<KanbanIssue>();
  vi.mocked(api.createKanbanIssue).mockReturnValue(creation.promise);
  await openColumnDialog("Todo");
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));
  await pressKey(dialogTitle(), "Enter", { ctrlKey: true });

  await renderBoard({
    issueRequest: { issue: { id: "i1", identifier: "ACM-1", source: "local" } },
  });
  expect(createDialog()).not.toBeNull();

  await act(async () => creation.resolve(createdIssue));
  expect(createDialog()).toBeNull();
  expect(detailView()?.contains(document.activeElement)).toBe(true);
});

it("opens the detail from the keyboard and closes it on Escape", async () => {
  await act(async () => cardButton().click());
  expect(detailView()).not.toBeNull();

  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
  });
  expect(detailView()).toBeNull();
});

it("moves the board issue when its state changes in the detail", async () => {
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ stateId: "done" }),
  );
  await tapCard();

  const stateSelect = detailView()!.querySelector<HTMLButtonElement>(
    '[role="combobox"][aria-label="Status"]',
  )!;
  expect(stateSelect.textContent).toBe("Todo");
  await act(async () => stateSelect.click());
  const done = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === "Done")!;
  await act(async () => {
    done.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    done.click();
  });

  expect(api.updateKanbanIssue).toHaveBeenCalledWith("local", "i1", {
    stateId: "done",
  });
  expect(stateSelect.textContent).toBe("Done");
  expect(
    container
      .querySelector('[data-kanban-state="done"]')
      ?.contains(cardButton()),
  ).toBe(true);
});

it("shows in the open board detail and on its card what the issue panel edits", async () => {
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ stateId: "done" }),
  );
  vi.mocked(api.createKanbanComment).mockImplementation(async (_, __, body) =>
    storeComment({ id: "c2", body, createdAt: "2026-09-27T10:00:00.000Z" }),
  );
  await renderBoard({
    panelIssue: { id: "i1", identifier: "ACM-1", source: "local" },
  });
  await tapCard();
  const panel = container.querySelector('[data-testid="issue-panel"]')!;

  await chooseOption(
    panel.querySelector<HTMLElement>('[role="combobox"][aria-label="Status"]')!,
    "Done",
  );
  expect(detailStateSelect().textContent).toBe("Done");
  expect(
    container
      .querySelector('[data-kanban-state="done"]')
      ?.contains(cardButton()),
  ).toBe(true);

  const panelComment = panel.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Add a comment"]',
  )!;
  await act(async () => setInputValue(panelComment, "Sent from the panel"));
  await pressKey(panelComment, "Enter", { ctrlKey: true });
  await vi.waitFor(() =>
    expect(detailView()!.textContent).toContain("Sent from the panel"),
  );
});

function detailStateSelect() {
  return detailView()!.querySelector<HTMLButtonElement>(
    '[role="combobox"][aria-label="Status"]',
  )!;
}

async function pressEscape(target: Element) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
  });
}

it("returns to the board on Escape from a closed select but not while its popup is open", async () => {
  await tapCard();
  const stateSelect = detailStateSelect();

  await act(async () => stateSelect.click());
  expect(stateSelect.getAttribute("aria-expanded")).toBe("true");
  await pressEscape(document.activeElement ?? stateSelect);
  expect(detailView()).not.toBeNull();
  expect(stateSelect.getAttribute("aria-expanded")).not.toBe("true");

  stateSelect.focus();
  await pressEscape(stateSelect);
  expect(detailView()).toBeNull();
});

it("focuses the selected tab when the issue left the board while the detail was open", async () => {
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ stateId: "done" }),
  );
  const activeTab = [
    ...container.querySelectorAll<HTMLButtonElement>(
      ".kanban-board-tabs button",
    ),
  ].find((button) => button.textContent === "Active")!;
  await act(async () => activeTab.click());
  await tapCard();

  const stateSelect = detailStateSelect();
  await act(async () => stateSelect.click());
  const done = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === "Done")!;
  await act(async () => {
    done.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    done.click();
  });
  stateSelect.focus();
  await pressEscape(stateSelect);

  expect(detailView()).toBeNull();
  expect(container.querySelector('[data-kanban-issue="i1"]')).toBeNull();
  expect(document.activeElement).toBe(activeTab);
});

function sidebarResizer() {
  return detailView()!.querySelector<HTMLElement>('[role="separator"]')!;
}

function sidebarWidth() {
  return Number(sidebarResizer().getAttribute("aria-valuenow"));
}

it("resizes the detail sidebar from the keyboard within its bounds and keeps the width when reopened", async () => {
  await tapCard();
  const resizer = sidebarResizer();
  expect(sidebarWidth()).toBe(240);

  await pressKey(resizer, "ArrowLeft");
  expect(sidebarWidth()).toBe(256);
  await pressKey(resizer, "ArrowRight");
  await pressKey(resizer, "ArrowRight");
  expect(sidebarWidth()).toBe(224);
  await pressKey(resizer, "ArrowRight");
  expect(sidebarWidth()).toBe(220);
  await pressKey(resizer, "End");
  expect(sidebarWidth()).toBe(520);
  await pressKey(resizer, "ArrowLeft");
  expect(sidebarWidth()).toBe(520);
  await pressKey(resizer, "Home");
  expect(sidebarWidth()).toBe(220);
  await pressKey(resizer, "ArrowLeft");

  await pressEscape(document.body);
  expect(detailView()).toBeNull();
  await tapCard();
  expect(sidebarWidth()).toBe(236);
});

it("stops resizing the detail sidebar when the pointer capture is lost", async () => {
  await tapCard();
  const resizer = sidebarResizer();
  const pointer = (type: string, clientX: number) =>
    act(async () => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
      Object.defineProperty(event, "pointerId", { value: 1 });
      resizer.dispatchEvent(event);
    });

  await pointer("pointerdown", 500);
  await pointer("pointermove", 460);
  expect(sidebarWidth()).toBe(280);

  await pointer("lostpointercapture", 460);
  await pointer("pointermove", 400);
  expect(sidebarWidth()).toBe(280);
});

async function pressKey(
  target: Element,
  key: string,
  init?: KeyboardEventInit,
) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key, ...init }),
    );
  });
}

function titleButton() {
  return detailView()!.querySelector<HTMLButtonElement>("h1 button")!;
}

async function editTitle(value: string) {
  await act(async () => titleButton().click());
  const input = detailView()!.querySelector<HTMLInputElement>("h1 input")!;
  expect(document.activeElement).toBe(input);
  await act(async () => setInputValue(input, value));
  return input;
}

it("renames the issue on Enter and cancels the edit on Escape without leaving the detail", async () => {
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ title: "Ship the editor" }),
  );
  await tapCard();

  await pressKey(await editTitle("  Ship the editor  "), "Enter");
  expect(api.updateKanbanIssue).toHaveBeenCalledWith("local", "i1", {
    title: "Ship the editor",
  });
  expect(titleButton().textContent).toBe("Ship the editor");
  expect(document.activeElement).toBe(titleButton());
  expect(cardButton().textContent).toContain("Ship the editor");

  await pressKey(await editTitle("Discarded"), "Escape");
  expect(detailView()).not.toBeNull();
  expect(detailView()!.querySelector("h1 input")).toBeNull();
  expect(titleButton().textContent).toBe("Ship the editor");
  expect(document.activeElement).toBe(titleButton());
  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(1);
});

it("keeps editing the title when Enter confirms an IME composition", async () => {
  await tapCard();
  const input = await editTitle("日本");

  await pressKey(input, "Enter", { keyCode: 229 });
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("日本");
  expect(api.updateKanbanIssue).not.toHaveBeenCalled();
});

it("keeps a newer server title when an untouched title edit is blurred", async () => {
  const resolveUpdate = deferred<KanbanIssueUpdate>();
  vi.mocked(api.updateKanbanIssue).mockReturnValue(resolveUpdate.promise);
  await tapCard();
  await act(async () => detailStateSelect().click());
  const done = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === "Done")!;
  await act(async () => {
    done.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    done.click();
  });

  await act(async () => titleButton().click());
  const input = detailView()!.querySelector<HTMLInputElement>("h1 input")!;
  await act(async () =>
    resolveUpdate.resolve(
      issueUpdate({ stateId: "done", title: "Renamed elsewhere" }),
    ),
  );
  await act(async () => input.blur());

  expect(api.updateKanbanIssue).toHaveBeenCalledTimes(1);
  expect(api.updateKanbanIssue).toHaveBeenCalledWith("local", "i1", {
    stateId: "done",
  });
  expect(titleButton().textContent).toBe("Renamed elsewhere");
});

async function chooseOption(select: HTMLElement, label: string) {
  await act(async () => select.click());
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find(
    (element) =>
      element.querySelector(".app-select-option-label")?.textContent === label,
  )!;
  await act(async () => {
    option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option.click();
  });
}

it("adds a label from the labels menu and keeps the menu open", async () => {
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ labels: [board.labels[0]] }),
  );
  await tapCard();

  const trigger = detailView()!.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit labels"]',
  )!;
  await act(async () => trigger.click());
  const bug = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="menu"] [role="menuitemcheckbox"]',
    ),
  ].find((item) => item.textContent === "Bug")!;
  expect(bug.getAttribute("aria-checked")).toBe("false");
  await act(async () => bug.click());

  expect(api.updateKanbanIssue).toHaveBeenCalledWith("local", "i1", {
    addedLabelIds: ["l1"],
  });
  expect(bug.isConnected).toBe(true);
  expect(bug.getAttribute("aria-checked")).toBe("true");
  expect(
    [
      ...detailView()!.querySelectorAll(".kanban-issue-labels .kanban-chip"),
    ].map((chip) => chip.textContent),
  ).toEqual(["Bug"]);
});

it("creates a label from the labels menu, selects it and reuses an existing name", async () => {
  const docs = { id: "l3", name: "Docs", color: "#26b5ce" };
  vi.mocked(api.createKanbanLabel).mockResolvedValue(docs);
  vi.mocked(api.updateKanbanIssue)
    .mockResolvedValueOnce(issueUpdate({ labels: [docs] }))
    .mockResolvedValueOnce(issueUpdate({ labels: [board.labels[0], docs] }));
  await tapCard();

  const trigger = detailView()!.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit labels"]',
  )!;
  await act(async () => trigger.click());
  const input = document.querySelector<HTMLInputElement>(
    '[role="menu"] input[aria-label="New label"]',
  )!;
  await act(async () => setInputValue(input, "  Docs "));
  await pressKey(input, "Enter");

  expect(api.createKanbanLabel).toHaveBeenCalledExactlyOnceWith(
    "local",
    "t1",
    "Docs",
  );
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    addedLabelIds: ["l3"],
  });
  expect(input.value).toBe("");
  const items = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="menu"] [role="menuitemcheckbox"]',
      ),
    ].map((item) => [item.textContent, item.getAttribute("aria-checked")]);
  expect(items()).toEqual([
    ["Bug", "false"],
    ["Docs", "true"],
    ["Feature", "false"],
  ]);

  await act(async () => setInputValue(input, "bug"));
  await pressKey(input, "Enter");

  expect(api.createKanbanLabel).toHaveBeenCalledOnce();
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    addedLabelIds: ["l1"],
  });
  expect(items()[0]).toEqual(["Bug", "true"]);
});

it("keeps a label ticked while another one is being created", async () => {
  const docs = { id: "l3", name: "Docs", color: "#26b5ce" };
  const creation = deferred<KanbanLabel>();
  const bugUpdate = deferred<KanbanIssueUpdate>();
  vi.mocked(api.createKanbanLabel).mockReturnValue(creation.promise);
  vi.mocked(api.updateKanbanIssue)
    .mockReturnValueOnce(bugUpdate.promise)
    .mockResolvedValueOnce(issueUpdate({ labels: [board.labels[0], docs] }));
  await tapCard();

  const trigger = detailView()!.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit labels"]',
  )!;
  await act(async () => trigger.click());
  const input = document.querySelector<HTMLInputElement>(
    '[role="menu"] input[aria-label="New label"]',
  )!;
  await act(async () => setInputValue(input, "Docs"));
  await pressKey(input, "Enter");
  const bug = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="menu"] [role="menuitemcheckbox"]',
    ),
  ].find((item) => item.textContent === "Bug")!;
  await act(async () => bug.click());
  await act(async () => creation.resolve(docs));
  await act(async () =>
    bugUpdate.resolve(issueUpdate({ labels: [board.labels[0]] })),
  );

  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    addedLabelIds: ["l3"],
  });
  expect(
    [
      ...detailView()!.querySelectorAll(".kanban-issue-labels .kanban-chip"),
    ].map((chip) => chip.textContent),
  ).toEqual(["Bug", "Docs"]);
});

it("creates a label whose name differs from an existing one only by accents", async () => {
  const accented = { id: "l4", name: "Bûg", color: "#26b5ce" };
  vi.mocked(api.createKanbanLabel).mockResolvedValue(accented);
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ labels: [accented] }),
  );
  await tapCard();

  const trigger = detailView()!.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit labels"]',
  )!;
  await act(async () => trigger.click());
  const input = document.querySelector<HTMLInputElement>(
    '[role="menu"] input[aria-label="New label"]',
  )!;
  await act(async () => setInputValue(input, "Bûg"));
  await pressKey(input, "Enter");

  expect(api.createKanbanLabel).toHaveBeenCalledExactlyOnceWith(
    "local",
    "t1",
    "Bûg",
  );
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    addedLabelIds: ["l4"],
  });
});

it("reaches the new label input from the keyboard and moves between it and the labels", async () => {
  const docs = { id: "l3", name: "Docs", color: "#26b5ce" };
  vi.mocked(api.createKanbanLabel).mockResolvedValue(docs);
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ labels: [docs] }),
  );
  await tapCard();

  const trigger = detailView()!.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit labels"]',
  )!;
  trigger.focus();
  // A native button turns Enter into a click without pointer details.
  await pressKey(trigger, "Enter");
  await act(async () => trigger.click());
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[role="menu"] input[aria-label="New label"]',
  )!;
  expect(document.activeElement).toBe(input);

  const firstItem = document.querySelector<HTMLElement>(
    '[role="menu"] [role="menuitemcheckbox"]',
  )!;
  await pressKey(input, "ArrowDown");
  expect(document.activeElement).toBe(firstItem);
  await pressKey(firstItem, "ArrowUp");
  expect(document.activeElement).toBe(input);

  await act(async () => setInputValue(input, "Docs"));
  await pressKey(input, "Enter");

  expect(api.createKanbanLabel).toHaveBeenCalledExactlyOnceWith(
    "local",
    "t1",
    "Docs",
  );
  expect(api.updateKanbanIssue).toHaveBeenLastCalledWith("local", "i1", {
    addedLabelIds: ["l3"],
  });
  expect(document.activeElement).toBe(input);
  expect(detailView()).not.toBeNull();
});

function commentField() {
  return detailView()!.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Add a comment"]',
  )!;
}

it("posts a comment, appends it and clears the draft", async () => {
  vi.mocked(api.createKanbanComment).mockImplementation(async (_, __, body) =>
    storeComment({ id: "c2", body, createdAt: "2026-09-27T10:00:00.000Z" }),
  );
  await tapCard();

  const submit = [...detailView()!.querySelectorAll("button")].find(
    (button) => button.textContent === "Comment",
  )!;
  expect(submit.disabled).toBe(true);
  await act(async () => setInputValue(commentField(), "Shipping today"));
  expect(submit.disabled).toBe(false);
  await pressKey(commentField(), "Enter", { ctrlKey: true });

  expect(api.createKanbanComment).toHaveBeenCalledWith(
    "local",
    "i1",
    "Shipping today",
  );
  expect(
    [...detailView()!.querySelectorAll(".kanban-issue-comment-author")].map(
      (author) => author.textContent,
    ),
  ).toEqual(["You", "You"]);
  expect(commentField().value).toBe("");
  expect(submit.disabled).toBe(true);
});

it("keeps the comment draft and reports the translated error when posting fails", async () => {
  vi.mocked(api.createKanbanComment).mockRejectedValue(
    "[Kanban/issueNotFound] Issue introuvable.",
  );
  await tapCard();

  await act(async () => setInputValue(commentField(), "Shipping today"));
  const submit = [...detailView()!.querySelectorAll("button")].find(
    (button) => button.textContent === "Comment",
  )!;
  await act(async () => submit.click());

  expect(api.createKanbanComment).toHaveBeenCalledWith(
    "local",
    "i1",
    "Shipping today",
  );
  expect(notifyError).toHaveBeenCalledWith("This issue no longer exists.");
  expect(commentField().value).toBe("Shipping today");
  expect(detailView()!.querySelectorAll(".kanban-issue-comment")).toHaveLength(
    1,
  );
});

it("deletes a comment once confirmed and stays on the issue", async () => {
  vi.mocked(api.deleteKanbanComment).mockImplementation(
    async (_source, _issueId, id) => {
      storedIssue = {
        ...storedIssue,
        comments: storedIssue.comments.filter((comment) => comment.id !== id),
      };
    },
  );
  await tapCard();
  const deleteSelector = 'button[aria-label="Delete comment"]';

  await act(async () =>
    detailView()!.querySelector<HTMLButtonElement>(deleteSelector)!.click(),
  );
  expect(deleteDialog()).not.toBeNull();
  // An agent issue opened from its notification abandons the confirmation.
  await renderBoard({
    issueRequest: { issue: { id: "i2", identifier: "ACM-2", source: "local" } },
  });
  expect(deleteDialog()).toBeNull();
  await renderBoard({
    issueRequest: { issue: { id: "i1", identifier: "ACM-1", source: "local" } },
  });
  expect(deleteDialog()).toBeNull();
  expect(api.deleteKanbanComment).not.toHaveBeenCalled();

  await act(async () =>
    detailView()!.querySelector<HTMLButtonElement>(deleteSelector)!.click(),
  );
  expect(api.deleteKanbanComment).not.toHaveBeenCalled();
  await act(async () => deleteDialogButton("Delete").click());

  expect(api.deleteKanbanComment).toHaveBeenCalledExactlyOnceWith(
    "local",
    "i1",
    "c1",
  );
  expect(deleteDialog()).toBeNull();
  expect(detailView()!.querySelectorAll(".kanban-issue-comment")).toHaveLength(
    0,
  );
});

function editorIn(host: Element) {
  return EditorView.findFromDOM(
    host.querySelector<HTMLElement>(".cm-editor")!,
  )!;
}

function descriptionEditor() {
  return editorIn(detailView()!.querySelector(".kanban-issue-description")!);
}

function setEditorText(view: EditorView, text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
  });
}

async function blurEditor(view: EditorView) {
  await act(async () => {
    view.contentDOM.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true }),
    );
  });
}

// Trims like the backend.
async function saveDescription(
  _source: string,
  id: string,
  description: string,
): Promise<KanbanIssueDescriptionUpdate> {
  storedIssue = { ...storedIssue, description: description.trim() };
  return {
    id,
    description: description.trim(),
    updatedAt: "2026-09-27T10:00:00.000Z",
  };
}

const pullRequest = { number: 42, url: "https://github.com/acme/app/pull/42" };

// The backend derives pull requests from the saved description and comments.
function linkPullRequest() {
  storedIssue = { ...storedIssue, pullRequests: [pullRequest] };
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [
      { ...structuredClone(board.issues[0]), pullRequests: [pullRequest] },
    ],
  });
}

function pullRequestChips() {
  const selector = 'button[aria-label="Open pull request #42"]';
  return {
    card: cardButton().closest(".kanban-card")!.querySelectorAll(selector)
      .length,
    detail: detailView()!.querySelectorAll(selector).length,
  };
}

it("saves the description edited in place when focus leaves it, keeping the typed text", async () => {
  // Like Linear: the stored Markdown has no repeated blank lines and a blank line before each list.
  vi.mocked(api.updateKanbanIssueDescription).mockImplementation(
    async (source, id, description) =>
      saveDescription(
        source,
        id,
        description
          .replace(/\n{3,}/g, "\n\n")
          .replace(/([^\n])\n- /g, "$1\n\n- "),
      ),
  );
  await tapCard();
  const editor = descriptionEditor();
  expect(editor.state.sliceDoc()).toBe("Rendered **markdown**");

  const typed = "Now\n- **bold**\n\n\n\nEnd\n";
  await act(async () => setEditorText(editor, typed));
  expect(api.updateKanbanIssueDescription).not.toHaveBeenCalled();
  await blurEditor(editor);

  expect(api.updateKanbanIssueDescription).toHaveBeenCalledExactlyOnceWith(
    "local",
    "i1",
    typed,
  );
  expect(descriptionEditor()).toBe(editor);
  expect(editor.state.sliceDoc()).toBe(typed);
  // New trailing lines change nothing to save, and stay.
  await act(async () => setEditorText(editor, `${typed}\n\n`));
  expect(editor.state.sliceDoc()).toBe(`${typed}\n\n`);
  await blurEditor(editor);
  expect(api.updateKanbanIssueDescription).toHaveBeenCalledTimes(1);
});

it("autosaves the description once typing pauses", async () => {
  vi.mocked(api.updateKanbanIssueDescription).mockImplementation(
    saveDescription,
  );
  await tapCard();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const editor = descriptionEditor();

  await act(async () => setEditorText(editor, "Draft"));
  await act(async () => vi.advanceTimersByTime(500));
  await act(async () => setEditorText(editor, "Draft 2"));
  await act(async () => vi.advanceTimersByTime(500));
  expect(api.updateKanbanIssueDescription).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(200));

  expect(api.updateKanbanIssueDescription).toHaveBeenCalledExactlyOnceWith(
    "local",
    "i1",
    "Draft 2",
  );
});

it("shows an outside description received during an edit once the edit is undone", async () => {
  vi.mocked(api.createKanbanComment).mockImplementation(async (_, __, body) =>
    storeComment({ id: "c2", body, createdAt: "2026-09-27T10:00:00.000Z" }),
  );
  await tapCard();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const editor = descriptionEditor();

  await act(async () => setEditorText(editor, "Local draft"));
  storedIssue = {
    ...storedIssue,
    description: "Written by an agent:\n- A\n- B",
  };
  await act(async () => setInputValue(commentField(), "Reloads the issue"));
  await pressKey(commentField(), "Enter", { ctrlKey: true });
  expect(editor.state.sliceDoc()).toBe("Local draft");
  await act(async () => setEditorText(editor, "Rendered **markdown**"));
  await act(async () => vi.advanceTimersByTime(1000));

  expect(editor.state.sliceDoc()).toBe("Written by an agent:\n- A\n- B");

  // Only the indentation changes: the sub-item still replaces the text.
  storedIssue = {
    ...storedIssue,
    description: "Written by an agent:\n- A\n  - B\n```\nC\n\n\nD\n```",
  };
  await act(async () => setInputValue(commentField(), "Reloads it again"));
  await pressKey(commentField(), "Enter", { ctrlKey: true });

  expect(editor.state.sliceDoc()).toBe(
    "Written by an agent:\n- A\n  - B\n```\nC\n\n\nD\n```",
  );

  // Only blank lines change, with no local save to echo: the outside text still wins.
  storedIssue = {
    ...storedIssue,
    description: "Written by an agent:\n- A\n  - B\n```\nC\n\nD\n```",
  };
  await act(async () => setInputValue(commentField(), "Reloads once more"));
  await pressKey(commentField(), "Enter", { ctrlKey: true });

  expect(editor.state.sliceDoc()).toBe(
    "Written by an agent:\n- A\n  - B\n```\nC\n\nD\n```",
  );
  expect(api.updateKanbanIssueDescription).not.toHaveBeenCalled();
});

it("saves a description still being typed when leaving the issue", async () => {
  vi.mocked(api.updateKanbanIssueDescription).mockImplementation(
    saveDescription,
  );
  await tapCard();

  await act(async () => setEditorText(descriptionEditor(), "Last words"));
  await pressEscape(document.body);

  expect(detailView()).toBeNull();
  expect(api.updateKanbanIssueDescription).toHaveBeenCalledExactlyOnceWith(
    "local",
    "i1",
    "Last words",
  );
});

it("shows the pull request a saved description links in the detail and on its card", async () => {
  vi.mocked(api.updateKanbanIssueDescription).mockImplementation(
    async (source, id, description) => {
      linkPullRequest();
      return saveDescription(source, id, description);
    },
  );
  await tapCard();
  expect(pullRequestChips()).toEqual({ card: 0, detail: 0 });

  const editor = descriptionEditor();
  await act(async () => setEditorText(editor, pullRequest.url));
  await blurEditor(editor);

  expect(pullRequestChips()).toEqual({ card: 1, detail: 1 });
});

it("shows the pull request a posted comment links in the detail and on its card", async () => {
  vi.mocked(api.createKanbanComment).mockImplementation(async (_, __, body) => {
    linkPullRequest();
    return storeComment({
      id: "c2",
      body,
      createdAt: "2026-09-27T10:00:00.000Z",
    });
  });
  await tapCard();
  expect(pullRequestChips()).toEqual({ card: 0, detail: 0 });

  await act(async () =>
    setInputValue(commentField(), `Opened ${pullRequest.url}`),
  );
  await pressKey(commentField(), "Enter", { ctrlKey: true });

  expect(pullRequestChips()).toEqual({ card: 1, detail: 1 });
});

it("keeps the description draft and reports the error when saving fails", async () => {
  vi.mocked(api.updateKanbanIssueDescription).mockRejectedValue(
    new Error("Offline."),
  );
  await tapCard();
  const editor = descriptionEditor();

  await act(async () => setEditorText(editor, "Draft"));
  await blurEditor(editor);

  expect(notifyError).toHaveBeenCalledWith("Offline.");
  expect(editor.state.sliceDoc()).toBe("Draft");
});

function deleteDialog() {
  return document.querySelector<HTMLElement>('[role="alertdialog"]');
}

function deleteDialogButton(label: string) {
  return [...deleteDialog()!.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  )!;
}

async function openDeleteDialog() {
  await tapCard();
  const trigger = detailView()!.querySelector<HTMLButtonElement>(
    '.agent-git-panel-header button[aria-label="Delete issue"]',
  )!;
  await act(async () => trigger.click());
  expect(deleteDialog()).not.toBeNull();
}

it("deletes the issue after confirmation and returns to the board without its card", async () => {
  const deletion = deferred<void>();
  vi.mocked(api.deleteKanbanIssue).mockReturnValue(deletion.promise);
  const selectedTab = container.querySelector<HTMLButtonElement>(
    ".kanban-board-tabs [aria-pressed='true']",
  )!;
  await openDeleteDialog();

  await act(async () => deleteDialogButton("Delete").click());

  expect(api.deleteKanbanIssue).toHaveBeenCalledExactlyOnceWith("local", "i1");
  expect(detailView()).not.toBeNull();

  await act(async () => deletion.resolve());

  expect(deleteDialog()).toBeNull();
  expect(detailView()).toBeNull();
  expect(container.querySelector('[data-kanban-issue="i1"]')).toBeNull();
  expect(document.activeElement).toBe(selectedTab);
});

it("keeps the issue when the deletion is cancelled", async () => {
  await openDeleteDialog();

  await act(async () => deleteDialogButton("Cancel").click());

  expect(deleteDialog()).toBeNull();
  expect(api.deleteKanbanIssue).not.toHaveBeenCalled();
  expect(detailView()).not.toBeNull();
});

it("closes the confirmation but not the detail on Escape", async () => {
  await openDeleteDialog();

  await pressEscape(document.activeElement!);

  expect(deleteDialog()).toBeNull();
  expect(detailView()).not.toBeNull();
  expect(api.deleteKanbanIssue).not.toHaveBeenCalled();
});

it("reports a failed deletion and keeps the detail and the card", async () => {
  vi.mocked(api.deleteKanbanIssue).mockRejectedValue(new Error("Offline."));
  await openDeleteDialog();

  await act(async () => deleteDialogButton("Delete").click());

  expect(notifyError).toHaveBeenCalledExactlyOnceWith("Offline.");
  expect(deleteDialog()).toBeNull();
  expect(detailView()).not.toBeNull();
  expect(container.querySelector('[data-kanban-issue="i1"]')).not.toBeNull();
});

const transferred: KanbanIssue = {
  ...structuredClone(board.issues[0]),
  source: "linear",
  id: "li7",
  identifier: "ENG-7",
  stateId: "lt",
};

async function sendToLinear() {
  const engineering = { id: "lt1", key: "ENG", name: "Engineering" };
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [
      { ...structuredClone(board.issues[0]), labels: [board.labels[0]] },
    ],
  });
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue({
    source: "linear",
    teams: [engineering],
    team: engineering,
    states: [
      {
        id: "lb",
        name: "Backlog",
        type: "backlog",
        color: "#888",
        position: 0,
      },
      { id: "lt", name: "Todo", type: "unstarted", color: "#888", position: 1 },
    ],
    labels: [
      { id: "ll1", name: "bug", color: "#e5484d" },
      { id: "ll2", name: "Docs", color: "#26b5ce" },
    ],
    issues: [],
    truncated: false,
  });
  vi.mocked(api.loadKanbanIssue).mockImplementation(async (source) =>
    source === "linear"
      ? { ...structuredClone(storedIssue), ...transferred, teamId: "lt1" }
      : structuredClone(storedIssue),
  );
  await remountBoard({});
  await tapCard();
  const trigger = await vi.waitFor(() => {
    const button = detailView()!.querySelector<HTMLButtonElement>(
      '.agent-git-panel-header button[aria-label="Send to Linear"]',
    );
    expect(button).not.toBeNull();
    return button!;
  });
  await act(async () => trigger.click());
  await act(async () => deleteDialogButton("Send").click());
}

it("sends a local issue to the shown Linear team, then opens it there", async () => {
  vi.mocked(api.transferKanbanIssueToLinear).mockResolvedValue(transferred);
  await sendToLinear();

  expect(api.transferKanbanIssueToLinear).toHaveBeenCalledExactlyOnceWith(
    "i1",
    expect.objectContaining({
      teamId: "lt1",
      stateId: "lt",
      labelIds: ["ll1"],
      description: expect.stringContaining("Looks good"),
    }),
    [{ id: "c1", body: "Looks good" }],
    "Rendered **markdown**",
  );
  expect(api.loadKanbanIssue).toHaveBeenLastCalledWith("linear", "li7");
  expect(deleteDialog()).toBeNull();
  expect(detailView()).not.toBeNull();
  expect(container.querySelector('[data-kanban-issue="i1"]')).toBeNull();
});

it("lists the created Linear issue and keeps the local card when the transfer is incomplete", async () => {
  vi.mocked(api.transferKanbanIssueToLinear).mockRejectedValue(
    new Error("[Kanban/transferIncomplete] ENG-7 : database locked"),
  );
  await sendToLinear();

  await vi.waitFor(() =>
    expect(api.loadLinearKanbanBoard).toHaveBeenCalledTimes(2),
  );
  expect(notifyError).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-kanban-issue="i1"]')).not.toBeNull();
});

const createdIssue: KanbanIssue = {
  ...board.issues[0],
  id: "i2",
  identifier: "ACM-2",
  title: "Write the docs",
  stateId: "done",
};

function createDialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function columnCreateButton(state: string) {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="New issue in ${state}"]`,
  )!;
}

function dialogTitle() {
  return createDialog()!.querySelector<HTMLInputElement>(
    'input[aria-label="Title"]',
  )!;
}

function dialogDescription() {
  return editorIn(createDialog()!);
}

function dialogField(label: string) {
  return createDialog()!.querySelector<HTMLButtonElement>(
    `.kanban-create-fields [aria-label="${label}"]`,
  )!;
}

function submitButton() {
  return [...createDialog()!.querySelectorAll("button")].find(
    (button) => button.textContent === "Create issue",
  )!;
}

function dialogCheckbox(label: string) {
  return [...createDialog()!.querySelectorAll("label")]
    .find((element) => element.textContent === label)!
    .querySelector<HTMLElement>('[role="checkbox"]')!;
}

async function openColumnDialog(state: string) {
  await act(async () => columnCreateButton(state).click());
  expect(createDialog()).not.toBeNull();
}

function issuePanel() {
  return container.querySelector<HTMLElement>('[data-testid="issue-panel"]')!;
}

it("links an existing issue to a session from the panel, starts it and tells its agent", async () => {
  const onLinkSessionIssue = vi.fn(async () => {});
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ stateId: "doing" }),
  );
  await renderBoard({ panelIssue: null, onLinkSessionIssue });

  const choice = [...issuePanel().querySelectorAll("button")].find((button) =>
    button.textContent?.includes("ACM-1"),
  )!;
  await act(async () => choice.click());

  expect(onLinkSessionIssue).toHaveBeenCalledExactlyOnceWith("s1", {
    id: "i1",
    identifier: "ACM-1",
    source: "local",
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledWith("local", "i1", {
    stateId: "doing",
  });
  await vi.waitFor(() =>
    expect(agentApi.sendAgentSessionMessage).toHaveBeenCalledOnce(),
  );
  const [sessionId, , message] = vi.mocked(agentApi.sendAgentSessionMessage)
    .mock.calls[0];
  expect(sessionId).toBe("s1");
  expect(message).toContain("ACM-1");
  expect(message).toContain("Rendered **markdown**");
  expect(message).toContain("<soreno-summary>");
});

it("creates the session's issue in its project from the panel, then links it", async () => {
  const onLinkSessionIssue = vi.fn(async () => {});
  vi.mocked(api.createKanbanIssue).mockResolvedValue(createdIssue);
  await renderBoard({
    panelIssue: null,
    onLinkSessionIssue,
    kanbanProjects: sorenoProjects,
  });

  const create = [...issuePanel().querySelectorAll("button")].find(
    (button) => button.textContent === "Create an issue",
  )!;
  await act(async () => create.click());
  expect(dialogField("Project").textContent).toBe("Soreno app");
  expect(createDialog()!.textContent).not.toContain("Start an agent");
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));
  await act(async () => submitButton().click());

  expect(api.createKanbanIssue).toHaveBeenCalledWith(
    "local",
    expect.objectContaining({ title: "Write the docs", projectId: "sp1" }),
  );
  expect(onLinkSessionIssue).toHaveBeenCalledExactlyOnceWith("s1", {
    id: "i2",
    identifier: "ACM-2",
    source: "local",
  });
  expect(createDialog()).toBeNull();
});

it("links the issue created from the panel to the session it was opened for", async () => {
  const onLinkSessionIssue = vi.fn(async () => {});
  vi.mocked(api.createKanbanIssue).mockResolvedValue(createdIssue);
  const props = {
    panelIssue: null,
    onLinkSessionIssue,
    kanbanProjects: sorenoProjects,
  };
  await renderBoard(props);

  const create = [...issuePanel().querySelectorAll("button")].find(
    (button) => button.textContent === "Create an issue",
  )!;
  await act(async () => create.click());
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));
  // A notification selects another agent session while the dialog is open.
  await renderBoard({ ...props, panelSessionId: "s2" });
  expect(dialogTitle().value).toBe("Write the docs");
  await act(async () => submitButton().click());

  expect(onLinkSessionIssue).toHaveBeenCalledExactlyOnceWith(
    "s1",
    expect.objectContaining({ id: "i2" }),
  );
});

it("unlinks the session's issue from the panel after confirmation and tells its agent", async () => {
  const onUnlinkSessionIssue = vi.fn(async () => {});
  await renderBoard({
    panelIssue: { id: "i1", identifier: "ACM-1", source: "local" },
    issueSessions: [issueLink()],
    sessions: [linkedSession],
    onUnlinkSessionIssue,
  });

  await act(async () =>
    issuePanel()
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Unlink from this session"]',
      )!
      .click(),
  );
  await act(async () => deleteDialogButton("Unlink").click());

  expect(onUnlinkSessionIssue).toHaveBeenCalledExactlyOnceWith("s1");
  expect(api.updateKanbanIssue).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await vi.waitFor(() =>
    expect(agentApi.sendAgentSessionMessage).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.stringContaining("no longer linked to issue ACM-1"),
    ),
  );
});

it("drops the panel's pending unlink confirmation when it shows another issue", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [
      ...structuredClone(board.issues),
      { ...structuredClone(board.issues[0]), id: "i2", identifier: "ACM-2" },
    ],
  });
  const onUnlinkSessionIssue = vi.fn(async () => {});
  const props: BoardProps = {
    panelIssue: { id: "i1", identifier: "ACM-1", source: "local" },
    issueSessions: [issueLink()],
    sessions: [linkedSession],
    onUnlinkSessionIssue,
  };
  await renderBoard(props);
  await act(async () =>
    issuePanel()
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Unlink from this session"]',
      )!
      .click(),
  );
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

  await renderBoard({
    ...props,
    panelIssue: { id: "i2", identifier: "ACM-2", source: "local" },
  });

  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(onUnlinkSessionIssue).not.toHaveBeenCalled();
});

it("creates an issue in the column it was opened from with Ctrl+Enter", async () => {
  vi.mocked(api.createKanbanIssue).mockResolvedValue(createdIssue);
  await openColumnDialog("Done");

  expect(document.activeElement).toBe(dialogTitle());
  expect(dialogField("Status").textContent).toBe("Done");
  expect(
    container.querySelector(".kanban-board-pane")?.hasAttribute("inert"),
  ).toBe(true);
  await act(async () => setInputValue(dialogTitle(), "  Write the docs  "));
  await pressKey(dialogTitle(), "Enter", { ctrlKey: true });

  expect(api.createKanbanIssue).toHaveBeenCalledWith("local", {
    teamId: "t1",
    title: "Write the docs",
    stateId: "done",
  });
  expect(createDialog()).toBeNull();
  const done = container.querySelector('[data-kanban-state="done"]')!;
  expect(done.querySelector('[data-kanban-issue="i2"]')).not.toBeNull();
  expect(document.activeElement).toBe(columnCreateButton("Done"));
});

it("defaults the board header dialog to the first unstarted state", async () => {
  const header = container.querySelector<HTMLButtonElement>(
    '.kanban-board-actions button[aria-label="New issue"]',
  )!;
  await act(async () => header.click());

  expect(dialogField("Status").textContent).toBe("Todo");
});

it("keeps the dialog open with the chosen fields when creating more", async () => {
  vi.mocked(api.createKanbanIssue).mockResolvedValue(createdIssue);
  await openColumnDialog("Todo");

  await chooseOption(dialogField("Priority"), "High priority");
  await act(async () => dialogField("Labels").click());
  const bug = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
  ].find((item) => item.textContent === "Bug")!;
  await act(async () => {
    bug.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    bug.click();
  });
  expect(createDialog()).not.toBeNull();
  await pressEscape(bug);
  await act(async () => dialogCheckbox("Create more").click());
  await act(async () => {
    setInputValue(dialogTitle(), "Write the docs");
    setEditorText(dialogDescription(), "Cover **creation**");
  });
  await act(async () => submitButton().click());

  expect(api.createKanbanIssue).toHaveBeenCalledWith("local", {
    teamId: "t1",
    title: "Write the docs",
    description: "Cover **creation**",
    stateId: "todo",
    priority: 2,
    labelIds: ["l1"],
  });
  expect(createDialog()).not.toBeNull();
  expect(dialogTitle().value).toBe("");
  expect(dialogDescription().state.sliceDoc()).toBe("");
  await act(async () => undo(dialogDescription()));
  expect(dialogDescription().state.sliceDoc()).toBe("");
  expect(document.activeElement).toBe(dialogTitle());
  expect(dialogField("Priority").textContent).toBe("High priority");
  expect(dialogField("Labels: Bug").textContent).toBe("Bug");
  expect(container.querySelector('[data-kanban-issue="i2"]')).not.toBeNull();
});

it("waits for a label being created before creating the issue", async () => {
  const docs = { id: "l3", name: "Docs", color: "#26b5ce" };
  const creation = deferred<KanbanLabel>();
  vi.mocked(api.createKanbanLabel).mockReturnValue(creation.promise);
  vi.mocked(api.createKanbanIssue).mockResolvedValue(createdIssue);
  await openColumnDialog("Todo");
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));

  await act(async () => dialogField("Labels").click());
  const input = document.querySelector<HTMLInputElement>(
    '[role="menu"] input[aria-label="New label"]',
  )!;
  await act(async () => setInputValue(input, "Docs"));
  await pressKey(input, "Enter");
  await pressEscape(input);
  expect(createDialog()).not.toBeNull();
  await act(async () => submitButton().click());
  await pressKey(dialogTitle(), "Enter", { ctrlKey: true });
  expect(api.createKanbanIssue).not.toHaveBeenCalled();

  await act(async () => creation.resolve(docs));
  await act(async () => submitButton().click());
  expect(api.createKanbanIssue).toHaveBeenCalledExactlyOnceWith("local", {
    teamId: "t1",
    title: "Write the docs",
    stateId: "todo",
    labelIds: ["l3"],
  });
});

it("adds the new label instead of creating the issue on Ctrl+Enter", async () => {
  vi.mocked(api.createKanbanLabel).mockReturnValue(
    deferred<KanbanLabel>().promise,
  );
  await openColumnDialog("Todo");
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));

  await act(async () => dialogField("Labels").click());
  const input = document.querySelector<HTMLInputElement>(
    '[role="menu"] input[aria-label="New label"]',
  )!;
  await act(async () => setInputValue(input, "Docs"));
  await pressKey(input, "Enter", { ctrlKey: true });
  expect(api.createKanbanLabel).toHaveBeenCalledOnce();
  expect(api.createKanbanIssue).not.toHaveBeenCalled();
});

it("keeps the draft and reports the error when creation fails", async () => {
  vi.mocked(api.createKanbanIssue).mockRejectedValue(new Error("Offline."));
  await openColumnDialog("Todo");

  await act(async () => {
    setInputValue(dialogTitle(), "Write the docs");
    setEditorText(dialogDescription(), "Details");
  });
  await act(async () => submitButton().click());

  expect(notifyError).toHaveBeenCalledWith("Offline.");
  expect(createDialog()).not.toBeNull();
  expect(dialogTitle().value).toBe("Write the docs");
  expect(dialogDescription().state.sliceDoc()).toBe("Details");
  expect(submitButton().disabled).toBe(false);
  expect(container.querySelector('[data-kanban-issue="i2"]')).toBeNull();
});

it("locks the draft controls while a creation is pending", async () => {
  const resolveCreation = deferred<KanbanIssue>();
  vi.mocked(api.createKanbanIssue).mockReturnValue(resolveCreation.promise);
  await openColumnDialog("Todo");
  const createMore = dialogCheckbox("Create more");

  await act(async () => setInputValue(dialogTitle(), "Write the docs"));
  await act(async () => submitButton().click());
  expect(createMore.getAttribute("aria-disabled")).toBe("true");
  await act(async () => createMore.click());
  expect(createMore.getAttribute("aria-checked")).toBe("false");
  for (const label of ["Status", "Priority", "Project", "Labels"]) {
    expect(dialogField(label).disabled).toBe(true);
  }

  await act(async () => resolveCreation.resolve(createdIssue));
  expect(createDialog()).toBeNull();
});

async function openAgentDialog(
  onStartIssueAgent: BoardProps["onStartIssueAgent"],
  props: BoardProps = {},
) {
  localStorage.setItem("soreno.kanban.agentPreset.v1", "codex");
  vi.mocked(api.createKanbanIssue).mockResolvedValue({
    ...createdIssue,
    stateId: "todo",
  });
  vi.mocked(api.loadKanbanIssue).mockResolvedValue({
    ...(await api.loadKanbanIssue("local", "i1")),
    id: "i2",
    identifier: "ACM-2",
    title: "Write the docs",
    description: "Cover **creation**",
    branchName: "acm-2-write-the-docs",
  });
  await remountBoard({
    kanbanProjects: sorenoProjects,
    onStartIssueAgent,
    projects: sorenoProjects,
    ...props,
  });
  await openColumnDialog("Todo");
  await act(async () => dialogCheckbox("Start an agent").click());
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));
}

function agentSubmitButton() {
  return [...createDialog()!.querySelectorAll("button")].find(
    (button) => button.textContent === "Create and start agent",
  )!;
}

it("creates the issue, then starts an agent in the issue's project", async () => {
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ id: "i2", stateId: "doing" }),
  );
  const onStartIssueAgent = vi.fn().mockResolvedValue(undefined);
  await openAgentDialog(onStartIssueAgent);

  // The agent has no project choice of its own: it follows the issue's.
  expect(
    createDialog()!.querySelectorAll(
      '[role="combobox"][aria-label*="project" i]',
    ),
  ).toHaveLength(1);
  expect(dialogField("Agent").textContent).toBe("Codex");
  expect(
    dialogCheckbox("Work in a dedicated worktree").getAttribute("aria-checked"),
  ).toBe("true");
  expect(agentSubmitButton().disabled).toBe(true);
  await chooseOption(dialogField("Project"), "Soreno app");
  await act(async () => agentSubmitButton().click());

  expect(api.createKanbanIssue).toHaveBeenCalledExactlyOnceWith("local", {
    teamId: "t1",
    title: "Write the docs",
    stateId: "todo",
    projectId: "sp1",
  });
  expect(createDialog()).toBeNull();
  expect(api.loadKanbanIssue).toHaveBeenCalledWith("local", "i2");
  expect(onStartIssueAgent).toHaveBeenCalledExactlyOnceWith({
    issue: {
      id: "i2",
      identifier: "ACM-2",
      title: "Write the docs",
      description: "Cover **creation**",
      branchName: "acm-2-write-the-docs",
      source: "local",
    },
    projectId: "sp1",
    executable: "codex",
    presetName: "Codex",
    worktree: true,
    open: false,
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledExactlyOnceWith("local", "i2", {
    stateId: "doing",
  });
});

it("starts the agent of a group overview issue without a worktree", async () => {
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ id: "i2", stateId: "doing" }),
  );
  const onStartIssueAgent = vi.fn().mockResolvedValue(undefined);
  await openAgentDialog(onStartIssueAgent, {
    overviewProjectIds: new Set(["sp1"]),
  });
  const checkbox = '[role="checkbox"]';
  const before = createDialog()!.querySelectorAll(checkbox).length;

  await chooseOption(dialogField("Project"), "Soreno app");
  // The overview folder is no Git repo: the worktree option goes away.
  expect(createDialog()!.querySelectorAll(checkbox)).toHaveLength(before - 1);
  await act(async () => agentSubmitButton().click());

  expect(onStartIssueAgent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ projectId: "sp1", worktree: false }),
  );
});

it("keeps the created issue, names it and restores its state when its agent cannot start", async () => {
  vi.mocked(api.updateKanbanIssue).mockImplementation(
    async (_source, id, { stateId }) =>
      issueUpdate({ id, stateId, updatedAt: new Date().toISOString() }),
  );
  const onStartIssueAgent = vi
    .fn()
    .mockRejectedValue(new Error("Could not create the worktree."));
  await openAgentDialog(onStartIssueAgent);

  await chooseOption(dialogField("Project"), "Website");
  await act(async () => dialogCheckbox("Work in a dedicated worktree").click());
  await act(async () => agentSubmitButton().click());

  expect(onStartIssueAgent).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "sp2", worktree: false }),
  );
  expect(notifyError).toHaveBeenCalledExactlyOnceWith(
    "The agent for ACM-2 could not start: Could not create the worktree.",
  );
  expect(createDialog()).toBeNull();
  expect(container.querySelector('[data-kanban-issue="i2"]')).not.toBeNull();
  expect(vi.mocked(api.updateKanbanIssue).mock.calls).toEqual([
    ["local", "i2", { stateId: "doing" }],
    ["local", "i2", { stateId: "todo" }],
  ]);
  expect(
    container
      .querySelector('[data-kanban-state="todo"]')
      ?.querySelector('[data-kanban-issue="i2"]'),
  ).not.toBeNull();
});

it("offers no agent start without a Soreno project", async () => {
  await openColumnDialog("Todo");

  const toggle = dialogCheckbox("Start an agent");
  expect(toggle.getAttribute("aria-disabled")).toBe("true");
});

it("keeps the agent creation disabled while the inherited project cannot start an agent", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [
      {
        ...structuredClone(board.issues[0]),
        project: { id: "sp3", name: "Docs" },
      },
    ],
  });
  await remountBoard({
    kanbanProjects: sorenoProjects,
    projects: sorenoProjects,
  });
  await chooseOption(
    container.querySelector<HTMLElement>(
      '[role="combobox"][aria-label="Project"]',
    )!,
    "Docs",
  );
  await openColumnDialog("Todo");
  await act(async () => dialogCheckbox("Start an agent").click());
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));

  expect(dialogField("Project").textContent).toBe("Docs");
  expect(agentSubmitButton().disabled).toBe(true);

  await chooseOption(dialogField("Project"), "Website");
  expect(agentSubmitButton().disabled).toBe(false);
});

it("tells same-named projects apart by their environment", async () => {
  const [local] = sorenoProjects;
  await remountBoard({
    kanbanProjects: [
      local,
      {
        ...local,
        id: "sp-wsl",
        environment: { kind: "wsl", distribution: "Ubuntu" },
      },
      {
        ...local,
        id: "sp-ssh",
        environment: {
          kind: "ssh",
          distribution: null,
          ssh: {
            host: "dev.example",
            user: "dev",
            port: null,
            identityFile: null,
            hostKey: null,
          },
        },
      },
    ],
  });
  await openColumnDialog("Todo");
  await act(async () => dialogField("Project").click());

  expect(
    [...document.querySelectorAll('[role="option"]')]
      .filter((option) => option.textContent?.startsWith("Soreno app"))
      .map((option) => option.textContent),
  ).toEqual(["Soreno appLocal", "Soreno appWSL", "Soreno appSSH"]);
});

async function pasteImages(...files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files, types: ["Files"] },
  });
  await act(async () => dialogDescription().contentDOM.dispatchEvent(event));
  return event;
}

const screenshot = new File(["png"], "shot [1].png", { type: "image/png" });

it("uploads a pasted image into the description and waits for it before creating", async () => {
  const upload = deferred<string>();
  vi.mocked(api.uploadKanbanImage).mockReturnValue(upload.promise);
  vi.mocked(api.createKanbanIssue).mockResolvedValue(createdIssue);
  await openColumnDialog("Todo");
  await act(async () => {
    setInputValue(dialogTitle(), "Write the docs");
    setEditorText(dialogDescription(), "Steps");
  });

  expect((await pasteImages(screenshot)).defaultPrevented).toBe(true);
  expect(api.uploadKanbanImage).toHaveBeenCalledWith(screenshot);
  expect(submitButton().disabled).toBe(true);
  await pressKey(dialogTitle(), "Enter", { ctrlKey: true });
  expect(api.createKanbanIssue).not.toHaveBeenCalled();

  await act(async () =>
    upload.resolve(
      "asset://localhost/%2Fdata%2Fkanban-images%2F0123456789abcdef0123456789abcdef.png",
    ),
  );
  const description =
    "Steps\n\n![shot \\[1\\].png](<asset://localhost/%2Fdata%2Fkanban-images%2F0123456789abcdef0123456789abcdef.png>)\n\n";
  expect(dialogDescription().state.sliceDoc()).toBe(description);
  expect(submitButton().disabled).toBe(false);
  await act(async () => submitButton().click());
  expect(api.createKanbanIssue).toHaveBeenCalledWith("local", {
    teamId: "t1",
    title: "Write the docs",
    description,
    stateId: "todo",
  });
});

it("reports a failed image upload and leaves the description as typed", async () => {
  vi.mocked(api.uploadKanbanImage).mockRejectedValue(
    "[Kanban/imageTooLarge] Les images sont limitées à 25 Mo.",
  );
  await openColumnDialog("Todo");
  await act(async () => {
    setInputValue(dialogTitle(), "Write the docs");
    setEditorText(dialogDescription(), "Steps");
  });

  await pasteImages(screenshot);

  expect(notifyError).toHaveBeenCalledWith("Images are limited to 25 MB.");
  expect(dialogDescription().state.sliceDoc()).toBe("Steps");
  expect(submitButton().disabled).toBe(false);
});

it("disables creation while the title is blank", async () => {
  await openColumnDialog("Todo");

  expect(submitButton().disabled).toBe(true);
  await act(async () => setInputValue(dialogTitle(), "   "));
  expect(submitButton().disabled).toBe(true);
  await pressKey(dialogTitle(), "Enter", { ctrlKey: true });
  await act(async () => setEditorText(dialogDescription(), "Steps"));
  await pressKey(dialogDescription().contentDOM, "Enter", { ctrlKey: true });

  expect(api.createKanbanIssue).not.toHaveBeenCalled();
  expect(createDialog()).not.toBeNull();
  expect(dialogDescription().state.sliceDoc()).toBe("Steps");
});

it("closes an open field popup on Escape before closing the dialog", async () => {
  await openColumnDialog("Todo");

  await act(async () => dialogField("Priority").click());
  const popup = document.querySelector('[role="listbox"]')!;
  await pressEscape(popup);
  expect(createDialog()).not.toBeNull();

  await act(async () => dialogField("Labels").click());
  const menu = document.querySelector('[role="menu"]')!;
  await pressEscape(menu);
  expect(createDialog()).not.toBeNull();

  await pressEscape(dialogTitle());
  expect(createDialog()).toBeNull();
  expect(document.activeElement).toBe(columnCreateButton("Todo"));
});

function agentButton(label: string) {
  return [...detailView()!.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  )!;
}

function agentSelect(label: string) {
  return detailView()!.querySelector<HTMLElement>(
    `[role="combobox"][aria-label="${label}"]`,
  )!;
}

const kanbanProject = { id: "sp1", name: "Soreno app" };

const expectedIssue: KanbanIssueAgentRequest["issue"] = {
  id: "i1",
  identifier: "ACM-1",
  title: "Ship the detail view",
  description: "Rendered **markdown**",
  branchName: "acm-1-ship-the-detail-view",
  source: "local",
};

it("starts an agent in the issue's project with the last preset, moving the issue to the first started state right away", async () => {
  localStorage.setItem("soreno.kanban.agentPreset.v1", "codex");
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [{ ...structuredClone(board.issues[0]), project: kanbanProject }],
  });
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ stateId: "doing", project: kanbanProject }),
  );
  let finish!: () => void;
  const onStartIssueAgent = vi.fn(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  await remountBoard({
    kanbanProjects: sorenoProjects,
    onStartIssueAgent,
    projects: sorenoProjects,
  });
  await tapCard();

  await act(async () => agentButton("Change").click());
  expect(document.activeElement).toBe(agentSelect("Agent"));
  expect(agentSelect("Soreno project")).toBeNull();
  expect(agentSelect("Agent").textContent).toBe("Codex");
  const [worktree, open] = detailView()!.querySelectorAll('[role="checkbox"]');
  expect(worktree.getAttribute("aria-checked")).toBe("true");
  expect(open.getAttribute("aria-checked")).toBe("false");
  await act(async () => agentButton("Start agent").click());

  expect(onStartIssueAgent).toHaveBeenCalledExactlyOnceWith({
    issue: expectedIssue,
    projectId: "sp1",
    executable: "codex",
    presetName: "Codex",
    worktree: true,
    open: false,
  });
  expect(agentButton("Starting…").disabled).toBe(true);
  expect(api.updateKanbanIssue).toHaveBeenCalledExactlyOnceWith("local", "i1", {
    stateId: "doing",
  });
  expect(
    container
      .querySelector('[data-kanban-state="doing"]')
      ?.contains(cardButton()),
  ).toBe(true);

  await act(async () => finish());
  expect(api.updateKanbanIssue).toHaveBeenCalledOnce();
});

it("keeps the state chosen while an agent starts when the start then fails", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [{ ...structuredClone(board.issues[0]), project: kanbanProject }],
  });
  vi.mocked(api.updateKanbanIssue).mockImplementation(
    async (_source, id, { stateId }) =>
      issueUpdate({
        id,
        stateId,
        project: kanbanProject,
        updatedAt: new Date().toISOString(),
      }),
  );
  const start = deferred<void>();
  const onStartIssueAgent = vi.fn().mockReturnValue(start.promise);
  await remountBoard({
    kanbanProjects: sorenoProjects,
    onStartIssueAgent,
    projects: sorenoProjects,
  });
  await tapCard();
  await act(async () => agentButton("Start agent").click());
  expect(onStartIssueAgent).toHaveBeenCalledOnce();

  await act(async () => detailStateSelect().click());
  const done = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === "Done")!;
  await act(async () => {
    done.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    done.click();
  });
  await pressEscape(document.body);
  expect(detailView()).toBeNull();
  await act(async () => start.reject(new Error("Could not start.")));

  expect(vi.mocked(api.updateKanbanIssue).mock.calls).toEqual([
    ["local", "i1", { stateId: "doing" }],
    ["local", "i1", { stateId: "done" }],
  ]);
});

async function moveToInProgressFromDetail(
  props: BoardProps,
  update: () => Promise<KanbanIssueUpdate> = async () =>
    issueUpdate({ stateId: "doing", project: kanbanProject }),
) {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [{ ...structuredClone(board.issues[0]), project: kanbanProject }],
  });
  vi.mocked(api.updateKanbanIssue).mockImplementation(update);
  await remountBoard({
    kanbanProjects: sorenoProjects,
    projects: sorenoProjects,
    ...props,
  });
  await tapCard();
  await act(async () => detailStateSelect().click());
  const inProgress = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === "In Progress")!;
  await act(async () => {
    inProgress.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    inProgress.click();
  });
  expect(api.updateKanbanIssue).toHaveBeenCalledExactlyOnceWith("local", "i1", {
    stateId: "doing",
  });
  return document.querySelector<HTMLElement>('[role="alertdialog"]');
}

function promptButton(prompt: HTMLElement, label: string) {
  return [...prompt.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  )!;
}

it("starts the issue's agent once moving it to the started state is confirmed", async () => {
  localStorage.setItem("soreno.kanban.agentPreset.v1", "codex");
  const onStartIssueAgent = vi.fn().mockResolvedValue(undefined);
  const prompt = await moveToInProgressFromDetail({ onStartIssueAgent });
  expect(prompt).not.toBeNull();
  expect(onStartIssueAgent).not.toHaveBeenCalled();

  await act(async () => promptButton(prompt!, "Start agent").click());

  expect(onStartIssueAgent).toHaveBeenCalledExactlyOnceWith({
    issue: expectedIssue,
    projectId: "sp1",
    executable: "codex",
    presetName: "Codex",
    worktree: true,
    open: false,
  });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(api.updateKanbanIssue).toHaveBeenCalledOnce();
});

it("keeps the moved issue without an agent when the start is declined", async () => {
  const onStartIssueAgent = vi.fn();
  const prompt = await moveToInProgressFromDetail({ onStartIssueAgent });

  await act(async () => promptButton(prompt!, "Not now").click());

  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(onStartIssueAgent).not.toHaveBeenCalled();
  expect(detailStateSelect().textContent).toBe("In Progress");
  expect(document.activeElement).toBe(detailView());
});

it("returns focus to the dragged card in its new column when the start is declined", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [{ ...structuredClone(board.issues[0]), project: kanbanProject }],
  });
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ stateId: "doing", project: kanbanProject }),
  );
  await remountBoard({
    kanbanProjects: sorenoProjects,
    projects: sorenoProjects,
  });
  // jsdom has no layout, so the pointer always lands on the In Progress column.
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => container.querySelector('[data-kanban-state="doing"]'),
  });
  onTestFinished(() => {
    Reflect.deleteProperty(document, "elementFromPoint");
  });
  const title = cardButton().querySelector(".kanban-card-title")!;
  await act(async () => {
    title.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    title.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 40 }),
    );
    title.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 40 }),
    );
  });
  const prompt = document.querySelector<HTMLElement>('[role="alertdialog"]');

  await act(async () => promptButton(prompt!, "Not now").click());

  expect(document.activeElement).toBe(
    container.querySelector(
      '[data-kanban-state="doing"] [data-kanban-issue="i1"]',
    ),
  );
  expect(document.activeElement).not.toBeNull();
});

it("withdraws the agent offer when moving the issue to the started state fails", async () => {
  const onStartIssueAgent = vi.fn();
  const prompt = await moveToInProgressFromDetail({ onStartIssueAgent }, () =>
    Promise.reject(new Error("Offline.")),
  );

  expect(prompt).toBeNull();
  expect(notifyError).toHaveBeenCalledWith("Offline.");
  expect(onStartIssueAgent).not.toHaveBeenCalled();
});

it("keeps the detail Start button busy while the confirmed agent starts", async () => {
  const start = deferred<void>();
  const onStartIssueAgent = vi.fn().mockReturnValue(start.promise);
  const prompt = await moveToInProgressFromDetail({ onStartIssueAgent });

  await act(async () => promptButton(prompt!, "Start agent").click());
  expect(onStartIssueAgent).toHaveBeenCalledOnce();
  const busy = agentButton("Starting…");
  expect(busy.disabled).toBe(true);
  await act(async () => busy.click());
  expect(onStartIssueAgent).toHaveBeenCalledOnce();

  await act(async () => start.resolve());
  expect(agentButton("Start agent").disabled).toBe(false);
});

it("offers no second agent when an issue with a running agent moves to the started state", async () => {
  const onStartIssueAgent = vi.fn();
  const prompt = await moveToInProgressFromDetail({
    issueSessions: [issueLink()],
    onStartIssueAgent,
    sessions: [linkedSession],
  });
  expect(prompt).toBeNull();
});

it("offers the agent before the move is saved, and withdraws it when one starts on the issue meanwhile", async () => {
  const move = deferred<KanbanIssueUpdate>();
  const onStartIssueAgent = vi.fn();
  const props: BoardProps = {
    kanbanProjects: sorenoProjects,
    onStartIssueAgent,
    projects: sorenoProjects,
  };
  expect(
    await moveToInProgressFromDetail(props, () => move.promise),
  ).not.toBeNull();
  await renderBoard({
    ...props,
    issueSessions: [issueLink()],
    sessions: [linkedSession],
  });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();

  await act(async () =>
    move.resolve(issueUpdate({ stateId: "doing", project: kanbanProject })),
  );

  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(onStartIssueAgent).not.toHaveBeenCalled();
});

const summaryStatus = (id: string): AgentSessionStatus => ({
  sessionId: "s1",
  state: "running",
  exitCode: null,
  issueSummary: { id, text: "Fixed it." },
});

const summaryComment = (id: string, body: string): KanbanComment => ({
  id,
  body,
  createdAt: "2026-09-27T10:00:00.000Z",
});

it("posts an agent's pending summary once, signed, and shows it as the agent's on the open issue in the confirmed state", async () => {
  const completion = deferred<KanbanIssueCompletion | null>();
  vi.mocked(agentApi.completeAgentKanbanIssue).mockReturnValue(
    completion.promise,
  );
  const linked = { issueSessions: [issueLink()], sessions: [linkedSession] };
  await remountBoard({ ...linked, statuses: [summaryStatus("turn-1")] });
  await renderBoard({ ...linked, statuses: [summaryStatus("turn-1")] });
  await tapCard();

  expect(agentApi.completeAgentKanbanIssue).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "turn-1",
    "Fixed it.\n\n— Codex via Soreno",
  );
  await act(async () =>
    completion.resolve({
      comment: storeComment(
        summaryComment("c2", "Fixed it.\n\n— Codex via Soreno"),
      ),
      update: issueUpdate({ stateId: "doing" }),
    }),
  );
  const comments = [...detailView()!.querySelectorAll(".kanban-issue-comment")];
  expect(comments).toHaveLength(2);
  expect(
    comments[1].querySelector(".kanban-issue-comment-author")?.textContent,
  ).toBe("Codex");
  expect(comments[1].querySelector(".kanban-markdown")?.textContent).toBe(
    "Fixed it.",
  );
  expect(
    comments.map((comment) =>
      [...comment.querySelectorAll("button")].some(
        (button) => button.textContent === "Send to the agent",
      ),
    ),
  ).toEqual([true, false]);
  expect(
    container
      .querySelector('[data-kanban-state="doing"]')
      ?.contains(cardButton()),
  ).toBe(true);
});

it("shows the open issue's agent summary when another issue's summary is posted in the same render", async () => {
  const completions = [
    deferred<KanbanIssueCompletion | null>(),
    deferred<KanbanIssueCompletion | null>(),
  ];
  vi.mocked(agentApi.completeAgentKanbanIssue)
    .mockReturnValueOnce(completions[0].promise)
    .mockReturnValueOnce(completions[1].promise);
  await remountBoard({
    issueSessions: [
      issueLink(),
      issueLink({
        sessionId: "s2",
        issueId: "i2",
        issueIdentifier: "ACM-2",
      }),
    ],
    sessions: [linkedSession, { ...linkedSession, id: "s2" }],
    statuses: [
      summaryStatus("turn-1"),
      { ...summaryStatus("turn-2"), sessionId: "s2" },
    ],
  });
  await tapCard();

  await act(async () => {
    completions[0].resolve({
      comment: storeComment(summaryComment("c2", "Fixed it.")),
      update: null,
    });
    completions[1].resolve({
      comment: summaryComment("c3", "Other issue fixed."),
      update: null,
    });
  });
  const comments = [
    ...detailView()!.querySelectorAll(".kanban-issue-comment"),
  ].map((comment) => comment.textContent);
  expect(comments).toHaveLength(2);
  expect(comments[1]).toContain("Fixed it.");
});

async function postSummary(comment: KanbanComment, props: BoardProps) {
  const completion = deferred<KanbanIssueCompletion | null>();
  vi.mocked(agentApi.completeAgentKanbanIssue).mockReturnValueOnce(
    completion.promise,
  );
  await renderBoard(props);
  await act(async () =>
    completion.resolve({ comment: storeComment(comment), update: null }),
  );
}

const shownComments = () =>
  [
    ...detailView()!.querySelectorAll(".kanban-issue-comment .kanban-markdown"),
  ].map((body) => body.textContent);

it("shows the extended body when a later summary of the session appends to its comment", async () => {
  const linked = { issueSessions: [issueLink()], sessions: [linkedSession] };
  await tapCard();
  await postSummary(summaryComment("c2", "Fixed it."), {
    ...linked,
    statuses: [summaryStatus("turn-1")],
  });
  expect(shownComments()).toEqual(["Looks good", "Fixed it."]);

  await postSummary(summaryComment("c2", "Fixed it.\n\nReviewed."), {
    ...linked,
    statuses: [summaryStatus("turn-2")],
  });
  expect(shownComments()).toEqual(["Looks good", "Fixed it.Reviewed."]);
});

it("keeps a summary comment updated meanwhile when another summary reaches the reopened issue", async () => {
  const linked = {
    issueSessions: [issueLink(), issueLink({ sessionId: "s2" })],
    sessions: [linkedSession, { ...linkedSession, id: "s2" }],
  };
  await tapCard();
  await postSummary(summaryComment("c2", "Fixed it."), {
    ...linked,
    statuses: [summaryStatus("turn-1")],
  });
  await pressEscape(document.body);
  storeComment(summaryComment("c2", "Updated meanwhile."));
  await tapCard();
  expect(shownComments()).toEqual(["Looks good", "Updated meanwhile."]);

  await postSummary(summaryComment("c3", "Also fixed."), {
    ...linked,
    statuses: [
      summaryStatus("turn-1"),
      { ...summaryStatus("turn-2"), sessionId: "s2" },
    ],
  });
  expect(shownComments()).toEqual([
    "Looks good",
    "Updated meanwhile.",
    "Also fixed.",
  ]);
});

it("shows on its card the pull request an agent summary links", async () => {
  linkPullRequest();
  await postSummary(summaryComment("c2", `Opened ${pullRequest.url}`), {
    issueSessions: [issueLink()],
    sessions: [linkedSession],
    statuses: [summaryStatus("turn-1")],
  });

  expect(
    cardButton()
      .closest(".kanban-card")!
      .querySelectorAll('button[aria-label="Open pull request #42"]'),
  ).toHaveLength(1);
});

it("names the issue whose agent summary could not be posted", async () => {
  vi.mocked(agentApi.completeAgentKanbanIssue).mockRejectedValue(
    new Error("Offline."),
  );
  await remountBoard({
    issueSessions: [issueLink()],
    sessions: [linkedSession],
    statuses: [summaryStatus("turn-2")],
  });

  expect(notifyError).toHaveBeenCalledWith(
    "The agent summary for ACM-1 could not be posted: Offline.",
  );
});

it("disables Start until the issue has a project, then starts the agent in it", async () => {
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ project: { id: "sp2", name: "Website" } }),
  );
  const onStartIssueAgent = vi.fn().mockResolvedValue(undefined);
  await remountBoard({
    kanbanProjects: sorenoProjects,
    onStartIssueAgent,
    projects: sorenoProjects,
  });
  await tapCard();

  expect(agentSelect("Soreno project")).toBeNull();
  expect(agentSelect("Agent").textContent).toBe("Pi");
  expect(agentButton("Start agent").disabled).toBe(true);

  await chooseOption(agentSelect("Project"), "Website");
  expect(agentButton("Start agent").disabled).toBe(false);
  await act(async () => agentButton("Start agent").click());

  expect(onStartIssueAgent).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "sp2", executable: "pi" }),
  );
});

it("disables Start while the issue's project cannot start an agent", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [
      {
        ...structuredClone(board.issues[0]),
        project: { id: "sp3", name: "Docs" },
      },
    ],
  });
  await remountBoard({
    kanbanProjects: sorenoProjects,
    projects: sorenoProjects,
  });
  await tapCard();

  expect(agentButton("Start agent").disabled).toBe(true);
});

it("names the issue's project by its current name, not the one loaded with the issue", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [
      {
        ...structuredClone(board.issues[0]),
        project: { id: "sp1", name: "Old name" },
      },
    ],
  });
  await remountBoard({ projects: sorenoProjects });
  await tapCard();

  expect(detailView()!.textContent).toContain("Pi in a Soreno app worktree");
  expect(detailView()!.textContent).not.toContain("Old name");
});

it("runs in the project itself when the worktree is unchecked and remembers the preset without moving a started issue", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [
      {
        ...structuredClone(board.issues[0]),
        stateId: "doing",
        project: kanbanProject,
      },
    ],
  });
  const onStartIssueAgent = vi.fn().mockResolvedValue(undefined);
  await remountBoard({ onStartIssueAgent, projects: sorenoProjects });
  await tapCard();

  await act(async () => agentButton("Change").click());
  await chooseOption(agentSelect("Agent"), "Claude Code");
  const [worktree, open] =
    detailView()!.querySelectorAll<HTMLElement>('[role="checkbox"]');
  await act(async () => worktree.click());
  await act(async () => open.click());
  await act(async () => agentButton("Start agent").click());

  expect(onStartIssueAgent).toHaveBeenCalledExactlyOnceWith({
    issue: expectedIssue,
    projectId: "sp1",
    executable: "claude",
    presetName: "Claude Code",
    worktree: false,
    open: true,
  });
  expect(localStorage.getItem("soreno.kanban.agentPreset.v1")).toBe("claude");
  expect(api.updateKanbanIssue).not.toHaveBeenCalled();
});

it("keeps the edited agent settings when the issue moves to a project", async () => {
  const docs: AgentProject = {
    id: "sp3",
    name: "Docs",
    path: "/work/docs",
    environment: { kind: "local", distribution: null },
  };
  vi.mocked(api.updateKanbanIssue).mockResolvedValue(
    issueUpdate({ project: { id: docs.id, name: docs.name } }),
  );
  const onStartIssueAgent = vi.fn().mockResolvedValue(undefined);
  await remountBoard({
    kanbanProjects: [...sorenoProjects, docs],
    onStartIssueAgent,
    projects: sorenoProjects,
  });
  await tapCard();

  const worktree =
    detailView()!.querySelector<HTMLElement>('[role="checkbox"]')!;
  await act(async () => worktree.click());
  await chooseOption(agentSelect("Project"), "Docs");

  expect(api.updateKanbanIssue).toHaveBeenCalledWith("local", "i1", {
    projectId: "sp3",
  });
  expect(
    detailView()!
      .querySelector('[role="checkbox"]')!
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(agentButton("Change")).toBeUndefined();
  await act(async () => agentButton("Start agent").click());

  expect(onStartIssueAgent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ projectId: "sp3", worktree: false }),
  );
});

it("keeps the form and reports the error when starting the agent fails", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [{ ...structuredClone(board.issues[0]), project: kanbanProject }],
  });
  vi.mocked(api.updateKanbanIssue).mockImplementation(
    async (_source, id, { stateId }) =>
      issueUpdate({
        id,
        stateId,
        project: kanbanProject,
        updatedAt: new Date().toISOString(),
      }),
  );
  const onStartIssueAgent = vi
    .fn()
    .mockRejectedValue(new Error("Could not create the worktree."));
  await remountBoard({ onStartIssueAgent, projects: sorenoProjects });
  await tapCard();

  await act(async () => agentButton("Change").click());
  await chooseOption(agentSelect("Agent"), "OMP");
  await act(async () => agentButton("Start agent").click());

  expect(notifyError).toHaveBeenCalledExactlyOnceWith(
    "Could not create the worktree.",
  );
  expect(onStartIssueAgent).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "sp1" }),
  );
  expect(agentSelect("Agent").textContent).toBe("OMP");
  expect(agentButton("Start agent").disabled).toBe(false);
  expect(localStorage.getItem("soreno.kanban.agentPreset.v1")).toBeNull();
  expect(detailStateSelect().textContent).toBe("Todo");
});

it("shows the linked agent session activity on the card and opens it from the detail", async () => {
  const onOpenSession = vi.fn();
  const props: BoardProps = {
    issueSessions: [issueLink()],
    onOpenSession,
    projects: sorenoProjects,
    sessions: [
      {
        id: "s1",
        projectId: "sp1",
        name: "ACM-1 · Codex",
        executable: "codex",
        args: [],
        createdAt: "2026-09-27T10:00:00.000Z",
      },
    ],
    statuses: [
      { sessionId: "s1", state: "running", exitCode: null, working: false },
    ],
  };
  await remountBoard(props);
  const indicator = () =>
    container
      .querySelector('[data-kanban-state="todo"] .kanban-card')!
      .querySelector(".kanban-chip-agent")!;

  expect(indicator().getAttribute("aria-label")).toBe(
    "Agent session: ACM-1 · Codex · Idle",
  );

  await renderBoard({
    ...props,
    statuses: [
      { sessionId: "s1", state: "running", exitCode: null, working: true },
    ],
  });
  expect(indicator().getAttribute("aria-label")).toBe(
    "Agent session: ACM-1 · Codex · Working",
  );
  await tapCard();

  await act(async () => agentButton("Open session").click());
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("s1");
});

it("shows a closed linked session as reopenable", async () => {
  const onOpenSession = vi.fn();
  await remountBoard({
    issueSessions: [issueLink()],
    closedSessionIds: new Set(["s1"]),
    onOpenSession,
    projects: sorenoProjects,
    sessions: [linkedSession],
    statuses: [{ sessionId: "s1", state: "exited", exitCode: 0 }],
  });
  await tapCard();

  await act(async () => agentButton("Reopen session").click());
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("s1");
});

it("shows how the last agent ended above the start form", async () => {
  await remountBoard({
    issueSessions: [
      issueLink({
        sessionId: null,
        projectName: "Website · acm-1",
        endedAt: "2026-09-28T09:00:00.000Z",
        endReason: "merged",
        mergedInto: "main",
      }),
    ],
    projects: sorenoProjects,
  });
  expect(
    container
      .querySelector('[data-kanban-state="todo"] .kanban-card')!
      .querySelector(".kanban-chip-agent"),
  ).toBeNull();
  await tapCard();

  const section = detailView()!.querySelector(".kanban-issue-agent")!;
  expect(section.textContent).toMatch(
    /^AgentACM-1 · CodexMerged into mainWebsite · acm-1.+Choose the issue’s project to start an agent\./,
  );
  expect(agentButton("Start agent")).toBeDefined();
  expect(agentButton("Open session")).toBeUndefined();
});

it("sends a comment to the running agent linked to the issue", async () => {
  let stored: AgentSessionMessage[] = [];
  vi.mocked(agentApi.sendAgentSessionMessage).mockImplementation(
    async (sessionId, messageId, body) => {
      stored = [
        {
          id: messageId,
          sessionId,
          body,
          status: "queued",
          error: null,
          createdAt: "2026-09-29T10:12:00Z",
          deliveredAt: null,
        },
      ];
      return stored[0];
    },
  );
  vi.mocked(agentApi.listAgentSessionMessages).mockImplementation(
    async () => stored,
  );
  const messageListeners: ((sessionId: string) => void)[] = [];
  vi.mocked(agentApi.listenAgentSessionMessages).mockImplementation(
    async (listener) => {
      messageListeners.push(listener);
      return () => {};
    },
  );
  const session = {
    id: "s1",
    projectId: "sp1",
    name: "ACM-1 · Codex",
    executable: "codex",
    args: [],
    createdAt: "2026-09-27T10:00:00.000Z",
  };
  await remountBoard({
    issueSessions: [issueLink()],
    projects: sorenoProjects,
    sessions: [session],
    statuses: [
      { sessionId: "s1", state: "exited", exitCode: 0, working: null },
    ],
  });
  await tapCard();
  const toAgent = () =>
    [...detailView()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Send to the agent",
    );
  expect(toAgent()).toBeUndefined();

  await renderBoard({
    issueSessions: [issueLink()],
    projects: sorenoProjects,
    sessions: [session],
    statuses: [
      { sessionId: "s1", state: "running", exitCode: null, working: true },
    ],
  });
  await act(async () => toAgent()!.click());

  const [sessionId, , body] = vi.mocked(agentApi.sendAgentSessionMessage).mock
    .calls[0];
  expect(sessionId).toBe("s1");
  expect(body.split("\n")[0]).toBe("Soreno: comment on ACM-1: Looks good");
  expect(
    detailView()!.querySelector(".kanban-issue-comment-agent-status")
      ?.textContent,
  ).toBe("Sent to “ACM-1 · Codex” · read when its turn ends");

  // The session stops before the agent read the comment: the failure must still show.
  stored = [{ ...stored[0], status: "failed", error: "session stopped" }];
  await renderBoard({
    issueSessions: [issueLink()],
    projects: sorenoProjects,
    sessions: [session],
    statuses: [
      { sessionId: "s1", state: "exited", exitCode: 0, working: null },
    ],
  });
  await act(async () => messageListeners.forEach((listener) => listener("s1")));
  expect(
    detailView()!.querySelector(".kanban-issue-comment-agent-status")
      ?.textContent,
  ).toBe("Not delivered to “ACM-1 · Codex”: session stopped");
  expect(toAgent()).toBeUndefined();
});

it("sends a comment of an unlinked issue to an agent of its project", async () => {
  vi.mocked(agentApi.sendAgentSessionMessage).mockImplementation(
    async (sessionId, messageId, body) => ({
      id: messageId,
      sessionId,
      body,
      status: "queued",
      error: null,
      createdAt: "2026-09-29T10:12:00Z",
      deliveredAt: null,
    }),
  );
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [{ ...structuredClone(board.issues[0]), project: kanbanProject }],
  });
  await remountBoard({
    kanbanProjects: sorenoProjects,
    projects: sorenoProjects,
    sessions: [
      {
        id: "pi-1",
        projectId: "sp1",
        name: "Pi",
        executable: "pi",
        args: [],
        createdAt: "2026-09-27T10:00:00.000Z",
      },
    ],
    statuses: [
      { sessionId: "pi-1", state: "running", exitCode: null, working: false },
    ],
  });
  await tapCard();
  const toAgent = [
    ...detailView()!.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Send to the agent")!;
  await act(async () => toAgent.click());

  expect(agentApi.sendAgentSessionMessage).toHaveBeenCalledWith(
    "pi-1",
    expect.any(String),
    expect.stringContaining("Soreno: comment on ACM-1"),
  );
});

it("offers a panel comment to no other agent while the issue's own agent is stopped", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [{ ...structuredClone(board.issues[0]), project: kanbanProject }],
  });
  const pi = { ...linkedSession, id: "pi-1", name: "Pi", executable: "pi" };
  await remountBoard({
    panelIssue: { id: "i1", identifier: "ACM-1", source: "local" },
    issueSessions: [issueLink()],
    kanbanProjects: sorenoProjects,
    projects: sorenoProjects,
    sessions: [linkedSession, pi],
    statuses: [
      { sessionId: "s1", state: "exited", exitCode: 0, working: null },
      { sessionId: "pi-1", state: "running", exitCode: null, working: false },
    ],
  });
  await tapCard();
  const toAgent = (view: Element) =>
    [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "Send to the agent",
    );

  await vi.waitFor(() => expect(toAgent(detailView()!)).toBeDefined());
  expect(toAgent(issuePanel())).toBeUndefined();
});

it("restores the chosen project filter after a remount", async () => {
  const website = { id: "sp2", name: "Website" };
  const boardWith = (
    projects: (typeof kanbanProject | null)[],
  ): KanbanBoardData => ({
    ...structuredClone(board),
    issues: projects.map((project, index) => ({
      ...structuredClone(board.issues[0]),
      id: `i${index + 1}`,
      identifier: `ACM-${index + 1}`,
      project,
    })),
  });
  const projectSelect = () =>
    container.querySelector<HTMLElement>(
      '[role="combobox"][aria-label="Project"]',
    )!;
  const visibleIssues = () =>
    [...container.querySelectorAll<HTMLElement>("[data-kanban-issue]")].map(
      (card) => card.dataset.kanbanIssue,
    );

  vi.mocked(api.loadKanbanBoard).mockResolvedValue(
    boardWith([kanbanProject, null]),
  );
  await remountBoard({});
  await chooseOption(projectSelect(), "Soreno app");
  expect(visibleIssues()).toEqual(["i1"]);

  await remountBoard({});
  expect(projectSelect().textContent).toBe("Soreno app");
  expect(visibleIssues()).toEqual(["i1"]);

  vi.mocked(api.loadKanbanBoard).mockResolvedValue(boardWith([website, null]));
  await remountBoard({});
  expect(projectSelect().textContent).toBe("All projects");
  expect(visibleIssues()).toEqual(["i1", "i2"]);

  vi.mocked(api.loadKanbanBoard).mockResolvedValue(
    boardWith([kanbanProject, null]),
  );
  await remountBoard({});
  expect(projectSelect().textContent).toBe("Soreno app");
});

it("creates a sub-issue in the issue's project and lists it once created", async () => {
  vi.mocked(api.loadKanbanBoard).mockResolvedValue({
    ...structuredClone(board),
    issues: [{ ...structuredClone(board.issues[0]), project: kanbanProject }],
  });
  vi.mocked(api.createKanbanIssue).mockResolvedValue({
    ...createdIssue,
    stateId: "todo",
    project: kanbanProject,
  });
  await remountBoard({ kanbanProjects: sorenoProjects });
  await tapCard();
  expect(detailView()!.textContent).not.toContain("Sub-issues");

  const trigger = detailView()!.querySelector<HTMLButtonElement>(
    '.agent-git-panel-header button[aria-label="New sub-issue"]',
  )!;
  await act(async () => trigger.click());
  expect(dialogField("Status").textContent).toBe("Todo");
  expect(dialogField("Project").textContent).toBe("Soreno app");
  const detail = await api.loadKanbanIssue("local", "i1");
  vi.mocked(api.loadKanbanIssue)
    .mockClear()
    .mockResolvedValue({
      ...detail,
      children: [
        {
          id: "i2",
          identifier: "ACM-2",
          title: "Write the docs",
          state: board.states[0],
        },
      ],
    });
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));
  await pressKey(dialogTitle(), "Enter", { ctrlKey: true });

  expect(api.createKanbanIssue).toHaveBeenCalledExactlyOnceWith("local", {
    teamId: "t1",
    title: "Write the docs",
    stateId: "todo",
    projectId: "sp1",
    parentId: "i1",
  });
  expect(createDialog()).toBeNull();
  expect(api.loadKanbanIssue).toHaveBeenCalledExactlyOnceWith("local", "i1");
  expect(
    detailView()!.querySelector(".kanban-issue-children")?.textContent,
  ).toBe("ACM-2Write the docs");
  expect(document.activeElement).toBe(trigger);
});

it("shows Linear issues next to local ones and moves them through Linear", async () => {
  const linearBoard: LinearKanbanBoard = {
    source: "linear",
    team: { id: "lt1", key: "ENG", name: "Engineering" },
    teams: [{ id: "lt1", key: "ENG", name: "Engineering" }],
    states: [
      {
        id: "lt-todo",
        name: "Todo",
        type: "unstarted",
        color: "#888",
        position: 0,
      },
      {
        id: "lt-review",
        name: "In Review",
        type: "started",
        color: "#888",
        position: 2,
      },
      {
        id: "lt-doing",
        name: "In Progress",
        type: "started",
        color: "#888",
        position: 1,
      },
      {
        id: "lt-done",
        name: "Done",
        type: "completed",
        color: "#888",
        position: 3,
      },
      {
        id: "lt-shipped",
        name: "Shipped",
        type: "completed",
        color: "#888",
        position: 4,
      },
    ],
    labels: [],
    issues: [
      {
        ...structuredClone(board.issues[0]),
        source: "linear",
        id: "li1",
        identifier: "ENG-7",
        title: "Fix the login",
        stateId: "lt-doing",
        url: "https://linear.app/acme/issue/ENG-7",
      },
    ],
    truncated: false,
  };
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(linearBoard);
  vi.mocked(api.updateKanbanIssue).mockResolvedValue({
    ...issueUpdate({ id: "li1", title: "Fix the login", stateId: "lt-done" }),
  });
  await remountBoard({});
  const linearCard = () =>
    container.querySelector<HTMLElement>('[data-kanban-issue="li1"]');

  expect(
    container
      .querySelector('[data-kanban-state="todo"]')
      ?.contains(cardButton()),
  ).toBe(true);
  expect(
    container
      .querySelector('[data-kanban-state="doing"]')
      ?.contains(linearCard()),
  ).toBe(true);
  const card = linearCard()!.closest("article")!;
  expect(card.textContent).toContain("ENG-7");

  // jsdom has no layout, so the pointer always lands on the Done column.
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => container.querySelector('[data-kanban-state="done"]'),
  });
  onTestFinished(() => {
    Reflect.deleteProperty(document, "elementFromPoint");
  });
  const title = linearCard()!.querySelector(".kanban-card-title")!;
  await act(async () => {
    title.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    title.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 40 }),
    );
    title.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 40 }),
    );
  });

  expect(api.updateKanbanIssue).toHaveBeenCalledExactlyOnceWith(
    "linear",
    "li1",
    {
      stateId: "lt-done",
    },
  );
  expect(
    container
      .querySelector('[data-kanban-state="done"]')
      ?.contains(linearCard()),
  ).toBe(true);

  const sources = container.querySelector('[aria-label="Issue source"]')!;
  const local = [...sources.querySelectorAll("button")].find(
    (button) => button.textContent === "Local",
  )!;
  await act(async () => local.click());

  expect(linearCard()).toBeNull();
  expect(cardButton()).not.toBeNull();
});

it("shows and remembers the Linear team of an issue opened from another team, and closes it on a team change", async () => {
  const engineering = { id: "lt1", key: "ENG", name: "Engineering" };
  const operations = { id: "lt2", key: "OPS", name: "Operations" };
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(api.loadLinearKanbanBoard).mockImplementation(async (teamId) => ({
    source: "linear",
    teams: [engineering, operations],
    team: teamId === operations.id ? operations : engineering,
    states: [],
    labels: [],
    issues: [],
    truncated: false,
  }));
  storedIssue = {
    ...storedIssue,
    source: "linear",
    id: "li9",
    identifier: "OPS-9",
    teamId: operations.id,
  };
  const issueRequest = {
    issue: { id: "li9", identifier: "OPS-9", source: "linear" as const },
  };

  await remountBoard({ issueRequest });

  await vi.waitFor(() =>
    expect(api.loadLinearKanbanBoard).toHaveBeenLastCalledWith(operations.id),
  );
  await remountBoard({});
  expect(api.loadLinearKanbanBoard).toHaveBeenLastCalledWith(operations.id);

  // Another team's board has no states or labels for this issue.
  await renderBoard({ issueRequest: { ...issueRequest } });
  await vi.waitFor(() => expect(detailView()).not.toBeNull());
  await chooseOption(
    container.querySelector<HTMLElement>('[aria-label="Linear team"]')!,
    engineering.name,
  );
  expect(detailView()).toBeNull();
  await vi.waitFor(() =>
    expect(api.loadLinearKanbanBoard).toHaveBeenLastCalledWith(engineering.id),
  );
});

it("follows the team of an issue opened during a Linear creation once the creation closes", async () => {
  const engineering = { id: "lt1", key: "ENG", name: "Engineering" };
  const operations = { id: "lt2", key: "OPS", name: "Operations" };
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(api.loadLinearKanbanBoard).mockImplementation(async (teamId) => ({
    source: "linear",
    teams: [engineering, operations],
    team: teamId === operations.id ? operations : engineering,
    states: [],
    labels: [],
    issues: [],
    truncated: false,
  }));
  const creation = deferred<KanbanIssue>();
  vi.mocked(api.createKanbanIssue).mockReturnValue(creation.promise);
  await remountBoard({});
  await openColumnDialog("Todo");
  await chooseOption(
    createDialog()!.querySelector<HTMLElement>(
      '[role="combobox"][aria-label="Destination"]',
    )!,
    "Engineering",
  );
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));
  await act(async () => submitButton().click());
  expect(api.createKanbanIssue).toHaveBeenCalledWith(
    "linear",
    expect.objectContaining({ teamId: engineering.id }),
  );

  storedIssue = {
    ...storedIssue,
    source: "linear",
    id: "li9",
    identifier: "OPS-9",
    teamId: operations.id,
  };
  await renderBoard({
    issueRequest: {
      issue: { id: "li9", identifier: "OPS-9", source: "linear" },
    },
  });
  expect(api.loadKanbanIssue).toHaveBeenLastCalledWith("linear", "li9");
  expect(createDialog()).not.toBeNull();
  expect(api.loadLinearKanbanBoard).not.toHaveBeenCalledWith(operations.id);

  await act(async () =>
    creation.resolve({ ...createdIssue, source: "linear", id: "li10" }),
  );

  expect(createDialog()).toBeNull();
  await vi.waitFor(() =>
    expect(api.loadLinearKanbanBoard).toHaveBeenLastCalledWith(operations.id),
  );
});

it("does not reload the Linear board after a Linear issue's content is saved", async () => {
  const engineering = { id: "lt1", key: "ENG", name: "Engineering" };
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue({
    source: "linear",
    teams: [engineering],
    team: engineering,
    states: [],
    labels: [],
    issues: [],
    truncated: false,
  });
  vi.mocked(api.createKanbanComment).mockImplementation(async (_, __, body) =>
    storeComment({ id: "c2", body, createdAt: "2026-09-27T10:00:00.000Z" }),
  );
  storedIssue = {
    ...storedIssue,
    source: "linear",
    id: "li1",
    identifier: "ENG-1",
    teamId: engineering.id,
  };
  await remountBoard({
    issueRequest: {
      issue: { id: "li1", identifier: "ENG-1", source: "linear" as const },
    },
  });
  await vi.waitFor(() => expect(commentField()).toBeTruthy());
  const boardLoads = vi.mocked(api.loadLinearKanbanBoard).mock.calls.length;

  await act(async () => setInputValue(commentField(), "Shipping today"));
  await pressKey(commentField(), "Enter", { ctrlKey: true });

  expect(api.createKanbanComment).toHaveBeenCalledWith(
    "linear",
    "li1",
    "Shipping today",
  );
  expect(api.loadLinearKanbanBoard).toHaveBeenCalledTimes(boardLoads);
});

it("reloads an open Linear issue once the board shows it changed in Linear", async () => {
  const engineering = { id: "lt1", key: "ENG", name: "Engineering" };
  const linearIssue: KanbanIssue = {
    ...structuredClone(board.issues[0]),
    source: "linear",
    id: "li1",
    identifier: "ENG-1",
    stateId: "lt-todo",
  };
  const linearBoard = (issue: KanbanIssue): LinearKanbanBoard => ({
    source: "linear",
    teams: [engineering],
    team: engineering,
    states: [
      {
        id: "lt-todo",
        name: "Todo",
        type: "unstarted",
        color: "#888",
        position: 0,
      },
    ],
    labels: [],
    issues: [issue],
    truncated: false,
  });
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
    linearBoard(linearIssue),
  );
  storedIssue = {
    ...storedIssue,
    source: "linear",
    id: "li1",
    identifier: "ENG-1",
    teamId: engineering.id,
    description: "Before the edit",
  };
  await remountBoard({
    issueRequest: {
      issue: { id: "li1", identifier: "ENG-1", source: "linear" as const },
    },
  });
  await vi.waitFor(() =>
    expect(detailView()?.textContent).toContain("Before the edit"),
  );
  const issueLoads = vi.mocked(api.loadKanbanIssue).mock.calls.length;

  const editedAt = "2026-09-30T10:00:00.000Z";
  storedIssue = {
    ...storedIssue,
    description: "Edited by a colleague",
    updatedAt: editedAt,
  };
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue(
    linearBoard({ ...linearIssue, updatedAt: editedAt }),
  );
  await act(async () => window.dispatchEvent(new Event("focus")));

  await vi.waitFor(() =>
    expect(detailView()?.textContent).toContain("Edited by a colleague"),
  );
  expect(api.loadKanbanIssue).toHaveBeenCalledTimes(issueLoads + 1);
  expect(api.loadKanbanIssue).toHaveBeenLastCalledWith("linear", "li1");
});

it("converts the draft to Linear when the destination changes", async () => {
  const engineering = { id: "lt1", key: "ENG", name: "Engineering" };
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue({
    source: "linear",
    teams: [engineering],
    team: engineering,
    states: [
      {
        id: "lt-todo",
        name: "Todo",
        type: "unstarted",
        color: "#888",
        position: 0,
      },
      {
        id: "lt-doing",
        name: "In Progress",
        type: "started",
        color: "#888",
        position: 1,
      },
      {
        id: "lt-done",
        name: "Done",
        type: "completed",
        color: "#888",
        position: 2,
      },
    ],
    labels: [{ id: "ll1", name: "Bug", color: "#e5484d" }],
    issues: [],
    truncated: false,
  });
  vi.mocked(api.createKanbanIssue).mockResolvedValue(createdIssue);
  await remountBoard({
    kanbanProjects: sorenoProjects,
    linearProjectLinks: [{ projectId: "sp1", linearProjectId: "lp1" }],
  });
  await openColumnDialog("In Progress");

  await chooseOption(dialogField("Project"), "Soreno app");
  await act(async () => dialogField("Labels").click());
  const bug = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
  ].find((item) => item.textContent === "Bug")!;
  await act(async () => {
    bug.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    bug.click();
  });
  await pressEscape(bug);
  await chooseOption(
    createDialog()!.querySelector<HTMLElement>(
      '[role="combobox"][aria-label="Destination"]',
    )!,
    "Engineering",
  );
  await act(async () => setInputValue(dialogTitle(), "Write the docs"));
  await act(async () => submitButton().click());

  expect(api.createKanbanIssue).toHaveBeenCalledExactlyOnceWith("linear", {
    teamId: "lt1",
    title: "Write the docs",
    stateId: "lt-doing",
    projectId: "sp1",
  });
});

it("reloads Linear when a project link changes, not when the same links are passed again", async () => {
  vi.mocked(api.hasLinearApiKey).mockResolvedValue(true);
  vi.mocked(api.loadLinearKanbanBoard).mockResolvedValue({
    source: "linear",
    teams: [{ id: "lt1", key: "ENG", name: "Engineering" }],
    team: { id: "lt1", key: "ENG", name: "Engineering" },
    states: [],
    labels: [],
    issues: [],
    truncated: false,
  });
  const link = { projectId: "sp1", linearProjectId: "lp1" };
  await remountBoard({ linearProjectLinks: [link] });
  const loads = () => vi.mocked(api.loadLinearKanbanBoard).mock.calls.length;
  const loaded = loads();
  const localLoads = vi.mocked(api.loadKanbanBoard).mock.calls.length;

  await renderBoard({ linearProjectLinks: [{ ...link }] });
  expect(loads()).toBe(loaded);

  await renderBoard({
    linearProjectLinks: [{ ...link, linearProjectId: "lp2" }],
  });
  expect(loads()).toBe(loaded + 1);
  expect(api.loadKanbanBoard).toHaveBeenCalledTimes(localLoads);
});
