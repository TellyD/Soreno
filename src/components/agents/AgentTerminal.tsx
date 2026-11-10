import { ContextMenu } from "@base-ui/react/context-menu";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FileUp } from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  resizeAgentTerminal,
  sendAgentGridDiagnostic,
  subscribeAgentGrid,
  uploadAgentClipboardImage,
  writeAgentTerminal,
  type AgentGridSubscription,
} from "../../data/agentSessionsApi";
import {
  readTerminalClipboard,
  terminalClipboardImage,
  writeClipboardText,
  type TerminalClipboard,
} from "../../data/clipboard";
import type {
  AgentGridConfig,
  AgentGridScroll,
  AgentGridSelect,
  AgentSessionStatus,
} from "../../domain/agentSessions";
import {
  dismissNotification,
  notifyError,
  useNotification,
} from "../../notifications";
import { useAgentFileDrop } from "../../hooks/useAgentFileDrop";
import { useAppSettings } from "../../settings";
import { useTheme } from "../../theme/ThemeProvider";
import { MenuItem, MenuSurface } from "../ui/Menu";
import {
  encodeGridKey,
  encodeGridMouse,
  encodeGridPaste,
  GRID_MOUSE_MODES,
  GridMode,
  type GridMouseEvent,
} from "./agentGridKeys";
import {
  AgentGridAnnouncer,
  AgentGridRenderer,
  type AgentGridCalibration,
} from "./agentGridRenderer";
import { agentGridConfigPalette, agentGridPalette } from "./agentGridPalette";
import { AgentGridScrollbar, GRID_SCROLLBAR_WIDTH } from "./agentGridScrollbar";
import { takeMainThreadStats } from "./agentTerminalPerf";
import { agentTerminalThemes } from "./agentTerminalThemes";
import { useAgentStrings, type AgentStrings } from "./agentStrings";
import { isContextMenuKey } from "./contextMenuKeyboard";
import "./AgentTerminal.css";

const NOTICE_FOCUS_TARGET =
  'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

type TerminalFailure = "write" | "resize" | "clipboard" | "attachment" | "link";

const failureMessages = {
  write: "terminalWriteError",
  resize: "terminalResizeError",
  clipboard: "clipboardError",
  attachment: "terminalAttachmentError",
  link: "urlOpenError",
} as const satisfies Record<TerminalFailure, keyof AgentStrings>;

const platform = import.meta.env.TAURI_ENV_PLATFORM ?? "";
const PROBE_TEXT = "W".repeat(32);
// Repeats a drag held past an edge, which scrolls by its distance each time.
const SELECTION_SCROLL_MS = 50;

type GridView = {
  cols: number;
  rows: number;
  modes: number;
  displayOffset: number;
  selected: boolean;
  state: AgentSessionStatus["state"];
};

export type AgentTerminalProps = {
  sessionId: string;
  name: string;
  visible: boolean;
  state: AgentSessionStatus["state"];
  runRevision: number;
  /** Null while another pane of the same split holds the focus target. */
  focusRequest: number | null;
  imagePasteSequence?: string;
  remote?: boolean;
  onTitleChange?: (sessionId: string, title: string) => void;
  onFocus?: (sessionId: string) => void;
  /** Covers the terminal output, e.g. when its executable is missing. */
  notice?: ReactNode;
};

