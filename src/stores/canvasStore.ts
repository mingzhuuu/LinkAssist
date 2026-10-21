import { create } from 'zustand';
import { Canvas, CanvasRect, CanvasConfig, CanvasType, CanvasActivationMode } from '../types';
import { dispose as disposeChartRuntime } from '../components/display/chartRuntime';
import { disposeScriptRuntime } from '../components/display/scriptRuntime';
import { disposeCanvasLifecycleRuntime } from '../components/display/canvasLifecycleRuntime';
import { disposeCanvasIngest } from '../lib/canvasIngestQueue';

/** Maximum number of rows kept per canvas data buffer */
const MAX_BUFFER_ROWS = 500;

export function clampCanvasRectToContainer(rect: CanvasRect, containerWidth: number, containerHeight: number): CanvasRect {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const width = Math.min(Math.max(rect.width, 0), containerWidth);
  const height = Math.min(Math.max(rect.height, 0), containerHeight);

  return {
    x: Math.min(Math.max(rect.x, 0), Math.max(0, containerWidth - width)),
    y: Math.min(Math.max(rect.y, 0), Math.max(0, containerHeight - height)),
    width,
    height,
  };
}

/** A single row of canvas table data */
export interface CanvasDataRow {
  timestamp: number;
  channelId: string;
  /** Cell values keyed by column id */
  cells: Record<string, string>;
}

interface CanvasStore {
  canvases: Canvas[];
  nextZIndex: number;
  /** Per-canvas data buffers for table rendering */
  dataBuffers: Record<string, CanvasDataRow[]>;
  chartViewState: Record<string, { paused: boolean }>;

  addCanvas: (rect: CanvasRect, openEditor?: boolean) => string;
  removeCanvas: (id: string) => void;
  removeAllCanvases: () => void;
  replaceCanvases: (canvases: Canvas[]) => void;
  updateCanvasRect: (id: string, rect: Partial<CanvasRect>) => void;
  updateCanvasConfig: (id: string, config: Partial<CanvasConfig>) => void;
  setCanvasName: (id: string, name: string) => void;
  activateCanvas: (id: string) => void;
  deactivateCanvas: (id: string, reason?: 'manual' | 'auto') => void;
  syncCanvasChannelState: (id: string, channelAvailable: boolean) => void;
  toggleMaximize: (id: string, containerRect: CanvasRect) => void;
  bringToFront: (id: string) => void;
  bringCanvasesToFront: (ids: string[]) => void;
  sendToBack: (id: string) => void;
  setCanvasRect: (id: string, rect: CanvasRect, snapped?: boolean) => void;
  setCanvasRects: (rects: Record<string, CanvasRect>, snapped?: boolean) => void;
  groupCanvases: (ids: string[]) => string | null;
  ungroupCanvases: (ids: string[]) => void;
  /** Push a new row into a canvas data buffer (capped at MAX_BUFFER_ROWS) */
  pushRow: (canvasId: string, row: CanvasDataRow) => void;
  /** Clear the data buffer for a canvas */
  clearRows: (canvasId: string) => void;
  setChartPaused: (canvasId: string, paused: boolean) => void;
  toggleChartPaused: (canvasId: string) => void;
}

const defaultConfig = (): CanvasConfig => ({
  type: 'table' as CanvasType,
  dataSource: 'raw',
  channels: [],
  table: { columns: [] },
  script: {
    sourceType: 'file',
    luaPath: '',
    stopOnFailure: true,
    defaultTimeoutMs: 2000,
    defaultDataFormat: 'hex',
    logLimit: 500,
  },
});

