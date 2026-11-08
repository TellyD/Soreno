import { ArrowUpDown, Check } from "lucide-react";
import { useCallback, useState } from "react";
import type { NoteSortOrder } from "../domain/notes";
import { useI18n, type TranslationKey } from "../i18n";
import { IconButton } from "./ui/IconButton";
import { MenuItem, MenuSurface } from "./ui/Menu";
import { useDismissibleLayer } from "./ui/useDismissibleLayer";

type NoteSortOption = {
  labelKey: TranslationKey;
  order: NoteSortOrder;
};

const noteSortOptions: NoteSortOption[] = [
  {
    labelKey: "notes.sort.updatedDesc",
    order: "updated-desc",
  },
  {
    labelKey: "notes.sort.updatedAsc",
    order: "updated-asc",
  },
  {
    labelKey: "notes.sort.createdDesc",
    order: "created-desc",
  },
  {
    labelKey: "notes.sort.createdAsc",
    order: "created-asc",
  },
  {
    labelKey: "notes.sort.titleAsc",
    order: "title-asc",
  },
  {
    labelKey: "notes.sort.titleDesc",
    order: "title-desc",
  },
];

type NoteSortPickerProps = {
  order: NoteSortOrder;
  onChange: (order: NoteSortOrder) => void;
};

export function NoteSortPicker({ order, onChange }: NoteSortPickerProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const closePicker = useCallback(() => setIsOpen(false), []);
  const pickerRef = useDismissibleLayer<HTMLDivElement>(isOpen, closePicker);
  const selectedOption =
    noteSortOptions.find((option) => option.order === order) ??
    noteSortOptions[0];
  const selectedLabel = t(selectedOption.labelKey);

  return (
    <div className="sort-picker" ref={pickerRef}>
      <IconButton
        className="sort-control"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`${t("notes.sort.aria")} : ${selectedLabel}`}
        selected={isOpen}
        title={selectedLabel}
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <ArrowUpDown aria-hidden="true" />
      </IconButton>

      {isOpen ? (
        <MenuSurface className="sort-picker-menu">
          {noteSortOptions.map((option) => {
            const isSelected = option.order === order;

            return (
              <MenuItem
                className="sort-picker-option"
                key={option.order}
                role="menuitemradio"
                aria-checked={isSelected}
                selected={isSelected}
                trailing={
                  isSelected ? <Check size={13} aria-hidden="true" /> : null
                }
                onClick={() => {
                  onChange(option.order);
                  setIsOpen(false);
                }}
              >
                {t(option.labelKey)}
              </MenuItem>
            );
          })}
        </MenuSurface>
      ) : null}
    </div>
  );
}
