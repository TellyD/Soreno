import { describe, expect, it } from "vitest";
import {
  applyAgentConversationRecord,
  initialAgentConversationState,
  type AgentConversationRecord,
} from "./agentConversation";

const apply = (
  records: AgentConversationRecord[],
  state = initialAgentConversationState,
) => records.reduce(applyAgentConversationRecord, state);

const update = (event: Record<string, unknown>): AgentConversationRecord => ({
  type: "message_update",
  message: { role: "assistant" },
  assistantMessageEvent: event,
});

const bashCall = {
  type: "toolCall",
  id: "call-1",
  name: "bash",
  arguments: { command: "npm test" },
};

describe("OMP conversation transcript", () => {
  it("streams delta updates, names a call once written and keeps its live progress", () => {
    const state = apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "text_start", contentIndex: 0 }),
      update({ type: "text_delta", contentIndex: 0, delta: "Je " }),
      update({ type: "text_delta", contentIndex: 0, delta: "lance." }),
      // Delta updates omit the partial message: the call is anonymous until its end.
      update({ type: "toolcall_start", contentIndex: 1 }),
      update({ type: "toolcall_end", contentIndex: 1, toolCall: bashCall }),
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "npm test" },
        intent: "Running the tests",
        receivedAt: 1_000,
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Je lance." }, bashCall],
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: "ok\n" }] },
        isError: false,
        receivedAt: 3_500,
      },
    ]);
    expect(state.busy).toBe(true);
    expect(state.entries).toEqual([
      expect.objectContaining({
        role: "assistant",
        streaming: false,
        blocks: [
          { type: "text", text: "Je lance." },
          expect.objectContaining({
            id: "call-1",
            name: "bash",
            intent: "Running the tests",
            status: "done",
            output: "ok\n",
            durationMs: 2_500,
          }),
        ],
      }),
    ]);

    // OMP 18.13.2 names the call from its start.
    expect(
      apply([
        { type: "message_start", message: { role: "assistant", content: [] } },
        update({
          type: "toolcall_start",
          contentIndex: 0,
          block: { ...bashCall, arguments: {} },
        }),
      ]).entries[0],
    ).toMatchObject({ blocks: [{ id: "call-1", name: "bash" }] });

    // Before, a diff streamed while the arguments are written reaches the anonymous call.
    const started = apply([
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "toolcall_start", contentIndex: 0 }),
    ]);
    const ignored = update({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "{",
    });
    expect(applyAgentConversationRecord(started, ignored)).toBe(started);
    const changes = [
      {
        path: "/p/a.ts",
        lines: [{ kind: "added", line: 1, text: "x" }],
      },
    ];
    const streamed = apply(
      [
        {
          type: "tool_stream_update",
          toolCallId: "edit-1",
          toolName: "edit",
          update: { path: "/p/a.ts", diff: "+1|x" },
        },
      ],
      started,
    );
    const closed = apply(
      [
        update({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "edit-1",
            name: "edit",
            arguments: {},
          },
        }),
      ],
      streamed,
    );
    for (const { entries } of [streamed, closed])
      expect(entries[0]).toMatchObject({
        blocks: [{ id: "edit-1", name: "edit", changes }],
      });
  });

  it("reads an edit's numbered diff and a read's plain lines", () => {
    const call = {
      type: "toolCall",
      id: "edit-1",
      name: "edit",
      arguments: {},
    };
    const state = apply([
      {
        type: "message_start",
        message: { role: "assistant", content: [call] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        result: {
          content: [{ type: "text", text: "[math.ts#C393]\n1:a\n2:b" }],
          details: {
            path: "/p/math.ts",
            diff: " 1|a\n-2|old\n+2|new\n ...\n 9|}",
            displayContent: { text: "a\nb" },
          },
        },
      },
    ]);
    const entry = state.entries[0];
    const tool = entry.role === "assistant" ? entry.blocks[0] : null;
    expect(tool).toMatchObject({
      status: "done",
      output: "a\nb",
      changes: [
        {
          path: "/p/math.ts",
          lines: [
            { kind: "context", line: 1, text: "a" },
            { kind: "removed", line: 2, text: "old" },
            { kind: "added", line: 2, text: "new" },
            { kind: "gap", line: null, text: "..." },
            { kind: "context", line: 9, text: "}" },
          ],
        },
      ],
    });
  });

  it("links an approval to its running call, times the call from the answer and clears requests once settled", () => {
    const running = apply([
      { type: "agent_start" },
      {
        type: "message_start",
        message: { role: "assistant", content: [bashCall] },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        args: { command: "npm test" },
        receivedAt: 1_000,
      },
      {
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Allow tool: bash\nCommand: npm test",
        options: ["Approve", "Deny"],
      },
      {
        type: "extension_ui_request",
        id: "ui-2",
        method: "confirm",
        title: "Continue?",
        message: "Really?",
      },
    ]);
    expect(running.dialogs).toEqual([
      {
        kind: "approval",
        id: "ui-1",
        tool: "bash",
        detail: "Command: npm test",
        options: ["Approve", "Deny"],
        toolCallId: "call-1",
      },
      { kind: "confirm", id: "ui-2", title: "Continue?", message: "Really?" },
    ]);

    const answered = apply(
      [
        { type: "soreno_dialog_answered", id: "ui-1", receivedAt: 9_000 },
        { type: "extension_ui_request", method: "cancel", targetId: "ui-2" },
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          result: { content: [] },
          receivedAt: 9_400,
        },
      ],
      running,
    );
    expect(answered.dialogs).toEqual([]);
    const entry = answered.entries[0];
    expect(entry.role === "assistant" && entry.blocks[0]).toMatchObject({
      durationMs: 400,
    });

    const settled = apply(
      [
        {
          type: "extension_ui_request",
          id: "ui-3",
          method: "input",
          title: "Name?",
        },
        { type: "session_settled" },
      ],
      answered,
    );
    expect(settled).toMatchObject({ busy: false, dialogs: [] });
  });

  it("reads every question of an ask request", () => {
    const state = apply([
      {
        type: "extension_ui_request",
        id: "ui-9",
        method: "ask",
        questions: [
          {
            id: "db",
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
            recommended: 1,
          },
          {
            id: "features",
            question: "Which features?",
            options: [{ label: "Auth", description: "Sign-in" }],
            multi: true,
          },
        ],
      },
    ]);
    expect(state.dialogs).toEqual([
      {
        kind: "ask",
        id: "ui-9",
        questions: [
          {
            id: "db",
            question: "Which database?",
            header: null,
            options: [
              { label: "Postgres", description: null },
              { label: "SQLite", description: null },
            ],
            multi: false,
            recommended: 1,
          },
          {
            id: "features",
            question: "Which features?",
            header: null,
            options: [{ label: "Auth", description: "Sign-in" }],
            multi: true,
            recommended: null,
          },
        ],
      },
    ]);
  });

  it("rebuilds the history without the messages OMP adds on the user's behalf", () => {
    const state = apply([
      {
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            { role: "user", content: [{ type: "text", text: "Bonjour" }] },
            {
              role: "user",
              attribution: "agent",
              content: [{ type: "text", text: "<system-notice>…" }],
            },
            {
              role: "compactionSummary",
              summary: "…",
              tokensBefore: 21000,
              tokensAfter: 18000,
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Salut" }],
              stopReason: "stop",
            },
          ],
        },
      },
    ]);
    expect(state.historyLoaded).toBe(true);
    expect(state.entries).toMatchObject([
      { role: "user", text: "Bonjour" },
      {
        role: "notice",
        notice: { kind: "compacted", tokensBefore: 21000, tokensAfter: 18000 },
      },
      { role: "assistant", blocks: [{ type: "text", text: "Salut" }] },
    ]);
  });

  it("keeps the reply streaming while the history loads, so its next deltas still reach it", () => {
    const state = apply([
      { type: "message_start", message: { role: "user", content: "Bonjour" } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "text_start", contentIndex: 0 }),
      update({ type: "text_delta", contentIndex: 0, delta: "Sa" }),
      {
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "Bonjour" }] },
      },
      update({ type: "text_delta", contentIndex: 0, delta: "lut" }),
    ]);
    expect(state.entries).toMatchObject([
      { role: "user", text: "Bonjour" },
      {
        role: "assistant",
        streaming: true,
        blocks: [{ type: "text", text: "Salut" }],
      },
    ]);
    expect(new Set(state.entries.map(({ id }) => id)).size).toBe(2);
  });

  it("shows a skill command as the user typed it, live and from history", () => {
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    const skill = (details: Record<string, unknown>) => ({
      role: "custom",
      customType: "skill-prompt",
      attribution: "user",
      display: true,
      content: [{ type: "text", text: "<skill>expanded body</skill>" }, image],
      details: { path: "/skills/review/SKILL.md", lineCount: 12, ...details },
    });
    const live = apply([
      {
        type: "message_start",
        message: skill({
          name: "review",
          args: "src",
          prompt: "/skill:review src",
        }),
      },
    ]);
    expect(live.entries).toMatchObject([
      {
        role: "user",
        text: "/skill:review src",
        images: [{ data: "aGk=", mimeType: "image/png" }],
      },
    ]);
    const history = apply([
      {
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            skill({ name: "review", args: "src" }),
            { ...skill({ name: "review" }), attribution: "agent" },
            { ...skill({}), customType: "custom-message" },
          ],
        },
      },
    ]);
    expect(history.entries).toMatchObject([
      { role: "user", text: "/skill:review src" },
    ]);
    expect(history.entries).toHaveLength(1);
  });

  it("shows a local command's output as plain text and follows the model it switched to", () => {
    const state = apply([
      { type: "command_output", text: "\u001b[1mModel\u001b[22m set." },
      {
        type: "config_update",
        model: {
          provider: "openai-codex",
          id: "gpt-5.6",
          name: "GPT-5.6",
          input: ["text", "image"],
        },
      },
      { type: "thinking_level_changed", thinkingLevel: "high" },
    ]);
    expect(state.entries).toMatchObject([
      { role: "notice", notice: { kind: "output", message: "Model set." } },
    ]);
    expect(state.model).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6",
      name: "GPT-5.6",
      images: true,
    });
    expect(state.thinkingLevel).toBe("high");
  });
  it("shows OMP's changelog as Markdown, apart from other command output", () => {
    const changelog = "## [18.12.1] - 2026-10-17\n\n### Fixed\n\n- Fixed `x`";
    expect(
      apply([
        { type: "command_output", text: changelog },
        { type: "command_output", text: "No changelog entries found." },
      ]).entries,
    ).toMatchObject([
      { notice: { kind: "changelog", markdown: changelog } },
      { notice: { kind: "output", message: "No changelog entries found." } },
    ]);
  });
  it("offers every installed command but only the builtins that fit the chat", () => {
    const state = apply([
      {
        type: "available_commands_update",
        commands: [
          { name: "switch", source: "builtin" },
          { name: "compact", source: "builtin" },
          { name: "skill:review", source: "skill" },
          { name: "ponytail", source: "extension" },
          { name: "green", source: "custom" },
          { name: "init", source: "file" },
        ],
      },
    ]);
    expect(state.commands.map(({ name }) => name)).toEqual([
      "goal",
      "btw",
      "compact",
      "skill:review",
      "ponytail",
      "green",
      "init",
    ]);
  });
  it("follows OMP's goal until it is completed or dropped", () => {
    const goal = { objective: "Ship v2", status: "active" };
    const active = apply([{ type: "goal_updated", goal }]);
    expect(active.goal).toEqual(goal);
    expect(
      apply(
        [{ type: "goal_updated", goal: { ...goal, status: "complete" } }],
        active,
      ).goal,
    ).toBeNull();
    const paused = apply(
      [
        {
          type: "response",
          command: "get_state",
          success: true,
          data: {
            goal: {
              enabled: false,
              mode: "active",
              goal: { ...goal, status: "paused" },
            },
          },
        },
      ],
      active,
    );
    expect(paused.goal).toEqual({ ...goal, status: "paused" });
    const dropped = apply(
      [
        {
          type: "response",
          command: "goal",
          success: true,
          data: { goal: null },
        },
      ],
      paused,
    );
    expect(dropped.goal).toBeNull();
  });
  it("streams a side question outside the transcript, then its follow-ups in the same topic", () => {
    const asked = {
      id: "b1",
      question: "Capitale ?",
      answer: "",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    };
    const answered = apply([
      { type: "btw_record", record: asked },
      { type: "btw_delta", recordId: "b1", delta: "Pa" },
      // OMP's answer to the request comes after its first record and must not reset the deltas.
      {
        type: "response",
        command: "btw",
        success: true,
        data: { record: asked },
      },
      { type: "btw_delta", recordId: "b1", delta: "ris" },
    ]);
    expect(answered.entries).toEqual([]);
    expect(answered.btwView).toEqual({ topic: "b1" });
    expect(answered.btw[0].turns).toEqual([
      {
        question: "Capitale ?",
        answer: "Paris",
        status: "running",
        error: null,
      },
    ]);
    const cancelled = apply(
      [
        {
          type: "btw_record",
          record: { ...asked, answer: "Paris", status: "cancelled" },
        },
        { type: "btw_delta", recordId: "b1", delta: " !" },
        // The end of a topic left with its conversation never shows.
        {
          type: "btw_record",
          record: { ...asked, id: "old", status: "cancelled" },
        },
      ],
      answered,
    );
    expect(cancelled.btw.map(({ id }) => id)).toEqual(["b1"]);
    expect(cancelled.btw[0].turns[0]).toMatchObject({
      answer: "Paris",
      status: "cancelled",
    });
    const followUp = apply(
      [
        { type: "soreno_btw_view", view: null },
        {
          type: "btw_record",
          record: {
            ...asked,
            answer: "Paris",
            status: "cancelled",
            followUps: [
              { question: "Et Lyon ?", answer: "", status: "running" },
            ],
          },
        },
        { type: "btw_delta", recordId: "b1", delta: "Non." },
        { type: "soreno_exited", exitCode: 1 },
      ],
      cancelled,
    );
    expect(followUp.btwView).toEqual({ topic: "b1" });
    expect(
      followUp.btw[0].turns.map(({ answer, status }) => [answer, status]),
    ).toEqual([
      ["Paris", "cancelled"],
      ["Non.", "interrupted"],
    ]);
  });
  it("finds a running side question in OMP's history, and forgets them with the conversation", () => {
    const record = (id: string, status: string, createdAt: number) => ({
      id,
      question: id,
      answer: "",
      status,
      createdAt,
    });
    const loaded = apply([
      {
        type: "response",
        command: "get_btw_history",
        success: true,
        data: {
          records: [record("live", "running", 2), record("tui", "complete", 1)],
        },
      },
    ]);
    expect(loaded.btw.map(({ id }) => id)).toEqual(["live", "tui"]);
    expect(loaded.btwView).toEqual({ topic: "live" });
    // An OMP without side questions refuses the request silently.
    expect(
      apply([
        {
          type: "response",
          command: "get_btw_history",
          success: false,
          error: "Unknown",
        },
      ]),
    ).toEqual(initialAgentConversationState);
    const replaced = apply(
      [{ type: "response", command: "new_session", success: true, data: {} }],
      loaded,
    );
    expect([replaced.btw, replaced.btwView]).toEqual([[], null]);
  });
  it("follows the agents a task call starts, and stops them with the process", () => {
    const state = apply([
      {
        type: "subagent_lifecycle",
        payload: {
          id: "Reader",
          agent: "reviewer",
          index: 1,
          status: "started",
          parentToolCallId: "task-1",
        },
      },
      {
        type: "subagent_lifecycle",
        payload: { id: "Counter", index: 0, status: "started" },
      },
      {
        type: "subagent_progress",
        payload: {
          parentToolCallId: "task-1",
          progress: {
            id: "Reader",
            status: "running",
            description: "Read a.txt",
            lastIntent: "Reading a.txt",
            toolCount: 1,
            tokens: 5_709,
            durationMs: 2_690,
          },
        },
      },
      {
        type: "subagent_lifecycle",
        payload: { id: "Counter", status: "completed" },
      },
      // An extension refused the new conversation: the session and its agents remain.
      {
        type: "response",
        command: "new_session",
        success: true,
        data: { cancelled: true },
      },
      { type: "soreno_exited", exitCode: 0, stderr: "" },
    ]);
    expect(state.subagents).toEqual([
      {
        id: "Counter",
        agent: null,
        index: 0,
        description: null,
        status: "completed",
        activity: null,
        toolCount: 0,
        tokens: 0,
        durationMs: null,
        parentToolCallId: null,
      },
      {
        id: "Reader",
        agent: "reviewer",
        index: 1,
        description: "Read a.txt",
        status: "aborted",
        activity: "Reading a.txt",
        toolCount: 1,
        tokens: 5_709,
        durationMs: 2_690,
        parentToolCallId: "task-1",
      },
    ]);
    expect(
      apply([
        {
          type: "subagent_lifecycle",
          payload: { id: "Odd", status: "__proto__" },
        },
      ]).subagents[0].status,
    ).toBe("running");
    expect(
      apply([
        {
          type: "subagent_lifecycle",
          payload: { id: "Counter", index: 0, status: "started" },
        },
        {
          type: "response",
          command: "switch_session",
          success: true,
          data: { cancelled: false },
        },
      ]).subagents,
    ).toEqual([]);
    const crashed = apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "toolcall_end", contentIndex: 0, toolCall: bashCall }),
      update({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { ...bashCall, id: "call-2" },
      }),
      { type: "tool_execution_start", toolCallId: "call-1", receivedAt: 1_000 },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: "ok\n" }] },
        receivedAt: 2_000,
      },
      { type: "tool_execution_start", toolCallId: "call-2", receivedAt: 2_000 },
      { type: "soreno_exited", exitCode: null, stderr: "" },
    ]);
    expect(
      crashed.entries.flatMap((entry) =>
        entry.role === "assistant"
          ? entry.blocks.map((block) => block.type === "tool" && block.status)
          : [],
      ),
    ).toEqual(["done", "error"]);
  });

  it("follows a compaction from OMP's state and events", () => {
    const state = (isCompacting: boolean): AgentConversationRecord => ({
      type: "response",
      command: "get_state",
      success: true,
      data: { isCompacting },
    });
    const manual = apply([state(true)]);
    expect(manual.compacting).toBe(true);
    expect(apply([state(false)], manual).compacting).toBe(false);
    const automatic = apply([{ type: "auto_compaction_start" }]);
    expect(automatic.compacting).toBe(true);
    expect(
      apply([{ type: "auto_compaction_end", aborted: true }], automatic)
        .compacting,
    ).toBe(false);
    // OMP 18.13.3 also announces a manual one; its text still brings the result.
    const compact = apply([{ type: "manual_compaction_start" }]);
    expect(compact.compacting).toBe(true);
    expect(
      apply(
        [{ type: "manual_compaction_end", aborted: false, skipped: true }],
        compact,
      ),
    ).toMatchObject({ compacting: false, entries: [] });

    // `/compact` ends with its text only; both paths leave the same marker.
    const notices = apply([
      {
        type: "command_output",
        text: "Compaction complete. Tokens: 21000 -> 18000 (saved 3000).",
      },
      { type: "command_output", text: "Compaction failed: provider error" },
      // OMP 18.10 reports only the count before an automatic compaction.
      { type: "auto_compaction_end", result: { tokensBefore: 90000 } },
    ]).entries;
    expect(notices).toMatchObject([
      {
        notice: { kind: "compacted", tokensBefore: 21000, tokensAfter: 18000 },
      },
      {
        notice: {
          kind: "output",
          message: "Compaction failed: provider error",
        },
      },
      {
        notice: { kind: "compacted", tokensBefore: 90000, tokensAfter: null },
      },
    ]);
  });

  it("tells when only background jobs keep the session busy, until a turn or the end", () => {
    const state = (data: Record<string, unknown>): AgentConversationRecord => ({
      type: "response",
      command: "get_state",
      success: true,
      data,
    });
    const jobs = { isSettled: false, hasPendingAsyncWork: true };
    const streaming = apply([state({ ...jobs, isStreaming: true })]);
    expect(streaming).toMatchObject({ busy: true, background: false });
    const waiting = apply([state({ ...jobs, isStreaming: false })]);
    expect(waiting).toMatchObject({ busy: true, background: true });
    // A job result wakes the agent: Stop is for its turn again.
    expect(apply([{ type: "agent_start" }], waiting).background).toBe(false);
    expect(apply([{ type: "session_settled" }], waiting)).toMatchObject({
      busy: false,
      background: false,
    });
    const yielded = apply([
      { type: "agent_start" },
      { type: "agent_end", awaitingAsyncWork: true },
    ]);
    expect(yielded).toMatchObject({ busy: true, background: true });
    // A compaction is Stop's target, not the jobs.
    expect(
      apply([state({ ...jobs, isStreaming: false, isCompacting: true })]),
    ).toMatchObject({ compacting: true, background: false });
    expect(apply([{ type: "compaction_start" }], waiting)).toMatchObject({
      compacting: true,
      background: false,
    });
  });

  it("keeps each queued message's queue and marks the ones already steered into the reply", () => {
    const { queued } = apply([
      {
        type: "queue_update",
        steering: ["sent", "waiting"],
        followUp: ["later"],
        liveSteered: 1,
      },
    ]);
    expect(queued).toEqual([
      { text: "sent", queue: "steering", live: true },
      { text: "waiting", queue: "steering", live: false },
      { text: "later", queue: "followUp", live: false },
    ]);
  });

  it("follows OMP's todo list from its state and its todo tool, until OMP clears it", () => {
    const loaded = apply([
      {
        type: "response",
        command: "get_state",
        success: true,
        data: {
          todoPhases: [
            { name: "Empty", tasks: [] },
            {
              name: "Fix",
              tasks: [
                { content: "Read the code", status: "completed" },
                { content: "Patch", status: "in_progress" },
                { content: "Mystery", status: "unknown" },
                { content: "Hostile", status: "__proto__" },
              ],
            },
          ],
        },
      },
    ]);
    expect(loaded.todos).toEqual([
      {
        name: "Fix",
        tasks: [
          { content: "Read the code", status: "completed" },
          { content: "Patch", status: "in_progress" },
          { content: "Mystery", status: "pending" },
          { content: "Hostile", status: "pending" },
        ],
      },
    ]);

    const updated = apply(
      [
        {
          type: "tool_execution_end",
          toolCallId: "read-1",
          toolName: "read",
          result: { details: { phases: [] } },
        },
        {
          type: "tool_execution_end",
          toolCallId: "todo-1",
          toolName: "todo",
          result: {
            details: {
              phases: [
                {
                  name: "Fix",
                  tasks: [{ content: "Patch", status: "completed" }],
                },
              ],
            },
          },
        },
      ],
      loaded,
    );
    expect(updated.todos).toEqual([
      { name: "Fix", tasks: [{ content: "Patch", status: "completed" }] },
    ]);
    expect(apply([{ type: "todo_auto_clear" }], updated).todos).toEqual([]);
  });
});
