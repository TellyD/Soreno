// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as agentApi from "../../data/agentSessionsApi";
import { I18nProvider } from "../../i18n";
import { KanbanCommentToAgent } from "./KanbanCommentToAgent";

vi.mock("../../settings", () => ({
  useAppSettings: () => ({
    settings: { languagePreference: "fr" },
    updateSettings: vi.fn(),
  }),
}));
// Base UI positioning is very slow in jsdom: render the menu inline. The factory is hoisted
// above static imports, hence the dynamic one.
vi.mock("@base-ui/react/menu", async () => {
  const { cloneElement } = await import("react");
  const Pass = ({ children }: { children: ReactNode }) => children;
  return {
    Menu: {
      Root: Pass,
      Portal: Pass,
      Positioner: Pass,
      Trigger: ({ render }: { render: ReactElement }) => render,
      Popup: ({
        render,
        children,
      }: {
        render: ReactElement;
        children: ReactNode;
      }) => cloneElement(render, {}, children),
      Item: ({
        render,
        children,
        onClick,
      }: {
        render: ReactElement;
        children: ReactNode;
        onClick: () => void;
      }) => cloneElement(render, { onClick } as never, children),
    },
  };
});
vi.mock("../../data/agentSessionsApi", () => ({
  sendAgentSessionMessage: vi.fn(),
  listAgentSessionMessages: vi.fn(async () => []),
  listenAgentSessionMessages: vi.fn(async () => () => {}),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

it("lets the user choose which running agent receives the comment", async () => {
  await act(async () =>
    root.render(
      <I18nProvider>
        <KanbanCommentToAgent
          issue={{ identifier: "ACM-1", title: "Verrou" }}
          comment={{
            id: "c1",
            body: "Couvre WSL",
            createdAt: "2026-09-29T10:00:00Z",
          }}
          targets={[
            {
              sessionId: "claude-1",
              name: "ACM-1 · Claude",
              executable: "claude",
              linkedToIssue: true,
            },
            {
              sessionId: "pi-1",
              name: "Pi",
              executable: "pi",
              linkedToIssue: false,
            },
          ]}
        />
      </I18nProvider>,
    ),
  );
  expect(agentApi.sendAgentSessionMessage).not.toHaveBeenCalled();
  const items = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual([
    "ACM-1 · Claude",
    "Pi",
  ]);
  await act(async () => items[1].click());

  expect(agentApi.sendAgentSessionMessage).toHaveBeenCalledExactlyOnceWith(
    "pi-1",
    expect.any(String),
    expect.stringContaining("Couvre WSL"),
  );
  // Pi is not the issue's own session: its summary would land on another issue.
  expect(
    vi.mocked(agentApi.sendAgentSessionMessage).mock.calls[0][2],
  ).not.toContain("<soreno-summary>");
});
