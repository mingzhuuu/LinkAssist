import type { CanvasRect } from '../../types';
import type { SnapZone } from './useCanvasInteraction';

export const CANVAS_CORNER_RADIUS_CLASS = 'rounded-xl';
export const CANVAS_CORNER_ABUT_THRESHOLD = 2;

export interface CanvasCornerState {
  topLeft: boolean;
  topRight: boolean;
  bottomLeft: boolean;
  bottomRight: boolean;
}

export interface CanvasCornerOptions {
  maximized?: boolean;
  usesOuterFrame?: boolean;
  roundMaximizedTopLeft?: boolean;
  roundMaximizedBottomRight?: boolean;
  threshold?: number;
}

/**
 * Determines which of the 4 corners should be rounded (true) vs flattened (false)
 * based on whether adjacent canvases touch/abut each corner, or whether the canvas is maximized.
 */
export function computeCanvasCornerState(
  canvasRect: CanvasRect,
  adjacentRects: CanvasRect[] = [],
  options: CanvasCornerOptions = {},
): CanvasCornerState {
  if (options.maximized) {
    if (options.usesOuterFrame) {
      return { topLeft: false, topRight: false, bottomLeft: false, bottomRight: false };
    }
    return {
      topLeft: false,
      topRight: false,
      bottomLeft: false,
      bottomRight: Boolean(options.roundMaximizedBottomRight),
    };
  }

  const threshold = options.threshold ?? CANVAS_CORNER_ABUT_THRESHOLD;
  let topLeft = true;
  let topRight = true;
  let bottomLeft = true;
  let bottomRight = true;

  const left = canvasRect.x;
  const right = canvasRect.x + canvasRect.width;
  const top = canvasRect.y;
  const bottom = canvasRect.y + canvasRect.height;

  for (const other of adjacentRects) {
    const oLeft = other.x;
    const oRight = other.x + other.width;
    const oTop = other.y;
    const oBottom = other.y + other.height;

    // Check horizontal abutment: other is immediately to the left
    if (Math.abs(oRight - left) <= threshold) {
      if (oTop <= top + threshold && oBottom >= top + threshold) {
        topLeft = false;
      }
      if (oTop <= bottom - threshold && oBottom >= bottom - threshold) {
        bottomLeft = false;
      }
    }

    // Check horizontal abutment: other is immediately to the right
    if (Math.abs(oLeft - right) <= threshold) {
      if (oTop <= top + threshold && oBottom >= top + threshold) {
        topRight = false;
      }
      if (oTop <= bottom - threshold && oBottom >= bottom - threshold) {
        bottomRight = false;
      }
    }

    // Check vertical abutment: other is immediately above
    if (Math.abs(oBottom - top) <= threshold) {
      if (oLeft <= left + threshold && oRight >= left + threshold) {
        topLeft = false;
      }
      if (oLeft <= right - threshold && oRight >= right - threshold) {
        topRight = false;
      }
    }

    // Check vertical abutment: other is immediately below
    if (Math.abs(oTop - bottom) <= threshold) {
      if (oLeft <= left + threshold && oRight >= left + threshold) {
        bottomLeft = false;
      }
      if (oLeft <= right - threshold && oRight >= right - threshold) {
        bottomRight = false;
      }
    }
  }

  return { topLeft, topRight, bottomLeft, bottomRight };
}

/**
 * Converts a CanvasCornerState into Tailwind border-radius classes.
 */
export function getCornerClassNames(corners: CanvasCornerState): string {
  const { topLeft, topRight, bottomLeft, bottomRight } = corners;

  if (topLeft && topRight && bottomLeft && bottomRight) {
    return 'rounded-xl';
  }
  if (!topLeft && !topRight && !bottomLeft && !bottomRight) {
    return 'rounded-none';
  }
  if (topLeft && topRight && !bottomLeft && !bottomRight) {
    return 'rounded-t-xl rounded-b-none';
  }
  if (bottomLeft && bottomRight && !topLeft && !topRight) {
    return 'rounded-b-xl rounded-t-none';
  }
  if (topLeft && bottomLeft && !topRight && !bottomRight) {
    return 'rounded-l-xl rounded-r-none';
  }
  if (topRight && bottomRight && !topLeft && !bottomLeft) {
    return 'rounded-r-xl rounded-l-none';
  }

  const classes: string[] = [];
  classes.push(topLeft ? 'rounded-tl-xl' : 'rounded-tl-none');
  classes.push(topRight ? 'rounded-tr-xl' : 'rounded-tr-none');
  classes.push(bottomLeft ? 'rounded-bl-xl' : 'rounded-bl-none');
  classes.push(bottomRight ? 'rounded-br-xl' : 'rounded-br-none');
  return classes.join(' ');
}

/**
 * Computes corner class names for snap previews, taking into account the snap zone
 * or adjacent canvases.
 */
export function getSnapPreviewCornerClassNames(
  zone: SnapZone['zone'],
  rect?: CanvasRect | null,
  adjacentRects: CanvasRect[] = [],
): string {
  switch (zone) {
    case 'left':
      return 'rounded-l-xl rounded-r-none';
    case 'right':
      return 'rounded-r-xl rounded-l-none';
    case 'top':
      return 'rounded-t-xl rounded-b-none';
    case 'bottom':
      return 'rounded-b-xl rounded-t-none';
    case 'left-top':
      return 'rounded-tl-xl rounded-tr-none rounded-bl-none rounded-br-none';
    case 'right-top':
      return 'rounded-tr-xl rounded-tl-none rounded-bl-none rounded-br-none';
    case 'left-bottom':
      return 'rounded-bl-xl rounded-tl-none rounded-tr-none rounded-br-none';
    case 'right-bottom':
      return 'rounded-br-xl rounded-tl-none rounded-tr-none rounded-bl-none';
    case 'full':
      return 'rounded-none';
    default:
      if (rect) {
        return getCornerClassNames(computeCanvasCornerState(rect, adjacentRects));
      }
      return 'rounded-xl';
  }
}
