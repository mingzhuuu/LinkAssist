import React, { useCallback, useRef } from 'react';
import { Canvas as CanvasType } from '../../types';
import type { CanvasChannelLink, Channel } from '../../types';
import { useChannelStore } from '../../stores';
import { ResizeEdge } from './useCanvasInteraction';
import { CanvasIngestStatus } from './CanvasIngestStatus';

function isHighContrastCanvasMode(): boolean {
  const root = document.documentElement;
  return root.classList.contains('high-contrast') || root.classList.contains('high-contrast-light');
}

function getCanvasFallbackColor(): string {
  const root = document.documentElement;
  if (root.classList.contains('high-contrast')) return 'rgb(255, 255, 255)';
  if (root.classList.contains('high-contrast-light')) return 'rgb(0, 0, 0)';
  return root.classList.contains('dark') ? 'rgb(68, 68, 68)' : 'rgb(209, 213, 219)';
}

// getComputedStyle forces a style recalc; during canvas drags this runs per
// channel per frame, so cache per theme state (class list + inline overrides).
let accentCacheKey = '';
const accentCache = new Map<string, [number, number, number]>();

function getThemeAccentChannels(
  variable: string,
  fallback: [number, number, number],
): [number, number, number] {
  const root = document.documentElement;
  const themeKey = `${root.className}|${root.getAttribute('style') ?? ''}`;
  if (themeKey !== accentCacheKey) {
    accentCache.clear();
    accentCacheKey = themeKey;
  }
  const cached = accentCache.get(variable);
  if (cached) return cached;

  const value = window.getComputedStyle(root).getPropertyValue(variable).trim();
  const channels = value.split(/\s+/).map(Number);
  const resolved: [number, number, number] =
    channels.length === 3 && channels.every(Number.isFinite)
      ? [channels[0], channels[1], channels[2]]
      : fallback;
  accentCache.set(variable, resolved);
  return resolved;
}

export function computeCanvasBorderColor(channels: CanvasChannelLink[], allChannels: Channel[]): string {
  const fallback = getCanvasFallbackColor();

  if (!channels || channels.length === 0) return fallback;

  let r = 0, g = 0, b = 0;
  let count = 0;

  for (const link of channels) {
    const channel = allChannels.find((c) => c.id === link.channelId);
    if (channel) {
      count++;
      switch (channel.type) {
        case 'ble': {
          const [red, green, blue] = getThemeAccentChannels('--accent-blue', [91, 155, 245]);
          r += red; g += green; b += blue;
          break;
        }
        case 'serial': {
          const [red, green, blue] = getThemeAccentChannels('--accent-mauve', [167, 139, 250]);
          r += red; g += green; b += blue;
          break;
        }
        case 'tcp': {
          const [red, green, blue] = getThemeAccentChannels('--accent-green', [74, 222, 128]);
          r += red; g += green; b += blue;
          break;
        }
      }
    }
  }

  if (count === 0) return fallback;

  return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
}

interface CanvasProps {
  canvas: CanvasType;
  onMouseDownMove: (e: React.MouseEvent, canvasId: string) => void;
  onResizeStart: (e: React.MouseEvent, canvasId: string, edge: ResizeEdge) => void;
  onContextMenu: (e: React.MouseEvent, canvasId: string) => void;
  onDoubleClickRight: (canvasId: string) => void;
  onDoubleClickLeft: (canvasId: string) => void;
  onSelect: (canvasId: string) => void;
  onPrimaryMouseDown: (canvasId: string) => void;
  isMoving?: boolean;
  isSelected?: boolean;
  roundMaximizedTopLeft?: boolean;
  roundMaximizedBottomRight?: boolean;
  seamlessMaximized?: boolean;
  children: React.ReactNode;
}

