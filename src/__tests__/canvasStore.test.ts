import { beforeEach, describe, expect, it } from 'vitest';
import type { CanvasRect } from '../types';
import { clampCanvasRectToContainer, useCanvasStore } from '../stores/canvasStore';

describe('canvas container resize helpers', () => {
  it('clamps oversized canvases to the container bounds', () => {
    expect(clampCanvasRectToContainer({ x: -20, y: 15, width: 500, height: 260 }, 320, 200)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 200,
    });
  });

  it('returns an empty rect when the container size is invalid', () => {
    const rect: CanvasRect = { x: 10, y: 10, width: 120, height: 80 };

    expect(clampCanvasRectToContainer(rect, 0, 200)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('canvas grouping', () => {
  beforeEach(() => {
    useCanvasStore.setState(useCanvasStore.getInitialState(), true);
  });

  function addTestCanvas(x: number) {
    return useCanvasStore.getState().addCanvas({ x, y: 0, width: 100, height: 80 });
  }

  it('groups selected canvases with one group id', () => {
    const firstId = addTestCanvas(0);
    const secondId = addTestCanvas(120);

    const groupId = useCanvasStore.getState().groupCanvases([firstId, secondId]);
    const groupedCanvases = useCanvasStore.getState().canvases.filter((canvas) => canvas.groupId === groupId);

    expect(groupId).toBeTruthy();
    expect(groupedCanvases.map((canvas) => canvas.id).sort()).toEqual([firstId, secondId].sort());
  });

  it('does not create a group for fewer than two canvases', () => {
    const firstId = addTestCanvas(0);

    expect(useCanvasStore.getState().groupCanvases([firstId])).toBeNull();
    expect(useCanvasStore.getState().canvases.find((canvas) => canvas.id === firstId)?.groupId).toBeNull();
  });

  it('merges existing group members into a new group', () => {
    const firstId = addTestCanvas(0);
    const secondId = addTestCanvas(120);
    const thirdId = addTestCanvas(240);
    useCanvasStore.getState().groupCanvases([firstId, secondId]);

    const mergedGroupId = useCanvasStore.getState().groupCanvases([secondId, thirdId]);
    const groupedCanvases = useCanvasStore.getState().canvases.filter((canvas) => canvas.groupId === mergedGroupId);

    expect(groupedCanvases.map((canvas) => canvas.id).sort()).toEqual([firstId, secondId, thirdId].sort());
  });

  it('ungroups every member of selected groups', () => {
    const firstId = addTestCanvas(0);
    const secondId = addTestCanvas(120);
    useCanvasStore.getState().groupCanvases([firstId, secondId]);

    useCanvasStore.getState().ungroupCanvases([firstId]);

    expect(useCanvasStore.getState().canvases.every((canvas) => canvas.groupId === null)).toBe(true);
  });

  it('clears singleton groups when a grouped canvas is removed', () => {
    const firstId = addTestCanvas(0);
    const secondId = addTestCanvas(120);
    useCanvasStore.getState().groupCanvases([firstId, secondId]);

    useCanvasStore.getState().removeCanvas(firstId);

    expect(useCanvasStore.getState().canvases.find((canvas) => canvas.id === secondId)?.groupId).toBeNull();
  });
});
