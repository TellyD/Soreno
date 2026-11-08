import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, RotateCw, TerminalSquare } from "lucide-react";
import {
  agentInstallGuides,
  agentProviderLabel,
  agentProviderOf,
  type AgentProject,
  type AgentSession,
} from "../../domain/agentSessions";
import { notifyError } from "../../notifications";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { useAgentStrings } from "./agentStrings";

export function MissingAgentNotice({
  session,
  environment,
  disabled,
  onRetry,
}: {
  session: AgentSession;
  environment: AgentProject["environment"] | undefined;
  disabled: boolean;
  onRetry: () => void;
}) {
  const s = useAgentStrings();
  const place =
    environment?.kind === "wsl"
      ? s.missingAgentWsl(environment.distribution)
      : environment?.kind === "ssh"
        ? s.missingAgentSsh(environment.ssh?.host ?? "")
        : s.missingAgentLocal;
  const provider = agentProviderOf(session.executable);
  return (
    <EmptyState
      fill
      icon={<TerminalSquare />}
      title={s.missingAgentTitle(agentProviderLabel(session.executable))}
      description={s.missingAgentBody(
        session.kind === "conversation" ? "omp" : session.executable,
        place,
      )}
      actions={
        <>
          {provider ? (
            <Button
              startIcon={<ExternalLink />}
              onClick={() =>
                void openUrl(agentInstallGuides[provider]).catch(() =>
                  notifyError(s.urlOpenError),
                )
              }
            >
              {s.agentInstallGuide}
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={disabled}
            startIcon={<RotateCw />}
            onClick={onRetry}
          >
            {s.retry}
          </Button>
        </>
      }
    />
  );
}
