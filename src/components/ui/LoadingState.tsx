import { LoaderCircle } from "lucide-react";
import type { HTMLAttributes } from "react";
import "./LoadingState.css";

type LoadingStateProps = HTMLAttributes<HTMLDivElement> & {
  spinnerSize?: number;
};

export function LoadingState({
  children,
  className,
  spinnerSize = 14,
  ...props
}: LoadingStateProps) {
  return (
    <div
      className={["app-loading-state", className].filter(Boolean).join(" ")}
      role="status"
      {...props}
    >
      <LoaderCircle
        size={spinnerSize}
        className="app-loading-spinner app-loading-state-spinner"
        aria-hidden="true"
      />
      <span className="app-loading-state-label">{children}</span>
    </div>
  );
}
