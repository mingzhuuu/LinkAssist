import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ChannelTab, TerminalEntry } from '../stores/terminalStore';
import type { TerminalChannelSettings } from '../stores/uiStore';
import { useUIStore } from '../stores/uiStore';

export interface DetachPayload {
  tab: ChannelTab;
  entries: TerminalEntry[];
  channelType?: string;
  terminalSettings: TerminalChannelSettings;
}

export interface ReattachPayload {
  tab: ChannelTab;
  entries: TerminalEntry[];
  channelType?: string;
  terminalSettings: TerminalChannelSettings;
}

export interface TerminalSettingsChangedPayload {
  channelId: string | null;
  settings: TerminalChannelSettings;
}

let detachCounter = 0;

/**
 * Create a new detached terminal window and send the tab payload to it.
 * Returns the window label if successful, null otherwise.
 */
export async function detachTabToWindow(
  payload: DetachPayload,
  screenX?: number,
  screenY?: number,
): Promise<string | null> {
  const label = `terminal-${++detachCounter}-${Date.now()}`;

  const mainWindow = getCurrentWindow();
  const mainPos = await mainWindow.outerPosition();
  const mainSize = await mainWindow.innerSize();

  // Position the new window near the drop location, or center of main window
  const x = screenX ?? (mainPos.x + Math.round(mainSize.width / 2) - 350);
  const y = screenY ?? (mainPos.y + Math.round(mainSize.height / 2) - 250);

  // Carry the current theme so the detached window paints the correct palette
  // from its first frame — it never runs persistence to load themeMode itself.
  const themeMode = useUIStore.getState().themeMode;

  const webview = new WebviewWindow(label, {
    url: `index.html?detached=${encodeURIComponent(label)}&theme=${encodeURIComponent(themeMode)}`,
    title: payload.tab.label || 'Terminal',
    width: 700,
    height: 500,
    minWidth: 400,
    minHeight: 300,
    x,
    y,
    decorations: false,
    transparent: true,
    resizable: true,
    shadow: false,
    focus: true,
    visible: false,
  });

  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let initSent = false;
    let readyUnlisten: (() => void) | null = null;

    const cleanup = () => {
      readyUnlisten?.();
      readyUnlisten = null;
    };

    const deliverInit = async () => {
      await emitTo(label, 'detach-init', {
        tab: payload.tab,
        entries: payload.entries,
        channelType: payload.channelType,
        terminalSettings: payload.terminalSettings,
      });

      if (initSent) return;
      initSent = true;

      // Reveal the window only once its initial state has been delivered.
      try {
        await webview.show();
      } catch {
        // window might already be visible
      }

      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(label);
      }
    };

    // Handshake: the detached window repeatedly emits 'detach-ready' with its
    // own label until it receives 'detach-init'. Responding to that signal —
    // rather than firing after a fixed delay — guarantees the init event is
    // never sent before the window's React listener exists. That race is what
    // left the popup stuck on "Initializing…" (blank input, title fell back to
    // "Terminal"), especially now that the transparent window paints slower.
    listen<string>('detach-ready', (event) => {
      if (event.payload === label) void deliverInit();
    }).then((fn) => {
      if (resolved) fn();
      else readyUnlisten = fn;
    });

    webview.once('tauri://error', () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(null);
      }
    });

    // Safety net: give up if the window never signals readiness.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(null);
      }
    }, 8000);
  });
}
