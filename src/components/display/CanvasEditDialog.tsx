import { FormulaInput } from './FormulaInput';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useCanvasStore, useChannelStore, useBleStore, useUIStore } from '../../stores';
import type {
  BarChartConfig,
  CanvasChannelLink,
  CanvasLifecycleScriptConfig,
  CanvasType,
  ChartConfig,
  ChartSeriesBase,
  DataSourceMode,
  FormBleTarget,
  FormConfig,
  FormMode,
  FormRowConfig,
  FormSendConfig,
  NumericExtractor,
  NumericFormat,
  ProtocolFieldSummary,
  ProtocolFileSummary,
  ScatterChartConfig,
  ScriptConfig,
  TableColumn,
  TableColumnFormat,
  TimeFormatConfig,
  YAxisConfig,
} from '../../types';
import { parseCanvasLifecycleLuaFile, parseScriptLuaFile } from './scriptLua';
import { retainScriptUiStateForPath } from './scriptUiUtils';
import { ChevronDownIcon, EyeIcon, EyeOffIcon, TrashIcon } from '../common/Icons';
import { getDialogDefaultPath, getParentDirectory } from '../../lib';

const NO_COLOR_VALUE = 'none';

interface CanvasEditDialogProps {
  open: boolean;
  canvasId: string | null;
  onClose: () => void;
}

type ChartKind = ChartConfig['kind'];
type AxisRangeInputs = { min: number; max: number };

type LineOrBarSeriesDraft = ChartSeriesBase & { extractor: NumericExtractor };
type ScatterSeriesDraft = ChartSeriesBase & { xExtractor: NumericExtractor; yExtractor: NumericExtractor };
type ChartSeriesDraft = LineOrBarSeriesDraft | ScatterSeriesDraft;

type XSourceDraft = NumericExtractor;

const TABLE_FORMAT_OPTIONS: TableColumnFormat[] = [
  'UInt8', 'UInt16LE', 'UInt16BE', 'UInt32LE', 'UInt32BE',
  'Int8', 'Int16LE', 'Int16BE', 'Int32LE', 'Int32BE',
  'Float32LE', 'Float32BE', 'Float64LE', 'Float64BE',
  'Hex', 'Ascii',
];

const NUMERIC_FORMAT_OPTIONS: NumericFormat[] = [
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
];

const COLOR_PALETTE = [
  '#a78bfa',
  '#4ade80',
  '#5b9bf5',
  '#f59e0b',
  '#fb7185',
  '#22d3ee',
  '#f97316',
  '#c084fc',
];

const DEFAULT_TIMESTAMP_FORMULA = '@T:HMS.MS';

const CANVAS_TYPE_TABS: Array<{ value: CanvasType; label: string }> = [
  { value: 'table', label: 'Table' },
  { value: 'form', label: 'Form' },
  { value: 'chart', label: 'Chart' },
  { value: 'script', label: 'Script' },
];

const CHART_KIND_TABS: Array<{ value: ChartKind; label: string }> = [
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bar' },
  { value: 'scatter', label: 'Scatter' },
];

const TIMESTAMP_FORMULA_PATTERN = /^@T(?::(?=.+$)(?:H?M?S?(?:\.MS)?|MS))?$/i;

function isTimestampFormula(formula: string): boolean {
  return TIMESTAMP_FORMULA_PATTERN.test(formula.trim());
}

function buildTimestampFormula(timeFormat?: TimeFormatConfig, format?: string): string {
  if (format && format.trim()) {
    return format;
  }

  const resolved = timeFormat ?? {
    hour: true,
    minute: true,
    second: true,
    millisecond: true,
  };

  const body = [
    resolved.hour ? 'H' : '',
    resolved.minute ? 'M' : '',
    resolved.second ? 'S' : '',
  ].join('');

  if (resolved.millisecond) {
    return `@T:${body ? `${body}.MS` : 'MS'}`;
  }

  return body ? `@T:${body}` : DEFAULT_TIMESTAMP_FORMULA;
}

function parseTimestampFormula(formula: string): { format: string; timeFormat: TimeFormatConfig } {
  const trimmed = formula.trim();
  const rawBody = (trimmed.match(/^@T:?(.+)$/i)?.[1] ?? 'HMS.MS').toUpperCase();
  const hasMillisecond = rawBody.includes('MS');
  const bodyWithoutMs = rawBody.replace(/MS/g, '');

  return {
    format: trimmed || DEFAULT_TIMESTAMP_FORMULA,
    timeFormat: {
      hour: bodyWithoutMs.includes('H'),
      minute: bodyWithoutMs.includes('M'),
      second: bodyWithoutMs.includes('S'),
      millisecond: hasMillisecond,
    },
  };
}

function formatChannelType(type: string): string {
  return type
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function clearParsedFieldReferences(columns: TableColumn[]): TableColumn[] {
  return columns.map((column) => {
    const next = { ...column };
    delete next.parsedFieldId;
    return next;
  });
}

function clearFormParsedFieldReferences(rows: FormRowConfig[]): FormRowConfig[] {
  return rows.map((row) => {
    const next = { ...row, column: clearParsedFieldReferences([row.column])[0] };
    delete next.parsedFieldId;
    return next;
  });
}

function generateId(): string {
  return crypto.randomUUID();
}

function getSeriesColor(index: number): string {
  if (index < COLOR_PALETTE.length) {
    return COLOR_PALETTE[index];
  }

  const hue = (index * 47) % 360;
  return hslToHex(hue, 78, 62);
}

function hslToHex(hue: number, saturationPercent: number, lightnessPercent: number): string {
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = hue / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));

  let red = 0;
  let green = 0;
  let blue = 0;

  if (huePrime >= 0 && huePrime < 1) {
    red = chroma;
    green = x;
  } else if (huePrime < 2) {
    red = x;
    green = chroma;
  } else if (huePrime < 3) {
    green = chroma;
    blue = x;
  } else if (huePrime < 4) {
    green = x;
    blue = chroma;
  } else if (huePrime < 5) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  const match = lightness - chroma / 2;
  const toHex = (value: number) => Math.round((value + match) * 255).toString(16).padStart(2, '0');

  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function isSeriesColorNone(color: string): boolean {
  return color === NO_COLOR_VALUE;
}

function getSeriesColorInputValue(color: string, fallback: string): string {
  return isSeriesColorNone(color) ? fallback : color;
}

function createRawExtractor(): NumericExtractor {
  return {
    source: 'raw',
    offset: 0,
    format: 'UInt8',
    formula: '',
  };
}

function createParsedExtractor(): NumericExtractor {
  return {
    source: 'parsed',
    fieldId: '',
    formula: '',
  };
}

function createExtractor(source: DataSourceMode): NumericExtractor {
  return source === 'parsed' ? createParsedExtractor() : createRawExtractor();
}

function syncExtractorSource(extractor: NumericExtractor, source: DataSourceMode): NumericExtractor {
  if (source === extractor.source) {
    return extractor;
  }

  return source === 'parsed'
    ? { source: 'parsed', fieldId: '', formula: extractor.formula }
    : { source: 'raw', offset: 0, format: 'UInt8', formula: extractor.formula };
}

function createLineSeries(index: number, dataSource: DataSourceMode): LineOrBarSeriesDraft {
  return {
    id: generateId(),
    name: `Series ${index + 1}`,
    color: getSeriesColor(index),
    extractor: createExtractor(dataSource),
  };
}

function createScatterSeries(index: number, dataSource: DataSourceMode): ScatterSeriesDraft {
  return {
    id: generateId(),
    name: `Series ${index + 1}`,
    color: getSeriesColor(index),
    xExtractor: createExtractor(dataSource),
    yExtractor: createExtractor(dataSource),
  };
}

function createDefaultChartConfig(): ChartConfig {
  return {
    kind: 'line',
    xSource: { kind: 'timestamp', format: DEFAULT_TIMESTAMP_FORMULA, timeFormat: parseTimestampFormula(DEFAULT_TIMESTAMP_FORMULA).timeFormat },
    series: [],
    yAxis: { mode: 'auto' },
  };
}

function setExtractorFormula(extractor: NumericExtractor, formula: string): NumericExtractor {
  return { ...extractor, formula };
}

function buildChartDraft(config: ChartConfig | undefined, dataSource: DataSourceMode): {
  chartKind: ChartKind;
  xSource: XSourceDraft;
  seriesDraft: ChartSeriesDraft[];
  lineTimeFormat: TimeFormatConfig;
  lineTimeFormula: string;
  yAxis: YAxisConfig;
  yAxisInputs: AxisRangeInputs;
} {
  const chart = config ?? createDefaultChartConfig();
  const resolveYAxisInputs = (axis: YAxisConfig): AxisRangeInputs =>
    axis.mode === 'manual'
      ? { min: axis.min, max: axis.max }
      : { min: 0, max: 0 };

  switch (chart.kind) {
    case 'line':
      const timestampConfig = chart.xSource.kind === 'timestamp'
        ? parseTimestampFormula(chart.xSource.format ?? buildTimestampFormula(chart.xSource.timeFormat))
        : parseTimestampFormula(DEFAULT_TIMESTAMP_FORMULA);
      return {
        chartKind: 'line',
        xSource: chart.xSource.kind === 'timestamp' ? createExtractor(dataSource) : chart.xSource.extractor,
        seriesDraft: chart.series.map((series) => ({ ...series })),
        yAxis: chart.yAxis,
        yAxisInputs: resolveYAxisInputs(chart.yAxis),
        lineTimeFormat: timestampConfig.timeFormat,
        lineTimeFormula: timestampConfig.format,
      };
    case 'bar':
      return {
        chartKind: 'bar',
        xSource: createExtractor(dataSource),
        seriesDraft: chart.series.map((series) => ({ ...series })),
        yAxis: chart.yAxis,
        yAxisInputs: resolveYAxisInputs(chart.yAxis),
        lineTimeFormat: parseTimestampFormula(DEFAULT_TIMESTAMP_FORMULA).timeFormat,
        lineTimeFormula: DEFAULT_TIMESTAMP_FORMULA,
      };
    case 'scatter':
      return {
        chartKind: 'scatter',
        xSource: createExtractor(dataSource),
        seriesDraft: chart.series.map((series) => ({ ...series })),
        yAxis: chart.yAxis,
        yAxisInputs: resolveYAxisInputs(chart.yAxis),
        lineTimeFormat: parseTimestampFormula(DEFAULT_TIMESTAMP_FORMULA).timeFormat,
        lineTimeFormula: DEFAULT_TIMESTAMP_FORMULA,
      };
  }
}

function isScatterSeries(series: ChartSeriesDraft): series is ScatterSeriesDraft {
  return 'xExtractor' in series;
}

function isLineOrBarSeries(series: ChartSeriesDraft): series is LineOrBarSeriesDraft {
  return 'extractor' in series;
}

