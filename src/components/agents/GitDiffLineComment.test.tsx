// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as agentApi from "../../data/agentSessionsApi";
import type { AgentSessionMessage } from "../../domain/agentSessions";
import type { GitComparison } from "../../domain/projectGit";
import { clearNotifications, getNotifications } from "../../notifications";
import { deferred } from "../../testing/deferred";
import { stubEditorGeometry } from "../markdown-editor/testGeometry";
import { GitChangesDiffContent } from "./GitChangesWorkspace";
import type { GitDiffCommentTarget } from "./GitDiffLineComment";
import { stubModalSelector } from "../ui/testTopLayer";
import { setInputValue } from "../ui/testInput";

vi.mock("../../i18n", () => ({ useI18n: () => ({ locale: "fr-FR" }) }));
vi.mock("../../theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "light" }),
}));
vi.mock("../../data/agentSessionsApi", () => ({
  sendAgentSessionMessage: vi.fn(),
  listAgentSessionMessages: vi.fn(),
  listenAgentSessionMessages: vi.fn(),
}));

const text = (value: string) => ({
  text: value,
  oid: "a",
  size: value.length,
  mode: "100644",
  reason: null,
});
const before = "const total = 1;\nconst kept = 2;\n";
const after =
  "const total = 1;\nconst kept = 2;\nconst average = total / count;\nreturn average;\n";
const comparison: GitComparison = {
  path: "src/value.ts",
  oldPath: null,
  version: "v1",
  before: text(before),
  after: text(after),
};
const claude: GitDiffCommentTarget = {
  sessionId: "claude-1",
  projectId: "p1",
  name: "Claude",
  executable: "claude",
};
const queued = (id = "m1"): AgentSessionMessage => ({
  id,
  sessionId: "claude-1",
  body: "",
  status: "queued",
  error: null,
  createdAt: "2026-09-29T10:12:00Z",
  deliveredAt: null,
});
let stored: AgentSessionMessage[];
let emit: (sessionId: string) => void;
let container: HTMLDivElement;
let root: Root;
let restoreGeometry: () => void;

beforeEach(() => {
  stubModalSelector();
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  restoreGeometry = stubEditorGeometry();
  vi.mocked(agentApi.sendAgentSessionMessage).mockReset();
  stored = [];
  vi.mocked(agentApi.listAgentSessionMessages).mockImplementation(async () =>
    structuredClone(stored),
  );
  vi.mocked(agentApi.listenAgentSessionMessages).mockImplementation(
    async (onChange) => {
      emit = onChange;
      return () => {};
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreGeometry();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearNotifications();
});

async function render(
  targets?: readonly GitDiffCommentTarget[],
  shown: GitComparison = comparison,
) {
  await act(async () =>
    root.render(
      <GitChangesDiffContent
        comparison={shown}
        loading={false}
        navigation={null}
        side="unstaged"
        commentTargets={targets}
      >
        {null}
      </GitChangesDiffContent>,
    ),
  );
}

function editor() {
  return EditorView.findFromDOM(container.querySelector(".cm-content")!)!;
}

/** Drags from the start of `fromLine` to the start of `endLine`, as a mouse selection would. */
async function select(fromLine: number, endLine: number) {
  const doc = editor().state.doc;
  await act(async () =>
    editor().dispatch({
      selection: {
        anchor: doc.line(fromLine).from,
        head: doc.line(endLine).from,
      },
    }),
  );
}

function commentButton() {
  return document.querySelector<HTMLButtonElement>(".git-diff-comment-send");
}

/** Points at the text of `line`, below any block widget sharing its line block. */
function pointer(type: string, line: number, target: EventTarget, buttons = 1) {
  const view = editor();
  const clientY =
    view.documentTop +
    view.lineBlockAt(view.state.doc.line(line).from).bottom -
    1;
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, button: 0, buttons, clientY }),
  );
}

async function write(value: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    setInputValue(textarea, value);
  });
}

