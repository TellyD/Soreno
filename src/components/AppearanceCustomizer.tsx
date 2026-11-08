import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { paletteColorOptions } from "../domain/palette";
import { useI18n } from "../i18n";
import { appearanceIconOptions } from "./appearanceIcons";
import { ColorSwatch } from "./ui/ColorSwatch";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Input";
import "./AppearanceCustomizer.css";

// Matches `.appearance-customizer-popover`; height covers six icon rows.
export const appearancePopoverSize = { width: 340, height: 380 };

type AppearanceCustomizerProps = {
  autoFocusSearch?: boolean;
  color: string | null;
  disabled: boolean;
  icon: string | null;
  onSelectColor: (color: string) => void;
  onSelectIcon: (icon: string) => void;
};

export function AppearanceCustomizer({
  autoFocusSearch = false,
  color,
  disabled,
  icon,
  onSelectColor,
  onSelectIcon,
}: AppearanceCustomizerProps) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const filteredIconOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);

    if (!normalizedQuery) {
      return appearanceIconOptions;
    }

    return appearanceIconOptions.filter((option) =>
      `${option.label} ${option.id}`
        .toLocaleLowerCase(locale)
        .includes(normalizedQuery),
    );
  }, [query, locale]);

  return (
    <>
      <div className="appearance-customizer-section">
        <span className="appearance-customizer-label">
          {t("appearance.color")}
        </span>
        <div className="appearance-color-row">
          {paletteColorOptions.map((option) => {
            const label = t(`palette.${option.id}`);

            return (
              <ColorSwatch
                aria-label={label}
                className="appearance-color-option"
                color={option.color}
                disabled={disabled}
                key={option.color}
                onClick={() => onSelectColor(option.color)}
                selected={color === option.color}
                title={label}
              />
            );
          })}
        </div>
      </div>

      <div className="appearance-customizer-section">
        <span className="appearance-customizer-label">
          {t("appearance.icon")}
        </span>
        <Input
          aria-label={t("appearance.iconSearch")}
          autoFocus={autoFocusSearch}
          className="appearance-icon-search"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("appearance.iconSearch")}
          size="small"
          startIcon={<Search size={13} aria-hidden="true" />}
          value={query}
        />
        <div className="appearance-icon-grid">
          {filteredIconOptions.map((option) => {
            const Icon = option.icon;

            return (
              <IconButton
                aria-label={option.label}
                aria-pressed={icon === option.id}
                className="appearance-icon-option"
                disabled={disabled}
                key={option.id}
                onClick={() => onSelectIcon(option.id)}
                selected={icon === option.id}
                size="large"
                title={option.label}
              >
                <Icon aria-hidden="true" />
              </IconButton>
            );
          })}
        </div>
      </div>
    </>
  );
}
