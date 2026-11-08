import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { installBridge } from "./pi_omp_bridge.mjs";

const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nextId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const managerKey = Symbol.for("pi-subagents:manager");
let directory;
beforeEach(() => { vi.useFakeTimers(); directory = mkdtempSync(join(tmpdir(), "soreno-bridge-")); });
afterEach(() => { delete globalThis[managerKey]; vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });

function bridge(provider = "pi", overrides = {}) {
  const config = { version: 1, provider, runId: "private-run", metadataPath: join(directory, "metadata.json"), expectedSessionId: firstId, ...overrides };
  const handlers = new Map();
  const active = { id: firstId, file: join(directory, "first.jsonl"), name: "Première conversation", working: false };
  const context = {
    mode: "tui", hasUI: true,
    sessionManager: { getSessionId: () => active.id, getSessionFile: () => active.file, getSessionName: () => active.name },
    isIdle: () => !active.working,
    ui: { notify: vi.fn(), ...(provider === "pi" && { setWorkingIndicator: vi.fn() }) }, shutdown: vi.fn(),
  };
  const events = new EventEmitter();
  installBridge({
    on: (event, handler) => handlers.set(event, handler),
    events: { on: (event, handler) => { events.on(event, handler); return () => events.off(event, handler); } },
  }, config);
  return { active, context, config, events, handlers, emit: (event, payload = {}) => handlers.get(event)(payload, context), read: () => JSON.parse(readFileSync(config.metadataPath, "utf8")) };
}

it("samples the current Pi manager even when the parent is idle or the extension loads later", () => {
  const run = bridge();
  run.emit("session_start");
  expect(run.read().working).toBe(false);
  // This documented manager snapshot also includes queued and workflow children.
  globalThis[managerKey] = { hasRunning: () => true };
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(true);
  globalThis[managerKey] = { hasRunning: () => false };
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(false);
  run.active.working = true;
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(true);
  delete globalThis[managerKey];
  run.active.working = false;
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(false);
});

it("keeps Pi responsive with a static working indicator", () => {
  const run = bridge("pi");
  run.emit("session_start");
  expect(run.context.ui.setWorkingIndicator).toHaveBeenCalledExactlyOnceWith({ frames: ["•"] });
});

it("publishes a Chat conversation from its main agent only", () => {
  const chat = bridge("omp", { mode: "rpc" });
  Object.assign(chat.context, { mode: "rpc", agent: { kind: "sub" } });
  chat.emit("session_start");
  expect(existsSync(chat.config.metadataPath)).toBe(false);
  chat.context.agent = { kind: "main" };
  chat.emit("session_start");
  expect(chat.read()).toMatchObject({ provider: "omp", runId: "private-run", sessionId: firstId, error: null });

  // A terminal launch still ignores RPC contexts.
  const terminal = bridge("omp", { metadataPath: join(directory, "terminal.json") });
  Object.assign(terminal.context, { mode: "rpc", agent: { kind: "main" } });
  terminal.emit("session_start");
  expect(existsSync(terminal.config.metadataPath)).toBe(false);
});

it("does not pretend OMP exposes the Pi working indicator API", () => {
  const run = bridge("omp");
  expect(run.context.ui).not.toHaveProperty("setWorkingIndicator");
  expect(() => run.emit("session_start")).not.toThrow();
});

it("does not break Pi conversation identity if the optional subagent manager fails", () => {
  const run = bridge();
  globalThis[managerKey] = { hasRunning: () => { throw new Error("unavailable"); } };
  run.emit("session_start");
  expect(run.read()).toMatchObject({ sessionId: firstId, working: false, error: null });
  expect(run.context.ui.notify).not.toHaveBeenCalled();
});

