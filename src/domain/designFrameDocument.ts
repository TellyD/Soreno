/** Design frames: agent-written HTML shown in a sandboxed frame alongside Soreno's picker. */
import type { AppTheme } from "./theme";

const OUTER_HTML_LIMIT = 2048;

export type DesignFrameMode = "canvas" | "target" | "interact";

/**
 * The frame's document: `html` under a policy that runs `picker` (a served file) and, when
 * `scripts` is true, inline prototype scripts — nothing loads, no network or form navigation runs.
 */
export function designFrameDocument(
  html: string,
  picker: string,
  theme: AppTheme,
  scripts = false,
) {
  // Agent-written: nothing loads, no form submits out, and ingestion already refuses <meta http-equiv>.
  const scriptSrc = scripts ? `${picker} 'unsafe-inline'` : picker;
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'"><base target="_blank"><script src="${picker}" data-theme="${theme}"></script>`;
  // The doctype stays first, or the frame would render in quirks mode.
  return `<!doctype html>${policy}${html.replace(/^\s*<!doctype[^>]*>/i, "")}`;
}

type DesignFramePick =
  | {
      type: "pick";
      /** Null for the whole frame. */
      target: { selector: string; outerHTML: string } | null;
    }
  /** `x`, `y` in the page's coordinates. */
  | { type: "zoom"; deltaY: number; x: number; y: number }
  | { type: "escape" };

/** What a frame's picker reports; anything else is ignored. */
export function designFramePick(data: unknown): DesignFramePick | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type === "soreno-frame-escape") return { type: "escape" };
  if (message.type === "soreno-frame-zoom") {
    const { deltaY, x, y } = message;
    return [deltaY, x, y].every(Number.isFinite)
      ? ({ type: "zoom", deltaY, x, y } as DesignFramePick)
      : null;
  }
  if (message.type !== "soreno-frame-pick") return null;
  const { path, html } = message;
  const selector = typeof path === "string" ? path.slice(0, 500) : "";
  return {
    type: "pick",
    target: selector
      ? {
          selector,
          outerHTML:
            typeof html === "string" ? html.slice(0, OUTER_HTML_LIMIT) : "",
        }
      : null,
  };
}
