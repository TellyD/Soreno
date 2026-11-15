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

const selectedItemSelector = ":scope > [aria-pressed='true']";

function placeIndicator(control: HTMLElement, animate: boolean) {
  // A hidden control measures 0px: keep the last placement for its reveal.
  if (!control.getClientRects().length) return;
  if (!animate) delete control.dataset.animated;
  const item = control.querySelector<HTMLElement>(selectedItemSelector);
  if (item) {
    control.style.setProperty(
      "--segmented-indicator-x",
      `${item.offsetLeft}px`,
    );
    control.style.setProperty(
      "--segmented-indicator-width",
      `${item.offsetWidth}px`,
    );
    control.dataset.indicator = "";
  } else {
    delete control.dataset.indicator;
  }
  if (animate) return;
  // Flush the placement so re-enabling transitions does not animate it.
  void control.offsetWidth;
  control.dataset.animated = "";
}

export function SegmentedControl({
  children,
  className,
  role = "group",
  ...props
}: SegmentedControlProps) {
  const controlRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLElement | null>(null);

  // Only a new selection slides: mounts, reveals from `hidden` and re-renders jump.
  useLayoutEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    const item = control.querySelector<HTMLElement>(selectedItemSelector);
    placeIndicator(
      control,
      selectedRef.current !== null && item !== selectedRef.current,
    );
    selectedRef.current = item;
  });

  useEffect(() => {
    const control = controlRef.current;
    if (!control || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => placeIndicator(control, false));
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
