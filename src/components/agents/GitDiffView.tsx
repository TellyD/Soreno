import { syntaxHighlighting } from "@codemirror/language";
import {
  Change,
  diff,
  getChunks,
  getOriginalDoc,
  MergeView,
  originalDocChangeEffect,
  unifiedMergeView,
  type Chunk,
  type DiffConfig,
} from "@codemirror/merge";
import {
  ChangeSet,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  BlockType,
  Decoration,
  EditorView,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { Menu } from "@base-ui/react/menu";
import { Check, Ellipsis } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DiffLineSelection } from "../../domain/diffLineComment";
import {
  gitPathParts,
  type GitComparison,
  type GitContent,
  type GitSide,
} from "../../domain/projectGit";
import { useStoredPreference } from "../../hooks/useStoredPreference";
import { useTheme } from "../../theme/ThemeProvider";
import {
  appendLoadedLanguage,
  codeLanguage,
} from "../markdown-editor/codeLanguages";
import { markdownHighlightStyle } from "../markdown-editor/highlighting";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { useGitStrings, type GitStrings } from "./gitStrings";
import GitImageComparison from "./GitImageComparison";
import {
  diffLineCommentGutter,
  isCommentHover,
  selectedLines,
  type CommentHandler,
} from "./diffLineCommentGutter";
import "./GitDiffView.css";

const parseLayout = (stored: string | null): "unified" | "split" =>
  stored === "split" ? "split" : "unified";
const parseWrap = (stored: string | null) => stored !== "false";
const parseExpand = (stored: string | null) => stored === "true";

type GitDiffViewProps = {
  comparison: GitComparison;
  showMinimap?: boolean;
  toolbarActions?: ReactNode;
  /** Offers "Comment" on selected lines; `side` is the Git side this comparison shows. */
  lineComments?: {
    side: GitSide;
    onComment: (selection: DiffLineSelection) => void;
  };
  footer?: ReactNode;
};

// Avoid size-based false replacements; the timeout may still approximate when its budget is exhausted.
const charDiffConfig: DiffConfig = { timeout: 100 };

// Null when line ids would reach UTF-16 surrogates.
function diffLines(
  a: readonly string[],
  b: readonly string[],
): readonly Change[] | null {
  const ids = new Map<string, number>();
  const encode = (lines: readonly string[]) =>
    lines
      .map((line) => {
        let id = ids.get(line);
        if (id === undefined) ids.set(line, (id = ids.size + 1));
        return String.fromCharCode(id);
      })
      .join("");
  const encodedA = encode(a);
  const encodedB = encode(b);
  return ids.size < 0xd800 ? diff(encodedA, encodedB, charDiffConfig) : null;
}

// Like VS Code: align whole lines first so a character diff cannot pair unrelated lines.
function lineFirstDiff(a: string, b: string): readonly Change[] {
  const linesA = a.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const linesB = b.match(/[^\n]*\n|[^\n]+/g) ?? [];
  // diff restarts its timeout per call, so zones share one budget.
  const deadline = Date.now() + charDiffConfig.timeout!;
  const lineChanges = diffLines(linesA, linesB);
  if (!lineChanges) return diff(a, b, charDiffConfig);
  const changes: Change[] = [];
  let lineA = 0;
  let lineB = 0;
  let posA = 0;
  let posB = 0;
  for (const change of lineChanges) {
    for (; lineA < change.fromA; lineA += 1, lineB += 1) {
      posA += linesA[lineA].length;
      posB += linesB[lineB].length;
    }
    let endA = posA;
    let endB = posB;
    for (; lineA < change.toA; lineA += 1) endA += linesA[lineA].length;
    for (; lineB < change.toB; lineB += 1) endB += linesB[lineB].length;
    const remaining = deadline - Date.now();
    if (remaining <= 0) changes.push(new Change(posA, endA, posB, endB));
    else
      for (const inner of diff(a.slice(posA, endA), b.slice(posB, endB), {
        timeout: remaining,
      }))
        changes.push(
          new Change(
            inner.fromA + posA,
            inner.toA + posA,
            inner.fromB + posB,
            inner.toB + posB,
          ),
        );
    posA = endA;
    posB = endB;
  }
  return changes;
}

