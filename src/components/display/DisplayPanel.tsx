import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { useBle, useSerial, useTcp } from '../../hooks';
import { toast } from '../../stores/toastStore';
import { useCanvasStore, useChannelStore, useBleStore, useSerialStore, useTcpStore, useUIStore } from '../../stores';
import { Canvas as StoredCanvas, CanvasChannelLink, CanvasRect, Channel } from '../../types';
import { CanvasContainer, computeCanvasBorderColor } from './Canvas';
const CanvasChart = lazy(() => import('./CanvasChart').then(module => ({ default: module.CanvasChart })));
import { CanvasForm } from './CanvasForm';
import { CanvasScript } from './CanvasScript';
import { CanvasTable } from './CanvasTable';
const CanvasEditDialog = lazy(() => import('./CanvasEditDialog').then(module => ({ default: module.CanvasEditDialog })));
import { ContextMenu } from './ContextMenu';
import { runCanvasLifecycleHook } from './canvasLifecycleRuntime';
import { useCanvasInteraction, ResizeEdge } from './useCanvasInteraction';
import {
  CanvasAttachSnap,
  getCanvasAttachSnapRect,
  getCanvasEdgeAttachSnapRect,
  getCanvasResizeAttachSnapRect,
} from './canvasSnapUtils';
import {
  CANVAS_SCROLLBAR_Z_INDEX,
  buildViewportTransform,
  clampScrollX,
  clampScrollY,
  displayToWorldRect,
  getCanvasScrollBounds,
  normalizeWheelDeltaX,
  normalizeWheelDeltaY,
  worldToDisplayRect,
} from './viewportUtils';
import { ErrorBoundary } from '../common';

interface MenuState {
  x: number;
  y: number;
  type: 'panel' | 'canvas';
  canvasId?: string;
}

interface DisplayPanelProps {
  layoutReady?: boolean;
  fixedWidth?: number;
  roundMaximizedCanvasTopLeft?: boolean;
  roundMaximizedCanvasBottomRight?: boolean;
  seamlessMaximizedCanvas?: boolean;
}

interface ViewportRectState {
  left: number;
  top: number;
  right: number;
  width: number;
  height: number;
}

const EMPTY_VIEWPORT_RECT: ViewportRectState = {
  left: 0,
  top: 0,
  right: 0,
  width: 0,
  height: 0,
};

const CANVAS_SCROLLBAR_INSET = 0;
const CANVAS_SCROLLBAR_MIN_THUMB_HEIGHT = 36;

function getEffectiveViewportRect(
  viewportRect: ViewportRectState,
  fixedWidth?: number,
): ViewportRectState {
  if (typeof fixedWidth !== 'number' || fixedWidth <= 0 || viewportRect.right === 0) {
    return viewportRect;
  }

  return {
    ...viewportRect,
    width: fixedWidth,
    left: viewportRect.right - fixedWidth,
  };
}

function isChannelReady(channel: Channel, link?: CanvasChannelLink): boolean {
  if (channel.type !== 'ble') {
    return channel.state === 'connected';
  }

  const bleTarget = link?.bleTarget;
  if (!bleTarget) {
    return false;
  }

  const bleState = useBleStore.getState();
  const channelState = bleState.getChannelState(channel.id);
  return channel.state === 'connected'
    && bleState.connectedChannelId === channel.id
    && channelState.subscribedCharacteristics.some(
      (item) => item.serviceUuid === bleTarget.serviceUuid && item.charUuid === bleTarget.charUuid
    );
}

