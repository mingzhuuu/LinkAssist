import React, { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { LEFT_PANEL_MAX_WIDTH, LEFT_PANEL_MIN_WIDTH, useMcpStore, useUIStore } from '../../stores';
import { ChannelQuickOpenButton, TitleBarContent } from './TitleBar';
import { LeftPanel } from './LeftPanel';
import { CenterPanel } from './CenterPanel';
import { RightPanel } from './RightPanel';
import { ResizeHandle } from './ResizeHandle';
const SettingsDialog = lazy(() => import('./SettingsDialog').then(module => ({ default: module.SettingsDialog })));

const LEFT_PANEL_COLLAPSED_THRESHOLD = 100;
const LEFT_PANEL_ICON_RAIL = 40;
const RIGHT_PANEL_MIN = 48;
const CENTER_PANEL_MIN = 300;
const WINDOW_RESIZE_SETTLE_MS = 0;

const clampPanelRatio = (ratio: number) => Math.min(Math.max(ratio, 0), 1);

interface MainLayoutProps {
  persistenceReady?: boolean;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ persistenceReady = true }) => {
  const [appWindow] = useState(() => getCurrentWindow());
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const titleBarContextMenuRef = useRef<HTMLDivElement>(null);
  const isMaximizedRef = useRef(false);
  const maximizeTransitionRef = useRef(false);
  const maximizeSyncRequestRef = useRef(0);
  const resizeSettleTimerRef = useRef<number | null>(null);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [titleBarContextMenu, setTitleBarContextMenu] = useState<{ x: number; y: number } | null>(null);
  const {
    leftPanelWidth,
    centerPanelWidth,
    setLeftPanelWidth,
    setCenterPanelWidth,
    setRightPanelWidth,
    channelPanelVisible,
    rightPanelVisible,
    centerTopVisible,
    centerBottomVisible,
    simpleMode,
    setSimpleMode,
  } = useUIStore();
  const mcpToolsEnabled = useMcpStore((state) => state.enabled);
  const setMcpToolsEnabled = useMcpStore((state) => state.setEnabled);
  const [isMaximized, setIsMaximized] = useState(false);
  const [frameOverscanned, setFrameOverscanned] = useState(false);

  const applyMaximizedState = useCallback((maximized: boolean) => {
    isMaximizedRef.current = maximized;
    setIsMaximized(maximized);
  }, []);

  const syncMaximizedState = useCallback(async () => {
    const requestId = ++maximizeSyncRequestRef.current;
    try {
      const maximized = await appWindow.isMaximized();
      if (requestId === maximizeSyncRequestRef.current && !maximizeTransitionRef.current) {
        applyMaximizedState(maximized);
        setFrameOverscanned(maximized);
      }
    } catch {
      if (requestId === maximizeSyncRequestRef.current && !maximizeTransitionRef.current) {
        applyMaximizedState(false);
        setFrameOverscanned(false);
      }
    }
  }, [appWindow, applyMaximizedState]);

  useEffect(() => {
    void syncMaximizedState();

    const unlistenPromise = appWindow.onResized(() => {
      if (maximizeTransitionRef.current) return;

      // If the window was previously maximized and resizes, it is being restored
      // (e.g. via titlebar drag, Aero Snap tear-off, or keyboard shortcut).
      // Immediately restore the rounded/windowed frame synchronously so the
      // restored window renders rounded corners from its very first frame without
      // any perceptible flicker or transition.
      if (isMaximizedRef.current) {
        isMaximizedRef.current = false;
        flushSync(() => {
          setIsMaximized(false);
          setFrameOverscanned(false);
        });
      }

      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
      }
      resizeSettleTimerRef.current = window.setTimeout(() => {
        resizeSettleTimerRef.current = null;
        void syncMaximizedState();
      }, WINDOW_RESIZE_SETTLE_MS);
    });

    return () => {
      maximizeSyncRequestRef.current += 1;
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
        resizeSettleTimerRef.current = null;
      }
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [appWindow, syncMaximizedState]);

  const handleToggleMaximize = useCallback(async () => {
    if (maximizeTransitionRef.current) return;

    window.getSelection()?.removeAllRanges();
    const targetMaximized = !isMaximizedRef.current;
    maximizeTransitionRef.current = true;
    maximizeSyncRequestRef.current += 1;

    try {
      if (targetMaximized) {
        // Commit the overscanned frame synchronously, then change the native
        // bounds without holding a visible intermediate frame.
        isMaximizedRef.current = true;
        flushSync(() => {
          setIsMaximized(true);
          setFrameOverscanned(true);
        });
        await appWindow.maximize();
      } else {
        // Unmaximizing: commit the windowed/rounded frame synchronously before
        // changing native window bounds, so the restored window renders with
        // rounded corners immediately from its very first frame without
        // noticeable transition.
        isMaximizedRef.current = false;
        flushSync(() => {
          setIsMaximized(false);
          setFrameOverscanned(false);
        });
        await appWindow.unmaximize();
      }
    } finally {
      maximizeTransitionRef.current = false;
      void syncMaximizedState();
    }
  }, [appWindow, syncMaximizedState]);

  const handleTitleBarContextMenu = useCallback((event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button, [data-no-drag]')) return;
    event.preventDefault();

    const menuWidth = 144;
    const menuHeight = 36;
    setTitleBarContextMenu({
      x: Math.min(event.clientX, window.innerWidth - menuWidth),
      y: Math.min(event.clientY, window.innerHeight - menuHeight),
    });
  }, []);

  const handleTitleBarMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest('button, [data-no-drag]')
    ) return;

    event.preventDefault();

    if (event.detail === 2) {
      window.getSelection()?.removeAllRanges();
      void handleToggleMaximize();
      return;
    }

    if (event.detail > 2) {
      return;
    }

    void appWindow.startDragging();
  }, [appWindow, handleToggleMaximize]);

  const handleTitleBarDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, [data-no-drag]')) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleToggleSimpleMode = useCallback(() => {
    setSimpleMode(!simpleMode);
    setTitleBarContextMenu(null);
  }, [setSimpleMode, simpleMode]);

  useEffect(() => {
    if (!persistenceReady) return;
    void invoke('set_tray_visible', { visible: !simpleMode })
      .catch((error) => console.warn('Failed to update tray visibility:', error));
  }, [persistenceReady, simpleMode]);

  useEffect(() => {
    if (!persistenceReady) return;
    void invoke('set_mcp_tools_enabled', { enabled: mcpToolsEnabled })
      .catch((error) => console.warn('Failed to update MCP tools state:', error));
  }, [mcpToolsEnabled, persistenceReady]);

  useEffect(() => {
    const unlistenPromise = listen<boolean>('mcp-tools-enabled-changed', (event) => {
      setMcpToolsEnabled(event.payload);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [setMcpToolsEnabled]);

  useEffect(() => {
    // Tray-menu "Settings": the backend marks the request before revealing the
    // window, because a headless Core may emit the event before this listener
    // registers. Consume the pending flag after subscribing to cover that gap.
    let cancelled = false;
    const unlistenPromise = listen('tray-open-settings', () => {
      setShowSettingsDialog(true);
      void invoke('consume_tray_settings_request');
    });
    void invoke<boolean>('consume_tray_settings_request')
      .then((pending) => {
        if (pending && !cancelled) setShowSettingsDialog(true);
      })
      .catch((error) => console.warn('Failed to consume the tray settings request:', error));
    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!titleBarContextMenu) return;

    const dismissMenu = (event: MouseEvent) => {
      if (!titleBarContextMenuRef.current?.contains(event.target as Node)) {
        setTitleBarContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTitleBarContextMenu(null);
    };

    document.addEventListener('mousedown', dismissMenu);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', dismissMenu);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [titleBarContextMenu]);

  const handleLeftResize = (deltaX: number) => {
    setLeftPanelWidth(Math.min(LEFT_PANEL_MAX_WIDTH, Math.max(LEFT_PANEL_MIN_WIDTH, leftPanelWidth + deltaX)));
  };

  const clampCenterPanelWidth = useCallback((width: number) => {
    const contentWidth = contentAreaRef.current?.clientWidth ?? 0;

    if (contentWidth === 0) {
      return Math.max(CENTER_PANEL_MIN, width);
    }

    const maxCenterPanelWidth = Math.max(CENTER_PANEL_MIN, contentWidth - RIGHT_PANEL_MIN);
    return Math.min(Math.max(CENTER_PANEL_MIN, width), maxCenterPanelWidth);
  }, []);

  const handleCenterResize = (deltaX: number) => {
    const nextWidth = clampCenterPanelWidth(centerPanelWidth + deltaX);
    setCenterPanelWidth(nextWidth);
    const contentWidth = contentAreaRef.current?.clientWidth ?? 0;
    if (contentWidth > 0) {
      setRightPanelWidth(Math.max(RIGHT_PANEL_MIN, contentWidth - nextWidth));
    }
  };

  useEffect(() => {
    if (!persistenceReady) {
      return;
    }

    const element = contentAreaRef.current;
    if (!element) return;

    const syncOnContentAreaResize = () => {
      const contentWidth = element.clientWidth;
      if (contentWidth <= 0) {
        return;
      }

      const currentCenterWidth = useUIStore.getState().centerPanelWidth;
      const maxCenterWidth = Math.max(CENTER_PANEL_MIN, contentWidth - RIGHT_PANEL_MIN);
      if (currentCenterWidth > maxCenterWidth) {
        setCenterPanelWidth(maxCenterWidth);
      }
      setRightPanelWidth(Math.max(RIGHT_PANEL_MIN, contentWidth - Math.min(currentCenterWidth, maxCenterWidth)));
    };

    syncOnContentAreaResize();

    const observer = new ResizeObserver(syncOnContentAreaResize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [persistenceReady, setCenterPanelWidth, setRightPanelWidth]);

  const isCollapsed = leftPanelWidth < LEFT_PANEL_COLLAPSED_THRESHOLD;
  const leftPanelExpansionProgress = clampPanelRatio(
    (leftPanelWidth - LEFT_PANEL_MIN_WIDTH) / (LEFT_PANEL_COLLAPSED_THRESHOLD - LEFT_PANEL_MIN_WIDTH)
  );
  const effectiveChannelPanelVisible = channelPanelVisible && !simpleMode;
  const centerFullyHidden = simpleMode || (!centerTopVisible && !centerBottomVisible);
  const effectiveRightPanelVisible = simpleMode || rightPanelVisible;
  const roundContentBottomRight = effectiveRightPanelVisible && !frameOverscanned;

  return (
    <div className="relative w-full h-screen overflow-hidden bg-transparent">
      <div
        className="absolute overflow-hidden rounded-[14px] border border-border bg-road text-text-primary"
        style={{ inset: frameOverscanned ? '-14px' : '0' }}
      >
        <div
          className={`absolute flex flex-col min-h-0 pt-0.5 pb-0.5 ${simpleMode ? 'pl-0 pr-0' : 'pl-0.5 pr-0.5'}`}
          style={{ inset: frameOverscanned ? '14px' : '0' }}
        >
          {/* ── Title bar row: road portion + content portion ── */}
          <div
            className="flex shrink-0 h-8 select-none"
            data-window-titlebar
            onMouseDown={handleTitleBarMouseDown}
            onDoubleClick={handleTitleBarDoubleClick}
            onContextMenu={handleTitleBarContextMenu}
          >
            {/* Title bar road section (above channel panel) — no bottom border */}
            {effectiveChannelPanelVisible && (
              <div
                className="h-full bg-road shrink-0"
                style={{ width: leftPanelWidth }}
              >
                <div
                  className="flex h-full items-center justify-center"
                  style={{ width: LEFT_PANEL_ICON_RAIL }}
                >
                  <ChannelQuickOpenButton />
                </div>
              </div>
            )}
            {/* Title bar content section — has bottom border */}
            <div className="flex-1 flex items-center h-full min-w-0">
              <TitleBarContent
                isMaximized={isMaximized}
                onToggleMaximize={handleToggleMaximize}
              />
            </div>
          </div>

          {/* ── Main content area ── */}
          <div className="relative flex flex-1 min-h-0">
            {/* ── Left channel panel: part of the "road" ── */}
            {effectiveChannelPanelVisible && (
              <>
                <div
                  className="h-full bg-road shrink-0 flex flex-col"
                  style={{ width: leftPanelWidth }}
                >
                  <LeftPanel
                    collapsed={isCollapsed}
                    expansionProgress={leftPanelExpansionProgress}
                    showSettings={showSettingsDialog}
                    onToggleSettings={() => setShowSettingsDialog((current) => !current)}
                  />
                </div>
                <ResizeHandle onResize={handleLeftResize} showLine={false} />
              </>
            )}

            {/* ── Content area: inset inside the L-shaped road ── */}
            <div
              ref={contentAreaRef}
              data-content-area
              className={`relative isolate flex flex-1 min-w-0 overflow-hidden rounded-tr-xl bg-surface before:rounded-tr-xl before:pointer-events-none before:absolute before:inset-0 before:z-[2147483647] before:border-t-[0.5px] before:border-b-[0.5px] before:border-[color:var(--divider-default)] before:content-[''] ${effectiveChannelPanelVisible ? 'rounded-l-xl before:rounded-l-xl before:border-l-[0.5px]' : ''} ${roundContentBottomRight ? 'rounded-br-xl before:rounded-br-xl before:border-r-[0.5px]' : ''}`}>
              {!centerFullyHidden && (
                <>
                  {/* Center panel */}
                  <div
                    className={`h-full min-w-[300px] shrink-0 ${effectiveRightPanelVisible ? 'border-r border-transparent' : 'flex-1'}`}
                    style={effectiveRightPanelVisible ? { width: centerPanelWidth } : undefined}
                  >
                    <CenterPanel />
                  </div>

                  {effectiveRightPanelVisible && <ResizeHandle onResize={handleCenterResize} hairline />}
                </>
              )}

              {/* Right panel */}
              {effectiveRightPanelVisible ? (
                <div className="relative z-0 h-full min-w-0 flex-1">
                  <RightPanel
                    layoutReady={persistenceReady}
                    roundMaximizedCanvasTopLeft={simpleMode || (centerFullyHidden && effectiveChannelPanelVisible)}
                    roundMaximizedCanvasBottomRight={roundContentBottomRight}
                    seamlessMaximizedCanvas
                  />
                </div>
              ) : centerFullyHidden ? (
                <div className="flex-1 h-full bg-surface" />
              ) : null}
            </div>

            {showSettingsDialog && <Suspense fallback={null}><SettingsDialog open onClose={() => setShowSettingsDialog(false)} /></Suspense>}
          </div>
        </div>
      </div>
      {/* Paint the bottom frame edge above the content without changing its spacing. */}
      {!frameOverscanned && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[2147483647] rounded-[14px] shadow-[inset_0_-1px_0_var(--border-default)]"
        />
      )}
      {titleBarContextMenu && (
        <div
          ref={titleBarContextMenuRef}
          role="menu"
          className="fixed z-[10000] w-max overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-xl shadow-black/30 backdrop-blur-sm"
          style={{ left: titleBarContextMenu.x, top: titleBarContextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="block whitespace-nowrap rounded-lg px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-[var(--layer-hover)]"
            onClick={handleToggleSimpleMode}
          >
            {simpleMode ? 'Exit simple mode' : 'Simple mode'}
          </button>
        </div>
      )}
    </div>
  );
};
