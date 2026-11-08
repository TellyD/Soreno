import { FileCode2, Folder } from "lucide-react";
import { lazy, Suspense } from "react";
import { useAppSettings } from "../settings";

// Keeps the ~500 kB icon manifest out of the startup bundle while the option is off.
const MaterialFileIcon = lazy(() => import("./MaterialFileIcon"));

type FileIconProps = {
  name: string;
  kind?: "file" | "directory";
  expanded?: boolean;
  size: number;
};

export function FileIcon({
  name,
  kind = "file",
  expanded = false,
  size,
}: FileIconProps) {
  const { materialFileIconsEnabled } = useAppSettings().settings;
  const Fallback = kind === "directory" ? Folder : FileCode2;
  const fallback = <Fallback size={size} aria-hidden="true" />;
  if (!materialFileIconsEnabled) return fallback;
  return (
    <Suspense fallback={fallback}>
      <MaterialFileIcon
        name={name}
        kind={kind}
        expanded={expanded}
        size={size}
      />
    </Suspense>
  );
}
