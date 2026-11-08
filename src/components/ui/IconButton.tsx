import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import "./IconButton.css";

type IconButtonSize = "small" | "medium" | "large";
type IconButtonTone = "default" | "danger";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  selected?: boolean;
  size?: IconButtonSize;
  tone?: IconButtonTone;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      children,
      className,
      selected = false,
      size = "medium",
      tone = "default",
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        className={[
          "app-icon-button",
          `app-icon-button-${size}`,
          `app-icon-button-${tone}`,
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
  },
);
