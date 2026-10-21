export type CanvasType = 'table' | 'chart' | 'form' | 'script';

export type DataSourceMode = 'raw' | 'parsed';

export type NumericFormat =
  | 'UInt8'
  | 'Int8'
  | 'UInt16LE'
  | 'UInt16BE'
  | 'Int16LE'
  | 'Int16BE'
  | 'UInt32LE'
  | 'UInt32BE'
  | 'Int32LE'
  | 'Int32BE'
  | 'Float32LE'
  | 'Float32BE'
  | 'Float64LE'
  | 'Float64BE';

export type NumericExtractor =
  | { source: 'raw'; offset: number; format: NumericFormat; formula: string }
  | { source: 'parsed'; fieldId: string; formula: string };

export type YAxisConfig = { mode: 'auto' } | { mode: 'manual'; min: number; max: number };

export interface ChartSeriesBase {
  id: string;
  name: string;
  color: string;
}

export type TableColumnFormat = 
  | 'UInt8' | 'UInt16LE' | 'UInt16BE' | 'UInt32LE' | 'UInt32BE'
  | 'Int8' | 'Int16LE' | 'Int16BE' | 'Int32LE' | 'Int32BE'
  | 'Float32LE' | 'Float32BE' | 'Float64LE' | 'Float64BE'
  | 'Hex' | 'Ascii';

export interface TableColumn {
  id: string;
  alias: string;
  offset: number;
  format: TableColumnFormat;
  formula: string;
  builtIn?: 'timestamp' | 'channelName';
  parsedFieldId?: string;
}

export interface TableConfig {
  columns: TableColumn[];
}

export interface TimeFormatConfig {
  hour: boolean;
  minute: boolean;
  second: boolean;
  millisecond: boolean;
}

export interface TimestampXAxisConfig {
  kind: 'timestamp';
  timeFormat?: TimeFormatConfig;
  format?: string;
}

export interface ExtractorXAxisConfig {
  kind: 'extractor';
  extractor: NumericExtractor;
}

export type LineXAxisConfig = TimestampXAxisConfig | ExtractorXAxisConfig;

export interface LineChartConfig {
  kind: 'line';
  xSource: LineXAxisConfig;
  series: Array<ChartSeriesBase & { extractor: NumericExtractor }>;
  yAxis: YAxisConfig;
}

export interface BarChartConfig {
  kind: 'bar';
  series: Array<ChartSeriesBase & { extractor: NumericExtractor }>;
  yAxis: YAxisConfig;
}

export interface ScatterChartConfig {
  kind: 'scatter';
  series: Array<ChartSeriesBase & { xExtractor: NumericExtractor; yExtractor: NumericExtractor }>;
  yAxis: YAxisConfig;
}

export type ChartConfig = LineChartConfig | BarChartConfig | ScatterChartConfig;

export type FormMode = 'display' | 'send';

export interface FormRowConfig {
  id: string;
  label: string;
  column: TableColumn;
  defaultValue?: string;
  editable?: boolean;
  visible?: boolean;
  parsedFieldId?: string;
}

export interface FormSendConfig {
  expectedResponse?: string;
  timeout?: number;
}

export interface FormBleTarget {
  serviceUuid: string;
  charUuid: string;
}

export interface FormConfig {
  kind: 'form';
  mode: FormMode;
  rows: FormRowConfig[];
  sendConfig?: FormSendConfig;
}

export interface ScriptReportConfig {
  csvEnabled?: boolean;
  csvPath?: string;
}

export interface ScriptCsvLogOutputConfig {
  enabled?: boolean;
  path?: string;
}

export interface ScriptConfig {
  sourceType: 'file';
  luaPath?: string;
  yamlPath?: string;
  /** The Lua source is owned by a portable snapshot and cannot be reconfigured. */
  bundled?: boolean;
  autoRun?: boolean;
  stopOnFailure?: boolean;
  defaultTimeoutMs?: number;
  defaultDataFormat?: 'hex' | 'text';
  logLimit?: number;
  report?: ScriptReportConfig;
  csvLogOutputs?: Record<string, ScriptCsvLogOutputConfig>;
  /** Explicitly persisted, non-sensitive values declared by Script UI controls. */
  uiState?: {
    stateVersion: string;
    values: Record<string, unknown>;
    /** Revisions of dynamic UI sources, keyed by their declared source path. */
    sourceRevisions?: Record<string, string>;
  };
}

export interface CanvasLifecycleScriptConfig {
  sourceType: 'file';
  luaPath?: string;
  /** The Lua source is owned by a portable snapshot and cannot be reconfigured. */
  bundled?: boolean;
  enabled?: boolean;
  runOnActivate?: boolean;
  runOnDeactivate?: boolean;
  stopOnFailure?: boolean;
  defaultTimeoutMs?: number;
  defaultDataFormat?: 'hex' | 'text';
  logLimit?: number;
}

export interface CanvasChannelLink {
  channelId: string;
  protocolTemplateId: string | null;
  protocolFile?: string | null;
  protocolResourceRoot?: string | null;
  /** The protocol Lua source and its resource root are owned by a portable snapshot. */
  protocolBundled?: boolean;
  bleTarget?: FormBleTarget;
}

export interface CanvasConfig {
  type: CanvasType;
  dataSource: DataSourceMode;
  channels: CanvasChannelLink[];
  table?: TableConfig;
  chart?: ChartConfig;
  form?: FormConfig;
  script?: ScriptConfig;
  lifecycleScript?: CanvasLifecycleScriptConfig;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasActivationMode = 'auto' | 'manual-off';

export interface Canvas {
  id: string;
  name: string;
  groupId?: string | null;
  rect: CanvasRect;
  savedRect: CanvasRect | null;
  savedSnapped: boolean | null;
  zIndex: number;
  active: boolean;
  activationMode: CanvasActivationMode;
  maximized: boolean;
  snapped: boolean;
  config: CanvasConfig;
}