const diffConfig: DiffConfig = { override: lineFirstDiff };
const collapseConfig = { margin: 8, minSize: 16 };

type DiffMinimapMarker = {
  id: string;
  kind: "added" | "deleted";
  top: number;
  height: number;
};

function diffMinimapMarkers(
  before: EditorView | undefined,
  after: EditorView,
  chunks: readonly Chunk[],
): DiffMinimapMarker[] {
  const contentHeight = Math.max(
    1,
    before?.contentHeight ?? 0,
    after.contentHeight,
  );
  const geometry = (
    view: EditorView,
    from: number,
    to: number,
    type = BlockType.Text,
  ) => {
    const blockAt = (position: number) => {
      const block = view.lineBlockAt(Math.min(position, view.state.doc.length));
      return Array.isArray(block.type)
        ? (block.type.find((part) => part.type === type) ?? block)
        : block;
    };
    const start = blockAt(from);
    const end = blockAt(Math.max(from, to - 1));
    const top = view.documentPadding.top + start.top;
    return { top, height: view.documentPadding.top + end.bottom - top };
  };
  const markers: DiffMinimapMarker[] = [];
  chunks.forEach((chunk, index) => {
    if (chunk.fromA !== chunk.toA) {
      const deleted = before
        ? geometry(before, chunk.fromA, chunk.toA)
        : geometry(after, chunk.fromB, chunk.fromB, BlockType.WidgetBefore);
      markers.push({
        id: `${index}-deleted`,
        kind: "deleted",
        top: (deleted.top / contentHeight) * 100,
        height: (deleted.height / contentHeight) * 100,
      });
    }
    if (chunk.fromB !== chunk.toB) {
      const added = geometry(after, chunk.fromB, chunk.toB);
      markers.push({
        id: `${index}-added`,
        kind: "added",
        top: (added.top / contentHeight) * 100,
        height: (added.height / contentHeight) * 100,
      });
    }
  });
  return markers;
}

function documentChanges(document: Text, next: Text): ChangeSet {
  return ChangeSet.of(
    diff(document.toString(), next.toString(), diffConfig).map(
      ({ fromA, toA, fromB, toB }) => ({
        from: fromA,
        to: toA,
        insert: next.slice(fromB, toB),
      }),
    ),
    document.length,
  );
}

function wholeLineChanges(
  before: Text,
  after: Text,
): { deleted: number[]; added: number[] } {
  const beforeLines = before.toJSON();
  const afterLines = after.toJSON();
  const deleted: number[] = [];
  const added: number[] = [];
  for (const change of diffLines(beforeLines, afterLines) ?? []) {
    if (change.fromB === change.toB) {
      let from = change.fromA;
      let to = change.toA;
      let anchor = change.fromB;
      while (
        to < beforeLines.length &&
        anchor < afterLines.length &&
        beforeLines[from] === afterLines[anchor]
      ) {
        from += 1;
        to += 1;
        anchor += 1;
      }
      for (let line = from; line < to; line += 1) deleted.push(line + 1);
    } else if (change.fromA === change.toA) {
      let from = change.fromB;
      let to = change.toB;
      let anchor = change.fromA;
      while (
        to < afterLines.length &&
        anchor < beforeLines.length &&
        afterLines[from] === beforeLines[anchor]
      ) {
        from += 1;
        to += 1;
        anchor += 1;
      }
      for (let line = from; line < to; line += 1) added.push(line + 1);
    }
  }
  return { deleted, added };
}

