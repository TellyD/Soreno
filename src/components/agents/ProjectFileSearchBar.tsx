import {
  closeSearchPanel,
  getSearchQuery,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  Regex,
  Search,
  WholeWord,
  X,
} from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { isImeComposing } from "../../domain/keyboard";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { useGitStrings } from "./gitStrings";
import {
  findNextMatch,
  findPreviousMatch,
  nearestSearchMatch,
  searchMatchPosition,
} from "./projectFileSearch";

type QueryOption = "caseSensitive" | "wholeWord" | "regexp";

const optionShortcuts: Record<string, QueryOption> = {
  KeyC: "caseSensitive",
  KeyW: "wholeWord",
  KeyR: "regexp",
};

export function ProjectFileSearchBar({
  state,
  view,
}: {
  state: EditorState;
  view: EditorView;
}) {
  const s = useGitStrings();
  const inputRef = useRef<HTMLInputElement>(null);
  const ownQuery = useRef<SearchQuery | null>(null);
  const statusId = useId();
  const query = getSearchQuery(state);
  const position = useMemo(() => searchMatchPosition(state, query), [state]);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Ctrl/Cmd+F selects the field before React writes the new prefill, which moves the caret to the end.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (
      input &&
      query !== ownQuery.current &&
      input === input.ownerDocument.activeElement
    )
      input.select();
  }, [query]);

  function updateQuery(
    changes: Partial<Pick<SearchQuery, "search" | QueryOption>>,
  ) {
    const next = new SearchQuery({
      search: query.search,
      caseSensitive: query.caseSensitive,
      literal: query.literal,
      regexp: query.regexp,
      wholeWord: query.wholeWord,
      ...changes,
    });
    ownQuery.current = next;
    const match = nearestSearchMatch(view.state, next);
    view.dispatch(
      match
        ? {
            selection: EditorSelection.single(match.from, match.to),
            effects: [
              setSearchQuery.of(next),
              EditorView.scrollIntoView(
                EditorSelection.range(match.from, match.to),
                { y: "center" },
              ),
            ],
            userEvent: "select.search",
          }
        : { effects: setSearchQuery.of(next) },
    );
  }

  const toggles: [QueryOption, string, ReactNode][] = [
    [
      "caseSensitive",
      s.projectSearchCaseSensitive,
      <CaseSensitive aria-hidden="true" />,
    ],
    ["wholeWord", s.projectSearchWholeWord, <WholeWord aria-hidden="true" />],
    ["regexp", s.projectSearchRegex, <Regex aria-hidden="true" />],
  ];
  const status = !query.search
    ? null
    : !query.valid
      ? s.fileSearchInvalidRegex
      : position.total === 0
        ? s.fileSearchNoResults
        : position.current
          ? s.fileSearchPosition(position.current, position.total)
          : s.projectSearchLineCount(position.total);

  return (
    <>
      <Input
        aria-describedby={statusId}
        aria-invalid={!!query.search && !query.valid}
        aria-label={s.fileSearch}
        autoComplete="off"
        className="project-file-search-input"
        main-field="true"
        placeholder={s.fileSearch}
        ref={inputRef}
        size="small"
        spellCheck={false}
        startIcon={<Search aria-hidden="true" />}
        value={query.search}
        onChange={(event) => updateQuery({ search: event.currentTarget.value })}
        onKeyDown={(event) => {
          // Panel-wide shortcuts run from the panel keydown listener in ProjectCodeEditor.
          if (event.defaultPrevented || isImeComposing(event.nativeEvent))
            return;
          const option = optionShortcuts[event.nativeEvent.code];
          if (
            option &&
            event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
          ) {
            event.preventDefault();
            updateQuery({ [option]: !query[option] });
          } else if (event.key === "Enter") {
            event.preventDefault();
            (event.shiftKey ? findPreviousMatch : findNextMatch)(view);
          }
        }}
      />
      {toggles.map(([option, label, icon]) => (
        <IconButton
          aria-label={label}
          aria-pressed={query[option]}
          key={option}
          selected={query[option]}
          size="small"
          title={label}
          onClick={() => updateQuery({ [option]: !query[option] })}
          onMouseDown={(event) => event.preventDefault()}
        >
          {icon}
        </IconButton>
      ))}
      <span className="project-file-search-status" id={statusId} role="status">
        {status}
      </span>
      <IconButton
        aria-label={s.fileSearchPrevious}
        disabled={position.total === 0}
        size="small"
        title={s.fileSearchPrevious}
        onClick={() => findPreviousMatch(view)}
        onMouseDown={(event) => event.preventDefault()}
      >
        <ArrowUp aria-hidden="true" />
      </IconButton>
      <IconButton
        aria-label={s.fileSearchNext}
        disabled={position.total === 0}
        size="small"
        title={s.fileSearchNext}
        onClick={() => findNextMatch(view)}
        onMouseDown={(event) => event.preventDefault()}
      >
        <ArrowDown aria-hidden="true" />
      </IconButton>
      <IconButton
        aria-label={s.fileSearchClose}
        size="small"
        title={s.fileSearchClose}
        onClick={() => closeSearchPanel(view)}
        onMouseDown={(event) => event.preventDefault()}
      >
        <X aria-hidden="true" />
      </IconButton>
    </>
  );
}
