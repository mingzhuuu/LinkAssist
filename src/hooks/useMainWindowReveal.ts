import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export function useMainWindowReveal(isDetached: boolean, persistenceReady: boolean) {
  useEffect(() => {
    if (isDetached || !persistenceReady) return;

    const root = document.documentElement;
    let cancelled = false;
    let revealFrame = 0;

    root.classList.add('main-window-revealing');
    root.classList.remove('main-window-revealed');

    const revealWhenRequested = async () => {
      try {
        const shouldReveal = await invoke<boolean>('main_window_ready');
        if (cancelled) return;
        if (!shouldReveal) {
          root.classList.remove('main-window-revealing', 'main-window-revealed');
          return;
        }

        // Give the compositor one frame with the fully hydrated layout before
        // transitioning it in. This avoids the abrupt transparent-window pop.
        revealFrame = window.requestAnimationFrame(() => {
          if (!cancelled) {
            root.classList.add('main-window-revealed');
          }
        });
      } catch (error) {
        if (!cancelled) {
          root.classList.remove('main-window-revealing', 'main-window-revealed');
          console.warn('Failed to mark the main window as ready:', error);
        }
      }
    };

    void revealWhenRequested();

    return () => {
      cancelled = true;
      if (revealFrame !== 0) {
        window.cancelAnimationFrame(revealFrame);
      }
      root.classList.remove('main-window-revealing', 'main-window-revealed');
    };
  }, [isDetached, persistenceReady]);
}
