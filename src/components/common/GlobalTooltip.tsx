import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipState {
  text: string;
  x: number;
  y: number;
  transform: string;
}

export const GlobalTooltip: React.FC = () => {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const activeElementRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const isVisibleRef = useRef(false);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const restoreTitle = (el: HTMLElement | null) => {
      if (!el) return;
      const savedTitle = el.getAttribute('data-title');
      if (savedTitle !== null) {
        el.setAttribute('title', savedTitle);
        el.removeAttribute('data-title');
      }
    };

    const hide = () => {
      clearTimer();
      setTooltip(null);
      isVisibleRef.current = false;
      if (activeElementRef.current) {
        restoreTitle(activeElementRef.current);
        activeElementRef.current = null;
      }
    };

    const handleMouseOver = (event: MouseEvent) => {
      const el = event.target as HTMLElement | null;
      if (!el) return;

      const target = el.closest<HTMLElement>('[title], [data-tooltip], [data-title]');
      if (!target || target.hasAttribute('data-no-tooltip')) {
        hide();
        return;
      }

      // If moving within the same target and already visible, do nothing
      if (activeElementRef.current === target && isVisibleRef.current) {
        return;
      }

      // Restore previous element's title if different
      if (activeElementRef.current && activeElementRef.current !== target) {
        restoreTitle(activeElementRef.current);
      }

      activeElementRef.current = target;

      let text = target.getAttribute('data-tooltip') || '';
      if (target.hasAttribute('title')) {
        const rawTitle = target.getAttribute('title');
        if (rawTitle && rawTitle.trim()) {
          text = rawTitle.trim();
          target.setAttribute('data-title', rawTitle);
          if (!target.hasAttribute('aria-label')) {
            target.setAttribute('aria-label', rawTitle);
          }
        }
        target.removeAttribute('title');
      } else if (target.hasAttribute('data-title')) {
        text = target.getAttribute('data-title')?.trim() || '';
      }

      if (!text) {
        hide();
        return;
      }

      clearTimer();

      const show = () => {
        if (!activeElementRef.current || !document.contains(activeElementRef.current)) {
          hide();
          return;
        }

        const rect = activeElementRef.current.getBoundingClientRect();
        const margin = 6;
        const isNearTop = rect.top < 50;

        let y: number;
        let transformY: string;

        if (isNearTop) {
          y = rect.bottom + margin;
          transformY = '0';
        } else {
          y = rect.top - margin;
          transformY = '-100%';
        }

        let x: number;
        let transformX: string;
        const centerX = rect.left + rect.width / 2;

        if (centerX < 80) {
          x = Math.max(8, rect.left);
          transformX = '0';
        } else if (centerX > window.innerWidth - 80) {
          x = Math.min(window.innerWidth - 8, rect.right);
          transformX = '-100%';
        } else {
          x = centerX;
          transformX = '-50%';
        }

        setTooltip({
          text,
          x,
          y,
          transform: `translate(${transformX}, ${transformY})`,
        });
        isVisibleRef.current = true;
      };

      const delay = isVisibleRef.current ? 40 : 180;
      timerRef.current = window.setTimeout(show, delay);
    };

    const handleMouseOut = (event: MouseEvent) => {
      if (!activeElementRef.current) return;
      const related = event.relatedTarget as Node | null;
      if (!related || !activeElementRef.current.contains(related)) {
        hide();
      }
    };

    const handleMouseDown = () => {
      hide();
    };

    const handleScroll = () => {
      hide();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hide();
      }
    };

    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('blur', hide);
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      clearTimer();
      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('mouseout', handleMouseOut, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('blur', hide);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (activeElementRef.current) {
        restoreTitle(activeElementRef.current);
      }
    };
  }, []);

  if (!tooltip) return null;

  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[99999] max-w-xs animate-fade-in rounded-2xl border border-border bg-surface-overlay/95 px-3 py-1.5 text-xs font-medium text-text-primary shadow-xl shadow-black/30 backdrop-blur-sm whitespace-pre-line leading-snug"
      style={{
        left: tooltip.x,
        top: tooltip.y,
        transform: tooltip.transform,
      }}
    >
      {tooltip.text}
    </div>,
    document.body
  );
};
