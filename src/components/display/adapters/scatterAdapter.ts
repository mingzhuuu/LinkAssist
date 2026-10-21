import uPlot from 'uplot';
import { ScatterChartConfig } from '../../../types';
import { getChartTheme } from './theme';

function isSeriesHiddenByColor(color: string): boolean {
  return color === 'none';
}

function buildYScale(config: ScatterChartConfig): uPlot.Scale {
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

export function buildScatterOptions(config: ScatterChartConfig, width: number, height: number): uPlot.Options {
  const theme = getChartTheme();
  return {
    width,
    height,
    pxAlign: true,
    padding: [6, 6, 6, 6],
    scales: {
      x: { time: false },
      y: buildYScale(config),
    },
    axes: [
      {
        size: 22,
        gap: 2,
        stroke: theme.axisStroke,
        grid: { stroke: theme.gridStroke },
        values: (_u, splits) => splits.map((value) => uPlot.fmtNum(value)),
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
      points: { show: true, size: 8 },
    },
    legend: { show: false },
    series: [
      { label: 'X', value: (_u, rawValue) => uPlot.fmtNum(rawValue) },
      ...config.series.map((series) => ({
        label: series.name,
        show: !isSeriesHiddenByColor(series.color),
        scale: 'y',
        stroke: isSeriesHiddenByColor(series.color) ? 'transparent' : series.color,
        width: 0,
        paths: () => null,
        points: {
          show: !isSeriesHiddenByColor(series.color),
          size: 6,
          width: 2,
          stroke: isSeriesHiddenByColor(series.color) ? 'transparent' : series.color,
          fill: isSeriesHiddenByColor(series.color) ? 'transparent' : series.color,
        },
        value: (_u: uPlot, rawValue: number, _seriesIdx: number, dataIdx: number | null) => {
          if (dataIdx === null) {
            return '—';
          }
          return `(${uPlot.fmtNum(rawValue)})`;
        },
      })),
    ],
  };
}
