import { StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { blockPadding, externalUpdate, markdownText } from "./document";
import { ImageUploadError } from "./fileUpload";
import { safeImageUrl } from "./urls";
import { markdownImage } from "../../domain/markdown";
import type { TranslationKey } from "../../i18n";

type Anchor = { id: symbol; from: number; to: number };
const addAnchor = StateEffect.define<Anchor>();
const removeAnchor = StateEffect.define<symbol>();
export const imageAnchors = StateField.define<Map<symbol, Anchor>>({
  create: () => new Map(),
  update: (anchors, tr) => {
    if (tr.annotation(externalUpdate)) return new Map();
    const mapped = new Map<symbol, Anchor>();
    for (const [id, anchor] of anchors) {
      let deleted = false;
      tr.changes.iterChangedRanges((from, to) => {
        if (to <= from) return;
        if (
          anchor.from === anchor.to
            ? from <= anchor.from && to >= anchor.from
            : from < anchor.to && to > anchor.from
        )
          deleted = true;
      });
      if (!deleted) {
        const from = tr.changes.mapPos(anchor.from, 1);
        mapped.set(id, {
          id,
          from,
          to:
            anchor.to === anchor.from ? from : tr.changes.mapPos(anchor.to, -1),
        });
      }
    }
    for (const effect of tr.effects) {
      if (effect.is(addAnchor)) mapped.set(effect.value.id, effect.value);
      if (effect.is(removeAnchor)) mapped.delete(effect.value);
    }
    return mapped;
  },
});

export function reserveImagePosition(
  view: EditorView,
  from = view.state.selection.main.from,
  to = view.state.selection.main.to,
): symbol {
  const id = Symbol("image upload");
  view.dispatch({ effects: addAnchor.of({ id, from, to }) });
  return id;
}

export function cancelImagePosition(view: EditorView, id: symbol) {
  view.dispatch({ effects: removeAnchor.of(id) });
}

export function imageErrorKey(error: unknown): TranslationKey {
  if (error instanceof ImageUploadError) {
    if (error.code === "unsupported-type")
      return "errors.imageUploadUnsupported";
    if (error.code === "source-too-large" || error.code === "stored-too-large")
      return "errors.imageUploadTooLarge";
  }
  return "errors.imageUpload";
}

export async function insertUploadedImages(
  view: EditorView,
  options: {
    files: readonly File[];
    upload: (file: File) => Promise<string>;
    signal: AbortSignal;
    onError: (error: unknown) => void;
    anchor?: symbol;
  },
): Promise<void> {
  if (options.signal.aborted) return;
  const id = options.anchor ?? reserveImagePosition(view);
  const results = await Promise.allSettled(
    options.files.map(async (file) => {
      const url = safeImageUrl(await options.upload(file));
      if (!url)
        throw new ImageUploadError("unsupported-type", "Unsupported image URL");
      return markdownImage(file.name, url);
    }),
  );
  if (options.signal.aborted) return;
  const anchor = view.state.field(imageAnchors).get(id);
  if (!anchor) return;
  for (const result of results)
    if (result.status === "rejected") options.onError(result.reason);
  const images = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (!images.length) {
    cancelImagePosition(view, id);
    return;
  }
  const { from, to } = anchor;
  // Edges are padded too, so text can be typed above or below the image.
  const { before, after } = blockPadding(view.state, from, to, true);
  const text = before + images.join("\n\n") + after;
  const insert = markdownText(text);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    effects: removeAnchor.of(id),
    annotations: isolateHistory.of("full"),
  });
}

export function imageClipboardHandlers(
  upload: (files: File[], position?: number) => void,
) {
  return EditorView.domEventHandlers({
    paste(event) {
      const images = Array.from(event.clipboardData?.files ?? []).filter(
        (file) => file.type.startsWith("image/"),
      );
      if (images.length) {
        event.preventDefault();
        upload(images);
        return true;
      }
      if (
        event.clipboardData?.types.includes("text/html") &&
        !event.clipboardData.getData("text/plain")
      ) {
        event.preventDefault();
        return true;
      }
      return false;
    },
    drop(event, view) {
      const images = Array.from(event.dataTransfer?.files ?? []).filter(
        (file) => file.type.startsWith("image/"),
      );
      if (!images.length) return false;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      event.preventDefault();
      upload(images, position);
      return true;
    },
  });
}
