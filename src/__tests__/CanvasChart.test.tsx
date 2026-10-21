import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasChart } from '../components/display/CanvasChart';
import { ingestPacket } from '../components/display/chartRuntime';
import { useCanvasStore } from '../stores';
import type { ChartConfig, LineChartConfig } from '../types';
import type uPlot from 'uplot';

const { plots } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  return { plots: [] as uPlot[] };
});

// Exercise the real uPlot scale/data lifecycle; only canvas drawing is stubbed.
vi.mock('uplot', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof uPlot }>();
  return {
    default: class extends actual.default {
      constructor(...args: ConstructorParameters<typeof actual.default>) {
        super(...args);
        plots.push(this);
      }
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const canvasId = 'chart-test';
const channelId = 'channel-test';
const config: LineChartConfig = {
  kind: 'line',
  xSource: { kind: 'timestamp' },
  yAxis: { mode: 'auto' },
  series: [{
    id: 'value', name: 'Value', color: '#ff0000',
    extractor: { source: 'raw', offset: 0, format: 'UInt8', formula: '' },
  }],
};

let resizeCallback: (() => void) | undefined;
let width = 500;

function configure(chart: ChartConfig) {
  act(() => useCanvasStore.getState().updateCanvasConfig(canvasId, { chart }));
}

async function packet(timestamp: number, value = 10) {
  await act(async () => {
    ingestPacket(canvasId, channelId, [value], timestamp);
    vi.advanceTimersByTime(60);
  });
}

function plot() {
  return plots[plots.length - 1];
}

describe('CanvasChart streaming and display', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    plots.length = 0;
    width = 500;
    resizeCallback = undefined;
    const noop = () => {};
    vi.stubGlobal('Path2D', class {
      constructor() { return new Proxy(this, { get: () => noop }); }
    });
    const context = new Proxy({ measureText: (text: string) => ({ width: text.length * 7 }) }, {
      get: (target, key) => Reflect.get(target, key) ?? noop,
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = () => callback([
          { contentRect: { width, height: 300 } } as ResizeObserverEntry,
        ], this as unknown as ResizeObserver);
      }
      observe() { resizeCallback?.(); }
      disconnect() {}
    });
    useCanvasStore.setState(useCanvasStore.getInitialState(), true);
    useCanvasStore.setState({
      canvases: [{
        id: canvasId, name: 'Chart', rect: { x: 0, y: 0, width: 500, height: 300 },
        savedRect: null, savedSnapped: null, zIndex: 1, active: true, activationMode: 'auto',
        maximized: false, snapped: false,
        config: { type: 'chart', dataSource: 'raw', channels: [{ channelId, protocolTemplateId: null }], chart: config },
      }],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps displaying new samples after automatic scale changes', async () => {
    render(<CanvasChart canvasId={canvasId} />);
    const start = 1_790_000_000_000;
    await packet(start);
    await packet(start + 1000, 20);
    await packet(start + 2000, 30);
    expect(plot().data[0]).toEqual([start, start + 1000, start + 2000]);
    expect(plot().scales.x.max).toBeGreaterThanOrEqual(start + 2000);
  });

  it('starts rendering when series are added to an empty chart', async () => {
    configure({ ...config, series: [] });
    render(<CanvasChart canvasId={canvasId} />);
    configure(config);
    await packet(1000);
    expect(plots.length).toBeGreaterThan(0);
    expect(plot().data[0]).toEqual([1000]);
  });

  it('preserves a user range during streaming and resumes following after reset', async () => {
    render(<CanvasChart canvasId={canvasId} />);
    await packet(1000);
    await packet(2000, 20);
    fireEvent.wheel(plot().over, { deltaY: 1 });
    await act(async () => {});
    const range = { min: plot().scales.x.min, max: plot().scales.x.max };
    await packet(3000, 30);
    expect({ min: plot().scales.x.min, max: plot().scales.x.max }).toEqual(range);
    fireEvent.click(screen.getByText('Reset Zoom'));
    await packet(4000, 40);
    expect(plot().data[0]).toEqual([1000, 2000, 3000, 4000]);
  });

  it('keeps the plot and hidden series intact when resizing', async () => {
    render(<CanvasChart canvasId={canvasId} />);
    await packet(1000);
    await act(async () => { fireEvent.click(screen.getByTitle('Hide series')); });
    const previous = plot();
    await act(async () => { width = 600; resizeCallback?.(); });
    expect(plot()).toBe(previous);
    expect(plot().width).toBe(600);
    expect(plot().series[1].show).toBe(false);
  });

  it('uses millisecond increments for millisecond timestamps', async () => {
    render(<CanvasChart canvasId={canvasId} />);
    await packet(1_790_000_000_000);
    const increments = plot().axes[0].incrs;
    if (typeof increments !== 'function') throw new Error('Expected uPlot time increments');
    // Date-based millisecond timestamps must never use sub-millisecond tick steps.
    expect(Math.min(...increments(plot(), 0, 0, 1000, 80, 80))).toBe(1);
  });

  it('resumes automatic ranges after clearing a zoomed chart', async () => {
    render(<CanvasChart canvasId={canvasId} />);
    await packet(1000);
    await packet(2000, 20);
    await act(async () => { fireEvent.wheel(plot().over, { deltaY: 1 }); });
    await act(async () => { fireEvent.click(screen.getByText('Clear')); });
    await packet(5000, 30);
    await packet(6000, 40);
    expect(plot().data[0]).toEqual([5000, 6000]);
    expect(plot().scales.x.max).toBeGreaterThanOrEqual(6000);
  });

  it('keeps pause effective when chart configuration recreates the runtime', async () => {
    render(<CanvasChart canvasId={canvasId} />);
    await packet(1000);
    fireEvent.click(screen.getByText('Pause'));
    configure({ ...config, series: [...config.series, { ...config.series[0], id: 'second', name: 'Second' }] });
    await packet(2000, 20);
    expect(plot().data).toEqual([[], [], []]);
    fireEvent.click(screen.getByText('Resume'));
    await packet(3000, 30);
    expect(plot().data).toEqual([[2000, 3000], [20, 30], [20, 30]]);
  });

  it('switches chart kinds without reusing the previous data shape', async () => {
    render(<CanvasChart canvasId={canvasId} />);
    await packet(1000);
    configure({ kind: 'bar', yAxis: { mode: 'auto' }, series: config.series });
    await packet(2000, 25);
    expect(plot().data).toEqual([[0], [25]]);
    configure({
      kind: 'scatter', yAxis: { mode: 'auto' },
      series: [{ id: 'point', name: 'Point', color: '#ff0000', xExtractor: config.series[0].extractor, yExtractor: config.series[0].extractor }],
    });
    await packet(3000, 30);
    expect(plot().data).toEqual([[30], [30]]);
  });
});
