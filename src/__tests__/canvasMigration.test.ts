import { describe, expect, it } from 'vitest';
import type { Canvas } from '../types';
import { migrateCanvases } from '../types';

describe('canvas migration', () => {
  it('migrates legacy chart endian and visible settings', () => {
    const legacyCanvases = [
      {
        id: 'canvas-1',
        name: 'Legacy Chart',
        rect: { x: 0, y: 0, width: 400, height: 300 },
        savedRect: null,
        savedSnapped: null,
        zIndex: 1,
        active: true,
        activationMode: 'auto',
        maximized: false,
        snapped: false,
        config: {
          type: 'chart',
          dataSource: 'raw',
          channels: [],
          chart: {
            kind: 'line',
            xSource: {
              kind: 'extractor',
              extractor: {
                source: 'raw',
                offset: 0,
                format: 'UInt32',
                endian: 'be',
                formula: '',
              },
            },
            series: [
              {
                id: 'series-1',
                name: 'Series 1',
                color: '#a78bfa',
                visible: false,
                extractor: {
                  source: 'raw',
                  offset: 4,
                  format: 'Float32',
                  endian: 'le',
                  formula: '',
                },
              },
            ],
            yAxis: { mode: 'auto' },
          },
          lifecycleScript: {
            sourceType: 'file',
            luaPath: 'E:/test/canvas-lifecycle-init-end.lua',
            bundled: true,
            enabled: true,
            runOnActivate: true,
            runOnDeactivate: true,
          },
        },
      },
    ] as unknown as Canvas[];

    const migrated = migrateCanvases(legacyCanvases);
    const chart = migrated[0]?.config.chart;

    expect(chart?.kind).toBe('line');
    if (!chart || chart.kind !== 'line' || chart.xSource.kind !== 'extractor') {
      throw new Error('Expected migrated line chart extractor');
    }

    expect(chart.xSource.extractor).toEqual({
      source: 'raw',
      offset: 0,
      format: 'UInt32BE',
      formula: '',
    });
    expect(chart.series[0]).toMatchObject({
      color: 'none',
      extractor: {
        source: 'raw',
        offset: 4,
        format: 'Float32LE',
        formula: '',
      },
    });
    expect(migrated[0]?.config.lifecycleScript).toMatchObject({
      sourceType: 'file',
      luaPath: 'E:/test/canvas-lifecycle-init-end.lua',
      bundled: true,
      enabled: true,
      runOnActivate: true,
      runOnDeactivate: true,
    });
  });

  it('preserves persisted Script canvas UI state', () => {
    const canvases = [{
      id: 'script-1',
      name: 'Bench',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      savedRect: null,
      savedSnapped: null,
      zIndex: 1,
      active: true,
      activationMode: 'auto',
      maximized: false,
      snapped: false,
      config: {
        type: 'script',
        dataSource: 'raw',
        channels: [],
        script: {
          sourceType: 'file',
          luaPath: 'D:/bench.lua',
          bundled: true,
          uiState: {
            stateVersion: 'bench-v1',
            values: { form: { channelId: 'serial-1', csvPath: 'D:/cases.csv' } },
            sourceRevisions: { catalog: 'revision-1' },
          },
        },
      },
    }] as Canvas[];

    expect(migrateCanvases(canvases)[0]?.config.script?.uiState).toEqual({
      stateVersion: 'bench-v1',
      values: { form: { channelId: 'serial-1', csvPath: 'D:/cases.csv' } },
      sourceRevisions: { catalog: 'revision-1' },
    });
    expect(migrateCanvases(canvases)[0]?.config.script?.bundled).toBe(true);
  });
});
