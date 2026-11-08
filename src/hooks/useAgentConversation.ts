import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import * as api from "../data/agentConversationApi";
import {
  agentConversationRestoredQueue,
  applyAgentConversationRecord,
  initialAgentConversationState,
  type AgentConversationDialog,
  type AgentConversationDialogAnswer,
  type AgentConversationImage,
  type AgentConversationModel,
  type AgentConversationQueuedMessage,
  type AgentConversationRecord,
  type AgentConversationState,
} from "../domain/agentConversation";
import {
  agentConversationBtwRequest,
  agentConversationGoalRequest,
} from "../domain/agentConversationCommands";
import { errorMessage } from "../domain/errors";

type Action = AgentConversationRecord | { type: "soreno_reset" };
type Request = (
  record: AgentConversationRecord,
) => Promise<AgentConversationRecord | null>;

/** State that a conversation switch may change, besides its messages; a model brings its levels. */
const CONVERSATION_STATE = [
  "get_state",
  "get_session_stats",
  "get_available_thinking_levels",
];
/** Tool durations are measured on Soreno's clock: OMP's records carry no time. */
const TIMED: Record<string, true> = {
  tool_execution_start: true,
  tool_execution_end: true,
};

function reducer(
  state: AgentConversationState,
  action: Action,
): AgentConversationState {
  return action.type === "soreno_reset"
    ? initialAgentConversationState
    : applyAgentConversationRecord(state, action);
}

/** Asks OMP for the conversation it holds; false when a request went unanswered. */
async function loadConversation(request: Request) {
  // Not awaited: an OMP older than 18.5 refuses a command it does not know without its id.
  void request({ type: "get_btw_history" });
  const answers = await Promise.all(
    [...CONVERSATION_STATE, "get_messages"].map((type) => request({ type })),
  );
  return answers.every((answer) => answer);
}

/** Pending requests get `null` once no response can come anymore. */
function settle(
  waiting: Map<string, (record: AgentConversationRecord | null) => void>,
) {
  const resolvers = [...waiting.values()];
  waiting.clear();
  for (const resolve of resolvers) resolve(null);
}

/**
 * Follows one OMP run. `hasRun` is true while Soreno holds its process (running or exited);
 * a new `runRevision` is a new process, so the transcript is rebuilt from OMP's history.
 */
