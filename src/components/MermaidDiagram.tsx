import { LoaderCircle } from "lucide-react";
import { renderAsync } from "pele/lazy";
import { useEffect, useRef, useState, type PointerEvent } from "react";

// Streamed text changes the code at every delta: draw it once it stops changing.
const SETTLE_MS = 300;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * A ```mermaid block drawn by Pele; its source shows until then, or if it does not parse.
 * Diagrams come from agents: Pele escapes their text and drops scripts, so with links and images off its SVG goes in the page.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const [diagram, setDiagram] = useState<{
    code: string;
    svg: string | null;
  }>();
  // A complete block (history, a file) draws at once; only streamed changes wait to settle.
  const changed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(
      async () => {
        let svg: string | null = null;
        try {
          ({ svg } = await renderAsync(code, {
            fontFamily: FONT,
            fontSize: 14,
            // Natural size and direction: a wide diagram scrolls instead of shrinking or turning.
            responsive: false,
            autoDirection: false,
            links: false,
            images: false,
          }));
        } catch {
          // Not a diagram Pele can draw: the source stays.
        }
        if (!cancelled) setDiagram({ code, svg });
      },
      changed.current ? SETTLE_MS : 0,
    );
    changed.current = true;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code]);

  const pan = useRef<{ x: number; left: number } | null>(null);
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    pan.current = null;
    event.currentTarget.removeAttribute("data-panning");
  };

  const drawn = diagram?.code === code ? diagram.svg : undefined;
  if (drawn)
    return (
      // Wide diagrams scroll instead of shrinking their text: drag with the mouse, or the keyboard once focused.
      <div
        className="markdown-diagram"
        role="img"
        aria-label={code}
        tabIndex={0}
        onPointerEnter={(event) => {
          const element = event.currentTarget;
          element.toggleAttribute(
            "data-pannable",
            element.scrollWidth > element.clientWidth,
          );
        }}
        onPointerDown={(event) => {
          const element = event.currentTarget;
          // Touch already pans natively.
          if (
            event.pointerType !== "mouse" ||
            event.button !== 0 ||
            !element.hasAttribute("data-pannable")
          )
            return;
          event.preventDefault();
          element.setPointerCapture(event.pointerId);
          pan.current = { x: event.clientX, left: element.scrollLeft };
          element.setAttribute("data-panning", "");
        }}
        onPointerMove={(event) => {
          if (!pan.current) return;
          // The button can be released while the source showed in place of the diagram.
          if ((event.buttons & 1) === 0) return endPan(event);
          event.currentTarget.scrollLeft =
            pan.current.left - (event.clientX - pan.current.x);
        }}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        dangerouslySetInnerHTML={{ __html: drawn }}
      />
    );
  // `undefined`: still drawing; `null`: Pele refused it, the source is all there is.
  return (
    <div className="markdown-diagram-source" aria-busy={drawn === undefined}>
      <pre>
        <code>{code}</code>
      </pre>
      {drawn === undefined ? (
        <LoaderCircle
          className="app-loading-spinner"
          size={14}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
