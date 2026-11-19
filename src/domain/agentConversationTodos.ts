import type {
  AgentConversationTodoPhase,
  AgentConversationTodoStatus,
} from "./agentConversation";
import { isObject, text } from "./agentConversationRecords";

const TODO_STATUSES: Record<string, true> = {
  pending: true,
  in_progress: true,
  completed: true,
  abandoned: true,
  blocked: true,
};

export function todoPhases(
  value: unknown,
): AgentConversationTodoPhase[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isObject).flatMap((phase) => {
    const tasks = (Array.isArray(phase.tasks) ? phase.tasks : [])
      .filter(isObject)
      .flatMap((task) =>
        text(task.content)
          ? [
              {
                content: text(task.content),
                // OMP statuses are free text: `__proto__` must not resolve through Object.prototype.
                status: Object.prototype.hasOwnProperty.call(
                  TODO_STATUSES,
                  text(task.status),
                )
                  ? (task.status as AgentConversationTodoStatus)
                  : "pending",
              },
            ]
          : [],
      );
    return tasks.length ? [{ name: text(phase.name), tasks }] : [];
  });
}
