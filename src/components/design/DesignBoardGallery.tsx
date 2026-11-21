import { Palette, Plus } from "lucide-react";
import type { Ref } from "react";
import { formatCompactDate } from "../../domain/dateTime";
import type { DesignBoard } from "../../domain/design";
import { designFitView } from "../../domain/designCanvas";
import { designFrameDocument } from "../../domain/designFrameDocument";
import { useDesignFrames } from "../../hooks/useDesignFrames";
import { useI18n } from "../../i18n";
import { useTheme } from "../../theme/ThemeProvider";
import { Button } from "../ui/Button";
import { DESIGN_FRAME_PICKER } from "./DesignCanvas";
import "./DesignBoardGallery.css";

// Matches the fixed grid track in DesignBoardGallery.css.
const PREVIEW_WIDTH = 280;
const PREVIEW_HEIGHT = 168;

function BoardPreview({ boardId }: { boardId: string }) {
  const { theme } = useTheme();
  const frames = useDesignFrames(boardId);
  if (!frames?.length)
    return (
      <div className="design-gallery-preview is-empty" aria-hidden="true">
        <Palette size={20} />
      </div>
    );
  // Floor 0: a wide board shrinks below the canvas zoom limit rather than clip.
  const view = designFitView(frames, PREVIEW_WIDTH, PREVIEW_HEIGHT, 12, 0);
  return (
    <div className="design-gallery-preview" aria-hidden="true">
      <div
        className="design-gallery-world"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        {frames.map((frame) => (
          <iframe
            key={frame.id}
            title={frame.title}
            sandbox="allow-scripts"
            loading="lazy"
            tabIndex={-1}
            srcDoc={designFrameDocument(frame.html, DESIGN_FRAME_PICKER, theme)}
            style={{
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
              zIndex: frame.z,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** The design view's home: every board as a card with a miniature of its frames. */
export function DesignBoardGallery({
  boards,
  projectName,
  onOpen,
  onCreate,
  createRef,
}: {
  boards: readonly DesignBoard[];
  projectName: (projectId: string | null) => string;
  onOpen: (boardId: string) => void;
  onCreate: () => void;
  createRef: Ref<HTMLButtonElement>;
}) {
  const { locale, t } = useI18n();
  return (
    <div className="design-gallery">
      <header className="design-gallery-header">
        <h2>{t("design.allBoards")}</h2>
        <Button
          ref={createRef}
          size="small"
          variant="primary"
          startIcon={<Plus />}
          onClick={onCreate}
        >
          {t("design.newBoard")}
        </Button>
      </header>
      <ul className="design-gallery-grid">
        {boards.map((board) => (
          <li key={board.id} className="design-gallery-card">
            <BoardPreview boardId={board.id} />
            <button
              type="button"
              className="design-gallery-open"
              onClick={() => onOpen(board.id)}
            >
              {board.name}
            </button>
            <span className="design-gallery-meta">
              <span className="design-gallery-project">
                {projectName(board.projectId)}
              </span>
              <span>{formatCompactDate(board.updatedAt, locale)?.value}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