export const AgentTerminal = memo(function AgentTerminal({
  sessionId,
  name,
  visible,
  state,
  runRevision,
  focusRequest,
  imagePasteSequence = "\x16",
  remote = false,
  onTitleChange,
  onFocus,
  notice,
}: AgentTerminalProps) {
  const s = useAgentStrings();
  const stringsRef = useRef(s);
  stringsRef.current = s;
  const { terminalTheme } = useTheme();
  const terminalThemeRef = useRef(terminalTheme);
  terminalThemeRef.current = terminalTheme;
  const { terminalLogEnabled } = useAppSettings().settings;
  const terminalLogRef = useRef(terminalLogEnabled);
  terminalLogRef.current = terminalLogEnabled;
  const running = state === "running";
  const titleChangeRef = useRef(onTitleChange);
  titleChangeRef.current = onTitleChange;
  const section = useRef<HTMLElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const hasNotice = Boolean(notice);
  const probe = useRef<HTMLSpanElement>(null);
  const rendererRef = useRef<AgentGridRenderer | null>(null);
  const liveRegion = useRef<HTMLDivElement>(null);
  const announcerRef = useRef<AgentGridAnnouncer | null>(null);
  // A configure repaints the whole screen once; not new output to announce.
  const configured = useRef(false);
  const scrollbarRef = useRef<AgentGridScrollbar | null>(null);
  const subscriptionRef = useRef<AgentGridSubscription | null>(null);
  // Select requests sent to the current subscription, and those still queued.
  const selects = useRef({ sent: 0, queued: 0 });
  const view = useRef<GridView>({
    cols: 0,
    rows: 0,
    modes: 0,
    displayOffset: 0,
    selected: false,
    state,
  });
  // CSS pixels, snapped to device pixels.
  const cell = useRef({ width: 8, height: 17, advance: 8 });
  const sentConfig = useRef("");
  const sentVisible = useRef(visible);
  const resizeState = useRef({ lastSize: "", queue: Promise.resolve() });
  const visibleRef = useRef(visible);
  const runningRef = useRef(running);
  const stateRef = useRef(state);
  visibleRef.current = visible;
  runningRef.current = running;
  stateRef.current = state;
  const retryRef = useRef<() => void>(() => {});
  const wakeRef = useRef<() => void>(() => {});
  const clipboardRevision = useRef(0);
  const pasteTextRef = useRef<(text: string) => void>(() => {});
  const clipboardActionRef = useRef<(action: "copy" | "paste") => void>(
    () => {},
  );
  const selectAllRef = useRef<() => void>(() => {});
  const [readFailed, setReadFailed] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLDivElement>(null);
  const menuRestoreFocus = useRef(false);
  // Keyboard-opened menus ignore the app's mouse reporting.
  const keyboardMenu = useRef(false);

  const failureKey = (failure: TerminalFailure) =>
    `agent-terminal-${failure}:${sessionId}`;
  function fail(failure: TerminalFailure, message?: string) {
    notifyError(message ?? stringsRef.current[failureMessages[failure]], {
      key: failureKey(failure),
    });
  }
  function recover(failure: TerminalFailure) {
    dismissNotification(failureKey(failure));
  }

  useNotification(
    readFailed && visible
      ? {
          message: s.terminalError,
          key: `agent-terminal-read:${sessionId}`,
          action: { label: s.retry, onAction: () => retryRef.current() },
        }
      : null,
  );

  function canInteract() {
    return visibleRef.current && !document.querySelector('[aria-modal="true"]');
  }

  function canInput() {
    return canInteract() && runningRef.current;
  }

  function reportsMouse(event: { shiftKey: boolean }) {
    return (
      (view.current.modes & GRID_MOUSE_MODES) !== 0 &&
      !event.shiftKey &&
      canInput()
    );
  }

  function focusTerminal() {
    if (canInteract()) input.current?.focus({ preventScroll: true });
  }

  const fileDrop = useAgentFileDrop({
    sessionId,
    canAttach: () => isTauri() && canInteract() && runningRef.current,
    paste: (paths) => pasteTextRef.current(`${paths.join(" ")} `),
    focus: () => input.current?.focus(),
    onError: (error) =>
      fail(
        "attachment",
        error === "count"
          ? stringsRef.current.terminalAttachmentCountError
          : error === "tooLarge"
            ? stringsRef.current.terminalAttachmentTooLarge
            : undefined,
      ),
    onSuccess: () => recover("attachment"),
  });

  function gridConfig(): AgentGridConfig {
    const ratio = window.devicePixelRatio || 1;
    return {
      cellWidth: Math.max(1, Math.round(cell.current.width * ratio)),
      cellHeight: Math.max(1, Math.round(cell.current.height * ratio)),
      palette: agentGridConfigPalette(
        agentGridPalette(agentTerminalThemes[terminalThemeRef.current]),
      ),
    };
  }

  function syncConfig() {
    const subscription = subscriptionRef.current;
    if (!subscription) return;
    const config = gridConfig();
    const key = JSON.stringify(config);
    if (key === sentConfig.current) return;
    sentConfig.current = key;
    configured.current = true;
    void subscription.configure(config).catch(() => {});
  }

  // Returns whether the cell size changed.
  function measureCell() {
    const bounds = probe.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return false;
    const advance = bounds.width / PROBE_TEXT.length;
    const ratio = window.devicePixelRatio || 1;
    // Device-pixel cells, glyph advances stretched to them by letter spacing.
    const width = Math.max(1, Math.floor(advance * ratio)) / ratio;
    const height = Math.max(1, Math.ceil(bounds.height * ratio)) / ratio;
    const previous = cell.current;
    if (
      width === previous.width &&
      height === previous.height &&
      advance === previous.advance
    )
      return false;
    cell.current = { width, height, advance };
    rendererRef.current?.setCellSize(width, height, width - advance);
    return true;
  }

  function reportCalibration(outcome: AgentGridCalibration) {
    if (!terminalLogRef.current) return;
    const { width, height, advance } = cell.current;
    const row = rendererRef.current?.element.querySelector(".agent-grid-row");
    void sendAgentGridDiagnostic(
      sessionId,
      [
        `dpr=${window.devicePixelRatio}`,
        `advance=${advance.toFixed(4)}`,
        `cell=${width.toFixed(4)}x${height.toFixed(4)}`,
        `spacing=${outcome.letterSpacing.toFixed(4)}`,
        `drifts=${outcome.drifts.join(",")}`,
        `per_cell=${outcome.perCell}`,
        `font=${row ? getComputedStyle(row).fontFamily : "?"}`,
        `view=${view.current.cols}x${view.current.rows}`,
      ].join(" "),
    ).catch(() => {});
  }

  // Invalidate before async completions can run after a visibility/process commit.
  useLayoutEffect(() => {
    clipboardRevision.current++;
    fileDrop.invalidate();
    if (!visible) setMenuOpen(false);
    return () => {
      fileDrop.invalidate();
    };
  }, [sessionId, runRevision, visible, running]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    const palette = agentGridPalette(
      agentTerminalThemes[terminalThemeRef.current],
    );
    const renderer = new AgentGridRenderer(host, palette, {
      caret: input.current ?? undefined,
      openLink: (url) => {
        recover("link");
        void openUrl(url).catch(() => {
          if (!disposed) fail("link");
        });
      },
    });
    renderer.setCellSize(
      cell.current.width,
      cell.current.height,
      cell.current.width - cell.current.advance,
    );
    renderer.setFocused(document.activeElement === input.current);
    rendererRef.current = renderer;
    const region = liveRegion.current;
    const announcer = region
      ? new AgentGridAnnouncer(
          region,
          () => document.activeElement === input.current,
        )
      : null;
    announcerRef.current = announcer;
    const scrollbar = new AgentGridScrollbar(host, {
      scroll: (request) =>
        subscriptionRef.current?.scroll(request) ?? Promise.resolve(),
      focus: () => {
        if (canInteract()) input.current?.focus({ preventScroll: true });
      },
    });
    scrollbar.setForeground(palette.foreground);
    scrollbar.setTrackHeight(host.clientHeight);
    scrollbarRef.current = scrollbar;
    return () => {
      disposed = true;
      renderer.dispose();
      rendererRef.current = null;
      announcer?.dispose();
      announcerRef.current = null;
      scrollbar.dispose();
      scrollbarRef.current = null;
    };
  }, [sessionId, runRevision]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    let disposed = false;
    let revision = 0;
    let streamFailed = false;
    let subscription: AgentGridSubscription | null = null;
    view.current = {
      cols: 0,
      rows: 0,
      modes: 0,
      displayOffset: 0,
      selected: false,
      state: stateRef.current,
    };
    recover("write");
    recover("resize");
    recover("clipboard");
    recover("link");
    const storeClipboard = (text: string) => {
      if (!canInteract()) return;
      const clipboard = ++clipboardRevision.current;
      const isCurrent = () =>
        !disposed && clipboard === clipboardRevision.current && canInteract();
      void writeClipboardText(text)
        .then(() => {
          if (isCurrent()) recover("clipboard");
        })
        .catch(() => {
          if (isCurrent()) fail("clipboard");
        });
    };
    const connect = () => {
      const current = ++revision;
      subscription?.unsubscribe();
      streamFailed = false;
      setReadFailed(false);
      measureCell();
      announcerRef.current?.reset();
      const config = gridConfig();
      sentConfig.current = JSON.stringify(config);
      sentVisible.current = visibleRef.current;
      selects.current.sent = 0;
      subscription = subscribeAgentGrid(
        sessionId,
        config,
        sentVisible.current,
        async (frame) => {
          if (disposed || current !== revision) return 0;
          const reconfigured = frame.full && configured.current;
          if (frame.full) configured.current = false;
          const applyMs = await renderer.render(frame);
          if (disposed || current !== revision) return applyMs;
          announcerRef.current?.frame(frame, reconfigured);
          scrollbarRef.current?.update(frame);
          // The frame answers every request sent so far; otherwise keep the value set on request.
          const selected =
            selects.current.queued === 0 &&
            frame.selectCount === selects.current.sent
              ? frame.selection !== null
              : view.current.selected;
          view.current = {
            cols: frame.cols,
            rows: frame.rows,
            modes: frame.modes,
            displayOffset: frame.displayOffset,
            selected,
            state: frame.state,
          };
          setHasSelection(selected);
          // Hidden rows have no layout to measure.
          const calibration = visibleRef.current ? renderer.calibrate() : null;
          if (calibration) reportCalibration(calibration);
          if (frame.title !== null)
            titleChangeRef.current?.(sessionId, frame.title);
          if (frame.clipboard !== null) storeClipboard(frame.clipboard);
          return applyMs;
        },
        () => {
          if (disposed || current !== revision) return;
          streamFailed = true;
          setReadFailed(true);
        },
      );
      subscriptionRef.current = subscription;
      // A theme or font change may have landed while unsubscribed.
      syncConfig();
    };
    wakeRef.current = () => {
      if (streamFailed || view.current.state === "idle") connect();
    };
    retryRef.current = connect;
    connect();
    return () => {
      disposed = true;
      subscription?.unsubscribe();
      subscriptionRef.current = null;
      wakeRef.current = () => {};
      retryRef.current = () => {};
    };
  }, [sessionId, runRevision]);

  // Hidden terminals stay subscribed: the backend keeps parsing and answering queries.
  useEffect(() => {
    const subscription = subscriptionRef.current;
    if (!subscription || sentVisible.current === visible) return;
    sentVisible.current = visible;
    // The full repaint on show is not new output to announce.
    if (visible) configured.current = true;
    void subscription.setVisible(visible).catch(() => {});
  }, [visible]);

  // One journal line per active second: the webview's own cost, which the backend cannot see.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!terminalLogEnabled || !visible || !renderer) return;
    renderer.takePaintStats();
    takeMainThreadStats();
    const timer = window.setInterval(() => {
      const paint = renderer.takePaintStats();
      const { longTasks, heapMb } = takeMainThreadStats();
      if (paint.frames === 0 && !longTasks?.count) return;
      const ms = (value: number) => value.toFixed(1);
      void sendAgentGridDiagnostic(
        sessionId,
        [
          "perf",
          `frames=${paint.frames}`,
          `paint_ms_avg=${ms(paint.paintMsAvg)}`,
          `paint_ms_max=${ms(paint.paintMsMax)}`,
          `boxes=${paint.boxes}`,
          longTasks
            ? `long_tasks=${longTasks.count} long_task_ms=${ms(longTasks.total)} long_task_max_ms=${ms(longTasks.max)}`
            : "long_tasks=na",
          `heap_mb=${heapMb === null ? "na" : heapMb.toFixed(0)}`,
        ].join(" "),
      ).catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [terminalLogEnabled, visible, sessionId, runRevision]);

  useEffect(() => {
    const host = container.current;
    const textarea = input.current;
    const renderer = rendererRef.current;
    if (!host || !textarea || !renderer) return;
    let disposed = false;
    let inputQueue = Promise.resolve();
    const screen = renderer.element;
    const canCopy = () => view.current.selected;
    // Requests reach the engine in order; consecutive pending extends coalesce into one.
    let selectQueue = Promise.resolve();
    let openExtend: { request: AgentGridSelect } | null = null;
    const select = (request: AgentGridSelect) => {
      view.current.selected =
        request.kind === "all" ||
        request.kind === "extend" ||
        (request.kind === "start" && request.mode !== "simple");
      setHasSelection(view.current.selected);
      if (request.kind === "extend" && openExtend) {
        openExtend.request = request;
        return;
      }
      const slot = { request };
      openExtend = request.kind === "extend" ? slot : null;
      selects.current.queued++;
      selectQueue = selectQueue
        .then(() => {
          selects.current.queued--;
          if (openExtend === slot) openExtend = null;
          const subscription = subscriptionRef.current;
          if (disposed || !subscription) return;
          selects.current.sent = (selects.current.sent + 1) >>> 0;
          return subscription.select(slot.request);
        })
        .catch(() => {});
    };
    selectAllRef.current = () => select({ kind: "all" });

    const write = (data: string) => {
      inputQueue = inputQueue
        .then(async () => {
          if (disposed || !runningRef.current) return;
          await writeAgentTerminal(sessionId, data);
          if (!disposed) recover("write");
        })
        .catch(() => {
          if (!disposed) fail("write");
        });
    };

    let scrollLines = 0;
    let scrolling = false;
    const scroll = (request: AgentGridScroll) => {
      void subscriptionRef.current?.scroll(request).catch(() => {});
    };
    // Coalesces wheel deltas while an IPC scroll is in flight.
    const scrollBy = (lines: number) => {
      scrollLines += lines;
      if (scrolling) return;
      scrolling = true;
      void (async () => {
        while (scrollLines && !disposed) {
          const request = scrollLines;
          scrollLines = 0;
          await subscriptionRef.current
            ?.scroll({ kind: "delta", lines: request })
            .catch(() => {});
        }
        scrolling = false;
      })();
    };

    // User input always returns the viewport to the live screen first.
    // Motion reports keep the selection: hovering after a Shift-drag is not input from the user.
    const sendInput = (data: string, clearSelection = true) => {
      if (!canInput() || !data) return;
      if (clearSelection && view.current.selected) select({ kind: "clear" });
      if (view.current.displayOffset > 0) {
        view.current.displayOffset = 0;
        scrollLines = 0;
        scroll({ kind: "bottom" });
      }
      write(data);
    };

    const pasteText = (text: string) =>
      sendInput(encodeGridPaste(text, view.current.modes));
    pasteTextRef.current = pasteText;

    const pasteClipboard = async (
      clipboard: TerminalClipboard,
      isCurrent: () => boolean,
    ) => {
      if (!isCurrent() || !canInput()) return;
      if (clipboard.type === "image" && remote) {
        if (!clipboard.mimeType || !clipboard.dataBase64)
          throw new Error("Clipboard image unavailable");
        const path = await uploadAgentClipboardImage(
          sessionId,
          clipboard.mimeType,
          clipboard.dataBase64,
        );
        if (!isCurrent() || !runningRef.current) return;
        pasteText(path);
      } else if (clipboard.type === "image") {
        sendInput(imagePasteSequence);
      } else {
        pasteText(clipboard.text);
      }
      recover("clipboard");
    };

    const clipboardAction = (action: "copy" | "paste") => {
      const subscription = subscriptionRef.current;
      if (
        !canInteract() ||
        (action === "paste" ? !runningRef.current : !canCopy() || !subscription)
      )
        return;
      const revision = ++clipboardRevision.current;
      const isCurrent = () =>
        !disposed && revision === clipboardRevision.current && canInteract();
      void (async () => {
        try {
          if (action === "copy") {
            await selectQueue;
            const value = await subscription?.text();
            if (value) await writeClipboardText(value);
            if (isCurrent()) recover("clipboard");
          } else {
            await pasteClipboard(
              await readTerminalClipboard(remote),
              isCurrent,
            );
            if (isCurrent()) textarea.focus();
          }
        } catch {
          if (isCurrent()) fail("clipboard");
        }
      })();
    };
    clipboardActionRef.current = clipboardAction;

    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      announcerRef.current?.clear();
      if (
        event.key === "Insert" &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        canCopy()
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) clipboardAction("copy");
        return;
      }
      const key = event.key.toLowerCase();
      const shortcut =
        !event.altKey &&
        ((event.ctrlKey &&
          !event.metaKey &&
          (event.shiftKey || key === "v" || (key === "c" && canCopy()))) ||
          (event.metaKey && !event.ctrlKey && !event.shiftKey));
      if (shortcut && (key === "c" || key === "v")) {
        // Keep unselected Ctrl+C as SIGINT; Ctrl+V preserves dictated text while images use the configured CLI shortcut.
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) clipboardAction(key === "c" ? "copy" : "paste");
        return;
      }
      if (shortcut && key === "a") {
        event.preventDefault();
        event.stopPropagation();
        selectAllRef.current();
        return;
      }
      if (!canInteract()) return;
      const modes = view.current.modes;
      if (
        (event.key === "PageUp" || event.key === "PageDown") &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !(modes & GridMode.altScreen)
      ) {
        event.preventDefault();
        event.stopPropagation();
        scroll({ kind: event.key === "PageUp" ? "pageUp" : "pageDown" });
        return;
      }
      if (!canInput()) return;
      const data = encodeGridKey(event, modes, platform);
      if (data === null) {
        // Focus moved during keydown still receives this key's text.
        if (event.target !== textarea && !event.ctrlKey && !event.metaKey)
          textarea.focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      sendInput(data);
    };

    // Whichever of input/compositionend comes last finds the textarea already drained.
    const flushText = () => {
      const text = textarea.value;
      textarea.value = "";
      sendInput(text);
    };
    const textInput = (event: Event) => {
      if (event instanceof InputEvent && event.isComposing) return;
      flushText();
    };

    const focusReport = (focused: boolean) => {
      renderer.setFocused(focused);
      if (view.current.modes & GridMode.focusInOut && canInput())
        write(focused ? "\x1b[I" : "\x1b[O");
    };
    const focus = () => focusReport(true);
    const blur = () => focusReport(false);

    // Own native paste: no second IPC read or duplicate input.
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const revision = ++clipboardRevision.current;
      const data = event.clipboardData;
      if (!canInput() || !data) return;
      const isCurrent = () =>
        !disposed && revision === clipboardRevision.current && canInteract();
      const image =
        Array.from(data.files ?? []).find((file) =>
          file.type.startsWith("image/"),
        ) ??
        Array.from(data.items ?? [])
          .find((item) => item.type.startsWith("image/"))
          ?.getAsFile();
      if (!image && !Array.from(data.types ?? []).includes("text/plain"))
        return;
      const clipboard =
        image && remote
          ? terminalClipboardImage(image)
          : Promise.resolve<TerminalClipboard>(
              image
                ? { type: "image" }
                : { type: "text", text: data.getData("text/plain") },
            );
      void clipboard
        .then((value) => pasteClipboard(value, isCurrent))
        .catch(() => {
          if (isCurrent()) fail("clipboard");
        });
    };

    const cellAt = (event: MouseEvent) => {
      const bounds = screen.getBoundingClientRect();
      const { cols, rows } = view.current;
      return {
        col: Math.min(
          Math.max(0, cols - 1),
          Math.max(
            0,
            Math.floor((event.clientX - bounds.left) / cell.current.width),
          ),
        ),
        row: Math.min(
          Math.max(0, rows - 1),
          Math.max(
            0,
            Math.floor((event.clientY - bounds.top) / cell.current.height),
          ),
        ),
      };
    };
    const mouseReport = (
      event: MouseEvent,
      button: number | null,
      action: GridMouseEvent["action"],
    ) =>
      encodeGridMouse(
        {
          button,
          action,
          ...cellAt(event),
          shift: event.shiftKey,
          alt: event.altKey,
          ctrl: event.ctrlKey,
        },
        view.current.modes,
      );

    let held: number | null = null;
    let lastCell = "";
    const dragMove = (event: MouseEvent) => {
      const at = cellAt(event);
      const key = `${at.col}:${at.row}`;
      if (key === lastCell) return;
      lastCell = key;
      const data = mouseReport(event, held, "move");
      if (data) sendInput(data, false);
    };
    const dragEnd = (event: MouseEvent) => {
      if (held === null || event.button !== held) return;
      const data = mouseReport(event, held, "release");
      held = null;
      document.removeEventListener("mousemove", dragMove, true);
      document.removeEventListener("mouseup", dragEnd, true);
      if (data) sendInput(data);
    };
    const mousedown = (event: MouseEvent) => {
      if (event.button > 2 || held !== null || !reportsMouse(event)) return;
      event.preventDefault();
      textarea.focus({ preventScroll: true });
      held = event.button;
      const at = cellAt(event);
      lastCell = `${at.col}:${at.row}`;
      document.addEventListener("mousemove", dragMove, true);
      document.addEventListener("mouseup", dragEnd, true);
      const data = mouseReport(event, held, "press");
      if (data) sendInput(data);
    };
    const hover = (event: MouseEvent) => {
      if (held !== null || !(view.current.modes & GridMode.mouseMotion)) return;
      if (!reportsMouse(event)) return;
      dragMove(event);
    };
    const mouseup = () => {
      if (held === null && canInteract())
        textarea.focus({ preventScroll: true });
    };

    const selectionPoint = (event: MouseEvent) => {
      const bounds = screen.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / cell.current.width;
      const col = Math.min(
        Math.max(0, view.current.cols - 1),
        Math.max(0, Math.floor(x)),
      );
      return {
        // Unclamped: a row past an edge scrolls toward the pointer.
        row: Math.floor((event.clientY - bounds.top) / cell.current.height),
        col,
        right: x >= col + 0.5,
      };
    };
    let dragged: MouseEvent | null = null;
    let draggedPoint = "";
    let edgeScroll = 0;
    const extendSelection = (event: MouseEvent, repeat: boolean) => {
      const point = selectionPoint(event);
      const key = `${point.row}:${point.col}:${point.right}`;
      if (repeat || key !== draggedPoint) select({ kind: "extend", ...point });
      draggedPoint = key;
      return point.row < 0 || point.row >= view.current.rows;
    };
    const stopSelecting = () => {
      dragged = null;
      clearInterval(edgeScroll);
      edgeScroll = 0;
      document.removeEventListener("mousemove", selectMove, true);
      document.removeEventListener("mouseup", selectEnd, true);
    };
    const selectMove = (event: MouseEvent) => {
      dragged = event;
      const outside = extendSelection(event, false);
      if (outside && !edgeScroll)
        edgeScroll = window.setInterval(() => {
          if (dragged) extendSelection(dragged, true);
        }, SELECTION_SCROLL_MS);
      else if (!outside && edgeScroll) {
        clearInterval(edgeScroll);
        edgeScroll = 0;
      }
    };
    const selectEnd = (event: MouseEvent) => {
      if (event.button === 0) stopSelecting();
    };
    const selectStart = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        reportsMouse(event) ||
        !(event.target instanceof Node) ||
        !screen.contains(event.target) ||
        !canInteract()
      )
        return;
      event.preventDefault();
      stopSelecting();
      textarea.focus({ preventScroll: true });
      const point = selectionPoint(event);
      draggedPoint = `${point.row}:${point.col}:${point.right}`;
      if (event.shiftKey && event.detail === 1 && view.current.selected)
        select({ kind: "extend", ...point });
      else
        select({
          kind: "start",
          ...point,
          mode:
            event.detail >= 3 ? "line" : event.detail === 2 ? "word" : "simple",
        });
      document.addEventListener("mousemove", selectMove, true);
      document.addEventListener("mouseup", selectEnd, true);
    };

    let wheelLines = 0;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !canInteract()) return;
      event.preventDefault();
      const rows = Math.max(1, view.current.rows);
      wheelLines +=
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * rows
            : event.deltaY / cell.current.height;
      const lines = Math.trunc(wheelLines);
      if (!lines) return;
      wheelLines -= lines;
      const modes = view.current.modes;
      const count = Math.min(Math.abs(lines), rows);
      if (reportsMouse(event)) {
        const data = mouseReport(event, lines < 0 ? 64 : 65, "press");
        if (data) sendInput(data.repeat(count));
      } else if (
        modes & GridMode.altScreen &&
        modes & GridMode.alternateScroll
      ) {
        if (canInput()) {
          const arrow = `${modes & GridMode.appCursor ? "\x1bO" : "\x1b["}${lines < 0 ? "A" : "B"}`;
          sendInput(arrow.repeat(count));
        }
      } else {
        scrollBy(-lines);
      }
    };

    host.addEventListener("keydown", keydown);
    host.addEventListener("paste", paste, true);
    host.addEventListener("mousedown", mousedown);
    host.addEventListener("mousedown", selectStart);
    host.addEventListener("mousemove", hover);
    host.addEventListener("mouseup", mouseup);
    host.addEventListener("wheel", wheel, { passive: false });
    textarea.addEventListener("input", textInput);
    textarea.addEventListener("compositionend", flushText);
    textarea.addEventListener("focus", focus);
    textarea.addEventListener("blur", blur);
    return () => {
      disposed = true;
      pasteTextRef.current = () => {};
      clipboardActionRef.current = () => {};
      selectAllRef.current = () => {};
      host.removeEventListener("keydown", keydown);
      host.removeEventListener("paste", paste, true);
      host.removeEventListener("mousedown", mousedown);
      host.removeEventListener("mousedown", selectStart);
      host.removeEventListener("mousemove", hover);
      host.removeEventListener("mouseup", mouseup);
      host.removeEventListener("wheel", wheel);
      textarea.removeEventListener("input", textInput);
      textarea.removeEventListener("compositionend", flushText);
      textarea.removeEventListener("focus", focus);
      textarea.removeEventListener("blur", blur);
      document.removeEventListener("mousemove", dragMove, true);
      document.removeEventListener("mouseup", dragEnd, true);
      stopSelecting();
    };
  }, [sessionId, runRevision, imagePasteSequence, remote]);

  useEffect(() => {
    const palette = agentGridPalette(agentTerminalThemes[terminalTheme]);
    rendererRef.current?.setPalette(palette);
    scrollbarRef.current?.setForeground(palette.foreground);
    syncConfig();
  }, [terminalTheme]);

  useEffect(() => {
    if (state === "running" || (state === "exited" && visible))
      wakeRef.current();
  }, [state, visible]);

  useEffect(() => {
    resizeState.current = { lastSize: "", queue: Promise.resolve() };
  }, [sessionId, runRevision, running]);

  useEffect(() => {
    const host = container.current;
    if (!visible || !host) return;
    let disposed = false;
    let frame = 0;
    const resize = resizeState.current;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !host.clientWidth || !host.clientHeight) return;
        if (measureCell()) syncConfig();
        scrollbarRef.current?.setTrackHeight(host.clientHeight);
        const cols = Math.max(
          2,
          Math.floor(
            (host.clientWidth - GRID_SCROLLBAR_WIDTH) / cell.current.width,
          ),
        );
        const rows = Math.max(
          1,
          Math.floor(host.clientHeight / cell.current.height),
        );
        const size = `${cols}:${rows}`;
        if (!running) return;
        resize.queue = resize.queue
          .then(async () => {
            if (disposed) return;
            if (size !== resize.lastSize) {
              await resizeAgentTerminal(sessionId, cols, rows);
              resize.lastSize = size;
            }
            if (!disposed) recover("resize");
          })
          .catch(() => {
            if (!disposed) fail("resize");
          });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    fit();
    void document.fonts?.ready.then(() => {
      if (!disposed) fit();
    });
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [sessionId, visible, running, runRevision]);

  // Layout effect: the covered terminal becomes inert in this commit, and the
  // browser drops its focus at the next rendering update.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (
      hasNotice &&
      visible &&
      !document.querySelector('[aria-modal="true"]') &&
      section.current?.contains(active) &&
      !noticeRef.current?.contains(active)
    )
      noticeRef.current
        ?.querySelector<HTMLElement>(NOTICE_FOCUS_TARGET)
        ?.focus({ preventScroll: true });
  }, [hasNotice, visible]);

  useEffect(() => {
    if (
      focusRequest === null ||
      !visible ||
      document.querySelector('[aria-modal="true"]')
    )
      return;
    if (!hasNotice) {
      if (!section.current?.contains(document.activeElement))
        input.current?.focus({ preventScroll: true });
    } else if (!noticeRef.current?.contains(document.activeElement))
      noticeRef.current
        ?.querySelector<HTMLElement>(NOTICE_FOCUS_TARGET)
        ?.focus({ preventScroll: true });
    // A notice appearing alone must not pull focus from elsewhere in the app.
  }, [sessionId, visible, runRevision, focusRequest]);

  return (
    <section
      ref={section}
      className="agent-terminal"
      hidden={!visible}
      aria-label={`${s.terminal} · ${name}`}
      onFocus={onFocus ? () => onFocus(sessionId) : undefined}
      {...fileDrop.handlers}
    >
      {fileDrop.active ? (
        <div className="agent-terminal-file-drop" aria-hidden="true">
          <FileUp size={34} strokeWidth={1.75} />
          <span>{s.terminalDropFiles}</span>
        </div>
      ) : null}
      {notice ? (
        <div ref={noticeRef} className="agent-terminal-notice">
          {notice}
        </div>
      ) : null}
      <ContextMenu.Root
        open={menuOpen && visible}
        onOpenChange={(open, details) => {
          menuRestoreFocus.current =
            details.reason === "escape-key" || details.reason === "item-press";
          setMenuOpen(open);
        }}
      >
        <ContextMenu.Trigger
          ref={menuTrigger}
          className="agent-terminal-context"
          tabIndex={0}
          inert={hasNotice}
          aria-label={s.terminalMenu}
          onContextMenu={(event) => {
            // The app receives right clicks while it reports the mouse; Shift overrides.
            if (keyboardMenu.current || !reportsMouse(event)) return;
            event.preventDefault();
            event.preventBaseUIHandler();
          }}
          onKeyDownCapture={(event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            event.stopPropagation();
            const bounds = menuTrigger.current!.getBoundingClientRect();
            keyboardMenu.current = true;
            try {
              menuTrigger.current!.dispatchEvent(
                new MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: bounds.left + 12,
                  clientY: bounds.top + 12,
                }),
              );
            } finally {
              keyboardMenu.current = false;
            }
          }}
        >
          <div
            className="agent-terminal-host agent-grid-host"
            ref={container}
            tabIndex={-1}
          >
            <textarea
              ref={input}
              className="agent-grid-input"
              aria-label={`${s.terminal} · ${name}`}
              readOnly={!running}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <span ref={probe} className="agent-grid-probe" aria-hidden="true">
              {PROBE_TEXT}
            </span>
            <div
              className="agent-grid-live"
              ref={liveRegion}
              aria-live="polite"
            />
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner
            className="agent-terminal-menu-positioner"
            sideOffset={4}
            collisionPadding={8}
          >
            <ContextMenu.Popup
              render={<MenuSurface />}
              aria-label={s.terminalMenu}
              finalFocus={() => {
                if (menuRestoreFocus.current) focusTerminal();
                return false;
              }}
            >
              <ContextMenu.Item
                nativeButton
                render={<MenuItem />}
                disabled={!hasSelection}
                onClick={() => clipboardActionRef.current("copy")}
              >
                {s.terminalCopy}
              </ContextMenu.Item>
              <ContextMenu.Item
                nativeButton
                render={<MenuItem />}
                disabled={!running}
                onClick={() => clipboardActionRef.current("paste")}
              >
                {s.terminalPaste}
              </ContextMenu.Item>
              <ContextMenu.Item
                nativeButton
                render={<MenuItem />}
                onClick={() => selectAllRef.current()}
              >
                {s.terminalSelectAll}
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </section>
  );
});
