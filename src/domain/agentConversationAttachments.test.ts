import { expect, it } from "vitest";
import {
  insertAgentConversationToken,
  renumberAgentConversationImageMarkers,
} from "./agentConversationAttachments";

it("inserts a token at the caret, spaced from the words around it", () => {
  expect(insertAgentConversationToken("like this.", 9, "[Image #1]")).toEqual({
    text: "like this [Image #1].",
    caret: 20,
  });
  expect(insertAgentConversationToken("a b", 2, "[Image #1]")).toEqual({
    text: "a [Image #1] b",
    caret: 13,
  });
  expect(insertAgentConversationToken("", 0, "/tmp/a")).toEqual({
    text: "/tmp/a ",
    caret: 7,
  });
});

it("drops a removed image's marker and closes the gap in the numbers", () => {
  expect(
    renumberAgentConversationImageMarkers(
      "see [Image #1] then [Image #2] and [Image #3]",
      (n) => (n === 2 ? null : n > 2 ? n - 1 : n),
    ),
  ).toBe("see [Image #1] then and [Image #2]");
});
