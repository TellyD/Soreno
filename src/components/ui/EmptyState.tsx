import type { HTMLAttributes, ReactNode } from "react";
import "./EmptyState.css";

type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  actions?: ReactNode;
  description?: ReactNode;
  fill?: boolean;
  headingLevel?: 2 | 3 | 4;
  icon?: ReactNode;
  layout?: "centered" | "inline";
  size?: "compact" | "default";
  title?: ReactNode;
};

export function EmptyState({
  actions,
  children,
  className,
  description,
  fill = false,
  headingLevel = 2,
  icon,
  layout = "centered",
  size = "default",
  title,
  ...props
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";

  return (
    <div
      className={[
        "app-empty-state",
        `app-empty-state-${layout}`,
        `app-empty-state-${size}`,
        fill ? "is-fill" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      <div className="app-empty-state-content">
        {icon ? (
          <span className="app-empty-state-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className="app-empty-state-body">
          {title ? (
            <Heading className="app-empty-state-title">{title}</Heading>
          ) : null}
          {description ? (
            <p className="app-empty-state-description">{description}</p>
          ) : null}
          {children ? (
            <div className="app-empty-state-details">{children}</div>
          ) : null}
          {actions ? (
            <div className="app-empty-state-actions">{actions}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