it("publishes the final assistant message of each terminal loop as a finished turn", () => {
  const run = bridge("omp");
  run.emit("session_start");
  const summary = "Done.\n<soreno-summary>Fixed it.</soreno-summary>";
  const assistant = (text) => ({ role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text }] });
  run.emit("agent_end", { isTerminal: false, messages: [assistant(summary)] });
  expect(run.read().turn).toBeNull();
  run.emit("agent_end", { willContinue: true, messages: [assistant(summary)] });
  expect(run.read().turn).toBeNull();
  run.emit("agent_end", { messages: [assistant("Draft"), { role: "user", content: "Go" }, assistant(summary)] });
  const { turn } = run.read();
  expect(turn).toEqual({ id: expect.any(String), message: summary });
  const reply = assistant(summary);
  run.emit("agent_end", { messages: [reply] });
  expect(run.read().turn.id).not.toBe(turn.id);
  run.emit("agent_end", { messages: [reply, { role: "user", content: "next" }] });
  expect(run.read().turn).toBeNull();
  run.emit("agent_end", { messages: [reply] });
  expect(run.read().turn).toBeNull();
  run.emit("agent_start");
  vi.advanceTimersByTime(250);
  expect(run.read().turn).toBeNull();
  run.emit("agent_end", { messages: [assistant("Which file should I edit?")] });
  expect(run.read().turn).toEqual({ id: expect.any(String), message: "Which file should I edit?" });
  run.emit("agent_end", { messages: [assistant(`${"é".repeat(20_000)}${summary}`)] });
  expect(run.read().turn).toBeNull();
});

it.each(["pi", "omp"])("%s awaits the user while a question tool runs", (provider) => {
  const run = bridge(provider);
  run.emit("session_start");
  expect(run.read().awaiting).toBe(false);
  run.emit("tool_execution_start", { toolCallId: "read-1", toolName: "read" });
  expect(run.read().awaiting).toBe(false);
  run.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "Ask" });
  expect(run.read().awaiting).toBe(true);
  if (provider === "pi") run.emit("session_info_changed");
  expect(run.read().awaiting).toBe(true);
  run.emit("tool_execution_end", { toolCallId: "read-1", toolName: "read" });
  expect(run.read().awaiting).toBe(true);
  run.emit("tool_execution_end", { toolCallId: "ask-1", toolName: "Ask" });
  expect(run.read().awaiting).toBe(false);

  run.emit("tool_execution_start", { toolCallId: "ask-2", toolName: "request_user_input" });
  expect(run.read().awaiting).toBe(true);
  run.emit("agent_end", { messages: [] });
  expect(run.read().awaiting).toBe(false);

  const subagent = { ...run.context, mode: "rpc", hasUI: false };
  run.handlers.get("tool_execution_start")({ toolCallId: "ask-3", toolName: "ask_user_question" }, subagent);
  expect(run.read().awaiting).toBe(false);
});

it("keeps a pending summary across /reload", () => {
  const run = bridge("omp");
  run.emit("session_start");
  run.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "<soreno-summary>Fixed it.</soreno-summary>" }] }] });
  const { turn } = run.read();
  expect(turn).toEqual({ id: expect.any(String), message: expect.any(String) });
  const reload = bridge("omp");
  reload.emit("session_start");
  expect(reload.read().turn).toEqual(turn);
});

it("keeps OMP busy until every child finishes, including failures, aborts and duplicate events", () => {
  const run = bridge("omp");
  const channel = "task:subagent:lifecycle";
  run.emit("session_start");
  expect(run.read().working).toBe(false);
  for (const id of ["one", "two", "three", "one"]) run.events.emit(channel, { id, status: "started" });
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(true);
  for (const [id, status] of [["one", "completed"], ["two", "failed"]]) {
    run.events.emit(channel, { id, status });
    run.events.emit(channel, { id, status });
    vi.advanceTimersByTime(250);
    expect(run.read().working).toBe(true);
  }
  run.events.emit(channel, { id: "three", status: "aborted" });
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(false);
  run.active.working = true;
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(true);
});

