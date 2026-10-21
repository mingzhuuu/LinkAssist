import React from 'react';

interface ChartToolbarSeries {
  id: string;
  name: string;
  color: string;
  visible: boolean;
}

function getSeriesChipColor(color: string): string {
  return color === 'none' ? 'transparent' : color;
}

interface ChartToolbarProps {
  paused: boolean;
  yAxisMode: 'auto' | 'manual';
  series: ChartToolbarSeries[];
  onTogglePause: () => void;
  onResetZoom: () => void;
  onToggleYAxisMode: () => void;
  onExportPng: () => void;
  onClear: () => void;
  onToggleSeries: (seriesId: string) => void;
}

function stopEvent(event: React.MouseEvent<HTMLButtonElement>): void {
  event.stopPropagation();
}

export const ChartToolbar: React.FC<ChartToolbarProps> = ({
  paused,
  yAxisMode,
  series,
  onTogglePause,
  onResetZoom,
  onToggleYAxisMode,
  onExportPng,
  onClear,
  onToggleSeries,
}) => {
  return (
    <div className="pointer-events-none absolute inset-x-2 top-2 z-20 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      <div className="pointer-events-auto rounded-2xl border border-border bg-surface-overlay/95 p-1 shadow-xl shadow-black/30 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/70 p-1">
          <button className="flex h-7 items-center justify-center rounded-lg px-2.5 py-1 text-xs text-text-secondary hover:bg-[var(--layer-hover)] hover:text-text-primary transition-colors cursor-pointer" onMouseDown={stopEvent} onClick={onTogglePause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="flex h-7 items-center justify-center rounded-lg px-2.5 py-1 text-xs text-text-secondary hover:bg-[var(--layer-hover)] hover:text-text-primary transition-colors cursor-pointer" onMouseDown={stopEvent} onClick={onResetZoom}>
            Reset Zoom
          </button>
          <button className="flex h-7 items-center justify-center rounded-lg px-2.5 py-1 text-xs text-text-secondary hover:bg-[var(--layer-hover)] hover:text-text-primary transition-colors cursor-pointer" onMouseDown={stopEvent} onClick={onToggleYAxisMode}>
            Y: {yAxisMode}
          </button>
          <button className="flex h-7 items-center justify-center rounded-lg px-2.5 py-1 text-xs text-text-secondary hover:bg-[var(--layer-hover)] hover:text-text-primary transition-colors cursor-pointer" onMouseDown={stopEvent} onClick={onExportPng}>
            Export PNG
          </button>
          <button className="flex h-7 items-center justify-center rounded-lg px-2.5 py-1 text-xs text-text-secondary hover:bg-[var(--layer-hover)] hover:text-text-primary transition-colors cursor-pointer" onMouseDown={stopEvent} onClick={onClear}>
            Clear
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 p-1">
          {series.map((seriesItem) => (
            <button
              key={seriesItem.id}
              className={`flex items-center gap-2 rounded-xl border px-2.5 py-1 text-xs transition-colors ${
                seriesItem.visible
                  ? 'border-border bg-surface-secondary text-text-secondary'
                  : 'border-border/60 bg-surface text-text-muted'
              }`}
              onMouseDown={stopEvent}
              onClick={() => onToggleSeries(seriesItem.id)}
              title={seriesItem.visible ? 'Hide series' : 'Show series'}
            >
              <span className="h-2.5 w-2.5 rounded-full border border-border/70" style={{ backgroundColor: getSeriesChipColor(seriesItem.color) }} />
              <span>{seriesItem.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
