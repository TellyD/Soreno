import { Menu } from "@base-ui/react/menu";
import {
  ArrowUpDown,
  Ellipsis,
  Palette,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRef, useState, type Ref } from "react";
import { formatCompactDate } from "../../domain/dateTime";
import {
  designBoardSortFields,
  sortDesignBoards,
  type DesignBoard,
  type DesignBoardSort,
  type DesignBoardSortField,
} from "../../domain/design";
import { designFitView } from "../../domain/designCanvas";
import { designFrameDocument } from "../../domain/designFrameDocument";
import { useDesignFrames } from "../../hooks/useDesignFrames";
import {
  readPreference,
  writePreference,
} from "../../hooks/useKanbanController";
import { useI18n, type TranslationKey } from "../../i18n";
import { useTheme } from "../../theme/ThemeProvider";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { Select } from "../ui/Select";
import { DESIGN_FRAME_PICKER } from "./DesignCanvas";
import "./DesignBoardGallery.css";

const sortLabelKeys: Record<DesignBoardSortField, TranslationKey> = {
  updated: "design.sort.updated",
  created: "design.sort.created",
  name: "design.sort.name",
};
const sortFieldKey = "soreno.design.sortField.v1";
const sortReversedKey = "soreno.design.sortReversed.v1";

function readSort(): DesignBoardSort {
  const saved = readPreference(sortFieldKey);
  return {
    field: designBoardSortFields.find((field) => field === saved) ?? "updated",
    reversed: readPreference(sortReversedKey) === "true",
  };
}

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
  onRename,
  onDelete,
  createRef,
}: {
  boards: readonly DesignBoard[];
  projectName: (projectId: string | null) => string;
  onOpen: (boardId: string) => void;
  onCreate: () => void;
  onRename: (board: DesignBoard, trigger: HTMLElement | undefined) => void;
  onDelete: (board: DesignBoard, trigger: HTMLElement | undefined) => void;
  createRef: Ref<HTMLButtonElement>;
}) {
  const { locale, t } = useI18n();
  const [sort, setSort] = useState(readSort);
  const menuTriggers = useRef(new Map<string, HTMLElement>());
  const selectSort = (next: DesignBoardSort) => {
    setSort(next);
    writePreference(sortFieldKey, next.field === "updated" ? null : next.field);
    writePreference(sortReversedKey, next.reversed ? "true" : null);
  };
  return (
    <div className="design-gallery">
      <header className="design-gallery-header">
        <h2>{t("design.allBoards")}</h2>
        <div className="design-gallery-actions">
          <Select
            aria-label={t("design.sort.label")}
            className="design-gallery-sort"
            onValueChange={(field) =>
              selectSort({ ...sort, field: field as DesignBoardSortField })
            }
            options={designBoardSortFields.map((field) => ({
              label: t(sortLabelKeys[field]),
              value: field,
            }))}
            size="small"
            value={sort.field}
          />
          <IconButton
            aria-label={t("design.sort.reverse")}
            aria-pressed={sort.reversed}
            onClick={() => selectSort({ ...sort, reversed: !sort.reversed })}
            size="small"
            title={t("design.sort.reverse")}
          >
            <ArrowUpDown size={14} />
          </IconButton>
          <Button
            ref={createRef}
            size="small"
            variant="primary"
            startIcon={<Plus />}
            onClick={onCreate}
          >
            {t("design.newBoard")}
          </Button>
        </div>
      </header>
      <ul className="design-gallery-grid">
        {sortDesignBoards(boards, sort, locale).map((board) => (
          <li key={board.id} className="design-gallery-card">
            <BoardPreview boardId={board.id} />
            <div className="design-gallery-title">
              <button
                type="button"
                className="design-gallery-open"
                onClick={() => onOpen(board.id)}
              >
                {board.name}
              </button>
              <Menu.Root modal={false}>
                <Menu.Trigger
                  ref={(node: HTMLElement | null) => {
                    if (!node) return;
                    menuTriggers.current.set(board.id, node);
                    return () => {
                      menuTriggers.current.delete(board.id);
                    };
                  }}
                  render={
                    <IconButton
                      size="small"
                      className="design-gallery-menu"
                      aria-label={t("design.boardActions", {
                        name: board.name,
                      })}
                      title={t("design.boardActions", { name: board.name })}
                    >
                      <Ellipsis />
                    </IconButton>
                  }
                />
                <Menu.Portal>
                  <Menu.Positioner
                    className="agent-menu-positioner"
                    sideOffset={4}
                    align="end"
                    collisionPadding={8}
                  >
                    <Menu.Popup
                      render={<MenuSurface className="agent-actions-menu" />}
                    >
                      <Menu.Item
                        nativeButton
                        render={<MenuItem leading={<Pencil />} />}
                        onClick={() =>
                          onRename(board, menuTriggers.current.get(board.id))
                        }
                      >
                        {t("design.rename")}
                      </Menu.Item>
                      <Menu.Item
                        nativeButton
                        render={<MenuItem danger leading={<Trash2 />} />}
                        onClick={() =>
                          onDelete(board, menuTriggers.current.get(board.id))
                        }
                      >
                        {t("design.delete")}
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </div>
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
