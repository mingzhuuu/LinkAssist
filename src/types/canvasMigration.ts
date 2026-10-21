import type { Canvas, CanvasLifecycleScriptConfig, ChartConfig, NumericExtractor, NumericFormat, ScriptConfig, TimeFormatConfig } from './canvas';

type LegacyEndian = 'le' | 'be';
type LegacyRawBaseFormat = 'UInt8' | 'Int8' | 'UInt16' | 'Int16' | 'UInt32' | 'Int32' | 'Float32' | 'Float64';

type LegacyRawNumericExtractor = {
  source: 'raw';
  offset: number;
  format: LegacyRawBaseFormat | NumericFormat;
  endian?: LegacyEndian;
  formula: string;
};

type LegacyParsedNumericExtractor = {
  source: 'parsed';
  fieldId: string;
  formula: string;
};

type CompatibleNumericExtractor = NumericExtractor | LegacyRawNumericExtractor | LegacyParsedNumericExtractor;

type CompatibleSeriesBase = {
  id: string;
  name: string;
  color: string;
  visible?: boolean;
};

type CompatibleLineOrBarSeries = CompatibleSeriesBase & { extractor: CompatibleNumericExtractor };
type CompatibleScatterSeries = CompatibleSeriesBase & { xExtractor: CompatibleNumericExtractor; yExtractor: CompatibleNumericExtractor };

type CompatibleTimestampXAxis = { kind: 'timestamp'; timeFormat?: TimeFormatConfig; format?: string };
type CompatibleExtractorXAxis = { kind: 'extractor'; extractor: CompatibleNumericExtractor };

type CompatibleChartConfig =
  | {
      kind: 'line';
      xSource: CompatibleTimestampXAxis | CompatibleExtractorXAxis;
      series: CompatibleLineOrBarSeries[];
      yAxis: ChartConfig['yAxis'];
    }
  | {
      kind: 'bar';
      series: CompatibleLineOrBarSeries[];
      yAxis: ChartConfig['yAxis'];
    }
  | {
      kind: 'scatter';
      series: CompatibleScatterSeries[];
      yAxis: ChartConfig['yAxis'];
    };

type CompatibleCanvas = Omit<Canvas, 'config'> & {
  config: Canvas['config'] & {
    chart?: CompatibleChartConfig;
    script?: Partial<ScriptConfig> & {
      sourceType?: 'inline' | 'file';
      inlineLua?: string;
      inlineYaml?: string;
      yamlPath?: string;
    };
    lifecycleScript?: Partial<CanvasLifecycleScriptConfig> & {
      sourceType?: 'inline' | 'file';
      inlineLua?: string;
    };
  };
};

function isCurrentNumericFormat(format: string): format is NumericFormat {
  return [
    'UInt8',
    'Int8',
    'UInt16LE',
    'UInt16BE',
    'Int16LE',
    'Int16BE',
    'UInt32LE',
    'UInt32BE',
    'Int32LE',
    'Int32BE',
    'Float32LE',
    'Float32BE',
    'Float64LE',
    'Float64BE',
  ].includes(format);
}

function migrateRawFormat(format: LegacyRawBaseFormat | NumericFormat, endian?: LegacyEndian): NumericFormat {
  if (isCurrentNumericFormat(format)) {
    return format;
  }

  switch (format) {
    case 'UInt16':
      return endian === 'be' ? 'UInt16BE' : 'UInt16LE';
    case 'Int16':
      return endian === 'be' ? 'Int16BE' : 'Int16LE';
    case 'UInt32':
      return endian === 'be' ? 'UInt32BE' : 'UInt32LE';
    case 'Int32':
      return endian === 'be' ? 'Int32BE' : 'Int32LE';
    case 'Float32':
      return endian === 'be' ? 'Float32BE' : 'Float32LE';
    case 'Float64':
      return endian === 'be' ? 'Float64BE' : 'Float64LE';
  }
}

function migrateNumericExtractor(extractor: CompatibleNumericExtractor): NumericExtractor {
  if (extractor.source === 'parsed') {
    return extractor;
  }

  return {
    source: 'raw',
    offset: extractor.offset,
    format: migrateRawFormat(extractor.format, 'endian' in extractor ? extractor.endian : undefined),
    formula: extractor.formula,
  };
}

