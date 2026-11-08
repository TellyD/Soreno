import { History, LoaderCircle, MessagesSquare, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { readAgentConversationHistory } from "../../data/agentConversationApi";
import type { AgentConversationHistoryEntry } from "../../domain/agentConversation";
import { formatCompactDate, formatShortDateTime } from "../../domain/dateTime";
import { errorMessage } from "../../domain/errors";
import { isImeComposing, listNavigation } from "../../domain/keyboard";
import { useI18n } from "../../i18n";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import type { AgentStrings } from "./agentStrings";
// Same layout as the file picker: a search field above a list of options.
import "./QuickOpenDialog.css";

type Strings = AgentStrings["conversation"];

const PAGE_SIZE = 20;

/** Lists the project's earlier OMP conversations; choosing one hands its path to `onSelect`. */
export function AgentConversationResumeDialog({
  sessionId,
  onClose,
  onSelect,
  s,
}: {
  sessionId: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  s: Strings;
}) {
  const { locale } = useI18n();
  const listId = useId();
  const [history, setHistory] = useState<{
    entries: AgentConversationHistoryEntry[];
    more: boolean;
    /** Files the backend already read: entries skip those without a session header. */
    next: number;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const surfaceRef = useDismissibleLayer<HTMLElement>(true, onClose);

  useEffect(() => {
    let active = true;
    readAgentConversationHistory(sessionId, 0, PAGE_SIZE).then(
      (page) => active && setHistory({ ...page, next: PAGE_SIZE }),
      (reason: unknown) => active && setError(errorMessage(reason)),
    );
    return () => {
      active = false;
    };
  }, [sessionId]);

  const entries = history?.entries;
  const needle = query.trim().toLocaleLowerCase(locale);
  const shown = (entries ?? []).filter((entry) =>
    (entry.title ?? s.resumeUntitled)
      .toLocaleLowerCase(locale)
      .includes(needle),
  );
  // The option after the shown entries loads the next page.
  const optionCount = shown.length + (history?.more ? 1 : 0);
  const loadIndex = history?.more ? shown.length : -1;

  useEffect(() => {
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  function loadMore() {
    if (!history?.more || loadingMore) return;
    setLoadingMore(true);
    readAgentConversationHistory(sessionId, history.next, PAGE_SIZE)
      .then(
        (page) =>
          setHistory((previous) => {
            if (!previous) return previous;
            // A conversation written meanwhile shifts the order: never list one twice.
            const known = new Set(previous.entries.map((entry) => entry.path));
            return {
              entries: [
                ...previous.entries,
                ...page.entries.filter((entry) => !known.has(entry.path)),
              ],
              more: page.more,
              next: previous.next + PAGE_SIZE,
            };
          }),
        (reason: unknown) => setError(errorMessage(reason)),
      )
      .finally(() => setLoadingMore(false));
  }

  // shortcut: after a failed next page the error replaces the list, yet Enter can still pick a loaded entry; lock selection like QuickOpenDialog if this bothers.
  function choose(index: number) {
    if (index === loadIndex) return loadMore();
    const entry = shown[index];
    if (!entry) return;
    onClose();
    if (!entry.current) onSelect(entry.path);
  }

  return (
    <DialogOverlay className="quick-open-overlay">
      <DialogSurface
        aria-label={s.resumeTitle}
        className="quick-open-dialog"
        ref={surfaceRef}
      >
        <Input
          autoComplete="off"
          aria-activedescendant={
            activeIndex < optionCount
              ? `${listId}-option-${activeIndex}`
              : undefined
          }
          aria-autocomplete="list"
          aria-controls={optionCount > 0 ? listId : undefined}
          aria-expanded={optionCount > 0}
          autoFocus
          className="quick-open-input"
          placeholder={s.resumeSearch}
          role="combobox"
          spellCheck={false}
          startIcon={<Search aria-hidden="true" />}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) {
              event.stopPropagation();
              return;
            }
            const move = listNavigation(event.key, optionCount);
            if (move) {
              event.preventDefault();
              setActiveIndex(move);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(activeIndex);
            }
          }}
        />
        <div className="quick-open-results">
          {error ? (
            <p className="quick-open-status" role="alert">
              {error}
            </p>
          ) : !entries ? (
            <p className="quick-open-status" role="status">
              <LoaderCircle
                className="app-loading-spinner"
                size={14}
                aria-hidden="true"
              />
              {s.resumeLoading}
            </p>
          ) : shown.length === 0 && !history.more ? (
            <p className="quick-open-status">
              {entries.length === 0 ? s.resumeEmpty : s.resumeNoMatch}
            </p>
          ) : (
            <ul id={listId} className="quick-open-list" role="listbox">
              {shown.map((entry, index) => {
                const modified = new Date(entry.modified).toISOString();
                return (
                  <li
                    aria-selected={index === activeIndex}
                    className="quick-open-option"
                    id={`${listId}-option-${index}`}
                    key={entry.path}
                    role="option"
                    title={formatShortDateTime(modified, locale)}
                    onClick={() => choose(index)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <MessagesSquare size={14} aria-hidden="true" />
                    <strong>{entry.title ?? s.resumeUntitled}</strong>
                    <span className="quick-open-date">
                      {formatCompactDate(modified, locale)?.value}
                    </span>
                    {entry.current ? (
                      <span className="quick-open-recent">
                        {s.resumeCurrent}
                      </span>
                    ) : null}
                  </li>
                );
              })}
              {history.more ? (
                <li
                  aria-busy={loadingMore}
                  aria-selected={loadIndex === activeIndex}
                  className="quick-open-option"
                  id={`${listId}-option-${loadIndex}`}
                  role="option"
                  onClick={() => choose(loadIndex)}
                  onMouseEnter={() => setActiveIndex(loadIndex)}
                >
                  {loadingMore ? (
                    <LoaderCircle
                      className="app-loading-spinner"
                      size={14}
                      aria-hidden="true"
                    />
                  ) : (
                    <History size={14} aria-hidden="true" />
                  )}
                  <span>{loadingMore ? s.resumeLoading : s.resumeMore}</span>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </DialogSurface>
    </DialogOverlay>
  );
}
