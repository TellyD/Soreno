import { Menu } from "@base-ui/react/menu";
import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { MenuItem, MenuSurface } from "@/components/ui/Menu";

type HeaderMenuAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

export function HeaderMenu({
  label,
  actions,
}: {
  label: string;
  actions: HeaderMenuAction[];
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <IconButton aria-label={label} title={label}>
            <Ellipsis />
          </IconButton>
        }
      />
      <Menu.Portal>
        <Menu.Positioner
          className="mobile-menu-positioner"
          sideOffset={4}
          align="end"
          collisionPadding={8}
        >
          <Menu.Popup render={<MenuSurface className="mobile-menu" />}>
            {actions.map((action) => (
              <Menu.Item
                key={action.id}
                nativeButton
                render={<MenuItem leading={action.icon} />}
                onClick={action.onSelect}
              >
                {action.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
