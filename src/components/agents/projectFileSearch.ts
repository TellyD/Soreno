import { getSearchQuery, type SearchQuery } from "@codemirror/search";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";

type SearchMatch = { from: number; to: number };

// Counting and navigation share these non-overlapping full-document matches so they always agree.
function* searchMatches(
  state: EditorState,
  query: SearchQuery,
): Generator<SearchMatch> {
  if (!query.valid) return;
  const cursor = query.getCursor(state);
  for (let match = cursor.next(); !match.done; match = cursor.next())
    yield match.value;
}

export function searchMatchPosition(
  state: EditorState,
  query: SearchQuery,
): { current: number; total: number } {
  const { from, to } = state.selection.main;
  let current = 0;
  let total = 0;
  for (const match of searchMatches(state, query)) {
    total++;
    if (match.from === from && match.to === to) current = total;
  }
  return { current, total };
}

// Typing keeps the current match while it still matches, else jumps forward and wraps.
export function nearestSearchMatch(
  state: EditorState,
  query: SearchQuery,
): SearchMatch | null {
  const start = state.selection.main.from;
  let first: SearchMatch | null = null;
  for (const match of searchMatches(state, query)) {
    if (match.from >= start) return match;
    first ??= match;
  }
  return first;
}

function selectSearchMatch(view: EditorView, match: SearchMatch | null) {
  if (!match) return false;
  view.dispatch({
    selection: EditorSelection.single(match.from, match.to),
    effects: EditorView.scrollIntoView(
      EditorSelection.range(match.from, match.to),
      { y: "center" },
    ),
    userEvent: "select.search",
  });
  return true;
}

export const findNextMatch: Command = (view) => {
  const { from, to } = view.state.selection.main;
  let first: SearchMatch | null = null;
  for (const match of searchMatches(view.state, getSearchQuery(view.state))) {
    if (match.from >= to && (match.from !== from || match.to !== to))
      return selectSearchMatch(view, match);
    first ??= match;
  }
  return selectSearchMatch(view, first);
};

export const findPreviousMatch: Command = (view) => {
  const { from, to } = view.state.selection.main;
  let before: SearchMatch | null = null;
  let last: SearchMatch | null = null;
  for (const match of searchMatches(view.state, getSearchQuery(view.state))) {
    if (match.to <= from && (match.from !== from || match.to !== to))
      before = match;
    last = match;
  }
  return selectSearchMatch(view, before ?? last);
};
