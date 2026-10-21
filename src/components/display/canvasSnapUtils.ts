import type { CanvasRect } from '../../types';
import type { ResizeEdge } from './useCanvasInteraction';
import { useUIStore } from '../../stores';

export const CANVAS_ATTACH_THRESHOLD = 12;
export const MIN_CANVAS_SIZE = 40;

export interface CanvasAttachSnap {
  rect: CanvasRect;
  snapped: boolean;
}

export function getChannelPanelRightWin(container: HTMLElement | null): number {
  const contentArea = container?.closest('[data-content-area]');
  if (contentArea) {
    return contentArea.getBoundingClientRect().left;
  }
  const uiState = useUIStore.getState();
  const effectiveChannelPanelVisible = !uiState.simpleMode && uiState.channelPanelVisible;
  return effectiveChannelPanelVisible ? uiState.leftPanelWidth : 0;
}

export function rangesOverlapOrNear(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  threshold: number = CANVAS_ATTACH_THRESHOLD,
): boolean {
  return Math.min(aEnd, bEnd) >= Math.max(aStart, bStart) - threshold;
}

export function isCanvasAttached(
  rectA: CanvasRect,
  rectB: CanvasRect,
  threshold: number = CANVAS_ATTACH_THRESHOLD,
): boolean {
  const aRight = rectA.x + rectA.width;
  const aBottom = rectA.y + rectA.height;
  const bRight = rectB.x + rectB.width;
  const bBottom = rectB.y + rectB.height;

  // Vertical abutment: top touches bottom or bottom touches top
  const touchesVertically =
    Math.abs(rectA.y - bBottom) <= threshold ||
    Math.abs(aBottom - rectB.y) <= threshold;
  const overlapsHorizontally = rangesOverlapOrNear(
    rectA.x,
    aRight,
    rectB.x,
    bRight,
    threshold,
  );
  if (touchesVertically && overlapsHorizontally) {
    return true;
  }

  // Horizontal abutment: left touches right or right touches left
  const touchesHorizontally =
    Math.abs(rectA.x - bRight) <= threshold ||
    Math.abs(aRight - rectB.x) <= threshold;
  const overlapsVertically = rangesOverlapOrNear(
    rectA.y,
    aBottom,
    rectB.y,
    bBottom,
    threshold,
  );
  if (touchesHorizontally && overlapsVertically) {
    return true;
  }

  return false;
}

export function getCanvasAttachSnapRect(
  movingRect: CanvasRect,
  targetRects: CanvasRect[],
  threshold: number = CANVAS_ATTACH_THRESHOLD,
): CanvasAttachSnap {
  let snapX = movingRect.x;
  let snapY = movingRect.y;
  let bestXDistance = threshold + 1;
  let bestYDistance = threshold + 1;

  const movingRight = movingRect.x + movingRect.width;
  const movingBottom = movingRect.y + movingRect.height;

  for (const target of targetRects) {
    const targetRight = target.x + target.width;
    const targetBottom = target.y + target.height;
    const verticalOverlap = rangesOverlapOrNear(
      movingRect.y,
      movingBottom,
      target.y,
      targetBottom,
      threshold,
    );
    const horizontalOverlap = rangesOverlapOrNear(
      movingRect.x,
      movingRight,
      target.x,
      targetRight,
      threshold,
    );

    if (verticalOverlap) {
      const candidates = [
        target.x - movingRect.width,
        targetRight,
        target.x,
        targetRight - movingRect.width,
      ];

      for (const candidate of candidates) {
        const distance = Math.abs(candidate - movingRect.x);
        if (distance <= threshold && distance < bestXDistance) {
          bestXDistance = distance;
          snapX = candidate;
        }
      }
    }

    if (horizontalOverlap) {
      const candidates = [
        target.y - movingRect.height,
        targetBottom,
        target.y,
        targetBottom - movingRect.height,
      ];

      for (const candidate of candidates) {
        const distance = Math.abs(candidate - movingRect.y);
        if (distance <= threshold && distance < bestYDistance) {
          bestYDistance = distance;
          snapY = candidate;
        }
      }
    }
  }

  const snapped = bestXDistance <= threshold || bestYDistance <= threshold;
  return {
    rect: { ...movingRect, x: snapX, y: snapY },
    snapped,
  };
}