function clearSingletonCanvasGroups(canvases: Canvas[]): Canvas[] {
  const groupCounts = new Map<string, number>();
  for (const canvas of canvases) {
    if (!canvas.groupId) continue;
    groupCounts.set(canvas.groupId, (groupCounts.get(canvas.groupId) ?? 0) + 1);
  }

  return canvases.map((canvas) => (
    canvas.groupId && (groupCounts.get(canvas.groupId) ?? 0) < 2
      ? { ...canvas, groupId: null }
      : canvas
  ));
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  canvases: [],
  nextZIndex: 1,
  dataBuffers: {},
  chartViewState: {},

  replaceCanvases: (canvases) => {
    get().removeAllCanvases();
    set({
      canvases,
      nextZIndex: Math.max(0, ...canvases.map(c => c.zIndex)) + 1,
      dataBuffers: Object.fromEntries(canvases.map(c => [c.id, []])),
      chartViewState: Object.fromEntries(canvases.map(c => [c.id, { paused: false }])),
    });
  },

  addCanvas: (rect, _openEditor) => {
    const id = crypto.randomUUID();
    set((state) => ({
      canvases: [
        ...state.canvases,
        {
          id,
          name: '',
          groupId: null,
          rect,
          savedRect: null,
          savedSnapped: null,
          zIndex: state.nextZIndex,
          active: true,
          activationMode: 'auto',
          maximized: false,
          snapped: false,
          config: defaultConfig(),
        }
      ],
      nextZIndex: state.nextZIndex + 1,
      dataBuffers: { ...state.dataBuffers, [id]: [] },
      chartViewState: { ...state.chartViewState, [id]: { paused: false } },
    }));
    return id;
  },

  removeCanvas: (id) =>
    set((state) => {
      const { [id]: _, ...restBuffers } = state.dataBuffers;
      const { [id]: __, ...restChartViewState } = state.chartViewState;
      disposeChartRuntime(id);
      disposeCanvasIngest(id);
      disposeScriptRuntime(id);
      disposeCanvasLifecycleRuntime(id);
      return {
        canvases: clearSingletonCanvasGroups(state.canvases.filter((c) => c.id !== id)),
        dataBuffers: restBuffers,
        chartViewState: restChartViewState,
      };
    }),

  removeAllCanvases: () =>
    set((state) => {
      state.canvases.forEach((canvas) => {
        disposeChartRuntime(canvas.id);
        disposeCanvasIngest(canvas.id);
        disposeScriptRuntime(canvas.id);
        disposeCanvasLifecycleRuntime(canvas.id);
      });

      return {
        canvases: [],
        dataBuffers: {},
        chartViewState: {},
      };
    }),

  updateCanvasRect: (id, partial) =>
    set((state) => ({
      canvases: state.canvases.map((c) =>
        c.id === id ? { ...c, rect: { ...c.rect, ...partial } } : c
      ),
    })),

  updateCanvasConfig: (id, partial) =>
    set((state) => ({
      canvases: state.canvases.map((c) =>
        c.id === id ? { ...c, config: { ...c.config, ...partial } } : c
      ),
    })),

  setCanvasName: (id, name) =>
    set((state) => ({
      canvases: state.canvases.map((c) =>
        c.id === id ? { ...c, name } : c
      ),
    })),

  activateCanvas: (id) =>
    set((state) => {
      let changed = false;
      const canvases: Canvas[] = state.canvases.map((c) => {
        if (c.id !== id) return c;
        if (c.active && c.activationMode === 'auto') return c;
        changed = true;
        return { ...c, active: true, activationMode: 'auto' };
      });
      return changed ? { canvases } : state;
    }),

  deactivateCanvas: (id, reason = 'manual') =>
    set((state) => {
      const nextMode: CanvasActivationMode = reason === 'manual' ? 'manual-off' : 'auto';
      let changed = false;
      const canvases: Canvas[] = state.canvases.map((c) => {
        if (c.id !== id) return c;
        if (!c.active && c.activationMode === nextMode) return c;
        changed = true;
        return {
          ...c,
          active: false,
          activationMode: nextMode,
        };
      });
      return changed ? { canvases } : state;
    }),

  syncCanvasChannelState: (id, channelAvailable) =>
    set((state) => {
      let changed = false;
      const canvases: Canvas[] = state.canvases.map((c) => {
        if (c.id !== id) return c;
        if (c.activationMode === 'manual-off') {
          if (!c.active) return c;
          changed = true;
          return { ...c, active: false };
        }
        if (c.active === channelAvailable && c.activationMode === 'auto') return c;
        changed = true;
        return { ...c, active: channelAvailable, activationMode: 'auto' };
      });
      return changed ? { canvases } : state;
    }),

  toggleMaximize: (id, containerRect) =>
    set((state) => ({
      canvases: state.canvases.map((c) => {
        if (c.id !== id) return c;
        if (c.maximized) {
          // Restore: use savedRect, or default to center 1/4 of container
          const restoreRect = c.savedRect ?? {
            x: containerRect.width / 4,
            y: containerRect.height / 4,
            width: containerRect.width / 2,
            height: containerRect.height / 2,
          };
          return {
            ...c,
            maximized: false,
            snapped: c.savedSnapped ?? false,
            rect: restoreRect,
            savedRect: null,
            savedSnapped: null,
          };
        }
        return {
          ...c,
          maximized: true,
          snapped: false,
          savedRect: c.rect,
          savedSnapped: c.snapped,
          rect: { x: 0, y: 0, width: containerRect.width, height: containerRect.height },
          zIndex: state.nextZIndex,
        };
      }),
      nextZIndex: state.nextZIndex + 1,
    })),

  bringToFront: (id) =>
    set((state) => ({
      canvases: state.canvases.map((c) =>
        c.id === id ? { ...c, zIndex: state.nextZIndex } : c
      ),
      nextZIndex: state.nextZIndex + 1,
    })),

  bringCanvasesToFront: (ids) =>
    set((state) => {
      const targetIds = new Set(ids);
      if (targetIds.size === 0) return state;

      let nextZIndex = state.nextZIndex;
      const canvases = state.canvases.map((canvas) => {
        if (!targetIds.has(canvas.id)) return canvas;
        const updated = { ...canvas, zIndex: nextZIndex };
        nextZIndex += 1;
        return updated;
      });

      return { canvases, nextZIndex };
    }),

  sendToBack: (id) =>
    set((state) => {
      const minZ = Math.min(...state.canvases.map((c) => c.zIndex));
      return {
        canvases: state.canvases.map((c) =>
          c.id === id ? { ...c, zIndex: minZ - 1 } : c
        ),
      };
    }),

  setCanvasRect: (id, rect, snapped = false) =>
    set((state) => ({
      canvases: state.canvases.map((c) =>
        c.id === id ? { ...c, rect, maximized: false, snapped, savedRect: null, savedSnapped: null } : c
      ),
    })),

  setCanvasRects: (rects, snapped = false) =>
    set((state) => {
      const ids = new Set(Object.keys(rects));
      if (ids.size === 0) return state;

      return {
        canvases: state.canvases.map((canvas) => (
          ids.has(canvas.id)
            ? {
                ...canvas,
                rect: rects[canvas.id],
                maximized: false,
                snapped,
                savedRect: null,
                savedSnapped: null,
              }
            : canvas
        )),
      };
    }),

  groupCanvases: (ids) => {
    const requestedIds = new Set(ids);
    if (requestedIds.size < 2) return null;

    const state = get();
    const existingGroupIds = new Set(
      state.canvases
        .filter((canvas) => requestedIds.has(canvas.id) && canvas.groupId)
        .map((canvas) => canvas.groupId as string)
    );
    const targetIds = new Set<string>();

    for (const canvas of state.canvases) {
      if (requestedIds.has(canvas.id) || (canvas.groupId && existingGroupIds.has(canvas.groupId))) {
        targetIds.add(canvas.id);
      }
    }

    if (targetIds.size < 2) return null;

    const groupId = crypto.randomUUID();
    set((state) => {
      return {
        canvases: state.canvases.map((canvas) => (
          targetIds.has(canvas.id)
            ? { ...canvas, groupId }
            : canvas
        )),
      };
    });
    return groupId;
  },

  ungroupCanvases: (ids) =>
    set((state) => {
      const requestedIds = new Set(ids);
      if (requestedIds.size === 0) return state;

      const targetGroupIds = new Set(
        state.canvases
          .filter((canvas) => requestedIds.has(canvas.id) && canvas.groupId)
          .map((canvas) => canvas.groupId as string)
      );

      return {
        canvases: state.canvases.map((canvas) => (
          requestedIds.has(canvas.id) || (canvas.groupId && targetGroupIds.has(canvas.groupId))
            ? { ...canvas, groupId: null }
            : canvas
        )),
      };
    }),

  pushRow: (canvasId, row) =>
    set((state) => {
      if (!state.canvases.some(canvas => canvas.id === canvasId)) return state;
      const existing = state.dataBuffers[canvasId] || [];
      const updated = [...existing, row];
      return {
        dataBuffers: {
          ...state.dataBuffers,
          [canvasId]: updated.length > MAX_BUFFER_ROWS ? updated.slice(-MAX_BUFFER_ROWS) : updated,
        },
      };
    }),

  clearRows: (canvasId) =>
    set((state) => ({
      dataBuffers: { ...state.dataBuffers, [canvasId]: [] },
    })),

  setChartPaused: (canvasId, paused) =>
    set((state) => ({
      chartViewState: {
        ...state.chartViewState,
        [canvasId]: { paused },
      },
    })),

  toggleChartPaused: (canvasId) =>
    set((state) => ({
      chartViewState: {
        ...state.chartViewState,
        [canvasId]: {
          paused: !(state.chartViewState[canvasId]?.paused ?? false),
        },
      },
    })),
}));
