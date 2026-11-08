import { createPortal } from "react-dom";
import type { ProjectService } from "../../domain/projectServices";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { useAgentStrings } from "./agentStrings";

export function AgentServiceTrustDialog({
  services,
  pending,
  onCancel,
  onConfirm,
}: {
  services: ProjectService[] | undefined;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const s = useAgentStrings();
  return createPortal(
    <ConfirmationDialog
      title={s.trustServicesTitle}
      description={
        <span className="project-services-trust-copy">
          <span>{s.trustServicesDescription}</span>
          {services?.map((service) => (
            <span className="project-services-trust-command" key={service.id}>
              <strong>{service.label}</strong>
              <span className="project-services-trust-detail">
                <span>{s.trustWorkingDirectory}</span>
                <code>{service.cwd}</code>
              </span>
              <span className="project-services-trust-detail">
                <span>{s.trustArguments}</span>
                <code>
                  {JSON.stringify([service.executable, ...service.args])}
                </code>
              </span>
            </span>
          ))}
        </span>
      }
      cancelLabel={s.cancel}
      closeLabel={s.cancel}
      confirmLabel={s.trustAndStart}
      confirmPending={pending}
      confirmVariant="primary"
      cancelDisabled={pending}
      confirmDisabled={pending}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
    document.body,
  );
}
