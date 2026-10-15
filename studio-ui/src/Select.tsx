import {useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent} from 'react';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  meta?: string;
  tone?: 'open' | 'muted';
}

interface SelectProps<T extends string | number> {
  value: T;
  options: SelectOption<T>[];
  onChange(value: T): void;
  label: string;
  placement?: 'down' | 'up';
  align?: 'start' | 'end';
  disabled?: boolean;
  className?: string;
}

export function Select<T extends string | number>({value, options, onChange, label, placement = 'down', align = 'start', disabled, className}: SelectProps<T>) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selectedIndex);
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block: 'nearest'});
  }, [open, active]);

  const show = (index = selectedIndex) => {
    setActive(index);
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    close();
  };

  const onTriggerKey = (event: ReactKeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      show(event.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1) : selectedIndex);
    }
  };

  const onListKey = (event: ReactKeyboardEvent) => {
    const last = options.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(last, active + 1),
      ArrowUp: () => Math.max(0, active - 1),
      Home: () => 0,
      End: () => last,
      PageDown: () => Math.min(last, active + 5),
      PageUp: () => Math.max(0, active - 5),
    };
    if (moves[event.key]) {
      event.preventDefault();
      setActive(moves[event.key]());
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close(false);
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      const key = event.key.toLowerCase();
      const order = [...options.slice(active + 1), ...options.slice(0, active + 1)];
      const match = order.find((o) => o.label.toLowerCase().startsWith(key));
      if (match) setActive(options.indexOf(match));
    }
  };

  return (
    <div ref={rootRef} className={`select${className ? ` ${className}` : ''}`} data-select>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${label}: ${selected?.label ?? 'none'}`}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
      >
        <span className="select-value">{selected?.label ?? '—'}</span>
        {selected?.meta && <span className={`select-meta ${selected.tone ?? 'muted'}`}>{selected.meta}</span>}
        <svg className="select-chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden>
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul
          ref={listRef}
          id={`${id}-list`}
          className={`select-menu ${placement} ${align}`}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onListKey}
        >
          {options.map((option, index) => (
            <li
              key={String(option.value)}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              aria-selected={option.value === value}
              className="select-option"
              data-active={index === active || undefined}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <svg className="select-check" viewBox="0 0 14 14" width="14" height="14" aria-hidden>
                <path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="select-label">{option.label}</span>
              {option.meta && <span className={`select-meta ${option.tone ?? 'muted'}`}>{option.meta}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