const wholeLineChange = Decoration.line({ class: "cm-wholeLineChange" });
const setWholeLineChanges = StateEffect.define<readonly number[]>();
const markWholeLineChanges = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    const lineNumbers = transaction.effects.find((effect) =>
      effect.is(setWholeLineChanges),
    );
    return lineNumbers
      ? Decoration.set(
          lineNumbers.value.map((line) =>
            wholeLineChange.range(transaction.state.doc.line(line).from),
          ),
          true,
        )
      : value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function languageName(path: string): string {
  const file = gitPathParts(path).name;
  return file.includes(".") ? file.slice(file.lastIndexOf(".") + 1) : "";
}

const absentMode = "000000";

function contentReason(content: GitContent, s: GitStrings): string | null {
  if (content.reason === "symlink") return s.symlink;
  if (content.text !== null) return null;
  if (content.reason === "binary") return s.binary;
  if (content.reason === "tooLarge") return s.tooLarge;
  if (content.reason === "submodule") return s.submodule;
  if (content.reason === "nonUtf8") return s.nonUtf8;
  return s.unavailable;
}

export default function GitDiffView({
  comparison,
  showMinimap = false,
  toolbarActions,
  lineComments,
  footer,
}: GitDiffViewProps) {
  const s = useGitStrings();
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const editors = useRef<{ before?: EditorView; after: EditorView } | null>(
    null,
  );
  const commentable = lineComments !== undefined;
  const commentHandler = useRef<CommentHandler>(() => {});
  commentHandler.current = (version, view) =>
    lineComments?.onComment({
      path: comparison.path,
      side: lineComments.side,
      version,
      ...selectedLines(view.state),
    });
  const minimap = useRef<HTMLDivElement>(null);
  const minimapViewport = useRef<HTMLSpanElement>(null);
  const minimapScroller = useRef<HTMLElement | null>(null);
  const activeMinimapPointer = useRef<number | null>(null);
  const syncMinimapViewport = useRef<() => void>(() => {});
  const refreshMinimapMarkers = useRef<() => void>(() => {});
  const [minimapMarkers, setMinimapMarkers] = useState<DiffMinimapMarker[]>([]);
  const [layout, setLayout] = useStoredPreference(
    "soreno:git-diff-layout",
    "soreno:git-diff-layout-change",
    parseLayout,
  );
  const [wrap, setWrap] = useStoredPreference(
    "soreno:git-diff-wrap",
    "soreno:git-diff-wrap-change",
    parseWrap,
  );
  const [expand, setExpand] = useStoredPreference(
    "soreno:git-diff-expand",
    "soreno:git-diff-expand-change",
    parseExpand,
  );
  const collapseUnchanged = expand ? undefined : collapseConfig;
  const editorId = useId();
  const { parent: parentPath, name: fileName } = gitPathParts(comparison.path);
  const beforeReason = contentReason(comparison.before, s);
  const afterReason = contentReason(comparison.after, s);
  const before = comparison.before.text ?? "";
  const after = comparison.after.text ?? "";
  const conflictStages = comparison.conflictStages;
  const unavailableSides = [
    {
      key: "before" as const,
      label: conflictStages
        ? s.conflictOurs
        : comparison.after.mode === absentMode
          ? s.deleted
          : s.before,
      content: comparison.before,
      reason: beforeReason,
    },
    {
      key: "after" as const,
      label: conflictStages
        ? s.conflictCurrent
        : comparison.before.mode === absentMode
          ? s.added
          : s.after,
      content: comparison.after,
      reason: afterReason,
    },
  ].flatMap((side) => (side.reason ? [{ ...side, reason: side.reason }] : []));

  const setMinimapScrollTop = (top: number) => {
    const scroller = minimapScroller.current;
    if (!scroller) return;
    scroller.scrollTop = Math.min(
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      Math.max(0, top),
    );
    syncMinimapViewport.current();
  };

  const navigateMinimap = (ratio: number) => {
    const scroller = minimapScroller.current;
    if (!scroller) return;
    const boundedRatio = Math.min(1, Math.max(0, ratio));
    setMinimapScrollTop(
      boundedRatio * scroller.scrollHeight - scroller.clientHeight / 2,
    );
  };

  useLayoutEffect(() => {
    if (!host.current || beforeReason || afterReason) return;
    let disposed = false;
    let destroy: () => void;
    const language = codeLanguage(languageName(comparison.path));
    const common: Extension[] = [
      lineNumbers(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({
        spellcheck: "false",
        "aria-label": comparison.path,
        tabindex: "0",
      }),
      markWholeLineChanges,
      ...(wrap ? [EditorView.lineWrapping] : []),
      syntaxHighlighting(markdownHighlightStyle),
      EditorView.theme({}, { dark: theme === "dark" }),
      EditorView.updateListener.of((update) => {
        if (
          showMinimap &&
          (update.geometryChanged ||
            update.transactions.some(
              (transaction) => !isCommentHover(transaction),
            ))
        )
          refreshMinimapMarkers.current();
      }),
    ];
    const comment = (version: DiffLineSelection["version"]) =>
      commentable
        ? [diffLineCommentGutter(version, s.commentLines, commentHandler)]
        : [];
    if (layout === "split") {
      const merge = new MergeView({
        parent: host.current,
        a: { doc: before, extensions: [...common, ...comment("before")] },
        b: { doc: after, extensions: [...common, ...comment("after")] },
        gutter: true,
        collapseUnchanged,
        diffConfig,
      });
      editors.current = { before: merge.a, after: merge.b };
      destroy = () => merge.destroy();
      if (language)
        appendLoadedLanguage(language, [merge.a, merge.b], () => disposed);
    } else {
      const view = new EditorView({
        parent: host.current,
        doc: after,
        extensions: [
          ...common,
          ...comment("after"),
          unifiedMergeView({
            original: before,
            mergeControls: false,
            gutter: true,
            collapseUnchanged,
            diffConfig,
          }),
        ],
      });
      editors.current = { after: view };
      destroy = () => view.destroy();
      if (language) appendLoadedLanguage(language, [view], () => disposed);
    }
    const lineChanges = wholeLineChanges(
      editors.current.after.state.toText(before),
      editors.current.after.state.toText(after),
    );
    editors.current.before?.dispatch({
      effects: setWholeLineChanges.of(lineChanges.deleted),
    });
    editors.current.after.dispatch({
      effects: setWholeLineChanges.of(lineChanges.added),
    });
    const scroller = editors.current.before
      ? host.current.querySelector<HTMLElement>(".cm-mergeView")!
      : editors.current.after.scrollDOM;
    const markerMeasureKey = {};
    const updateMinimapMarkers = () => {
      editors.current?.after.requestMeasure({
        key: markerMeasureKey,
        read: () => {
          const views = editors.current;
          return views
            ? diffMinimapMarkers(
                views.before,
                views.after,
                getChunks(views.after.state)?.chunks ?? [],
              )
            : [];
        },
        write: (markers) => {
          if (!disposed) setMinimapMarkers(markers);
        },
      });
    };
    const updateMinimapViewport = () => {
      const viewport = minimapViewport.current;
      const track = minimap.current;
      if (!viewport || !track) return;
      const scrollHeight = scroller.scrollHeight;
      const clientHeight = scroller.clientHeight;
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      const top = scrollHeight ? (scroller.scrollTop / scrollHeight) * 100 : 0;
      const height = scrollHeight
        ? Math.min(100, (clientHeight / scrollHeight) * 100)
        : 100;
      viewport.style.top = `${top}%`;
      viewport.style.height = `${height}%`;
      track.setAttribute(
        "aria-valuenow",
        String(
          Math.round((maxScroll ? scroller.scrollTop / maxScroll : 0) * 100),
        ),
      );
    };
    minimapScroller.current = scroller;
    syncMinimapViewport.current = updateMinimapViewport;
    refreshMinimapMarkers.current = updateMinimapMarkers;
    const resizeObserver =
      showMinimap && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            updateMinimapViewport();
            updateMinimapMarkers();
          })
        : null;
    if (showMinimap) {
      scroller.addEventListener("scroll", updateMinimapViewport, {
        passive: true,
      });
      resizeObserver?.observe(scroller);
      resizeObserver?.observe(editors.current.after.contentDOM);
      if (editors.current.before)
        resizeObserver?.observe(editors.current.before.contentDOM);
      updateMinimapViewport();
      updateMinimapMarkers();
    }
    return () => {
      disposed = true;
      scroller.removeEventListener("scroll", updateMinimapViewport);
      resizeObserver?.disconnect();
      minimapScroller.current = null;
      syncMinimapViewport.current = () => {};
      refreshMinimapMarkers.current = () => {};
      editors.current = null;
      destroy();
    };
    // Content updates below keep the editor, selection and scroll position intact.
  }, [
    comparison.path,
    layout,
    wrap,
    expand,
    theme,
    beforeReason,
    afterReason,
    showMinimap,
    commentable,
    s.commentLines,
  ]);

  useLayoutEffect(() => {
    const views = editors.current;
    if (!views) return;
    const nextBefore = views.after.state.toText(before);
    const nextAfter = views.after.state.toText(after);
    const lineChanges = wholeLineChanges(nextBefore, nextAfter);
    const afterChanges = documentChanges(views.after.state.doc, nextAfter);
    if (views.before) {
      const beforeChanges = documentChanges(views.before.state.doc, nextBefore);
      views.before.dispatch({
        changes: beforeChanges,
        effects: setWholeLineChanges.of(lineChanges.deleted),
      });
      views.after.dispatch({
        changes: afterChanges,
        effects: setWholeLineChanges.of(lineChanges.added),
      });
    } else {
      const beforeChanges = documentChanges(
        getOriginalDoc(views.after.state),
        nextBefore,
      );
      views.after.dispatch({
        changes: afterChanges,
        effects: [
          setWholeLineChanges.of(lineChanges.added),
          ...(beforeChanges.empty
            ? []
            : [originalDocChangeEffect(views.after.state, beforeChanges)]),
        ],
      });
    }
    if (showMinimap) refreshMinimapMarkers.current();
  }, [before, after, showMinimap]);

  return (
    <div className="git-diff-view">
      <header className="git-diff-toolbar">
        <div className="git-diff-path" title={comparison.path}>
          {parentPath ? <span>{parentPath}</span> : null}
          <strong>{fileName}</strong>
        </div>
        {toolbarActions ? (
          <div className="git-diff-toolbar-actions">{toolbarActions}</div>
        ) : null}
        {unavailableSides.length ? null : (
          <Menu.Root modal={false}>
            <Menu.Trigger
              render={
                <IconButton
                  size="small"
                  aria-label={s.diffOptions}
                  title={s.diffOptions}
                >
                  <Ellipsis />
                </IconButton>
              }
            />
            <Menu.Portal>
              <Menu.Positioner
                className="git-diff-menu-positioner"
                sideOffset={4}
                align="end"
                collisionPadding={8}
              >
                <Menu.Popup render={<MenuSurface className="git-diff-menu" />}>
                  <Menu.RadioGroup
                    aria-label={s.viewMode}
                    value={layout}
                    onValueChange={setLayout}
                  >
                    <Menu.RadioItem
                      nativeButton
                      value="unified"
                      render={
                        <MenuItem
                          selected={layout === "unified"}
                          trailing={
                            layout === "unified" ? (
                              <Check aria-hidden="true" />
                            ) : null
                          }
                        />
                      }
                    >
                      {s.unified}
                    </Menu.RadioItem>
                    <Menu.RadioItem
                      nativeButton
                      value="split"
                      render={
                        <MenuItem
                          selected={layout === "split"}
                          trailing={
                            layout === "split" ? (
                              <Check aria-hidden="true" />
                            ) : null
                          }
                        />
                      }
                    >
                      {s.split}
                    </Menu.RadioItem>
                  </Menu.RadioGroup>
                  <Menu.Separator className="git-diff-menu-separator" />
                  <Menu.CheckboxItem
                    nativeButton
                    checked={wrap}
                    onCheckedChange={setWrap}
                    render={
                      <MenuItem
                        selected={wrap}
                        trailing={wrap ? <Check aria-hidden="true" /> : null}
                      />
                    }
                  >
                    {s.wrapLines}
                  </Menu.CheckboxItem>
                  <Menu.CheckboxItem
                    nativeButton
                    checked={expand}
                    onCheckedChange={setExpand}
                    render={
                      <MenuItem
                        selected={expand}
                        trailing={expand ? <Check aria-hidden="true" /> : null}
                      />
                    }
                  >
                    {s.showAllLines}
                  </Menu.CheckboxItem>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        )}
      </header>
      {conflictStages ? (
        <p className="git-conflict-comparison" role="status">
          {s.conflictComparison}
        </p>
      ) : null}
      {unavailableSides.length ? (
        unavailableSides.some((side) => side.content.imageDataUrl) ? (
          <GitImageComparison sides={unavailableSides} fileName={fileName} />
        ) : (
          <div className="git-diff-unavailable" role="status">
            {unavailableSides.map(({ key, label, reason }) => (
              <p key={key}>
                <strong>{label}</strong> — {reason}
              </p>
            ))}
          </div>
        )
      ) : (
        <div className="git-diff-editor-shell">
          <div className="git-diff-editor" id={editorId} ref={host} />
          {showMinimap ? (
            <div
              ref={minimap}
              className="git-diff-minimap"
              role="scrollbar"
              tabIndex={0}
              aria-controls={editorId}
              aria-label={s.diffMinimap}
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={0}
              title={s.diffMinimap}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                activeMinimapPointer.current = event.pointerId;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                const bounds = event.currentTarget.getBoundingClientRect();
                navigateMinimap((event.clientY - bounds.top) / bounds.height);
              }}
              onPointerMove={(event) => {
                if (
                  activeMinimapPointer.current !== event.pointerId ||
                  event.buttons !== 1
                )
                  return;
                const bounds = event.currentTarget.getBoundingClientRect();
                navigateMinimap((event.clientY - bounds.top) / bounds.height);
              }}
              onPointerUp={(event) => {
                if (activeMinimapPointer.current === event.pointerId)
                  activeMinimapPointer.current = null;
              }}
              onPointerCancel={(event) => {
                if (activeMinimapPointer.current === event.pointerId)
                  activeMinimapPointer.current = null;
              }}
              onLostPointerCapture={(event) => {
                if (activeMinimapPointer.current === event.pointerId)
                  activeMinimapPointer.current = null;
              }}
              onKeyDown={(event) => {
                const scroller = minimapScroller.current;
                const lineStep = editors.current?.after.defaultLineHeight ?? 20;
                const nextTop = !scroller
                  ? null
                  : event.key === "ArrowUp"
                    ? scroller.scrollTop - lineStep
                    : event.key === "ArrowDown"
                      ? scroller.scrollTop + lineStep
                      : event.key === "PageUp"
                        ? scroller.scrollTop - scroller.clientHeight
                        : event.key === "PageDown"
                          ? scroller.scrollTop + scroller.clientHeight
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? scroller.scrollHeight
                              : null;
                if (nextTop === null) return;
                event.preventDefault();
                setMinimapScrollTop(nextTop);
              }}
            >
              {minimapMarkers.map((marker) => (
                <span
                  key={marker.id}
                  className={`git-diff-minimap-marker is-${marker.kind}`}
                  style={{ top: `${marker.top}%`, height: `${marker.height}%` }}
                  aria-hidden="true"
                />
              ))}
              <span
                ref={minimapViewport}
                className="git-diff-minimap-viewport"
                aria-hidden="true"
              />
            </div>
          ) : null}
        </div>
      )}
      {footer}
    </div>
  );
}
