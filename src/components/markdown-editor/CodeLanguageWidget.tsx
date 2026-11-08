import { EditorView, WidgetType } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { createRoot, type Root } from "react-dom/client";
import { Select } from "../ui/Select";
import { codeLanguage, codeLanguageOptions } from "./codeLanguages";

export type CodeLanguageLabels = { codeLanguage: string; plainText: string };
const roots = new WeakMap<HTMLElement, Root>();

export class CodeLanguageWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly info: string,
    readonly labels: CodeLanguageLabels,
    readonly readOnly: boolean,
    readonly doc: Text,
  ) {
    super();
  }

  eq(other: CodeLanguageWidget) {
    return (
      this.from === other.from &&
      this.to === other.to &&
      this.info === other.info &&
      this.labels.codeLanguage === other.labels.codeLanguage &&
      this.labels.plainText === other.labels.plainText &&
      this.readOnly === other.readOnly &&
      this.doc === other.doc
    );
  }

  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-md-code-language";
    dom.contentEditable = "false";
    roots.set(dom, createRoot(dom));
    this.updateDOM(dom, view);
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    const root = roots.get(dom);
    if (!root) return false;
    const language = codeLanguage(this.info);
    const known = codeLanguageOptions.find(
      (option) => option.label === language?.name,
    );
    const value = known?.value ?? (this.info || "text");
    const options = [
      { value: "text", label: this.labels.plainText },
      ...codeLanguageOptions,
    ];
    if (!options.some((option) => option.value === value))
      options.push({ value, label: value });
    const doc = view.state.doc;
    root.render(
      <Select
        size="small"
        aria-label={this.labels.codeLanguage}
        title={this.labels.codeLanguage}
        value={value}
        options={options}
        disabled={this.readOnly}
        onValueChange={(next) => {
          // A popup may outlive the source positions it was rendered for.
          if (
            !roots.has(dom) ||
            view.state.readOnly ||
            view.state.doc !== doc ||
            view.state.doc.sliceString(this.from, this.to) !== this.info ||
            (next !== "text" &&
              !codeLanguageOptions.some((option) => option.value === next))
          )
            return;
          if (next === value) return;
          view.dispatch({
            changes: { from: this.from, to: this.to, insert: next },
            annotations: isolateHistory.of("full"),
          });
        }}
      />,
    );
    return true;
  }

  ignoreEvent() {
    return true;
  }

  destroy(dom: HTMLElement) {
    const root = roots.get(dom);
    roots.delete(dom);
    if (root) queueMicrotask(() => root.unmount());
  }
}