function buildChartConfig(
  chartKind: ChartKind,
  xSource: XSourceDraft,
  seriesDraft: ChartSeriesDraft[],
  yAxis: YAxisConfig,
  lineTimeFormula: string,
  lineTimeFormat: TimeFormatConfig,
  dataSource: DataSourceMode,
): ChartConfig {
  if (chartKind === 'line') {
    const series = seriesDraft.map((series, index) => {
      if (isLineOrBarSeries(series)) {
        return { ...series, extractor: syncExtractorSource(series.extractor, dataSource) };
      }

      return { ...createLineSeries(index, dataSource), name: series.name, color: series.color };
    });

    return {
      kind: 'line',
      xSource: isTimestampFormula(lineTimeFormula)
        ? {
            kind: 'timestamp',
            format: lineTimeFormula.trim(),
            timeFormat: lineTimeFormat,
          }
        : {
            kind: 'extractor',
            extractor: syncExtractorSource(xSource, dataSource),
          },
      series,
      yAxis,
    };
  }

  if (chartKind === 'bar') {
    return {
      kind: 'bar',
      series: seriesDraft.map((series, index) => {
        if (isLineOrBarSeries(series)) {
          return { ...series, extractor: syncExtractorSource(series.extractor, dataSource) };
        }

        return { ...createLineSeries(index, dataSource), name: series.name, color: series.color };
      }),
      yAxis,
    } satisfies BarChartConfig;
  }

  return {
    kind: 'scatter',
    series: seriesDraft.map((series, index) => {
      if (isScatterSeries(series)) {
        return {
          ...series,
          xExtractor: syncExtractorSource(series.xExtractor, dataSource),
          yExtractor: syncExtractorSource(series.yExtractor, dataSource),
        };
      }

      return { ...createScatterSeries(index, dataSource), name: series.name, color: series.color };
    }),
    yAxis,
  } satisfies ScatterChartConfig;
}

function parseNumber(value: string, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ParsedFieldSelector({
  value,
  onChange,
  fieldOptions,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  fieldOptions: ProtocolFieldSummary[];
  placeholder: string;
}): React.JSX.Element {
  if (fieldOptions.length > 0) {
    const isInOptions = fieldOptions.some((f) => f.id === value);
    return (
      <div className="flex min-w-0 items-center gap-2">
        <select
          className={`select-base min-w-0 py-1 text-sm ${isInOptions ? 'w-full' : 'w-[62%]'}`}
          value={isInOptions ? value : '__custom__'}
          onChange={(event) => {
            if (event.target.value === '__custom__') {
              onChange('');
            } else {
              onChange(event.target.value);
            }
          }}
        >
          <option value="__custom__">Custom</option>
          {fieldOptions.map((field) => (
            <option key={field.id} value={field.id}>
              {field.fieldType ? `${field.name} (${field.fieldType})` : field.name}
            </option>
          ))}
        </select>
        {!isInOptions && (
          <input
            type="text"
            className="input-base min-w-0 flex-1 text-sm"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Id"
          />
        )}
      </div>
    );
  }

  return (
    <input
      type="text"
      className="input-base text-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
    />
  );
}

function SeriesColorControl({
  color,
  fallbackColor,
  onChange,
}: {
  color: string;
  fallbackColor: string;
  onChange: (color: string) => void;
}): React.JSX.Element {
  const currentColor = getSeriesColorInputValue(color, fallbackColor);
  const hidden = isSeriesColorNone(color);

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        className={`h-9 w-10 shrink-0 rounded border bg-surface p-1 ${hidden ? 'border-dashed border-border-active opacity-70' : 'border-border'}`}
        value={currentColor}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Series color"
        title={hidden ? 'Series hidden — pick a color to show it' : 'Series color'}
      />
      {hidden && (
        <span className="rounded border border-dashed border-border-active px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
          Hidden
        </span>
      )}
    </div>
  );
}

const canvasConfigRowClassName = "relative flex min-h-[3.75rem] items-center gap-2 px-4 py-2.5 transition-colors after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-[var(--layer-active)] hover:bg-[var(--layer-hover)] [&_input]:bg-transparent [&_select]:bg-transparent [&_option]:bg-surface [&_input]:rounded-lg [&_select]:rounded-lg [&_input]:border-border-hover [&_select]:border-border-hover";

