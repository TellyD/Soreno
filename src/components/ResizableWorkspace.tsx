import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n";
import "./ResizableWorkspace.css";

const layoutStorageKey = "soreno:layout-widths";
const defaultLayoutWidths = {
  browser: 310,
  git: 520,
  sidebar: 280,
};
const layoutLimits = {
  browser: { max: 520, min: 240 },
  git: { min: 340 },
  sidebar: { max: 420, min: 220 },
};
const minimumEditorWidth = 220;
const resizeDirections: Record<ResizablePane, 1 | -1> = {
  browser: 1,
  git: -1,
  sidebar: 1,
};
type ResizablePane = keyof typeof defaultLayoutWidths;
type LayoutWidths = Record<ResizablePane, number>;
type ResizableWorkspaceProps = {
  browser: ReactNode;
  browserVisible?: boolean;
  editor?: ReactNode;
  editorVisible?: boolean;
  layoutResetRequest?: number;
  rightPanel?: ReactNode;
  rightPanelExpanded?: boolean;
  rightPanelId: string;
  rightPanelResizeLabel: string;
  rightPanelVisible?: boolean;
  sidebar: ReactNode;
  sidebarVisible?: boolean;
};

function clampWidth(pane: ResizablePane, width: number) {
  const limits: { min: number; max?: number } = layoutLimits[pane];
  return Math.min(
    limits.max ?? Infinity,
    Math.max(limits.min, Math.round(width)),
  );
}

function readSavedLayoutWidths(): LayoutWidths {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(layoutStorageKey) ?? "null",
    );
    const widths = { ...defaultLayoutWidths };
    for (const pane of Object.keys(widths) as ResizablePane[]) {
      if (typeof saved?.[pane] === "number" && Number.isFinite(saved[pane])) {
        widths[pane] = clampWidth(pane, saved[pane]);
      }
    }
    return widths;
  } catch {
    return defaultLayoutWidths;
  }
}

