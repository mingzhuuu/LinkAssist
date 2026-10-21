import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayPanel } from '../components/display/DisplayPanel';
import { useCanvasStore, useUIStore } from '../stores';
import type { Canvas } from '../types';

vi.mock('../components/display/CanvasChart', () => ({ CanvasChart: () => null }));

let resizeObserverCallback: ResizeObserverCallback | null = null;

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }
  observe() {}
  disconnect() {}
}

describe('DisplayPanel viewport reset', () => {
  let viewport = {
    left: 1700,
    top: 40,
    width: 300,
    height: 800,
  };

  beforeEach(() => {
    viewport = {
      left: 1700,
      top: 40,
      width: 300,
      height: 800,
    };
    resizeObserverCallback = null;
    useCanvasStore.setState(useCanvasStore.getInitialState(), true);
    useUIStore.setState(useUIStore.getInitialState(), true);

    const canvas: Canvas = {
      id: 'canvas-1',
      name: 'Test canvas',
      groupId: null,
      rect: { x: 100, y: 20, width: 200, height: 120 },
      savedRect: null,
      savedSnapped: null,
      zIndex: 1,
      active: false,
      activationMode: 'manual-off',
      maximized: false,
      snapped: false,
      config: {
        type: 'table',
        dataSource: 'raw',
        channels: [],
        table: { columns: [] },
        script: {
          sourceType: 'file',
          luaPath: '',
          stopOnFailure: true,
          defaultTimeoutMs: 2000,
          defaultDataFormat: 'hex',
          logLimit: 500,
        },
      },
    };
    useCanvasStore.setState({
      canvases: [canvas],
      nextZIndex: 2,
      dataBuffers: { [canvas.id]: [] },
      chartViewState: { [canvas.id]: { paused: false } },
    });

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(1);
        return 1;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: viewport.left,
      y: viewport.top,
      left: viewport.left,
      top: viewport.top,
      right: viewport.left + viewport.width,
      bottom: viewport.top + viewport.height,
      width: viewport.width,
      height: viewport.height,
      toJSON: () => ({}),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('maintains canvas coordinates stably inside panel when viewport geometry changes', () => {
    const { container } = render(<DisplayPanel layoutReady />);
    const canvasElement = container.querySelector('[data-canvas-id="canvas-1"]')?.firstElementChild as HTMLElement;

    expect(canvasElement.style.left).toBe('100px');
    expect(canvasElement.style.top).toBe('20px');

    // Panel resize changes left/width
    viewport = { ...viewport, left: 600, width: 1400 };
    act(() => resizeObserverCallback?.([], {} as ResizeObserver));

    expect(canvasElement.style.left).toBe('100px');
    expect(canvasElement.style.top).toBe('20px');

    act(() => useUIStore.getState().resetCanvasViewport());

    expect(canvasElement.style.left).toBe('100px');
    expect(canvasElement.style.top).toBe('20px');
    expect(useCanvasStore.getState().canvases[0].rect).toEqual({
      x: 100,
      y: 20,
      width: 200,
      height: 120,
    });
  });

  it('uses the effective fixed-width viewport as the startup baseline', () => {
    const { container } = render(<DisplayPanel layoutReady fixedWidth={312} />);
    const canvasElement = container.querySelector('[data-canvas-id="canvas-1"]')?.firstElementChild as HTMLElement;

    expect(canvasElement.style.left).toBe('100px');
    expect(canvasElement.style.top).toBe('20px');
    expect(useCanvasStore.getState().canvases[0].rect.x).toBe(100);
  });

  it('maintains canvas-local coordinates when the native window bounds change', () => {
    const { container } = render(<DisplayPanel layoutReady />);
    const canvasElement = container.querySelector('[data-canvas-id="canvas-1"]')?.firstElementChild as HTMLElement;

    viewport = { left: 1000, top: 26, width: 1000, height: 940 };
    act(() => window.dispatchEvent(new Event('resize')));

    expect(canvasElement.style.left).toBe('100px');
    expect(canvasElement.style.top).toBe('20px');
    expect(useCanvasStore.getState().canvases[0].rect).toEqual({
      x: 100,
      y: 20,
      width: 200,
      height: 120,
    });
  });

  it('keeps canvas size and position relative to top-left invariant when fixedWidth changes', () => {
    const { container, rerender } = render(<DisplayPanel layoutReady fixedWidth={300} />);
    const canvasElement = container.querySelector('[data-canvas-id="canvas-1"]')?.firstElementChild as HTMLElement;

    expect(canvasElement.style.left).toBe('100px');
    expect(canvasElement.style.top).toBe('20px');

    // Divider drags left 100px (fixedWidth expands from 300 to 400)
    rerender(<DisplayPanel layoutReady fixedWidth={400} />);

    expect(canvasElement.style.left).toBe('100px');
    expect(canvasElement.style.top).toBe('20px');

    // Divider drags right 50px (fixedWidth shrinks from 300 to 250)
    rerender(<DisplayPanel layoutReady fixedWidth={250} />);

    expect(canvasElement.style.left).toBe('100px');
    expect(canvasElement.style.top).toBe('20px');
  });
});

