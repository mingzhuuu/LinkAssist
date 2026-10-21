import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppEventMap } from '../../types';

/** One scope per effect; registration may finish after React has unmounted it. */
export function createEventSubscriptions(
  onError: (error: unknown, eventName: keyof AppEventMap) => void = (error, eventName) => {
    console.error(`Event subscription failed (${eventName}):`, error);
  },
) {
  let disposed = false;
  const subscriptions = new Map<UnlistenFn, keyof AppEventMap>();

  const release = (unlisten: UnlistenFn, eventName: keyof AppEventMap) => {
    try {
      unlisten();
    } catch (error) {
      onError(error, eventName);
    }
  };

  return {
    listen<K extends keyof AppEventMap>(eventName: K, handler: (event: Event<AppEventMap[K]>) => void): void {
      if (disposed) return;
      void (async () => {
        try {
          const unlisten = await listen<AppEventMap[K]>(eventName, (event) => {
            // Also guard callbacks while an asynchronous registration is pending.
            if (!disposed) handler(event);
          });
          if (disposed) release(unlisten, eventName);
          else subscriptions.set(unlisten, eventName);
        } catch (error) {
          onError(error, eventName);
        }
      })();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [unlisten, eventName] of subscriptions) release(unlisten, eventName);
      subscriptions.clear();
    },
  };
}
