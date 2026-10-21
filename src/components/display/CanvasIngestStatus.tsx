import { useCallback, useSyncExternalStore } from 'react';
import { canvasIngestStats, subscribeCanvasIngest } from '../../lib/canvasIngestQueue';

export function CanvasIngestStatus({ canvasId }: { canvasId: string }) {
  const subscribe = useCallback((listener: () => void) => subscribeCanvasIngest(canvasId, listener), [canvasId]);
  const snapshot = useCallback(() => canvasIngestStats(canvasId), [canvasId]);
  const stats = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!stats.pending && !stats.dropped && !stats.errors) return null;
  return <div className="pointer-events-none absolute bottom-1 right-2 z-20 rounded bg-surface-overlay px-2 py-1 text-xs text-text-secondary"
    role="status" title="Display queue only. Dropped samples are not recorded by the canvas.">
    Queue: {stats.pending} · Dropped: {stats.dropped}{stats.errors ? ` · Errors: ${stats.errors}` : ''}
  </div>;
}
