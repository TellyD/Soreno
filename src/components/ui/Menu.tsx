import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import "./Menu.css";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type MenuSurfaceProps = HTMLAttributes<HTMLDivElement>;

export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(
  function MenuSurface({ children, className, role = "menu", ...props }, ref) {
    return (
      <div
        className={classNames("app-menu-surface", className)}
        ref={ref}
        role={role}
        {...props}
      >
        {children}
      </div>
    );
  },
);

type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  danger?: boolean;
  leading?: ReactNode;
  selected?: boolean;
  trailing?: ReactNode;
};

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
  function MenuItem(
    {
      children,
      className,
      danger = false,
      leading,
      role = "menuitem",
      selected = false,
      trailing,
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        className={classNames(
          "app-menu-item",
          selected && "selected",
          danger && "danger",
          className,
        )}
        ref={ref}
        role={role}
        type={type}
        {...props}
      >
        {leading}
        <span className="app-menu-item-label">{children}</span>
        {trailing}
      </button>
    );
  },
);
