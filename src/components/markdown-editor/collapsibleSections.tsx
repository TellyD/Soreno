import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { ChevronRight } from "lucide-react";
import { createRoot, type Root } from "react-dom/client";

// Linear's collapsible sections: a `+++ Title` line, the content, then a `+++` line.
type Section = {
  from: number;
  titleFrom: number;
  to: number;
  closeFrom: number;
  end: number;
};

const opening = /^\+\+\+[ \t]+(?=\S)/u;
const closing = /^\+\+\+[ \t]*$/u;

// shortcut: `+++` lines inside fenced code still form sections; check the syntax tree if notes hit it.
// shortcut: a table right above the closing `+++` (no blank line) swallows it as a row and renders past the fold; split tables at section bounds if agents write that.
function findSections(doc: Text): Section[] {
  const sections: Section[] = [];
  let open: Pick<Section, "from" | "titleFrom" | "to"> | null = null;
  let from = 0;
  for (const text of doc.iterLines()) {
    const to = from + text.length;
    const marker = opening.exec(text);
    if (marker) open = { from, titleFrom: from + marker[0].length, to };
    else if (open && closing.test(text)) {
      sections.push({ ...open, closeFrom: from, end: to });
      open = null;
    }
    from = to + 1;
  }
  return sections;
}

const toggleSection = StateEffect.define<number>();
const roots = new WeakMap<HTMLElement, Root>();
const hides = (section: Section, at: number) =>
  at > section.to && at <= section.end;

// A cursor in hidden content (undo, a closing line, the source mode) opens its section.
function openAtSelection(
  state: EditorState,
  sections: Section[],
  expanded: number[],
) {
  const opened = sections.filter(
    (section) =>
      !expanded.includes(section.from) &&
      state.selection.ranges.some((range) => hides(section, range.head)),
  );
  return opened.length
    ? [...expanded, ...opened.map((section) => section.from)]
    : expanded;
}

export class SectionToggleWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly expanded: boolean,
    readonly label: string,
  ) {
    super();
  }
  eq(other: SectionToggleWidget) {
    return (
      this.from === other.from &&
      this.expanded === other.expanded &&
      this.label === other.label
    );
  }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    const root = createRoot(button);
    root.render(<ChevronRight aria-hidden="true" />);
    roots.set(button, root);
    this.updateDOM(button, view);
    return button;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (!(dom instanceof HTMLButtonElement)) return false;
    dom.type = "button";
    dom.className = "cm-md-section-toggle";
    dom.setAttribute("aria-label", this.label);
    dom.setAttribute("aria-expanded", String(this.expanded));
    dom.onmousedown = (event) => event.preventDefault();
    dom.onclick = () => {
      const { state } = view;
      const section = findSections(state.doc).find(
        (section) => section.from === this.from,
      );
      // Collapsing pulls cursors out of the content, or an atomic Backspace would delete it.
      const clamp = (at: number) =>
        this.expanded && section && hides(section, at) ? section.to : at;
      view.dispatch({
        effects: toggleSection.of(this.from),
        selection: EditorSelection.create(
          state.selection.ranges.map((range) =>
            EditorSelection.range(clamp(range.anchor), clamp(range.head)),
          ),
          state.selection.mainIndex,
        ),
      });
    };
    return true;
  }
  destroy(dom: HTMLElement) {
    const root = roots.get(dom);
    roots.delete(dom);
    if (root) queueMicrotask(() => root.unmount());
  }
}

type SectionState = {
  sections: Section[];
  // Opening line starts; sections start collapsed, as on Linear.
  expanded: number[];
  decorations: DecorationSet;
};

function sectionDecorations(
  state: EditorState,
  sections: Section[],
  expanded: number[],
  label: string,
) {
  const ranges: Range<Decoration>[] = [];
  for (const section of sections) {
    const open = expanded.includes(section.from);
    ranges.push(
      Decoration.replace({
        widget: new SectionToggleWidget(section.from, open, label),
      }).range(section.from, section.titleFrom),
    );
    if (!open)
      ranges.push(
        Decoration.replace({ block: true }).range(section.to, section.end),
      );
    // The closing `+++` stays visible while the cursor is on it, so it can be edited.
    else if (
      !state.selection.ranges.some(
        (range) => range.from <= section.end && range.to >= section.closeFrom,
      )
    )
      ranges.push(
        Decoration.replace({ block: true }).range(
          section.closeFrom - 1,
          section.end,
        ),
      );
  }
  return Decoration.set(ranges, true);
}

export function collapsibleSections(label: string) {
  return StateField.define<SectionState>({
    create(state) {
      const sections = findSections(state.doc);
      const expanded = openAtSelection(state, sections, []);
      return {
        sections,
        expanded,
        decorations: sectionDecorations(state, sections, expanded, label),
      };
    },
    update(value, tr) {
      const toggles = tr.effects.filter((effect) => effect.is(toggleSection));
      if (!tr.docChanged && !tr.selection && !toggles.length) return value;
      let { sections, expanded } = value;
      if (tr.docChanged) {
        sections = findSections(tr.state.doc);
        let replaced = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          replaced ||= fromA === 0 && toA === tr.startState.doc.length;
        });
        // A replaced document, e.g. an outside update, collapses everything again.
        expanded = replaced
          ? []
          : expanded.map((at) => tr.changes.mapPos(at, 1));
      }
      for (const toggle of toggles)
        expanded = expanded.includes(toggle.value)
          ? expanded.filter((at) => at !== toggle.value)
          : [...expanded, toggle.value];
      const starts = new Set(sections.map((section) => section.from));
      expanded = expanded.filter((at) => starts.has(at));
      if (tr.docChanged || tr.selection)
        expanded = openAtSelection(tr.state, sections, expanded);
      return {
        sections,
        expanded,
        decorations: sectionDecorations(tr.state, sections, expanded, label),
      };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
      // Delete next to a fold would extend over its atomic range; open it instead of erasing hidden text.
      EditorState.transactionFilter.of((tr) => {
        if (
          !tr.isUserEvent("delete") ||
          tr.startState.selection.ranges.some((range) => !range.empty)
        )
          return tr;
        const { sections, expanded } = tr.startState.field(field);
        const touched = sections.filter(
          (section) =>
            !expanded.includes(section.from) &&
            section.to + 1 <= section.end - 1 &&
            tr.changes.touchesRange(section.to + 1, section.end - 1),
        );
        return touched.length
          ? {
              effects: touched.map((section) => toggleSection.of(section.from)),
            }
          : tr;
      }),
    ],
  });
}
