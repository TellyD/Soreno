import { expect, it } from "vitest";
import {
  agentConversationMentionAt,
  groupMentionRoots,
  insertAgentConversationMention,
  interleaveMentionPaths,
} from "./agentConversationMentions";

it.each([
  ["@", { start: 0, query: "" }],
  ["see @src/ap", { start: 4, query: "src/ap" }],
  ["(@src", { start: 1, query: "src" }],
  ["me@example.com", null],
  ["@src done", null],
])("finds the mention typed at the end of %j", (text, mention) => {
  expect(agentConversationMentionAt(text, text.length)).toEqual(mention);
});

it.each([
  ["read @sr please", 8, "src/app.ts", "read @src/app.ts please", 17],
  ["read @sr|c/old tail", 8, "src/a.ts", "read @src/a.ts tail", 15],
  ["@my", 3, "my notes.md", '@"my notes.md" ', 15],
  ["@x", 2, "end.", '@"end." ', 8],
  ["@x", 2, "src/app/@modal/page.tsx", '@"src/app/@modal/page.tsx" ', 27],
  ["@x", 2, 'say "hi".md', "@'say \"hi\".md' ", 15],
  ['@"my notes.md" tail', 1, "README.md", "@README.md tail", 11],
  ["@'a b' tail", 1, "c.md", "@c.md tail", 6],
  ["Lire (@sr) ensuite", 9, "src/app.ts", "Lire (@src/app.ts) ensuite", 17],
  ["voir @sr.", 8, "src/app.ts", "voir @src/app.ts.", 16],
])(
  "replaces the whole token in %j",
  (text, caret, path, expected, expectedCaret) => {
    const mention = agentConversationMentionAt(text, caret)!;
    expect(insertAgentConversationMention(text, mention, path)).toEqual({
      text: expected,
      caret: expectedCaret,
    });
  },
);

it("refuses a quoted path holding both quote characters", () => {
  const mention = agentConversationMentionAt("@x", 2)!;
  expect(
    insertAgentConversationMention("@x", mention, `docs/a' @.env ".md`),
  ).toBeNull();
});

it("names group members like their links, the first of a folder name winning", () => {
  expect(
    groupMentionRoots([
      { id: "api", path: "/srv/repos/api/" },
      { id: "fork", path: "/srv/forks/API" },
      { id: "web", path: "C:\\code\\web" },
      { id: "root", path: "/" },
    ]),
  ).toEqual([
    { projectId: "api", folder: "api" },
    { projectId: "web", folder: "web" },
  ]);
});

it("interleaves each project's paths up to the limit", () => {
  expect(interleaveMentionPaths([["a1", "a2", "a3"], [], ["b1"]], 3)).toEqual([
    "a1",
    "b1",
    "a2",
  ]);
});