export function ResizableWorkspace({
  browser,
  browserVisible = Boolean(browser),
  editor,
  editorVisible = Boolean(editor),
  layoutResetRequest = 0,
  rightPanel,
  rightPanelExpanded = false,
  rightPanelId,
  rightPanelResizeLabel,
  rightPanelVisible = true,
  sidebar,
  sidebarVisible = true,
}: ResizableWorkspaceProps) {
  const { t } = useI18n();
  const hasBrowser = Boolean(browser) && browserVisible;
  const hasEditor = Boolean(editor) && editorVisible;
  const hasRightPanel = hasEditor && Boolean(rightPanel) && rightPanelVisible;
  const isRightPanelExpanded = hasRightPanel && rightPanelExpanded;
  const [layoutWidths, setLayoutWidths] = useState(readSavedLayoutWidths);
  const [availableWidth, setAvailableWidth] = useState(() => window.innerWidth);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);
  const previousRightPanelExpanded = useRef(false);

  function rightPanelMaxWidth(widths = layoutWidths) {
    return Math.max(
      0,
      availableWidth -
        (sidebarVisible ? widths.sidebar : 0) -
        (hasBrowser ? widths.browser : 0) -
        minimumEditorWidth -
        (hasBrowser ? 1 : 0) -
        (sidebarVisible ? 2 : 1),
    );
  }

  function effectiveRightPanelWidth(width: number, widths = layoutWidths) {
    return Math.min(clampWidth("git", width), rightPanelMaxWidth(widths));
  }

  const rightPanelWidth = effectiveRightPanelWidth(layoutWidths.git);
  const lastRightPanelWidth = useRef(rightPanelWidth);
  useLayoutEffect(() => {
    if (hasRightPanel) lastRightPanelWidth.current = rightPanelWidth;
  }, [hasRightPanel, rightPanelWidth]);

  useLayoutEffect(() => {
    const enteringExpandedPanel =
      isRightPanelExpanded && !previousRightPanelExpanded.current;
    previousRightPanelExpanded.current = isRightPanelExpanded;
    const activeElement = document.activeElement;
    if (
      enteringExpandedPanel &&
      (editorRef.current?.contains(activeElement) ||
        browserRef.current?.contains(activeElement))
    ) {
      const panel = rightPanelRef.current;
      (
        panel?.querySelector<HTMLElement>("[data-git-expand]") ??
        panel?.querySelector<HTMLElement>("button")
      )?.focus();
    }
  }, [isRightPanelExpanded]);

  useLayoutEffect(() => {
    for (const [ref, visible, id] of [
      [
        browserRef,
        hasBrowser && !isRightPanelExpanded,
        "workspace-note-browser",
      ],
      [rightPanelRef, hasRightPanel, rightPanelId],
    ] as const) {
      if (
        !visible &&
        ref.current?.contains(document.activeElement) &&
        hasEditor
      ) {
        editorRef.current
          ?.querySelector<HTMLElement>(`[aria-controls="${id}"]`)
          ?.focus();
      }
    }
  }, [
    hasBrowser,
    hasRightPanel,
    hasEditor,
    isRightPanelExpanded,
    rightPanelId,
  ]);

  // The workspace can sit beside fixed chrome, so measure from its own left edge.
  function measureAvailableWidth() {
    setAvailableWidth(
      window.innerWidth -
        (workspaceRef.current?.getBoundingClientRect().left ?? 0),
    );
  }

  useLayoutEffect(measureAvailableWidth, []);

  useEffect(() => {
    if (layoutResetRequest > 0) {
      setLayoutWidths(defaultLayoutWidths);
      measureAvailableWidth();
    }
  }, [layoutResetRequest]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        layoutStorageKey,
        JSON.stringify(layoutWidths),
      );
    } catch {
      // Layout persistence is a convenience; the app should still run without it.
    }
  }, [layoutWidths]);

  useEffect(() => {
    window.addEventListener("resize", measureAvailableWidth);
    return () => {
      window.removeEventListener("resize", measureAvailableWidth);
      stopResizeRef.current?.();
    };
  }, []);

  const workspaceStyle = {
    "--right-panel-width": `${hasRightPanel ? rightPanelWidth : lastRightPanelWidth.current}px`,
    "--browser-width": `${layoutWidths.browser}px`,
    "--sidebar-width": `${layoutWidths.sidebar}px`,
  } as CSSProperties;

  function updatePaneWidth(pane: ResizablePane, width: number) {
    setLayoutWidths((current) => ({
      ...current,
      [pane]:
        pane === "git"
          ? effectiveRightPanelWidth(width, current)
          : clampWidth(pane, width),
    }));
  }

  function handleResizeStart(
    pane: ResizablePane,
    event: PointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    stopResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = pane === "git" ? rightPanelWidth : layoutWidths[pane];
    document.body.classList.add("is-resizing-workspace");

    function handlePointerMove(moveEvent: globalThis.PointerEvent) {
      updatePaneWidth(
        pane,
        startWidth + (moveEvent.clientX - startX) * resizeDirections[pane],
      );
    }
    function stopResize() {
      document.body.classList.remove("is-resizing-workspace");
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", stopResize);
      document.removeEventListener("pointercancel", stopResize);
      stopResizeRef.current = null;
    }
    stopResizeRef.current = stopResize;
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", stopResize, { once: true });
    document.addEventListener("pointercancel", stopResize, { once: true });
  }

  function handleResizeKeyDown(
    pane: ResizablePane,
    event: KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    updatePaneWidth(
      pane,
      (pane === "git" ? rightPanelWidth : layoutWidths[pane]) +
        (event.key === "ArrowRight" ? 12 : -12) * resizeDirections[pane],
    );
  }

  return (
    <div
      ref={workspaceRef}
      className={[
        "workspace",
        sidebarVisible ? null : "sidebar-hidden",
        hasBrowser ? null : "browser-hidden",
        hasEditor ? null : "editor-hidden",
        hasRightPanel ? "right-panel-visible" : null,
        isRightPanelExpanded ? "right-panel-expanded" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      style={workspaceStyle}
    >
      {sidebar}
      <WorkspaceResizer
        label={t("workspace.resizeNavigation")}
        pane="sidebar"
        width={layoutWidths.sidebar}
        visible={sidebarVisible}
        onKeyDown={handleResizeKeyDown}
        onResizeStart={handleResizeStart}
      />
      <div
        id="workspace-note-browser"
        ref={browserRef}
        className="workspace-browser workspace-pane"
        data-hidden={!hasBrowser || isRightPanelExpanded || undefined}
        inert={!hasBrowser || isRightPanelExpanded}
        aria-hidden={!hasBrowser || isRightPanelExpanded}
      >
        {browser}
      </div>
      <WorkspaceResizer
        label={t("workspace.resizePanels")}
        pane="browser"
        width={layoutWidths.browser}
        visible={hasBrowser && hasEditor && !isRightPanelExpanded}
        onKeyDown={handleResizeKeyDown}
        onResizeStart={handleResizeStart}
      />
      <div
        ref={editorRef}
        className="workspace-editor workspace-pane"
        data-hidden={!hasEditor || isRightPanelExpanded || undefined}
        inert={!hasEditor || isRightPanelExpanded}
        aria-hidden={!hasEditor || isRightPanelExpanded}
      >
        {editor}
      </div>
      <WorkspaceResizer
        label={rightPanelResizeLabel}
        pane="git"
        width={rightPanelWidth}
        max={rightPanelMaxWidth()}
        visible={hasRightPanel && !isRightPanelExpanded}
        onKeyDown={handleResizeKeyDown}
        onResizeStart={handleResizeStart}
      />
      <div
        id={rightPanelId}
        ref={rightPanelRef}
        className="workspace-right-panel workspace-pane"
        data-hidden={!hasRightPanel || undefined}
        inert={!hasRightPanel}
        aria-hidden={!hasRightPanel}
      >
        {rightPanel}
      </div>
    </div>
  );
}

function WorkspaceResizer({
  label,
  max,
  onKeyDown,
  onResizeStart,
  pane,
  width,
  visible = true,
}: {
  label: string;
  max?: number;
  onKeyDown: (
    pane: ResizablePane,
    event: KeyboardEvent<HTMLDivElement>,
  ) => void;
  onResizeStart: (
    pane: ResizablePane,
    event: PointerEvent<HTMLDivElement>,
  ) => void;
  pane: ResizablePane;
  width: number;
  visible?: boolean;
}) {
  return (
    <div
      className="workspace-resizer"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={max ?? (layoutLimits[pane] as { max?: number }).max}
      aria-valuemin={Math.min(layoutLimits[pane].min, width)}
      aria-valuenow={width}
      aria-hidden={!visible}
      data-hidden={!visible || undefined}
      inert={!visible}
      tabIndex={visible ? 0 : -1}
      onKeyDown={(event) => onKeyDown(pane, event)}
      onPointerDown={(event) => onResizeStart(pane, event)}
    />
  );
}
