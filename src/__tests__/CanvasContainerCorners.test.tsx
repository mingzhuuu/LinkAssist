import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasContainer } from '../components/display/Canvas';
import type { Canvas } from '../types';

const canvas: Canvas = {
  id: 'canvas-corners',
  name: 'Corners',
  groupId: null,
  rect: { x: 0, y: 0, width: 800, height: 600 },
  savedRect: null,
  savedSnapped: null,
  zIndex: 1,
  active: false,
  activationMode: 'manual-off',
  maximized: true,
  snapped: false,
  config: {
    type: 'table',
    dataSource: 'raw',
    channels: [],
    table: { columns: [] },
  },
};

const handlers = {
  onMouseDownMove: vi.fn(),
  onResizeStart: vi.fn(),
  onContextMenu: vi.fn(),
  onDoubleClickRight: vi.fn(),
  onDoubleClickLeft: vi.fn(),
  onSelect: vi.fn(),
  onPrimaryMouseDown: vi.fn(),
};

describe('CanvasContainer maximized corners', () => {
  afterEach(cleanup);

  it('matches the outer panel corners only while maximized', () => {
    const { container, rerender } = render(
      <CanvasContainer
        canvas={canvas}
        roundMaximizedTopLeft
        roundMaximizedBottomRight
        {...handlers}
      >
        <div />
      </CanvasContainer>,
    );

    const element = container.firstElementChild as HTMLElement;
    expect(element.className).toContain('border-t-0');
    expect(element.className).toContain('border-l-0');
    expect(element.className).not.toContain('rounded-tl-xl');
    expect(element.className).toContain('rounded-br-xl');

    rerender(
      <CanvasContainer
        canvas={{ ...canvas, maximized: false }}
        roundMaximizedTopLeft
        roundMaximizedBottomRight
        seamlessMaximized
        {...handlers}
      >
        <div />
      </CanvasContainer>,
    );

    const nonMaximizedClasses = element.className.split(' ');
    expect(nonMaximizedClasses).toContain('border');
    expect(nonMaximizedClasses).not.toContain('border-0');
    expect(nonMaximizedClasses).toContain('rounded-none');
    expect(nonMaximizedClasses).not.toContain('border-t-0');
    expect(nonMaximizedClasses).not.toContain('border-l-0');
    expect(nonMaximizedClasses).not.toContain('rounded-br-xl');
  });

  it('lets the outer frame own every edge in seamless maximized mode', () => {
    const { container } = render(
      <CanvasContainer
        canvas={canvas}
        roundMaximizedTopLeft
        roundMaximizedBottomRight
        seamlessMaximized
        {...handlers}
      >
        <div />
      </CanvasContainer>,
    );

    const classes = (container.firstElementChild as HTMLElement).className.split(' ');
    expect(classes).toContain('border-0');
    expect(classes).not.toContain('border');
    expect(classes).not.toContain('border-t-0');
    expect(classes).not.toContain('border-l-0');
    expect(classes).not.toContain('rounded-br-xl');
  });
});