it("gates OMP listeners to the terminal session and cleans them up on shutdown", () => {
  const run = bridge("omp");
  const channel = "task:subagent:lifecycle";
  run.context.mode = "print";
  run.emit("session_start");
  expect(run.events.listenerCount(channel)).toBe(0);
  run.context.mode = "tui";
  run.emit("session_start");
  run.emit("session_switch");
  expect(run.events.listenerCount(channel)).toBe(1);
  for (const event of [null, {}, { id: "", status: "started" }, { id: "bad", status: "unknown" }]) run.events.emit(channel, event);
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(false);
  run.events.emit(channel, { id: "one", status: "started" });
  run.emit("session_shutdown");
  expect(run.events.listenerCount(channel)).toBe(0);
  expect(run.read().working).toBe(false);
  run.events.emit(channel, { id: "late", status: "started" });
  run.emit("session_start");
  expect(run.events.listenerCount(channel)).toBe(1);
  expect(run.read().working).toBe(false);
});

it.each(["pi", "omp"])("publishes %s child activity over SSH without a parent turn", (provider) => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const run = bridge(provider, { remote: true });
  run.emit("session_start");
  if (provider === "pi") globalThis[managerKey] = { hasRunning: () => true };
  else run.events.emit("task:subagent:lifecycle", { id: "child", status: "started", detached: true });
  vi.advanceTimersByTime(250);
  expect(run.read().working).toBe(true);
  const sequence = write.mock.calls.at(-1)[0];
  expect(JSON.parse(Buffer.from(sequence.match(/;([^;\x07]+)\x07$/)[1], "base64").toString("utf8")).working).toBe(true);
});

