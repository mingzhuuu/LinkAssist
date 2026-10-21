import { describe, expect, it } from 'vitest';
import type { CanvasRect } from '../types';
import {
  CANVAS_ATTACH_THRESHOLD,
  getCanvasAttachSnapRect,
  getCanvasEdgeAttachSnapRect,
  getCanvasResizeAttachSnapRect,
  isCanvasAttached,
  rangesOverlapOrNear,
} from '../components/display/canvasSnapUtils';

describe('canvasSnapUtils', () => {
  it('defines CANVAS_ATTACH_THRESHOLD as 12', () => {
    expect(CANVAS_ATTACH_THRESHOLD).toBe(12);
  });

  describe('rangesOverlapOrNear', () => {
    it('returns true for overlapping ranges', () => {
      expect(rangesOverlapOrNear(0, 100, 50, 150, 12)).toBe(true);
    });

    it('returns true for ranges within threshold gap', () => {
      expect(rangesOverlapOrNear(0, 100, 105, 200, 12)).toBe(true);
    });

    it('returns false for ranges outside threshold gap', () => {
      expect(rangesOverlapOrNear(0, 100, 120, 200, 12)).toBe(false);
    });
  });

  describe('isCanvasAttached', () => {
    it('detects vertically abutting canvases (top to bottom) with horizontal overlap', () => {
      const topRect: CanvasRect = { x: 100, y: 50, width: 300, height: 150 };
      const bottomRect: CanvasRect = { x: 120, y: 200, width: 200, height: 100 }; // y: 200 = 50 + 150

      expect(isCanvasAttached(topRect, bottomRect)).toBe(true);
      expect(isCanvasAttached(bottomRect, topRect)).toBe(true);
    });

    it('detects horizontally abutting canvases (left to right) with vertical overlap', () => {
      const leftRect: CanvasRect = { x: 50, y: 100, width: 150, height: 200 };
      const rightRect: CanvasRect = { x: 200, y: 120, width: 200, height: 150 }; // x: 200 = 50 + 150

      expect(isCanvasAttached(leftRect, rightRect)).toBe(true);
      expect(isCanvasAttached(rightRect, leftRect)).toBe(true);
    });

    it('returns false when canvases are aligned on an axis but far apart', () => {
      const rectA: CanvasRect = { x: 100, y: 50, width: 100, height: 100 };
      const rectB: CanvasRect = { x: 500, y: 50, width: 100, height: 100 };

      expect(isCanvasAttached(rectA, rectB)).toBe(false);
    });

    it('returns false when canvases are far apart in both axes', () => {
      const rectA: CanvasRect = { x: 0, y: 0, width: 100, height: 100 };
      const rectB: CanvasRect = { x: 400, y: 400, width: 100, height: 100 };

      expect(isCanvasAttached(rectA, rectB)).toBe(false);
    });
  });

  describe('getCanvasAttachSnapRect', () => {
    it('snaps moving rect to target edges', () => {
      const target: CanvasRect = { x: 100, y: 100, width: 200, height: 200 };
      const moving: CanvasRect = { x: 96, y: 304, width: 200, height: 100 };

      const result = getCanvasAttachSnapRect(moving, [target]);
      expect(result.snapped).toBe(true);
      expect(result.rect.x).toBe(100);
      expect(result.rect.y).toBe(300); // target.y + target.height
    });
  });

  describe('getCanvasEdgeAttachSnapRect', () => {
    it('snaps near container edges to 0 or container bound', () => {
      const moving: CanvasRect = { x: 5, y: 6, width: 100, height: 100 };
      const result = getCanvasEdgeAttachSnapRect(moving, 800, 600);

      expect(result.snapped).toBe(true);
      expect(result.rect.x).toBe(0);
      expect(result.rect.y).toBe(0);
    });
  });

  describe('getCanvasResizeAttachSnapRect', () => {
    it('returns original raw rect with snapped=false when no attached targets exist', () => {
      const rawRect: CanvasRect = { x: 500, y: 500, width: 150, height: 150 };
      const originalRect: CanvasRect = { x: 500, y: 500, width: 100, height: 100 };
      const isolatedTarget: CanvasRect = { x: 0, y: 0, width: 150, height: 150 };

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 'e', [isolatedTarget]);
      expect(result.snapped).toBe(false);
      expect(result.rect).toEqual(rawRect);
    });

    it('snaps width to match vertically attached target width when dragging east (e)', () => {
      // Target is above: x=100, y=50, w=400, h=150 (bottom at 200)
      const target: CanvasRect = { x: 100, y: 50, width: 400, height: 150 };
      // Canvas being resized is below: x=100, y=200, orig width=250
      const originalRect: CanvasRect = { x: 100, y: 200, width: 250, height: 100 };
      // User drags right edge: candidate width is 395 (within 12px of target width 400)
      const rawRect: CanvasRect = { x: 100, y: 200, width: 395, height: 100 };

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 'e', [target]);
      expect(result.snapped).toBe(true);
      expect(result.rect.width).toBe(400);
      expect(result.rect.x).toBe(100);
    });

    it('disengages width snap when dragging beyond threshold', () => {
      const target: CanvasRect = { x: 100, y: 50, width: 400, height: 150 };
      const originalRect: CanvasRect = { x: 100, y: 200, width: 250, height: 100 };
      // User drags right edge to 420 (gap of 20px > 12px)
      const rawRect: CanvasRect = { x: 100, y: 200, width: 420, height: 100 };

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 'e', [target]);
      expect(result.snapped).toBe(false);
      expect(result.rect.width).toBe(420);
    });

    it('snaps width and adjusts x to match target width when dragging west (w)', () => {
      // Target is above: x=100, y=50, w=400, h=150 (left=100, right=500)
      const target: CanvasRect = { x: 100, y: 50, width: 400, height: 150 };
      // Canvas below has right edge at 500: x=250, w=250 (origRight = 500)
      const originalRect: CanvasRect = { x: 250, y: 200, width: 250, height: 100 };
      // User drags left edge leftwards: raw x=106 (width=394, within 12px of 400)
      const rawRect: CanvasRect = { x: 106, y: 200, width: 394, height: 100 };

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 'w', [target]);
      expect(result.snapped).toBe(true);
      expect(result.rect.width).toBe(400);
      expect(result.rect.x).toBe(100); // 500 - 400
    });

    it('snaps height to match horizontally attached target height when dragging south (s)', () => {
      // Target is on the left: x=50, y=100, w=200, h=350 (right at 250)
      const target: CanvasRect = { x: 50, y: 100, width: 200, height: 350 };
      // Canvas on the right: x=250, y=100, w=200, orig height=200
      const originalRect: CanvasRect = { x: 250, y: 100, width: 200, height: 200 };
      // User drags bottom edge downwards: raw height=345 (within 12px of 350)
      const rawRect: CanvasRect = { x: 250, y: 100, width: 200, height: 345 };

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 's', [target]);
      expect(result.snapped).toBe(true);
      expect(result.rect.height).toBe(350);
      expect(result.rect.y).toBe(100);
    });

    it('snaps height and adjusts y when dragging north (n)', () => {
      // Target is on the left: x=50, y=100, w=200, h=350 (top=100, bottom=450)
      const target: CanvasRect = { x: 50, y: 100, width: 200, height: 350 };
      // Canvas on the right: bottom edge at 450: x=250, y=250, w=200, h=200
      const originalRect: CanvasRect = { x: 250, y: 250, width: 200, height: 200 };
      // User drags top edge upwards: raw y=105, height=345 (within 12px of 350)
      const rawRect: CanvasRect = { x: 250, y: 105, width: 200, height: 345 };

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 'n', [target]);
      expect(result.snapped).toBe(true);
      expect(result.rect.height).toBe(350);
      expect(result.rect.y).toBe(100); // 450 - 350
    });

    it('snaps both width and height when resizing corner handle (se)', () => {
      // Target: x=100, y=50, w=400, h=300 (touches top at y=350, wait bottom is 350)
      const target: CanvasRect = { x: 100, y: 50, width: 400, height: 300 };
      const originalRect: CanvasRect = { x: 100, y: 350, width: 200, height: 200 };
      // User drags south-east handle: width close to 400, height close to 300
      const rawRect: CanvasRect = { x: 100, y: 350, width: 392, height: 306 };

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 'se', [target]);
      expect(result.snapped).toBe(true);
      expect(result.rect.width).toBe(400);
      expect(result.rect.height).toBe(300);
    });

    it('aligns right edge to target right edge when x offsets differ', () => {
      // Target: x=100, w=300 (right=400), y=50, h=100
      const target: CanvasRect = { x: 100, y: 50, width: 300, height: 100 };
      // Resizing canvas attached below but with x=120
      const originalRect: CanvasRect = { x: 120, y: 150, width: 200, height: 100 };
      // User drags right edge until right edge is 396 (close to 400)
      const rawRect: CanvasRect = { x: 120, y: 150, width: 276, height: 100 }; // 120 + 276 = 396

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 'e', [target]);
      expect(result.snapped).toBe(true);
      expect(result.rect.x + result.rect.width).toBe(400); // aligns to right edge
      expect(result.rect.width).toBe(280); // 400 - 120
    });

    it('never snaps to width or height smaller than MIN_CANVAS_SIZE', () => {
      const target: CanvasRect = { x: 100, y: 50, width: 20, height: 20 };
      const originalRect: CanvasRect = { x: 100, y: 70, width: 60, height: 60 };
      const rawRect: CanvasRect = { x: 100, y: 70, width: 45, height: 60 };

      const result = getCanvasResizeAttachSnapRect(rawRect, originalRect, 'e', [target]);
      // Should not snap to 20 because MIN_CANVAS_SIZE is 40
      expect(result.rect.width).toBe(45);
    });
  });
});
