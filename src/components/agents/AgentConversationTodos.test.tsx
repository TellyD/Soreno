// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { AgentConversationTodoPhase } from "../../domain/agentConversation";
import { AgentConversationTodos } from "./AgentConversationTodos";
import { agentStringsForLocale } from "./agentStrings";

const s = agentStringsForLocale("en").conversation;
let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(phases: AgentConversationTodoPhase[]) {
  act(() => root!.render(<AgentConversationTodos phases={phases} s={s} />));
}

const closeButton = () =>
  host!.querySelector<HTMLButtonElement>(`[aria-label="${s.todosClose}"]`);

it("hides finished tasks until the list changes", () => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const finished = (): AgentConversationTodoPhase[] => [
    { name: "Fix", tasks: [{ content: "Patch", status: "completed" }] },
  ];

  render([{ name: "Fix", tasks: [{ content: "Patch", status: "in_progress" }] }]);
  expect(closeButton()).toBeNull();

  render(finished());
  act(() => closeButton()!.click());
  expect(host.textContent).toBe("");

  // OMP's `get_state` resends the same list as a new array.
  render(finished());
  expect(host.textContent).toBe("");

  render([
    ...finished(),
    { name: "Next", tasks: [{ content: "Ship", status: "pending" }] },
  ]);
  expect(host.textContent).toContain(s.todos);
});
