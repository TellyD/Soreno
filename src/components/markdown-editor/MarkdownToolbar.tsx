import { SlidersHorizontal, X } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorView } from "@codemirror/view";
import { Compartment, StateEffect, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import { forgetTableCell, prepareTableCell } from "./tablePreview";
import { useI18n, type TranslationKey } from "../../i18n";
import { dismissNotification, notifyError } from "../../notifications";
import { Button } from "../ui/Button";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { scrollWheelHorizontally } from "../ui/horizontalWheel";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/Select";
import { commandLabel, editorCommand, type EditorAction } from "./commands";
import { actionIcon, actionIcons, type IconAction } from "./actionIcons";

type ToolbarAction = IconAction;
const storageKey = "soreno:markdown-toolbar:v1";
const toolbarSaveNotificationKey = "editor-toolbar-save";
const defaultTools: ToolbarAction[] = [
  "bold",
  "italic",
  "link",
  "heading1",
  "heading2",
  "bullet",
  "numbered",
  "task",
  "image",
];
const toolColumns: {
  label: TranslationKey;
  tools: readonly ToolbarAction[];
}[][] = [
  [
    {
      label: "editor.toolbar.text",
      tools: ["bold", "italic", "strike", "code", "link"],
    },
    {
      label: "editor.toolbar.headings",
      tools: [
        "paragraph",
        "heading1",
        "heading2",
        "heading3",
        "heading4",
        "heading5",
        "heading6",
      ],
    },
  ],
  [
    {
      label: "editor.toolbar.lists",
      tools: ["bullet", "numbered", "task", "indent", "outdent", "toggleTask"],
    },
    {
      label: "editor.toolbar.insert",
      tools: ["quote", "codeBlock", "rule", "table", "image"],
    },
  ],
];

const blockStyles = toolColumns[0][1].tools;
const buttonGroups = [toolColumns[0][0], ...toolColumns[1]];
const formatNodes: Partial<Record<ToolbarAction, readonly string[]>> = {
  bold: ["StrongEmphasis"],
  italic: ["Emphasis"],
  strike: ["Strikethrough"],
  code: ["InlineCode"],
  link: ["Link"],
  bullet: ["BulletList"],
  numbered: ["OrderedList"],
  task: ["Task"],
  quote: ["Blockquote"],
  codeBlock: ["FencedCode", "CodeBlock"],
  table: ["Table"],
};

function currentFormats(state: EditorState) {
  const { from, to } = state.selection.main;
  const active = new Set<ToolbarAction>();
  // Resolve the Markdown tree, not a language mounted inside a fenced code block.
  const side = from === state.doc.lineAt(from).to ? -1 : 1;
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(
      state,
    ).resolve(from, side);
    node;
    node = node.parent
  ) {
    if (node.from > from || node.to < to) continue;
    const heading = /^(?:ATX|Setext)Heading([1-6])$/u.exec(node.name);
    if (heading) active.add(`heading${heading[1]}` as ToolbarAction);
    for (const [action, names] of Object.entries(formatNodes)) {
      if (names.includes(node.name)) active.add(action as ToolbarAction);
    }
  }
  // Markdown tasks also belong to a list, but have their own toolbar button.
  if (active.has("task")) {
    active.delete("bullet");
    active.delete("numbered");
  }
  return [...active].sort().join(",");
}

export function parseToolbarTools(stored: string | null): ToolbarAction[] {
  try {
    const tools: unknown = JSON.parse(stored ?? "null");
    if (
      Array.isArray(tools) &&
      tools.every((item) => typeof item === "string")
    ) {
      const known = actionIcons
        .map(([action]) => action)
        .filter((action) => tools.includes(action));
      if (known.length || tools.length === 0) return known;
    }
  } catch {
    /* Invalid preferences use the essential tools. */
  }
  return defaultTools;
}

function readTools(): ToolbarAction[] {
  try {
    return parseToolbarTools(window.localStorage.getItem(storageKey));
  } catch {
    /* Unavailable preferences use the essential tools. */
    return defaultTools;
  }
}

