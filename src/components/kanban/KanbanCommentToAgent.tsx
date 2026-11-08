import { Menu } from "@base-ui/react/menu";
import { AlertCircle, Check, ChevronDown, Clock } from "lucide-react";
import { useState } from "react";
import { sendAgentSessionMessage } from "../../data/agentSessionsApi";
import type { AgentSessionMessage } from "../../domain/agentSessions";
import { errorMessage } from "../../domain/errors";
import type { KanbanComment } from "../../domain/kanban";
import {
  kanbanCommentRequest,
  type KanbanCommentTarget,
} from "../../domain/kanbanAgent";
import { useAgentSessionMessage } from "../../hooks/useAgentSessionMessage";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { AgentProviderIcon } from "../agents/AgentProviderIcon";
import { Button } from "../ui/Button";
import { MenuItem, MenuSurface } from "../ui/Menu";

export function KanbanCommentToAgent({
  issue,
  comment,
  targets,
}: {
  issue: { identifier: string; title: string };
  comment: KanbanComment;
  /** Running agents, the issue's own session first; empty hides the button but keeps a sent status. */
  targets: readonly KanbanCommentTarget[];
}) {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{
    name: string;
    message: AgentSessionMessage;
  } | null>(null);
  const delivery = useAgentSessionMessage(sent?.message ?? null);
  const name = sent?.name ?? "";
  const status = !delivery
    ? null
    : delivery.status === "queued"
      ? delivery.error
        ? t("kanban.issue.comment.agentQueuedReason", {
            name,
            reason: delivery.error,
          })
        : t("kanban.issue.comment.agentQueued", { name })
      : delivery.status === "delivered"
        ? t("kanban.issue.comment.agentDelivered", { name })
        : delivery.error
          ? t("kanban.issue.comment.agentFailedReason", {
              name,
              reason: delivery.error,
            })
          : t("kanban.issue.comment.agentFailed", { name });

  async function send(target: KanbanCommentTarget) {
    setSending(true);
    try {
      const message = await sendAgentSessionMessage(
        target.sessionId,
        crypto.randomUUID(),
        kanbanCommentRequest(issue, comment, target.linkedToIssue),
      );
      setSent({ name: target.name, message });
    } catch (error) {
      notifyError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  if (!targets.length && !(delivery && status)) return null;

  const trigger = (
    <Button
      size="small"
      variant="secondary"
      disabled={sending}
      title={
        targets.length === 1
          ? t("kanban.issue.comment.toAgentTitle", { name: targets[0].name })
          : undefined
      }
      endIcon={targets.length > 1 ? <ChevronDown aria-hidden="true" /> : null}
      onClick={targets.length === 1 ? () => void send(targets[0]) : undefined}
    >
      {t("kanban.issue.comment.toAgent")}
    </Button>
  );

  return (
    <footer className="kanban-issue-comment-agent">
      {targets.length > 1 ? (
        <Menu.Root disabled={sending} modal={false}>
          <Menu.Trigger render={trigger} />
          <Menu.Portal>
            <Menu.Positioner
              className="agent-menu-positioner"
              sideOffset={4}
              align="start"
              collisionPadding={8}
            >
              <Menu.Popup
                render={
                  <MenuSurface
                    className="agent-actions-menu"
                    aria-label={t("kanban.issue.comment.toAgentMenu")}
                  />
                }
              >
                {targets.map((target) => (
                  <Menu.Item
                    key={target.sessionId}
                    nativeButton
                    render={
                      <MenuItem
                        leading={
                          <AgentProviderIcon executable={target.executable} />
                        }
                      />
                    }
                    onClick={() => void send(target)}
                  >
                    {target.name}
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : targets.length === 1 ? (
        trigger
      ) : null}
      {delivery && status ? (
        <span
          className="kanban-issue-comment-agent-status"
          data-status={delivery.status}
          role="status"
          title={status}
        >
          {delivery.status === "queued" ? (
            <Clock size={12} aria-hidden="true" />
          ) : delivery.status === "delivered" ? (
            <Check size={12} aria-hidden="true" />
          ) : (
            <AlertCircle size={12} aria-hidden="true" />
          )}
          <span>{status}</span>
        </span>
      ) : null}
    </footer>
  );
}
