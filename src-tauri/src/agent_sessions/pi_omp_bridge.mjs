// Loaded only by Soreno's Pi/OMP launch; Rust prepends the run-specific `soreno` config.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export default function (api) {
  // A conversation (`omp --mode rpc-ui`) without `runId` reports only through RPC: it only takes the instruction.
  if (soreno.runId) installBridge(api, soreno);
  else appendSystemPrompt(api, soreno.systemAppend);
}

export function installBridge(api, config) {
  let context;
  let timer;
  let previous;
  let established = false;
  let rejected = false;
  let notified = false;
  const activeSubagents = new Set();
  let unsubscribeSubagents;
  let turn = null;
  // Question tool calls in progress, by toolCallId: the agent waits for the user.
  const pendingQuestions = new Set();
  // OMP replays the whole active history in agent_end, even when no model replied.
  let summarizedReply;
  // The history file seen on disk during this run: its disappearance means it was deleted.
  let materializedFile = null;
  // /reload recreates extensions, not the CLI run. A previously accepted /new
  // must not be compared again with the conversation originally resumed.
  try {
    if (statSync(config.metadataPath).size <= 64 * 1024) {
      const saved = JSON.parse(readFileSync(config.metadataPath, "utf8"));
      established = saved.version === 1 && saved.runId === config.runId
        && saved.provider === config.provider && saved.error === null
        && typeof saved.sessionId === "string" && typeof saved.sessionFile === "string";
      if (established && typeof saved.turn?.id === "string" && typeof saved.turn.message === "string") turn = saved.turn;
      if (established && (saved.materialized === true || saved.deleted === true)) materializedFile = saved.sessionFile;
    }
  } catch { /* A new run has no sidecar yet. */ }

  function notify(error) {
    if (notified) return;
    notified = true;
    context?.ui?.notify(`Soreno : ${error}`, "error");
  }

  function hasWorkingSubagents() {
    if (config.provider === "omp") return activeSubagents.size > 0;
    // pi-subagents documents this snapshot for all running/queued children,
    // including workflow agents that do not emit public lifecycle events.
    try {
      const manager = globalThis[Symbol.for("pi-subagents:manager")];
      return typeof manager?.hasRunning === "function" && manager.hasRunning() === true;
    } catch {
      // An optional status integration must not invalidate the conversation link.
      return false;
    }
  }

  function stopObservingSubagents() {
    unsubscribeSubagents?.();
    unsubscribeSubagents = undefined;
    activeSubagents.clear();
  }

  function publish() {
    if (!context || rejected) return;
    let snapshot = {
      version: 1, runId: config.runId, provider: config.provider,
      sessionId: null, sessionFile: null, name: null, working: null, materialized: false, deleted: false, error: null, turn,
      awaiting: pendingQuestions.size > 0,
    };
    try {
      const manager = context.sessionManager;
      const sessionId = manager.getSessionId();
      const sessionFile = manager.getSessionFile();
      if (typeof sessionId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(sessionId)
        || typeof sessionFile !== "string" || sessionFile.length > 4096
        || sessionFile.includes("\0") || !isAbsolute(sessionFile)) {
        throw new Error("La conversation active ne fournit pas de référence persistante exploitable.");
      }
      if (!established && config.expectedSessionId && sessionId !== config.expectedSessionId) {
        rejected = true;
        throw new Error("La conversation ouverte ne correspond pas à celle demandée. Reprise interrompue.");
      }
      const name = manager.getSessionName();
      const materialized = existsSync(sessionFile);
      if (materialized) materializedFile = sessionFile;
      snapshot = {
        ...snapshot, sessionId, sessionFile,
        name: typeof name === "string" ? Array.from(name.split(/\r?\n/, 1)[0].replace(/[\x00-\x1f\x7f]/g, "").trim()).slice(0, 512).join("") || null : null,
        working: hasWorkingSubagents() || (typeof context.isIdle === "function" ? context.isIdle() === false : null),
        materialized,
        deleted: !materialized && materializedFile === sessionFile,
      };
    } catch (error) {
      snapshot.error = error instanceof Error ? error.message : String(error);
      notify(snapshot.error);
    }
    try {
      const serialized = JSON.stringify(snapshot);
      if (serialized !== previous) {
        if (config.remote === true) {
          process.stdout.write(`\x1b]777;soreno;${config.runId};${Buffer.from(serialized).toString("base64")}\x07`);
        }
        writeFileSync(`${config.metadataPath}.tmp`, serialized, { mode: 0o600 });
        renameSync(`${config.metadataPath}.tmp`, config.metadataPath);
        previous = serialized;
      }
      if (!snapshot.error) { established = true; notified = false; }
    } catch {
      // Retry on the next tick. Never write CLI history or let bridge I/O break it.
      notify("Impossible d’enregistrer la liaison de conversation ; la reprise n’est pas garantie.");
    }
    if (rejected) { clearInterval(timer); stopObservingSubagents(); context.shutdown(); }
  }

  function isMainSession(ctx) {
    // OMP reuses explicit extension paths for its SDK subagents. Their metadata
    // belongs to a different conversation, even if they can forward UI requests.
    if (config.mode === "rpc") return ctx.mode === "rpc" && ctx.agent?.kind === "main";
    return ctx.mode === undefined ? ctx.hasUI === true : ctx.mode === "tui";
  }

  // Bounded: Soreno reads at most 64 KiB of sidecar.
  function finishedTurn(messages) {
    // Only the loop's final reply counts; a trailing user/tool message means none.
    const last = Array.isArray(messages) ? messages.at(-1) : undefined;
    if (last?.role !== "assistant" || last === summarizedReply) return null;
    const content = last.content;
    const message = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
      : "";
    if (Buffer.byteLength(JSON.stringify(message)) > 32 * 1024) return null;
    summarizedReply = last;
    return { id: randomUUID(), message };
  }

  function observe(nextContext, sessionChanged) {
    if (!isMainSession(nextContext)) return;
    context = nextContext;
    if (sessionChanged) pendingQuestions.clear();
    if (config.provider === "pi") context.ui?.setWorkingIndicator?.({ frames: ["•"] });
    if (config.provider === "omp" && !unsubscribeSubagents && typeof api.events?.on === "function") {
      unsubscribeSubagents = api.events.on("task:subagent:lifecycle", (event) => {
        if (typeof event?.id !== "string" || !event.id) return;
        if (event.status === "started") activeSubagents.add(event.id);
        else if (["completed", "failed", "aborted"].includes(event.status)) activeSubagents.delete(event.id);
      });
    }
    publish();
    clearInterval(timer);
    if (!rejected) {
      // ponytail: APIs have no common rename event; sample the live manager every
      // 250 ms. A forced kill can lose that last interval, not acknowledged history.
      timer = setInterval(publish, 250);
      timer.unref?.();
    }
  }
  const observeSession = (_event, nextContext) => observe(nextContext, true);
  api.on("session_start", observeSession);
  // A rename keeps the session, and the question still awaiting its answer.
  if (config.provider === "pi") api.on("session_info_changed", (_event, nextContext) => observe(nextContext, false));
  api.on("session_switch", observeSession);
  api.on(config.provider === "pi" ? "session_fork" : "session_branch", observeSession);
  api.on("agent_start", (_event, nextContext) => {
    if (!isMainSession(nextContext)) return;
    turn = null;
    if (pendingQuestions.size > 0) { pendingQuestions.clear(); publish(); }
  });
  api.on("agent_end", (event, nextContext) => {
    if (!isMainSession(nextContext)) return;
    pendingQuestions.clear();
    // OMP also ends loops that continue on their own.
    if (event?.willContinue !== true && event?.isTerminal !== false) turn = finishedTurn(event?.messages);
    publish();
  });
  api.on("tool_execution_start", (event, nextContext) => {
    if (!isMainSession(nextContext) || typeof event?.toolCallId !== "string" || !isQuestionTool(event.toolName)) return;
    pendingQuestions.add(event.toolCallId);
    publish();
  });
  api.on("tool_execution_end", (event, nextContext) => {
    if (!isMainSession(nextContext) || !pendingQuestions.delete(event?.toolCallId)) return;
    publish();
  });
  api.on("session_shutdown", (_event, nextContext) => {
    if (!isMainSession(nextContext)) return;
    context = nextContext;
    pendingQuestions.clear();
    stopObservingSubagents();
    publish();
    clearInterval(timer);
  });
  appendSystemPrompt(api, config.systemAppend);
}

export function appendSystemPrompt(api, text) {
  if (typeof text !== "string" || !text) return;
  // Unlike --append-system-prompt, this keeps OMP's APPEND_SYSTEM.md discovery working.
  api.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    // Pi providers such as pi-claude-bridge forward the structured options, not a forced prompt.
    if (options && typeof options.appendSystemPrompt === "string") {
      if (!options.appendSystemPrompt.includes(text)) {
        options.appendSystemPrompt = options.appendSystemPrompt
          ? `${options.appendSystemPrompt}\n\n${text}`
          : text;
      }
      return undefined;
    }
    // OMP passes separate blocks; merging them would defeat its prompt caching.
    if (Array.isArray(event.systemPrompt)) return { systemPrompt: [...event.systemPrompt, text] };
    return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  });
}

function isQuestionTool(name) {
  return typeof name === "string"
    && ["ask", "askuserquestion", "ask_user_question", "request_user_input"].includes(name.toLowerCase());
}