it("comments whole selected lines and sends them to the project's agent", async () => {
  vi.mocked(agentApi.sendAgentSessionMessage).mockResolvedValue(queued());
  await render([claude]);
  expect(commentButton()).toBeNull();

  await select(3, 5);
  await act(async () => commentButton()!.click());
  await write("Gère le cas vide.");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '.git-diff-comment button[type="submit"]',
      )!
      .click(),
  );

  const [sessionId, , body] = vi.mocked(agentApi.sendAgentSessionMessage).mock
    .calls[0];
  expect(sessionId).toBe("claude-1");
  expect(body.split("\n")[0]).toBe(
    "Soreno comment on src/value.ts lines 3-4: Gère le cas vide.",
  );
  expect(body).toContain(
    "```\nconst average = total / count;\nreturn average;\n```",
  );
  expect(container.querySelector("textarea")?.value).toBe("");
});

it("comments the lines dragged over from the gutter's plus", async () => {
  vi.mocked(agentApi.sendAgentSessionMessage).mockResolvedValue(queued());
  await render([claude]);
  await act(async () => pointer("mousemove", 3, editor().dom));
  const add = container.querySelector(".git-diff-comment-add")!;
  await act(async () => {
    pointer("mousedown", 3, add);
    pointer("mousemove", 4, window);
    pointer("mouseup", 4, window);
  });
  await write("Nommer la moyenne.");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '.git-diff-comment button[type="submit"]',
      )!
      .click(),
  );

  const [, , body] = vi.mocked(agentApi.sendAgentSessionMessage).mock.calls[0];
  expect(body.split("\n")[0]).toBe(
    "Soreno comment on src/value.ts lines 3-4: Nommer la moyenne.",
  );
});

it("drops a gutter drag released outside the window", async () => {
  await render([claude]);
  await act(async () => pointer("mousemove", 3, editor().dom));
  const add = container.querySelector(".git-diff-comment-add")!;
  await act(async () => {
    pointer("mousedown", 3, add);
    pointer("mousemove", 4, window, 0);
    pointer("mouseup", 4, window, 0);
  });

  expect(container.querySelector("textarea")).toBeNull();
});

it("asks to reselect lines once the diff changed, keeping the draft", async () => {
  vi.mocked(agentApi.sendAgentSessionMessage).mockResolvedValue(queued());
  await render([claude]);
  await select(3, 5);
  await act(async () => commentButton()!.click());
  await write("Gère le cas vide.");

  await render([claude], {
    ...comparison,
    version: "v2",
    after: text(`// total\n${after}`),
  });
  const send = container.querySelector<HTMLButtonElement>(
    '.git-diff-comment button[type="submit"]',
  )!;
  expect(send.disabled).toBe(true);
  expect(container.textContent).toContain(
    "Le diff a changé : resélectionnez les lignes.",
  );

  await select(4, 6);
  await act(async () => commentButton()!.click());
  expect(container.textContent).not.toContain("Le diff a changé");
  expect(container.querySelector("textarea")?.value).toBe("Gère le cas vide.");
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  const [, , body] = vi.mocked(agentApi.sendAgentSessionMessage).mock.calls[0];
  expect(body.split("\n")[0]).toBe(
    "Soreno comment on src/value.ts lines 4-5: Gère le cas vide.",
  );
  expect(body).toContain(
    "```\nconst average = total / count;\nreturn average;\n```",
  );
});

it("keeps the draft while another comparison is shown", async () => {
  await render([claude]);
  await select(3, 5);
  await act(async () => commentButton()!.click());
  await write("Gère le cas vide.");

  await render([claude], { ...comparison, path: "src/other.ts" });
  expect(container.querySelector(".git-diff-comment")).toBeNull();
  await render([claude]);
  expect(container.querySelector("textarea")?.value).toBe("Gère le cas vide.");
});

it("confirms a send only for the lines it contained", async () => {
  const send = deferred<AgentSessionMessage>();
  vi.mocked(agentApi.sendAgentSessionMessage).mockReturnValue(send.promise);
  await render([claude]);
  await select(3, 5);
  await act(async () => commentButton()!.click());
  await write("Gère le cas vide.");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '.git-diff-comment button[type="submit"]',
      )!
      .click(),
  );

  await select(1, 2);
  await act(async () => commentButton()!.click());
  expect(
    container.querySelector(".git-diff-comment-header")?.textContent,
  ).toContain("L1");
  await act(async () => send.resolve(queued()));
  expect(container.textContent).not.toContain("Envoyé à");
  expect(container.querySelector("textarea")?.value).toBe("");
});

