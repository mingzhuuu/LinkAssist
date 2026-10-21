import { BarChartConfig, ChartConfig, LineChartConfig, ScatterChartConfig } from '../../types';
import type { ParsedField, ParseResult } from '../../types';
import { extractNumeric } from './chartDataUtils';
import { buildFormulaVariableDefinitions, FormulaVariableContext } from './formulaUtils';
import { invoke } from '@tauri-apps/api/core';
import { reportProtocolParseError, reportProtocolParseResult } from './protocolParseDiagnostics';

export type ChartSnapshot = [number[], ...Array<Array<number | null>>];

interface ChartScaleRange {
  min: number;
  max: number;
}

type RuntimeSubscriber = () => void;

interface PendingPacket {
  channelId: string;
  data: number[];
  timestamp: number;
  protocolFile?: string;
  protocolResourceRoot?: string;
}

interface RuntimeBaseState {
  kind: ChartConfig['kind'];
  chartConfig: ChartConfig;
  channelIds: Set<string>;
  dirty: boolean;
  paused: boolean;
  pendingPackets: PendingPacket[];
  subscribers: Set<RuntimeSubscriber>;
  /**
   * In-order packet backlog drained by a single pump. Bounded (drop-oldest)
   * so a data rate above parse throughput increases loss, not display lag.
   */
  liveQueue: PendingPacket[];
  pumping: boolean;
  /** Bumped by clear(); in-flight queued packets from before are dropped. */
  generation: number;
}

interface LineRuntimeState extends RuntimeBaseState {
  kind: 'line';
  chartConfig: LineChartConfig;
  xValues: number[];
  seriesValues: Array<Array<number | null>>;
}

interface BarRuntimeState extends RuntimeBaseState {
  kind: 'bar';
  chartConfig: BarChartConfig;
  xValues: number[];
  latestValues: Array<number | null>;
}

interface ScatterRuntimeState extends RuntimeBaseState {
  kind: 'scatter';
  chartConfig: ScatterChartConfig;
  xValues: number[];
  seriesValues: Array<Array<number | null>>;
}

type ChartRuntimeState = LineRuntimeState | BarRuntimeState | ScatterRuntimeState;

const runtimes = new Map<string, ChartRuntimeState>();
const DEFAULT_RENDER_LIMIT = 1200;
const MAX_HISTORY_POINTS = 20000;
const MAX_PENDING_PACKETS = 5000;
const MAX_LIVE_QUEUE = 256;

function notify(runtime: ChartRuntimeState): void {
  runtime.dirty = true;
  runtime.subscribers.forEach((callback) => callback());
}

function trimAlignedArrays(xValues: number[], seriesValues: Array<Array<number | null>>, limit: number): void {
  if (xValues.length <= limit) {
    return;
  }

  const removeCount = Math.max(xValues.length - limit, Math.ceil(limit * 0.2));
  xValues.splice(0, removeCount);
  seriesValues.forEach((values) => values.splice(0, removeCount));
}

function buildPointIndices(length: number, limit: number): number[] {
  if (length <= limit) {
    return Array.from({ length }, (_, index) => index);
  }

  const step = (length - 1) / Math.max(1, limit - 1);
  const indices = new Set<number>([0, length - 1]);
  for (let index = 1; index < limit - 1; index += 1) {
    indices.add(Math.round(index * step));
  }

  return [...indices].sort((left, right) => left - right);
}

function filterIndicesByRange(xValues: number[], range?: ChartScaleRange): number[] {
  if (!range) {
    return Array.from({ length: xValues.length }, (_, index) => index);
  }

  return xValues.reduce<number[]>((indices, value, index) => {
    if (value >= range.min && value <= range.max) {
      indices.push(index);
    }
    return indices;
  }, []);
}

function buildSampledSnapshot(
  xValues: number[],
  seriesValues: Array<Array<number | null>>,
  range?: ChartScaleRange,
): ChartSnapshot {
  const candidateIndices = filterIndicesByRange(xValues, range);
  const finalIndices = buildPointIndices(candidateIndices.length, range ? candidateIndices.length : DEFAULT_RENDER_LIMIT)
    .map((index) => candidateIndices[index])
    .filter((index): index is number => index !== undefined);

  return [
    finalIndices.map((index) => xValues[index]),
    ...seriesValues.map((values) => finalIndices.map((index) => values[index] ?? null)),
  ];
}

async function resolveParsedFields(packet: PendingPacket): Promise<ParsedField[]> {
  if (!packet.protocolFile) return [];
  try {
    const result = await invoke<ParseResult>('parse_data_with_lua_file', {
      filePath: packet.protocolFile,
      resourceRoot: packet.protocolResourceRoot,
      data: packet.data,
    });
    reportProtocolParseResult(packet.channelId, packet.protocolFile, result);
    return result.fields;
  } catch (error) {
    reportProtocolParseError(packet.channelId, packet.protocolFile, error);
    return [];
  }
}

