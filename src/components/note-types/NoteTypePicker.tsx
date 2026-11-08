import { Check, ChevronDown } from "lucide-react";
import { useCallback, useState, type CSSProperties } from "react";
import {
  findNoteType,
  getFallbackNoteType,
  type NoteType,
  type NoteTypeId,
} from "../../domain/noteTypes";
import { useI18n } from "../../i18n";
import { MenuItem, MenuSurface } from "../ui/Menu";
import { getNoteTypeAppearance, noteTypeStyleVars } from "./noteTypeMeta";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";

type NoteTypePickerProps = {
  disabled: boolean;
  kind: NoteTypeId | null;
  noteTypes: NoteType[];
  onChange: (kind: NoteTypeId) => void;
};

export function NoteTypePicker({
  disabled,
  kind,
  noteTypes,
  onChange,
}: NoteTypePickerProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const closePicker = useCallback(() => setIsOpen(false), []);
  const pickerRef = useDismissibleLayer<HTMLDivElement>(isOpen, closePicker);
  const selectedNoteType =
    findNoteType(noteTypes, kind) ?? getFallbackNoteType(noteTypes);
  const selectedAppearance = getNoteTypeAppearance(selectedNoteType);
  const SelectedKindIcon = selectedAppearance.icon;
  const isDisabled = disabled || !selectedNoteType || noteTypes.length === 0;

  return (
    <div
      className={`kind-picker ${isDisabled ? "disabled" : ""}`}
      ref={pickerRef}
      style={noteTypeStyleVars(selectedNoteType) as CSSProperties}
    >
      <button
        className="kind-picker-trigger"
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={t("editor.title.noteKind")}
        disabled={isDisabled}
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <SelectedKindIcon size={14} aria-hidden="true" />
        <span>{selectedAppearance.label || t("editor.title.noteKind")}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {isOpen ? (
        <MenuSurface className="kind-picker-menu">
          {noteTypes.map((noteType) => {
            const appearance = getNoteTypeAppearance(noteType);
            const OptionIcon = appearance.icon;
            const isSelected = noteType.id === selectedNoteType?.id;

            return (
              <MenuItem
                className="kind-picker-option"
                key={noteType.id}
                role="menuitemradio"
                aria-checked={isSelected}
                leading={<OptionIcon size={14} aria-hidden="true" />}
                selected={isSelected}
                style={
                  {
                    "--menu-item-hover-bg": appearance.surfaceHover,
                    "--menu-item-icon-color": appearance.accent,
                    "--menu-item-selected-bg": appearance.surface,
                    ...noteTypeStyleVars(noteType),
                  } as CSSProperties
                }
                trailing={
                  isSelected ? <Check size={13} aria-hidden="true" /> : null
                }
                onClick={() => {
                  onChange(noteType.id);
                  setIsOpen(false);
                }}
              >
                {appearance.label}
              </MenuItem>
            );
          })}
        </MenuSurface>
      ) : null}
    </div>
  );
}
