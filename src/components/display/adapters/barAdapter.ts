import uPlot from 'uplot';
import { BarChartConfig } from '../../../types';
import { getChartTheme } from './theme';

const DEFAULT_BAR_COLOR = '#a78bfa';
const ORDINAL_SCALE_DISTR = 2;
const COLOR_FACET_UNIT = 3;

function getVisibleBarColor(color: string): string {
  return color === 'none' ? 'transparent' : color;
}

function getBarColors(config: BarChartConfig): string[] {
  return config.series.map((series) => getVisibleBarColor(series.color));
}

function getBarColor(colors: string[], index: number): string {
  return colors[index] ?? colors[0] ?? DEFAULT_BAR_COLOR;
}

function buildYScale(config: BarChartConfig): uPlot.Scale {
  if (config.yAxis.mode === 'manual') {
    const min = config.yAxis.min;
    const max = config.yAxis.max === config.yAxis.min ? config.yAxis.max + 1 : config.yAxis.max;
    return { auto: false, range: [min, max] };
  }

  return {
    auto: true,
    range: (_u, min, max) => {
      if (min === max) {
        return [Math.min(0, min - 1), max + 1];
      }
      return [Math.min(0, min), max];
    },
  };
}

export function buildBarOptions(config: BarChartConfig, width: number, height: number): uPlot.Options {
  const barColors = getBarColors(config);
  const theme = getChartTheme();

  return {
    width,
    height,
    pxAlign: true,
    padding: [6, 6, 6, 6],
    scales: {
      x: { distr: ORDINAL_SCALE_DISTR },
      y: buildYScale(config),
    },
    axes: [
      {
        size: 22,
        gap: 2,
        stroke: theme.axisStroke,
        grid: { show: false },
        values: (_u, splits) => splits.map((value) => config.series[Math.round(value)]?.name ?? ''),
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
      drag: { x: false, y: true, setScale: false },
      points: { show: false },
    },
    legend: { show: false },
    series: [
      { label: 'Category' },
      {
        label: 'Value',
        scale: 'y',
        width: 1,
        stroke: DEFAULT_BAR_COLOR,
        fill: DEFAULT_BAR_COLOR,
        value: (_u, rawValue, _seriesIdx, dataIdx) => {
          if (dataIdx === null) {
            return '—';
          }
          const name = config.series[dataIdx]?.name ?? 'Value';
          return `${name}: ${uPlot.fmtNum(rawValue)}`;
        },
        points: { show: false },
        paths: uPlot.paths.bars?.({
          size: [0.7, 120],
          disp: {
            fill: {
              unit: COLOR_FACET_UNIT,
              values: (_plot, _seriesIdx, idx0, idx1) => {
                const colors: string[] = [];
                for (let index = idx0; index <= idx1; index += 1) {
                  colors.push(getBarColor(barColors, index));
                }
                return colors;
              },
            },
            stroke: {
              unit: COLOR_FACET_UNIT,
              values: (_plot, _seriesIdx, idx0, idx1) => {
                const colors: string[] = [];
                for (let index = idx0; index <= idx1; index += 1) {
                  colors.push(getBarColor(barColors, index));
                }
                return colors;
              },
            },
          },
        }),
      },
    ],
  };
}