function buildSeriesFormulaVariables(series: Array<{ name: string }>) {
  return buildFormulaVariableDefinitions(
    series.map((item, index) => ({
      label: item.name,
      fallback: `series_${index + 1}`,
    })),
  );
}

function processLinePacket(runtime: LineRuntimeState, data: number[], timestamp: number, parsedFields?: ParsedField[]): void {
  const xValue = runtime.chartConfig.xSource.kind === 'timestamp'
    ? timestamp
    : extractNumeric(runtime.chartConfig.xSource.extractor, data, parsedFields);

  if (xValue === null) {
    return;
  }

  runtime.xValues.push(xValue);
  const formulaVariables: FormulaVariableContext = {};
  const seriesFormulaVariables = buildSeriesFormulaVariables(runtime.chartConfig.series);
  runtime.chartConfig.series.forEach((series, index) => {
    const value = extractNumeric(series.extractor, data, parsedFields, formulaVariables);
    runtime.seriesValues[index].push(value);
    formulaVariables[seriesFormulaVariables[index].identifier] = value ?? undefined;
  });

  trimAlignedArrays(runtime.xValues, runtime.seriesValues, MAX_HISTORY_POINTS);
}

function processBarPacket(runtime: BarRuntimeState, data: number[], parsedFields?: ParsedField[]): void {
  const formulaVariables: FormulaVariableContext = {};
  const seriesFormulaVariables = buildSeriesFormulaVariables(runtime.chartConfig.series);
  runtime.chartConfig.series.forEach((series, index) => {
    const value = extractNumeric(series.extractor, data, parsedFields, formulaVariables);
    runtime.latestValues[index] = value;
    formulaVariables[seriesFormulaVariables[index].identifier] = value ?? undefined;
  });
}

function appendScatterPoint(runtime: ScatterRuntimeState, seriesIndex: number, xValue: number, yValue: number): void {
  runtime.xValues.push(xValue);
  runtime.seriesValues.forEach((values, index) => {
    values.push(index === seriesIndex ? yValue : null);
  });

  trimAlignedArrays(runtime.xValues, runtime.seriesValues, MAX_HISTORY_POINTS);
}

function processScatterPacket(runtime: ScatterRuntimeState, data: number[], parsedFields?: ParsedField[]): void {
  const formulaVariables: FormulaVariableContext = {};
  const seriesFormulaVariables = buildSeriesFormulaVariables(runtime.chartConfig.series);
  runtime.chartConfig.series.forEach((series, seriesIndex) => {
    const xValue = extractNumeric(series.xExtractor, data, parsedFields, formulaVariables);
    const yValue = extractNumeric(series.yExtractor, data, parsedFields, formulaVariables);

    formulaVariables[seriesFormulaVariables[seriesIndex].identifier] = yValue ?? undefined;

    if (xValue === null || yValue === null) {
      return;
    }

    appendScatterPoint(runtime, seriesIndex, xValue, yValue);
  });
}

function processPacket(runtime: ChartRuntimeState, packet: PendingPacket, parsedFields: ParsedField[]): void {
  switch (runtime.kind) {
    case 'line':
      processLinePacket(runtime, packet.data, packet.timestamp, parsedFields);
      break;
    case 'bar':
      processBarPacket(runtime, packet.data, parsedFields);
      break;
    case 'scatter':
      processScatterPacket(runtime, packet.data, parsedFields);
      break;
  }
}

function createLineRuntime(chartConfig: LineChartConfig, channelIds: string[]): LineRuntimeState {
  return {
    kind: 'line',
    chartConfig,
    channelIds: new Set(channelIds),
    dirty: true,
    paused: false,
    pendingPackets: [],
    subscribers: new Set(),
    liveQueue: [],
    pumping: false,
    generation: 0,
    xValues: [],
    seriesValues: chartConfig.series.map(() => []),
  };
}

function createBarRuntime(chartConfig: BarChartConfig, channelIds: string[]): BarRuntimeState {
  return {
    kind: 'bar',
    chartConfig,
    channelIds: new Set(channelIds),
    dirty: true,
    paused: false,
    pendingPackets: [],
    subscribers: new Set(),
    liveQueue: [],
    pumping: false,
    generation: 0,
    xValues: chartConfig.series.map((_, index) => index),
    latestValues: chartConfig.series.map(() => null),
  };
}

function createScatterRuntime(chartConfig: ScatterChartConfig, channelIds: string[]): ScatterRuntimeState {
  return {
    kind: 'scatter',
    chartConfig,
    channelIds: new Set(channelIds),
    dirty: true,
    paused: false,
    pendingPackets: [],
    subscribers: new Set(),
    liveQueue: [],
    pumping: false,
    generation: 0,
    xValues: [],
    seriesValues: chartConfig.series.map(() => []),
  };
}

