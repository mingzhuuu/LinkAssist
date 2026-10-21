import { useRef, useCallback, useState } from 'react';
import { CanvasRect } from '../../types';

/** Minimum drag distance to distinguish drag from click */
const DRAG_THRESHOLD = 6;
/** Snap only engages when the pointer is pressed fully against a main-window
 *  edge (≤1px), never on mere proximity. */
const EDGE_SNAP_THRESHOLD = 1;

const clampValue = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export type InteractionMode = 'idle' | 'creating-left' | 'creating-right' | 'moving' | 'resizing';

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface DragState {
  mode: InteractionMode;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  /** Canvas id being moved/resized */
  canvasId: string | null;
  /** Original rect before move/resize started */
  originalRect: CanvasRect | null;
  /** Which edge is being resized (only for 'resizing' mode) */
  resizeEdge: ResizeEdge | null;
}

export interface SnapZone {
  zone: 'left-top' | 'right-top' | 'left-bottom' | 'right-bottom' | 'left' | 'right' | 'top' | 'bottom' | 'full' | null;
  rect: CanvasRect | null;
}

/**
 * Compute a snap preview rect from the pointer position. Edge detection is
 * against the MAIN WINDOW edges (drags may roam the whole window, including
 * under the center panel), while preview rects stay container-local.
 */
function computeSnapZone(
  clientX: number,
  clientY: number,
  containerRect: DOMRect,
): SnapZone {
  const atLeft = clientX <= EDGE_SNAP_THRESHOLD;
  const atRight = clientX >= window.innerWidth - EDGE_SNAP_THRESHOLD;
  const atTop = clientY <= EDGE_SNAP_THRESHOLD;
  const atBottom = clientY >= window.innerHeight - EDGE_SNAP_THRESHOLD;

  const containerWidth = containerRect.width;
  const containerHeight = containerRect.height;
  const mouseX = clientX - containerRect.left;
  const mouseY = clientY - containerRect.top;
  const halfW = containerWidth / 2;
  const halfH = containerHeight / 2;
  const midY = mouseY > halfH * 0.6 && mouseY < halfH * 1.4;
  const midX = mouseX > halfW * 0.6 && mouseX < halfW * 1.4;

  // Corner snaps: quarter screen
  if (atLeft && atTop) return { zone: 'left-top', rect: { x: 0, y: 0, width: halfW, height: halfH } };
  if (atRight && atTop) return { zone: 'right-top', rect: { x: halfW, y: 0, width: halfW, height: halfH } };
  if (atLeft && atBottom) return { zone: 'left-bottom', rect: { x: 0, y: halfH, width: halfW, height: halfH } };
  if (atRight && atBottom) return { zone: 'right-bottom', rect: { x: halfW, y: halfH, width: halfW, height: halfH } };

  // Edge snaps: half screen
  if (atLeft && midY) return { zone: 'left', rect: { x: 0, y: 0, width: halfW, height: containerHeight } };
  if (atRight && midY) return { zone: 'right', rect: { x: halfW, y: 0, width: halfW, height: containerHeight } };
  if (atTop && midX) return { zone: 'top', rect: { x: 0, y: 0, width: containerWidth, height: halfH } };
  if (atBottom && midX) return { zone: 'bottom', rect: { x: 0, y: halfH, width: containerWidth, height: halfH } };

  // Single edge: full side
  if (atLeft) return { zone: 'left', rect: { x: 0, y: 0, width: halfW, height: containerHeight } };
  if (atRight) return { zone: 'right', rect: { x: halfW, y: 0, width: halfW, height: containerHeight } };
  if (atTop) return { zone: 'top', rect: { x: 0, y: 0, width: containerWidth, height: halfH } };
  if (atBottom) return { zone: 'bottom', rect: { x: 0, y: halfH, width: containerWidth, height: halfH } };

  return { zone: null, rect: null };
}

/** Drags may leave the container (e.g. under the center panel) but never the
 *  main window. */
function clampMouseToWindow(clientX: number, clientY: number) {
  return {
    currentX: clampValue(clientX, 0, window.innerWidth),
    currentY: clampValue(clientY, 0, window.innerHeight),
  };
}

