// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  applyAgentConversationRecord,
  initialAgentConversationState,
  type AgentConversationRecord,
} from "./agentConversation";
import {
  agentConversationFormData,
  agentConversationFormInputs,
} from "./agentConversationForm";

it("replays OMP 19.1.1 probe frames", () => {
  const frames = JSON.parse(
    readFileSync("/tmp/omp-probe-frames.json", "utf8"),
  ) as (AgentConversationRecord & { _turn: number })[];
  let state = initialAgentConversationState;
  const seen: string[] = [];
  for (const { _turn, ...frame } of frames) {
    state = applyAgentConversationRecord(state, frame as AgentConversationRecord);
    if (frame.type === "extension_ui_request" && frame.method === "form") {
      const dialog = state.dialogs.find(({ id }) => id === frame.id);
      expect(dialog?.kind).toBe("form");
      if (dialog?.kind === "form")
        seen.push(
          `${_turn} form ${dialog.form.fields.map((f) => `${f.name}:${f.kind}`).join(",")} defaults=${JSON.stringify(agentConversationFormData(dialog.form, agentConversationFormInputs(dialog.form)))}`,
        );
      state = applyAgentConversationRecord(state, {
        type: "soreno_dialog_answered",
        id: frame.id,
      } as AgentConversationRecord);
    }
  }
  console.log(seen.join("\n"));
  console.log(JSON.stringify({ busy: state.busy, dialogs: state.dialogs.length }));
  console.log(JSON.stringify(state.transcript ?? state, null, 1).slice(0, 4000));
});
