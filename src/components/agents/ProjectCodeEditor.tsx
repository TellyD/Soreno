import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { closeSearchPanel, openSearchPanel, search } from "@codemirror/search";
import {
  EditorSelection,
  EditorState,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  runScopeHandlers,
} from "@codemirror/view";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isImeComposing } from "../../domain/keyboard";
import {
  isMarkdownProjectFile,
  projectFileName,
  type ProjectFileContent,
} from "../../domain/projectFiles";
import { useTheme } from "../../theme/ThemeProvider";
import {
  appendLoadedLanguage,
  codeLanguage,
} from "../markdown-editor/codeLanguages";
import { markdownSupport } from "../markdown-editor/document";
import { markdownHighlightStyle } from "../markdown-editor/highlighting";
import { findNextMatch, findPreviousMatch } from "./projectFileSearch";
import { ProjectFileSearchBar } from "./ProjectFileSearchBar";

export type FileReveal = {
  id: number;
  path: string;
  line: number;
  start: number;
  end: number;
};

export type OpenDocument = ProjectFileContent & {
  loadId: number;
  original: string;
  value: string;
};

type SearchPanel = { dom: HTMLElement; view: EditorView; state: EditorState };

function languageName(path: string): string {
  const file = projectFileName(path);
  return file.includes(".")
    ? file.slice(file.lastIndexOf(".") + 1).toLowerCase()
    : "";
}

export function ProjectCodeEditor({
  document,
  editable,
  reveal,
  searchRequested,
  onChange,
  onRevealed,
  onSave,
  onSearchOpened,
}: {
  document: OpenDocument;
  editable: boolean;
  reveal: FileReveal | null;
  searchRequested: boolean;
  onChange: (value: string) => void;
  onRevealed: (id: number) => void;
  onSave: () => void;
  onSearchOpened: () => void;
}) {
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const [searchPanel, setSearchPanel] = useState<SearchPanel | null>(null);
  const change = useRef(onChange);
  const save = useRef(onSave);
  change.current = onChange;
  save.current = onSave;

  useLayoutEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const markdown = isMarkdownProjectFile(document.path);
    const language = markdown
      ? null
      : codeLanguage(languageName(document.path));
    const common: Extension[] = [
      lineNumbers(),
      history(),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          scope: "editor search-panel",
          run: () => {
            save.current();
            return true;
          },
        },
        { key: "Mod-f", run: openSearchPanel, scope: "editor search-panel" },
        {
          key: "F3",
          run: findNextMatch,
          shift: findPreviousMatch,
          scope: "editor search-panel",
          preventDefault: true,
        },
        {
          key: "Mod-g",
          run: findNextMatch,
          shift: findPreviousMatch,
          scope: "editor search-panel",
          preventDefault: true,
        },
        { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      search({
        createPanel: (view) => {
          const dom = view.dom.ownerDocument.createElement("div");
          dom.className = "project-file-search";
          dom.addEventListener("keydown", (event) => {
            if (
              !event.defaultPrevented &&
              !isImeComposing(event) &&
              runScopeHandlers(view, event, "search-panel")
            )
              event.preventDefault();
          });
          return {
            dom,
            top: true,
            mount: () => setSearchPanel({ dom, view, state: view.state }),
            update: (update) => {
              if (update.state === update.startState) return;
              setSearchPanel((panel) =>
                panel?.dom === dom ? { ...panel, state: update.state } : panel,
              );
            },
            destroy: () =>
              setSearchPanel((panel) => (panel?.dom === dom ? null : panel)),
          };
        },
      }),
      EditorState.lineSeparator.of("\n"),
      EditorState.readOnly.of(!editable),
      EditorView.editable.of(editable),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        spellcheck: "false",
        "aria-label": document.path,
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) change.current(update.state.doc.toString());
      }),
      syntaxHighlighting(markdownHighlightStyle),
      EditorView.theme({}, { dark: theme === "dark" }),
      ...(markdown ? [markdownSupport] : []),
    ];
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: Text.of(document.value.split("\n")),
        extensions: common,
      }),
    });
    editor.current = view;
    if (language) appendLoadedLanguage(language, [view], () => disposed);
    return () => {
      disposed = true;
      editor.current = null;
      view.destroy();
    };
  }, [document.loadId, document.path, editable, theme]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== document.value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: document.value },
      });
    }
  }, [document.value]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || !reveal) return;
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(reveal.line, 1), doc.lines));
    const anchor = line.from + Math.min(Math.max(reveal.start, 0), line.length);
    const head = line.from + Math.min(Math.max(reveal.end, 0), line.length);
    view.dispatch({
      selection: EditorSelection.range(anchor, head),
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    // A modal opened while the file loaded keeps focus; typing must not edit the file behind it.
    if (!view.dom.ownerDocument.querySelector('[aria-modal="true"]'))
      view.focus();
    onRevealed(reveal.id);
  }, [reveal?.id, document.loadId]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || !searchRequested) return;
    openSearchPanel(view);
    onSearchOpened();
  }, [searchRequested, document.loadId]);

  return (
    <>
      <div className="project-file-editor-host" ref={host} />
      {searchPanel
        ? createPortal(
            <ProjectFileSearchBar
              state={searchPanel.state}
              view={searchPanel.view}
            />,
            searchPanel.dom,
          )
        : null}
    </>
  );
}
