import { beforeEach, expect, it, vi } from "vitest";
import { Channel, invoke } from "@tauri-apps/api/core";
import { AgentAttachmentTooLargeError } from "../domain/agentSessions";
import { deferred } from "../testing/deferred";
import * as api from "./agentSessionsApi";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    id = 42;
    onmessage = (_output: unknown) => {};
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});
function gridChannel(index = 0) {
  const calls = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "agent_grid_subscribe");
  return (calls[index][1] as { onFrame: Channel<unknown> }).onFrame;
}

it("keeps Unicode intact at the byte boundary and writes chunks sequentially", async () => {
  const first = deferred<void>();
  vi.mocked(invoke).mockImplementationOnce(() => first.promise);
  const data = `${"a".repeat(65_535)}😀b`;

  const writing = api.writeAgentTerminal("s", data);
  expect(invoke).toHaveBeenCalledOnce();

  first.resolve();
  await writing;

  const chunks = vi
    .mocked(invoke)
    .mock.calls.map(([, args]) => (args as { data: string }).data);
  expect(
    chunks.map((chunk) => new TextEncoder().encode(chunk).byteLength),
  ).toEqual([65_535, 5]);
  expect(chunks.join("")).toBe(data);
});

it("attaches one file as a raw IPC body with encoded metadata", async () => {
  const bytes = new Uint8Array([0, 127, 128, 255]);
  const file = {
    name: "résumé 你好.txt",
    arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
  } as unknown as File;
  vi.mocked(invoke).mockResolvedValueOnce("'/tmp/résumé 你好.txt'");

  await expect(api.attachAgentFile("session-id", file)).resolves.toBe(
    "'/tmp/résumé 你好.txt'",
  );
  expect(file.arrayBuffer).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_attach_file", bytes, {
    headers: {
      "x-soreno-session-id": "session-id",
      "x-soreno-file-name": "csOpc3Vtw6kg5L2g5aW9LnR4dA==",
    },
  });
});

it("rejects oversized attachments before reading them", async () => {
  const file = {
    name: "huge.bin",
    size: 32 * 1024 * 1024 + 1,
    arrayBuffer: vi.fn(),
  } as unknown as File;

  await expect(api.attachAgentFile("session-id", file)).rejects.toBeInstanceOf(
    AgentAttachmentTooLargeError,
  );
  expect(file.arrayBuffer).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it("acknowledges a grid frame only once it is applied and stops commands after unsubscribe", async () => {
  let applied!: (ms: number) => void;
  const apply = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        applied = resolve;
      }),
  );
  const grid = api.subscribeAgentGrid("s", config, false, apply, vi.fn());
  const channel = gridChannel();
  expect(invoke).toHaveBeenCalledWith("agent_grid_subscribe", {
    sessionId: "s",
    config,
    visible: false,
    onFrame: channel,
  });
  channel.onmessage({ full: true });
  await grid.scroll({ kind: "pageUp" });
  expect(invoke).not.toHaveBeenCalledWith("agent_grid_ack", expect.anything());
  applied(1.2345);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("agent_grid_ack", {
      sessionId: "s",
      channelId: 42,
      applyMicros: 1235,
    }),
  );
  await grid.setVisible(true);
  expect(invoke).toHaveBeenLastCalledWith("agent_grid_visibility", {
    sessionId: "s",
    channelId: 42,
    visible: true,
  });
  vi.mocked(invoke).mockResolvedValueOnce("buffer");
  await expect(grid.text()).resolves.toBe("buffer");
  expect(invoke).toHaveBeenLastCalledWith("agent_grid_text", {
    sessionId: "s",
    channelId: 42,
  });
  grid.unsubscribe();
  await grid.configure(config);
  await grid.setVisible(false);
  await expect(grid.text()).resolves.toBe("");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("agent_grid_unsubscribe", {
      sessionId: "s",
      channelId: 42,
    }),
  );
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "agent_grid_subscribe",
    "agent_grid_scroll",
    "agent_grid_ack",
    "agent_grid_visibility",
    "agent_grid_text",
    "agent_grid_unsubscribe",
  ]);
});

const config = { cellWidth: 8, cellHeight: 17, palette: [] };

it("unsubscribes after a late grid registration and ignores its stale frames", async () => {
  const registration = deferred<void>();
  vi.mocked(invoke).mockImplementationOnce(() => registration.promise);
  const apply = vi.fn();
  const onError = vi.fn();
  const grid = api.subscribeAgentGrid("s", config, true, apply, onError);
  grid.unsubscribe();
  gridChannel().onmessage({ full: true });
  expect(invoke).toHaveBeenCalledTimes(1);
  registration.resolve();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("agent_grid_unsubscribe", {
      sessionId: "s",
      channelId: 42,
    }),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it.each(["resolves", "rejects"])(
  "serializes a replacement grid subscription behind cleanup when registration %s",
  async (outcome) => {
    let settleFirst!: () => void;
    const operations: string[] = [];
    vi.mocked(invoke).mockImplementation((command) => {
      operations.push(command);
      if (command === "agent_grid_subscribe" && operations.length === 1)
        return new Promise<void>((resolve, reject) => {
          settleFirst = () =>
            outcome === "resolves" ? resolve() : reject(new Error("failed"));
        });
      return Promise.resolve(undefined);
    });
    const firstError = vi.fn();
    api
      .subscribeAgentGrid("s", config, true, vi.fn(), firstError)
      .unsubscribe();
    const second = api.subscribeAgentGrid("s", config, true, vi.fn(), vi.fn());
    expect(operations).toEqual(["agent_grid_subscribe"]);
    settleFirst();
    const expected =
      outcome === "resolves"
        ? [
            "agent_grid_subscribe",
            "agent_grid_unsubscribe",
            "agent_grid_subscribe",
          ]
        : ["agent_grid_subscribe", "agent_grid_subscribe"];
    await vi.waitFor(() => expect(operations).toEqual(expected));
    expect(firstError).not.toHaveBeenCalled();
    second.unsubscribe();
    await vi.waitFor(() =>
      expect(operations).toEqual([...expected, "agent_grid_unsubscribe"]),
    );
  },
);

it.each(["subscribe", "apply", "ack"])(
  "reports grid %s failures",
  async (stage) => {
    const error = new Error("stream failed");
    if (stage === "subscribe") vi.mocked(invoke).mockRejectedValueOnce(error);
    if (stage === "ack")
      vi.mocked(invoke)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(error);
    const apply =
      stage === "apply"
        ? vi.fn().mockRejectedValue(error)
        : vi.fn().mockResolvedValue(0);
    const onError = vi.fn();
    const grid = api.subscribeAgentGrid("s", config, true, apply, onError);
    if (stage !== "subscribe") gridChannel().onmessage({ full: true });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    if (stage === "apply") expect(invoke).toHaveBeenCalledTimes(1);
    grid.unsubscribe();
  },
);

it("links a session to a local or a Linear issue", async () => {
  await api.linkAgentSessionKanbanIssue("s", {
    source: "local",
    id: "i1",
    identifier: "SOR-1",
    title: "Local",
  });
  await api.linkAgentSessionKanbanIssue("s", {
    source: "linear",
    id: "i2",
    identifier: "ENG-2",
    title: "Remote",
  });

  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["agent_link_session_kanban_issue", { sessionId: "s", issueId: "i1" }],
    [
      "agent_link_session_linear_issue",
      {
        sessionId: "s",
        issueId: "i2",
        issueIdentifier: "ENG-2",
        issueTitle: "Remote",
      },
    ],
  ]);
});
