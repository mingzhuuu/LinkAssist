type Job = () => Promise<() => void>;
export interface IngestStats { pending: number; dropped: number; errors: number }
const EMPTY: IngestStats = Object.freeze({ pending: 0, dropped: 0, errors: 0 });
interface Queue {
  jobs: Job[];
  running: boolean;
  dropped: number;
  errors: number;
  snapshot: IngestStats;
  timer?: ReturnType<typeof setTimeout>;
}
const queues = new Map<string, Queue>();
const subscribers = new Map<string, Set<() => void>>();
export const MAX_CANVAS_INGEST_QUEUE = 256;

function publish(id: string, q: Queue) {
  if (q.timer || queues.get(id) !== q) return;
  q.timer = setTimeout(() => {
    q.timer = undefined;
    if (queues.get(id) !== q) return;
    q.snapshot = { pending: q.jobs.length + Number(q.running), dropped: q.dropped, errors: q.errors };
    subscribers.get(id)?.forEach(listener => listener());
  }, 250);
}
export function canvasIngestStats(id: string): IngestStats { return queues.get(id)?.snapshot ?? EMPTY; }
export function subscribeCanvasIngest(id: string, listener: () => void): () => void {
  const listeners = subscribers.get(id) ?? new Set<() => void>();
  subscribers.set(id, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) subscribers.delete(id);
  };
}
export function disposeCanvasIngest(id: string) {
  const q = queues.get(id);
  if (q) {
    q.jobs.length = 0;
    clearTimeout(q.timer);
    queues.delete(id);
    subscribers.get(id)?.forEach(listener => listener());
  }
}
export function enqueueCanvasIngest(id: string, job: Job): void {
  let q = queues.get(id);
  if (!q) {
    q = { jobs: [], running: false, dropped: 0, errors: 0, snapshot: EMPTY };
    queues.set(id, q);
  }
  q.jobs.push(job);
  if (q.jobs.length > MAX_CANVAS_INGEST_QUEUE) {
    q.dropped += q.jobs.length - MAX_CANVAS_INGEST_QUEUE;
    q.jobs.splice(0, q.jobs.length - MAX_CANVAS_INGEST_QUEUE);
  }
  publish(id, q);
  if (!q.running) void pump(id, q);
}
async function pump(id: string, q: Queue) {
  q.running = true;
  try {
    while (queues.get(id) === q && q.jobs.length) {
      try {
        const commit = await q.jobs.shift()!();
        // Deleting/replacing the canvas invalidates even an already-running parse.
        if (queues.get(id) === q) commit();
      } catch (error) {
        q.errors++;
        console.warn('Canvas data processing failed:', error);
      }
    }
  } finally {
    q.running = false;
    publish(id, q);
  }
}