function ToolbarCustomization({
  id,
  visible,
  onChange,
  onClose,
}: {
  id: string;
  visible: ToolbarAction[];
  onChange: (tools: ToolbarAction[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return createPortal(
    <DialogOverlay
      className="markdown-toolbar-settings-overlay"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onClose();
        }
      }}
    >
      <DialogSurface
        id={id}
        className="markdown-toolbar-settings"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
      >
        <header>
          <h2 id={`${id}-title`}>{t("editor.toolbar.title")}</h2>
          <IconButton aria-label={t("editor.toolbar.close")} onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <p id={`${id}-description`}>{t("editor.toolbar.description")}</p>
        <div className="markdown-toolbar-settings-groups">
          {toolColumns.map((column) => (
            <div
              className="markdown-toolbar-settings-column"
              key={column[0].label}
            >
              {column.map((group) => (
                <fieldset key={group.label}>
                  <legend className="sr-only">{t(group.label)}</legend>
                  <div className="markdown-toolbar-settings-options">
                    {group.tools.map((action) => {
                      const Icon = actionIcon(action);
                      return (
                        <label key={action}>
                          <input
                            type="checkbox"
                            checked={visible.includes(action)}
                            onChange={(event) =>
                              onChange(
                                event.target.checked
                                  ? [...visible, action]
                                  : visible.filter(
                                      (toolId) => toolId !== action,
                                    ),
                              )
                            }
                          />
                          <Icon size={16} aria-hidden="true" />
                          <span>{t(commandLabel(action))}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          ))}
        </div>
        <footer>
          <button
            type="button"
            className="markdown-toolbar-reset"
            onClick={() => onChange(defaultTools)}
          >
            {t("editor.toolbar.reset")}
          </button>
          <Button variant="primary" onClick={onClose}>
            {t("editor.toolbar.done")}
          </Button>
        </footer>
      </DialogSurface>
    </DialogOverlay>,
    document.body,
  );
}

export function MarkdownToolbar({
  editor,
  onImage,
}: {
  editor: EditorView;
  onImage: () => void;
}) {
  const { t } = useI18n();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const settingsId = useId();
  const styleRef = useRef<HTMLButtonElement>(null);
  const [formats, setFormats] = useState(() => currentFormats(editor.state));
  const active = formats.split(",");
  const blockStyle =
    blockStyles.find((action) => active.includes(action)) ?? "paragraph";
  useEffect(() => {
    const compartment = new Compartment();
    let previous = currentFormats(editor.state);
    setFormats(previous);
    editor.dispatch({
      effects: StateEffect.appendConfig.of(
        compartment.of(
          EditorView.updateListener.of((update) => {
            if (
              !update.docChanged &&
              !update.selectionSet &&
              syntaxTree(update.startState) === syntaxTree(update.state)
            )
              return;
            const next = currentFormats(update.state);
            if (next !== previous) {
              previous = next;
              setFormats(next);
            }
          }),
        ),
      ),
    });
    return () => {
      editor.dispatch({ effects: compartment.reconfigure([]) });
    };
  }, [editor]);
  const [visible, setVisible] = useState(readTools);
  const [customizing, setCustomizing] = useState(false);
  function changeTools(tools: ToolbarAction[]) {
    setVisible(tools);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(tools));
      dismissNotification(toolbarSaveNotificationKey);
    } catch {
      notifyError(t("editor.toolbar.saveError"), {
        key: toolbarSaveNotificationKey,
      });
    }
  }
  useEffect(() => {
    const toolbar = toolbarRef.current!;
    const scrollTools = (event: WheelEvent) =>
      scrollWheelHorizontally(toolbar, event);
    let drag: { x: number; scrollLeft: number } | null = null;
    let dragged = false;
    function startDrag(event: MouseEvent) {
      if (event.button !== 0) return;
      dragged = false;
      if (toolbar.scrollWidth > toolbar.clientWidth) {
        drag = { x: event.clientX, scrollLeft: toolbar.scrollLeft };
      }
    }
    function endDrag() {
      drag = null;
      delete toolbar.dataset.dragging;
    }
    function moveDrag(event: MouseEvent) {
      if (!drag) return;
      if (event.buttons !== 1) {
        endDrag();
        return;
      }
      const delta = event.clientX - drag.x;
      if (!dragged && Math.abs(delta) < 5) return;
      dragged = true;
      toolbar.dataset.dragging = "true";
      event.preventDefault();
      toolbar.scrollLeft = Math.max(
        0,
        Math.min(
          toolbar.scrollWidth - toolbar.clientWidth,
          drag.scrollLeft - delta,
        ),
      );
    }
    function suppressDragClick(event: MouseEvent) {
      if (dragged && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
      }
      dragged = false;
    }
    toolbar.addEventListener("wheel", scrollTools, { passive: false });
    toolbar.addEventListener("mousedown", startDrag);
    toolbar.addEventListener("click", suppressDragClick, true);
    window.addEventListener("mousemove", moveDrag);
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("blur", endDrag);
    return () => {
      toolbar.removeEventListener("wheel", scrollTools);
      toolbar.removeEventListener("mousedown", startDrag);
      toolbar.removeEventListener("click", suppressDragClick, true);
      window.removeEventListener("mousemove", moveDrag);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("blur", endDrag);
    };
  }, []);
  const saved = useRef({
    doc: editor.state.doc,
    selection: editor.state.selection,
  });
  function remember() {
    saved.current = {
      doc: editor.state.doc,
      selection: editor.state.selection,
    };
  }
  function restore() {
    if (saved.current.doc.eq(editor.state.doc))
      editor.dispatch({ selection: saved.current.selection });
  }
  function run(action: EditorAction | "image", focusEditor = true) {
    if (editor.composing) return;
    restore();
    const prepared = prepareTableCell(editor);
    if (action === "image") {
      if (prepared) editor.dispatch(prepared);
      onImage();
    } else {
      editorCommand(action)(
        prepared
          ? {
              state: prepared.state,
              dispatch: (formatted) => {
                editor.dispatch({
                  changes: prepared.changes.compose(formatted.changes),
                  selection: formatted.state.selection,
                  annotations: isolateHistory.of("full"),
                  scrollIntoView: true,
                });
              },
            }
          : editor,
      );
      remember();
      if (focusEditor) editor.focus();
    }
  }
  function containsFocus(row: HTMLElement, target: EventTarget | null) {
    const listId = styleRef.current?.getAttribute("aria-controls");
    return (
      target instanceof Node &&
      (row.contains(target) ||
        document.getElementById(settingsId)?.contains(target) ||
        (listId && document.getElementById(listId)?.contains(target)))
    );
  }
  return (
    <div
      className="markdown-toolbar-row"
      onPointerDown={remember}
      onBlurCapture={(event) => {
        if (!containsFocus(event.currentTarget, event.relatedTarget)) {
          forgetTableCell(editor);
        }
      }}
      onFocusCapture={(event) => {
        if (!containsFocus(event.currentTarget, event.relatedTarget)) {
          remember();
        }
      }}
    >
      <div
        ref={toolbarRef}
        className="markdown-toolbar"
        role="toolbar"
        aria-label={t("editor.formatting")}
      >
        {[
          blockStyles.some((action) => visible.includes(action)) ? (
            <Select
              key="style"
              ref={styleRef}
              className="markdown-toolbar-style"
              aria-label={t("editor.toolbar.headings")}
              value={blockStyle}
              options={blockStyles
                .filter(
                  (action) =>
                    action === "paragraph" ||
                    visible.includes(action) ||
                    action === blockStyle,
                )
                .map((action) => ({
                  value: action,
                  label: t(commandLabel(action)),
                  disabled: action !== "paragraph" && !visible.includes(action),
                }))}
              onValueChange={(action) => run(action as EditorAction, false)}
            />
          ) : null,
          ...buttonGroups.map((group) => {
            const tools = group.tools.filter((action) =>
              visible.includes(action),
            );
            return tools.length ? (
              <Fragment key={group.label}>
                {tools.map((action) => {
                  const Icon = actionIcon(action);
                  const pressed = formatNodes[action]
                    ? active.includes(action)
                    : undefined;
                  return (
                    <IconButton
                      key={action}
                      title={t(commandLabel(action))}
                      aria-label={t(commandLabel(action))}
                      aria-pressed={pressed}
                      className={pressed ? "selected" : undefined}
                      onClick={() => run(action)}
                    >
                      <Icon />
                    </IconButton>
                  );
                })}
              </Fragment>
            ) : null;
          }),
        ]
          .filter(Boolean)
          .map((group, index) => (
            <Fragment key={group!.key}>
              {index > 0 ? (
                <span
                  className="markdown-toolbar-separator"
                  aria-hidden="true"
                />
              ) : null}
              {group}
            </Fragment>
          ))}
      </div>
      <span className="markdown-toolbar-separator" aria-hidden="true" />
      <IconButton
        className="markdown-toolbar-customize"
        title={t("editor.toolbar.title")}
        aria-label={t("editor.toolbar.title")}
        aria-haspopup="dialog"
        aria-expanded={customizing}
        aria-controls={customizing ? settingsId : undefined}
        onClick={(event) => {
          event.currentTarget.focus();
          setCustomizing(true);
        }}
      >
        <SlidersHorizontal aria-hidden="true" />
      </IconButton>
      {customizing ? (
        <ToolbarCustomization
          id={settingsId}
          visible={visible}
          onChange={changeTools}
          onClose={() => setCustomizing(false)}
        />
      ) : null}
    </div>
  );
}