it("keeps a new draft when an earlier comment's send completes", async () => {
  const send = deferred<AgentSessionMessage>();
  vi.mocked(agentApi.sendAgentSessionMessage).mockReturnValue(send.promise);
  await render([claude]);
  await select(3, 5);
  await act(async () => commentButton()!.click());
  await write("Gère le cas vide.");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '.git-diff-comment button[type="submit"]',
      )!
      .click(),
  );
  await act(async () => {
    container
      .querySelector("textarea")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
  });
  expect(container.querySelector(".git-diff-comment")).toBeNull();

  await select(1, 2);
  await act(async () => commentButton()!.click());
  await write("Renomme total.");
  await act(async () => send.resolve(queued()));
  expect(container.querySelector("textarea")?.value).toBe("Renomme total.");
});

it("starts an empty draft when commenting another file", async () => {
  await render([claude]);
  await select(3, 5);
  await act(async () => commentButton()!.click());
  await write("Gère le cas vide.");

  await render([claude], { ...comparison, path: "src/other.ts" });
  await select(3, 5);
  await act(async () => commentButton()!.click());
  expect(
    container.querySelector(".git-diff-comment-header")?.textContent,
  ).toContain("other.ts");
  expect(container.querySelector("textarea")?.value).toBe("");
});

it("keeps the composer open when Escape ends an IME composition", async () => {
  await render([claude]);
  await select(3, 5);
  await act(async () => commentButton()!.click());
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  expect(container.querySelector(".git-diff-comment")).not.toBeNull();
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(container.querySelector(".git-diff-comment")).toBeNull();
});

it("keeps the remark when sending fails", async () => {
  vi.mocked(agentApi.sendAgentSessionMessage).mockRejectedValue(
    "Démarrez la session avant de lui écrire.",
  );
  await render([claude]);
  await select(3, 4);
  await act(async () => commentButton()!.click());
  await write("À garder");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '.git-diff-comment button[type="submit"]',
      )!
      .click(),
  );
  expect(container.querySelector("textarea")?.value).toBe("À garder");
  expect(getNotifications()).toContainEqual(
    expect.objectContaining({
      message: "Démarrez la session avant de lui écrire.",
    }),
  );
});

it("explains that an agent must run before a comment can be sent", async () => {
  await render([]);
  await select(3, 4);
  await act(async () => commentButton()!.click());
  await write("Sans agent");
  expect(container.textContent).toContain(
    "Lancez un agent dans ce projet pour lui envoyer un commentaire.",
  );
  expect(
    container.querySelector<HTMLButtonElement>(
      '.git-diff-comment button[type="submit"]',
    )!.disabled,
  ).toBe(true);
});

it("offers no comment action without agent context", async () => {
  await render(undefined);
  await select(3, 4);
  expect(commentButton()).toBeNull();
});

it("follows the sent comment until the agent receives it", async () => {
  vi.mocked(agentApi.sendAgentSessionMessage).mockImplementation(
    async (_sessionId, messageId) => {
      stored = [{ ...queued(messageId) }];
      return queued(messageId);
    },
  );
  await render([claude]);
  await select(3, 5);
  await act(async () => commentButton()!.click());
  await write("Gère le cas vide.");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '.git-diff-comment button[type="submit"]',
      )!
      .click(),
  );
  const status = () =>
    container.querySelector<HTMLElement>(".git-diff-comment-sent")!;
  expect(status().textContent).toBe(
    "Envoyé à « Claude » · lu à la fin de son tour",
  );

  stored = [{ ...stored[0], status: "delivered" }];
  await act(async () => emit("other-session"));
  expect(status().dataset.status).toBe("queued");
  await act(async () => emit("claude-1"));
  expect(status().textContent).toBe("Livré à « Claude »");

  stored = [
    {
      ...stored[0],
      status: "failed",
      error: "Session arrêtée avant la livraison.",
    },
  ];
  await act(async () => emit("claude-1"));
  expect(status().textContent).toBe(
    "Non livré à « Claude » : Session arrêtée avant la livraison.",
  );
});
