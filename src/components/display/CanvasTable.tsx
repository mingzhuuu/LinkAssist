import React, { useEffect, useRef } from 'react';
import { useCanvasStore, useChannelStore } from '../../stores';
import { TableColumn, Canvas } from '../../types';
import type { CanvasDataRow } from '../../stores/canvasStore';
import { evaluateNumericFormula } from './formulaUtils';

/** Stable empty array to avoid new-reference re-render loops in Zustand selectors */
const EMPTY_ROWS: CanvasDataRow[] = [];

export interface CanvasTableProps {
  canvasId: string;
}

export const evaluateFormula = evaluateNumericFormula;

export const CanvasTable: React.FC<CanvasTableProps> = ({ canvasId }) => {
  const canvases = useCanvasStore((state) => state.canvases);
  const canvas = canvases.find((c: Canvas) => c.id === canvasId);
  const channels = useChannelStore((state) => state.channels);
  const storedRows = useCanvasStore((state) => state.dataBuffers[canvasId]);
  const rows = storedRows ?? EMPTY_ROWS;

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Auto-scroll to bottom when new rows arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  // Track whether user has scrolled up (disable auto-scroll)
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  if (!canvas || !channels) {
    return null;
  }

  const tableConfig = canvas.config.table;
  const columns = tableConfig?.columns || [];

  return (
    <div className="relative w-full h-full bg-surface flex flex-col overflow-hidden">

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 w-full overflow-auto"
      >
        <table className="min-w-full border-separate border-spacing-0 table-auto">
          <thead>
            <tr>
              {columns.map((col: TableColumn) => {
                let headerLabel = col.alias;
                if (!headerLabel) {
                  if (col.formula?.trim() === '@Timestamp' || col.builtIn === 'timestamp') {
                    headerLabel = 'Timestamp';
                  } else if (col.formula?.trim() === '@ChannelName' || col.builtIn === 'channelName') {
                    headerLabel = 'Channel';
                  } else {
                    headerLabel = `Col ${col.offset}`;
                  }
                }

                return (
                  <th
                    key={col.id}
                    className="sticky top-0 z-10 min-w-[56px] whitespace-nowrap border-b border-border bg-surface px-2 py-1.5 text-left text-[13px] font-semibold text-text-primary"
                  >
                    {headerLabel}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length || 1}
                  className="text-center py-8 text-text-muted text-xs font-mono"
                >
                  Waiting for data...
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className="canvas-table-row"
                >
                  {columns.map((col: TableColumn) => (
                    <td
                      key={col.id}
                      className="min-w-[56px] whitespace-nowrap px-2 py-1.5 text-xs font-mono text-text-secondary"
                    >
                      {row.cells[col.id] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