export const DisplayPanel: React.FC<DisplayPanelProps> = ({
  layoutReady = true,
  fixedWidth,
  roundMaximizedCanvasTopLeft = false,
  roundMaximizedCanvasBottomRight = false,
  seamlessMaximizedCanvas = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fixedWidthRef = useRef(fixedWidth);
  fixedWidthRef.current = fixedWidth;
  const {
    canvases,
    addCanvas,
    removeCanvas,
    removeAllCanvases,
    activateCanvas,
    deactivateCanvas,
    syncCanvasChannelState,
    toggleMaximize,
    bringToFront,
    bringCanvasesToFront,
    setCanvasRect,
    setCanvasRects,
    groupCanvases,
    ungroupCanvases,
  } = useCanvasStore();
  const allChannels = useChannelStore((state) => state.channels);
  const activeChannelId = useChannelStore((state) => state.activeChannelId);
  const { openPort } = useSerial();
  const { connectTcp, startServer, bindUdp } = useTcp();
  const { reconnectLastDevice, subscribeNotifications } = useBle();
  const serialConfigs = useSerialStore((state) => state.channelConfigs);
  const tcpConfigs = useTcpStore((state) => state.channelConfigs);
  const { connectedChannelId, channelStates } = useBleStore();
  const canvasViewportResetVersion = useUIStore((state) => state.canvasViewportResetVersion);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editCanvasId, setEditCanvasId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [selectedCanvasIds, setSelectedCanvasIds] = useState<string[]>([]);
  const [viewportRect, setViewportRect] = useState<ViewportRectState>(EMPTY_VIEWPORT_RECT);
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [isDraggingScrollbar, setIsDraggingScrollbar] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerScrolling = useCallback(() => {
    setIsScrolling(true);
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
      scrollTimeoutRef.current = null;
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  const handleContainerMouseEnter = useCallback(() => setIsHovered(true), []);
  const handleContainerMouseMove = useCallback(() => setIsHovered(true), []);
  const handleContainerMouseLeave = useCallback(() => setIsHovered(false), []);

  const ignoreNextMoveEndRef = useRef<string | null>(null);
  const suppressNextPanelContextMenuRef = useRef(false);
  const primaryMouseDownCanvasIdRef = useRef<string | null>(null);
  const movingSelectionRef = useRef<{
    ids: string[];
    primaryId: string;
    originalRects: Record<string, CanvasRect>;
  } | null>(null);
  const previousCanvasActiveRef = useRef<Record<string, boolean>>({});

  const channelMap = useMemo(
    () => Object.fromEntries(allChannels.map((channel) => [channel.id, channel] as const)),
    [allChannels]
  );

  const {
    dragState,
    snapPreview,
    startCreating,
    startMoving,
    startResizing,
    updateDrag,
    endDrag,
    getCreationRect,
    getMoveDelta,
    getResizedRect,
    isDragging,
  } = useCanvasInteraction();
  const effectiveViewportRect = useMemo(
    () => getEffectiveViewportRect(viewportRect, fixedWidth),
    [fixedWidth, viewportRect],
  );
  const scrollBounds = useMemo(
    () => getCanvasScrollBounds(canvases, effectiveViewportRect.width, effectiveViewportRect.height),
    [canvases, effectiveViewportRect.height, effectiveViewportRect.width],
  );
  const scrollRangeX = scrollBounds.maxScrollX - scrollBounds.minScrollX;
  const scrollRangeY = scrollBounds.maxScrollY - scrollBounds.minScrollY;
  const viewportTransform = useMemo(
    () => buildViewportTransform(scrollX, scrollY),
    [scrollX, scrollY],
  );
  const toWorldRect = useCallback(
    (rect: CanvasRect) => displayToWorldRect(rect, viewportTransform),
    [viewportTransform],
  );
  const toDisplayRect = useCallback(
    (rect: CanvasRect) => worldToDisplayRect(rect, viewportTransform),
    [viewportTransform],
  );
  const getCanvasDisplayRect = useCallback(
    (canvas: StoredCanvas): CanvasRect => (
      canvas.maximized
        ? { x: 0, y: 0, width: effectiveViewportRect.width, height: effectiveViewportRect.height }
        : toDisplayRect(canvas.rect)
    ),
    [effectiveViewportRect.height, effectiveViewportRect.width, toDisplayRect],
  );
  const getCanvasSelectionIds = useCallback(
    (canvasId: string, sourceCanvases: StoredCanvas[] = canvases): string[] => {
      const canvas = sourceCanvases.find((item) => item.id === canvasId);
      if (!canvas) return [];
      if (!canvas.groupId) return [canvas.id];

      return sourceCanvases
        .filter((item) => item.groupId === canvas.groupId)
        .map((item) => item.id);
    },
    [canvases],
  );
  const normalizeCanvasSelection = useCallback(
    (ids: string[], sourceCanvases: StoredCanvas[] = canvases): string[] => {
      const existingIds = new Set(sourceCanvases.map((canvas) => canvas.id));
      const next = new Set<string>();

      for (const id of ids) {
        if (!existingIds.has(id)) continue;
        for (const selectionId of getCanvasSelectionIds(id, sourceCanvases)) {
          next.add(selectionId);
        }
      }

      return Array.from(next);
    },
    [canvases, getCanvasSelectionIds],
  );
  const selectedCanvasIdSet = useMemo(() => new Set(selectedCanvasIds), [selectedCanvasIds]);
  const getAttachTargetRects = useCallback(
    (excludedCanvasIds: string | string[]): CanvasRect[] => {
      const excludedIds = new Set(Array.isArray(excludedCanvasIds) ? excludedCanvasIds : [excludedCanvasIds]);
      return canvases
        .filter((canvas) => !excludedIds.has(canvas.id) && !canvas.maximized)
        .map(getCanvasDisplayRect);
    },
    [canvases, getCanvasDisplayRect],
  );
  const getMovingSelectionDelta = useCallback(() => {
    const movingSelection = movingSelectionRef.current;
    const delta = getMoveDelta();
    if (!movingSelection || !delta) return null;

    const primaryOriginalRect = movingSelection.originalRects[movingSelection.primaryId];
    if (!primaryOriginalRect) return null;

    const rawPrimaryRect = {
      ...primaryOriginalRect,
      x: primaryOriginalRect.x + delta.x,
      y: primaryOriginalRect.y + delta.y,
    };
    let nextPrimaryRect = rawPrimaryRect;
    let snapped = false;

    if (snapPreview.rect) {
      nextPrimaryRect = snapPreview.rect;
      snapped = true;
    } else {
      const edgeSnap = getCanvasEdgeAttachSnapRect(rawPrimaryRect, effectiveViewportRect.width, effectiveViewportRect.height);
      const attachSnap = getCanvasAttachSnapRect(edgeSnap.rect, getAttachTargetRects(movingSelection.ids));
      nextPrimaryRect = attachSnap.rect;
      snapped = edgeSnap.snapped || attachSnap.snapped;
    }

    let deltaX = nextPrimaryRect.x - primaryOriginalRect.x;
    let deltaY = nextPrimaryRect.y - primaryOriginalRect.y;

    // Keep every moving canvas inside the main window. Display coords may go
    // negative (the element slides under the center panel, which covers it),
    // but nothing may cross the window edges and become unreachable.
    let boxMinX = Infinity;
    let boxMinY = Infinity;
    let boxMaxX = -Infinity;
    let boxMaxY = -Infinity;
    for (const id of movingSelection.ids) {
      const rect = movingSelection.originalRects[id];
      if (!rect) continue;
      boxMinX = Math.min(boxMinX, rect.x);
      boxMinY = Math.min(boxMinY, rect.y);
      boxMaxX = Math.max(boxMaxX, rect.x + rect.width);
      boxMaxY = Math.max(boxMaxY, rect.y + rect.height);
    }
    if (Number.isFinite(boxMinX)) {
      deltaX = Math.max(deltaX, -scrollX - boxMinX);
      deltaY = Math.max(deltaY, -scrollY - boxMinY);
    }

    return {
      x: deltaX,
      y: deltaY,
      snapped,
    };
  }, [getMoveDelta, snapPreview.rect, getAttachTargetRects, scrollX, scrollY]);
  const getMovingSelectionDisplayRect = useCallback((canvasId: string): CanvasRect | null => {
    const movingSelection = movingSelectionRef.current;
    if (!movingSelection || !movingSelection.ids.includes(canvasId)) return null;

    const originalRect = movingSelection.originalRects[canvasId];
    const delta = getMovingSelectionDelta();
    if (!originalRect || !delta) return null;

    return {
      ...originalRect,
      x: originalRect.x + delta.x,
      y: originalRect.y + delta.y,
    };
  }, [getMovingSelectionDelta]);
  /** Resized rect with its edges clamped to the main-window bounds and snapped to attached canvases. */
  const getWindowClampedResizedRect = useCallback((): CanvasAttachSnap | null => {
    const rawRect = getResizedRect();
    if (!rawRect) return null;

    const originalRect = dragState.originalRect;
    const resizeEdge = dragState.resizeEdge;
    const canvasId = dragState.canvasId;

    let targetRect = rawRect;
    let snapped = false;

    if (originalRect && resizeEdge && canvasId) {
      const attachTargets = getAttachTargetRects(canvasId);
      const resizeSnap = getCanvasResizeAttachSnapRect(
        rawRect,
        originalRect,
        resizeEdge,
        attachTargets,
      );
      targetRect = resizeSnap.rect;
      snapped = resizeSnap.snapped;
    }

    const left = Math.max(targetRect.x, -scrollX);
    const top = Math.max(targetRect.y, -scrollY);
    const width = Math.max(targetRect.width, 1);
    const height = Math.max(targetRect.height, 1);

    return {
      rect: {
        x: left,
        y: top,
        width,
        height,
      },
      snapped,
    };
  }, [dragState.canvasId, dragState.originalRect, dragState.resizeEdge, scrollX, scrollY, getAttachTargetRects, getResizedRect]);

  const verticalScrollbarMetrics = useMemo(() => {
    const bottomInset = scrollRangeX > 0 ? CANVAS_SCROLLBAR_INSET + 6 : CANVAS_SCROLLBAR_INSET;
    const trackHeight = Math.max(0, effectiveViewportRect.height - CANVAS_SCROLLBAR_INSET - bottomInset);
    if (scrollRangeY <= 0 || trackHeight <= 0) {
      return null;
    }

    const contentHeight = effectiveViewportRect.height + scrollRangeY;
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(CANVAS_SCROLLBAR_MIN_THUMB_HEIGHT, Math.round(trackHeight * (effectiveViewportRect.height / contentHeight))),
    );
    const thumbTravel = Math.max(0, trackHeight - thumbHeight);
    const progress = (scrollY - scrollBounds.minScrollY) / scrollRangeY;

    return {
      trackHeight,
      thumbHeight,
      thumbTop: CANVAS_SCROLLBAR_INSET + Math.round(thumbTravel * progress),
      thumbTravel,
    };
  }, [effectiveViewportRect.height, scrollBounds.minScrollY, scrollRangeX, scrollRangeY, scrollY]);

  const horizontalScrollbarMetrics = useMemo(() => {
    const rightInset = scrollRangeY > 0 ? CANVAS_SCROLLBAR_INSET + 6 : CANVAS_SCROLLBAR_INSET;
    const trackWidth = Math.max(0, effectiveViewportRect.width - CANVAS_SCROLLBAR_INSET - rightInset);
    if (scrollRangeX <= 0 || trackWidth <= 0) {
      return null;
    }

    const contentWidth = effectiveViewportRect.width + scrollRangeX;
    const thumbWidth = Math.min(
      trackWidth,
      Math.max(CANVAS_SCROLLBAR_MIN_THUMB_HEIGHT, Math.round(trackWidth * (effectiveViewportRect.width / contentWidth))),
    );
    const thumbTravel = Math.max(0, trackWidth - thumbWidth);
    const progress = (scrollX - scrollBounds.minScrollX) / scrollRangeX;

    return {
      trackWidth,
      thumbWidth,
      thumbLeft: CANVAS_SCROLLBAR_INSET + Math.round(thumbTravel * progress),
      thumbTravel,
    };
  }, [effectiveViewportRect.width, scrollBounds.minScrollX, scrollRangeX, scrollRangeY, scrollX]);

  const syncViewportRect = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const nextRect = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    };

    setViewportRect((current) => (
      current.left === nextRect.left
      && current.top === nextRect.top
      && current.right === nextRect.right
      && current.width === nextRect.width
      && current.height === nextRect.height
        ? current
        : nextRect
    ));
  }, []);

  useLayoutEffect(() => {
    if (!layoutReady) {
      setViewportRect(EMPTY_VIEWPORT_RECT);
      setScrollY(0);
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    let observer: ResizeObserver | null = null;

    const animationFrame = window.requestAnimationFrame(() => {
      syncViewportRect();
      observer = new ResizeObserver(() => syncViewportRect());
      observer.observe(container);
    });

    const handleWindowResize = () => {
      syncViewportRect();
    };

    window.addEventListener('resize', handleWindowResize);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', handleWindowResize);
      observer?.disconnect();
    };
  }, [layoutReady, syncViewportRect]);

  // Center-panel visibility changes resize the right panel in the same commit.
  // Measure that new geometry before paint instead of waiting for ResizeObserver,
  // otherwise canvases briefly render against the previous viewport position.
  useLayoutEffect(() => {
    if (!layoutReady) return;
    syncViewportRect();
  }, [fixedWidth, layoutReady, syncViewportRect]);

  // Loading/resetting a saved layout resets the scroll offset.
  useLayoutEffect(() => {
    if (!layoutReady) return;
    setScrollX(0);
    setScrollY(0);
    syncViewportRect();
  }, [canvasViewportResetVersion, layoutReady, syncViewportRect]);

  useEffect(() => {
    if (
      primaryMouseDownCanvasIdRef.current !== null
      && selectedCanvasIdSet.has(primaryMouseDownCanvasIdRef.current)
    ) {
      return;
    }

    setScrollX((current) => clampScrollX(current, scrollBounds));
    setScrollY((current) => clampScrollY(current, scrollBounds));
  }, [scrollBounds, selectedCanvasIdSet]);

  useEffect(() => {
    if (dragState.mode === 'idle') return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      updateDrag(e, rect);
    };

    const handleMouseUp = () => {
      const container = containerRef.current;
      if (!container) {
        endDrag();
        movingSelectionRef.current = null;
        return;
      }

      if (dragState.mode === 'creating-left' || dragState.mode === 'creating-right') {
        const creationRect = getCreationRect();
        if (creationRect && creationRect.width > 20 && creationRect.height > 20) {
          const id = addCanvas(toWorldRect(creationRect));
          if (dragState.mode === 'creating-right') {
            suppressNextPanelContextMenuRef.current = true;
            setEditCanvasId(id);
            setEditOpen(true);
          }
        }
      } else if (dragState.mode === 'moving' && dragState.canvasId) {
        if (isDragging()) {
          if (ignoreNextMoveEndRef.current === dragState.canvasId) {
            ignoreNextMoveEndRef.current = null;
          } else {
            const movingSelection = movingSelectionRef.current;
            const movingDelta = getMovingSelectionDelta();
            if (movingSelection && movingDelta) {
              const nextRects: Record<string, CanvasRect> = {};
              for (const id of movingSelection.ids) {
                const originalRect = movingSelection.originalRects[id];
                if (!originalRect) continue;
                nextRects[id] = toWorldRect({
                  ...originalRect,
                  x: originalRect.x + movingDelta.x,
                  y: originalRect.y + movingDelta.y,
                });
              }
              setCanvasRects(nextRects, movingDelta.snapped);
            }
          }
        }
      } else if (dragState.mode === 'resizing' && dragState.canvasId) {
        const resizedResult = getWindowClampedResizedRect();
        if (resizedResult) {
          setCanvasRect(dragState.canvasId, toWorldRect(resizedResult.rect), resizedResult.snapped);
        }
      }

      endDrag();
      movingSelectionRef.current = null;
      const suppressCtx = (e: Event) => { e.preventDefault(); };
      document.addEventListener('contextmenu', suppressCtx, { once: true });
      setTimeout(() => document.removeEventListener('contextmenu', suppressCtx), 100);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState.mode, dragState.canvasId, addCanvas, endDrag, getCreationRect, getMovingSelectionDelta, getWindowClampedResizedRect, isDragging, setCanvasRect, setCanvasRects, toWorldRect, updateDrag]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Delete' && selectedCanvasIds.length > 0) {
        selectedCanvasIds.forEach((id) => removeCanvas(id));
        setSelectedCanvasIds([]);
        return;
      }

      if (selectedCanvasIds.length === 0) return;

      const step = e.shiftKey ? 10 : 1;
      const delta = { x: 0, y: 0 };
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          delta.y = -step;
          break;
        case 'ArrowDown':
          e.preventDefault();
          delta.y = step;
          break;
        case 'ArrowLeft':
          e.preventDefault();
          delta.x = -step;
          break;
        case 'ArrowRight':
          e.preventDefault();
          delta.x = step;
          break;
        default:
          return;
      }

      let clampedDeltaX = delta.x;
      let clampedDeltaY = delta.y;

      let boxMinX = Infinity;
      let boxMinY = Infinity;
      for (const canvas of canvases) {
        if (!selectedCanvasIdSet.has(canvas.id) || canvas.maximized) continue;
        boxMinX = Math.min(boxMinX, canvas.rect.x);
        boxMinY = Math.min(boxMinY, canvas.rect.y);
      }

      if (Number.isFinite(boxMinX)) {
        clampedDeltaX = Math.max(delta.x, -boxMinX);
      }
      if (Number.isFinite(boxMinY)) {
        clampedDeltaY = Math.max(delta.y, -boxMinY);
      }

      if (clampedDeltaX === 0 && clampedDeltaY === 0) return;

      const nextRects: Record<string, CanvasRect> = {};
      for (const canvas of canvases) {
        if (!selectedCanvasIdSet.has(canvas.id) || canvas.maximized) continue;
        nextRects[canvas.id] = {
          ...canvas.rect,
          x: canvas.rect.x + clampedDeltaX,
          y: canvas.rect.y + clampedDeltaY,
        };
      }

      setCanvasRects(nextRects);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedCanvasIds, selectedCanvasIdSet, removeCanvas, canvases, setCanvasRects]);

  useEffect(() => {
    const clearPrimaryMouseDownCanvas = () => {
      primaryMouseDownCanvasIdRef.current = null;
    };

    document.addEventListener('mouseup', clearPrimaryMouseDownCanvas);
    window.addEventListener('blur', clearPrimaryMouseDownCanvas);
    return () => {
      document.removeEventListener('mouseup', clearPrimaryMouseDownCanvas);
      window.removeEventListener('blur', clearPrimaryMouseDownCanvas);
    };
  }, []);

  const handlePanelContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (editOpen) return;
    if (suppressNextPanelContextMenuRef.current) {
      suppressNextPanelContextMenuRef.current = false;
      return;
    }
    if (isDragging()) return;
    if ((e.target as HTMLElement).closest('[data-canvas-scrollbar]')) return;
    if ((e.target as HTMLElement).closest('[data-canvas-id]')) return;
    setMenu({ x: e.clientX, y: e.clientY, type: 'panel' });
  }, [editOpen, isDragging]);

  const handlePanelMouseDown = useCallback((e: React.MouseEvent) => {
    if (editOpen) return;
    if ((e.target as HTMLElement).closest('[data-canvas-scrollbar]')) return;
    if ((e.target as HTMLElement).closest('[data-canvas-id]')) return;
    primaryMouseDownCanvasIdRef.current = null;
    setSelectedCanvasIds([]);

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (e.button === 0) {
      startCreating(e, rect, 'left');
    } else if (e.button === 2) {
      startCreating(e, rect, 'right');
    }
  }, [editOpen, startCreating]);

  const handleCanvasMouseDownMove = useCallback((e: React.MouseEvent, canvasId: string) => {
    const targetSelectionIds = getCanvasSelectionIds(canvasId);
    const targetAlreadySelected = targetSelectionIds.some((id) => selectedCanvasIdSet.has(id));
    const nextSelectedIds = e.ctrlKey && selectedCanvasIds.length > 0 && !targetAlreadySelected
      ? normalizeCanvasSelection([...selectedCanvasIds, ...targetSelectionIds])
      : normalizeCanvasSelection(targetAlreadySelected ? selectedCanvasIds : targetSelectionIds);

    setSelectedCanvasIds(nextSelectedIds);
    bringCanvasesToFront(nextSelectedIds);
    const canvas = canvases.find((c) => c.id === canvasId);
    if (!canvas || canvas.maximized) return;

    const movableIds = nextSelectedIds.filter((id) => {
      const selectedCanvas = canvases.find((item) => item.id === id);
      return selectedCanvas && !selectedCanvas.maximized;
    });
    const originalRects: Record<string, CanvasRect> = {};
    for (const id of movableIds) {
      const selectedCanvas = canvases.find((item) => item.id === id);
      if (!selectedCanvas) continue;
      originalRects[id] = getCanvasDisplayRect(selectedCanvas);
    }

    movingSelectionRef.current = {
      ids: movableIds,
      primaryId: canvasId,
      originalRects,
    };
    startMoving(e, canvasId, getCanvasDisplayRect(canvas));
  }, [bringCanvasesToFront, canvases, getCanvasDisplayRect, getCanvasSelectionIds, normalizeCanvasSelection, selectedCanvasIds, selectedCanvasIdSet, startMoving]);

  const handleCanvasResizeStart = useCallback((e: React.MouseEvent, canvasId: string, edge: ResizeEdge) => {
    bringToFront(canvasId);
    setSelectedCanvasIds(getCanvasSelectionIds(canvasId));
    const canvas = canvases.find((c) => c.id === canvasId);
    if (!canvas || canvas.maximized) return;
    startResizing(e, canvasId, getCanvasDisplayRect(canvas), edge);
  }, [bringToFront, canvases, getCanvasDisplayRect, getCanvasSelectionIds, startResizing]);

  const handleCanvasContextMenu = useCallback((e: React.MouseEvent, canvasId: string) => {
    const targetSelectionIds = getCanvasSelectionIds(canvasId);
    const targetAlreadySelected = targetSelectionIds.some((id) => selectedCanvasIdSet.has(id));
    setSelectedCanvasIds(targetAlreadySelected ? selectedCanvasIds : targetSelectionIds);
    setMenu({ x: e.clientX, y: e.clientY, type: 'canvas', canvasId });
  }, [getCanvasSelectionIds, selectedCanvasIds, selectedCanvasIdSet]);

  const handleCanvasDoubleClickRight = useCallback((canvasId: string) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    toggleMaximize(canvasId, toWorldRect({ x: 0, y: 0, width: rect.width, height: rect.height }));
  }, [toWorldRect, toggleMaximize]);

  const handleCanvasDoubleClickLeft = useCallback((canvasId: string) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    toggleMaximize(canvasId, toWorldRect({ x: 0, y: 0, width: rect.width, height: rect.height }));
    ignoreNextMoveEndRef.current = canvasId;
  }, [toWorldRect, toggleMaximize]);

  const handleCanvasSelect = useCallback((canvasId: string) => {
    const nextSelectedIds = getCanvasSelectionIds(canvasId);
    bringCanvasesToFront(nextSelectedIds);
    setSelectedCanvasIds(nextSelectedIds);
  }, [bringCanvasesToFront, getCanvasSelectionIds]);
  const handleCanvasPrimaryMouseDown = useCallback((canvasId: string) => {
    primaryMouseDownCanvasIdRef.current = canvasId;
  }, []);

  const handleAddCanvasFull = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const fullRect: CanvasRect = toWorldRect({ x: 0, y: 0, width: rect.width, height: rect.height });
    const id = addCanvas(fullRect);
    setEditCanvasId(id);
    setEditOpen(true);
  }, [addCanvas, toWorldRect]);

  const handleRemoveAllCanvases = useCallback(() => {
    removeAllCanvases();
    setSelectedCanvasIds([]);
    setEditCanvasId(null);
    setEditOpen(false);
  }, [removeAllCanvases]);

  const ensureCanvasChannelReady = useCallback(async (canvasId: string) => {
    const canvas = useCanvasStore.getState().canvases.find((item) => item.id === canvasId);
    if (!canvas) return false;

    if (canvas.config.channels.length === 0) {
      activateCanvas(canvasId);
      return true;
    }

    const primaryLink = canvas.config.channels.find((link) => link.channelId === activeChannelId)
      ?? canvas.config.channels[0];
    const channel = channelMap[primaryLink.channelId];
    if (!channel) {
      toast.error('Linked channel not found');
      return false;
    }

    try {
      if (channel.type === 'serial') {
        if (!isChannelReady(channel)) {
          const config = serialConfigs[channel.id];
          if (!config?.path) {
            toast.error('UART channel has no saved config to reopen');
            return false;
          }
          await openPort(config, channel.id);
        }
        activateCanvas(canvasId);
        return true;
      }

      if (channel.type === 'tcp') {
        if (!isChannelReady(channel)) {
          const config = tcpConfigs[channel.id];
          if (!config) {
            toast.error('TCP/IP channel has no saved config to reopen');
            return false;
          }
          if (config.mode === 'client') {
            await connectTcp(config.clientAddress, channel.id);
          } else if (config.mode === 'server') {
            await startServer(config.serverAddress, channel.id);
          } else {
            await bindUdp(config.udpBindAddress, channel.id);
          }
        }
        activateCanvas(canvasId);
        return true;
      }

      const bleTarget = primaryLink.bleTarget;
      if (!bleTarget) {
        toast.error('BLE canvas is missing a subscribed characteristic target');
        return false;
      }

      const bleState = useBleStore.getState();
      let deviceId = bleState.connectedChannelId === channel.id ? bleState.connectedDeviceId : null;
      if (!deviceId) {
        deviceId = await reconnectLastDevice(channel.id);
      }

      if (!deviceId) {
        toast.error('BLE reconnect failed');
        return false;
      }

      const channelSubscriptions = useBleStore.getState().getChannelState(channel.id).subscribedCharacteristics;
      const alreadySubscribed = channelSubscriptions.some(
        (item) => item.serviceUuid === bleTarget.serviceUuid && item.charUuid === bleTarget.charUuid
      );
      if (!alreadySubscribed) {
        await subscribeNotifications(deviceId, bleTarget.serviceUuid, bleTarget.charUuid);
        useBleStore.getState().addSubscription(bleTarget.serviceUuid, bleTarget.charUuid, channel.id);
      }

      activateCanvas(canvasId);
      return true;
    } catch (error) {
      toast.error(String(error));
      return false;
    }
  }, [activateCanvas, activeChannelId, bindUdp, channelMap, connectTcp, openPort, reconnectLastDevice, serialConfigs, startServer, subscribeNotifications, tcpConfigs]);

  const getCanvasActionIds = useCallback((canvasId: string): string[] => {
    const targetSelectionIds = getCanvasSelectionIds(canvasId);
    const targetAlreadySelected = targetSelectionIds.some((id) => selectedCanvasIdSet.has(id));
    return targetAlreadySelected && selectedCanvasIds.length > 0
      ? normalizeCanvasSelection(selectedCanvasIds)
      : targetSelectionIds;
  }, [getCanvasSelectionIds, normalizeCanvasSelection, selectedCanvasIds, selectedCanvasIdSet]);

  const handleCanvasActivationToggle = useCallback(async (canvasIds: string[]) => {
    const targets = normalizeCanvasSelection(canvasIds);
    if (targets.length === 0) return;

    const currentCanvases = useCanvasStore.getState().canvases.filter((item) => targets.includes(item.id));
    if (currentCanvases.length === 0) return;

    if (currentCanvases.every((canvas) => canvas.active)) {
      currentCanvases.forEach((canvas) => deactivateCanvas(canvas.id, 'manual'));
      return;
    }

    for (const canvas of currentCanvases) {
      if (canvas.active) continue;
      await ensureCanvasChannelReady(canvas.id);
    }
  }, [deactivateCanvas, ensureCanvasChannelReady, normalizeCanvasSelection]);

  const handleToggleCanvasGrouping = useCallback((ids: string[], shouldUngroup: boolean) => {
    const normalizedIds = normalizeCanvasSelection(ids);
    if (shouldUngroup) {
      if (normalizedIds.length === 0) return;
      ungroupCanvases(normalizedIds);
    } else {
      if (normalizedIds.length < 2) return;
      groupCanvases(normalizedIds);
    }
    setSelectedCanvasIds(normalizedIds);
  }, [groupCanvases, normalizeCanvasSelection, ungroupCanvases]);

  const handleDeleteSelectedCanvases = useCallback((ids: string[]) => {
    const normalizedIds = normalizeCanvasSelection(ids);
    normalizedIds.forEach((id) => removeCanvas(id));
    setSelectedCanvasIds([]);
  }, [normalizeCanvasSelection, removeCanvas]);

  const closeMenu = useCallback(() => setMenu(null), []);
  const creationRect = (dragState.mode === 'creating-left' || dragState.mode === 'creating-right') ? getCreationRect() : null;
  const setScrollYFromScrollbar = useCallback((clientY: number, trackRect: DOMRect, thumbOffsetY: number) => {
    if (!verticalScrollbarMetrics || scrollRangeY <= 0) return;

    const localY = clientY - trackRect.top - thumbOffsetY;
    const progress = verticalScrollbarMetrics.thumbTravel <= 0
      ? 0
      : Math.min(Math.max(localY / verticalScrollbarMetrics.thumbTravel, 0), 1);
    setScrollY(scrollBounds.minScrollY + progress * scrollRangeY);
  }, [scrollBounds.minScrollY, scrollRangeY, verticalScrollbarMetrics]);

  const handleVerticalScrollbarPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!verticalScrollbarMetrics || scrollRangeY <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    const track = event.currentTarget;
    const trackRect = track.getBoundingClientRect();
    const thumb = (event.target as HTMLElement).closest('[data-canvas-scrollbar-thumb]') as HTMLElement | null;
    const thumbOffsetY = thumb
      ? event.clientY - thumb.getBoundingClientRect().top
      : verticalScrollbarMetrics.thumbHeight / 2;
    setScrollYFromScrollbar(event.clientY, trackRect, thumbOffsetY);

    setIsDraggingScrollbar(true);
    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setScrollYFromScrollbar(moveEvent.clientY, trackRect, thumbOffsetY);
    };
    const handlePointerUp = () => {
      setIsDraggingScrollbar(false);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp, { once: true });
  }, [scrollRangeY, verticalScrollbarMetrics, setScrollYFromScrollbar]);

  const setScrollXFromScrollbar = useCallback((clientX: number, trackRect: DOMRect, thumbOffsetX: number) => {
    if (!horizontalScrollbarMetrics || scrollRangeX <= 0) return;

    const localX = clientX - trackRect.left - thumbOffsetX;
    const progress = horizontalScrollbarMetrics.thumbTravel <= 0
      ? 0
      : Math.min(Math.max(localX / horizontalScrollbarMetrics.thumbTravel, 0), 1);
    setScrollX(scrollBounds.minScrollX + progress * scrollRangeX);
  }, [scrollBounds.minScrollX, scrollRangeX, horizontalScrollbarMetrics]);

  const handleHorizontalScrollbarPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!horizontalScrollbarMetrics || scrollRangeX <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    const track = event.currentTarget;
    const trackRect = track.getBoundingClientRect();
    const thumb = (event.target as HTMLElement).closest('[data-canvas-horizontal-scrollbar-thumb]') as HTMLElement | null;
    const thumbOffsetX = thumb
      ? event.clientX - thumb.getBoundingClientRect().left
      : horizontalScrollbarMetrics.thumbWidth / 2;
    setScrollXFromScrollbar(event.clientX, trackRect, thumbOffsetX);

    setIsDraggingScrollbar(true);
    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setScrollXFromScrollbar(moveEvent.clientX, trackRect, thumbOffsetX);
    };
    const handlePointerUp = () => {
      setIsDraggingScrollbar(false);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp, { once: true });
  }, [scrollRangeX, horizontalScrollbarMetrics, setScrollXFromScrollbar]);

  const handlePanelWheelCapture = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    triggerScrolling();
    const target = e.target as HTMLElement;
    const canvasTarget = target.closest('[data-canvas-id]') as HTMLElement | null;
    const hoveredCanvasId = canvasTarget?.dataset.canvasId ?? null;

    const isHorizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (isHorizontal) {
      const rawDeltaX = e.shiftKey ? e.deltaY : e.deltaX;
      const viewportWidth = effectiveViewportRect.width || containerRef.current?.clientWidth || 0;
      const deltaX = normalizeWheelDeltaX(rawDeltaX, e.deltaMode, viewportWidth);
      if (deltaX === 0) return;

      if (scrollRangeX > 0) {
        e.preventDefault();
        e.stopPropagation();
        setScrollX((current) => clampScrollX(current + deltaX, scrollBounds));
      }
      return;
    }

    const viewportHeight = effectiveViewportRect.height || containerRef.current?.clientHeight || 0;
    const deltaY = normalizeWheelDeltaY(e.deltaY, e.deltaMode, viewportHeight);

    if (deltaY === 0) {
      return;
    }

    if (
      e.ctrlKey
      && selectedCanvasIds.length > 0
      && primaryMouseDownCanvasIdRef.current !== null
      && selectedCanvasIdSet.has(primaryMouseDownCanvasIdRef.current)
    ) {
      e.preventDefault();
      e.stopPropagation();

      if (hoveredCanvasId && !selectedCanvasIdSet.has(hoveredCanvasId)) {
        return;
      }

      const nextRects: Record<string, CanvasRect> = {};
      for (const canvas of useCanvasStore.getState().canvases) {
        if (!selectedCanvasIdSet.has(canvas.id) || canvas.maximized) continue;
        nextRects[canvas.id] = {
          ...canvas.rect,
          y: Math.max(0, canvas.rect.y + deltaY),
        };
      }

      endDrag();
      setScrollY((current) => current + deltaY);
      setCanvasRects(nextRects);
      return;
    }

    if (scrollRangeY > 0) {
      e.preventDefault();
      e.stopPropagation();
      setScrollY((current) => clampScrollY(current + deltaY, scrollBounds));
    }
  }, [effectiveViewportRect.height, effectiveViewportRect.width, endDrag, scrollBounds, scrollRangeX, scrollRangeY, selectedCanvasIds.length, selectedCanvasIdSet, setCanvasRects, triggerScrolling]);

  useEffect(() => {
    for (const canvas of canvases) {
      const linkedChannels = canvas.config.channels
        .map((link) => channelMap[link.channelId])
        .filter((channel): channel is Channel => !!channel);

      if (linkedChannels.length === 0) continue;

      const selectedLinkedChannel = linkedChannels.find((channel) => channel.id === activeChannelId)
        ?? linkedChannels[0];
      const selectedLink = canvas.config.channels.find((link) => link.channelId === selectedLinkedChannel.id)
        ?? canvas.config.channels[0];
      syncCanvasChannelState(canvas.id, isChannelReady(selectedLinkedChannel, selectedLink));
    }
  }, [activeChannelId, canvases, channelMap, connectedChannelId, channelStates, syncCanvasChannelState]);

  useEffect(() => {
    const previous = previousCanvasActiveRef.current;
    const next: Record<string, boolean> = {};

    for (const canvas of canvases) {
      next[canvas.id] = canvas.active;
      const previousActive = previous[canvas.id];
      if (previousActive === undefined || previousActive === canvas.active) continue;
      if (canvas.config.type !== 'table' && canvas.config.type !== 'chart' && canvas.config.type !== 'form') continue;

      const hook = canvas.active ? 'activate' : 'deactivate';
      void runCanvasLifecycleHook(canvas, hook).catch((error) => {
        console.error(`Canvas lifecycle ${hook} failed:`, error);
        toast.error(`Canvas lifecycle ${hook} failed: ${String(error)}`);
      });
    }

    previousCanvasActiveRef.current = next;
  }, [canvases]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-surface overflow-hidden select-none"
      onMouseEnter={handleContainerMouseEnter}
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={handleContainerMouseLeave}
      onMouseDown={handlePanelMouseDown}
      onWheelCapture={handlePanelWheelCapture}
      onContextMenu={handlePanelContextMenu}
    >
      {canvases.length === 0 && dragState.mode === 'idle' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-text-faint text-xs">Right-click to add a canvas</p>
        </div>
      )}

      {canvases.map((canvas) => {
        const movingRect = getMovingSelectionDisplayRect(canvas.id);
        const isBeingMoved = dragState.mode === 'moving' && movingRect !== null;
        const isBeingResized = dragState.mode === 'resizing' && dragState.canvasId === canvas.id;
        const resizedResult = isBeingResized ? getWindowClampedResizedRect() : null;
        const liveRect = isBeingMoved ? movingRect : resizedResult ? resizedResult.rect : null;
        const displayCanvas = { ...canvas, rect: liveRect ?? getCanvasDisplayRect(canvas) };

        return (
          <div key={canvas.id} data-canvas-id={canvas.id}>
            <ErrorBoundary label={`Canvas: ${canvas.name}`} inline>
              <CanvasContainer
                canvas={displayCanvas}
                isMoving={isBeingMoved || isBeingResized}
                isSelected={selectedCanvasIdSet.has(canvas.id)}
                onMouseDownMove={handleCanvasMouseDownMove}
                onResizeStart={handleCanvasResizeStart}
                onContextMenu={handleCanvasContextMenu}
                onDoubleClickRight={handleCanvasDoubleClickRight}
                onDoubleClickLeft={handleCanvasDoubleClickLeft}
                onSelect={handleCanvasSelect}
                onPrimaryMouseDown={handleCanvasPrimaryMouseDown}
                roundMaximizedTopLeft={roundMaximizedCanvasTopLeft}
                roundMaximizedBottomRight={roundMaximizedCanvasBottomRight}
                seamlessMaximized={seamlessMaximizedCanvas}
              >
                {canvas.config.type === 'table' ? (
                  <CanvasTable canvasId={canvas.id} />
                ) : canvas.config.type === 'form' ? (
                  <CanvasForm canvasId={canvas.id} liveWidth={displayCanvas.rect.width} />
                ) : canvas.config.type === 'script' ? (
                  <CanvasScript canvasId={canvas.id} />
                ) : (
                  <Suspense fallback={<div className="p-3 text-text-muted">Loading chart…</div>}><CanvasChart canvasId={canvas.id} isMoving={isBeingMoved || isBeingResized} /></Suspense>
                )}
              </CanvasContainer>
            </ErrorBoundary>
          </div>
        );
      })}

      {creationRect && (
        <div
          className="absolute border-2 border-dashed border-accent-mauve/40 bg-accent-mauve/5 rounded-sm pointer-events-none"
          style={{
            zIndex: 2147483630,
            left: creationRect.x,
            top: creationRect.y,
            width: creationRect.width,
            height: creationRect.height,
          }}
        />
      )}

      {snapPreview.rect && dragState.mode === 'moving' && (() => {
        const draggedCanvas = canvases.find((c) => c.id === dragState.canvasId);
        const highContrast = document.documentElement.classList.contains('high-contrast')
          || document.documentElement.classList.contains('high-contrast-light');
        const snapColor = computeCanvasBorderColor(draggedCanvas?.config.channels || [], allChannels);
        const snapBg = snapColor.replace('rgb', 'rgba').replace(')', ', 0.1)');
        const snapBorder = snapColor.replace('rgb', 'rgba').replace(')', `, ${highContrast ? 0.9 : 0.3})`);
        return (
          <div
            className="absolute border-2 rounded-sm pointer-events-none transition-all duration-100"
            style={{
              zIndex: 2147483630,
              left: snapPreview.rect.x,
              top: snapPreview.rect.y,
              width: snapPreview.rect.width,
              height: snapPreview.rect.height,
              backgroundColor: snapBg,
              borderColor: snapBorder,
            }}
          />
        );
      })()}

      {verticalScrollbarMetrics && (() => {
        const isScrollbarVisible = isHovered || isScrolling || isDraggingScrollbar || dragState.mode !== 'idle';
        const bottomOffset = horizontalScrollbarMetrics ? 6 : 0;
        return (
          <div
            data-canvas-scrollbar
            className={`absolute right-0 top-0 w-1.5 hover:w-2 cursor-pointer bg-[var(--layer-hover)]/90 shadow-sm border-l border-border/30 backdrop-blur-xs before:absolute before:-left-2 before:right-0 before:inset-y-0 before:content-[''] transition-all duration-150 ${
              isScrollbarVisible
                ? 'opacity-85 hover:opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
            }`}
            style={{
              zIndex: CANVAS_SCROLLBAR_Z_INDEX,
              bottom: bottomOffset,
            }}
            role="scrollbar"
            aria-orientation="vertical"
            aria-valuemin={scrollBounds.minScrollY}
            aria-valuemax={scrollBounds.maxScrollY}
            aria-valuenow={scrollY}
            onPointerDown={handleVerticalScrollbarPointerDown}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            <div
              data-canvas-scrollbar-thumb
              className="absolute left-0 right-0 rounded-full bg-slate-500/50 hover:bg-slate-600/80 dark:bg-slate-300/50 dark:hover:bg-slate-100/90 shadow-xs transition-colors"
              style={{
                top: verticalScrollbarMetrics.thumbTop,
                height: verticalScrollbarMetrics.thumbHeight,
              }}
            />
          </div>
        );
      })()}

      {horizontalScrollbarMetrics && (() => {
        const isScrollbarVisible = isHovered || isScrolling || isDraggingScrollbar || dragState.mode !== 'idle';
        const rightOffset = verticalScrollbarMetrics ? 6 : 0;
        return (
          <div
            data-canvas-horizontal-scrollbar
            className={`absolute bottom-0 left-0 h-1.5 hover:h-2 cursor-pointer bg-[var(--layer-hover)]/90 shadow-sm border-t border-border/30 backdrop-blur-xs before:absolute before:-top-2 before:bottom-0 before:inset-x-0 before:content-[''] transition-all duration-150 ${
              isScrollbarVisible
                ? 'opacity-85 hover:opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
            }`}
            style={{
              zIndex: CANVAS_SCROLLBAR_Z_INDEX,
              right: rightOffset,
            }}
            role="scrollbar"
            aria-orientation="horizontal"
            aria-valuemin={scrollBounds.minScrollX}
            aria-valuemax={scrollBounds.maxScrollX}
            aria-valuenow={scrollX}
            onPointerDown={handleHorizontalScrollbarPointerDown}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            <div
              data-canvas-horizontal-scrollbar-thumb
              className="absolute top-0 bottom-0 rounded-full bg-slate-500/50 hover:bg-slate-600/80 dark:bg-slate-300/50 dark:hover:bg-slate-100/90 shadow-xs transition-colors"
              style={{
                left: horizontalScrollbarMetrics.thumbLeft,
                width: horizontalScrollbarMetrics.thumbWidth,
              }}
            />
          </div>
        );
      })()}

      {menu && menu.type === 'panel' && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          options={[
            { label: 'Add Canvas', onClick: handleAddCanvasFull },
            {
              label: 'Delete All Canvases',
              danger: true,
              disabled: canvases.length === 0,
              onClick: handleRemoveAllCanvases,
            },
          ]}
        />
      )}

      {menu && menu.type === 'canvas' && menu.canvasId && (() => {
        const actionIds = getCanvasActionIds(menu.canvasId);
        const actionCanvases = canvases.filter((canvas) => actionIds.includes(canvas.id));
        const actionGroupIds = new Set(actionCanvases.map((canvas) => canvas.groupId).filter((groupId): groupId is string => !!groupId));
        const allActive = actionCanvases.length > 0 && actionCanvases.every((canvas) => canvas.active);
        const allInOneGroup = actionCanvases.length > 1 && actionGroupIds.size === 1 && actionCanvases.every((canvas) => canvas.groupId);
        const groupMenuLabel = allInOneGroup ? 'Ungroup' : 'Group Selected';

        return (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            onClose={closeMenu}
            options={[
              {
                label: allActive ? 'Deactivate' : 'Activate',
                onClick: () => { void handleCanvasActivationToggle(actionIds); },
              },
              {
                label: groupMenuLabel,
                disabled: !allInOneGroup && actionIds.length < 2,
                onClick: () => handleToggleCanvasGrouping(actionIds, allInOneGroup),
              },
              {
                label: 'Edit',
                onClick: () => { setEditCanvasId(menu.canvasId!); setEditOpen(true); },
              },
              {
                label: actionIds.length > 1 ? `Delete Selected (${actionIds.length})` : 'Delete',
                danger: true,
                onClick: () => handleDeleteSelectedCanvases(actionIds),
              },
            ]}
          />
        );
      })()}

      {editOpen && <ErrorBoundary label="CanvasEditDialog" inline><Suspense fallback={null}>
        <CanvasEditDialog
          open={editOpen}
          canvasId={editCanvasId}
          onClose={() => { setEditOpen(false); setEditCanvasId(null); }}
        />
      </Suspense></ErrorBoundary>}
    </div>
  );
};
