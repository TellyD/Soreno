import type { ButtonHTMLAttributes, CSSProperties } from "react";
import "./ColorSwatch.css";

type ColorSwatchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> & {
  color: string;
  selected: boolean;
  size?: "small" | "medium";
};

export function ColorSwatch({
  className,
  color,
  selected,
  size = "medium",
  style,
  type = "button",
  ...props
}: ColorSwatchProps) {
  return (
    <button
      aria-pressed={selected}
      className={["app-color-swatch", `app-color-swatch-${size}`, className]
        .filter(Boolean)
        .join(" ")}
      style={{ "--swatch-color": color, ...style } as CSSProperties}
      type={type}
      {...props}
    />
  );
}
