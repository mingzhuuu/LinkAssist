import React, { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { ChartConfig, RemoteWorkspaceSnapshot } from '../../types';
import type { RemoteAction } from './RemoteChannelPanel';
import { ScriptCanvasUi } from '../display/ScriptCanvasUi';
import { LegacyScriptOutput, ScriptToolbarControlView } from '../display/CanvasScript';
import { buildBarOptions, buildLineOptions, buildScatterOptions } from '../display/adapters';
import { readUiPath, setUiPath } from '../display/scriptUiUtils';

export const RemoteCanvasPanel: React.FC<{ snapshot: RemoteWorkspaceSnapshot; canvasId: string; act: RemoteAction }> = ({ snapshot, canvasId, act }) => {
  const frame = snapshot.canvasFrames?.[canvasId];
  if (frame) snapshot = { ...snapshot, canvasId, rows: frame.rows, chart: frame.chart, canvasView: frame.view };
  const canvas = snapshot.canvases.find(canvas => canvas.id === canvasId);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [paused, setPaused] = useState(false);
  const view = snapshot.canvasId === canvasId ? snapshot.canvasView : null;
  useEffect(() => {
    if (editing || !view) return;
    if (view.kind === 'script') setValues(view.values);
    else setFormValues(view.values);
  }, [view, editing]);
  if (!canvas || snapshot.canvasId !== canvasId) return <p className="p-4 text-text-secondary">Loading canvas from host…</p>;
  const call = (action: string, args: Record<string, unknown> = {}) => act(action, { canvasId, ...args });
  const scriptAction = (handler: string, options?: { preserveLogs?: boolean; reloadDocument?: boolean }) => {
    void call('script.action', { handler, values, ...options }).then(() => setEditing(false)).catch(() => {});
  };
  const columns = canvas.config.table?.columns ?? [];
  return <section className="flex h-full min-h-0 flex-col bg-surface text-sm">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <strong className="flex-1">{canvas.name || canvas.config.type}</strong><span className="text-xs text-text-secondary">Runs on host</span>
      <button className="btn-channel-action px-2" onClick={() => void call(canvas.active ? 'canvas.deactivate' : 'canvas.activate').catch(() => {})}>{canvas.active ? 'Deactivate' : 'Activate'}</button>
      {canvas.config.type !== 'script' && <button className="btn-channel-action px-2" onClick={() => void call('canvas.clear').catch(() => {})}>Clear</button>}
      {canvas.config.type === 'chart' && <button className="btn-channel-action px-2" onClick={() => void call('canvas.pause', { paused: !paused }).then(() => setPaused(!paused)).catch(() => {})}>{paused ? 'Resume' : 'Pause'}</button>}
    </header>
    {canvas.config.type === 'table' && <div className="min-h-0 flex-1 overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-surface-secondary"><tr><th className="p-2">Time</th>{columns.map(column => <th className="p-2" key={column.id}>{column.alias || column.id}</th>)}</tr></thead><tbody>{snapshot.rows.map((row, index) => <tr key={`${row.timestamp}-${index}`} className="border-b border-border"><td className="p-2 font-mono">{new Date(row.timestamp).toLocaleTimeString()}</td>{columns.map(column => <td className="p-2 font-mono" key={column.id}>{row.cells[column.id]}</td>)}</tr>)}</tbody></table></div>}
    {canvas.config.type === 'chart' && canvas.config.chart && <RemoteChart config={canvas.config.chart} data={snapshot.chart} />}
    {canvas.config.type === 'form' && <div className="space-y-2 overflow-auto p-3">
      {(canvas.config.form?.rows ?? []).filter(row => row.visible !== false).map(row => <label className="flex items-center justify-between gap-4 border-b border-border py-2" key={row.id}><span>{row.label}</span>{canvas.config.form?.mode === 'send' ? <input className="input-base min-w-0 flex-1" disabled={row.editable === false} value={formValues[row.id] ?? row.defaultValue ?? ''} onChange={event => { setEditing(true); setFormValues({ ...formValues, [row.id]: event.target.value }); }} /> : <span className="font-mono">{snapshot.rows[snapshot.rows.length - 1]?.cells[row.column.id] ?? '—'}</span>}</label>)}
      {canvas.config.form?.mode === 'send' && <button className="btn-channel-action px-4" disabled={view?.kind !== 'form' || view.status === 'sending'} onClick={() => void call('canvas.formSend', { values: formValues }).then(() => setEditing(false)).catch(() => {})}>Send form on host</button>}
      {view?.kind === 'form' && <p className="text-xs text-text-secondary">{view.status}</p>}
    </div>}
    {canvas.config.type === 'script' && (view?.kind === 'script' ? <>
      {view.error && <p className="p-3 text-accent-red">{view.error}</p>}
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <span className="text-xs text-text-secondary">{view.snapshot.status}</span>
        {view.ui?.toolbar?.map(control => <React.Fragment key={control.id}>
          {control.type === 'button' && control.directoryPicker && control.bind && <input aria-label={`Remote ${control.label || control.id} path`} className="input-base min-w-32 flex-1 text-xs" placeholder="Path on the remote computer" value={String(readUiPath(values, control.bind) ?? '')} onChange={event => { setEditing(true); setValues(setUiPath(values, control.bind!, event.target.value)); }} />}
          <ScriptToolbarControlView control={control.type === 'button' ? { ...control, directoryPicker: false } : control}
          values={values} sources={view.sources} snapshot={view.snapshot} loading={false}
          onValuesChange={next => { setEditing(true); setValues(next); }} onAction={scriptAction} /></React.Fragment>)}
        <button className="btn-channel-action px-2" disabled={view.snapshot.status === 'running'} onClick={() => scriptAction('$reload')}>Reload</button>
        {!view.ui && <button className="btn-channel-action px-3" onClick={() => void call(view.snapshot.status === 'running' ? 'script.stop' : 'script.run').catch(() => {})}>{view.snapshot.status === 'running' ? 'Stop' : 'Run on host'}</button>}
        {view.ui && <button className="btn-channel-action ml-auto px-2" onClick={() => void call('script.stop').catch(() => {})}>Stop</button>}
      </div>
      {view.ui ? <div className="min-h-0 flex-1"><ScriptCanvasUi ui={view.ui} values={values} sources={view.sources} snapshot={view.snapshot} allowFileDialogs={false}
        onValuesChange={next => { setEditing(true); setValues(next); }} onAction={scriptAction} /></div> : <LegacyScriptOutput snapshot={view.snapshot} />}
    </> : <p className="p-4 text-text-secondary">Open this script canvas on the host to load its controls. Scripts execute only on the host.</p>)}
  </section>;
};

const RemoteChart: React.FC<{ config: ChartConfig; data: RemoteWorkspaceSnapshot['chart'] }> = ({ config, data }) => {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // Config arrives in snapshots as a fresh object; only recreate when it changes.
  const configKey = JSON.stringify(config);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const parsed = JSON.parse(configKey) as ChartConfig;
    const width = Math.max(100, element.clientWidth);
    const height = Math.max(100, element.clientHeight);
    const options = parsed.kind === 'bar' ? buildBarOptions(parsed, width, height) : parsed.kind === 'scatter' ? buildScatterOptions(parsed, width, height) : buildLineOptions(parsed, width, height);
    const chart = new uPlot(options, [[], ...parsed.series.map(() => [])], element);
    plot.current = chart;
    const observer = new ResizeObserver(() => chart.setSize({ width: Math.max(100, element.clientWidth), height: Math.max(100, element.clientHeight) }));
    observer.observe(element);
    return () => { observer.disconnect(); chart.destroy(); plot.current = null; };
  }, [configKey]);
  useEffect(() => {
    if (!data || !plot.current || data.length !== config.series.length + 1) return;
    const x = data[0];
    if (x.some(value => value === null)) return;
    plot.current.setData([x as number[], ...data.slice(1)]);
  }, [data, config.series.length, configKey]);
  return <div className="min-h-0 flex-1 overflow-hidden" ref={container} />;
};
