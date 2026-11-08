import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from "react";
import "./SegmentedControl.css";

type SegmentedControlProps = HTMLAttributes<HTMLDivElement>;

type SegmentedControlItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  selected: boolean;
};

function placeIndicator(control: HTMLElement) {
  const item = control.querySelector<HTMLElement>(
    ":scope > [aria-pressed='true']",
  );
  if (!item) {
    delete control.dataset.indicator;
    return;
  }
  control.style.setProperty("--segmented-indicator-x", `${item.offsetLeft}px`);
  control.style.setProperty(
    "--segmented-indicator-width",
    `${item.offsetWidth}px`,
  );
  control.dataset.indicator = "";
}

export function SegmentedControl({
  children,
  className,
  role = "group",
  ...props
}: SegmentedControlProps) {
  const controlRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (controlRef.current) placeIndicator(controlRef.current);
  });

  useEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    // Flush the first placement so enabling transitions does not animate it.
    void control.offsetWidth;
    control.dataset.animated = "";
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => placeIndicator(control));
    observer.observe(control);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={["app-segmented-control", className].filter(Boolean).join(" ")}
      ref={controlRef}
      role={role}
      {...props}
    >
      {children}
    </div>
  );
}

export const SegmentedControlItem = forwardRef<
  HTMLButtonElement,
  SegmentedControlItemProps
>(function SegmentedControlItem(
  { children, className, selected, type = "button", ...props },
  ref,
) {
  return (
    <button
      aria-pressed={selected}
      className={[
        "app-segmented-control-item",
        selected ? "selected" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      ref={ref}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
});
