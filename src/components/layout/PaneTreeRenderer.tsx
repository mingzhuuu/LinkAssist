import React, { useCallback, useEffect, useRef } from 'react';
import { useTerminalStore, PaneNode, SplitDirection } from '../../stores/terminalStore';
import { TerminalLeafPane } from './TerminalLeafPane';

interface Props {
  node: PaneNode;
}

const SplitResizeHandle: React.FC<{ splitId: string; direction: SplitDirection }> = ({ splitId, direction }) => {
  const isDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { resizeSplit } = useTerminalStore.getState();

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;

    const parent = (e.currentTarget as HTMLElement).parentElement;
    containerRef.current = parent as HTMLDivElement;
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const r = direction === 'horizontal'
        ? (e.clientX - rect.left) / rect.width
        : (e.clientY - rect.top) / rect.height;
      resizeSplit(splitId, Math.max(0.1, Math.min(0.9, r)));
    };
    const handleMouseUp = () => { isDraggingRef.current = false; };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [splitId, direction, resizeSplit]);

  if (direction === 'vertical') {
    return (
      <div
        className="relative h-px cursor-row-resize shrink-0 bg-border"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-x-0 -top-2 h-4" />
      </div>
    );
  }

  return (
    <div
      className="relative w-px cursor-col-resize shrink-0 bg-border"
      onMouseDown={handleMouseDown}
    >
      <div className="absolute inset-y-0 -left-2 w-4" />
    </div>
  );
};

export const PaneTreeRenderer: React.FC<Props> = ({ node }) => {
  if (node.type === 'leaf') {
    return (
      <div className="flex flex-col h-full min-h-0 flex-1 min-w-0">
        <TerminalLeafPane paneId={node.paneId} />
      </div>
    );
  }

  const isHorizontal = node.direction === 'horizontal';
  const firstSize = `${node.ratio * 100}%`;
  const secondSize = `${(1 - node.ratio) * 100}%`;

  return (
    <div className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} h-full min-h-0 flex-1 min-w-0`}>
      <div
        className="flex flex-col min-h-0 min-w-0"
        style={isHorizontal ? { width: firstSize } : { height: firstSize }}
      >
        <PaneTreeRenderer node={node.left} />
      </div>
      <SplitResizeHandle splitId={node.id} direction={node.direction} />
      <div
        className="flex flex-col min-h-0 min-w-0"
        style={isHorizontal ? { width: secondSize } : { height: secondSize }}
      >
        <PaneTreeRenderer node={node.right} />
      </div>
    </div>
  );
};