export function useCanvasInteraction() {
  const dragRef = useRef<DragState>({
    mode: 'idle',
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    canvasId: null,
    originalRect: null,
    resizeEdge: null,
  });

  const [dragState, setDragState] = useState<DragState>(dragRef.current);
  const [snapPreview, setSnapPreview] = useState<SnapZone>({ zone: null, rect: null });

  const startCreating = useCallback((e: React.MouseEvent, containerRect: DOMRect, button: 'left' | 'right') => {
    const x = e.clientX - containerRect.left;
    const y = e.clientY - containerRect.top;
    const mode: InteractionMode = button === 'left' ? 'creating-left' : 'creating-right';
    const state: DragState = { mode, startX: x, startY: y, currentX: x, currentY: y, canvasId: null, originalRect: null, resizeEdge: null };
    dragRef.current = state;
    setDragState(state);
  }, []);

  const startMoving = useCallback((e: React.MouseEvent, canvasId: string, canvasRect: CanvasRect) => {
    const state: DragState = {
      mode: 'moving',
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      canvasId,
      originalRect: { ...canvasRect },
      resizeEdge: null,
    };
    dragRef.current = state;
    setDragState(state);
  }, []);

  const startResizing = useCallback((e: React.MouseEvent, canvasId: string, canvasRect: CanvasRect, edge: ResizeEdge) => {
    e.preventDefault();
    e.stopPropagation();
    const state: DragState = {
      mode: 'resizing',
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      canvasId,
      originalRect: { ...canvasRect },
      resizeEdge: edge,
    };
    dragRef.current = state;
    setDragState(state);
  }, []);

  const updateDrag = useCallback((e: MouseEvent, containerRect: DOMRect) => {
    const current = dragRef.current;
    if (current.mode === 'idle') return;

    if (current.mode === 'creating-left' || current.mode === 'creating-right') {
      const x = e.clientX - containerRect.left;
      const y = e.clientY - containerRect.top;
      const newState = { ...current, currentX: x, currentY: y };
      dragRef.current = newState;
      setDragState(newState);
    } else if (current.mode === 'moving') {
      const { currentX, currentY } = clampMouseToWindow(e.clientX, e.clientY);
      const newState = { ...current, currentX, currentY };
      dragRef.current = newState;
      setDragState(newState);

      // Compute snap zone
      const snap = computeSnapZone(currentX, currentY, containerRect);
      setSnapPreview(snap);
    } else if (current.mode === 'resizing') {
      const { currentX, currentY } = clampMouseToWindow(e.clientX, e.clientY);
      const newState = { ...current, currentX, currentY };
      dragRef.current = newState;
      setDragState(newState);
    }
  }, []);

  const endDrag = useCallback(() => {
    const state: DragState = { mode: 'idle', startX: 0, startY: 0, currentX: 0, currentY: 0, canvasId: null, originalRect: null, resizeEdge: null };
    dragRef.current = state;
    setDragState(state);
    setSnapPreview({ zone: null, rect: null });
  }, []);

  /** Get the creation rect from drag state (normalized to positive width/height) */
  const getCreationRect = useCallback((): CanvasRect | null => {
    const d = dragRef.current;
    if (d.mode !== 'creating-left' && d.mode !== 'creating-right') return null;
    const dx = Math.abs(d.currentX - d.startX);
    const dy = Math.abs(d.currentY - d.startY);
    if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return null;
    return {
      x: Math.min(d.startX, d.currentX),
      y: Math.min(d.startY, d.currentY),
      width: dx,
      height: dy,
    };
  }, []);

  /** Get the moved rect for a canvas */
  const getMovedRect = useCallback((): CanvasRect | null => {
    const d = dragRef.current;
    if (d.mode !== 'moving' || !d.originalRect) return null;
    const deltaX = d.currentX - d.startX;
    const deltaY = d.currentY - d.startY;
    return {
      x: d.originalRect.x + deltaX,
      y: d.originalRect.y + deltaY,
      width: d.originalRect.width,
      height: d.originalRect.height,
    };
  }, []);

  const getMoveDelta = useCallback((): { x: number; y: number } | null => {
    const d = dragRef.current;
    if (d.mode !== 'moving') return null;
    return {
      x: d.currentX - d.startX,
      y: d.currentY - d.startY,
    };
  }, []);

  const MIN_CANVAS_SIZE = 40;

  /** Get the resized rect from drag state, enforcing minimum size */
  const getResizedRect = useCallback((): CanvasRect | null => {
    const d = dragRef.current;
    if (d.mode !== 'resizing' || !d.originalRect || !d.resizeEdge) return null;

    const deltaX = d.currentX - d.startX;
    const deltaY = d.currentY - d.startY;
    const orig = d.originalRect;

    let x = orig.x;
    let y = orig.y;
    let width = orig.width;
    let height = orig.height;

    const edge = d.resizeEdge;

    // Horizontal edges
    if (edge === 'e' || edge === 'ne' || edge === 'se') {
      width = Math.max(MIN_CANVAS_SIZE, orig.width + deltaX);
    }
    if (edge === 'w' || edge === 'nw' || edge === 'sw') {
      const newWidth = Math.max(MIN_CANVAS_SIZE, orig.width - deltaX);
      x = orig.x + (orig.width - newWidth);
      width = newWidth;
    }

    // Vertical edges
    if (edge === 's' || edge === 'se' || edge === 'sw') {
      height = Math.max(MIN_CANVAS_SIZE, orig.height + deltaY);
    }
    if (edge === 'n' || edge === 'ne' || edge === 'nw') {
      const newHeight = Math.max(MIN_CANVAS_SIZE, orig.height - deltaY);
      y = orig.y + (orig.height - newHeight);
      height = newHeight;
    }

    return { x, y, width, height };
  }, []);

  const isDragging = useCallback((): boolean => {
    const d = dragRef.current;
    if (d.mode === 'idle') return false;
    const dx = Math.abs(d.currentX - d.startX);
    const dy = Math.abs(d.currentY - d.startY);
    return dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD;
  }, []);

  return {
    dragState,
    snapPreview,
    startCreating,
    startMoving,
    startResizing,
    updateDrag,
    endDrag,
    getCreationRect,
    getMovedRect,
    getMoveDelta,
    getResizedRect,
    isDragging,
  };
}
