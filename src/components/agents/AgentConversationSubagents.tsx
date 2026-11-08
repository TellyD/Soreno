import {
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  LoaderCircle,
  Square,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";
import type { AgentConversationSubagent } from "../../domain/agentConversation";
import { IconButton } from "../ui/IconButton";
import type { AgentStrings } from "./agentStrings";
import "./AgentConversationSubagents.css";

type Strings = AgentStrings["conversation"];

const SUBAGENT_ICONS: Record<AgentConversationSubagent["status"], LucideIcon> =
  {
    running: LoaderCircle,
    completed: CircleCheck,
    failed: CircleX,
    aborted: CircleSlash,
  };

/** One quiet line per agent; stoppable only where `onCancel` is given. */
export function SubagentList({
  agents,
  onCancel,
  s,
}: {
  agents: readonly AgentConversationSubagent[];
  onCancel?: (id: string) => void;
  s: Strings;
}) {
  if (agents.length === 0) return null;
  return (
    <ul className="agent-conversation-subagents" aria-label={s.subagents}>
      {agents.map((agent) => {
        const Icon = SUBAGENT_ICONS[agent.status];
        const running = agent.status === "running";
        return (
          <li key={agent.id} className={`is-${agent.status}`}>
            <Icon
              className={running ? "app-loading-spinner" : undefined}
              size={14}
              aria-hidden="true"
            />
            <span className="agent-conversation-subagent-name">{agent.id}</span>
            {agent.agent ? (
              <span className="agent-conversation-subagent-type">
                {agent.agent}
              </span>
            ) : null}
            <span className="agent-conversation-subagent-detail">
              {(running && agent.activity) || agent.description}
            </span>
            <span className="agent-conversation-subagent-meta">
              {s.subagentMeta(
                agent.status,
                agent.toolCount,
                agent.tokens,
                agent.durationMs,
              )}
            </span>
            {running && onCancel ? (
              <IconButton
                size="small"
                aria-label={s.stopSubagent(agent.id)}
                title={s.stopSubagent(agent.id)}
                onClick={() => onCancel(agent.id)}
              >
                <Square />
              </IconButton>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The agents still running, above the composer while the transcript scrolls. */
export function AgentConversationSubagents({
  agents,
  onCancel,
  s,
}: {
  agents: readonly AgentConversationSubagent[];
  onCancel: (id: string) => void;
  s: Strings;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const running = agents.filter(({ status }) => status === "running");
  if (running.length === 0) return null;
  return (
    <div className={`agent-conversation-panel${open ? " is-open" : ""}`}>
      <button
        className="agent-conversation-panel-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={14} aria-hidden="true" />
        <span className="agent-conversation-panel-title">{s.subagents}</span>
        <span className="agent-conversation-panel-progress">
          {running.length}
        </span>
        <span className="agent-conversation-panel-current">
          {running
            .map(({ id, agent }) => (agent ? `${id} (${agent})` : id))
            .join(", ")}
        </span>
      </button>
      {open ? (
        <div
          id={listId}
          className="agent-conversation-panel-list"
          role="region"
          tabIndex={0}
          aria-label={s.subagents}
        >
          <SubagentList agents={running} onCancel={onCancel} s={s} />
        </div>
      ) : null}
    </div>
  );
}
