import { describe, expect, it } from "vitest";
import {
  appendItems,
  awaitingReply,
  conversationMessage,
  resetConversation,
  toolLabel,
  type ToolCall,
} from "./conversation";
import { mobileStrings } from "./mobileStrings";

const start = resetConversation({
  provider: "omp",
  available: true,
  truncated: false,
});

const read: ToolCall = {
  kind: "tool",
  id: "call-1",
  name: "read",
  action: "read",
  subject: "src/main.ts",
};

const ask: ToolCall = {
  kind: "tool",
  id: "call-2",
  name: "AskUserQuestion",
  action: "ask",
  subject: "Quelle option ?",
};

describe("conversation", () => {
  it("attaches a result to its call, even from a later batch", () => {
    const first = appendItems(start, [
      { kind: "user", id: "u", text: "Lis main", images: 0 },
      read,
    ]);
    const next = appendItems(first, [
      { kind: "toolResult", id: "call-1", error: true, text: "ENOENT" },
      { kind: "assistant", id: "a", text: "Fichier absent." },
    ]);
    expect(next.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
    expect(next.entries[1]).toEqual({
      ...read,
      result: { kind: "toolResult", id: "call-1", error: true, text: "ENOENT" },
    });
    expect(first.entries[1]).toEqual({ ...read, result: null });
  });

  it("drops a result whose call predates the history shown", () => {
    const next = appendItems(start, [
      { kind: "toolResult", id: "old", error: false, text: "ok" },
    ]);
    expect(next.entries).toEqual([]);
  });

  it("expects a reply when the agent stopped on a call without result", () => {
    const permission = appendItems(start, [read]).entries;
    expect(awaitingReply(permission, false)).toBe(true);
    expect(awaitingReply(permission, null)).toBe(true);
    expect(awaitingReply(permission, true)).toBe(false);
  });

  it("expects a reply to a question even while the agent reports work", () => {
    const question = appendItems(start, [read, ask]).entries;
    expect(awaitingReply(question, true)).toBe(true);
    const answered = appendItems(start, [
      ask,
      { kind: "toolResult", id: "call-2", error: false, text: "B" },
      read,
    ]).entries;
    expect(awaitingReply(answered, true)).toBe(false);
  });

  it("expects no reply once the calls are answered or the agent spoke after them", () => {
    const answered = appendItems(start, [
      read,
      { kind: "toolResult", id: "call-1", error: false, text: "" },
    ]).entries;
    expect(awaitingReply(answered, false)).toBe(false);
    const spoke = appendItems(start, [
      read,
      { kind: "assistant", id: "a", text: "Terminé." },
    ]).entries;
    expect(awaitingReply(spoke, false)).toBe(false);
    expect(awaitingReply([], false)).toBe(false);
  });

  it("names tool calls by their action", () => {
    expect(toolLabel(read, mobileStrings.fr)).toBe("a lu");
    expect(toolLabel({ ...read, action: "run" }, mobileStrings.en)).toBe("ran");
    expect(
      toolLabel(
        { ...read, name: "todo_write", action: "other" },
        mobileStrings.fr,
      ),
    ).toBe("a utilisé todo_write");
    expect(
      toolLabel(
        { ...read, name: "lsp", action: "future" as "other" },
        mobileStrings.en,
      ),
    ).toBe("used lsp");
  });

  it("sends a message as a protected paste then Enter, or as an RPC prompt line for a chat", () => {
    expect(conversationMessage("a\x1b[31mb", false)).toBe(
      "\x1b[200~a[31mb\x1b[201~\r",
    );
    expect(JSON.parse(conversationMessage('say "hi"\n', true))).toEqual({
      type: "prompt",
      message: 'say "hi"\n',
      streamingBehavior: "followUp",
    });
    expect(conversationMessage("x", true).endsWith("}\n")).toBe(true);
  });
});
