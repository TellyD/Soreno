import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import "./Input.css";

type InputSize = "small" | "medium" | "large";

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  endIcon?: ReactNode;
  inputClassName?: string;
  size?: InputSize;
  startIcon?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      disabled,
      endIcon,
      inputClassName,
      size = "medium",
      startIcon,
      ...props
    },
    ref,
  ) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const rootClasses = [
      "app-input",
      `app-input-${size}`,
      disabled ? "app-input-disabled" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const inputClasses = ["app-input-element", inputClassName]
      .filter(Boolean)
      .join(" ");

    useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    function handleMouseDown(event: MouseEvent<HTMLSpanElement>) {
      if (event.target === inputRef.current) {
        return;
      }

      event.preventDefault();
      inputRef.current?.focus();
    }

    return (
      <span className={rootClasses} onMouseDown={handleMouseDown}>
        {startIcon ? <span className="app-input-icon">{startIcon}</span> : null}
        <input
          className={inputClasses}
          disabled={disabled}
          ref={inputRef}
          {...props}
        />
        {endIcon ? <span className="app-input-icon">{endIcon}</span> : null}
      </span>
    );
  },
);

Input.displayName = "Input";
