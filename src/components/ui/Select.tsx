import { Combobox } from "@base-ui/react/combobox";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import type { BaseUIEvent } from "@base-ui/react/types";
import { Check, ChevronDown } from "lucide-react";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import "./Select.css";

type SelectProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "value" | "onChange"
> & {
  size?: "small" | "medium" | "large";
  popupClassName?: string;
  startIcon?: ReactNode;
  value: string;
  // Trigger text replacing the selected option's label; options keep their labels.
  valueLabel?: ReactNode;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  // A filter field at the top of the list, for long lists.
  search?: { placeholder: string; empty: string };
};

type SelectOption = {
  value: string;
  label: string;
  description?: string;
  // Short muted qualifier kept on the label line.
  hint?: string;
  disabled?: boolean;
  icon?: ReactNode;
};

// Option texts stay on one line; the full text becomes the tooltip only when clipped.
// shortcut: hover only, keyboard users see clipped text truncated; reveal on highlight if long ambiguous labels show up.
function revealClippedText(item: HTMLElement, option: SelectOption) {
  const clipped = [
    ...item.querySelectorAll<HTMLElement>(
      ".app-select-option-label, .app-select-option-description, .app-select-option-hint",
    ),
  ].some((text) => text.scrollWidth > text.clientWidth);
  item.title = clipped
    ? [option.label, option.description, option.hint].filter(Boolean).join("\n")
    : "";
}

function optionBody(option: SelectOption, label: ReactNode) {
  return (
    <>
      {option.icon ? (
        <span className="app-select-option-icon" aria-hidden="true">
          {option.icon}
        </span>
      ) : null}
      {option.description ? (
        <span className="app-select-option-text">
          {label}
          <span className="app-select-option-description">
            {option.description}
          </span>
        </span>
      ) : (
        label
      )}
      {option.hint ? (
        <span className="app-select-option-hint">{option.hint}</span>
      ) : null}
    </>
  );
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  function Select(
    {
      className,
      disabled,
      id,
      size = "medium",
      popupClassName,
      startIcon,
      value,
      valueLabel,
      options,
      onValueChange,
      search,
      onKeyDown,
      ...props
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    useImperativeHandle(ref, () => triggerRef.current!);
    const { contains } = Combobox.useFilter();
    const selected = options.find((option) => option.value === value);
    const triggerClassName = ["app-select", `app-select-${size}`, className]
      .filter(Boolean)
      .join(" ");
    const popupClasses = ["app-select-popup", popupClassName]
      .filter(Boolean)
      .join(" ");
    const startIconNode = startIcon ? (
      <span className="app-select-start-icon" aria-hidden="true">
        {startIcon}
      </span>
    ) : null;

    function handleTab(event: BaseUIEvent<KeyboardEvent<HTMLElement>>) {
      if (open && event.key === "Tab") {
        // Close before native Tab traversal can re-enter the portal's focus guards.
        event.preventBaseUIHandler();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }

    if (search)
      return (
        <Combobox.Root
          items={options}
          value={selected ?? null}
          onValueChange={(option) => {
            if (option) onValueChange(option.value);
          }}
          itemToStringLabel={(option) => option.label}
          itemToStringValue={(option) => option.value}
          isItemEqualToValue={(option, other) => option.value === other.value}
          filter={(option, query) =>
            [option.label, option.hint, option.description, option.value].some(
              (text) => !!text && contains(text, query),
            )
          }
          autoHighlight
          disabled={disabled}
          open={open}
          onOpenChange={setOpen}
        >
          <Combobox.Trigger
            {...props}
            ref={triggerRef}
            onKeyDown={onKeyDown}
            className={triggerClassName}
          >
            {startIconNode}
            <span className="app-select-value">
              {valueLabel ?? selected?.label}
            </span>
            <Combobox.Icon className="app-select-chevron">
              <ChevronDown />
            </Combobox.Icon>
          </Combobox.Trigger>
          <Combobox.Portal onPointerDown={(event) => event.stopPropagation()}>
            <Combobox.Positioner
              className="app-select-positioner"
              onPointerDown={(event) => event.stopPropagation()}
              sideOffset={5}
              align="start"
              positionMethod="fixed"
              collisionPadding={8}
            >
              <Combobox.Popup className={popupClasses}>
                <Combobox.Input
                  className="app-select-search"
                  placeholder={search.placeholder}
                  aria-label={search.placeholder}
                />
                <Combobox.Empty className="app-select-empty">
                  {search.empty}
                </Combobox.Empty>
                <Combobox.List className="app-select-list">
                  {(option: SelectOption) => (
                    <Combobox.Item
                      key={option.value}
                      className="app-select-option"
                      value={option}
                      disabled={option.disabled}
                      onMouseEnter={(event) =>
                        revealClippedText(event.currentTarget, option)
                      }
                    >
                      {optionBody(
                        option,
                        <span className="app-select-option-label">
                          {option.label}
                        </span>,
                      )}
                      <Combobox.ItemIndicator className="app-select-indicator">
                        <Check size={14} />
                      </Combobox.ItemIndicator>
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Positioner>
          </Combobox.Portal>
        </Combobox.Root>
      );

    return (
      <SelectPrimitive.Root
        id={id}
        disabled={disabled}
        items={options}
        open={open}
        onOpenChange={setOpen}
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue !== null) onValueChange(nextValue);
        }}
      >
        <SelectPrimitive.Trigger
          {...props}
          ref={triggerRef}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (!event.defaultPrevented) handleTab(event);
          }}
          className={triggerClassName}
        >
          {startIconNode}
          <SelectPrimitive.Value className="app-select-value">
            {valueLabel}
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon className="app-select-chevron">
            <ChevronDown />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal
          onPointerDown={(event) => event.stopPropagation()}
        >
          <SelectPrimitive.Positioner
            className="app-select-positioner"
            onPointerDown={(event) => event.stopPropagation()}
            sideOffset={5}
            align="start"
            positionMethod="fixed"
            collisionPadding={8}
            alignItemWithTrigger={false}
          >
            <SelectPrimitive.Popup
              className={popupClasses}
              onKeyDown={handleTab}
            >
              <SelectPrimitive.List className="app-select-list">
                {options.map((option) => (
                  <SelectPrimitive.Item
                    key={option.value}
                    className="app-select-option"
                    value={option.value}
                    disabled={option.disabled}
                    onMouseEnter={(event) =>
                      revealClippedText(event.currentTarget, option)
                    }
                  >
                    {optionBody(
                      option,
                      <SelectPrimitive.ItemText className="app-select-option-label">
                        {option.label}
                      </SelectPrimitive.ItemText>,
                    )}
                    <SelectPrimitive.ItemIndicator className="app-select-indicator">
                      <Check size={14} />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.List>
            </SelectPrimitive.Popup>
          </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    );
  },
);
