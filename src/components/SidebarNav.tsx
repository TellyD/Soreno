import { ChevronDown, Plus } from "lucide-react";
import { useId, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { CountBadge } from "./ui/CountBadge";
import { IconButton } from "./ui/IconButton";
import "./Sidebar.css";

type NavItemProps = {
  accentColor?: string;
  className?: string;
  count?: number;
  icon: ReactNode;
  isSelected: boolean;
  label: ReactNode;
  onSelect: () => void;
  style?: CSSProperties;
  title?: string;
};

type NavSectionProps = {
  addLabel?: string;
  children: ReactNode;
  isExpanded: boolean;
  onAdd?: () => void;
  onExpandedChange: (isExpanded: boolean) => void;
  title: string;
};

export function NavItem({
  accentColor,
  className,
  count,
  icon,
  isSelected,
  label,
  onSelect,
  style,
  title,
}: NavItemProps) {
  const activeBadgeColor = isSelected
    ? (accentColor ?? "var(--primary)")
    : undefined;

  return (
    <button
      className={["nav-item", className, isSelected ? "selected" : null]
        .filter(Boolean)
        .join(" ")}
      type="button"
      aria-current={isSelected ? "page" : undefined}
      onClick={onSelect}
      style={style}
      title={title}
    >
      <span className="nav-icon" style={{ color: accentColor }}>
        {icon}
      </span>
      <span>{label}</span>
      {typeof count === "number" ? (
        <CountBadge accentColor={activeBadgeColor} count={count} />
      ) : null}
    </button>
  );
}

export function NavSection(props: NavSectionProps) {
  const { locale, t } = useI18n();
  const contentId = useId();
  const { isExpanded, title } = props;
  const sectionName = title.toLocaleLowerCase(locale);
  const toggleLabel = t(
    isExpanded ? "sidebar.collapseSection" : "sidebar.expandSection",
    { section: sectionName },
  );

  return (
    <section className="nav-section">
      <div className={`section-title ${props.onAdd ? "" : "no-action"}`}>
        <button
          className="section-toggle"
          type="button"
          aria-controls={contentId}
          aria-expanded={isExpanded}
          aria-label={toggleLabel}
          onClick={() => props.onExpandedChange(!isExpanded)}
        >
          <span>{title}</span>
          <ChevronDown
            className="section-toggle-icon"
            size={14}
            aria-hidden="true"
          />
        </button>
        {props.onAdd ? (
          <IconButton
            className="section-add-button"
            aria-label={props.addLabel}
            size="small"
            title={props.addLabel}
            onClick={props.onAdd}
          >
            <Plus strokeWidth={1.6} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
      <div className="section-content" id={contentId} hidden={!isExpanded}>
        {props.children}
      </div>
    </section>
  );
}
