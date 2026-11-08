import { WidgetType } from "@codemirror/view";
import { Check, Copy } from "lucide-react";
import { createRoot } from "react-dom/client";
import { IconButton } from "../ui/IconButton";
import { writeClipboardText } from "../../data/clipboard";

export type CodeCopyLabels = {
  copyCode: string;
  codeCopied: string;
  copyCodeError: string;
  onError: (message: string) => void;
};

const disposers = new WeakMap<HTMLElement, () => void>();

export class CodeCopyWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly labels: CodeCopyLabels,
  ) {
    super();
  }

  eq(other: CodeCopyWidget) {
    return (
      this.text === other.text &&
      this.labels.copyCode === other.labels.copyCode &&
      this.labels.codeCopied === other.labels.codeCopied &&
      this.labels.copyCodeError === other.labels.copyCodeError &&
      this.labels.onError === other.labels.onError
    );
  }

  toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-md-code-copy";
    dom.contentEditable = "false";
    const root = createRoot(dom);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { text, labels } = this;

    const copy = async () => {
      if (disposed) return;
      try {
        await writeClipboardText(text);
      } catch {
        if (!disposed) labels.onError(labels.copyCodeError);
        return;
      }
      if (disposed) return;
      clearTimeout(timer);
      render(true);
      timer = setTimeout(() => {
        if (!disposed) render(false);
      }, 1500);
    };

    const render = (copied: boolean) => {
      const label = copied ? labels.codeCopied : labels.copyCode;
      root.render(
        <>
          <IconButton
            size="small"
            aria-label={label}
            title={label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={copy}
          >
            {copied ? (
              <Check aria-hidden="true" className="app-icon-button-feedback" />
            ) : (
              <Copy aria-hidden="true" />
            )}
          </IconButton>
          <span className="cm-md-code-copy-status" role="status">
            {copied ? labels.codeCopied : ""}
          </span>
        </>,
      );
    };

    disposers.set(dom, () => {
      disposed = true;
      clearTimeout(timer);
      queueMicrotask(() => root.unmount());
    });
    render(false);
    return dom;
  }

  destroy(dom: HTMLElement) {
    disposers.get(dom)?.();
    disposers.delete(dom);
  }
}
