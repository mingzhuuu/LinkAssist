import { describe, expect, it } from 'vitest';
import type { CanvasRect } from '../types';
import {
  buildViewportTransform,
  clampScrollX,
  clampScrollY,
  displayToWorldRect,
  getCanvasScrollBounds,
  normalizeWheelDeltaX,
  normalizeWheelDeltaY,
  worldToDisplayRect,
} from '../components/display/viewportUtils';

describe('viewportUtils', () => {
  it('keeps canvas size fixed while translating between world and display space', () => {
    const rect: CanvasRect = { x: 260, y: 320, width: 180, height: 120 };
    const transform = buildViewportTransform(60, 220);

    expect(worldToDisplayRect(rect, transform)).toEqual({
      x: 200,
      y: 100,
      width: 180,
      height: 120,
    });
    expect(displayToWorldRect({ x: 200, y: 100, width: 180, height: 120 }, transform)).toEqual(rect);
  });

  it('keeps elements fixed relative to top-left when frame/panel size changes', () => {
    const rect: CanvasRect = { x: 200, y: 50, width: 100, height: 100 };
    // When the canvas frame changes size (e.g. window is resized or divider moves),
    // the position relative to top-left does NOT change.
    const transform = buildViewportTransform(0, 0);
    expect(worldToDisplayRect(rect, transform).x).toBe(200);
    expect(worldToDisplayRect(rect, transform).y).toBe(50);
  });

  it('expands scroll bounds when canvases exceed the viewport on X or Y axes', () => {
    const bounds = getCanvasScrollBounds([
      { rect: { x: 40, y: 50, width: 100, height: 80 }, maximized: false },
      { rect: { x: 450, y: 520, width: 160, height: 120 }, maximized: false },
    ], 500, 400);

    // X: maxRight = 450 + 160 = 610. 610 + 80 - 500 = 190.
    // Y: maxBottom = 520 + 120 = 640. 640 + 80 - 400 = 320.
    expect(bounds).toEqual({
      minScrollX: 0,
      maxScrollX: 190,
      minScrollY: 0,
      maxScrollY: 320,
    });
  });

  it('ignores maximized canvases when calculating scroll bounds', () => {
    const bounds = getCanvasScrollBounds([
      { rect: { x: 0, y: 0, width: 800, height: 600 }, maximized: true },
    ], 400, 400);

    expect(bounds).toEqual({
      minScrollX: 0,
      maxScrollX: 0,
      minScrollY: 0,
      maxScrollY: 0,
    });
  });

  it('clamps scroll positions to the available ranges', () => {
    const bounds = { minScrollX: 0, maxScrollX: 200, minScrollY: 0, maxScrollY: 360 };

    expect(clampScrollX(-50, bounds)).toBe(0);
    expect(clampScrollX(80, bounds)).toBe(80);
    expect(clampScrollX(300, bounds)).toBe(200);

    expect(clampScrollY(-100, bounds)).toBe(0);
    expect(clampScrollY(90, bounds)).toBe(90);
    expect(clampScrollY(600, bounds)).toBe(360);
  });

  it('normalizes line and page wheel deltas into pixel movement for both axes', () => {
    expect(normalizeWheelDeltaY(3, WheelEvent.DOM_DELTA_LINE, 400)).toBe(48);
    expect(normalizeWheelDeltaY(-2, WheelEvent.DOM_DELTA_PAGE, 300)).toBe(-240);
    expect(normalizeWheelDeltaX(2, WheelEvent.DOM_DELTA_LINE, 500)).toBe(32);
    expect(normalizeWheelDeltaX(-1, WheelEvent.DOM_DELTA_PAGE, 500)).toBe(-240);
  });
});
