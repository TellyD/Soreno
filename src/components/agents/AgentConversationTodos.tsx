import {
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash,
  X,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";
import type {
  AgentConversationTodoPhase,
  AgentConversationTodoStatus,
} from "../../domain/agentConversation";
import { IconButton } from "../ui/IconButton";
import type { AgentStrings } from "./agentStrings";
import "./AgentConversationTodos.css";

const TODO_ICONS: Record<AgentConversationTodoStatus, LucideIcon> = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CircleCheck,
  abandoned: CircleSlash,
  blocked: CircleAlert,
};

// OMP names the phase of a flat todo list "Tasks": alone, it repeats the panel title.
const OMP_DEFAULT_PHASE = "Tasks";

/** OMP's todo list above the composer: progress at a glance, every task once opened. */
export function AgentConversationTodos({
  phases,
  s,
}: {
  phases: readonly AgentConversationTodoPhase[];
  s: AgentStrings["conversation"];
}) {
  const [open, setOpen] = useState(false);
  // Content, not identity: `get_state` rebuilds the same list, and any change shows it again.
  // shortcut: a list that changes then returns to the dismissed content stays hidden, track changes if users hit it.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const tasks = phases.flatMap((phase) => phase.tasks);
  const key = JSON.stringify(phases);
  if (tasks.length === 0 || dismissed === key) return null;
  const done = tasks.filter(
    ({ status }) => status === "completed" || status === "abandoned",
  ).length;
  const current =
    tasks.find(({ status }) => status === "in_progress") ??
    tasks.find(({ status }) => status === "pending");
  return (
    <div
      className={`agent-conversation-panel agent-conversation-todos${open ? " is-open" : ""}`}
    >
      <div className="agent-conversation-todos-header">
        <button
          className="agent-conversation-panel-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={14} aria-hidden="true" />
          <span className="agent-conversation-panel-title">{s.todos}</span>
          <span className="agent-conversation-panel-progress">
            {done}/{tasks.length}
          </span>
          {current ? (
            <span className="agent-conversation-panel-current">
              {current.content}
            </span>
          ) : null}
        </button>
        {done === tasks.length ? (
          <IconButton
            size="small"
            aria-label={s.todosClose}
            title={s.todosClose}
            onClick={() => setDismissed(key)}
          >
            <X />
          </IconButton>
        ) : null}
      </div>
      {open ? (
        <div
          id={listId}
          className="agent-conversation-panel-list"
          role="region"
          tabIndex={0}
          aria-label={s.todos}
        >
          {phases.map((phase, phaseIndex) => (
            <div key={phaseIndex}>
              {phase.name &&
              (phases.length > 1 || phase.name !== OMP_DEFAULT_PHASE) ? (
                <p>{phase.name}</p>
              ) : null}
              <ul>
                {phase.tasks.map((task, taskIndex) => {
                  const Icon = TODO_ICONS[task.status];
                  return (
                    <li key={taskIndex} className={`is-${task.status}`}>
                      <Icon
                        size={14}
                        role="img"
                        aria-label={s.todoStatus[task.status]}
                      />
                      <span>{task.content}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
