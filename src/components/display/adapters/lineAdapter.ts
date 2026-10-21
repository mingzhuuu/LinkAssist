import uPlot from 'uplot';
import type { LineChartConfig, TimeFormatConfig } from '../../../types';
import { getChartTheme } from './theme';

function isSeriesHiddenByColor(color: string): boolean {
  return color === 'none';
}

function buildTimeFormatString(timeFormat?: TimeFormatConfig): string {
  const tf = timeFormat ?? { hour: true, minute: true, second: true, millisecond: false };
  const parts: string[] = [];
  if (tf.hour) parts.push('{HH}');
  if (tf.minute) parts.push('{mm}');
  if (tf.second) parts.push('{ss}');
  if (tf.millisecond) parts.push('{fff}');
  return parts.join(':');
}

function getTimeAxisSpace(timeFormat?: TimeFormatConfig): number {
  const tf = timeFormat ?? { hour: true, minute: true, second: true, millisecond: false };
  let space = 30;
  if (tf.hour) space += 20;
  if (tf.minute) space += 15;
  if (tf.second) space += 15;
  if (tf.millisecond) space += 25;
  return space;
}

function buildYScale(config: LineChartConfig): uPlot.Scale {
  if (config.yAxis.mode === 'manual') {
    const min = config.yAxis.min;
    const max = config.yAxis.max === config.yAxis.min ? config.yAxis.max + 1 : config.yAxis.max;
    return { auto: false, range: [min, max] };
  }

  return {
    auto: true,
    range: (_u, min, max) => {
      if (min === max) {
        return [min - 1, max + 1];
      }
      return [min, max];
    },
  };
}

export function buildLineOptions(config: LineChartConfig, width: number, height: number): uPlot.Options {
  const usesTimeAxis = config.xSource.kind === 'timestamp';
  const timeFormat = config.xSource.kind === 'timestamp' ? config.xSource.timeFormat : undefined;
  const timeFormatter = uPlot.fmtDate(buildTimeFormatString(timeFormat));
  const theme = getChartTheme();

  return {
    width,
    height,
    // Packet timestamps and Date formatting both use milliseconds.
    ms: 1,
    pxAlign: true,
    padding: [6, 6, 6, 6],
    scales: {
      x: { time: usesTimeAxis },
      y: buildYScale(config),
    },
    axes: [
      {
        size: 22,
        gap: 2,
        space: usesTimeAxis ? getTimeAxisSpace(timeFormat) : 40,
        stroke: theme.axisStroke,
        grid: { stroke: theme.gridStroke },
        values: usesTimeAxis
          ? (_u, splits) => splits.map((value) => timeFormatter(new Date(value)))
          : (_u, splits) => splits.map((value) => uPlot.fmtNum(value)),
      },
      {
        size: 28,
        gap: 2,
        stroke: theme.axisStroke,
        grid: { stroke: theme.gridStroke },
        values: (_u, splits) => splits.map((value) => uPlot.fmtNum(value)),
      },
    ],
    cursor: {
      show: true,
      x: true,
      y: true,
      drag: { x: true, y: true, setScale: false },
      points: { show: false },
    },
    legend: { show: false },
    series: [
      {
        label: usesTimeAxis ? 'Time' : 'X',
        value: (_u, rawValue) => usesTimeAxis ? timeFormatter(new Date(rawValue)) : uPlot.fmtNum(rawValue),
      },
      ...config.series.map((series) => ({
        label: series.name,
        show: !isSeriesHiddenByColor(series.color),
        scale: 'y',
        stroke: isSeriesHiddenByColor(series.color) ? 'transparent' : series.color,
        width: 2,
        spanGaps: true,
        paths: uPlot.paths.linear?.(),
        points: { show: false },
        value: (_u: uPlot, rawValue: number) => uPlot.fmtNum(rawValue),
      })),
    ],
  };
}