export function getCanvasEdgeAttachSnapRect(
  movingRect: CanvasRect,
  containerWidth: number,
  containerHeight: number,
  threshold: number = CANVAS_ATTACH_THRESHOLD,
): CanvasAttachSnap {
  let snapX = movingRect.x;
  let snapY = movingRect.y;
  let snapped = false;

  const rightX = Math.max(0, containerWidth - movingRect.width);
  const bottomY = Math.max(0, containerHeight - movingRect.height);
  const leftDistance = Math.abs(movingRect.x);
  const rightDistance = Math.abs(containerWidth - (movingRect.x + movingRect.width));
  const topDistance = Math.abs(movingRect.y);
  const bottomDistance = Math.abs(containerHeight - (movingRect.y + movingRect.height));

  if (leftDistance <= threshold || rightDistance <= threshold) {
    snapX = leftDistance <= rightDistance ? 0 : rightX;
    snapped = true;
  }

  if (topDistance <= threshold || bottomDistance <= threshold) {
    snapY = topDistance <= bottomDistance ? 0 : bottomY;
    snapped = true;
  }

  return {
    rect: { ...movingRect, x: snapX, y: snapY },
    snapped,
  };
}

export function getCanvasResizeAttachSnapRect(
  rawRect: CanvasRect,
  originalRect: CanvasRect,
  resizeEdge: ResizeEdge,
  targetRects: CanvasRect[],
  threshold: number = CANVAS_ATTACH_THRESHOLD,
): CanvasAttachSnap {
  const attachedTargets = targetRects.filter(
    (target) =>
      isCanvasAttached(originalRect, target, threshold) ||
      isCanvasAttached(rawRect, target, threshold),
  );

  if (attachedTargets.length === 0) {
    return { rect: rawRect, snapped: false };
  }

  let finalX = rawRect.x;
  let finalY = rawRect.y;
  let finalWidth = rawRect.width;
  let finalHeight = rawRect.height;
  let snappedWidth = false;
  let snappedHeight = false;

  const isEast = resizeEdge === 'e' || resizeEdge === 'ne' || resizeEdge === 'se';
  const isWest = resizeEdge === 'w' || resizeEdge === 'nw' || resizeEdge === 'sw';
  const isSouth = resizeEdge === 's' || resizeEdge === 'se' || resizeEdge === 'sw';
  const isNorth = resizeEdge === 'n' || resizeEdge === 'ne' || resizeEdge === 'nw';

  // Handle horizontal resizing (width and x)
  if (isEast) {
    const rawRight = rawRect.x + rawRect.width;
    let bestDist = threshold + 1;
    let bestWidth = rawRect.width;

    for (const target of attachedTargets) {
      const targetRight = target.x + target.width;

      // Candidate 1: Match target width
      const distWidth = Math.abs(rawRect.width - target.width);
      if (distWidth <= threshold && distWidth < bestDist && target.width >= MIN_CANVAS_SIZE) {
        bestDist = distWidth;
        bestWidth = target.width;
      }

      // Candidate 2: Align right edge to target right edge
      const wAlignRight = targetRight - rawRect.x;
      const distAlignRight = Math.abs(rawRight - targetRight);
      if (distAlignRight <= threshold && distAlignRight < bestDist && wAlignRight >= MIN_CANVAS_SIZE) {
        bestDist = distAlignRight;
        bestWidth = wAlignRight;
      }

      // Candidate 3: Right edge touches target left edge
      const wTouchLeft = target.x - rawRect.x;
      const distTouchLeft = Math.abs(rawRight - target.x);
      if (distTouchLeft <= threshold && distTouchLeft < bestDist && wTouchLeft >= MIN_CANVAS_SIZE) {
        bestDist = distTouchLeft;
        bestWidth = wTouchLeft;
      }
    }

    if (bestDist <= threshold) {
      finalWidth = bestWidth;
      snappedWidth = true;
    }
  } else if (isWest) {
    const origRight = originalRect.x + originalRect.width;
    const rawLeft = rawRect.x;
    let bestDist = threshold + 1;
    let bestX = rawRect.x;
    let bestWidth = rawRect.width;

    for (const target of attachedTargets) {
      const targetRight = target.x + target.width;

      // Candidate 1: Match target width
      const distWidth = Math.abs(rawRect.width - target.width);
      const xMatchWidth = origRight - target.width;
      if (distWidth <= threshold && distWidth < bestDist && target.width >= MIN_CANVAS_SIZE) {
        bestDist = distWidth;
        bestWidth = target.width;
        bestX = xMatchWidth;
      }

      // Candidate 2: Align left edge to target left edge
      const distAlignLeft = Math.abs(rawLeft - target.x);
      const wAlignLeft = origRight - target.x;
      if (distAlignLeft <= threshold && distAlignLeft < bestDist && wAlignLeft >= MIN_CANVAS_SIZE) {
        bestDist = distAlignLeft;
        bestWidth = wAlignLeft;
        bestX = target.x;
      }

      // Candidate 3: Left edge touches target right edge
      const distTouchRight = Math.abs(rawLeft - targetRight);
      const wTouchRight = origRight - targetRight;
      if (distTouchRight <= threshold && distTouchRight < bestDist && wTouchRight >= MIN_CANVAS_SIZE) {
        bestDist = distTouchRight;
        bestWidth = wTouchRight;
        bestX = targetRight;
      }
    }

    if (bestDist <= threshold) {
      finalX = bestX;
      finalWidth = bestWidth;
      snappedWidth = true;
    }
  }

  // Handle vertical resizing (height and y)
  if (isSouth) {
    const rawBottom = rawRect.y + rawRect.height;
    let bestDist = threshold + 1;
    let bestHeight = rawRect.height;

    for (const target of attachedTargets) {
      const targetBottom = target.y + target.height;

      // Candidate 1: Match target height
      const distHeight = Math.abs(rawRect.height - target.height);
      if (distHeight <= threshold && distHeight < bestDist && target.height >= MIN_CANVAS_SIZE) {
        bestDist = distHeight;
        bestHeight = target.height;
      }

      // Candidate 2: Align bottom edge to target bottom edge
      const hAlignBottom = targetBottom - rawRect.y;
      const distAlignBottom = Math.abs(rawBottom - targetBottom);
      if (distAlignBottom <= threshold && distAlignBottom < bestDist && hAlignBottom >= MIN_CANVAS_SIZE) {
        bestDist = distAlignBottom;
        bestHeight = hAlignBottom;
      }

      // Candidate 3: Bottom edge touches target top edge
      const hTouchTop = target.y - rawRect.y;
      const distTouchTop = Math.abs(rawBottom - target.y);
      if (distTouchTop <= threshold && distTouchTop < bestDist && hTouchTop >= MIN_CANVAS_SIZE) {
        bestDist = distTouchTop;
        bestHeight = hTouchTop;
      }
    }

    if (bestDist <= threshold) {
      finalHeight = bestHeight;
      snappedHeight = true;
    }
  } else if (isNorth) {
    const origBottom = originalRect.y + originalRect.height;
    const rawTop = rawRect.y;
    let bestDist = threshold + 1;
    let bestY = rawRect.y;
    let bestHeight = rawRect.height;

    for (const target of attachedTargets) {
      const targetBottom = target.y + target.height;

      // Candidate 1: Match target height
      const distHeight = Math.abs(rawRect.height - target.height);
      const yMatchHeight = origBottom - target.height;
      if (distHeight <= threshold && distHeight < bestDist && target.height >= MIN_CANVAS_SIZE) {
        bestDist = distHeight;
        bestHeight = target.height;
        bestY = yMatchHeight;
      }

      // Candidate 2: Align top edge to target top edge
      const distAlignTop = Math.abs(rawTop - target.y);
      const hAlignTop = origBottom - target.y;
      if (distAlignTop <= threshold && distAlignTop < bestDist && hAlignTop >= MIN_CANVAS_SIZE) {
        bestDist = distAlignTop;
        bestHeight = hAlignTop;
        bestY = target.y;
      }

      // Candidate 3: Top edge touches target bottom edge
      const distTouchBottom = Math.abs(rawTop - targetBottom);
      const hTouchBottom = origBottom - targetBottom;
      if (distTouchBottom <= threshold && distTouchBottom < bestDist && hTouchBottom >= MIN_CANVAS_SIZE) {
        bestDist = distTouchBottom;
        bestHeight = hTouchBottom;
        bestY = targetBottom;
      }
    }

    if (bestDist <= threshold) {
      finalY = bestY;
      finalHeight = bestHeight;
      snappedHeight = true;
    }
  }

  return {
    rect: {
      x: finalX,
      y: finalY,
      width: finalWidth,
      height: finalHeight,
    },
    snapped: snappedWidth || snappedHeight,
  };
}
