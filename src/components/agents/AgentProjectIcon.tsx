import { Folder, type LucideIcon } from "lucide-react";
import type { AgentProject } from "../../domain/agentSessions";
import { findAppearanceIcon } from "../appearanceIcons";

export function AgentProjectIcon({
  project,
  size,
  fallback = Folder,
}: {
  project: Pick<AgentProject, "color" | "icon" | "iconDataUrl"> | undefined;
  size: number;
  fallback?: LucideIcon;
}) {
  if (project?.iconDataUrl) {
    return (
      <img
        className="agent-project-icon"
        src={project.iconDataUrl}
        alt=""
        width={size}
        height={size}
      />
    );
  }
  const Icon = findAppearanceIcon(project?.icon)?.icon ?? fallback;
  return <Icon size={size} color={project?.color ?? undefined} />;
}
