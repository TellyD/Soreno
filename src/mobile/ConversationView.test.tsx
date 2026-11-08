// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationView } from "./ConversationView";
import { appendItems, resetConversation } from "./conversation";
import { mobileStrings } from "./mobileStrings";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("explains that a session without conversation is only visible on the computer", async () => {
  const conversation = resetConversation({
    provider: null,
    available: false,
    truncated: false,
  });
  await act(async () =>
    root.render(
      <ConversationView
        conversation={conversation}
        working={false}
        strings={mobileStrings.fr}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "Pas de conversation pour cette session",
  );
  expect(container.querySelector("[role=log]")).toBeNull();
});

it("shows a Chat without history yet as an empty conversation", async () => {
  const conversation = resetConversation({
    provider: "omp",
    available: false,
    truncated: false,
    rpc: true,
  });
  await act(async () =>
    root.render(
      <ConversationView
        conversation={conversation}
        working={false}
        strings={mobileStrings.fr}
      />,
    ),
  );
  expect(container.querySelector("[role=log]")?.textContent).toContain(
    "Aucun message pour l’instant.",
  );
  expect(container.textContent).not.toContain(
    "Pas de conversation pour cette session",
  );
});

it("hides tool calls on request but still asks for a reply", async () => {
  const conversation = appendItems(
    resetConversation({ provider: "omp", available: true, truncated: false }),
    [
      { kind: "user", id: "u", text: "Lance les tests", images: 0 },
      { kind: "assistant", id: "a", text: "Je les lance." },
      {
        kind: "tool",
        id: "call",
        name: "bash",
        action: "run",
        subject: "npm test",
      },
    ],
  );
  await act(async () =>
    root.render(
      <ConversationView
        conversation={conversation}
        working={false}
        toolsHidden
        strings={mobileStrings.fr}
      />,
    ),
  );
  const log = container.querySelector("[role=log]")?.textContent;
  expect(log).toContain("Lance les tests");
  expect(log).toContain("Je les lance.");
  expect(log).not.toContain("npm test");
  expect(container.querySelector(".mobile-awaiting")).not.toBeNull();
});

it("lets the keyboard reach the scrolling history", async () => {
  const conversation = resetConversation({
    provider: "omp",
    available: true,
    truncated: false,
  });
  await act(async () =>
    root.render(
      <ConversationView
        conversation={conversation}
        working={false}
        strings={mobileStrings.en}
      />,
    ),
  );
  const scroller = container.querySelector<HTMLElement>(
    "[aria-label='Conversation history']",
  );
  expect(scroller?.tabIndex).toBe(0);
});
