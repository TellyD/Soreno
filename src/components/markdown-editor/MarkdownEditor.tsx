import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewline,
  invertedEffects,
  isolateHistory,
} from "@codemirror/commands";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { markdownHighlightStyle } from "./highlighting";
import { closeCompletion } from "@codemirror/autocomplete";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { useTheme } from "../../theme";
import { ImagePreviewDialog } from "../ui/ImagePreviewDialog";
import {
  externalUpdate,
  lineEnding,
  markdownSupport,
  markdownText,
} from "./document";
import { livePreview } from "./livePreview";
import type { ImageResolver } from "./previewWidgets";
import "./MarkdownEditor.css";
import { formattingKeymap, slashCompletions } from "./commands";
import { MarkdownToolbar } from "./MarkdownToolbar";
import {
  cancelImagePosition,
  imageAnchors,
  imageClipboardHandlers,
  imageErrorKey,
  insertUploadedImages,
  reserveImagePosition,
} from "./imageUpload";

export type MarkdownEditorHandle = {
  focus: () => void;
  requestImage: () => void;
};

export type MarkdownEditorProps = {
  content: string;
  readOnly?: boolean;
  // Changing it mounts a fresh editor, with its own history and pending uploads.
  documentId: string;
  mode: "source" | "preview";
  // Sized to its content inside a form.
  inline?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  focusRequest?: number;
  ref?: Ref<MarkdownEditorHandle>;
  uploadImage: (file: File) => Promise<string>;
  formatImageError?: (error: unknown) => string;
  // Must keep its identity; the document keeps the original URLs.
  resolveImageUrl?: ImageResolver;
  onContentChange: (content: string) => void;
  onFocusRequestHandled?: (request: number) => void;
};

