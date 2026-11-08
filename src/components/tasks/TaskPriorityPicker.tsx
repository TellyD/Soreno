import { Menu } from "@base-ui/react/menu";
import { Check, Flag } from "lucide-react";
import {
  taskPriorities,
  type Task,
  type TaskPriority,
} from "../../domain/tasks";
import { useI18n } from "../../i18n";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";

type TaskPriorityPickerProps = {
  isEditing: boolean;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onUpdatePriority: (priority: TaskPriority) => void;
  task: Task;
};

export function TaskPriorityPicker({
  isEditing,
  isOpen,
  onOpenChange,
  onUpdatePriority,
  task,
}: TaskPriorityPickerProps) {
  const { t } = useI18n();

  return (
    <div className="task-priority-picker" data-task-no-drag>
      <Menu.Root modal={false} open={isOpen} onOpenChange={onOpenChange}>
        <Menu.Trigger
          render={
            <IconButton
              className={taskPriorityClassName(task)}
              aria-label={t("tasks.priority.change", {
                priority: task.priority,
              })}
              size="small"
              title={t("tasks.priority.change", { priority: task.priority })}
              onMouseDown={(event) => {
                if (isEditing) event.preventDefault();
              }}
            >
              <Flag aria-hidden="true" />
            </IconButton>
          }
        />
        <Menu.Portal
          data-task-no-drag
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Menu.Positioner
            className="task-menu-positioner"
            align="start"
            collisionPadding={8}
            positionMethod="fixed"
            sideOffset={5}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Menu.Popup render={<MenuSurface className="task-priority-menu" />}>
              <Menu.RadioGroup
                value={task.priority}
                onValueChange={(priority) =>
                  onUpdatePriority(priority as TaskPriority)
                }
              >
                {taskPriorities.map((priority) => {
                  const isSelected = priority === task.priority;

                  return (
                    <Menu.RadioItem
                      nativeButton
                      closeOnClick
                      key={priority}
                      value={priority}
                      render={
                        <MenuItem
                          className={`task-priority-menu-item task-priority-menu-item-${priority}`}
                          leading={
                            <Flag
                              className={`task-priority-menu-icon task-priority-menu-icon-${priority}`}
                              size={14}
                              aria-hidden="true"
                            />
                          }
                          selected={isSelected}
                          trailing={
                            isSelected ? (
                              <Check size={13} aria-hidden="true" />
                            ) : null
                          }
                        />
                      }
                    >
                      {t("tasks.priority.set", { priority })}
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

export function taskPriorityClassName(task: Task): string {
  return `task-priority task-priority-${task.priority}`;
}
