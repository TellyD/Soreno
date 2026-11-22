// Runs in a Design frame alongside optional inline prototype scripts.
// In target mode, outlines the hovered element and reports the clicked one; in interact mode, stays out of the way.
(() => {
  // Captured before prototype scripts run, so they cannot hijack the Escape relay or reports.
  const schedule = globalThis.setTimeout.bind(globalThis);
  const postToParent = parent.postMessage.bind(parent);
  // Defense in depth with Tauri's init script; outside Tauri (dev, tests) this is the only lock.
  for (const name of [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "mozRTCPeerConnection",
  ]) {
    if (name in globalThis && globalThis[name] !== undefined) {
      try {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          writable: false,
          configurable: false,
        });
      } catch {}
    }
  }
  function outline(style) {
    // A custom element under `all: initial`: the frame's styles must not reach it.
    const box = document.createElement("soreno-outline");
    box.style.cssText = `all: initial; position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box; border-radius: 3px; display: none; ${style}`;
    return box;
  }
  const hover = outline("outline: 2px dashed #2f5ec4; outline-offset: -2px");
  const picked = outline(
    "outline: 2px solid #2f5ec4; outline-offset: -2px; background: rgba(47, 94, 196, 0.08)",
  );
  let selected = null;
  let mode = "canvas";
  // Disabled controls dispatch no mouse events; let them fall through to their parent in target mode, then refine.
  // Not bare `:disabled`: a disabled fieldset would pass its legend and labels through too.
  // shortcut: disabled rows of an open listbox (option, optgroup) still swallow clicks; add them here if frames show such lists.
  const disabledControls =
    "button:disabled, input:disabled, select:disabled, textarea:disabled";
  // Soreno's scrollbars in Soreno's theme, the track opaque over a frame that may leave its canvas white;
  // `:where` lets the frame's own rules win.
  const [track, thumb, thumbHover] =
    document.currentScript?.dataset.theme === "dark"
      ? ["#282c34", "rgba(141, 150, 168, 0.36)", "rgba(141, 150, 168, 0.6)"]
      : ["#ffffff", "rgba(138, 141, 133, 0.34)", "rgba(138, 141, 133, 0.56)"];
  const scrollbars = document.createElement("style");
  scrollbars.textContent = `:where(*) { scrollbar-color: ${thumb} ${track}; scrollbar-width: thin; }
:where(*)::-webkit-scrollbar { width: 10px; height: 10px; }
:where(*)::-webkit-scrollbar-track, :where(*)::-webkit-scrollbar-corner { background: ${track}; }
:where(*)::-webkit-scrollbar-thumb { min-height: 42px; border: 2px solid transparent; border-radius: 999px; background-color: ${thumb}; background-clip: padding-box; }
:where(*)::-webkit-scrollbar-thumb:hover { background-color: ${thumbHover}; }`;
  document.documentElement.append(scrollbars);
  const disabledPassThrough = document.createElement("style");
  disabledPassThrough.textContent = `${disabledControls} { pointer-events: none !important; }`;
  // The frame paints its own white page when it sets no background: a backdrop behind the iframe would flash.
  // shortcut: checked once at load, so white hides a root background that only a media query applies after a resize, and a translucent root background shows the canvas through; composite white under the authored background if frames use either.
  document.addEventListener("DOMContentLoaded", () => {
    const bare = (element) => {
      const style = element && getComputedStyle(element);
      return (
        !style ||
        (style.backgroundImage === "none" &&
          style.backgroundColor === "rgba(0, 0, 0, 0)")
      );
    };
    if (bare(document.documentElement) && bare(document.body))
      document.documentElement.style.background = "#ffffff";
  });
  addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    // Runs once dispatch is over, so prototype Escape handlers (even ones added on DOMContentLoaded or later) can cancel it.
    schedule(() => {
      if (mode !== "canvas" && !event.defaultPrevented)
        postToParent({ type: "soreno-frame-escape" }, "*");
    }, 0);
  });

  function bounds(element) {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { left, top, right, bottom };
  }

  function place(box, element) {
    if (!element) {
      box.style.display = "none";
      return;
    }
    if (!box.isConnected) document.documentElement.append(box);
    const { left, top, right, bottom } = bounds(element);
    box.style.display = "block";
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${right - left}px`;
    box.style.height = `${bottom - top}px`;
  }

  // The page itself stands for the whole frame, not its outermost boxes.
  function target(event) {
    let node = event.target;
    if (node instanceof Element) {
      const { clientX: x, clientY: y } = event;
      const disabled = [...node.querySelectorAll(disabledControls)].filter(
        (child) => {
          const { left, top, right, bottom } = bounds(child);
          return x >= left && x <= right && y >= top && y <= bottom;
        },
      );
      node = disabled.at(-1) ?? node;
    }
    return node instanceof Element &&
      node !== document.documentElement &&
      node !== document.body
      ? node
      : null;
  }

  function path(element) {
    const parts = [];
    let node = element;
    for (
      ;
      node && node !== document.body && node !== document.documentElement;
      node = node.parentElement
    ) {
      if (node.id) {
        parts.unshift(`${node.localName}#${CSS.escape(node.id)}`);
        break;
      }
      const classes = [...node.classList]
        .slice(0, 2)
        .map((name) => `.${CSS.escape(name)}`)
        .join("");
      const twins = node.parentElement
        ? [...node.parentElement.children].filter(
            (child) => child.localName === node.localName,
          )
        : [];
      parts.unshift(
        node.localName +
          classes +
          (twins.length > 1 ? `:nth-of-type(${twins.indexOf(node) + 1})` : ""),
      );
    }
    // Anchored, so a structure repeated in another variant cannot match too.
    return (node === document.body ? "body > " : "") + parts.join(" > ");
  }

  // shortcut: moving between a disabled control and its parent (or two disabled siblings) fires no mouseover, so the hover outline lags until the next element; refine on mousemove if it misleads.
  addEventListener(
    "mouseover",
    (event) => {
      if (mode !== "target") return;
      place(hover, target(event));
    },
    true,
  );
  document.addEventListener("mouseleave", () => place(hover, null));
  // shortcut: clicks inside an open shadow root are reported as their host; follow event.composedPath() if frames use shadow DOM.
  addEventListener(
    "click",
    (event) => {
      if (mode !== "target") return;
      event.preventDefault();
      event.stopPropagation();
      selected = target(event);
      place(picked, selected);
      place(hover, null);
      postToParent(
        {
          type: "soreno-frame-pick",
          path: selected ? path(selected) : "",
          // Soreno bounds it again.
          html: selected?.outerHTML.slice(0, 2048) ?? "",
        },
        "*",
      );
    },
    true,
  );
  // Scrolling or a frame resize moves the picked element without a click.
  function follow() {
    place(hover, null);
    place(picked, mode === "target" && selected?.isConnected ? selected : null);
  }
  addEventListener("scroll", follow, true);
  addEventListener("resize", follow);
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    if (event.data === "soreno-frame-clear") {
      selected = null;
      place(picked, null);
      return;
    }
    if (
      event.data &&
      typeof event.data === "object" &&
      event.data.type === "soreno-frame-mode" &&
      (event.data.mode === "canvas" ||
        event.data.mode === "target" ||
        event.data.mode === "interact")
    ) {
      mode = event.data.mode;
      if (mode === "target") {
        if (!disabledPassThrough.isConnected)
          document.documentElement.append(disabledPassThrough);
      } else {
        disabledPassThrough.remove();
      }
      place(hover, null);
      place(
        picked,
        mode === "target" && selected?.isConnected ? selected : null,
      );
    }
  });
  // Ctrl+wheel and trackpad pinches zoom Soreno's canvas, not the page.
  addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      postToParent(
        {
          type: "soreno-frame-zoom",
          deltaY: event.deltaY,
          x: event.clientX,
          y: event.clientY,
        },
        "*",
      );
    },
    { passive: false },
  );
})();
