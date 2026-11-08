import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import "./Dialog.css";

type DialogOverlayProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
};

type DialogSurfaceProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export function DialogOverlay({
  children,
  className,
  ...props
}: DialogOverlayProps) {
  return (
    <div
      className={["app-dialog-overlay", className].filter(Boolean).join(" ")}
      role="presentation"
      {...props}
    >
      {children}
    </div>
  );
}

const focusableSelector = [
  "a[href]",
  "summary",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function dialogFocusTargetIndex(
  activeIndex: number,
  itemCount: number,
  shiftKey: boolean,
): number | null {
  if (activeIndex < 0) {
    return shiftKey ? Math.max(0, itemCount - 1) : 0;
  }
  if (shiftKey && activeIndex === 0) {
    return Math.max(0, itemCount - 1);
  }
  if (!shiftKey && activeIndex === itemCount - 1) {
    return 0;
  }
  return null;
}

export const DialogSurface = forwardRef<HTMLElement, DialogSurfaceProps>(
  function DialogSurface(
    { children, className, role = "dialog", returnFocusRef, ...props },
    ref,
  ) {
    const surfaceRef = useRef<HTMLElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(
      typeof document !== "undefined" &&
        document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    );
    // A text field always matches :focus-visible, so restoring from it would ring the opener after a mouse flow.
    const [restoreFocusVisible] = useState(
      () => previousFocusRef.current?.matches(":focus-visible") ?? false,
    );

    useImperativeHandle(ref, () => surfaceRef.current as HTMLElement);

    useEffect(() => {
      const surface = surfaceRef.current;
      if (!surface) {
        return;
      }

      function focusableElements() {
        const closedDetails = Array.from(
          surface?.querySelectorAll("details:not([open])") ?? [],
        );
        return Array.from(
          surface?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(
              ':disabled, [aria-hidden="true"], [data-base-ui-focus-guard]',
            ) &&
            closedDetails.every(
              (details) =>
                !details.contains(element) ||
                details.querySelector("summary")?.contains(element),
            ),
        );
      }

      if (!surface.contains(document.activeElement)) {
        (focusableElements()[0] ?? surface).focus();
      }

      function handleKeyDown(event: KeyboardEvent) {
        if (event.key !== "Tab") {
          return;
        }

        const activeElement = document.activeElement;
        if (
          activeElement instanceof Element &&
          !surface?.contains(activeElement) &&
          activeElement.closest('[aria-modal="true"]')
        ) {
          return;
        }

        const focusable = focusableElements();
        const activeIndex = focusable.indexOf(
          document.activeElement as HTMLElement,
        );
        const targetIndex = dialogFocusTargetIndex(
          activeIndex,
          focusable.length,
          event.shiftKey,
        );

        if (targetIndex !== null) {
          event.preventDefault();
          (focusable[targetIndex] ?? surface).focus();
        }
      }

      document.addEventListener("keydown", handleKeyDown);

      return () => {
        document.removeEventListener("keydown", handleKeyDown);
        const target = returnFocusRef?.current ?? previousFocusRef.current;
        if (target?.isConnected) {
          target.focus({
            preventScroll: true,
            focusVisible: restoreFocusVisible,
          });
        }
      };
    }, [restoreFocusVisible, returnFocusRef]);

    return (
      <section
        aria-modal="true"
        className={["app-dialog-surface", className].filter(Boolean).join(" ")}
        ref={surfaceRef}
        role={role}
        tabIndex={-1}
        {...props}
      >
        {children}
      </section>
    );
  },
);
