import { useEffect, useMemo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { MainLayout } from './components/layout/MainLayout';
import { DetachedTerminalWindow } from './components/layout/DetachedTerminalWindow';
import { ToastContainer } from './components/common/ToastContainer';
import { ErrorBoundary, GlobalTooltip } from './components/common';
import { useMainWindowReveal, usePersistence } from './hooks';
import { useUIStore } from './stores';
import { useTerminalStore } from './stores/terminalStore';
import type { ReattachPayload, TerminalSettingsChangedPayload } from './lib/detachWindow';
import type { ThemeMode } from './stores/uiStore';

function useDetachedMode(): boolean {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('detached');
  }, []);
}

function App() {
  const isDetached = useDetachedMode();
  let persistenceReady = true;

  // Only run persistence in the main window
  if (!isDetached) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    persistenceReady = usePersistence();
  }

  const { themeMode } = useUIStore();

  useEffect(() => {
    const root = document.documentElement;
    const tauriWindow = getCurrentWindow();
    
    const applyTheme = (dark: boolean, highContrastMode: 'none' | 'dark' | 'light' = 'none') => {
      root.classList.remove('dark', 'high-contrast', 'high-contrast-light');
      if (highContrastMode === 'dark') {
        root.classList.add('high-contrast', 'dark');
      } else if (highContrastMode === 'light') {
        root.classList.add('high-contrast-light');
      } else if (dark) {
        root.classList.add('dark');
      }
    };
    
    if (themeMode === 'system') {
      const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
      // Windows high-contrast themes surface as forced-colors/prefers-contrast;
      // follow them with the matching high-contrast palette.
      const contrastQuery = window.matchMedia('(prefers-contrast: more)');
      const forcedColorsQuery = window.matchMedia('(forced-colors: active)');

      const applySystemTheme = () => {
        const dark = darkQuery.matches;
        const highContrast = contrastQuery.matches || forcedColorsQuery.matches;
        applyTheme(dark, highContrast ? (dark ? 'dark' : 'light') : 'none');
      };

      applySystemTheme();
      tauriWindow.setTheme(null).catch(() => {});

      darkQuery.addEventListener('change', applySystemTheme);
      contrastQuery.addEventListener('change', applySystemTheme);
      forcedColorsQuery.addEventListener('change', applySystemTheme);
      return () => {
        darkQuery.removeEventListener('change', applySystemTheme);
        contrastQuery.removeEventListener('change', applySystemTheme);
        forcedColorsQuery.removeEventListener('change', applySystemTheme);
      };
    } else {
      let hcMode: 'none' | 'dark' | 'light' = 'none';
      if (themeMode === 'high-contrast') hcMode = 'dark';
      if (themeMode === 'high-contrast-light') hcMode = 'light';
      
      const isDark = themeMode === 'dark' || hcMode === 'dark';
      applyTheme(isDark, hcMode);
      tauriWindow.setTheme(isDark ? 'dark' : 'light').catch(() => {});
    }
  }, [themeMode]);

  useMainWindowReveal(isDetached, persistenceReady);

  // Broadcast theme changes so open detached windows follow the main window.
  useEffect(() => {
    if (isDetached) return;
    void emit('theme-mode-changed', themeMode);
  }, [isDetached, themeMode]);

  // Detached windows have no persistence; follow the main window's theme.
  useEffect(() => {
    if (!isDetached) return;
    const unlistenPromise = listen<ThemeMode>('theme-mode-changed', (event) => {
      useUIStore.getState().setThemeMode(event.payload);
    });
    return () => { unlistenPromise.then(fn => fn()); };
  }, [isDetached]);

  // Listen for tabs being docked back from detached windows (main window only)
  useEffect(() => {
    if (isDetached) return;

    const unlistenPromise = listen<ReattachPayload>('reattach-tab', (event) => {
      const { tab, entries, terminalSettings } = event.payload;
      useUIStore.getState().setTerminalChannelSettings(
        tab.channelId ?? '__terminal__',
        terminalSettings,
      );
      const state = useTerminalStore.getState();
      const targetPaneId = state.focusedPaneId ?? Object.keys(state.panes)[0];
      if (!targetPaneId) return;

      // Add the tab back to the focused pane
      const newTabId = state.addTab(targetPaneId, tab.channelId ?? '', tab.label);

      // Populate the tab's entries if there are any
      if (entries.length > 0) {
        useTerminalStore.setState(s => {
          const pane = s.panes[targetPaneId];
          if (!pane) return {};
          return {
            panes: {
              ...s.panes,
              [targetPaneId]: {
                ...pane,
                entries: pane.activeTabId === newTabId ? entries : pane.entries,
                tabEntries: { ...pane.tabEntries, [newTabId]: entries },
              },
            },
          };
        });
      }
    });

    return () => { unlistenPromise.then(fn => fn()); };
  }, [isDetached]);

  useEffect(() => {
    if (isDetached) return;

    const unlistenPromise = listen<TerminalSettingsChangedPayload>(
      'terminal-channel-settings-changed',
      (event) => {
        useUIStore.getState().setTerminalChannelSettings(
          event.payload.channelId ?? '__terminal__',
          event.payload.settings,
        );
      },
    );

    return () => { unlistenPromise.then(fn => fn()); };
  }, [isDetached]);

  if (isDetached) {
    return (
      <ErrorBoundary label="DetachedWindow">
        <DetachedTerminalWindow />
        <ToastContainer />
        <GlobalTooltip />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary label="App">
      <MainLayout persistenceReady={persistenceReady} />
      <ToastContainer />
      <GlobalTooltip />
    </ErrorBoundary>
  );
}

export default App;
