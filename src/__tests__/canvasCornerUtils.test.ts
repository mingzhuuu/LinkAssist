import { describe, expect, it } from 'vitest';
import type { CanvasRect } from '../types';
import {
  computeCanvasCornerState,
  getCornerClassNames,
  getSnapPreviewCornerClassNames,
} from '../components/display/canvasCornerUtils';

describe('canvasCornerUtils', () => {
  const singleRect: CanvasRect = { x: 50, y: 50, width: 200, height: 150 };

  it('rounds all 4 corners for a single floating canvas', () => {
    const corners = computeCanvasCornerState(singleRect, []);
    expect(corners).toEqual({
      topLeft: true,
      topRight: true,
      bottomLeft: true,
      bottomRight: true,
    });
    expect(getCornerClassNames(corners)).toBe('rounded-xl');
  });

  it('preserves all corners when adjacent canvas is not touching', () => {
    const farRect: CanvasRect = { x: 300, y: 50, width: 200, height: 150 }; // 50px gap
    const corners = computeCanvasCornerState(singleRect, [farRect]);
    expect(corners).toEqual({
      topLeft: true,
      topRight: true,
      bottomLeft: true,
      bottomRight: true,
    });
    expect(getCornerClassNames(corners)).toBe('rounded-xl');
  });

  it('flattens right corners when abutting another canvas on the right', () => {
    const rightAbutting: CanvasRect = { x: 250, y: 50, width: 200, height: 150 }; // x = 50 + 200
    const cornersA = computeCanvasCornerState(singleRect, [rightAbutting]);
    expect(cornersA).toEqual({
      topLeft: true,
      topRight: false,
      bottomLeft: true,
      bottomRight: false,
    });
    expect(getCornerClassNames(cornersA)).toBe('rounded-l-xl rounded-r-none');

    const cornersB = computeCanvasCornerState(rightAbutting, [singleRect]);
    expect(cornersB).toEqual({
      topLeft: false,
      topRight: true,
      bottomLeft: false,
      bottomRight: true,
    });
    expect(getCornerClassNames(cornersB)).toBe('rounded-r-xl rounded-l-none');
  });

  it('flattens bottom corners when abutting another canvas below', () => {
    const bottomAbutting: CanvasRect = { x: 50, y: 200, width: 200, height: 150 }; // y = 50 + 150
    const cornersTop = computeCanvasCornerState(singleRect, [bottomAbutting]);
    expect(cornersTop).toEqual({
      topLeft: true,
      topRight: true,
      bottomLeft: false,
      bottomRight: false,
    });
    expect(getCornerClassNames(cornersTop)).toBe('rounded-t-xl rounded-b-none');

    const cornersBottom = computeCanvasCornerState(bottomAbutting, [singleRect]);
    expect(cornersBottom).toEqual({
      topLeft: false,
      topRight: false,
      bottomLeft: true,
      bottomRight: true,
    });
    expect(getCornerClassNames(cornersBottom)).toBe('rounded-b-xl rounded-t-none');
  });

  it('handles 2x2 grid alignment with outer corners rounded and inner seams flat', () => {
    const topLeft: CanvasRect = { x: 0, y: 0, width: 200, height: 200 };
    const topRight: CanvasRect = { x: 200, y: 0, width: 200, height: 200 };
    const bottomLeft: CanvasRect = { x: 0, y: 200, width: 200, height: 200 };
    const bottomRight: CanvasRect = { x: 200, y: 200, width: 200, height: 200 };

    const cTL = computeCanvasCornerState(topLeft, [topRight, bottomLeft, bottomRight]);
    expect(cTL).toEqual({ topLeft: true, topRight: false, bottomLeft: false, bottomRight: false });
    expect(getCornerClassNames(cTL)).toBe('rounded-tl-xl rounded-tr-none rounded-bl-none rounded-br-none');

    const cTR = computeCanvasCornerState(topRight, [topLeft, bottomLeft, bottomRight]);
    expect(cTR).toEqual({ topLeft: false, topRight: true, bottomLeft: false, bottomRight: false });
    expect(getCornerClassNames(cTR)).toBe('rounded-tl-none rounded-tr-xl rounded-bl-none rounded-br-none');

    const cBL = computeCanvasCornerState(bottomLeft, [topLeft, topRight, bottomRight]);
    expect(cBL).toEqual({ topLeft: false, topRight: false, bottomLeft: true, bottomRight: false });
    expect(getCornerClassNames(cBL)).toBe('rounded-tl-none rounded-tr-none rounded-bl-xl rounded-br-none');

    const cBR = computeCanvasCornerState(bottomRight, [topLeft, topRight, bottomLeft]);
    expect(cBR).toEqual({ topLeft: false, topRight: false, bottomLeft: false, bottomRight: true });
    expect(getCornerClassNames(cBR)).toBe('rounded-tl-none rounded-tr-none rounded-bl-none rounded-br-xl');
  });

  it('handles partial T-junction docking', () => {
    // Tall canvas on left: y=0 to 400
    const tallLeft: CanvasRect = { x: 0, y: 0, width: 200, height: 400 };
    // Shorter canvas on right: y=100 to 300
    const shortRight: CanvasRect = { x: 200, y: 100, width: 200, height: 200 };

    // Short canvas left side is completely covered by tallLeft
    const cShort = computeCanvasCornerState(shortRight, [tallLeft]);
    expect(cShort).toEqual({ topLeft: false, topRight: true, bottomLeft: false, bottomRight: true });
    expect(getCornerClassNames(cShort)).toBe('rounded-r-xl rounded-l-none');

    // Tall canvas right corners are untouched because shortRight starts at 100 and ends at 300
    const cTall = computeCanvasCornerState(tallLeft, [shortRight]);
    expect(cTall).toEqual({ topLeft: true, topRight: true, bottomLeft: true, bottomRight: true });
    expect(getCornerClassNames(cTall)).toBe('rounded-xl');
  });

  it('respects maximized and seamlessMaximized options', () => {
    // Seamless maximized delegates to outer frame
    const seamless = computeCanvasCornerState(singleRect, [], {
      maximized: true,
      usesOuterFrame: true,
    });
    expect(seamless).toEqual({ topLeft: false, topRight: false, bottomLeft: false, bottomRight: false });
    expect(getCornerClassNames(seamless)).toBe('rounded-none');

    // Non-seamless maximized with roundMaximizedBottomRight
    const nonSeamless = computeCanvasCornerState(singleRect, [], {
      maximized: true,
      usesOuterFrame: false,
      roundMaximizedBottomRight: true,
    });
    expect(nonSeamless).toEqual({ topLeft: false, topRight: false, bottomLeft: false, bottomRight: true });
    expect(getCornerClassNames(nonSeamless)).toBe('rounded-tl-none rounded-tr-none rounded-bl-none rounded-br-xl');
  });

  it('provides matching corner classes for snap preview zones', () => {
    expect(getSnapPreviewCornerClassNames('left')).toBe('rounded-l-xl rounded-r-none');
    expect(getSnapPreviewCornerClassNames('right')).toBe('rounded-r-xl rounded-l-none');
    expect(getSnapPreviewCornerClassNames('top')).toBe('rounded-t-xl rounded-b-none');
    expect(getSnapPreviewCornerClassNames('bottom')).toBe('rounded-b-xl rounded-t-none');
    expect(getSnapPreviewCornerClassNames('left-top')).toBe('rounded-tl-xl rounded-tr-none rounded-bl-none rounded-br-none');
    expect(getSnapPreviewCornerClassNames('right-top')).toBe('rounded-tr-xl rounded-tl-none rounded-bl-none rounded-br-none');
    expect(getSnapPreviewCornerClassNames('left-bottom')).toBe('rounded-bl-xl rounded-tl-none rounded-tr-none rounded-br-none');
    expect(getSnapPreviewCornerClassNames('right-bottom')).toBe('rounded-br-xl rounded-tl-none rounded-tr-none rounded-bl-none');
    expect(getSnapPreviewCornerClassNames('full')).toBe('rounded-none');
    expect(getSnapPreviewCornerClassNames(null)).toBe('rounded-xl');
  });
});
