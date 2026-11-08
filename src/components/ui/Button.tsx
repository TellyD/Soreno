import type { ComponentProps, ReactNode } from "react";
import "./Button.css";

type ButtonSize = "small" | "medium" | "large";
type ButtonVariant = "danger" | "primary" | "secondary";

type ButtonProps = ComponentProps<"button"> & {
  children: ReactNode;
  endIcon?: ReactNode;
  size?: ButtonSize;
  startIcon?: ReactNode;
  variant?: ButtonVariant;
};

export function Button({
  children,
  className,
  endIcon,
  size = "medium",
  startIcon,
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  const classes = [
    "app-button",
    `app-button-${size}`,
    `app-button-${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} type={type} {...props}>
      {startIcon ? (
        <span className="app-button-icon" aria-hidden="true">
          {startIcon}
        </span>
      ) : null}
      {children}
      {endIcon ? (
        <span className="app-button-icon" aria-hidden="true">
          {endIcon}
        </span>
      ) : null}
    </button>
  );
}
