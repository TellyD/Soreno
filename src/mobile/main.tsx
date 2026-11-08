import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/fonts.css";
import "@/App.css";
import "./mobile.css";
import { captureInstallPrompt } from "./installHint";
import { MobileApp } from "./MobileApp";
import { takePairingFragment } from "./pairing";

// iOS overlays the keyboard on the layout viewport (it ignores `interactive-widget`): size the page
// to the visible part then. Elsewhere `100dvh` alone, so a stale or empty reading cannot hide the page.
function trackVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const style = document.documentElement.style;
  const update = () => {
    if (viewport.height > 0 && viewport.height < window.innerHeight - 1) {
      style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
      style.setProperty("--mobile-viewport-top", `${viewport.offsetTop}px`);
    } else {
      style.removeProperty("--mobile-viewport-height");
      style.removeProperty("--mobile-viewport-top");
    }
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  document.addEventListener("visibilitychange", update);
  update();
}

const isIOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function opensKeyboard(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement &&
      ![
        "button",
        "checkbox",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ].includes(target.type)) ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

// Safari scrolls the whole page to lift a focused field over its keyboard, then the shell follows the
// visual viewport: everything jumps twice. A field it sees far above at focus is left alone (react-aria's trick).
function keepPageStillOnFocus() {
  const hide = (field: HTMLElement) => {
    field.style.transform = "translateY(-2000px)";
    requestAnimationFrame(() => field.style.removeProperty("transform"));
  };
  // A tapped field must already be moved when Safari decides to scroll: focus it here, before its `focus`.
  document.addEventListener(
    "touchend",
    (event) => {
      const target = event.target;
      if (!opensKeyboard(target) || target === document.activeElement) return;
      event.preventDefault();
      hide(target);
      target.focus();
    },
    { passive: false },
  );
  // Focus moved by the keyboard's previous/next arrows.
  document.addEventListener("focusin", (event) => {
    if (opensKeyboard(event.target)) hide(event.target);
  });
}

const pairing = takePairingFragment(window.location, window.history);
trackVisualViewport();
if (isIOS) keepPageStillOnFocus();
captureInstallPrompt();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp initialPairing={pairing} />
  </StrictMode>,
);
