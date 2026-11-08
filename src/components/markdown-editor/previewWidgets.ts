import { EditorView, WidgetType } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { isImeComposing } from "../../domain/keyboard";
import { safeImageUrl } from "./urls";
import { bindImageResize, stopImageResize } from "./imageResize";

export class BulletWidget extends WidgetType {
  constructor(readonly marker: string) {
    super();
  }
  eq(other: WidgetType) {
    return other instanceof BulletWidget && other.marker === this.marker;
  }
  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "cm-md-bullet";
    bullet.textContent = this.marker;
    return bullet;
  }
}

export class TaskWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly checked: boolean,
    readonly label: string,
    readonly readOnly = false,
  ) {
    super();
  }
  eq(other: TaskWidget) {
    return (
      this.from === other.from &&
      this.checked === other.checked &&
      this.label === other.label &&
      this.readOnly === other.readOnly
    );
  }
  toDOM(view: EditorView) {
    const checkbox = document.createElement("input");
    this.updateDOM(checkbox, view);
    return checkbox;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (!(dom instanceof HTMLInputElement)) return false;
    const checkbox = dom;
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.disabled = view.state.readOnly;
    checkbox.className = "cm-md-task";
    checkbox.setAttribute("aria-label", this.label);
    checkbox.onmousedown = (event) => event.preventDefault();
    checkbox.onchange = () => {
      if (
        view.state.readOnly ||
        !/^\[[ xX]\]$/u.test(
          view.state.doc.sliceString(this.from, this.from + 3),
        )
      )
        return;
      view.dispatch({
        changes: {
          from: this.from + 1,
          to: this.from + 2,
          insert: checkbox.checked ? "x" : " ",
        },
        annotations: isolateHistory.of("full"),
      });
    };
    return true;
  }
}

/** Display URL for an image the webview cannot load as is; null leaves it to the webview. */
export type ImageResolver = (url: string) => Promise<string> | null;

export class ImageWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly selected: boolean,
    // A cursor touching the image line, drawn since the webview cannot place a caret there.
    readonly gap: "before" | "after" | null,
    readonly url: string,
    readonly alt: string,
    readonly label: string,
    readonly errorLabel: string,
    readonly onError: (error: string) => void,
    readonly openImage: (src: string, alt: string) => void,
    readonly sizing: {
      imageTo: number;
      width: number | undefined;
      label: string;
      readOnly: boolean;
    },
    readonly resolveImage?: ImageResolver,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      this.from === other.from &&
      this.to === other.to &&
      this.selected === other.selected &&
      this.gap === other.gap &&
      this.url === other.url &&
      this.alt === other.alt &&
      this.label === other.label &&
      this.errorLabel === other.errorLabel &&
      this.onError === other.onError &&
      this.openImage === other.openImage &&
      this.sizing.imageTo === other.sizing.imageTo &&
      this.sizing.width === other.sizing.width &&
      this.sizing.label === other.sizing.label &&
      this.sizing.readOnly === other.sizing.readOnly &&
      this.resolveImage === other.resolveImage
    );
  }
  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    const surface = document.createElement("div");
    surface.className = "cm-md-image-select";
    wrapper.append(surface);
    wrapper.dataset.url = this.url;
    wrapper.dataset.alt = this.alt;
    const resolved = this.resolveImage?.(this.url);
    const src = resolved ? null : safeImageUrl(this.url);
    if (!resolved && !src) {
      surface.textContent = this.alt || this.url;
      this.onError(this.errorLabel);
    } else {
      const image = document.createElement("img");
      if (src) image.src = src;
      else {
        // Without a source yet, WebKit draws the image as broken.
        image.style.display = "none";
        void resolved?.then(
          (url) => {
            image.src = url;
            image.style.display = "";
          },
          () => image.dispatchEvent(new Event("error")),
        );
      }
      image.alt = this.alt;
      image.loading = "lazy";
      image.draggable = false;
      surface.append(image);
    }
    this.bindDOM(wrapper, view);
    return wrapper;
  }
  // Failed placeholders are kept too, so unrelated edits don't report the failure again.
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (dom.dataset.url !== this.url || dom.dataset.alt !== this.alt)
      return false;
    this.bindDOM(dom, view);
    return true;
  }
  private bindDOM(wrapper: HTMLElement, view: EditorView) {
    wrapper.className = `cm-md-widget cm-md-image${this.selected ? " cm-md-image-selected" : ""}${this.gap ? ` cm-md-image-gap-${this.gap}` : ""}`;
    wrapper.setAttribute("role", "group");
    const surface = wrapper.querySelector<HTMLElement>(".cm-md-image-select")!;
    surface.tabIndex = 0;
    surface.setAttribute("role", "button");
    surface.setAttribute(
      "aria-label",
      this.alt ? `${this.label}: ${this.alt}` : this.label,
    );
    surface.setAttribute("aria-pressed", String(this.selected));
    const select = () => {
      view.dispatch({
        selection: { anchor: this.from, head: this.to },
        scrollIntoView: true,
      });
      view.focus();
    };
    wrapper.onmousedown = (event) => event.preventDefault();
    wrapper.onclick = select;
    surface.onkeydown = (event) => {
      if (isImeComposing(event)) return;
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        // Read-only content can't take focus, so a second press must open from here.
        // shortcut: a wider selection that covers the image (Ctrl+A then Tab here) opens instead of narrowing to it; require an exact selection if reported.
        const shown = wrapper.querySelector("img");
        if (this.selected && shown?.src) this.openImage(shown.src, shown.alt);
        else select();
      }
    };
    const image = wrapper.querySelector("img");
    wrapper.ondblclick = (event) => {
      const shown = wrapper.querySelector("img");
      if (
        shown?.src &&
        !(event.target as Element).closest(".cm-md-image-resize")
      )
        this.openImage(shown.src, shown.alt);
    };
    if (image) {
      bindImageResize(wrapper, view, {
        from: this.from,
        to: this.to,
        ...this.sizing,
        selected: this.selected,
      });
      image.onerror = () => {
        stopImageResize(wrapper);
        image.remove();
        surface.textContent = this.alt;
        wrapper.querySelector(".cm-md-image-resize")?.remove();
        this.onError(this.errorLabel);
      };
    }
  }
  destroy(dom: HTMLElement) {
    stopImageResize(dom);
    const image = dom.querySelector("img");
    if (image) image.onerror = null;
  }
}
