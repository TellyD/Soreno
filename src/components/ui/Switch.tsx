import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import type { ComponentPropsWithoutRef } from "react";
import "./Switch.css";

type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & {
  size?: "small" | "medium";
};

export function Switch({ className, size = "medium", ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={["app-switch", `app-switch-${size}`, className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      <SwitchPrimitive.Thumb className="app-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
