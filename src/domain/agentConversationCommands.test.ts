import { expect, it } from "vitest";
import {
  agentConversationCommandAt,
  agentConversationCommandMatches,
  agentConversationBtwRequest,
  agentConversationGoalRequest,
  insertAgentConversationCommand,
} from "./agentConversationCommands";

const commands = [
  { name: "compact", description: "" },
  { name: "skill:ponytail-review", description: "" },
  { name: "skill:soreno-release", description: "" },
];

it.each([
  ["/", ["compact", "skill:ponytail-review", "skill:soreno-release"]],
  ["/RE", ["skill:ponytail-review", "skill:soreno-release"]],
  ["Lance /", ["skill:ponytail-review", "skill:soreno-release"]],
  ["Lance\n/rel", ["skill:soreno-release"]],
  ["Lance /com", []],
  ["/compact puis /po", null],
  ["voir src/re", null],
  ["https://ex", null],
])("suggests commands for %j", (text, names) => {
  const token = agentConversationCommandAt(text, text.length);
  expect(
    token &&
      agentConversationCommandMatches(commands, token).map((c) => c.name),
  ).toEqual(names);
});

it.each([
  [
    "Lance /po",
    9,
    "skill:ponytail-review",
    "Lance /skill:ponytail-review ",
    29,
  ],
  ["Lance /po|xx sur src", 9, "skill:a", "Lance /skill:a sur src", 15],
  ["/co\nsuite", 3, "compact", "/compact \nsuite", 9],
])(
  "replaces the whole token in %j",
  (text, caret, name, expected, expectedCaret) => {
    const token = agentConversationCommandAt(text, caret)!;
    expect(insertAgentConversationCommand(text, token, name)).toEqual({
      text: expected,
      caret: expectedCaret,
    });
  },
);

it.each([
  [" /goal ", { type: "goal", op: "get" }],
  ["/goal show", { type: "goal", op: "get" }],
  ["/goal pause", { type: "goal", op: "pause" }],
  ["/goal drop", { type: "goal", op: "drop" }],
  ["/goal set Fix\nall", { type: "goal", op: "create", objective: "Fix\nall" }],
  ["/goal Ship v2", { type: "goal", op: "create", objective: "Ship v2" }],
  ["/goal budget 500", { type: "goal", op: "budget" }],
  ["/goals", null],
  ["Lance /goal x", null],
])("maps %j to OMP's goal request", (text, request) => {
  expect(agentConversationGoalRequest(text)).toEqual(request);
});

it.each([
  [" /btw ", { type: "get_btw_history" }],
  [
    "/btw Pourquoi\nce choix ?",
    { type: "btw", question: "Pourquoi\nce choix ?" },
  ],
  ["/btwx", null],
  ["Dis /btw x", null],
])("maps %j to OMP's side-question request", (text, request) => {
  expect(agentConversationBtwRequest(text)).toEqual(request);
});