export function MarkdownEditor(props: MarkdownEditorProps) {
  const { language, t } = useI18n();
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const toolbarOverlay = useRef<HTMLDivElement>(null);
  const toolbarMount = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<EditorView | null>(null);
  const requestImage = useRef<() => void>(() => {});
  const selectImages = useRef<(files: File[]) => void>(() => {});
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const translate = useRef(t);
  translate.current = t;
  const viewRef = useRef<EditorView | null>(null);
  const current = useRef(props);
  current.current = props;
  const acceptedSource = useRef(props.content);
  const lastFocusRequest = useRef(0);
  const compartments = useRef({
    separator: new Compartment(),
    display: new Compartment(),
    locale: new Compartment(),
    appearance: new Compartment(),
    editing: new Compartment(),
  }).current;

  // Mount the editor and its toolbar before paint so note switches don't shift the content.
  useLayoutEffect(() => {
    if (!host.current) return;
    acceptedSource.current = current.current.content;
    const lifetime = new AbortController();
    let pickerAnchor: symbol | undefined;
    function upload(files: File[], anchor: symbol) {
      if (
        current.current.readOnly ||
        !view.state.field(imageAnchors).has(anchor)
      )
        return;
      const onError = (error: unknown) => {
        if (lifetime.signal.aborted) return;
        const { formatImageError } = current.current;
        notifyError(
          formatImageError
            ? formatImageError(error)
            : translate.current(imageErrorKey(error)),
        );
      };
      void insertUploadedImages(view, {
        files,
        anchor,
        upload: (file) => current.current.uploadImage(file),
        signal: lifetime.signal,
        onError,
      }).catch(onError);
    }
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: markdownText(current.current.content),
        extensions: [
          markdownSupport,
          history(),
          imageAnchors,
          imageClipboardHandlers((files, position) => {
            if (current.current.readOnly) return;
            upload(
              files,
              position === undefined
                ? reserveImagePosition(view)
                : reserveImagePosition(view, position, position),
            );
          }),
          EditorState.transactionFilter.of((tr) =>
            current.current.readOnly &&
            tr.docChanged &&
            !tr.annotation(externalUpdate)
              ? []
              : tr,
          ),
          EditorView.clipboardInputFilter.of((text, state) =>
            text.replace(/\r\n?|\n/gu, state.lineBreak),
          ),
          keymap.of([
            { key: "Escape", run: closeCompletion, stopPropagation: true },
            { key: "Shift-Enter", run: insertNewline },
            ...formattingKeymap,
            ...markdownKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.scrollMargins.of(() => ({
            top: toolbarOverlay.current?.offsetHeight ?? 0,
          })),
          syntaxHighlighting(markdownHighlightStyle),
          compartments.separator.of(
            EditorState.lineSeparator.of(lineEnding(current.current.content)),
          ),
          compartments.display.of([]),
          compartments.locale.of([]),
          compartments.appearance.of([]),
          compartments.editing.of([]),
          invertedEffects.of((tr) =>
            tr.startState.lineBreak === tr.state.lineBreak
              ? []
              : [
                  compartments.separator.reconfigure(
                    EditorState.lineSeparator.of(tr.startState.lineBreak),
                  ),
                ],
          ),
          EditorView.updateListener.of((update) => {
            const textChanged =
              update.docChanged ||
              update.startState.lineBreak !== update.state.lineBreak;
            if (
              !textChanged ||
              update.transactions.some((tr) => tr.annotation(externalUpdate))
            )
              return;
            const next = update.state.sliceDoc();
            if (next === acceptedSource.current) return;
            acceptedSource.current = next;
            current.current.onContentChange(next);
          }),
        ],
      }),
    });
    const toolbarHost = document.createElement("div");
    toolbarHost.className = "markdown-toolbar-host";
    view.scrollDOM.prepend(toolbarHost);
    toolbarMount.current = toolbarHost;
    viewRef.current = view;
    setEditor(view);
    requestImage.current = () => {
      if (
        current.current.readOnly ||
        lifetime.signal.aborted ||
        !fileInput.current
      )
        return;
      if (pickerAnchor) cancelImagePosition(view, pickerAnchor);
      pickerAnchor = reserveImagePosition(view);
      fileInput.current.value = "";
      fileInput.current.click();
    };
    const input = fileInput.current;
    const cancelSelection = () => selectImages.current([]);
    input?.addEventListener("cancel", cancelSelection);
    selectImages.current = (files) => {
      if (!pickerAnchor || lifetime.signal.aborted) return;
      const anchor = pickerAnchor;
      pickerAnchor = undefined;
      if (files.length) upload(files, anchor);
      else cancelImagePosition(view, anchor);
    };
    return () => {
      lifetime.abort();
      input?.removeEventListener("cancel", cancelSelection);
      requestImage.current = () => {};
      selectImages.current = () => {};
      viewRef.current = null;
      toolbarMount.current = null;
      view.destroy();
    };
  }, [props.documentId, compartments]);

  useImperativeHandle(
    props.ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      requestImage: () => requestImage.current(),
    }),
    [],
  );

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const readOnly = props.readOnly ?? false;
    view.dispatch({
      effects: compartments.editing.reconfigure(
        readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [],
      ),
      // Cancel pending imports even when they finish after editing is unlocked.
      annotations: readOnly ? externalUpdate.of(true) : undefined,
    });
  }, [props.readOnly, props.documentId, compartments]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || props.content === acceptedSource.current) return;
    acceptedSource.current = props.content;
    const doc = markdownText(props.content);
    view.dispatch({
      changes: view.state.doc.eq(doc)
        ? undefined
        : { from: 0, to: view.state.doc.length, insert: doc },
      effects: compartments.separator.reconfigure(
        EditorState.lineSeparator.of(lineEnding(props.content)),
      ),
      annotations: [externalUpdate.of(true), isolateHistory.of("full")],
    });
  }, [props.content, props.documentId, compartments]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        compartments.display.reconfigure(
          props.mode === "preview"
            ? livePreview({
                selectImage: t("editor.selectImage"),
                resizeImage: t("editor.resizeImage"),
                tableCell: t("editor.tableCell"),
                tableAddRow: t("editor.tableAddRow"),
                tableAddColumn: t("editor.tableAddColumn"),
                toggleTask: t("editor.command.toggleTask"),
                imageError: t("editor.imagePreviewError"),
                linkError: t("editor.linkError"),
                copyCode: t("editor.copyCode"),
                codeCopied: t("editor.codeCopied"),
                copyCodeError: t("editor.copyCodeError"),
                codeLanguage: t("editor.codeLanguage"),
                plainText: t("editor.plainText"),
                resolveImage: props.resolveImageUrl,
                onError: (message) => {
                  if (viewRef.current === view) notifyError(message);
                },
                openImage: (src, alt) => {
                  if (viewRef.current === view) setPreview({ src, alt });
                },
              })
            : [],
        ),
        compartments.locale.reconfigure([
          EditorView.contentAttributes.of({
            "aria-label":
              props.ariaLabel ??
              t(
                props.mode === "source"
                  ? "editor.raw.ariaLabel"
                  : "editor.preview.ariaLabel",
              ),
            lang: language,
            spellcheck: "false",
          }),
          placeholder(props.placeholder ?? t("editor.empty.prompt")),
          slashCompletions(t, () => requestImage.current()),
        ]),
        compartments.appearance.reconfigure(
          EditorView.theme({}, { dark: theme === "dark" }),
        ),
      ],
    });
  }, [
    props.mode,
    props.documentId,
    props.ariaLabel,
    props.placeholder,
    props.resolveImageUrl,
    language,
    theme,
    t,
    compartments,
  ]);

  useEffect(() => {
    const request = props.focusRequest ?? 0;
    if (request <= 0 || request === lastFocusRequest.current) return;
    const view = viewRef.current;
    const frame = requestAnimationFrame(() => {
      if (!view || viewRef.current !== view) return;
      lastFocusRequest.current = request;
      view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
      view.focus();
      current.current.onFocusRequestHandled?.(request);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.focusRequest, props.documentId]);

  return (
    <>
      <div
        className={`markdown-editor markdown-editor-${props.mode}${props.inline ? " markdown-editor-inline" : ""}`}
        data-mode={props.mode}
      >
        {props.mode === "preview" && editor && toolbarMount.current
          ? createPortal(
              <div className="markdown-toolbar-overlay" ref={toolbarOverlay}>
                <MarkdownToolbar
                  editor={editor}
                  onImage={() => requestImage.current()}
                />
              </div>,
              toolbarMount.current,
            )
          : null}
        <input
          type="file"
          accept="image/*"
          multiple
          hidden
          ref={fileInput}
          onChange={(event) =>
            selectImages.current(Array.from(event.currentTarget.files ?? []))
          }
        />
        <div className="markdown-editor-content" ref={host} />
        {preview ? (
          <ImagePreviewDialog
            src={preview.src}
            name={preview.alt || t("editor.image")}
            onClose={() => setPreview(null)}
          />
        ) : null}
      </div>
    </>
  );
}
