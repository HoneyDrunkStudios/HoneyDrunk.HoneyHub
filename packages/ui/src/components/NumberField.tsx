import type { ReactElement } from "react";

export interface NumberFieldProps {
  /** Held as a string so callers can keep free-text state (empty / "none"). */
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  /** Increment for the +/- buttons (default 1). Typing still allows any value. */
  step?: number;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * A themed number stepper: −  [ input ]  + . Replaces the native `<input type="number">`
 * spinner (which clashes with the dark theme) with consistent, friendly controls. The native
 * spinner is hidden via CSS; typing is still allowed, the buttons step by `step`.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
  ariaLabel,
  className
}: Readonly<NumberFieldProps>): ReactElement {
  const current = Number.parseFloat(value);

  const adjust = (delta: number): void => {
    const base = Number.isFinite(current) ? current : (min ?? 0);
    let next = base + delta;
    if (min !== undefined) {
      next = Math.max(min, next);
    }
    if (max !== undefined) {
      next = Math.min(max, next);
    }
    // Round away float noise (e.g. 0.1 + 0.2) for clean values.
    next = Math.round(next * 1e6) / 1e6;
    onChange(String(next));
  };

  const atMin = min !== undefined && Number.isFinite(current) && current <= min;
  const atMax = max !== undefined && Number.isFinite(current) && current >= max;

  return (
    <span className={`number-field ${className ?? ""}`}>
      <button
        type="button"
        className="number-step"
        aria-label="Decrease"
        tabIndex={-1}
        disabled={atMin}
        onClick={() => adjust(-step)}
      >
        −
      </button>
      <input
        type="number"
        className="number-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...(step !== undefined ? { step } : {})}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
      />
      <button
        type="button"
        className="number-step"
        aria-label="Increase"
        tabIndex={-1}
        disabled={atMax}
        onClick={() => adjust(step)}
      >
        +
      </button>
    </span>
  );
}
