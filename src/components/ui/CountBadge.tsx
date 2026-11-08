import type { CSSProperties, HTMLAttributes } from "react";
import "./CountBadge.css";

type CountBadgeProps = {
  accentColor?: string;
  className?: string;
  count: number;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

export function CountBadge({
  accentColor,
  className,
  count,
  style,
  ...props
}: CountBadgeProps) {
  const badgeStyle = accentColor
    ? ({
        ...style,
        "--count-badge-accent": accentColor,
      } as CSSProperties)
    : style;

  return (
    <span
      className={[
        "count-badge",
        accentColor ? "count-badge-accent" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={badgeStyle}
      {...props}
    >
      {count}
    </span>
  );
}
