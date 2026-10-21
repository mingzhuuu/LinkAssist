import { migrateCanvases } from '../types/canvasMigration';
import type { Canvas } from '../types/canvas';
import type { AppConfig } from '../types/persistence';
import { isTerminalLayoutSnapshot, normalizeTerminalChannelSettings } from './persistenceValidation';
import { numericExpressionError } from './numericExpression';

type ObjectValue = Record<string, unknown>;
export type LayoutImport = Partial<Omit<AppConfig, 'ui' | 'protocol'>> & {
  ui?: Partial<AppConfig['ui']>;
  protocol?: Partial<AppConfig['protocol']>;
};

function requireValid(condition: unknown, path: string): asserts condition {
  if (!condition) throw new Error(`Invalid layout: ${path}`);
}
function object(value: unknown, path: string): ObjectValue {
  requireValid(value && typeof value === 'object' && !Array.isArray(value), path);
  return value as ObjectValue;
}
function list(value: unknown, path: string): unknown[] {
  requireValid(Array.isArray(value) && value.length <= 10000, path);
  return value;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string';
function optionalFields(value: ObjectValue, keys: string[], test: (value: unknown) => boolean, path: string) {
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) requireValid(test(value[key]), `${path}.${key}`);
}
function uniqueObjects(value: unknown, path: string): ObjectValue[] {
  const ids = new Set<string>();
  return list(value, path).map((entry, index) => {
    const item = object(entry, `${path}[${index}]`);
    requireValid(text(item.id) && item.id.length > 0 && !ids.has(item.id), `${path}[${index}].id (missing or duplicate)`);
    ids.add(item.id);
    return item;
  });
}
function safeTree(value: unknown, depth = 0): void {
  requireValid(depth <= 64, 'nesting exceeds 64 levels');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    requireValid(!['__proto__', 'constructor', 'prototype'].includes(key), `reserved key "${key}"`);
    safeTree(child, depth + 1);
  }
}
function formula(value: unknown, path: string, strict: boolean) {
  requireValid(value === undefined || text(value), path);
  if (!strict || !value || /^@(Timestamp|ChannelName)(?:\(|$)/.test(value)) return;
  const error = numericExpressionError(value);
  requireValid(!error, `${path}: ${error}`);
}
const formats = new Set(['UInt8', 'Int8', 'UInt16', 'Int16', 'UInt32', 'Int32', 'Float32', 'Float64',
  ...['UInt16', 'Int16', 'UInt32', 'Int32', 'Float32', 'Float64'].flatMap(name => [name + 'LE', name + 'BE'])]);
function extractor(value: unknown, path: string, strict: boolean) {
  const entry = object(value, path);
  requireValid(entry.source === 'raw' || entry.source === 'parsed', `${path}.source`);
  if (entry.source === 'raw') {
    requireValid(Number.isInteger(entry.offset) && Number(entry.offset) >= 0, `${path}.offset`);
    requireValid(text(entry.format) && formats.has(entry.format), `${path}.format`);
  } else requireValid(text(entry.fieldId), `${path}.fieldId`);
  formula(entry.formula, `${path}.formula`, strict);
}
function column(value: unknown, path: string, strict: boolean) {
  const entry = object(value, path);
  requireValid(text(entry.id) && text(entry.alias), path);
  requireValid(Number.isInteger(entry.offset) && Number(entry.offset) >= 0, `${path}.offset`);
  requireValid(text(entry.format) && (formats.has(entry.format) || ['Hex', 'Ascii'].includes(entry.format)), `${path}.format`);
  optionalFields(entry, ['parsedFieldId'], text, path);
  formula(entry.formula, `${path}.formula`, strict);
}
function rect(value: unknown, path: string) {
  const r = object(value, path);
  requireValid(['x', 'y', 'width', 'height'].every(key => finite(r[key])), path);
  requireValid(Number(r.width) >= 0 && Number(r.height) >= 0, path);
}

/** Shared startup/import validation. Old unsupported formulas remain inert and editable on startup. */
export function validateCanvases(value: unknown, strictFormulas = true): Canvas[] {
  safeTree(value);
  const canvases = uniqueObjects(value, 'canvases');
  for (const c of canvases) {
    const path = `canvases.${c.id}`;
    requireValid(text(c.name) && finite(c.zIndex), path);
    rect(c.rect, `${path}.rect`);
    if (c.savedRect != null) rect(c.savedRect, `${path}.savedRect`);
    optionalFields(c, ['active', 'maximized', 'snapped', 'savedSnapped'], v => typeof v === 'boolean', path);
    optionalFields(c, ['activationMode'], v => v === 'auto' || v === 'manual-off', path);
    const cfg = object(c.config, `${path}.config`);
    requireValid(['table', 'form', 'chart', 'script'].includes(String(cfg.type)), `${path}.config.type`);
    requireValid(cfg.dataSource === 'raw' || cfg.dataSource === 'parsed', `${path}.config.dataSource`);
    for (const linkValue of list(cfg.channels, `${path}.channels`)) {
      const link = object(linkValue, `${path}.channels`);
      requireValid(text(link.channelId), `${path}.channelId`);
      optionalFields(link, ['protocolFile', 'protocolTemplateId', 'protocolResourceRoot'], text, path);
      if (link.bleTarget != null) {
        const target = object(link.bleTarget, `${path}.bleTarget`);
        requireValid(text(target.serviceUuid) && text(target.charUuid), `${path}.bleTarget`);
      }
    }
    if (cfg.table != null) {
      const table = object(cfg.table, `${path}.table`);
      for (const col of uniqueObjects(table.columns, `${path}.columns`)) column(col, `${path}.columns.${col.id}`, strictFormulas);
    }
    if (cfg.form != null) {
      const form = object(cfg.form, `${path}.form`);
      requireValid(form.mode === 'send' || form.mode === 'display', `${path}.form.mode`);
      for (const row of uniqueObjects(form.rows, `${path}.form.rows`)) {
        requireValid(text(row.label), `${path}.form.label`);
        optionalFields(row, ['defaultValue', 'parsedFieldId'], text, path);
        optionalFields(row, ['editable', 'visible'], v => typeof v === 'boolean', path);
        column(row.column, `${path}.form.${row.id}.column`, strictFormulas);
      }
    }
    if (cfg.chart != null) {
      const chart = object(cfg.chart, `${path}.chart`);
      requireValid(['line', 'bar', 'scatter'].includes(String(chart.kind)), `${path}.chart.kind`);
      const axis = object(chart.yAxis, `${path}.yAxis`);
      requireValid(axis.mode === 'auto' || (axis.mode === 'manual' && finite(axis.min) && finite(axis.max) && axis.min < axis.max), `${path}.yAxis`);
      if (chart.kind === 'line') {
        const x = object(chart.xSource, `${path}.xSource`);
        requireValid(x.kind === 'timestamp' || x.kind === 'extractor', `${path}.xSource.kind`);
        if (x.kind === 'extractor') extractor(x.extractor, `${path}.xSource.extractor`, strictFormulas);
      }
      for (const series of uniqueObjects(chart.series, `${path}.series`)) {
        requireValid(text(series.name) && text(series.color), `${path}.series`);
        for (const key of chart.kind === 'scatter' ? ['xExtractor', 'yExtractor'] : ['extractor']) {
          extractor(series[key], `${path}.series.${series.id}.${key}`, strictFormulas);
        }
      }
    }
    for (const key of ['script', 'lifecycleScript']) {
      if (cfg[key] == null) continue;
      const script = object(cfg[key], `${path}.${key}`);
      optionalFields(script, ['luaPath', 'yamlPath'], text, path);
      optionalFields(script, ['autoRun', 'enabled', 'bundled', 'stopOnFailure', 'runOnActivate', 'runOnDeactivate'], v => typeof v === 'boolean', path);
      optionalFields(script, ['defaultTimeoutMs', 'logLimit'], v => finite(v) && v >= 0, path);
      optionalFields(script, ['defaultDataFormat'], v => v === 'hex' || v === 'text', path);
      if (script.report != null) {
        const report = object(script.report, `${path}.${key}.report`);
        optionalFields(report, ['csvEnabled'], v => typeof v === 'boolean', path);
        optionalFields(report, ['csvPath'], text, path);
      }
      if (script.csvLogOutputs != null) {
        const outputs = object(script.csvLogOutputs, `${path}.${key}.csvLogOutputs`);
        for (const [name, value] of Object.entries(outputs)) {
          const output = object(value, `${path}.csvLogOutputs.${name}`);
          optionalFields(output, ['enabled'], v => typeof v === 'boolean', path);
          optionalFields(output, ['path'], text, path);
        }
      }
    }
  }
  // All migration-consumed structure is checked above. Migration also normalizes legacy extractors.
  return migrateCanvases(canvases as unknown as Canvas[]);
}

/** Validate the whole document before any store is changed. Missing sections preserve current state. */
export function parseLayoutImport(content: string): LayoutImport {
  requireValid(content.length <= 8 * 1024 * 1024, 'file exceeds 8 MiB');
  const config = object(JSON.parse(content), 'document');
  safeTree(config);
  requireValid(['channels', 'ui', 'protocol', 'canvases', 'saved_commands', 'mcp_tools'].some(key => config[key] != null), 'no supported sections');
  let channelIds: Set<string> | undefined;
  if (config.channels !== undefined) {
    const channels = uniqueObjects(config.channels, 'channels');
    channelIds = new Set(channels.map(c => String(c.id)));
    for (const channel of channels) {
      requireValid(text(channel.name) && ['ble', 'serial', 'tcp'].includes(String(channel.channel_type)), `channels.${channel.id}`);
      const settings = object(channel.settings, `channels.${channel.id}.settings`);
      if (channel.channel_type === 'tcp') {
        optionalFields(settings, ['mode'], v => ['client', 'server', 'udp'].includes(String(v)), 'channels.settings');
        optionalFields(settings, ['clientAddress', 'serverAddress', 'udpBindAddress', 'udpTargetAddress'], text, 'channels.settings');
      } else if (channel.channel_type === 'ble') {
        optionalFields(settings, ['nameFilter'], text, 'channels.settings');
        optionalFields(settings, ['rssiFilter'], finite, 'channels.settings');
        optionalFields(settings, ['hasServicesFilter', 'hasNameFilter', 'connectableFilter'], v => typeof v === 'boolean', 'channels.settings');
      }
    }
  }
  if (config.canvases != null) {
    const canvases = validateCanvases(config.canvases);
    if (channelIds) for (const c of canvases) for (const link of c.config.channels) {
      requireValid(channelIds.has(link.channelId), `canvases.${c.id}: unknown channel ${link.channelId}`);
    }
    config.canvases = canvases;
  }
  if (config.ui !== undefined) {
    const ui = object(config.ui, 'ui');
    optionalFields(ui, ['left_panel_width', 'right_panel_width', 'center_panel_width'], v => finite(v) && v >= 0, 'ui');
    optionalFields(ui, ['center_split_ratio'], v => finite(v) && v >= 0 && v <= 1, 'ui');
    optionalFields(ui, ['theme_mode'], v => ['dark', 'light', 'system', 'high-contrast', 'high-contrast-light'].includes(String(v)), 'ui');
    optionalFields(ui, ['data_view_mode'], v => ['text', 'table', 'chart', 'image'].includes(String(v)), 'ui');
    optionalFields(ui, ['send_format', 'receive_format'], v => v === 'ascii' || v === 'hex', 'ui');
    if (ui.terminal_layout != null) requireValid(isTerminalLayoutSnapshot(ui.terminal_layout), 'ui.terminal_layout');
    if (ui.terminal_channel_settings != null) requireValid(normalizeTerminalChannelSettings(ui.terminal_channel_settings), 'ui.terminal_channel_settings');
  }
  if (config.protocol !== undefined) {
    const protocol = object(config.protocol, 'protocol');
    optionalFields(protocol, ['mode'], v => ['Passthrough', 'FieldDefinition', 'LuaScript'].includes(String(v)), 'protocol');
    optionalFields(protocol, ['lua_script', 'linked_channel_id', 'linked_service_uuid', 'linked_char_uuid'], text, 'protocol');
  }
  if (config.saved_commands != null) {
    const saved = object(config.saved_commands, 'saved_commands');
    object(saved.commandSets, 'saved_commands.commandSets');
    object(saved.expandedGroups, 'saved_commands.expandedGroups');
    if (saved.savedConfigs != null) {
      const configs = object(saved.savedConfigs, 'saved_commands.savedConfigs');
      for (const [tag, entries] of Object.entries(configs)) {
        for (const entry of uniqueObjects(entries, `saved_commands.savedConfigs.${tag}`)) {
          requireValid(text(entry.name) && finite(entry.timestamp), `saved_commands.savedConfigs.${tag}`);
          const data = object(entry.data, `saved_commands.savedConfigs.${tag}.data`);
          for (const group of uniqueObjects(data.groups, 'saved_commands.groups')) {
            requireValid(text(group.name) && finite(group.order), 'saved_commands.groups');
            optionalFields(group, ['parentGroupId'], text, 'saved_commands.groups');
          }
          for (const command of uniqueObjects(data.commands, 'saved_commands.commands')) {
            requireValid(text(command.name) && text(command.command) && finite(command.order), 'saved_commands.commands');
            optionalFields(command, ['groupId'], text, 'saved_commands.commands');
          }
        }
      }
    }
  }
  if (config.mcp_tools != null) {
    const mcp = object(config.mcp_tools, 'mcp_tools');
    optionalFields(mcp, ['enabled'], v => typeof v === 'boolean', 'mcp_tools');
    for (const value of list(mcp.scripts, 'mcp_tools.scripts')) {
      const script = object(value, 'mcp_tools.scripts');
      requireValid(text(script.luaPath), 'mcp_tools.scripts.luaPath');
      optionalFields(script, ['protocolFile', 'protocolResourceRoot'], text, 'mcp_tools.scripts');
      optionalFields(script, ['exposeToMcp'], v => typeof v === 'boolean', 'mcp_tools.scripts');
    }
  }
  return config as LayoutImport;
}
