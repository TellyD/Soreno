import { ImagePlus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  importAgentProjectIcon,
  PROJECT_ICON_ACCEPT,
} from "../../data/agentProjectIcon";
import type {
  AgentProject,
  AgentProjectAppearance,
} from "../../domain/agentSessions";
import { useScopedNotification } from "../../notifications";
import {
  AppearanceCustomizer,
  appearancePopoverSize,
} from "../AppearanceCustomizer";
import { Button } from "../ui/Button";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import { AgentProjectIcon } from "./AgentProjectIcon";
import { useAgentStrings } from "./agentStrings";
import "./AgentProjectAppearancePopover.css";

const margin = 8;
const imageSectionHeight = 108;

export function AgentProjectAppearancePopover({
  project,
  x,
  y,
  disabled,
  onSave,
  onClose,
}: {
  project: Pick<AgentProject, "id" | "name"> & AgentProjectAppearance;
  x: number;
  y: number;
  disabled: boolean;
  onSave: (
    projectId: string,
    change: AgentProjectAppearance,
  ) => Promise<boolean>;
  onClose: () => void;
}) {
  const s = useAgentStrings();
  const hintId = useId();
  const layerRef = useDismissibleLayer<HTMLElement>(true, onClose);
  const notice = useScopedNotification("agent-project-appearance");
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Stays enabled while saving (disabling flashed the grid); the workspace queues and merges picks.
  const [draft, setDraft] = useState<AgentProjectAppearance | null>(null);
  // Bumped on every pick so an import or save finishing after a newer choice is ignored.
  const pickGeneration = useRef(0);
  const shown = draft ?? project;
  function pick(change: AgentProjectAppearance) {
    const generation = ++pickGeneration.current;
    setDraft((current) => {
      const base = current ?? project;
      return {
        color: base.color,
        icon: base.icon,
        iconDataUrl: base.iconDataUrl,
        ...change,
      };
    });
    void onSave(project.id, change).then(() => {
      if (mounted.current && generation === pickGeneration.current)
        setDraft(null);
    });
  }
  async function importImage(file: File) {
    setImporting(true);
    const generation = pickGeneration.current;
    try {
      const iconDataUrl = await importAgentProjectIcon(file);
      if (!mounted.current || generation !== pickGeneration.current) return;
      notice.clear();
      pick({ iconDataUrl, icon: null });
    } catch {
      if (mounted.current) notice.error(s.projectIconError);
    } finally {
      if (mounted.current) setImporting(false);
    }
  }
  return createPortal(
    <section
      ref={layerRef}
      aria-label={`${s.customizeProject} · ${project.name}`}
      className="appearance-customizer-popover"
      data-agent-project-appearance=""
      style={{
        left: Math.max(
          margin,
          Math.min(x, window.innerWidth - appearancePopoverSize.width - margin),
        ),
        top: Math.max(
          margin,
          Math.min(
            y,
            window.innerHeight -
              appearancePopoverSize.height -
              imageSectionHeight -
              margin,
          ),
        ),
      }}
    >
      <AppearanceCustomizer
        autoFocusSearch
        color={shown.color ?? null}
        disabled={disabled}
        icon={shown.iconDataUrl ? null : (shown.icon ?? null)}
        onSelectColor={(color) => pick({ color })}
        onSelectIcon={(icon) => pick({ icon, iconDataUrl: null })}
      />
      <div className="appearance-customizer-section">
        <span className="appearance-customizer-label">{s.projectImage}</span>
        <div className="agent-project-image-row">
          <AgentProjectIcon project={shown} size={20} />
          <input
            ref={fileInput}
            type="file"
            accept={PROJECT_ICON_ACCEPT}
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void importImage(file);
            }}
          />
          <Button
            size="small"
            startIcon={<ImagePlus />}
            aria-describedby={hintId}
            disabled={disabled || importing}
            onClick={() => fileInput.current?.click()}
          >
            {importing ? s.importingProjectIcon : s.importProjectIcon}
          </Button>
          {shown.iconDataUrl || shown.icon || shown.color ? (
            <Button
              size="small"
              disabled={disabled || importing}
              onClick={() =>
                pick({ iconDataUrl: null, icon: null, color: null })
              }
            >
              {s.resetProjectAppearance}
            </Button>
          ) : null}
        </div>
        <p className="agent-project-image-hint" id={hintId}>
          {s.projectIconHint}
        </p>
      </div>
    </section>,
    document.body,
  );
}
