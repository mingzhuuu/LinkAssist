import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useCanvasStore } from '../../stores';
import { ChartConfig, YAxisConfig } from '../../types';
import { buildBarOptions, buildLineOptions, buildScatterOptions } from './adapters';
import {
  ChartSnapshot,
  clear,
  createRuntime,
  dispose,
  getSnapshot,
  setPaused,
  subscribe,
} from './chartRuntime';
import { ChartToolbar } from './ChartToolbar';

interface CanvasChartProps {
  canvasId: string;
  isMoving?: boolean;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

interface ScaleRange {
  min: number;
  max: number;
}

function isSeriesHiddenByColor(color: string): boolean {
  return color === 'none';
}

function buildOptions(config: ChartConfig, width: number, height: number, plugin: uPlot.Plugin): uPlot.Options {
  const options = config.kind === 'line'
    ? buildLineOptions(config, width, height)
    : config.kind === 'bar'
      ? buildBarOptions(config, width, height)
      : buildScatterOptions(config, width, height);

  return {
    ...options,
    plugins: [...(options.plugins ?? []), plugin],
  };
}

function getScaleLimits(plot: uPlot, scaleKey: string): { min: number; max: number } | null {
  const scale = plot.scales[scaleKey];
  if (!scale || typeof scale.min !== 'number' || typeof scale.max !== 'number') {
    return null;
  }

  return { min: scale.min, max: scale.max };
}

function buildTooltipState(
  plot: uPlot,
  config: ChartConfig,
  seriesVisibility: Record<string, boolean>,
): TooltipState | null {
  const dataIdx = plot.cursor.idx;
  const cursorLeft = plot.cursor.left;
  const cursorTop = plot.cursor.top;

  if (typeof dataIdx !== 'number' || cursorLeft === undefined || cursorTop === undefined) {
    return null;
  }

  const xValues = plot.data[0] as ArrayLike<number>;
  const xValue = xValues[dataIdx];
  if (typeof xValue !== 'number') {
    return null;
  }

  if (config.kind === 'bar') {
    const yValues = plot.data[1] as ArrayLike<number | null | undefined>;
    const value = yValues[dataIdx];
    const series = config.series[dataIdx];
    if (!series || !seriesVisibility[series.id]) {
      return null;
    }

    return {
      x: cursorLeft,
      y: cursorTop,
      title: series.name,
      lines: [value == null ? '—' : `Value: ${uPlot.fmtNum(value)}`],
    };
  }

  const lines = config.series
    .map((series, index) => {
      if (!seriesVisibility[series.id]) {
        return null;
      }

      const yValues = plot.data[index + 1] as ArrayLike<number | null | undefined>;
      const value = yValues[dataIdx];
      if (value == null) {
        return null;
      }

      if (config.kind === 'scatter') {
        return `${series.name}: (${uPlot.fmtNum(xValue)}, ${uPlot.fmtNum(value)})`;
      }

      return `${series.name}: ${uPlot.fmtNum(value)}`;
    })
    .filter((line): line is string => line !== null);

  if (lines.length === 0) {
    return null;
  }

  return {
    x: cursorLeft,
    y: cursorTop,
    title: config.kind === 'line' && config.xSource.kind === 'timestamp'
      ? new Date(xValue).toLocaleTimeString()
      : `X: ${uPlot.fmtNum(xValue)}`,
    lines,
  };
}

function applySeriesVisibility(
  config: ChartConfig,
  snapshot: ChartSnapshot,
  seriesVisibility: Record<string, boolean>,
): ChartSnapshot {
  if (config.kind !== 'bar') {
    return snapshot;
  }

  const xValues = [...snapshot[0]];
  const yValues = [...(snapshot[1] ?? [])];
  config.series.forEach((series, index) => {
    if (!seriesVisibility[series.id]) {
      yValues[index] = null;
    }
  });

  return [xValues, yValues];
}

export const CanvasChart: React.FC<CanvasChartProps> = ({ canvasId, isMoving }) => {
  const canvases = useCanvasStore((state) => state.canvases);
  const chartViewState = useCanvasStore((state) => state.chartViewState[canvasId]);
  const setChartPaused = useCanvasStore((state) => state.setChartPaused);
  const canvas = canvases.find((item) => item.id === canvasId);
  const chartConfig = canvas?.config.chart;

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [yAxisOverride, setYAxisOverride] = useState<YAxisConfig | null>(null);
  const [seriesVisibility, setSeriesVisibility] = useState<Record<string, boolean>>({});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const plotHostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const redrawTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(true);
  const latestSnapshotRef = useRef<ChartSnapshot | null>(null);
  const xRangeRef = useRef<ScaleRange | undefined>(undefined);
  const isZoomedRef = useRef(false);
  const isSelectingRef = useRef(false);
  const selectStartRef = useRef({ x: 0, y: 0 });
  const selectionDivRef = useRef<HTMLDivElement | null>(null);
  const seriesVisibilityRef = useRef(seriesVisibility);

  const paused = chartViewState?.paused ?? false;
  const hasSeries = (chartConfig?.series.length ?? 0) > 0;
  const hasSize = size.width > 0 && size.height > 0;

  useLayoutEffect(() => {
    seriesVisibilityRef.current = seriesVisibility;
  }, [seriesVisibility]);

  useEffect(() => {
    if (!chartConfig || !hasSeries) {
      setSeriesVisibility({});
      return;
    }

    setSeriesVisibility(Object.fromEntries(chartConfig.series.map((series) => [series.id, !isSeriesHiddenByColor(series.color)])));
    setYAxisOverride(null);
  }, [chartConfig, hasSeries]);

  const effectiveChartConfig = useMemo<ChartConfig | null>(() => {
    if (!chartConfig) {
      return null;
    }

    return yAxisOverride ? { ...chartConfig, yAxis: yAxisOverride } : chartConfig;
  }, [chartConfig, yAxisOverride]);

  const plugin = useMemo<uPlot.Plugin>(() => ({
    hooks: {
      setCursor: [
        (plot) => {
          if (!effectiveChartConfig) {
            return;
          }

          setTooltip(buildTooltipState(plot, effectiveChartConfig, seriesVisibilityRef.current));
        },
      ],
    },
  }), [effectiveChartConfig]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      const nextWidth = Math.max(120, Math.floor(entry.contentRect.width));
      const nextHeight = Math.max(120, Math.floor(entry.contentRect.height));
      setSize((current) => current.width === nextWidth && current.height === nextHeight
        ? current
        : { width: nextWidth, height: nextHeight });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [hasSeries]);

  useLayoutEffect(() => {
    if (!chartConfig || !hasSeries) {
      return;
    }

    createRuntime(canvasId, chartConfig, canvas?.config.channels.map((link) => link.channelId) ?? []);
    dirtyRef.current = true;
    xRangeRef.current = undefined;
    isZoomedRef.current = false;
    latestSnapshotRef.current = getSnapshot(canvasId);

    const unsubscribe = subscribe(canvasId, () => {
      dirtyRef.current = true;
    });

    return () => {
      unsubscribe();
      dispose(canvasId);
    };
  }, [canvas?.config.channels, canvasId, chartConfig, hasSeries]);

  useEffect(() => {
    setPaused(canvasId, paused);
  }, [canvasId, paused, chartConfig, canvas?.config.channels, hasSeries]);

  useLayoutEffect(() => {
    if (!effectiveChartConfig || !hasSeries || !plotHostRef.current || !hasSize) {
      return;
    }

    plotRef.current?.destroy();
    plotHostRef.current.innerHTML = '';

    const visibility = seriesVisibilityRef.current;
    const options = buildOptions(effectiveChartConfig, size.width, size.height, plugin);
    if (effectiveChartConfig.kind !== 'bar') {
      effectiveChartConfig.series.forEach((series, index) => {
        options.series[index + 1].show = visibility[series.id] ?? !isSeriesHiddenByColor(series.color);
      });
    }
    latestSnapshotRef.current = getSnapshot(canvasId, xRangeRef.current);

    const plot = new uPlot(
      options,
      applySeriesVisibility(
        effectiveChartConfig,
        latestSnapshotRef.current,
        visibility,
      ),
      plotHostRef.current,
    );
    if (xRangeRef.current) {
      plot.setScale('x', xRangeRef.current);
    }

    const handleMouseLeave = () => setTooltip(null);
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();

      const scaleKey = event.shiftKey ? 'y' : 'x';
      const scale = getScaleLimits(plot, scaleKey);
      if (!scale) {
        return;
      }

      const range = scale.max - scale.min;
      if (range <= 0) {
        return;
      }

      const delta = range * 0.08 * Math.sign(event.deltaY || 1);
      const nextRange = { min: scale.min + delta, max: scale.max + delta };
      isZoomedRef.current = true;
      if (scaleKey === 'x') xRangeRef.current = nextRange;
      plot.setScale(scaleKey, nextRange);
      dirtyRef.current = true;
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey) return;
      event.preventDefault();
      isSelectingRef.current = true;
      selectStartRef.current = { x: event.offsetX, y: event.offsetY };

      const div = document.createElement('div');
      div.className = 'pointer-events-none absolute border border-accent-primary/70 bg-accent-primary/10';
      div.style.left = `${event.offsetX}px`;
      div.style.top = `${event.offsetY}px`;
      div.style.width = '0px';
      div.style.height = '0px';
      plot.over.appendChild(div);
      selectionDivRef.current = div;
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (!isSelectingRef.current || !selectionDivRef.current) return;
      const startX = selectStartRef.current.x;
      const startY = selectStartRef.current.y;
      const div = selectionDivRef.current;
      div.style.left = `${Math.min(startX, event.offsetX)}px`;
      div.style.top = `${Math.min(startY, event.offsetY)}px`;
      div.style.width = `${Math.abs(event.offsetX - startX)}px`;
      div.style.height = `${Math.abs(event.offsetY - startY)}px`;
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (!isSelectingRef.current) return;
      isSelectingRef.current = false;
      selectionDivRef.current?.remove();
      selectionDivRef.current = null;

      const startX = selectStartRef.current.x;
      const startY = selectStartRef.current.y;
      const width = Math.abs(event.offsetX - startX);
      const height = Math.abs(event.offsetY - startY);

      if (width < 5 || height < 5) return;

      const left = Math.min(startX, event.offsetX);
      const top = Math.min(startY, event.offsetY);
      const xMin = plot.posToVal(left, 'x');
      const xMax = plot.posToVal(left + width, 'x');
      const yMin = plot.posToVal(top + height, 'y');
      const yMax = plot.posToVal(top, 'y');

      isZoomedRef.current = true;
      xRangeRef.current = { min: Math.min(xMin, xMax), max: Math.max(xMin, xMax) };
      plot.setScale('x', xRangeRef.current);
      plot.setScale('y', { min: Math.min(yMin, yMax), max: Math.max(yMin, yMax) });
      dirtyRef.current = true;
    };

    plot.over.addEventListener('mouseleave', handleMouseLeave);
    plot.over.addEventListener('wheel', handleWheel, { passive: false });
    plot.over.addEventListener('mousedown', handleMouseDown);
    plot.over.addEventListener('mousemove', handleMouseMove);
    plot.over.addEventListener('mouseup', handleMouseUp);
    plotRef.current = plot;

    return () => {
      plot.over.removeEventListener('mouseleave', handleMouseLeave);
      plot.over.removeEventListener('wheel', handleWheel);
      plot.over.removeEventListener('mousedown', handleMouseDown);
      plot.over.removeEventListener('mousemove', handleMouseMove);
      plot.over.removeEventListener('mouseup', handleMouseUp);
      isSelectingRef.current = false;
      selectionDivRef.current?.remove();
      selectionDivRef.current = null;
      plot.destroy();
      if (plotRef.current === plot) {
        plotRef.current = null;
      }
    };
  }, [canvasId, effectiveChartConfig, plugin, hasSeries, hasSize]);

  useLayoutEffect(() => {
    if (hasSize) plotRef.current?.setSize(size);
  }, [size, hasSize]);

  useEffect(() => {
    if (!effectiveChartConfig) {
      return;
    }

    const tick = () => {
      const plot = plotRef.current;
      if (!plot || !dirtyRef.current) {
        return;
      }

      const snapshot = getSnapshot(canvasId, isZoomedRef.current ? xRangeRef.current : undefined);
      latestSnapshotRef.current = snapshot;
      dirtyRef.current = false;
      // Automatic scale changes are not user zooms. Only gestures freeze the view.
      plot.setData(applySeriesVisibility(effectiveChartConfig, snapshot, seriesVisibility), !isZoomedRef.current);
    };

    redrawTimerRef.current = window.setInterval(tick, 60);
    return () => {
      if (redrawTimerRef.current !== null) {
        window.clearInterval(redrawTimerRef.current);
        redrawTimerRef.current = null;
      }
    };
  }, [canvasId, effectiveChartConfig, seriesVisibility]);

  useEffect(() => {
    if (!plotRef.current || !effectiveChartConfig || !latestSnapshotRef.current) {
      return;
    }

    plotRef.current.setData(
      applySeriesVisibility(effectiveChartConfig, latestSnapshotRef.current, seriesVisibility),
      false,
    );

    if (effectiveChartConfig.kind !== 'bar') {
      effectiveChartConfig.series.forEach((series, index) => {
        plotRef.current?.setSeries(index + 1, { show: seriesVisibility[series.id] ?? true }, false);
      });
      plotRef.current.redraw();
    }
  }, [effectiveChartConfig, seriesVisibility]);

  if (!canvas || !effectiveChartConfig || !hasSeries) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-muted">
        Configure chart series to begin streaming.
      </div>
    );
  }

  const handleTogglePause = () => {
    const nextPaused = !paused;
    setChartPaused(canvasId, nextPaused);
    setPaused(canvasId, nextPaused);
  };

  const handleResetZoom = () => {
    const plot = plotRef.current;
    if (!plot || !latestSnapshotRef.current) {
      return;
    }

    isZoomedRef.current = false;
    xRangeRef.current = undefined;
    latestSnapshotRef.current = getSnapshot(canvasId);
    plot.setData(applySeriesVisibility(effectiveChartConfig, latestSnapshotRef.current, seriesVisibility), true);
    plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);

    if (effectiveChartConfig.yAxis.mode === 'manual') {
      plot.setScale('y', {
        min: effectiveChartConfig.yAxis.min,
        max: effectiveChartConfig.yAxis.max === effectiveChartConfig.yAxis.min
          ? effectiveChartConfig.yAxis.max + 1
          : effectiveChartConfig.yAxis.max,
      });
    }
  };

  const handleToggleYAxisMode = () => {
    const plot = plotRef.current;
    const currentMode = effectiveChartConfig.yAxis.mode;
    if (!chartConfig) {
      return;
    }

    if (currentMode === 'auto') {
      const limits = plot ? getScaleLimits(plot, 'y') : null;
      setYAxisOverride(
        limits
          ? { mode: 'manual', min: limits.min, max: limits.max }
          : { mode: 'manual', min: 0, max: 1 },
      );
      return;
    }

    if (chartConfig.yAxis.mode === 'manual' && yAxisOverride === null) {
      setYAxisOverride({ mode: 'auto' });
      return;
    }

    setYAxisOverride(null);
  };

  const handleExportPng = () => {
    const canvasElement = plotRef.current?.root.querySelector('canvas');
    if (!(canvasElement instanceof HTMLCanvasElement)) {
      return;
    }

    const link = document.createElement('a');
    link.href = canvasElement.toDataURL('image/png');
    link.download = `${canvas.name.replace(/\s+/g, '-').toLowerCase() || 'chart'}.png`;
    link.click();
  };

  const handleClear = () => {
    clear(canvasId);
    latestSnapshotRef.current = getSnapshot(canvasId);
    xRangeRef.current = undefined;
    isZoomedRef.current = false;
    dirtyRef.current = false;
    if (plotRef.current && latestSnapshotRef.current) {
      plotRef.current.setData(applySeriesVisibility(effectiveChartConfig, latestSnapshotRef.current, seriesVisibility), true);
    }
  };

  const handleToggleSeries = (seriesId: string) => {
    setSeriesVisibility((current) => ({
      ...current,
      [seriesId]: !(current[seriesId] ?? true),
    }));
  };

  return (
    <div className={`group relative h-full w-full bg-surface ${isMoving ? 'pointer-events-none' : ''}`}>
      <div ref={wrapperRef} className="h-full w-full">
        <div ref={plotHostRef} className="h-full w-full" />
      </div>

      <ChartToolbar
        paused={paused}
        yAxisMode={effectiveChartConfig.yAxis.mode}
        series={effectiveChartConfig.series.map((series) => ({
          id: series.id,
          name: series.name,
          color: series.color,
          visible: seriesVisibility[series.id] ?? true,
        }))}
        onTogglePause={handleTogglePause}
        onResetZoom={handleResetZoom}
        onToggleYAxisMode={handleToggleYAxisMode}
        onExportPng={handleExportPng}
        onClear={handleClear}
        onToggleSeries={handleToggleSeries}
      />

      {tooltip && (
        <div
          className="pointer-events-none absolute z-30 max-w-[240px] animate-fade-in rounded-2xl border border-border bg-surface-overlay/95 px-3 py-2 text-xs font-medium text-text-primary shadow-xl shadow-black/30 backdrop-blur-sm"
          style={{
            left: Math.min(Math.max(tooltip.x + 18, 8), Math.max(size.width - 180, 8)),
            top: Math.min(Math.max(tooltip.y + 18, 8), Math.max(size.height - 80, 8)),
          }}
        >
          <div className="mb-1 font-semibold text-text-primary">{tooltip.title}</div>
          <div className="space-y-0.5 font-normal text-text-secondary">
            {tooltip.lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