function migrateSeriesColor(series: CompatibleSeriesBase): string {
  return series.visible === false ? 'none' : series.color;
}

function migrateChartConfig(chart?: CompatibleChartConfig): ChartConfig | undefined {
  if (!chart) {
    return undefined;
  }

  switch (chart.kind) {
    case 'line':
      return {
        kind: 'line',
        xSource: chart.xSource.kind === 'extractor'
          ? { kind: 'extractor', extractor: migrateNumericExtractor(chart.xSource.extractor) }
          : {
              kind: 'timestamp',
              format: chart.xSource.format,
              timeFormat: chart.xSource.timeFormat,
            },
        series: chart.series.map((series) => ({
          id: series.id,
          name: series.name,
          color: migrateSeriesColor(series),
          extractor: migrateNumericExtractor(series.extractor),
        })),
        yAxis: chart.yAxis,
      };
    case 'bar':
      return {
        kind: 'bar',
        series: chart.series.map((series) => ({
          id: series.id,
          name: series.name,
          color: migrateSeriesColor(series),
          extractor: migrateNumericExtractor(series.extractor),
        })),
        yAxis: chart.yAxis,
      };
    case 'scatter':
      return {
        kind: 'scatter',
        series: chart.series.map((series) => ({
          id: series.id,
          name: series.name,
          color: migrateSeriesColor(series),
          xExtractor: migrateNumericExtractor(series.xExtractor),
          yExtractor: migrateNumericExtractor(series.yExtractor),
        })),
        yAxis: chart.yAxis,
      };
  }
}

function migrateScriptConfig(script?: CompatibleCanvas['config']['script']): ScriptConfig | undefined {
  if (!script) {
    return undefined;
  }

  return {
    sourceType: 'file',
    luaPath: script.luaPath ?? script.yamlPath ?? undefined,
    bundled: script.bundled,
    autoRun: script.autoRun,
    stopOnFailure: script.stopOnFailure,
    defaultTimeoutMs: script.defaultTimeoutMs,
    defaultDataFormat: script.defaultDataFormat,
    logLimit: script.logLimit,
    report: script.report,
    csvLogOutputs: script.csvLogOutputs,
    uiState: normalizeScriptUiState(script.uiState),
  };
}

function normalizeScriptUiState(value: unknown): ScriptConfig['uiState'] {
  if (!isRecord(value) || typeof value.stateVersion !== 'string' || !isRecord(value.values)) {
    return undefined;
  }

  const sourceRevisions = isRecord(value.sourceRevisions)
    ? Object.fromEntries(
        Object.entries(value.sourceRevisions)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : undefined;

  return {
    stateVersion: value.stateVersion,
    values: value.values,
    ...(sourceRevisions && Object.keys(sourceRevisions).length > 0 ? { sourceRevisions } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function migrateLifecycleScriptConfig(lifecycleScript?: CompatibleCanvas['config']['lifecycleScript']): CanvasLifecycleScriptConfig | undefined {
  if (!lifecycleScript) {
    return undefined;
  }

  return {
    sourceType: 'file',
    luaPath: lifecycleScript.luaPath,
    bundled: lifecycleScript.bundled,
    enabled: lifecycleScript.enabled,
    runOnActivate: lifecycleScript.runOnActivate,
    runOnDeactivate: lifecycleScript.runOnDeactivate,
    stopOnFailure: lifecycleScript.stopOnFailure,
    defaultTimeoutMs: lifecycleScript.defaultTimeoutMs,
    defaultDataFormat: lifecycleScript.defaultDataFormat,
    logLimit: lifecycleScript.logLimit,
  };
}

export function migrateCanvas(canvas: CompatibleCanvas): Canvas {
  return {
    ...canvas,
    groupId: typeof canvas.groupId === 'string' ? canvas.groupId : null,
    config: {
      ...canvas.config,
      chart: migrateChartConfig(canvas.config.chart),
      script: migrateScriptConfig(canvas.config.script),
      lifecycleScript: migrateLifecycleScriptConfig(canvas.config.lifecycleScript),
    },
  };
}

export function migrateCanvases(canvases: CompatibleCanvas[]): Canvas[] {
  return canvases.map(migrateCanvas);
}
