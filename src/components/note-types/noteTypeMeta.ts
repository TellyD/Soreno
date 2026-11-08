import type { LucideIcon } from "lucide-react";
import type { NoteType } from "../../domain/noteTypes";
import { paletteColorOptions } from "../../domain/palette";
import { appearanceIconOptions, findAppearanceIcon } from "../appearanceIcons";

export type NoteTypeAppearance = {
  accent: string;
  border: string;
  icon: LucideIcon;
  label: string;
  surface: string;
  surfaceHover: string;
};

export function getNoteTypeAppearance(
  noteType: Pick<NoteType, "color" | "icon" | "name"> | null,
): NoteTypeAppearance {
  const color = noteType?.color ?? paletteColorOptions[0].color;
  const iconOption =
    findAppearanceIcon(noteType?.icon) ?? appearanceIconOptions[0];

  return {
    accent: color,
    border: tint(color, 34),
    icon: iconOption.icon,
    label: noteType?.name ?? "",
    surface: tint(color, 11),
    surfaceHover: tint(color, 17),
  };
}

export function noteTypeStyleVars(
  noteType: Pick<NoteType, "color" | "icon" | "name"> | null,
) {
  const appearance = getNoteTypeAppearance(noteType);

  return {
    "--note-accent": appearance.accent,
    "--note-border": appearance.border,
    "--note-surface": appearance.surface,
    "--note-surface-hover": appearance.surfaceHover,
  };
}

function tint(color: string, amount: number): string {
  return `color-mix(in srgb, ${color} ${amount}%, var(--surface))`;
}
