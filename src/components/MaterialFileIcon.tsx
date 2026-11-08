import { materialIconFile } from "../domain/fileIcons";
import { useTheme } from "../theme/ThemeProvider";

const iconDirectory = "/node_modules/material-icon-theme/icons/";
const iconUrls = import.meta.glob<string>(
  "/node_modules/material-icon-theme/icons/*.svg",
  { eager: true, exhaustive: true, import: "default", query: "?no-inline" },
);

export default function MaterialFileIcon({
  name,
  kind,
  expanded,
  size,
}: {
  name: string;
  kind: "file" | "directory";
  expanded: boolean;
  size: number;
}) {
  const isLight = useTheme().theme === "light";
  return (
    <img
      src={
        iconUrls[
          iconDirectory + materialIconFile(name, kind, { expanded, isLight })
        ]
      }
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