function ChartTypeTabs({
  chartKind,
  onChange,
  isOpen,
  onToggleOpen,
}: {
  chartKind: ChartKind;
  onChange: (kind: ChartKind) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 border-b border-border">
      <div className="flex items-center gap-6" role="tablist" aria-label="Chart type">
        {CHART_KIND_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={chartKind === item.value}
            className={`-mb-px border-b-2 px-0 pb-2 text-sm font-medium transition-colors focus:outline-none focus-visible:text-text-primary ${chartKind === item.value ? 'border-accent-mauve text-text-primary' : 'border-transparent text-text-muted hover:text-text-secondary'}`}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="ml-auto -mb-px flex h-8 w-8 items-center justify-center rounded-full border border-transparent pb-2 text-text-secondary transition-colors hover:bg-[var(--layer-hover)] hover:text-text-primary"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        aria-controls="chart-settings-panel"
        title="Toggle chart settings"
      >
        <ChevronDownIcon className={`h-4 w-4 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
}

function buildYAxisFromInputs(inputs: AxisRangeInputs): YAxisConfig {
  return inputs.min === 0 && inputs.max === 0
    ? { mode: 'auto' }
    : { mode: 'manual', min: inputs.min, max: inputs.max };
}

function buildLineXAxisEditorValue(extractor: NumericExtractor, formula: string): NumericExtractor {
  return setExtractorFormula(extractor, formula);
}

function ExtractorEditor({
  extractor,
  dataSource,
  onChange,
  label,
  fieldOptions,
}: {
  extractor: NumericExtractor;
  dataSource: DataSourceMode;
  onChange: (extractor: NumericExtractor) => void;
  label: string;
  fieldOptions?: ProtocolFieldSummary[];
}): React.JSX.Element {
  const resolvedExtractor = syncExtractorSource(extractor, dataSource);

  return (
    <div className="space-y-2 rounded border border-border bg-surface p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</div>

      {resolvedExtractor.source === 'raw' ? (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <input
            type="number"
            className="input-base text-sm"
            value={resolvedExtractor.offset}
            onChange={(event) => onChange({ ...resolvedExtractor, offset: parseNumber(event.target.value) })}
            placeholder="Offset"
          />

          <select
            className="select-base text-sm"
            value={resolvedExtractor.format}
            onChange={(event) => onChange({ ...resolvedExtractor, format: event.target.value as NumericFormat })}
          >
            {NUMERIC_FORMAT_OPTIONS.map((format) => (
              <option key={format} value={format}>{format}</option>
            ))}
          </select>

          <FormulaInput
            value={resolvedExtractor.formula}
            onChange={(formula) => onChange({ ...resolvedExtractor, formula })}
            placeholder="Formula, e.g. x * 0.1"
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <ParsedFieldSelector
            value={resolvedExtractor.fieldId}
            onChange={(fieldId) => onChange({ ...resolvedExtractor, fieldId })}
            fieldOptions={fieldOptions ?? []}
            placeholder="Parsed field id"
          />
          <FormulaInput
            value={resolvedExtractor.formula}
            onChange={(formula) => onChange({ ...resolvedExtractor, formula })}
            placeholder="Formula, e.g. x * 0.1"
          />
        </div>
      )}
    </div>
  );
}

export const CanvasEditDialog: React.FC<CanvasEditDialogProps> = ({ open, canvasId, onClose }) => {
  const channels = useChannelStore((state) => state.channels);

  const [name, setName] = useState('');
  const [type, setType] = useState<CanvasType>('table');
  const [dataSource, setDataSource] = useState<DataSourceMode>('raw');
  const [selectedChannels, setSelectedChannels] = useState<CanvasChannelLink[]>([]);
  const [tableColumns, setTableColumns] = useState<TableColumn[]>([]);
  const [isTableSettingsOpen, setIsTableSettingsOpen] = useState(false);
  const [chartKind, setChartKind] = useState<ChartKind>('line');
  const [xSource, setXSource] = useState<XSourceDraft>(createExtractor('raw'));
  const [seriesDraft, setSeriesDraft] = useState<ChartSeriesDraft[]>([]);
  const [yAxis, setYAxis] = useState<YAxisConfig>({ mode: 'auto' });
  const [yAxisInputs, setYAxisInputs] = useState<AxisRangeInputs>({ min: 0, max: 0 });
  const [lineTimeFormat, setLineTimeFormat] = useState<TimeFormatConfig>(parseTimestampFormula(DEFAULT_TIMESTAMP_FORMULA).timeFormat);
  const [lineTimeFormula, setLineTimeFormula] = useState(DEFAULT_TIMESTAMP_FORMULA);
  const [isChartSettingsOpen, setIsChartSettingsOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('send');
  const [formRows, setFormRows] = useState<FormRowConfig[]>([]);
  const [formSendConfig, setFormSendConfig] = useState<FormSendConfig>({});
  const [isFormSendSettingsOpen, setIsFormSendSettingsOpen] = useState(false);
  const [scriptLegacyInlineMessage, setScriptLegacyInlineMessage] = useState('');
  const [scriptLuaPath, setScriptLuaPath] = useState('');
  const [scriptBundled, setScriptBundled] = useState(false);
  const [scriptAutoRun, setScriptAutoRun] = useState(false);
  const [scriptStopOnFailure, setScriptStopOnFailure] = useState(true);
  const [scriptDefaultTimeoutMs, setScriptDefaultTimeoutMs] = useState(2000);
  const [scriptCsvLogOutputs, setScriptCsvLogOutputs] = useState<Record<string, { enabled: boolean; path: string }>>({});
  const [scriptCsvLogLoading, setScriptCsvLogLoading] = useState(false);
  const [lifecycleEnabled, setLifecycleEnabled] = useState(false);
  const [lifecycleLuaPath, setLifecycleLuaPath] = useState('');
  const [lifecycleBundled, setLifecycleBundled] = useState(false);
  const [lifecycleRunOnActivate, setLifecycleRunOnActivate] = useState(true);
  const [lifecycleRunOnDeactivate, setLifecycleRunOnDeactivate] = useState(true);
  const [lifecycleStopOnFailure, setLifecycleStopOnFailure] = useState(true);
  const [lifecycleDefaultTimeoutMs, setLifecycleDefaultTimeoutMs] = useState(2000);
  const [lifecycleFileError, setLifecycleFileError] = useState('');
  const [lifecyclePreview, setLifecyclePreview] = useState<{ name: string; activateCount: number; whileActiveCount: number; deactivateCount: number } | null>(null);
  const [dragColumnId, setDragColumnId] = useState<string | null>(null);
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null);
  const scriptCsvLogLoadedPathRef = useRef<string | null>(null);
  const scriptCsvLogSavedOutputsRef = useRef<ScriptConfig['csvLogOutputs']>({});
  const lifecyclePreviewLoadedPathRef = useRef<string | null>(null);
  const skipNextAutoSaveRef = useRef(false);
  const dragColumnActivationTimerRef = useRef<number | null>(null);
  const backdropMouseDownRef = useRef(false);

  const [protocolFieldSummaries, setProtocolFieldSummaries] = useState<Record<string, ProtocolFileSummary>>({});
  const [protocolLoading, setProtocolLoading] = useState<Record<string, boolean>>({});
  const [protocolErrors, setProtocolErrors] = useState<Record<string, string>>({});
  const [scriptFileError, setScriptFileError] = useState('');
  const protocolDialogDir = useUIStore((state) => state.fileDialogDirs.protocol);
  const scriptDialogDir = useUIStore((state) => state.fileDialogDirs.script);
  const setFileDialogDir = useUIStore((state) => state.setFileDialogDir);

  const loadProtocolFileSummary = useCallback(async (
    channelId: string,
    filePath: string,
    resourceRoot?: string | null,
  ) => {
    setProtocolLoading((prev) => ({ ...prev, [channelId]: true }));
    try {
      const summary = await invoke<ProtocolFileSummary>('get_lua_protocol_file_summary', {
        filePath,
        resourceRoot: resourceRoot || undefined,
      });
      setProtocolFieldSummaries((prev) => ({ ...prev, [channelId]: summary }));
      setProtocolErrors((prev) => {
        const next = { ...prev };
        delete next[channelId];
        return next;
      });
    } catch (e) {
      console.error('Failed to load protocol file summary:', e);
      const message = e instanceof Error ? e.message : String(e);
      setProtocolFieldSummaries((prev) => {
        const next = { ...prev };
        delete next[channelId];
        return next;
      });
      setProtocolErrors((prev) => ({ ...prev, [channelId]: message }));
    } finally {
      setProtocolLoading((prev) => ({ ...prev, [channelId]: false }));
    }
  }, []);

  const handlePickProtocolFile = useCallback(async (channelId: string) => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        defaultPath: getDialogDefaultPath(protocolDialogDir),
        filters: [{ name: 'Lua Protocol Script', extensions: ['lua'] }],
      });
      if (typeof selected === 'string') {
        const filePath = selected;
        const resourceRoot = selectedChannels.find((link) => link.channelId === channelId)?.protocolResourceRoot;
        setFileDialogDir('protocol', getParentDirectory(filePath));
        setSelectedChannels((current) => {
          const existing = current.find((link) => link.channelId === channelId);
          if (type === 'form') {
            return [{ ...(existing ?? { channelId, protocolTemplateId: null }), protocolFile: filePath }];
          }

          return (existing ? current : [...current, { channelId, protocolTemplateId: null }])
            .map((link) =>
              link.channelId === channelId ? { ...link, protocolFile: filePath } : link
            );
        });
        applyDataSource('parsed');
        loadProtocolFileSummary(channelId, filePath, resourceRoot);
      }
    } catch (e) {
      console.error('Failed to pick protocol file:', e);
    }
  }, [loadProtocolFileSummary, protocolDialogDir, selectedChannels, setFileDialogDir, type]);

  const handlePickProtocolResourceRoot = useCallback(async (channelId: string) => {
    try {
      const selected = await openFileDialog({
        directory: true,
        multiple: false,
        defaultPath: getDialogDefaultPath(protocolDialogDir),
      });
      if (typeof selected !== 'string') return;
      setFileDialogDir('protocol', selected);
      const link = selectedChannels.find((item) => item.channelId === channelId);
      setSelectedChannels((current) => current.map((item) =>
        item.channelId === channelId ? { ...item, protocolResourceRoot: selected } : item
      ));
      if (link?.protocolFile) loadProtocolFileSummary(channelId, link.protocolFile, selected);
    } catch (error) {
      console.error('Failed to pick protocol resource root:', error);
    }
  }, [loadProtocolFileSummary, protocolDialogDir, selectedChannels, setFileDialogDir]);

  const clearProtocolFile = useCallback((channelId: string) => {
    setSelectedChannels((current) => {
      const next = current.map((link) =>
        link.channelId === channelId
          ? { ...link, protocolFile: null, protocolResourceRoot: null }
          : link
      );
      applyDataSource(next.some((link) => Boolean(link.protocolFile)) ? 'parsed' : 'raw');
      return next;
    });
    setProtocolFieldSummaries((prev) => {
      const next = { ...prev };
      delete next[channelId];
      return next;
    });
    setProtocolErrors((prev) => {
      const next = { ...prev };
      delete next[channelId];
      return next;
    });
  }, []);

  const mergeCsvLogOutputs = useCallback((targetNames: string[], saved: ScriptConfig['csvLogOutputs'] = {}) => {
    setScriptCsvLogOutputs((current) => {
      const merged: Record<string, { enabled: boolean; path: string }> = {};
      for (const name of targetNames) {
        const existing = current[name];
        const persisted = saved[name];
        merged[name] = {
          enabled: persisted?.enabled ?? existing?.enabled ?? false,
          path: persisted?.path ?? existing?.path ?? '',
        };
      }
      return merged;
    });
  }, []);

  const handlePickScriptLua = useCallback(async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        defaultPath: getDialogDefaultPath(scriptDialogDir),
        filters: [{ name: 'Lua Automation Script', extensions: ['lua'] }],
      });
      if (typeof selected === 'string') {
        setFileDialogDir('script', getParentDirectory(selected));
        scriptCsvLogLoadedPathRef.current = null;
        setScriptFileError('');
        setScriptLegacyInlineMessage('');
        setScriptLuaPath(selected);
      }
    } catch (e) {
      console.error('Failed to pick Lua file:', e);
    }
  }, [scriptDialogDir, setFileDialogDir]);

  const handlePickLifecycleLua = useCallback(async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        defaultPath: getDialogDefaultPath(scriptDialogDir),
        filters: [{ name: 'Lua Canvas Lifecycle Script', extensions: ['lua'] }],
      });
      if (typeof selected === 'string') {
        setFileDialogDir('script', getParentDirectory(selected));
        lifecyclePreviewLoadedPathRef.current = null;
        setLifecycleFileError('');
        setLifecyclePreview(null);
        setLifecycleLuaPath(selected);
        setLifecycleEnabled(true);
      }
    } catch (e) {
      console.error('Failed to pick canvas lifecycle Lua file:', e);
    }
  }, [scriptDialogDir, setFileDialogDir]);

  const loadFileCsvLogTargets = useCallback(async (path: string, saved: ScriptConfig['csvLogOutputs'] = {}) => {
    if (!path) {
      mergeCsvLogOutputs(Object.keys(saved), saved);
      scriptCsvLogLoadedPathRef.current = null;
      setScriptFileError('');
      return;
    }
    if (scriptCsvLogLoadedPathRef.current === path && Object.keys(saved).length === 0) return;
    scriptCsvLogLoadedPathRef.current = path;
    setScriptCsvLogLoading(true);
    try {
      if (scriptCsvLogLoadedPathRef.current !== path) return;
      const targetNames = Object.keys((await parseScriptLuaFile(path)).csvLog ?? {});
      mergeCsvLogOutputs(targetNames.length > 0 ? targetNames : Object.keys(saved), saved);
      setScriptFileError('');
    } catch (error) {
      console.error('Failed to load script CSV log targets:', error);
      if (scriptCsvLogLoadedPathRef.current !== path) return;
      setScriptFileError(error instanceof Error ? error.message : String(error));
      mergeCsvLogOutputs(Object.keys(saved), saved);
    } finally {
      if (scriptCsvLogLoadedPathRef.current === path) setScriptCsvLogLoading(false);
    }
  }, [mergeCsvLogOutputs]);

  const loadLifecyclePreview = useCallback(async (path: string) => {
    if (!path) {
      lifecyclePreviewLoadedPathRef.current = null;
      setLifecycleFileError('');
      setLifecyclePreview(null);
      return;
    }

    if (lifecyclePreviewLoadedPathRef.current === path) return;
    lifecyclePreviewLoadedPathRef.current = path;
    try {
      const document = await parseCanvasLifecycleLuaFile(path);
      if (lifecyclePreviewLoadedPathRef.current !== path) return;
      setLifecyclePreview({
        name: document.name,
        activateCount: document.onActivate?.length ?? 0,
        whileActiveCount: document.whileActive?.steps?.length ?? 0,
        deactivateCount: document.onDeactivate?.length ?? 0,
      });
      setLifecycleFileError('');
    } catch (error) {
      console.error('Failed to load canvas lifecycle script preview:', error);
      if (lifecyclePreviewLoadedPathRef.current !== path) return;
      setLifecyclePreview(null);
      setLifecycleFileError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const getMergedFieldOptions = useCallback((): ProtocolFieldSummary[] => {
    const allFields: ProtocolFieldSummary[] = [];
    for (const link of selectedChannels) {
      const summary = protocolFieldSummaries[link.channelId];
      if (summary) {
        allFields.push(...summary.fields);
      }
    }
    return allFields;
  }, [selectedChannels, protocolFieldSummaries]);

  useEffect(() => {
    if (!open || !canvasId) {
      return;
    }

    const state = useCanvasStore.getState();
    const canvas = state.canvases.find((item) => item.id === canvasId);
    if (!canvas) {
      return;
    }

    skipNextAutoSaveRef.current = true;

    setName(canvas.name || '');
    setType(canvas.config.type || 'table');
    setDataSource(canvas.config.dataSource || 'raw');
    setSelectedChannels(canvas.config.channels || []);
    const loadedColumns = (canvas.config.table?.columns ?? []).map(col => {
      if (col.builtIn === 'timestamp') {
        return { ...col, formula: '@Timestamp', alias: col.alias || 'Timestamp', builtIn: undefined };
      }
      if (col.builtIn === 'channelName') {
        return { ...col, formula: '@ChannelName', alias: col.alias || 'Channel Name', builtIn: undefined };
      }
      return col;
    });
    setTableColumns(loadedColumns);

    const form = canvas.config.form;
    const nextFormMode = form?.mode ?? 'send';
    setFormMode(nextFormMode);
    setFormRows(form?.rows ? form.rows.map((r) => ({ ...r })) : []);
    setFormSendConfig(form?.sendConfig ? { ...form.sendConfig } : {});
    setIsFormSendSettingsOpen(
      nextFormMode === 'send' && Boolean(form?.sendConfig && (form.sendConfig.expectedResponse || form.sendConfig.timeout !== undefined))
    );

    const script = canvas.config.script;
    scriptCsvLogLoadedPathRef.current = null;
    scriptCsvLogSavedOutputsRef.current = script?.csvLogOutputs ?? {};
    setScriptLuaPath(script?.luaPath ?? script?.yamlPath ?? '');
    setScriptBundled(script?.bundled === true);
    setScriptAutoRun(script?.autoRun ?? false);
    setScriptStopOnFailure(script?.stopOnFailure ?? true);
    setScriptDefaultTimeoutMs(script?.defaultTimeoutMs ?? 2000);
    const savedCsvLogOutputs = script?.csvLogOutputs ?? {};
    setScriptLegacyInlineMessage(
      !script?.luaPath && !script?.yamlPath && Boolean(('inlineLua' in (script ?? {})) || ('inlineYaml' in (script ?? {})))
        ? 'Inline Lua is no longer supported. Please select an external Lua script file.'
        : '',
    );
    void loadFileCsvLogTargets(script?.luaPath ?? script?.yamlPath ?? '', savedCsvLogOutputs);

    const lifecycle = canvas.config.lifecycleScript;
    lifecyclePreviewLoadedPathRef.current = null;
    setLifecycleEnabled(lifecycle?.enabled ?? false);
    setLifecycleLuaPath(lifecycle?.luaPath ?? '');
    setLifecycleBundled(lifecycle?.bundled === true);
    setLifecycleRunOnActivate(lifecycle?.runOnActivate ?? true);
    setLifecycleRunOnDeactivate(lifecycle?.runOnDeactivate ?? true);
    setLifecycleStopOnFailure(lifecycle?.stopOnFailure ?? true);
    setLifecycleDefaultTimeoutMs(lifecycle?.defaultTimeoutMs ?? 2000);
    setLifecycleFileError('');
    setLifecyclePreview(null);
    void loadLifecyclePreview(lifecycle?.luaPath ?? '');
    setIsTableSettingsOpen(
      canvas.config.type === 'table'
      && Boolean(lifecycle?.luaPath)
    );

    const chartDraft = buildChartDraft(canvas.config.chart, canvas.config.dataSource || 'raw');
    setChartKind(chartDraft.chartKind);
    setXSource(chartDraft.xSource);
    setSeriesDraft(chartDraft.seriesDraft);
    setYAxis(chartDraft.yAxis);
    setYAxisInputs(chartDraft.yAxisInputs);
    setLineTimeFormat(chartDraft.lineTimeFormat);
    setLineTimeFormula(chartDraft.lineTimeFormula);
    setIsChartSettingsOpen(false);

    setProtocolFieldSummaries({});
    setProtocolErrors({});
    setScriptFileError('');
    if (script?.luaPath || script?.yamlPath) {
      setScriptLegacyInlineMessage('');
    }
    for (const link of canvas.config.channels || []) {
      if (link.protocolFile) {
        loadProtocolFileSummary(link.channelId, link.protocolFile, link.protocolResourceRoot);
      }
    }
  }, [loadFileCsvLogTargets, open, canvasId, loadProtocolFileSummary, loadLifecyclePreview]);

  useEffect(() => {
    if (!open || type !== 'script') return;
    void loadFileCsvLogTargets(scriptLuaPath, scriptCsvLogSavedOutputsRef.current);
  }, [loadFileCsvLogTargets, open, scriptLuaPath, type]);

  useEffect(() => {
    if (!open || (type !== 'table' && type !== 'chart' && type !== 'form')) return;
    void loadLifecyclePreview(lifecycleLuaPath);
  }, [lifecycleLuaPath, loadLifecyclePreview, open, type]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const persistCanvasConfig = useCallback(() => {
    if (!canvasId) return;

    const store = useCanvasStore.getState();
    const existingScript = store.canvases.find((canvas) => canvas.id === canvasId)?.config.script;
    const chart = buildChartConfig(chartKind, xSource, seriesDraft, yAxis, lineTimeFormula, lineTimeFormat, dataSource);

    store.setCanvasName(canvasId, name);
    const formConfig: FormConfig | undefined =
      type === 'form'
        ? {
            kind: 'form',
            mode: formMode,
            rows: formRows,
            sendConfig: formMode === 'send' ? formSendConfig : undefined,
          }
        : undefined;
    const scriptConfig: ScriptConfig | undefined =
      type === 'script'
        ? {
            sourceType: 'file',
            luaPath: scriptLuaPath || undefined,
            bundled: scriptBundled || undefined,
            autoRun: scriptAutoRun,
            stopOnFailure: scriptStopOnFailure,
            defaultTimeoutMs: Math.max(1, scriptDefaultTimeoutMs),
            defaultDataFormat: 'hex',
            logLimit: 500,
            csvLogOutputs: Object.keys(scriptCsvLogOutputs).length > 0
              ? Object.fromEntries(Object.entries(scriptCsvLogOutputs).map(([target, output]) => [
                  target,
                  { enabled: output.enabled, path: output.path || undefined },
                ]))
              : undefined,
            uiState: retainScriptUiStateForPath(existingScript, scriptLuaPath),
          }
        : undefined;
    const lifecycleConfig: CanvasLifecycleScriptConfig | undefined =
      type === 'table' || type === 'chart' || type === 'form'
        ? {
            sourceType: 'file',
            luaPath: lifecycleLuaPath || undefined,
            bundled: lifecycleBundled || undefined,
            enabled: lifecycleEnabled && Boolean(lifecycleLuaPath),
            runOnActivate: lifecycleRunOnActivate,
            runOnDeactivate: lifecycleRunOnDeactivate,
            stopOnFailure: lifecycleStopOnFailure,
            defaultTimeoutMs: Math.max(1, lifecycleDefaultTimeoutMs),
            defaultDataFormat: 'hex',
            logLimit: 200,
          }
        : undefined;
    store.updateCanvasConfig(canvasId, {
      type,
      dataSource,
      channels: selectedChannels,
      table: { columns: tableColumns },
      chart,
      form: formConfig,
      script: scriptConfig,
      lifecycleScript: lifecycleConfig,
    });
  }, [
    canvasId,
    chartKind,
    dataSource,
    formMode,
    formRows,
    formSendConfig,
    lifecycleDefaultTimeoutMs,
    lifecycleBundled,
    lifecycleEnabled,
    lifecycleLuaPath,
    lifecycleRunOnActivate,
    lifecycleRunOnDeactivate,
    lifecycleStopOnFailure,
    lineTimeFormat,
    lineTimeFormula,
    name,
    scriptAutoRun,
    scriptBundled,
    scriptCsvLogOutputs,
    scriptDefaultTimeoutMs,
    scriptLuaPath,
    scriptStopOnFailure,
    selectedChannels,
    seriesDraft,
    tableColumns,
    type,
    xSource,
    yAxis,
  ]);

  useEffect(() => {
    if (!open || !canvasId) return;
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      return;
    }
    persistCanvasConfig();
  }, [canvasId, open, persistCanvasConfig]);

  useEffect(() => () => clearColumnDragActivation(), []);

  if (!open) return null;

  const setChannelBleTarget = (channelId: string, bleTarget: FormBleTarget | undefined) => {
    setSelectedChannels((current) =>
      current.map((link) =>
        link.channelId === channelId ? { ...link, bleTarget } : link
      )
    );
  };

  function clearColumnDragActivation() {
    if (dragColumnActivationTimerRef.current !== null) {
      window.clearTimeout(dragColumnActivationTimerRef.current);
      dragColumnActivationTimerRef.current = null;
    }
  }

  const isInteractiveDragTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement && Boolean(target.closest('input, select, textarea, button'));

  const handleColumnPointerDown = (event: React.PointerEvent<HTMLDivElement>, columnId: string) => {
    if (event.button !== 0 || isInteractiveDragTarget(event.target)) return;
    clearColumnDragActivation();
    dragColumnActivationTimerRef.current = window.setTimeout(() => {
      setDragColumnId(columnId);
      dragColumnActivationTimerRef.current = null;
    }, 180);
  };

  const handleColumnDragStart = (event: React.DragEvent<HTMLDivElement>, columnId: string) => {
    if (dragColumnId !== columnId) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', columnId);
  };

  const handleColumnDrop = (event: React.DragEvent<HTMLDivElement>, targetColumnId: string) => {
    event.preventDefault();
    const sourceColumnId = event.dataTransfer.getData('text/plain') || dragColumnId;
    setDragOverColumnId(null);
    setDragColumnId(null);
    if (!sourceColumnId || sourceColumnId === targetColumnId) return;

    setTableColumns((current) => {
      const sourceIndex = current.findIndex((column) => column.id === sourceColumnId);
      const targetIndex = current.findIndex((column) => column.id === targetColumnId);
      if (sourceIndex < 0 || targetIndex < 0) return current;

      const next = [...current];
      const [sourceColumn] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, sourceColumn);
      return next;
    });
  };

  const updateColumn = (index: number, updates: Partial<TableColumn>) => {
    const nextColumns = [...tableColumns];
    nextColumns[index] = { ...nextColumns[index], ...updates };
    setTableColumns(nextColumns);
  };

  const addColumn = () => {
    setTableColumns([
      ...tableColumns,
      { id: generateId(), alias: 'New Col', offset: 0, format: 'UInt8', formula: '' },
    ]);
  };

  const addFormRow = () => {
    setFormRows((current) => [
      ...current,
      {
        id: generateId(),
        label: `Field ${current.length + 1}`,
        column: {
          id: generateId(),
          alias: `Field ${current.length + 1}`,
          offset: 0,
          format: 'UInt8',
          formula: '',
        },
        editable: true,
        visible: true,
      },
    ]);
  };

  const removeColumn = (index: number) => {
    const nextColumns = [...tableColumns];
    nextColumns.splice(index, 1);
    setTableColumns(nextColumns);
  };

  const normalizeSeriesForKind = (nextKind: ChartKind) => {
    if (nextKind === 'scatter') {
      setSeriesDraft((current) => current.map((series) => isScatterSeries(series)
        ? series
        : {
            id: series.id,
            name: series.name,
            color: series.color,
            xExtractor: createExtractor(dataSource),
            yExtractor: isLineOrBarSeries(series) ? series.extractor : createExtractor(dataSource),
          }));
      return;
    }

    setSeriesDraft((current) => current.map((series, index) => isLineOrBarSeries(series)
      ? series
      : {
          id: series.id,
          name: series.name,
          color: series.color,
          extractor: index === 0 ? series.yExtractor : createExtractor(dataSource),
        }));
  };

  const handleChartKindChange = (nextKind: ChartKind) => {
    setChartKind(nextKind);
    normalizeSeriesForKind(nextKind);

    if (nextKind !== 'line') {
      setLineTimeFormula(DEFAULT_TIMESTAMP_FORMULA);
      setLineTimeFormat(parseTimestampFormula(DEFAULT_TIMESTAMP_FORMULA).timeFormat);
    }
  };

  const addSeries = () => {
    setSeriesDraft((current) => [
      ...current,
      chartKind === 'scatter'
        ? createScatterSeries(current.length, dataSource)
        : createLineSeries(current.length, dataSource),
    ]);
  };

  const removeSeries = (index: number) => {
    setSeriesDraft((current) => current.filter((_, seriesIndex) => seriesIndex !== index));
  };

  const updateSeriesBase = (index: number, updates: Partial<ChartSeriesBase>) => {
    setSeriesDraft((current) => current.map((series, seriesIndex) => seriesIndex === index ? { ...series, ...updates } : series));
  };

  const updateLineOrBarSeriesExtractor = (index: number, extractor: NumericExtractor) => {
    setSeriesDraft((current) => current.map((series, seriesIndex) => {
      if (seriesIndex !== index || !isLineOrBarSeries(series)) {
        return series;
      }
      return { ...series, extractor };
    }));
  };

  const updateScatterSeriesExtractor = (index: number, axis: 'x' | 'y', extractor: NumericExtractor) => {
    setSeriesDraft((current) => current.map((series, seriesIndex) => {
      if (seriesIndex !== index || !isScatterSeries(series)) {
        return series;
      }

      return axis === 'x'
        ? { ...series, xExtractor: extractor }
        : { ...series, yExtractor: extractor };
    }));
  };

  function applyDataSource(nextSource: DataSourceMode) {
    setDataSource(nextSource);
    if (nextSource === 'raw') {
      setTableColumns((current) => clearParsedFieldReferences(current));
      setFormRows((current) => clearFormParsedFieldReferences(current));
    }
    setXSource((current) => syncExtractorSource(current, nextSource));
    setSeriesDraft((current) => current.map((series) => isScatterSeries(series)
      ? {
          ...series,
          xExtractor: syncExtractorSource(series.xExtractor, nextSource),
          yExtractor: syncExtractorSource(series.yExtractor, nextSource),
        }
      : { ...series, extractor: syncExtractorSource(series.extractor, nextSource) }));
  }

  function updateDataSourceFromChannels(links: CanvasChannelLink[]) {
    applyDataSource(links.some((link) => Boolean(link.protocolFile)) ? 'parsed' : 'raw');
  }

  function selectSingleChannel(channelId: string) {
    setSelectedChannels((current) => {
      const existing = current.find((link) => link.channelId === channelId);
      const next = [existing ?? { channelId, protocolTemplateId: null }];
      updateDataSourceFromChannels(next);
      return next;
    });
  }

  function handleChannelToggle(channelId: string) {
    setSelectedChannels((current) => {
      const isSelected = current.some((channel) => channel.channelId === channelId);
      const next = isSelected
        ? current.filter((channel) => channel.channelId !== channelId)
        : [...current, { channelId, protocolTemplateId: null }];
      updateDataSourceFromChannels(next);
      return next;
    });
  }

  function handleBackdropMouseDown(event: React.MouseEvent<HTMLDivElement>): void {
    event.stopPropagation();
    backdropMouseDownRef.current = (event.button === 0 || event.button === 2) && event.target === event.currentTarget;
  }

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (backdropMouseDownRef.current && event.target === event.currentTarget) {
      onClose();
    }
    backdropMouseDownRef.current = false;
  }

  function handleBackdropContextMenu(event: React.MouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    if (backdropMouseDownRef.current && event.target === event.currentTarget) {
      onClose();
    }
    backdropMouseDownRef.current = false;
  }

  const renderedSeries = seriesDraft;
  const mergedFieldOptions = getMergedFieldOptions();
  const renderLifecycleScriptSettings = () => (
    <div className="space-y-3 rounded-2xl border border-border bg-surface/95 px-4 py-3">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-secondary">Canvas Lifecycle</div>
          {lifecyclePreview && (
            <div className="mt-1 truncate text-[11px] text-text-muted">
              {lifecyclePreview.name} · Activate {lifecyclePreview.activateCount} · Loop {lifecyclePreview.whileActiveCount} · Deactivate {lifecyclePreview.deactivateCount}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={lifecycleEnabled}
            onChange={(event) => setLifecycleEnabled(event.target.checked)}
          />
          Enabled
        </label>
      </div>

      {lifecycleBundled ? (
        <div className="rounded border border-accent-green/30 bg-accent-green/10 px-3 py-2 text-xs text-text-secondary">
          Bundled Lua lifecycle script. Its source is managed by this snapshot and cannot be changed.
        </div>
      ) : (
        <label className="space-y-1">
          <span className="block text-xs text-text-muted">Lua File Path</span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="input-base min-w-0 flex-1 text-sm"
              value={lifecycleLuaPath}
              onChange={(event) => {
                lifecyclePreviewLoadedPathRef.current = null;
                setLifecycleFileError('');
                setLifecyclePreview(null);
                setLifecycleLuaPath(event.target.value);
              }}
              placeholder="E:/test/canvas-lifecycle-init-end.lua"
            />
            <button
              type="button"
              className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-primary hover:bg-surface-overlay"
              onClick={() => { void handlePickLifecycleLua(); }}
            >
              Browse
            </button>
          </div>
        </label>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-xs text-text-muted">Default Timeout (ms)</span>
          <input
            type="number"
            min={1}
            className="input-base w-full text-sm"
            value={lifecycleDefaultTimeoutMs}
            onChange={(event) => setLifecycleDefaultTimeoutMs(Math.max(1, parseNumber(event.target.value, 2000)))}
          />
        </label>
        <div className="flex flex-wrap items-end gap-4 pb-1">
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={lifecycleRunOnActivate}
              onChange={(event) => setLifecycleRunOnActivate(event.target.checked)}
            />
            On activate
          </label>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={lifecycleRunOnDeactivate}
              onChange={(event) => setLifecycleRunOnDeactivate(event.target.checked)}
            />
            On deactivate
          </label>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={lifecycleStopOnFailure}
          onChange={(event) => setLifecycleStopOnFailure(event.target.checked)}
        />
        Stop on failure by default
      </label>

      {lifecycleFileError && (
        <div className="text-xs text-red-400">{lifecycleFileError}</div>
      )}
    </div>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/40 dark:bg-black/60 px-4 backdrop-blur-sm"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      onContextMenu={handleBackdropContextMenu}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[52rem] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.4)]"
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseUp={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 pt-6 pb-6">
          <section className="px-1">
            <label className="block text-sm font-medium text-text-primary">
              <span className="sr-only">Name</span>
            <input
              type="text"
                className="min-w-0 flex-1 border-0 border-b border-border-active bg-transparent px-0 py-1 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-mauve"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Canvas Name 1"
            />
            </label>
          </section>

          <section className="px-1">
            {channels.length === 0 ? (
              <div className="rounded-xl border border-border px-5 py-4 text-sm text-text-muted">No channels available</div>
            ) : (
              <div className="max-h-[280px] overflow-y-auto rounded-xl border border-border">
                {channels.map((channel) => {
                  const isSelected = selectedChannels.some((item) => item.channelId === channel.id);
                  const link = selectedChannels.find((item) => item.channelId === channel.id);
                  const bleTarget = link?.bleTarget;
                  const hasProtocol = Boolean(link?.protocolFile);
                  const protocolBundled = link?.protocolBundled === true;
                  const isBle = channel.type === 'ble';
                  const bleState = useBleStore.getState();
                  const isBleConnected = isBle && bleState.connectedChannelId === channel.id;
                  const gattServices = bleState.gattServices;

                  const allowNotify = type !== 'form' || formMode === 'display';
                  const allowWrite = type === 'form' && formMode === 'send';

                  const filterCharProps = (props: string[]) => {
                    if (allowNotify && allowWrite) {
                      return props.includes('notify') || props.includes('indicate') || props.includes('write') || props.includes('write_without_response');
                    }
                    if (allowNotify) {
                      return props.includes('notify') || props.includes('indicate');
                    }
                    return props.includes('write') || props.includes('write_without_response');
                  };

                  return (
                    <div key={channel.id} className="relative transition-colors after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-[var(--layer-active)] last:after:hidden hover:bg-[var(--layer-hover)]">
                      <div className="flex items-center gap-3 px-4 py-3">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                          <input
                            type={type === 'form' ? 'radio' : 'checkbox'}
                            name={type === 'form' ? 'form-channel' : undefined}
                            className="channel-selector border-border-active bg-surface text-accent-mauve focus:ring-accent-mauve"
                            checked={isSelected}
                            onChange={() => {
                              if (type === 'form') {
                                selectSingleChannel(channel.id);
                              } else {
                                handleChannelToggle(channel.id);
                              }
                            }}
                          />
                          <span className="min-w-0 truncate text-sm font-medium text-text-primary">{channel.name}</span>
                          <span className="rounded bg-[var(--layer-hover)] px-1.5 py-0.5 text-[10px] font-mono text-text-secondary">{formatChannelType(channel.type)}</span>
                        </label>

                        <button
                          className={`shrink-0 rounded px-2.5 py-1 text-[10px] font-medium transition-colors ${hasProtocol ? 'bg-accent-green/20 text-accent-green hover:bg-accent-green/30' : 'bg-[var(--layer-hover)] text-text-secondary hover:bg-[var(--layer-active)]'}`}
                          onClick={() => { if (!protocolBundled) void handlePickProtocolFile(channel.id); }}
                          disabled={protocolBundled}
                          title={protocolBundled ? 'Bundled protocol parser cannot be changed' : hasProtocol ? 'Change protocol parser' : 'Select protocol parser'}
                        >
                          {protocolBundled ? 'Bundled' : hasProtocol ? 'Parsed' : 'Parse'}
                        </button>

                        {hasProtocol && !protocolBundled && (
                          <button
                            className="shrink-0 rounded bg-[var(--layer-hover)] px-2.5 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                            onClick={() => clearProtocolFile(channel.id)}
                            title="Remove protocol parser"
                          >
                            Clear
                          </button>
                        )}
                      </div>

                      {isSelected && isBle && (
                        <div className="mx-4 border-t border-border px-3 py-2 text-xs font-mono">
                          {!isBleConnected && (
                            <span className="text-[10px] text-text-muted">Connect to a BLE device to select service and characteristic.</span>
                          )}
                          {isBleConnected && gattServices.length === 0 && (
                            <span className="text-[10px] text-text-muted">No GATT services discovered.</span>
                          )}
                          {isBleConnected && gattServices.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2">
                              <select
                                className="select-base py-1 text-xs"
                                value={bleTarget?.serviceUuid ?? ''}
                                onChange={(e) => {
                                  const serviceUuid = e.target.value;
                                  setChannelBleTarget(channel.id, serviceUuid ? { serviceUuid, charUuid: '' } : undefined);
                                }}
                              >
                                <option value="">Service</option>
                                {gattServices.map((svc) => (
                                  <option key={svc.uuid} value={svc.uuid}>{svc.uuid}</option>
                                ))}
                              </select>
                              {bleTarget?.serviceUuid && (
                                <select
                                  className="select-base py-1 text-xs"
                                  value={bleTarget.charUuid}
                                  onChange={(e) => {
                                    const charUuid = e.target.value;
                                    setChannelBleTarget(channel.id, charUuid ? { serviceUuid: bleTarget.serviceUuid, charUuid } : undefined);
                                  }}
                                >
                                  <option value="">Characteristic</option>
                                  {gattServices
                                    .find((s) => s.uuid === bleTarget.serviceUuid)
                                    ?.characteristics.filter((c) => filterCharProps(c.properties))
                                    .map((char) => (
                                      <option key={char.uuid} value={char.uuid}>{char.uuid}</option>
                                    ))}
                                  </select>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {hasProtocol && (
                        <div className="mx-4 space-y-2 border-t border-border px-3 py-2">
                          <div className="flex min-w-0 items-center gap-2 text-xs">
                            <span className="shrink-0 text-text-secondary">Protocol</span>
                            <span className="min-w-0 max-w-[520px] truncate text-text-primary">
                              {protocolBundled ? 'Bundled Lua script' : link?.protocolFile}
                            </span>
                          </div>
                          {!protocolBundled && (
                            <div className="flex min-w-0 items-center gap-2 text-xs">
                              <span className="shrink-0 text-text-secondary">Resources</span>
                              <span className="min-w-0 flex-1 truncate font-mono text-text-primary">
                                {link?.protocolResourceRoot || 'Protocol file directory'}
                              </span>
                              <button
                                className="shrink-0 rounded bg-[var(--layer-hover)] px-2.5 py-1 text-[10px] font-medium text-text-secondary transition-colors hover:bg-[var(--layer-active)]"
                                onClick={() => { void handlePickProtocolResourceRoot(channel.id); }}
                                title="Select the sandboxed data directory used by the protocol adapter"
                              >
                                Select root
                              </button>
                            </div>
                          )}
                          {protocolLoading[channel.id] && (
                            <span className="text-[10px] text-text-muted">Loading protocol fields...</span>
                          )}
                          {!protocolLoading[channel.id] && protocolFieldSummaries[channel.id] && (
                            <div className="rounded-lg border border-border bg-[var(--layer-hover)] px-2.5 py-2 text-xs text-text-secondary">
                              {protocolFieldSummaries[channel.id].name} — {protocolFieldSummaries[channel.id].fields.length} fields available
                            </div>
                          )}
                          {!protocolLoading[channel.id] && link?.protocolFile && protocolErrors[channel.id] && (
                            <span className="text-[10px] text-red-400">{protocolErrors[channel.id]}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="px-1">
            <div className="space-y-3">
               <div className="flex items-center gap-7 border-b border-border-hover">
                 {CANVAS_TYPE_TABS.map((item) => (
                  <button
                    key={item.value}
                    className={`-mb-px border-b-2 px-0 pb-2 text-sm font-medium transition-colors ${type === item.value ? 'border-accent-mauve text-text-primary' : 'border-transparent text-text-muted hover:text-text-secondary'}`}
                    onClick={() => {
                      setType(item.value);
                      if (item.value === 'form' && selectedChannels.length > 1) {
                        const next = [selectedChannels[0]];
                        setSelectedChannels(next);
                        updateDataSourceFromChannels(next);
                      }
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

            <div className="relative flex h-[min(420px,60vh)] min-h-[300px] flex-col overflow-hidden rounded-xl border border-border">

          {type === 'table' && (
            <>
              <div className="h-full overflow-y-auto pb-14">
                <div>
                  <div className="px-4 pt-3 pb-2">
                    <div className="flex items-center gap-4 border-b border-border">
                      <div className="flex items-center gap-6">
                        <span className="-mb-px border-b-2 border-accent-mauve px-0 pb-2 text-sm font-medium text-text-primary">
                          Table
                        </span>
                      </div>

                      <button
                        type="button"
                        className="ml-auto -mb-px flex h-8 w-8 items-center justify-center rounded-full border border-transparent pb-2 text-text-secondary transition-colors hover:bg-[var(--layer-hover)] hover:text-text-primary"
                        onClick={() => setIsTableSettingsOpen((current) => !current)}
                        aria-expanded={isTableSettingsOpen}
                        aria-controls="table-settings-panel"
                        title="Toggle table settings"
                      >
                        <ChevronDownIcon
                          className={`h-4 w-4 transition-transform duration-200 ${isTableSettingsOpen ? 'rotate-180' : ''}`}
                        />
                      </button>
                    </div>

                    <div
                      id="table-settings-panel"
                      aria-hidden={!isTableSettingsOpen}
                      className={`grid transition-all duration-200 ease-out ${isTableSettingsOpen ? 'grid-rows-[1fr] pt-3 opacity-100' : 'grid-rows-[0fr] pt-0 opacity-0 invisible pointer-events-none'}`}
                    >
                      <div className="overflow-hidden">
                        <div className="space-y-3">
                          {renderLifecycleScriptSettings()}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-1 overflow-hidden rounded-xl">
                    {tableColumns.map((column, index) => (
                      <div
                        key={column.id}
                        className={`relative flex items-center gap-2 px-4 py-3 transition-colors after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-[var(--layer-active)] ${dragOverColumnId === column.id ? 'bg-[var(--layer-hover)]' : 'hover:bg-[var(--layer-hover)]'} ${dragColumnId === column.id ? 'cursor-grabbing opacity-70' : 'cursor-grab'} [&_input]:bg-transparent [&_select]:bg-transparent [&_option]:bg-surface [&_input]:rounded-lg [&_select]:rounded-lg [&_input]:border-border-hover [&_select]:border-border-hover`}
                        draggable={dragColumnId === column.id}
                        onPointerDown={(event) => handleColumnPointerDown(event, column.id)}
                        onPointerUp={clearColumnDragActivation}
                        onPointerCancel={clearColumnDragActivation}
                        onPointerLeave={clearColumnDragActivation}
                        onDragStart={(event) => handleColumnDragStart(event, column.id)}
                        onDragOver={(event) => {
                          if (!dragColumnId || dragColumnId === column.id) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          setDragOverColumnId(column.id);
                        }}
                        onDragLeave={() => setDragOverColumnId((current) => current === column.id ? null : current)}
                        onDrop={(event) => handleColumnDrop(event, column.id)}
                        onDragEnd={() => {
                          clearColumnDragActivation();
                          setDragColumnId(null);
                          setDragOverColumnId(null);
                        }}
                        title="Hold and drag to reorder"
                      >
                        {dataSource === 'parsed' ? (
                          <div className="flex flex-1 items-center space-x-2">
                            <input
                              type="text"
                              className="input-base w-1/4 text-sm"
                              placeholder="Alias"
                              value={column.alias}
                              onChange={(event) => updateColumn(index, { alias: event.target.value })}
                            />
                            <ParsedFieldSelector
                              value={column.parsedFieldId ?? ''}
                              onChange={(parsedFieldId) => updateColumn(index, { parsedFieldId })}
                              fieldOptions={mergedFieldOptions}
                              placeholder="Parsed field"
                            />
                            <FormulaInput
                              value={column.formula}
                              onChange={(formula) => updateColumn(index, { formula })}
                              placeholder="Formula, e.g. x * 0.1, @Timestamp, @ChannelName"
                              containerClassName="flex-1"
                            />
                          </div>
                        ) : (
                          <div className="flex flex-1 items-center space-x-2">
                            <input
                              type="text"
                              className="input-base w-1/4 text-sm"
                              placeholder="Alias"
                              value={column.alias}
                              onChange={(event) => updateColumn(index, { alias: event.target.value })}
                            />
                            <input
                              type="number"
                              className="input-base w-20 text-sm"
                              placeholder="Offset"
                              value={column.offset}
                              onChange={(event) => updateColumn(index, { offset: parseNumber(event.target.value) })}
                            />
                            <select
                              className="select-base w-32 text-sm"
                              value={column.format}
                              onChange={(event) => updateColumn(index, { format: event.target.value as TableColumnFormat })}
                            >
                              {TABLE_FORMAT_OPTIONS.map((option) => (
                                <option key={option} value={option}>{option}</option>
                              ))}
                            </select>
                            <FormulaInput
                              value={column.formula}
                              onChange={(formula) => updateColumn(index, { formula })}
                              placeholder="e.g. x * 0.1 + 25, @Timestamp, @ChannelName"
                              containerClassName="flex-1"
                            />
                          </div>
                        )}

                        <button
                          className="ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-1 focus:ring-red-400/60"
                          onClick={() => removeColumn(index)}
                          title="Remove Column"
                          aria-label="Remove Column"
                        >
                          <TrashIcon size={16} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <button
                className="absolute bottom-4 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-accent-mauve text-text-primary hover:bg-accent-mauve/80 active:scale-95 transition-all shadow-lg text-2xl font-bold"
                onClick={addColumn}
                title="Add Column"
              >
                +
              </button>
            </>
          )}

          {type === 'script' && (
            <div className="h-full overflow-y-auto p-4 pr-5">
            <div className="space-y-4 rounded border border-border p-3">
              <div>
                <h3 className="text-sm font-medium text-text-primary">Script Automation</h3>
                <p className="mt-1 text-xs text-text-muted">
                  Lua drives automated Serial / TCP Client / UDP tests. File-based scripts must declare <span className="font-mono">-- linkassist:type = script</span>. CSV files are loaded dynamically from paths declared in the script.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {scriptBundled ? (
                  <div className="rounded border border-accent-green/30 bg-accent-green/10 px-3 py-2 text-xs text-text-secondary">
                    Bundled Lua automation script. Its source is managed by this snapshot and cannot be changed.
                  </div>
                ) : (
                  <label className="space-y-1">
                    <span className="block text-xs font-medium text-text-secondary">Lua File Path</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        className="input-base flex-1 text-sm"
                        value={scriptLuaPath}
                        onChange={(event) => {
                          scriptCsvLogLoadedPathRef.current = null;
                          setScriptFileError('');
                          setScriptLegacyInlineMessage('');
                          setScriptLuaPath(event.target.value);
                        }}
                        placeholder="E:/test/script.lua"
                      />
                      <button className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-primary hover:bg-surface-overlay" onClick={() => { void handlePickScriptLua(); }}>
                        Browse
                      </button>
                    </div>
                  </label>
                )}

                <label className="space-y-1">
                  <span className="block text-xs font-medium text-text-secondary">Default Timeout (ms)</span>
                  <input
                    type="number"
                    min={1}
                    className="input-base w-full text-sm"
                    value={scriptDefaultTimeoutMs}
                    onChange={(event) => setScriptDefaultTimeoutMs(Math.max(1, parseNumber(event.target.value, 2000)))}
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={scriptStopOnFailure}
                    onChange={(event) => setScriptStopOnFailure(event.target.checked)}
                  />
                  Stop on failure by default
                </label>
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={scriptAutoRun}
                    onChange={(event) => setScriptAutoRun(event.target.checked)}
                  />
                  Auto-run when mounted
                </label>
              </div>

              {(scriptFileError || scriptLegacyInlineMessage) && (
                <div className="space-y-1">
                  {scriptLegacyInlineMessage && (
                    <div className="text-xs text-yellow-400">{scriptLegacyInlineMessage}</div>
                  )}
                  {scriptFileError && (
                    <div className="text-xs text-red-400">{scriptFileError}</div>
                  )}
                </div>
              )}

              <div className="space-y-3 rounded border border-border p-3">
                <div>
                  <div className="text-sm font-medium text-text-secondary">Business CSV Logs</div>
                  <div className="mt-1 text-xs text-text-muted">Lua defines csvLog columns; this canvas controls whether each log is saved and where.</div>
                </div>
                {scriptCsvLogLoading ? (
                  <div className="text-xs text-text-muted">Loading csvLog targets...</div>
                ) : Object.keys(scriptCsvLogOutputs).length === 0 ? (
                  <div className="text-xs text-text-muted">No csvLog targets detected in the current Lua script.</div>
                ) : Object.entries(scriptCsvLogOutputs).map(([target, output]) => (
                  <div key={target} className="space-y-2 rounded border border-border/70 p-2">
                    <label className="flex items-center gap-2 text-sm text-text-secondary">
                      <input
                        type="checkbox"
                        checked={output.enabled}
                        onChange={(event) => setScriptCsvLogOutputs((current) => ({
                          ...current,
                          [target]: { ...current[target], enabled: event.target.checked },
                        }))}
                      />
                      Save {target}
                    </label>
                    <input
                      type="text"
                      className="input-base w-full text-sm"
                      value={output.path}
                      onChange={(event) => setScriptCsvLogOutputs((current) => ({
                        ...current,
                        [target]: { ...current[target], path: event.target.value },
                      }))}
                      disabled={!output.enabled}
                      placeholder={`${target}.csv (current program folder)`}
                    />
                  </div>
                ))}
              </div>
            </div>
            </div>
          )}

          {type === 'chart' && (
            <>
              <div className="h-full overflow-y-auto pb-14">
                <div>
                  <div className="px-4 pt-3 pb-2">
                    <ChartTypeTabs
                      chartKind={chartKind}
                      onChange={handleChartKindChange}
                      isOpen={isChartSettingsOpen}
                      onToggleOpen={() => setIsChartSettingsOpen((current) => !current)}
                    />

                    <div
                      id="chart-settings-panel"
                      aria-hidden={!isChartSettingsOpen}
                      className={`grid transition-all duration-200 ease-out ${isChartSettingsOpen ? 'grid-rows-[1fr] pt-3 opacity-100' : 'grid-rows-[0fr] pt-0 opacity-0 invisible pointer-events-none'}`}
                    >
                      <div className="overflow-hidden">
                        <div className="space-y-4 rounded-2xl border border-border bg-surface/95 px-4 py-3">
                          {chartKind === 'line' && (
                            <div className="space-y-3">
                              <ExtractorEditor
                                label="X-Axis Source"
                                extractor={buildLineXAxisEditorValue(xSource, lineTimeFormula)}
                                dataSource={dataSource}
                                onChange={(extractor) => {
                                  setXSource(extractor);
                                  setLineTimeFormula(extractor.formula);
                                  if (isTimestampFormula(extractor.formula)) {
                                    setLineTimeFormat(parseTimestampFormula(extractor.formula || DEFAULT_TIMESTAMP_FORMULA).timeFormat);
                                  }
                                }}
                                fieldOptions={dataSource === 'parsed' ? mergedFieldOptions : undefined}
                              />
                            </div>
                          )}

                          {(chartKind === 'line' || chartKind === 'bar' || chartKind === 'scatter') && (
                            <div className="space-y-2">
                              <label className="block text-xs text-text-muted">Y-Axis</label>
                              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                <input
                                  type="number"
                                  className="input-base text-sm"
                                  value={yAxisInputs.min}
                                  onChange={(event) => {
                                    const next = { ...yAxisInputs, min: parseNumber(event.target.value) };
                                    setYAxisInputs(next);
                                    setYAxis(buildYAxisFromInputs(next));
                                  }}
                                  placeholder="0"
                                />
                                <input
                                  type="number"
                                  className="input-base text-sm"
                                  value={yAxisInputs.max}
                                  onChange={(event) => {
                                    const next = { ...yAxisInputs, max: parseNumber(event.target.value) };
                                    setYAxisInputs(next);
                                    setYAxis(buildYAxisFromInputs(next));
                                  }}
                                  placeholder="0"
                                />
                              </div>
                              <p className="text-[11px] text-text-muted">默认 0 / 0 代表 Auto。</p>
                            </div>
                          )}

                          {renderLifecycleScriptSettings()}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-1 overflow-hidden rounded-xl">
                    {renderedSeries.map((series, index) => (
                      <div
                        key={series.id}
                        className={canvasConfigRowClassName}
                      >
                        {chartKind === 'line' && isLineOrBarSeries(series) ? (
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <input
                              type="text"
                              className="input-base w-28 shrink-0 text-sm"
                              value={series.name}
                              onChange={(event) => updateSeriesBase(index, { name: event.target.value })}
                              placeholder="Name"
                            />
                            <SeriesColorControl
                              color={series.color}
                              fallbackColor={getSeriesColor(index)}
                              onChange={(color) => updateSeriesBase(index, { color })}
                            />

                            {dataSource === 'parsed' ? (
                              <div className="w-48 shrink-0">
                                <ParsedFieldSelector
                                  value={series.extractor.source === 'parsed' ? series.extractor.fieldId : ''}
                                  onChange={(fieldId) => updateLineOrBarSeriesExtractor(index, { source: 'parsed', fieldId, formula: series.extractor.formula })}
                                  fieldOptions={mergedFieldOptions}
                                  placeholder="Field"
                                />
                              </div>
                            ) : (
                              <>
                                <input
                                  type="number"
                                  className="input-base w-16 shrink-0 text-sm"
                                  value={series.extractor.source === 'raw' ? series.extractor.offset : 0}
                                  onChange={(event) => {
                                    if (series.extractor.source !== 'raw') return;
                                    updateLineOrBarSeriesExtractor(index, { ...series.extractor, offset: parseNumber(event.target.value) });
                                  }}
                                  placeholder="Off"
                                />
                                <select
                                  className="select-base w-28 shrink-0 text-sm"
                                  value={series.extractor.source === 'raw' ? series.extractor.format : 'UInt8'}
                                  onChange={(event) => {
                                    if (series.extractor.source !== 'raw') return;
                                    updateLineOrBarSeriesExtractor(index, { ...series.extractor, format: event.target.value as NumericFormat });
                                  }}
                                >
                                  {NUMERIC_FORMAT_OPTIONS.map((format) => (
                                    <option key={format} value={format}>{format}</option>
                                  ))}
                                </select>
                              </>
                            )}

                            <FormulaInput
                              value={series.extractor.formula}
                              onChange={(formula) => updateLineOrBarSeriesExtractor(index, setExtractorFormula(series.extractor, formula))}
                              placeholder="Formula"
                              containerClassName="min-w-[10rem] flex-1"
                            />
                          </div>
                        ) : isLineOrBarSeries(series) ? (
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <input
                              type="text"
                              className="input-base w-28 shrink-0 text-sm"
                              value={series.name}
                              onChange={(event) => updateSeriesBase(index, { name: event.target.value })}
                              placeholder="Series name"
                            />
                            <SeriesColorControl
                              color={series.color}
                              fallbackColor={getSeriesColor(index)}
                              onChange={(color) => updateSeriesBase(index, { color })}
                            />
                            {dataSource === 'parsed' ? (
                              <div className="w-48 shrink-0">
                                <ParsedFieldSelector
                                  value={series.extractor.source === 'parsed' ? series.extractor.fieldId : ''}
                                  onChange={(fieldId) => updateLineOrBarSeriesExtractor(index, { source: 'parsed', fieldId, formula: series.extractor.formula })}
                                  fieldOptions={mergedFieldOptions}
                                  placeholder="Field"
                                />
                              </div>
                            ) : (
                              <>
                                <input
                                  type="number"
                                  className="input-base w-16 shrink-0 text-sm"
                                  value={series.extractor.source === 'raw' ? series.extractor.offset : 0}
                                  onChange={(event) => {
                                    if (series.extractor.source !== 'raw') return;
                                    updateLineOrBarSeriesExtractor(index, { ...series.extractor, offset: parseNumber(event.target.value) });
                                  }}
                                  placeholder="Off"
                                />
                                <select
                                  className="select-base w-28 shrink-0 text-sm"
                                  value={series.extractor.source === 'raw' ? series.extractor.format : 'UInt8'}
                                  onChange={(event) => {
                                    if (series.extractor.source !== 'raw') return;
                                    updateLineOrBarSeriesExtractor(index, { ...series.extractor, format: event.target.value as NumericFormat });
                                  }}
                                >
                                  {NUMERIC_FORMAT_OPTIONS.map((format) => (
                                    <option key={format} value={format}>{format}</option>
                                  ))}
                                </select>
                              </>
                            )}
                            <FormulaInput
                              value={series.extractor.formula}
                              onChange={(formula) => updateLineOrBarSeriesExtractor(index, setExtractorFormula(series.extractor, formula))}
                              placeholder="Formula"
                              containerClassName="min-w-[10rem] flex-1"
                            />
                          </div>
                        ) : (
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <input
                              type="text"
                              className="input-base w-28 shrink-0 text-sm"
                              value={series.name}
                              onChange={(event) => updateSeriesBase(index, { name: event.target.value })}
                              placeholder="Series name"
                            />
                            <SeriesColorControl
                              color={series.color}
                              fallbackColor={getSeriesColor(index)}
                              onChange={(color) => updateSeriesBase(index, { color })}
                            />
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-text-secondary">X</span>
                              {dataSource === 'parsed' ? (
                                <div className="w-48 shrink-0">
                                  <ParsedFieldSelector
                                    value={series.xExtractor.source === 'parsed' ? series.xExtractor.fieldId : ''}
                                    onChange={(fieldId) => updateScatterSeriesExtractor(index, 'x', { source: 'parsed', fieldId, formula: series.xExtractor.formula })}
                                    fieldOptions={mergedFieldOptions}
                                    placeholder="Field"
                                  />
                                </div>
                              ) : (
                                <>
                                  <input
                                    type="number"
                                    className="input-base w-16 shrink-0 text-sm"
                                    value={series.xExtractor.source === 'raw' ? series.xExtractor.offset : 0}
                                    onChange={(event) => {
                                      if (series.xExtractor.source !== 'raw') return;
                                      updateScatterSeriesExtractor(index, 'x', { ...series.xExtractor, offset: parseNumber(event.target.value) });
                                    }}
                                    placeholder="Off"
                                  />
                                  <select
                                    className="select-base w-28 shrink-0 text-sm"
                                    value={series.xExtractor.source === 'raw' ? series.xExtractor.format : 'UInt8'}
                                    onChange={(event) => {
                                      if (series.xExtractor.source !== 'raw') return;
                                      updateScatterSeriesExtractor(index, 'x', { ...series.xExtractor, format: event.target.value as NumericFormat });
                                    }}
                                  >
                                    {NUMERIC_FORMAT_OPTIONS.map((format) => (
                                      <option key={format} value={format}>{format}</option>
                                    ))}
                                  </select>
                                </>
                              )}
                              <FormulaInput
                                value={series.xExtractor.formula}
                                onChange={(formula) => updateScatterSeriesExtractor(index, 'x', setExtractorFormula(series.xExtractor, formula))}
                                placeholder="Formula"
                                containerClassName="min-w-[10rem] flex-1"
                              />
                            </div>
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-text-secondary">Y</span>
                              {dataSource === 'parsed' ? (
                                <div className="w-48 shrink-0">
                                  <ParsedFieldSelector
                                    value={series.yExtractor.source === 'parsed' ? series.yExtractor.fieldId : ''}
                                    onChange={(fieldId) => updateScatterSeriesExtractor(index, 'y', { source: 'parsed', fieldId, formula: series.yExtractor.formula })}
                                    fieldOptions={mergedFieldOptions}
                                    placeholder="Field"
                                  />
                                </div>
                              ) : (
                                <>
                                  <input
                                    type="number"
                                    className="input-base w-16 shrink-0 text-sm"
                                    value={series.yExtractor.source === 'raw' ? series.yExtractor.offset : 0}
                                    onChange={(event) => {
                                      if (series.yExtractor.source !== 'raw') return;
                                      updateScatterSeriesExtractor(index, 'y', { ...series.yExtractor, offset: parseNumber(event.target.value) });
                                    }}
                                    placeholder="Off"
                                  />
                                  <select
                                    className="select-base w-28 shrink-0 text-sm"
                                    value={series.yExtractor.source === 'raw' ? series.yExtractor.format : 'UInt8'}
                                    onChange={(event) => {
                                      if (series.yExtractor.source !== 'raw') return;
                                      updateScatterSeriesExtractor(index, 'y', { ...series.yExtractor, format: event.target.value as NumericFormat });
                                    }}
                                  >
                                    {NUMERIC_FORMAT_OPTIONS.map((format) => (
                                      <option key={format} value={format}>{format}</option>
                                    ))}
                                  </select>
                                </>
                              )}
                              <FormulaInput
                                value={series.yExtractor.formula}
                                onChange={(formula) => updateScatterSeriesExtractor(index, 'y', setExtractorFormula(series.yExtractor, formula))}
                                placeholder="Formula"
                                containerClassName="min-w-[10rem] flex-1"
                              />
                            </div>
                          </div>
                        )}
                        <button
                          className="ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-1 focus:ring-red-400/60"
                          onClick={() => removeSeries(index)}
                          title="Remove Series"
                          aria-label="Remove Series"
                        >
                          <TrashIcon size={16} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <button
                className="absolute bottom-4 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-accent-mauve text-text-primary hover:bg-accent-mauve/80 active:scale-95 transition-all shadow-lg text-2xl font-bold"
                onClick={addSeries}
                title="Add Series"
                aria-label="Add Series"
              >
                +
              </button>
            </>
          )}

          {type === 'form' && (
            <>
              <div className="h-full overflow-y-auto pb-14">
                <div>
                  <div className="px-4 pt-3 pb-2">
                    <div className="flex items-center gap-4 border-b border-border">
                      <div className="flex items-center gap-6" role="tablist" aria-label="Form mode">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={formMode === 'send'}
                          className={`-mb-px border-b-2 px-0 pb-2 text-sm font-medium transition-colors focus:outline-none focus-visible:text-text-primary ${formMode === 'send' ? 'border-accent-mauve text-text-primary' : 'border-transparent text-text-muted hover:text-text-secondary'}`}
                          onClick={() => setFormMode('send')}
                        >
                          Send
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={formMode === 'display'}
                          className={`-mb-px border-b-2 px-0 pb-2 text-sm font-medium transition-colors focus:outline-none focus-visible:text-text-primary ${formMode === 'display' ? 'border-accent-mauve text-text-primary' : 'border-transparent text-text-muted hover:text-text-secondary'}`}
                          onClick={() => setFormMode('display')}
                        >
                          Display
                        </button>
                      </div>

                      <button
                        type="button"
                        className="ml-auto -mb-px flex h-8 w-8 items-center justify-center rounded-full border border-transparent pb-2 text-text-secondary transition-colors hover:bg-[var(--layer-hover)] hover:text-text-primary"
                        onClick={() => setIsFormSendSettingsOpen((current) => !current)}
                        aria-expanded={isFormSendSettingsOpen}
                        aria-controls="form-send-settings-panel"
                        title="Toggle form settings"
                      >
                        <ChevronDownIcon
                          className={`h-4 w-4 transition-transform duration-200 ${isFormSendSettingsOpen ? 'rotate-180' : ''}`}
                        />
                      </button>
                    </div>

                    <div
                      id="form-send-settings-panel"
                      aria-hidden={!isFormSendSettingsOpen}
                      className={`grid transition-all duration-200 ease-out ${isFormSendSettingsOpen ? 'grid-rows-[1fr] pt-3 opacity-100' : 'grid-rows-[0fr] pt-0 opacity-0 invisible pointer-events-none'}`}
                    >
                      <div className="overflow-hidden">
                        <div className="space-y-3">
                          {formMode === 'send' && (
                            <div className="space-y-3 rounded-2xl border border-border bg-surface/95 px-4 py-3">
                              <div className="space-y-1">
                                <label className="block text-xs text-text-muted">Expected response (optional)</label>
                                <input
                                  type="text"
                                  className="input-base w-full rounded-xl border-border text-sm"
                                  value={formSendConfig.expectedResponse ?? ''}
                                  onChange={(e) => setFormSendConfig({ ...formSendConfig, expectedResponse: e.target.value || undefined })}
                                  placeholder="e.g. OK or 01 02"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="block text-xs text-text-muted">Timeout (ms)</label>
                                <input
                                  type="number"
                                  className="input-base w-full rounded-xl border-border text-sm"
                                  value={formSendConfig.timeout ?? 5000}
                                  min={100}
                                  onChange={(e) => setFormSendConfig({ ...formSendConfig, timeout: Math.max(100, parseNumber(e.target.value, 5000)) })}
                                />
                              </div>
                            </div>
                          )}
                          {renderLifecycleScriptSettings()}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-1 overflow-hidden rounded-xl">
                    {formRows.map((row, index) => {
                      const rowVisible = row.visible !== false;

                      return (
                      <div
                        key={row.id}
                        className={`${canvasConfigRowClassName} ${rowVisible ? '' : 'opacity-55'}`}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <input
                            type="text"
                            className="input-base w-28 shrink-0 text-sm"
                            value={row.label}
                            onChange={(e) =>
                              setFormRows((current) =>
                                current.map((r, i) =>
                                  i === index
                                    ? {
                                        ...r,
                                        label: e.target.value,
                                        column: { ...r.column, alias: e.target.value },
                                      }
                                    : r
                                )
                              )
                            }
                            placeholder="Field name"
                          />

                          {dataSource === 'parsed' ? (
                            <>
                              <div className="w-36 shrink-0">
                                <ParsedFieldSelector
                                  value={row.parsedFieldId ?? ''}
                                  onChange={(parsedFieldId) =>
                                    setFormRows((current) =>
                                      current.map((r, i) =>
                                        i === index ? { ...r, parsedFieldId } : r
                                      )
                                    )
                                  }
                                  fieldOptions={mergedFieldOptions}
                                  placeholder="Parsed field"
                                />
                              </div>
                              <FormulaInput
                                value={row.column.formula}
                                onChange={(formula) =>
                                  setFormRows((current) =>
                                    current.map((r, i) =>
                                      i === index
                                        ? { ...r, column: { ...r.column, formula } }
                                        : r
                                    )
                                  )
                                }
                                placeholder="Formula, e.g. x * 0.1"
                                containerClassName="min-w-0 flex-1"
                              />
                            </>
                          ) : (
                            <>
                              <input
                                type="number"
                                className="input-base w-16 shrink-0 text-sm"
                                value={row.column.offset}
                                onChange={(e) =>
                                  setFormRows((current) =>
                                    current.map((r, i) =>
                                      i === index
                                        ? { ...r, column: { ...r.column, offset: parseNumber(e.target.value) } }
                                        : r
                                    )
                                  )
                                }
                                placeholder="Offset"
                              />
                              <select
                                className="select-base w-24 shrink-0 text-sm"
                                value={row.column.format}
                                onChange={(e) =>
                                  setFormRows((current) =>
                                    current.map((r, i) =>
                                      i === index
                                        ? { ...r, column: { ...r.column, format: e.target.value as TableColumnFormat } }
                                        : r
                                    )
                                  )
                                }
                              >
                                {TABLE_FORMAT_OPTIONS.map((option) => (
                                  <option key={option} value={option}>{option}</option>
                                ))}
                              </select>
                              <FormulaInput
                                value={row.column.formula}
                                onChange={(formula) =>
                                  setFormRows((current) =>
                                    current.map((r, i) =>
                                      i === index
                                        ? { ...r, column: { ...r.column, formula } }
                                        : r
                                    )
                                  )
                                }
                                placeholder="Formula, e.g. x * 0.1"
                                containerClassName="min-w-0 flex-1"
                              />
                            </>
                          )}

                          {formMode === 'send' && (
                            <input
                              type="text"
                              className="input-base w-32 shrink-0 text-sm"
                              value={row.defaultValue ?? ''}
                              onChange={(e) =>
                                setFormRows((current) =>
                                  current.map((r, i) =>
                                    i === index ? { ...r, defaultValue: e.target.value || undefined } : r
                                  )
                                )
                              }
                              placeholder="Default value"
                            />
                          )}
                        </div>

                        <button
                          className="ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-[var(--layer-hover)] hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-mauve/60"
                          onClick={() =>
                            setFormRows((current) =>
                              current.map((r, i) =>
                                i === index ? { ...r, visible: r.visible === false } : r
                              )
                            )
                          }
                          title={rowVisible ? 'Hide Row' : 'Show Row'}
                          aria-label={rowVisible ? 'Hide Row' : 'Show Row'}
                          aria-pressed={!rowVisible}
                        >
                          {rowVisible ? (
                            <EyeIcon size={16} aria-hidden="true" />
                          ) : (
                            <EyeOffIcon size={16} aria-hidden="true" />
                          )}
                        </button>

                        <button
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-1 focus:ring-red-400/60"
                          onClick={() => setFormRows((current) => current.filter((_, i) => i !== index))}
                          title="Remove Row"
                          aria-label="Remove Row"
                        >
                          <TrashIcon size={16} aria-hidden="true" />
                        </button>
                      </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <button
                className="absolute bottom-4 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-accent-mauve text-text-primary hover:bg-accent-mauve/80 active:scale-95 transition-all shadow-lg text-2xl font-bold"
                onClick={addFormRow}
                title="Add Row"
              >
                +
              </button>
            </>
          )}
            </div>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
};
