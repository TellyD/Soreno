import { Tooltip } from "@base-ui/react/tooltip";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useAgentTabReorder } from "../hooks/useAgentTabReorder";
import { IconButton } from "./ui/IconButton";
import "./ActivityBar.css";

type ActivityBarProps = {
  "aria-label": string;
  children: ReactNode;
  footer?: ReactNode;
};

type ActivityBarItemProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children" | "title"
> & {
  icon: ReactNode;
  label: string;
  selected: boolean;
};

export function ActivityBar({ children, footer, ...props }: ActivityBarProps) {
  return (
    <Tooltip.Provider delay={300}>
      <nav className="activity-bar" {...props}>
        {children}
        {footer ? <div className="activity-bar-footer">{footer}</div> : null}
      </nav>
    </Tooltip.Provider>
  );
}

export function ActivityBarItem({
  icon,
  label,
  selected,
  ...props
}: ActivityBarItemProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <IconButton
            size="large"
            className="activity-bar-item"
            selected={selected}
            aria-current={selected ? "page" : undefined}
            aria-label={label}
            {...props}
          >
            {icon}
          </IconButton>
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner
          className="activity-bar-tooltip-positioner"
          side="right"
          sideOffset={8}
          collisionPadding={8}
        >
          <Tooltip.Popup className="activity-bar-tooltip">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

type ReorderableActivityItemsProps<T extends string> = {
  items: Record<T, ReactNode>;
  order: T[];
  onReorder: (order: T[]) => void;
};

export function ReorderableActivityItems<T extends string>({
  items,
  order,
  onReorder,
}: ReorderableActivityItemsProps<T>) {
  const reorder = useAgentTabReorder({
    axis: "vertical",
    ids: order,
    projectId: undefined,
    disabled: false,
    onReorder: (id, index) => {
      const next = order.filter((item) => item !== id);
      next.splice(index, 0, id as T);
      onReorder(next);
    },
  });
  const lastId = order.filter((id) => id !== reorder.draggingId).slice(-1)[0];

  return (
    <div
      ref={(element) => {
        reorder.containerRef.current = element;
      }}
      className={`activity-bar-items${reorder.isReordering ? " is-reordering" : ""}`}
    >
      {order.map((id) => (
        <div
          key={id}
          ref={(element) => {
            if (element) reorder.itemRefs.current.set(id, element);
            else reorder.itemRefs.current.delete(id);
          }}
          className={`activity-bar-slot${reorder.draggingId === id ? " is-dragging" : ""}`}
          data-drop={
            reorder.dropBeforeId === id
              ? "before"
              : reorder.dropAtEnd && lastId === id
                ? "after"
                : undefined
          }
          onPointerDown={(event) => reorder.startDrag(id, event)}
        >
          {items[id]}
        </div>
      ))}
    </div>
  );
}