export const CanvasContainer: React.FC<CanvasProps> = ({
  canvas,
  onMouseDownMove,
  onResizeStart,
  onContextMenu,
  onDoubleClickRight,
  onDoubleClickLeft,
  onSelect,
  onPrimaryMouseDown,
  isMoving = false,
  isSelected = false,
  roundMaximizedTopLeft = false,
  roundMaximizedBottomRight = false,
  seamlessMaximized = false,
  children,
}) => {
  const allChannels = useChannelStore((state) => state.channels);
  const lastRightClickTime = useRef(0);
  const rightDownPos = useRef<{ x: number; y: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      onSelect(canvas.id);
      onPrimaryMouseDown(canvas.id);
      if (!e.ctrlKey) {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.detail >= 2) {
        onDoubleClickLeft(canvas.id);
      } else {
        onMouseDownMove(e, canvas.id);
      }
    } else if (e.button === 2) {
      e.stopPropagation();
      rightDownPos.current = { x: e.clientX, y: e.clientY };
    }
  }, [canvas.id, onMouseDownMove, onDoubleClickLeft, onPrimaryMouseDown, onSelect]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      e.stopPropagation();
    }
  }, []);

  const handleContextMenuNative = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(canvas.id);

    const pos = rightDownPos.current;
    const dx = pos ? Math.abs(e.clientX - pos.x) : 0;
    const dy = pos ? Math.abs(e.clientY - pos.y) : 0;

    if (dx < 6 && dy < 6) {
      const now = Date.now();
      if (now - lastRightClickTime.current < 400) {
        onDoubleClickRight(canvas.id);
        lastRightClickTime.current = 0;
      } else {
        lastRightClickTime.current = now;
        onContextMenu(e, canvas.id);
      }
    }
  }, [canvas.id, onContextMenu, onDoubleClickRight, onSelect]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent, edge: ResizeEdge) => {
    e.preventDefault();
    e.stopPropagation();
    onResizeStart(e, canvas.id, edge);
  }, [canvas.id, onResizeStart]);

  const computedColor = computeCanvasBorderColor(canvas.config.channels || [], allChannels);
  const highContrast = isHighContrastCanvasMode();
  const grayColor = getCanvasFallbackColor();
  // Active → channel color (or gray if none); Inactive → always gray
  const effectiveColor = canvas.active ? computedColor : grayColor;
  const getRgba = (color: string, alpha: number) => color.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
  const borderAlpha = highContrast
    ? isSelected
      ? 1
      : isMoving
      ? 0.9
      : canvas.active
      ? 0.85
      : 1
    : isSelected
    ? 0.85
    : isMoving
    ? 0.5
    : canvas.active
    ? 0.3
    : 0.5;
  const usesOuterFrame = canvas.maximized && seamlessMaximized;
  const cornerClassName = !usesOuterFrame && canvas.maximized && roundMaximizedBottomRight
    ? 'rounded-br-xl'
    : 'rounded-none';
  const borderClassName = usesOuterFrame
    ? 'border-0'
    : 'border';
  const sharedTopLeftEdgeClassName = !usesOuterFrame && canvas.maximized && roundMaximizedTopLeft
    ? 'border-t-0 border-l-0'
    : '';

  return (
    <div
      className={`absolute overflow-hidden flex flex-col ${borderClassName} ${cornerClassName} ${sharedTopLeftEdgeClassName} ${
        isMoving
          ? 'shadow-xl opacity-90'
          : isSelected
          ? 'shadow-lg'
          : canvas.active
          ? 'shadow-lg transition-shadow'
          : 'transition-shadow'
      }`}
      style={{
        left: canvas.rect.x,
        top: canvas.rect.y,
        width: canvas.rect.width,
        height: canvas.rect.height,
        zIndex: canvas.zIndex,
        borderColor: getRgba(effectiveColor, borderAlpha),
        boxShadow: isMoving
          ? `0 20px 25px -5px ${getRgba(effectiveColor, 0.3)}, 0 8px 10px -6px ${getRgba(effectiveColor, 0.3)}`
          : isSelected
          ? `0 0 0 1px ${getRgba(effectiveColor, 0.6)}, 0 10px 15px -3px ${getRgba(effectiveColor, 0.25)}, 0 4px 6px -4px ${getRgba(effectiveColor, 0.25)}`
          : canvas.active
          ? `0 10px 15px -3px ${getRgba(effectiveColor, 0.2)}, 0 4px 6px -4px ${getRgba(effectiveColor, 0.2)}`
          : 'none',
      }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenuNative}
    >
      {/* Content */}
      <div
        className="flex-1 min-h-0 bg-surface overflow-hidden relative cursor-move rounded-none"
      >
        {children}
        <CanvasIngestStatus canvasId={canvas.id} />
      </div>

      {/* Resize handles — edges (4px thick strips) */}
      <div className="absolute top-0 left-1 right-1 h-1 cursor-n-resize z-20" onMouseDown={(e) => handleResizeMouseDown(e, 'n')} />
      <div className="absolute bottom-0 left-1 right-1 h-1 cursor-s-resize z-20" onMouseDown={(e) => handleResizeMouseDown(e, 's')} />
      <div className="absolute left-0 top-1 bottom-1 w-1 cursor-w-resize z-20" onMouseDown={(e) => handleResizeMouseDown(e, 'w')} />
      <div className="absolute right-0 top-1 bottom-1 w-1 cursor-e-resize z-20" onMouseDown={(e) => handleResizeMouseDown(e, 'e')} />

      {/* Resize handles — corners (8x8 squares) */}
      <div className="absolute top-0 left-0 w-2 h-2 cursor-nw-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, 'nw')} />
      <div className="absolute top-0 right-0 w-2 h-2 cursor-ne-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, 'ne')} />
      <div className="absolute bottom-0 left-0 w-2 h-2 cursor-sw-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, 'sw')} />
      <div className="absolute bottom-0 right-0 w-2 h-2 cursor-se-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, 'se')} />
    </div>
  );
};
