import { SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  findNextMatch,
  findPreviousMatch,
  nearestSearchMatch,
  searchMatchPosition,
} from "./projectFileSearch";

function editor(
  doc: string,
  query: ConstructorParameters<typeof SearchQuery>[0],
  anchor = 0,
  head = anchor,
) {
  let state = EditorState.create({
    doc,
    extensions: search(),
    selection: EditorSelection.single(anchor, head),
  });
  state = state.update({
    effects: setSearchQuery.of(new SearchQuery(query)),
  }).state;
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const selection = () => [state.selection.main.from, state.selection.main.to];
  return { view, selection };
}

describe("nearestSearchMatch", () => {
  it.each([
    [
      "the only occurrence around the cursor",
      "foobar",
      { search: "foobar" },
      3,
      [0, 6],
    ],
    [
      "the next occurrence after the cursor",
      "ab ab ab",
      { search: "ab" },
      1,
      [3, 5],
    ],
    ["a wrap to the first occurrence", "ab ab", { search: "ab" }, 4, [0, 2]],
    [
      "a whole word, not a word suffix",
      "foobar bar",
      { search: "bar", wholeWord: true },
      3,
      [7, 10],
    ],
  ])("selects %s", (_, doc, query, cursor, expected) => {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
    });
    expect(nearestSearchMatch(state, new SearchQuery(query))).toMatchObject({
      from: expected[0],
      to: expected[1],
    });
  });

  it("finds nothing for an invalid regex", () => {
    const state = EditorState.create({ doc: "a(" });
    expect(
      nearestSearchMatch(state, new SearchQuery({ search: "(", regexp: true })),
    ).toBeNull();
  });
});

describe("findNextMatch / findPreviousMatch", () => {
  it("walks zero-length regex matches and wraps", () => {
    const { view, selection } = editor("alpha\nbeta", {
      search: "^",
      regexp: true,
    });
    expect(findNextMatch(view)).toBe(true);
    expect(selection()).toEqual([6, 6]);
    findNextMatch(view);
    expect(selection()).toEqual([0, 0]);
    findPreviousMatch(view);
    expect(selection()).toEqual([6, 6]);
    findPreviousMatch(view);
    expect(selection()).toEqual([0, 0]);
  });

  it("stays on the matches the counter knows", () => {
    const { view, selection } = editor("bananana", { search: "ana" }, 5, 8);
    findPreviousMatch(view);
    expect(selection()).toEqual([1, 4]);
    expect(
      searchMatchPosition(view.state, new SearchQuery({ search: "ana" })),
    ).toEqual({ current: 1, total: 2 });
    findNextMatch(view);
    expect(selection()).toEqual([5, 8]);
    findPreviousMatch(view);
    findPreviousMatch(view);
    expect(selection()).toEqual([5, 8]);
  });

  it("does nothing without a usable query or match", () => {
    expect(findNextMatch(editor("abc", { search: "" }).view)).toBe(false);
    expect(findPreviousMatch(editor("abc", { search: "z" }).view)).toBe(false);
  });
});
