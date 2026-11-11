import { expect, it } from "vitest";
import { agentConversationPrompt } from "./agentConversationAttachments";
import {
  agentConversationHistory,
  recallAgentConversationMessage,
} from "./agentConversationHistory";

it("keeps what the user typed, without files, blanks, repeats or Soreno's messages", () => {
  const user = (id: number, text: string) => ({
    id,
    role: "user" as const,
    text,
    images: [],
  });
  expect(
    agentConversationHistory({
      entries: [
        user(
          1,
          agentConversationPrompt("voir", [{ name: "a.ts", content: "x" }]),
        ),
        { id: 2, role: "notice", notice: { kind: "aborted" } } as never,
        user(3, "  "),
        user(6, "Soreno: Kanban issue SOR-1 updated."),
        user(4, "suite"),
        user(5, "suite"),
      ],
      queued: [
        { text: "suite", queue: "followUp", live: false },
        { text: "/compact", queue: "followUp", live: false },
      ],
    }),
  ).toEqual(["voir", "suite", "/compact"]);
});

const history = ["a", "b"];

it.each([
  [
    "starts from the newest",
    null,
    "x",
    "ArrowUp",
    { recall: { index: 1, text: "b", stash: "x" }, text: "b" },
  ],
  [
    "goes back",
    { index: 1, text: "b", stash: "x" },
    "b",
    "ArrowUp",
    { recall: { index: 0, text: "a", stash: "x" }, text: "a" },
  ],
  [
    "stops at the oldest",
    { index: 0, text: "a", stash: "x" },
    "a",
    "ArrowUp",
    null,
  ],
  [
    "comes forward",
    { index: 0, text: "a", stash: "x" },
    "a",
    "ArrowDown",
    { recall: { index: 1, text: "b", stash: "x" }, text: "b" },
  ],
  [
    "restores the draft past the newest",
    { index: 1, text: "b", stash: "x" },
    "b",
    "ArrowDown",
    { recall: null, text: "x" },
  ],
  ["leaves ↓ alone when not browsing", null, "x", "ArrowDown", null],
  [
    "browses again from an edited recall",
    { index: 1, text: "b", stash: "x" },
    "b!",
    "ArrowUp",
    { recall: { index: 1, text: "b", stash: "b!" }, text: "b" },
  ],
  [
    "leaves ↓ alone on an edited recall",
    { index: 0, text: "a", stash: "x" },
    "a!",
    "ArrowDown",
    null,
  ],
  // [a, cancelled, b] shrank to [a, b] while b was recalled.
  [
    "restores the draft after the history shrank",
    { index: 2, text: "b", stash: "x" },
    "b",
    "ArrowDown",
    { recall: null, text: "x" },
  ],
  [
    "goes back after the history shrank",
    { index: 2, text: "b", stash: "x" },
    "b",
    "ArrowUp",
    { recall: { index: 0, text: "a", stash: "x" }, text: "a" },
  ],
  [
    "restores the draft once the recall left the history",
    { index: 1, text: "z", stash: "x" },
    "z",
    "ArrowDown",
    { recall: null, text: "x" },
  ],
] as const)("%s", (_case, recall, draft, key, expected) => {
  expect(recallAgentConversationMessage(history, recall, draft, key)).toEqual(
    expected,
  );
});

it("leaves ↑ alone without history", () => {
  expect(recallAgentConversationMessage([], null, "x", "ArrowUp")).toBeNull();
});
