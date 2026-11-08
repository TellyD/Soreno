import { History, LoaderCircle, Square, X } from "lucide-react";
import { useState } from "react";
import {
  agentConversationBtwRunning,
  type AgentConversationBtwTopic,
  type AgentConversationState,
} from "../../domain/agentConversation";
import { MarkdownContent } from "../MarkdownContent";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import type { AgentStrings } from "./agentStrings";
import "./AgentConversationBtw.css";

type View = AgentConversationState["btwView"];

/** OMP's side questions above the composer, apart from the transcript. */
export function AgentConversationBtw({
  topics,
  view,
  disabled,
  onShow,
  onCancel,
  onFollowUp,
  s,
}: {
  topics: readonly AgentConversationBtwTopic[];
  view: View;
  /** OMP cannot take a question now. */
  disabled: boolean;
  onShow: (view: View) => void;
  onCancel: (id: string) => void;
  /** Resolves to whether OMP took the question. */
  onFollowUp: (question: string, id: string) => Promise<boolean>;
  s: AgentStrings["conversation"];
}) {
  const [draft, setDraft] = useState("");
  const topic =
    view && view !== "history"
      ? topics.find(({ id }) => id === view.topic)
      : undefined;
  if (!topic && view !== "history") return null;
  const running = !!topic && agentConversationBtwRunning(topic);
  const title = topic ? s.btw : s.btwHistory;

  function followUp() {
    const question = draft.trim();
    if (!topic || !question || running || disabled) return;
    setDraft("");
    void onFollowUp(question, topic.id).then((accepted) => {
      if (!accepted) setDraft((current) => current || question);
    });
  }

  return (
    <div className="agent-conversation-panel agent-conversation-btw is-open">
      <div className="agent-conversation-btw-header">
        <span className="agent-conversation-panel-title">{title}</span>
        {running ? (
          <LoaderCircle
            className="app-loading-spinner"
            size={14}
            aria-hidden="true"
          />
        ) : null}
        <span className="agent-conversation-btw-actions">
          {running ? (
            <IconButton
              size="small"
              aria-label={s.btwStop}
              title={s.btwStop}
              onClick={() => onCancel(topic.id)}
            >
              <Square />
            </IconButton>
          ) : null}
          {topic ? (
            <IconButton
              size="small"
              aria-label={s.btwOpenHistory}
              title={s.btwOpenHistory}
              onClick={() => onShow("history")}
            >
              <History />
            </IconButton>
          ) : null}
          <IconButton
            size="small"
            aria-label={s.btwClose}
            title={s.btwClose}
            onClick={() => onShow(null)}
          >
            <X />
          </IconButton>
        </span>
      </div>
      <div
        className="agent-conversation-panel-list"
        role="region"
        tabIndex={0}
        aria-label={title}
        aria-busy={running}
      >
        {topic ? (
          topic.turns.map((turn, index) => (
            <div key={index} className="agent-conversation-btw-turn">
              <p className="agent-conversation-btw-question">{turn.question}</p>
              {turn.answer ? (
                <MarkdownContent
                  className="agent-conversation-prose"
                  content={turn.answer}
                />
              ) : null}
              {turn.status === "running" && !turn.answer ? (
                <p className="agent-conversation-btw-status">{s.btwWaiting}</p>
              ) : turn.status === "error" ||
                turn.status === "cancelled" ||
                turn.status === "interrupted" ? (
                <p
                  className={`agent-conversation-btw-status is-${turn.status}`}
                >
                  {turn.error ?? s.btwStatus[turn.status]}
                </p>
              ) : null}
            </div>
          ))
        ) : topics.length ? (
          <ul className="agent-conversation-btw-topics">
            {topics.map(({ id, turns }) => (
              <li key={id}>
                <button
                  type="button"
                  aria-label={s.btwOpen(turns[0].question)}
                  onClick={() => onShow({ topic: id })}
                >
                  <span>{turns[0].question}</span>
                  <span className="agent-conversation-btw-count">
                    {s.btwTurns(turns.length)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="agent-conversation-btw-status">{s.btwEmpty}</p>
        )}
      </div>
      {topic ? (
        <form
          className="agent-conversation-btw-follow-up"
          onSubmit={(event) => {
            event.preventDefault();
            followUp();
          }}
        >
          <Input
            size="small"
            aria-label={s.btwFollowUp}
            placeholder={s.btwFollowUp}
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
      ) : null}
    </div>
  );
}