export function useAgentConversation(
  sessionId: string,
  hasRun: boolean,
  runRevision: number,
) {
  const [state, dispatch] = useReducer(reducer, initialAgentConversationState);
  // OMP answers once its plugins are loaded: until then the view is still starting.
  const [loaded, setLoaded] = useState(false);
  const pending = useRef(
    new Map<string, (record: AgentConversationRecord | null) => void>(),
  );
  const nextRequest = useRef(1);
  // A command sent before the subscription would lose its response: requests await it.
  const subscribed = useRef(Promise.resolve(false));

  const fail = useCallback((reason: unknown) => {
    dispatch({ type: "response", success: false, error: errorMessage(reason) });
  }, []);

  /** Resolves to whether the command reached OMP; a failure is shown as an error notice. */
  const send = useCallback(
    (record: AgentConversationRecord) =>
      api.sendAgentConversationCommand(sessionId, record).then(
        () => true,
        (reason: unknown) => {
          fail(reason);
          return false;
        },
      ),
    [fail, sessionId],
  );

  /** Resolves with OMP's response, or `null` if the command could not be sent or answered. */
  const request = useCallback<Request>(
    async (record) => {
      const subscription = subscribed.current;
      // The run may have been replaced or closed while the subscription settled.
      if (!(await subscription) || subscription !== subscribed.current)
        return null;
      const id = `view-${nextRequest.current++}`;
      return new Promise<AgentConversationRecord | null>((resolve) => {
        pending.current.set(id, resolve);
        api
          .sendAgentConversationCommand(sessionId, { ...record, id })
          .catch((reason) => {
            pending.current.delete(id);
            fail(reason);
            resolve(null);
          });
      });
    },
    [fail, sessionId],
  );

  useEffect(() => {
    dispatch({ type: "soreno_reset" });
    setLoaded(false);
    let ready = (_subscribed: boolean) => {};
    subscribed.current = new Promise((resolve) => (ready = resolve));
    if (!hasRun) {
      ready(false);
      return;
    }
    let closed = false;
    // An exited run replays its exit while subscribing; every request would fail.
    let exited = false;
    let close = () => {};
    const waiting = pending.current;
    // OMP before 18.13.3 reports a manual compaction only through its state.
    let compacting = false;
    // OMP 18.10 may still report a compaction just after it ends, then stays silent.
    let poll: number | undefined;
    const stopPolling = () => {
      window.clearTimeout(poll);
      poll = undefined;
    };
    void api
      .subscribeAgentConversation(sessionId, (record) => {
        // Replayed records can arrive after the run or session changed.
        if (closed) return;
        const resolve =
          record.type === "response" && typeof record.id === "string"
            ? waiting.get(record.id)
            : undefined;
        if (resolve) waiting.delete(record.id as string);
        dispatch(
          typeof record.type === "string" && TIMED[record.type]
            ? { ...record, receivedAt: Date.now() }
            : record,
        );
        resolve?.(record);
        switch (record.type) {
          case "soreno_exited":
            exited = true;
            stopPolling();
            settle(waiting);
            break;
          case "response": {
            // OMP before 18.6.3 does not know it, and before 18.5 answers without an id.
            if (
              record.command === "abort_and_restore_queue" &&
              record.success !== true
            )
              void send({ type: "abort" });
            // An abort can end a compaction, which then reports nothing.
            if (
              record.command === "abort_and_restore_queue" ||
              record.command === "abort"
            )
              void send({ type: "get_state" });
            if (record.command !== "get_state" || record.success !== true)
              break;
            const data = record.data as { isCompacting?: unknown } | undefined;
            const ended = compacting && data?.isCompacting !== true;
            compacting = data?.isCompacting === true;
            if (!compacting) stopPolling();
            else if (!poll)
              poll = window.setTimeout(() => {
                poll = undefined;
                void send({ type: "get_state" });
              }, 1000);
            // Like OMP's own view, the transcript stays: only the context usage changed.
            if (ended) void send({ type: "get_session_stats" });
            break;
          }
          // `/compact` runs in the background and ends with its output only.
          case "command_output":
            void send({ type: "get_state" });
            break;
          case "auto_compaction_start":
          case "manual_compaction_start":
          case "compaction_start":
            compacting = true;
            break;
          case "auto_compaction_end":
          case "manual_compaction_end":
          case "compaction_end":
            // A manual compaction outlives the automatic one it aborted.
            void send({ type: "get_state" });
            void send({ type: "get_session_stats" });
            break;
          case "session_settled":
            void send({ type: "get_session_stats" });
            break;
          case "model_changed":
            void send({ type: "get_state" });
            void send({ type: "get_available_thinking_levels" });
            break;
        }
      })
      .then(
        (unsubscribe) => {
          if (closed) return unsubscribe();
          close = unsubscribe;
          ready(!exited);
          if (exited) return setLoaded(true);
          void request({ type: "get_available_models" });
          void request({ type: "get_available_commands" });
          void request({ type: "get_subagents" });
          void loadConversation(request).then(() => {
            if (!closed) setLoaded(true);
          });
        },
        (reason: unknown) => {
          ready(false);
          if (closed) return;
          fail(reason);
          setLoaded(true);
        },
      );
    return () => {
      closed = true;
      stopPolling();
      ready(false);
      subscribed.current = Promise.resolve(false);
      close();
      settle(waiting);
    };
  }, [fail, hasRun, request, runRevision, send, sessionId]);

  const busy = state.busy;
  /** Resolves to whether OMP accepted the message; a refusal is shown as an error notice. */
  const prompt = useCallback(
    async (message: string, images: AgentConversationImage[] = []) => {
      const goal = agentConversationGoalRequest(message);
      if (goal) return (await request(goal))?.success === true;
      // A side question runs beside the turn: neither steered nor queued.
      const btw = agentConversationBtwRequest(message);
      if (btw) {
        const answer = await request(btw);
        if (btw.type === "get_btw_history" && answer) {
          // The reducer ignores the refusal an OMP without `/btw` gives the view's own request.
          if (answer.success !== true) fail(answer.error ?? btw.type);
          else dispatch({ type: "soreno_btw_view", view: "history" });
        }
        return answer?.success === true;
      }
      const content = images.length
        ? {
            message,
            images: images.map((image) => ({ type: "image", ...image })),
          }
        : { message };
      const answer = await request(
        // A message typed during a run steers it, as Enter does in OMP's terminal view.
        busy
          ? { type: "prompt", ...content, streamingBehavior: "steer" }
          : { type: "prompt", ...content },
      );
      const accepted = answer?.success === true;
      // Commands such as `/todo done` change the todos without any event.
      if (accepted && message.startsWith("/")) void send({ type: "get_state" });
      return accepted;
    },
    [busy, fail, request, send],
  );

  /** Resolves to whether OMP took the follow-up in topic `recordId`. */
  const askBtw = useCallback(
    async (question: string, recordId: string) =>
      (await request({ type: "btw", question, recordId }))?.success === true,
    [request],
  );

  const cancelBtw = useCallback(
    (recordId: string) => send({ type: "btw_cancel", recordId }),
    [send],
  );

  const showBtw = useCallback(
    (view: AgentConversationState["btwView"]) =>
      dispatch({ type: "soreno_btw_view", view }),
    [],
  );

  const background = state.background;
  /** Stops the run like Esc in OMP's terminal view: the queued messages come back, oldest first. */
  const abort = useCallback(async () => {
    // An abort leaves background jobs running; once only they remain, Stop is meant for them.
    if (background) {
      await request({ type: "prompt", message: "/jobs kill all" });
      return { messages: [], incomplete: false };
    }
    dispatch({ type: "soreno_abort_requested" });
    const answer = await request({ type: "abort_and_restore_queue" });
    // A refusal falls back to a plain abort in the listener.
    // shortcut: before OMP 18.5 the id-less refusal leaves this request pending until the process exits; drop once older OMP is unsupported.
    return answer?.success === true
      ? agentConversationRestoredQueue(answer.data)
      : { messages: [], incomplete: false };
  }, [background, request]);

  const removeQueued = useCallback(
    ({ text, queue }: AgentConversationQueuedMessage) =>
      send({ type: "remove_queued_message", message: text, queue }),
    [send],
  );

  const answer = useCallback(
    (dialog: AgentConversationDialog, reply: AgentConversationDialogAnswer) => {
      dispatch({
        type: "soreno_dialog_answered",
        id: dialog.id,
        receivedAt: Date.now(),
      });
      return send({ type: "extension_ui_response", id: dialog.id, ...reply });
    },
    [send],
  );

  const setModel = useCallback(
    async ({ provider, id }: AgentConversationModel) => {
      const response = await request({
        type: "set_model",
        provider,
        modelId: id,
      });
      // Thinking levels and the context window depend on the model.
      if (response?.success === true)
        await Promise.all([
          request({ type: "get_available_thinking_levels" }),
          request({ type: "get_session_stats" }),
        ]);
    },
    [request],
  );

  const setThinkingLevel = useCallback(
    (level: string) => send({ type: "set_thinking_level", level }),
    [send],
  );

  /** Resolves to whether the new conversation loaded; "cancelled" when OMP declined it. */
  const replaceConversation = useCallback(
    async (record: AgentConversationRecord) => {
      const response = await request(record);
      const data =
        response?.data && typeof response.data === "object"
          ? (response.data as Record<string, unknown>)
          : {};
      if (response?.success !== true) return false;
      if (data.cancelled === true) return "cancelled";
      return loadConversation(request);
    },
    [request],
  );

  const newConversation = useCallback(
    () => replaceConversation({ type: "new_session" }),
    [replaceConversation],
  );

  const switchConversation = useCallback(
    (sessionPath: string) =>
      replaceConversation({ type: "switch_session", sessionPath }),
    [replaceConversation],
  );

  const cancelSubagent = useCallback(
    (subagentId: string) => send({ type: "cancel_subagent", subagentId }),
    [send],
  );

  return {
    state,
    loaded,
    prompt,
    abort,
    removeQueued,
    answer,
    setModel,
    setThinkingLevel,
    newConversation,
    switchConversation,
    cancelSubagent,
    askBtw,
    cancelBtw,
    showBtw,
    reportError: fail,
  };
}
