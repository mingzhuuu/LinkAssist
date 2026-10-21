import type { CanvasRect } from '../../types';

export const VIEWPORT_SCROLL_PADDING = 80;
export const CANVAS_SCROLLBAR_Z_INDEX = 2147483640;
const FALLBACK_PAGE_DELTA = 120;
const LINE_DELTA_PX = 16;
const MAX_WHEEL_DELTA_PX = 240;

export interface ViewportTransform {
  offsetX: number;
  offsetY: number;
}

export interface ScrollBounds {
  minScrollX: number;
  maxScrollX: number;
  minScrollY: number;
  maxScrollY: number;
}

export interface CanvasScrollBoundsTarget {
  rect: CanvasRect;
  maximized: boolean;
}

export function buildViewportTransform(
  scrollX: number,
  scrollY: number,
): ViewportTransform {
  return {
    offsetX: scrollX,
    offsetY: scrollY,
  };
}

export function worldToDisplayRect(rect: CanvasRect, transform: ViewportTransform): CanvasRect {
  return {
    x: rect.x - transform.offsetX,
    y: rect.y - transform.offsetY,
    width: rect.width,
    height: rect.height,
  };
}

export function displayToWorldRect(rect: CanvasRect, transform: ViewportTransform): CanvasRect {
  return {
    x: rect.x + transform.offsetX,
    y: rect.y + transform.offsetY,
    width: rect.width,
    height: rect.height,
  };
}

export function getCanvasScrollBounds(
  canvases: CanvasScrollBoundsTarget[],
  viewportWidth: number,
  viewportHeight: number,
  padding = VIEWPORT_SCROLL_PADDING,
): ScrollBounds {
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return { minScrollX: 0, maxScrollX: 0, minScrollY: 0, maxScrollY: 0 };
  }

  let maxRight = viewportWidth;
  let maxBottom = viewportHeight;
  let hasFreeformCanvas = false;

  canvases.forEach((canvas) => {
    if (canvas.maximized) {
      return;
    }

    hasFreeformCanvas = true;
    maxRight = Math.max(maxRight, canvas.rect.x + canvas.rect.width);
    maxBottom = Math.max(maxBottom, canvas.rect.y + canvas.rect.height);
  });

  if (!hasFreeformCanvas) {
    return { minScrollX: 0, maxScrollX: 0, minScrollY: 0, maxScrollY: 0 };
  }

  const maxScrollX = maxRight > viewportWidth ? maxRight + padding - viewportWidth : 0;
  const maxScrollY = maxBottom > viewportHeight ? maxBottom + padding - viewportHeight : 0;

  return { minScrollX: 0, maxScrollX, minScrollY: 0, maxScrollY };
}

export function clampScrollX(scrollX: number, bounds: ScrollBounds): number {
  return Math.min(Math.max(scrollX, bounds.minScrollX), bounds.maxScrollX);
}

export function clampScrollY(scrollY: number, bounds: ScrollBounds): number {
  return Math.min(Math.max(scrollY, bounds.minScrollY), bounds.maxScrollY);
}

export function normalizeWheelDeltaX(deltaX: number, deltaMode: number, viewportWidth: number): number {
  let normalized = deltaX;

  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    normalized *= LINE_DELTA_PX;
  } else if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    normalized *= viewportWidth > 0 ? viewportWidth : FALLBACK_PAGE_DELTA;
  }

  const magnitude = Math.min(Math.abs(normalized), MAX_WHEEL_DELTA_PX);
  return Math.sign(normalized) * magnitude;
}

export function normalizeWheelDeltaY(deltaY: number, deltaMode: number, viewportHeight: number): number {
  let normalized = deltaY;

  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    normalized *= LINE_DELTA_PX;
  } else if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    normalized *= viewportHeight > 0 ? viewportHeight : FALLBACK_PAGE_DELTA;
  }

  const magnitude = Math.min(Math.abs(normalized), MAX_WHEEL_DELTA_PX);
  return Math.sign(normalized) * magnitude;
}
