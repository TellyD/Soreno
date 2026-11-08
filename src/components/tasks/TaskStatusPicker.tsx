import { Menu } from "@base-ui/react/menu";
import { ArrowRight, Check } from "lucide-react";
import { taskStatuses, type Task, type TaskStatus } from "../../domain/tasks";
import { useI18n, type TranslationKey } from "../../i18n";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui/Menu";

export const taskStatusLabelKeys: Record<TaskStatus, TranslationKey> = {
  doing: "tasks.status.doing",
  done: "tasks.status.done",
  todo: "tasks.status.todo",
};

type TaskStatusPickerProps = {
  isEditing: boolean;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onUpdateStatus: (status: TaskStatus) => void;
  task: Task;
};

export function TaskStatusPicker({
  isEditing,
  isOpen,
  onOpenChange,
  onUpdateStatus,
  task,
}: TaskStatusPickerProps) {
  const { t } = useI18n();
  const label = t("tasks.status.change", {
    status: t(taskStatusLabelKeys[task.status]),
  });

  return (
    <div className="task-status-picker" data-task-no-drag>
      <Menu.Root modal={false} open={isOpen} onOpenChange={onOpenChange}>
        <Menu.Trigger
          render={
            <IconButton
              aria-label={label}
              data-task-status-trigger={task.id}
              size="small"
              title={label}
              onMouseDown={(event) => {
                if (isEditing) event.preventDefault();
              }}
            >
              <ArrowRight aria-hidden="true" />
            </IconButton>
          }
        />
        <Menu.Portal
          data-task-no-drag
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Menu.Positioner
            className="task-menu-positioner"
            align="end"
            collisionPadding={8}
            positionMethod="fixed"
            sideOffset={5}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Menu.Popup render={<MenuSurface className="task-status-menu" />}>
              <Menu.RadioGroup
                value={task.status}
                onValueChange={(status) => onUpdateStatus(status as TaskStatus)}
              >
                {taskStatuses.map((status) => {
                  const isSelected = status === task.status;

                  return (
                    <Menu.RadioItem
                      nativeButton
                      closeOnClick
                      key={status}
                      value={status}
                      render={
                        <MenuItem
                          selected={isSelected}
                          trailing={
                            isSelected ? (
                              <Check size={13} aria-hidden="true" />
                            ) : null
                          }
                        />
                      }
                    >
                      {t(taskStatusLabelKeys[status])}
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