describe.each(["pi", "omp"])("%s conversation bridge", (provider) => {
  it("waits for the conversation history to be materialized", () => {
    const run = bridge(provider);
    run.emit("session_start");
    expect(run.read()).toMatchObject({ sessionId: firstId, materialized: false, error: null });
    writeFileSync(run.active.file, "");
    vi.advanceTimersByTime(250);
    expect(run.read().materialized).toBe(true);
  });

  it("tells a deleted history from one not written yet, across a reload", () => {
    const run = bridge(provider);
    run.emit("session_start");
    expect(run.read()).toMatchObject({ materialized: false, deleted: false });
    writeFileSync(run.active.file, "");
    vi.advanceTimersByTime(250);
    rmSync(run.active.file);
    vi.advanceTimersByTime(250);
    expect(run.read()).toMatchObject({ materialized: false, deleted: true });

    const reloaded = bridge(provider);
    reloaded.emit("session_start");
    expect(reloaded.read()).toMatchObject({ materialized: false, deleted: true });

    reloaded.active.id = nextId;
    reloaded.active.file = join(directory, "next.jsonl");
    vi.advanceTimersByTime(250);
    expect(reloaded.read()).toMatchObject({ sessionId: nextId, materialized: false, deleted: false });
  });

  it("publishes identity and durable names, including a rename without a lifecycle event", () => {
    const run = bridge(provider);
    run.emit("session_start");
    expect(run.read()).toMatchObject({ version: 1, runId: "private-run", provider, sessionId: firstId, name: "Première conversation", error: null });
    const modified = statSync(run.config.metadataPath).mtimeMs;
    vi.advanceTimersByTime(500);
    expect(statSync(run.config.metadataPath).mtimeMs).toBe(modified);
    run.active.name = "Nouveau nom";
    vi.advanceTimersByTime(250);
    expect(run.read().name).toBe("Nouveau nom");
    run.emit("session_shutdown");
    run.active.name = "Après arrêt";
    vi.advanceTimersByTime(500);
    expect(run.read().name).toBe("Nouveau nom");
  });

  it("publishes idle and busy state through the sidecar", () => {
    const run = bridge(provider);
    run.emit("session_start");
    expect(run.read().working).toBe(false);
    run.active.working = true;
    vi.advanceTimersByTime(250);
    expect(run.read().working).toBe(true);
    run.active.working = false;
    vi.advanceTimersByTime(250);
    expect(run.read().working).toBe(false);
  });

  it("defaults to unknown activity and recovers if the activity API throws", () => {
    const run = bridge(provider);
    delete run.context.isIdle;
    run.emit("session_start");
    expect(run.read().working).toBeNull();
    run.context.isIdle = () => { throw new Error("unavailable"); };
    vi.advanceTimersByTime(250);
    expect(run.read()).toMatchObject({ working: null, error: "unavailable" });
    run.context.isIdle = () => false;
    vi.advanceTimersByTime(250);
    expect(run.read()).toMatchObject({ working: true, error: null });
  });

  it("publishes changed metadata over the private OSC channel only in remote mode", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const run = bridge(provider, { remote: true });
    run.emit("session_start");
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledOnce();

    run.active.name = "Nom distant";
    run.active.working = true;
    vi.advanceTimersByTime(250);
    expect(write).toHaveBeenCalledTimes(2);
    for (const [sequence] of write.mock.calls) {
      const match = sequence.match(/^\x1b\]777;soreno;private-run;([^\x07]+)\x07$/);
      expect(match).not.toBeNull();
      expect(JSON.parse(Buffer.from(match[1], "base64").toString("utf8"))).toMatchObject({
        version: 1, runId: "private-run", provider, sessionId: firstId,
      });
    }
    expect(JSON.parse(Buffer.from(write.mock.calls[0][0].match(/;([^;\x07]+)\x07$/)[1], "base64").toString("utf8")).working).toBe(false);
    expect(JSON.parse(Buffer.from(write.mock.calls[1][0].match(/;([^;\x07]+)\x07$/)[1], "base64").toString("utf8"))).toEqual(run.read());
    expect(run.read().working).toBe(true);
  });

  it("does not write private OSC metadata for local runs", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const run = bridge(provider);
    run.emit("session_start");
    vi.advanceTimersByTime(250);
    expect(write).not.toHaveBeenCalled();
  });

  it("tracks /new, /resume and forks instead of retaining the startup reference", () => {
    const run = bridge(provider);
    run.emit("session_start");
    run.active.id = nextId;
    run.active.file = join(directory, "next.jsonl");
    run.active.name = undefined;
    run.emit("session_switch");
    expect(run.read()).toMatchObject({ sessionId: nextId, sessionFile: run.active.file, name: null, error: null });
    run.active.id = firstId;
    run.emit(provider === "pi" ? "session_fork" : "session_branch");
    expect(run.read().sessionId).toBe(firstId);
    expect(run.context.shutdown).not.toHaveBeenCalled();
  });

  it("rejects a different startup identity and never later adopts it", () => {
    const run = bridge(provider);
    run.active.id = nextId;
    run.emit("session_start");
    expect(run.read()).toMatchObject({ sessionId: null, sessionFile: null, error: expect.stringContaining("ne correspond pas") });
    expect(run.context.shutdown).toHaveBeenCalledOnce();
    run.emit("session_switch");
    expect(run.read().sessionId).toBeNull();
  });

  it("allows /reload after an accepted internal switch but not across runs", () => {
    const run = bridge(provider);
    run.emit("session_start");
    run.active.id = nextId;
    run.emit("session_switch");
    run.emit("session_shutdown");
    const reload = bridge(provider);
    reload.active.id = nextId;
    reload.emit("session_start");
    expect(reload.read().sessionId).toBe(nextId);
    expect(reload.context.shutdown).not.toHaveBeenCalled();
    reload.emit("session_shutdown");
    const otherRun = bridge(provider, { runId: "different-run" });
    otherRun.active.id = nextId;
    otherRun.emit("session_start");
    expect(otherRun.context.shutdown).toHaveBeenCalledOnce();
  });

  it("reports missing references and recovers when the manager becomes persistent", () => {
    const run = bridge(provider);
    run.active.file = undefined;
    run.emit("session_start");
    expect(run.read()).toMatchObject({ sessionId: null, error: expect.stringContaining("référence persistante") });
    run.active.file = join(directory, "first.jsonl");
    run.active.name = "  Nom\u0007\nTexte ignoré  ";
    vi.advanceTimersByTime(250);
    expect(run.read()).toMatchObject({ sessionId: firstId, name: "Nom", error: null });
    run.active.name = `${"a".repeat(511)}😀 fin ignorée`;
    if (provider === "pi") run.emit("session_info_changed");
    else vi.advanceTimersByTime(250);
    expect(run.read().name).toBe(`${"a".repeat(511)}😀`);
  });

  it("ignores inherited bridge instances in SDK subagents, including forwarded UI", () => {
    const main = bridge(provider);
    main.emit("session_start");
    const child = bridge(provider);
    child.context.mode = "print";
    child.active.id = nextId;
    child.active.name = "Ne pas remplacer le parent";
    child.emit("session_start");
    if (provider === "pi") child.emit("session_info_changed");
    child.emit("session_shutdown");
    vi.advanceTimersByTime(500);
    expect(main.read()).toMatchObject({ sessionId: firstId, name: "Première conversation" });
    expect(child.context.shutdown).not.toHaveBeenCalled();
  });

  it("keeps the CLI alive on bridge write failure and retries without terminal spam", () => {
    const path = join(directory, "unavailable", "metadata.json");
    const run = bridge(provider, { metadataPath: path });
    expect(() => run.emit("session_start")).not.toThrow();
    vi.advanceTimersByTime(500);
    expect(run.context.ui.notify).toHaveBeenCalledOnce();
    expect(run.context.shutdown).not.toHaveBeenCalled();
    mkdirSync(join(directory, "unavailable"));
    vi.advanceTimersByTime(250);
    expect(run.read().sessionId).toBe(firstId);
  });

  it("appends Soreno's run instruction to the system prompt of every agent turn", () => {
    const run = bridge(provider, { systemAppend: "Soreno: write kanban-issue-<name>.json" });
    const start = run.handlers.get("before_agent_start");
    expect(start({ systemPrompt: "Base prompt\nwith APPEND_SYSTEM.md" }, run.context)).toEqual({
      systemPrompt: "Base prompt\nwith APPEND_SYSTEM.md\n\nSoreno: write kanban-issue-<name>.json",
    });
  });

  it("adds the run instruction to structured prompt options once, keeping discovered text", () => {
    const run = bridge(provider, { systemAppend: "Soreno: write kanban-issue-<name>.json" });
    const start = run.handlers.get("before_agent_start");
    const systemPromptOptions = { appendSystemPrompt: "From APPEND_SYSTEM.md" };
    for (let turn = 0; turn < 2; turn += 1) {
      expect(start({ systemPrompt: "Base", systemPromptOptions }, run.context)).toBeUndefined();
    }
    expect(systemPromptOptions.appendSystemPrompt).toBe(
      "From APPEND_SYSTEM.md\n\nSoreno: write kanban-issue-<name>.json",
    );
  });

  it("adds the run instruction as its own block when the prompt is split in blocks", () => {
    const run = bridge(provider, { systemAppend: "Soreno: write kanban-issue-<name>.json" });
    const start = run.handlers.get("before_agent_start");
    expect(start({ systemPrompt: ["Static prefix", "<project-context>…</project-context>"] }, run.context)).toEqual({
      systemPrompt: ["Static prefix", "<project-context>…</project-context>", "Soreno: write kanban-issue-<name>.json"],
    });
  });

  it("leaves the system prompt alone without a run instruction", () => {
    for (const systemAppend of [undefined, null, ""]) {
      expect(bridge(provider, { systemAppend }).handlers.has("before_agent_start")).toBe(false);
    }
  });
});