export function createRuntime(canvasId: string, chartConfig: ChartConfig, channelIds: string[]): void {
  const runtime = chartConfig.kind === 'line'
    ? createLineRuntime(chartConfig, channelIds)
    : chartConfig.kind === 'bar'
      ? createBarRuntime(chartConfig, channelIds)
      : createScatterRuntime(chartConfig, channelIds);

  runtimes.set(canvasId, runtime);
}

/** Bound the live backlog: keep the freshest packets, drop the oldest. */
function capLiveQueue(runtime: ChartRuntimeState): void {
  if (runtime.liveQueue.length > MAX_LIVE_QUEUE) {
    runtime.liveQueue.splice(0, runtime.liveQueue.length - MAX_LIVE_QUEUE);
  }
}

/**
 * Single in-order consumer per runtime. Raw packets process synchronously;
 * parsed packets await one backend call each, so ordering is preserved
 * without letting an unbounded promise chain accumulate lag.
 */
async function pumpLiveQueue(runtime: ChartRuntimeState): Promise<void> {
  if (runtime.pumping) return;
  runtime.pumping = true;
  try {
    while (runtime.liveQueue.length > 0) {
      const generation = runtime.generation;
      const packet = runtime.liveQueue.shift()!;
      let parsedFields: ParsedField[] = [];
      if (packet.protocolFile) {
        parsedFields = await resolveParsedFields(packet);
        if (runtime.generation !== generation) continue;
      }
      processPacket(runtime, packet, parsedFields);
      notify(runtime);
    }
  } catch (error) {
    console.error(error);
  } finally {
    runtime.pumping = false;
  }
}

export function ingestPacket(
  canvasId: string,
  channelId: string,
  data: number[],
  timestamp: number,
  protocolFile?: string,
  protocolResourceRoot?: string,
): void {
  const runtime = runtimes.get(canvasId);
  if (!runtime || !runtime.channelIds.has(channelId)) {
    return;
  }

  const packet: PendingPacket = { channelId, data, timestamp, protocolFile, protocolResourceRoot };

  if (runtime.paused) {
    runtime.pendingPackets.push(packet);
    // Bound memory during long pauses; drop the oldest packets first.
    if (runtime.pendingPackets.length > MAX_PENDING_PACKETS) {
      runtime.pendingPackets.splice(0, runtime.pendingPackets.length - MAX_PENDING_PACKETS);
    }
    return;
  }

  runtime.liveQueue.push(packet);
  capLiveQueue(runtime);
  void pumpLiveQueue(runtime);
}

export function getSnapshot(canvasId: string, xRange?: ChartScaleRange): ChartSnapshot {
  const runtime = runtimes.get(canvasId);
  if (!runtime) {
    return [[], []];
  }

  runtime.dirty = false;

  switch (runtime.kind) {
    case 'line':
    case 'scatter':
      return buildSampledSnapshot(runtime.xValues, runtime.seriesValues, xRange);
    case 'bar':
      return [[...runtime.xValues], [...runtime.latestValues]];
  }
}

export function subscribe(canvasId: string, callback: RuntimeSubscriber): () => void {
  const runtime = runtimes.get(canvasId);
  if (!runtime) {
    return () => undefined;
  }

  runtime.subscribers.add(callback);
  return () => {
    runtime.subscribers.delete(callback);
  };
}

export function dispose(canvasId: string): void {
  runtimes.delete(canvasId);
}

export function setPaused(canvasId: string, paused: boolean): void {
  const runtime = runtimes.get(canvasId);
  if (!runtime || runtime.paused === paused) {
    return;
  }

  runtime.paused = paused;

  if (!paused && runtime.pendingPackets.length > 0) {
    // Packets buffered during the pause precede anything that arrives now.
    runtime.liveQueue.unshift(...runtime.pendingPackets);
    runtime.pendingPackets = [];
    capLiveQueue(runtime);
    void pumpLiveQueue(runtime);
    return;
  }

  notify(runtime);
}

export function clear(canvasId: string): void {
  const runtime = runtimes.get(canvasId);
  if (!runtime) {
    return;
  }

  runtime.pendingPackets = [];
  runtime.liveQueue = [];
  // Invalidate the packet the pump may be awaiting right now so it can't
  // repopulate the chart after this reset.
  runtime.generation += 1;

  switch (runtime.kind) {
    case 'line':
    case 'scatter':
      runtime.xValues = [];
      runtime.seriesValues = runtime.chartConfig.series.map(() => []);
      break;
    case 'bar':
      runtime.xValues = runtime.chartConfig.series.map((_, index) => index);
      runtime.latestValues = runtime.chartConfig.series.map(() => null);
      break;
  }

  notify(runtime);
}
