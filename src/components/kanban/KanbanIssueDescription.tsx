import { useCallback, useEffect, useRef, useState } from "react";
import { loadLinearImage, uploadKanbanImage } from "../../data/kanbanApi";
import { replacedKanbanImages } from "../../domain/kanban";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { MarkdownEditor } from "../markdown-editor/MarkdownEditor";

const DESCRIPTION_SAVE_DELAY_MS = 700;

// Object URLs of recently shown Linear uploads; a failed load is tried again next time.
const linearImages = new Map<string, Promise<string>>();
const LINEAR_IMAGE_CACHE_LIMIT = 50;

function cacheLinearImage(url: string, image: Promise<string>) {
  linearImages.set(url, image);
  for (const [oldest, evicted] of linearImages) {
    if (linearImages.size <= LINEAR_IMAGE_CACHE_LIMIT) break;
    linearImages.delete(oldest);
    // An image already shown keeps its decoded pixels after the revoke.
    // shortcut: past 50 images still loading at once, an evicted URL may be revoked before its widget loads it; count widget users if descriptions that large appear.
    evicted.then(URL.revokeObjectURL, () => undefined);
  }
}

function resolveLinearImage(url: string): Promise<string> | null {
  if (!url.startsWith("https://uploads.linear.app/")) return null;
  let image = linearImages.get(url);
  // Re-inserted so the Map's insertion order lists the least recently used first.
  linearImages.delete(url);
  if (!image) {
    image = loadLinearImage(url).then(
      (bytes) => URL.createObjectURL(new Blob([bytes])),
      (error: unknown) => {
        linearImages.delete(url);
        throw error;
      },
    );
  }
  cacheLinearImage(url, image);
  return image;
}

export function KanbanIssueDescription({
  description,
  formatError,
  issueId,
  onSave,
}: {
  description: string | null;
  formatError: (error: unknown) => string;
  issueId: string;
  onSave: (description: string) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(description ?? "");
  // Written with the state so a blur or unmount right after a keystroke saves it.
  const draftRef = useRef(draft);
  // Last text sent or received; compared trimmed since the backend trims what it stores.
  const savedRef = useRef(draft);
  const savingRef = useRef(false);
  // Our last save: the text sent and the one stored, which comes back as an outside change.
  const echoRef = useRef<{ sent: string; stored: string } | null>(null);
  const latest = useRef({ formatError, onSave });
  latest.current = { formatError, onSave };

  // Saves one draft at a time, then whatever was typed meanwhile.
  const flush = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (draftRef.current.trim() !== savedRef.current.trim()) {
        const text = draftRef.current;
        const previous = savedRef.current;
        savedRef.current = text;
        try {
          const stored = await latest.current.onSave(text);
          echoRef.current = { sent: text, stored: stored ?? "" };
        } catch (error) {
          savedRef.current = previous;
          notifyError(latest.current.formatError(error));
          return;
        }
      }
    } finally {
      savingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (draft.trim() === savedRef.current.trim()) return;
    const timer = window.setTimeout(
      () => void flush(),
      DESCRIPTION_SAVE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [draft, flush]);

  // Leaving the issue keeps the last keystrokes.
  useEffect(() => () => void flush(), [flush]);

  // An outside change, e.g. by an agent, replaces the text once no local edit is pending.
  useEffect(() => {
    const next = description ?? "";
    const saved = savedRef.current;
    if (
      next.trim() === saved.trim() ||
      savingRef.current ||
      draft.trim() !== saved.trim()
    )
      return;
    const echo = echoRef.current;
    // Linear rewrites the Markdown it stores (blank lines, list spacing…): our own save keeps the typed text.
    const replaced =
      echo && next === echo.stored && saved === echo.sent
        ? replacedKanbanImages(saved, next)
        : null;
    if (!replaced) {
      savedRef.current = next;
      draftRef.current = next;
      setDraft(next);
      return;
    }
    if (replaced.length === 0) return;
    let kept = saved;
    let typed = draft;
    // shortcut: a file written under two URL forms (hand-edited, e.g. `%2F` and `/`) keeps its second form local and uploads again on the next save; map every alias if seen.
    for (const [upload, local] of replaced) {
      kept = kept.split(local).join(upload);
      typed = typed.split(local).join(upload);
      // A pasted image uploaded to Linear keeps showing its local copy instead of loading again.
      if (linearImages.has(upload)) continue;
      const seeded = Promise.resolve(local);
      cacheLinearImage(upload, seeded);
      // The pasted file may be deleted with its issue: later widgets get a copy of it, else Linear's.
      void fetch(local)
        .then((response) => (response.ok ? response.blob() : Promise.reject()))
        .then(
          (blob) => {
            if (linearImages.get(upload) === seeded)
              linearImages.set(
                upload,
                Promise.resolve(URL.createObjectURL(blob)),
              );
          },
          () => {
            if (linearImages.get(upload) === seeded)
              linearImages.delete(upload);
          },
        );
    }
    savedRef.current = kept;
    echoRef.current = { sent: kept, stored: next };
    draftRef.current = typed;
    setDraft(typed);
  }, [description, draft]);

  return (
    <div
      className="kanban-issue-description"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) void flush();
      }}
    >
      <MarkdownEditor
        ariaLabel={t("kanban.issue.description")}
        content={draft}
        documentId={issueId}
        formatImageError={formatError}
        inline
        mode="preview"
        onContentChange={(text) => {
          draftRef.current = text;
          setDraft(text);
        }}
        placeholder={t("kanban.issue.descriptionPlaceholder")}
        resolveImageUrl={resolveLinearImage}
        uploadImage={uploadKanbanImage}
      />
    </div>
  );
}
