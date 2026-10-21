import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon } from './Icons';

export interface RoundedSelectOption {
  value: string;
  label: string;
  title?: string;
}

interface RoundedSelectProps {
  value: string;
  options: RoundedSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  tone?: 'mauve' | 'green' | 'blue';
}

interface TooltipState {
  text: string;
  top: number;
  left: number;
  side: 'right' | 'left';
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
}

function joinClassNames(...classNames: Array<string | false | null | undefined>) {
  return classNames.filter(Boolean).join(' ');
}

export const RoundedSelect: React.FC<RoundedSelectProps> = ({
  value,
  options,
  onChange,
  disabled = false,
  className,
  placeholder = '',
  tone = 'mauve'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toneClasses = {
    mauve: {
      trigger: 'border-accent-mauve/40 bg-accent-mauve/5',
      option: 'border border-accent-mauve/30 bg-accent-mauve/10 text-accent-mauve'
    },
    green: {
      trigger: 'border-accent-green/40 bg-accent-green/5',
      option: 'border border-accent-green/30 bg-accent-green/10 text-accent-green'
    },
    blue: {
      trigger: 'border-accent-blue/40 bg-accent-blue/5',
      option: 'border border-accent-blue/30 bg-accent-blue/10 text-accent-blue'
    }
  } as const;

  const selectedOption = useMemo(
    () => options.find(option => option.value === value),
    [options, value]
  );

  const updateMenuPosition = () => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    setMenuPosition({
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width
    });
  };

  useEffect(() => {
    if (!isOpen) return;

    updateMenuPosition();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [isOpen]);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
      setTooltip(null);
      setMenuPosition(null);
    }
  }, [disabled]);

  useEffect(() => {
    if (!tooltip) return;

    const hideTooltip = () => setTooltip(null);
    window.addEventListener('scroll', hideTooltip, true);
    window.addEventListener('resize', hideTooltip);

    return () => {
      window.removeEventListener('scroll', hideTooltip, true);
      window.removeEventListener('resize', hideTooltip);
    };
  }, [tooltip]);

  const showTooltip = (event: React.MouseEvent<HTMLElement>, text?: string) => {
    if (!text) {
      setTooltip(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const tooltipWidth = 220;
    const fitsRight = rect.right + 8 + tooltipWidth <= window.innerWidth - 12;

    setTooltip({
      text,
      top: rect.top + rect.height / 2,
      left: fitsRight ? rect.right + 8 : rect.left - 8,
      side: fitsRight ? 'right' : 'left'
    });
  };

  const hideTooltip = () => setTooltip(null);

  return (
    <>
      <div
        ref={containerRef}
        className={joinClassNames('relative inline-block', disabled && 'cursor-not-allowed', className)}
        onMouseEnter={event => !isOpen && showTooltip(event, selectedOption?.title)}
        onMouseMove={event => !isOpen && showTooltip(event, selectedOption?.title)}
        onMouseLeave={hideTooltip}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => setIsOpen(current => !current)}
          className={joinClassNames(
            'flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-text-primary outline-none transition-all duration-150',
            disabled
              ? 'pointer-events-none opacity-50'
              : joinClassNames('hover:border-border-hover hover:bg-[var(--layer-hover)]', isOpen && toneClasses[tone].trigger)
          )}
        >
          <span className="truncate">{selectedOption?.label ?? placeholder}</span>
          <ChevronDownIcon className={joinClassNames('h-4 w-4 shrink-0 text-text-muted transition-transform duration-150', isOpen && 'rotate-180')} />
        </button>

        {isOpen && !disabled && (
          menuPosition && createPortal(
            <div
              ref={menuRef}
              className="fixed z-[10000] overflow-hidden rounded-xl border border-border bg-surface shadow-[0_12px_30px_rgba(0,0,0,0.35)]"
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
                width: menuPosition.width
              }}
            >
              <div className="max-h-56 overflow-y-auto p-1">
                {options.map(option => {
                  const isSelected = option.value === value;

                  return (
                    <button
                      type="button"
                      key={option.value}
                      onMouseEnter={event => showTooltip(event, option.title)}
                      onMouseMove={event => showTooltip(event, option.title)}
                      onMouseLeave={hideTooltip}
                      onClick={() => {
                        onChange(option.value);
                        setIsOpen(false);
                        setTooltip(null);
                      }}
                      className={joinClassNames(
                        'flex w-full items-center rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-all duration-150',
                        isSelected
                          ? toneClasses[tone].option
                          : 'text-text-secondary hover:border-border hover:bg-[var(--layer-hover)] hover:text-text-primary'
                      )}
                    >
                      <span className="truncate">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body
          )
        )}
      </div>

      {tooltip && createPortal(
        <div
          className="pointer-events-none fixed z-[10010] max-w-[220px] animate-fade-in rounded-2xl border border-border bg-surface-overlay/95 px-3 py-2 text-xs font-medium text-text-primary shadow-xl shadow-black/30 backdrop-blur-sm whitespace-nowrap"
          style={{
            top: tooltip.top,
            left: tooltip.left,
            transform: tooltip.side === 'right' ? 'translateY(-50%)' : 'translate(-100%, -50%)'
          }}
        >
          {tooltip.text}
        </div>,
        document.body
      )}
    </>
  );
};
